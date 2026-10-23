'use strict';

// Runs the real "Cloud Pool.lua" bridge under LuaJIT (the Lua runtime embedded in Resolve)
// against a fake Resolve, and drives it through the app-side MailboxBridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../support/helpers');
const { MailboxBridge } = require('../../plugin/src/main/resolve/mailbox-bridge');

const ROOT = path.resolve(__dirname, '../..');
const LUA = spawnSync('luajit', ['-v']).status === 0 ? 'luajit' : null;

function luaString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function startBridge({ media, existing = false, playhead = 0, blocked = [] }) {
  const dir = tmpDir('cloudpool-lua-');
  const config = path.join(dir, 'config');
  const mailboxDir = path.join(config, 'Cloud Pool for Resolve', 'resolve-bridge');
  const statePath = path.join(dir, 'state.json');
  const bridge = new MailboxBridge({ dir: mailboxDir, logger: { warn() {} } });
  bridge.start();
  const mediaLua = Object.entries(media)
    .map(([p, m]) => `[${luaString(p)}] = { fps = ${m.fps || 0}, frames = ${m.frames || 0}, audio = ${!!m.audio}, still = ${!!m.still} }`)
    .join(',\n');
  const runner = path.join(dir, 'runner.lua');
  fs.writeFileSync(
    runner,
    [
      `FAKE_MEDIA = {\n${mediaLua}\n}`,
      `FAKE_STATE = ${luaString(statePath)}`,
      'FAKE_TIMELINE_FPS = 24',
      `FAKE_EXISTING_TIMELINE = ${existing}`,
      `FAKE_PLAYHEAD = ${playhead}`,
      `FAKE_BLOCKED = { ${blocked.map(([a, b]) => `{ ${a}, ${b} }`).join(', ')} }`,
      `dofile(${luaString(path.join(ROOT, 'test/support/fake_resolve.lua'))})`,
      `dofile(${luaString(path.join(ROOT, 'plugin/resolve/Cloud Pool.lua'))})`,
    ].join('\n'),
  );
  const proc = spawn(LUA, [runner], { env: { ...process.env, XDG_CONFIG_HOME: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((await bridge.status()).connected) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const stop = async () => {
    try {
      await bridge._call('stop', {}, 5000);
    } catch {
      /* already gone */
    }
    bridge.dispose();
    await new Promise((resolve) => {
      if (proc.exitCode !== null) resolve();
      else proc.on('exit', resolve);
      setTimeout(() => {
        proc.kill();
        resolve();
      }, 3000);
    });
  };
  return { bridge, state, stop, output: () => output };
}

test('Lua bridge imports and places clips at the playhead on a free track', { skip: !LUA && 'luajit not installed' }, async () => {
  const media = {
    '/m/Отпуск 2026/видео 1.mp4': { fps: 30, frames: 300, audio: true },
    '/m/b.mp4': { fps: 24, frames: 48, audio: false },
  };
  const s = await startBridge({ media, existing: true, playhead: 120, blocked: [[0, 480]] });
  try {
    const status = await s.bridge.status();
    assert.equal(status.connected, true, s.output());
    assert.equal(status.project, 'Lua Project');
    assert.equal(status.timeline.name, 'Existing');
    const result = await s.bridge.place({
      action: 'playhead',
      binName: 'Google Photos',
      clips: [
        { path: '/m/Отпуск 2026/видео 1.mp4', name: 'видео 1.mp4', kind: 'video', inSec: 1, outSec: 3, comment: 'Google Photos · Pixel' },
        { path: '/m/b.mp4', name: 'b.mp4', kind: 'video' },
      ],
    });
    assert.equal(result.placed, 2, s.output());
    assert.equal(result.imported, 2);
    const st = s.state();
    const t = st.timelines[0];
    assert.equal(t.tracks.video[0].length, 1, 'V1 untouched');
    const v2 = t.tracks.video[1];
    assert.equal(v2[0].path, '/m/Отпуск 2026/видео 1.mp4');
    assert.equal(v2[0].start, t.startFrame + 120);
    assert.equal(v2[0].end - v2[0].start, 48); // 2 s @ 24 fps
    assert.equal(v2[1].start, v2[0].end);
    assert.equal(t.playhead, v2[1].end, 'playhead moved after the inserted clips');
    assert.equal(st.bins['Google Photos'][0].comment, 'Google Photos · Pixel');
  } finally {
    await s.stop();
  }
});

test('Lua bridge creates a timeline, reuses imported clips and reports errors', { skip: !LUA && 'luajit not installed' }, async () => {
  const s = await startBridge({ media: { '/m/a.mp4': { fps: 25, frames: 250, audio: true } } });
  try {
    const r1 = await s.bridge.place({ action: 'append', binName: 'Google Drive', clips: [{ path: '/m/a.mp4', name: 'a.mp4', kind: 'video' }] });
    assert.equal(r1.createdTimeline, true);
    assert.equal(r1.placed, 1);
    const r2 = await s.bridge.place({ action: 'import', binName: 'Google Drive', clips: [{ path: '/m/a.mp4', name: 'a.mp4', kind: 'video' }] });
    assert.equal(r2.reused, 1);
    assert.equal(s.state().imports, 1);
    await assert.rejects(
      s.bridge.place({ action: 'import', binName: 'Google Drive', clips: [{ path: '/m/missing.mov', name: 'missing.mov', kind: 'video' }] }),
      /could not import "missing.mov"/,
    );
  } finally {
    await s.stop();
  }
});
