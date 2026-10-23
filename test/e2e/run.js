'use strict';

// End-to-end test: runs the real Electron app (standalone mode) against the fake Google server
// and a fake DaVinci Resolve driven through the real Lua bridge script (LuaJIT), clicks through
// the main flows and writes screenshots to test-results/.
//
//   npm run test:e2e            (Linux CI: wrap with xvfb-run)

const assert = require('assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');
const { FakeGoogle } = require('../support/fake-google');
const { buildLibrary } = require('./fixtures');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'test-results');
const LUA = spawnSync('luajit', ['-v']).status === 0 ? 'luajit' : null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const lib = buildLibrary();
  const fake = new FakeGoogle(lib, { throttleBytesPerSec: 1.5 * 1024 * 1024 });
  await fake.start();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpool-e2e-'));
  const home = path.join(tmp, 'home');
  const xdg = path.join(home, '.config');
  const userData = path.join(xdg, 'Cloud Pool for Resolve');
  fs.mkdirSync(userData, { recursive: true });
  const clientFile = path.join(tmp, 'client_secret_test.json');
  fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'e2e.apps.googleusercontent.com', client_secret: 'secret' } }));

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    LANG: 'ru_RU.UTF-8',
    CLOUDPOOL_GOOGLE_BASE: fake.base,
    CLOUDPOOL_TEST_BROWSER: 'fetch',
    CLOUDPOOL_USER_DATA: userData,
    CLOUDPOOL_CLIENT_FILE: clientFile,
  };
  delete env.NODE_OPTIONS;

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(ROOT, 'plugin'), '--no-sandbox', '--lang=ru'],
    env,
  });
  const logs = [];
  const page = await app.firstWindow();
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e.message}`));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 900);
    w.center();
  });
  const shot = async (name) => {
    await sleep(350);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };

  let lua = null;
  try {
    // 1. Onboarding: the client JSON is preloaded, step 2 (sign-in) is active.
    await page.waitForSelector('.onboarding.open .btn.google');
    await shot('01-onboarding');
    await page.click('.btn.google');
    await page.waitForSelector('.onboarding', { state: 'hidden' });
    await page.waitForSelector('.empty-box.wide');
    await shot('02-empty-library');

    // 2. Pick from Google Photos (the fake picker auto-selects everything).
    await page.click('.pick-btn');
    await waitFor(async () => (await page.$$('.tile')).length >= 10, { label: 'tiles' });
    await waitFor(async () => (await page.$$('.tile.loaded')).length >= 10, { label: 'thumbnails' });
    await sleep(1200);
    await shot('03-library');
    const headers = await page.$$eval('.group-label', (els) => els.map((e) => e.textContent));
    assert.ok(headers.length >= 4, `date groups: ${headers.join(', ')}`);

    // Auto-download started for picked items.
    await waitFor(async () => (await page.$$('.tile-status.busy, .tile-status.ok')).length >= 3, { label: 'downloads progress' });
    await shot('04-downloading');

    // 3. Preview a video (streams from the fake Google before the download finishes), set in/out.
    const firstVideo = await page.$('.tile.kind-video');
    await firstVideo.dblclick();
    await page.waitForSelector('.preview .pv-video');
    await waitFor(() => page.$eval('.pv-video', (v) => v.readyState >= 2 && v.duration > 0), { label: 'video playback' });
    await page.keyboard.press('k');
    await page.$eval('.pv-video', (v) => {
      v.currentTime = 1;
    });
    await sleep(300);
    await page.keyboard.press('i');
    await page.$eval('.pv-video', (v) => {
      v.currentTime = 3;
    });
    await sleep(300);
    await page.keyboard.press('o');
    await page.waitForSelector('.preview.has-marks');
    await shot('05-preview-marks');

    // 4. Connect the fake Resolve through the real Lua bridge and send the clip at the playhead.
    if (LUA) {
      const statePath = path.join(tmp, 'resolve-state.json');
      const runner = path.join(tmp, 'runner.lua');
      fs.writeFileSync(
        runner,
        [
          'FAKE_MEDIA = {}',
          'FAKE_ACCEPT_ANY = true',
          `FAKE_STATE = ${JSON.stringify(statePath)}`,
          'FAKE_TIMELINE_FPS = 25',
          'FAKE_EXISTING_TIMELINE = true',
          'FAKE_PLAYHEAD = 250',
          'FAKE_BLOCKED = { { 0, 500 } }',
          `dofile(${JSON.stringify(path.join(ROOT, 'test/support/fake_resolve.lua'))})`,
          `dofile(${JSON.stringify(path.join(ROOT, 'plugin/resolve/Cloud Pool.lua'))})`,
        ].join('\n'),
      );
      lua = spawn(LUA, [runner], { env: { ...process.env, XDG_CONFIG_HOME: xdg }, stdio: 'ignore' });
      await page.waitForSelector('.statusbar .dot.ok', { timeout: 15000 });
      await page.click('.pv-actions .btn.primary + .btn'); // "At playhead"
      await waitFor(() => fs.existsSync(statePath) && JSON.parse(fs.readFileSync(statePath, 'utf8')).timelines[0].tracks.video.length > 1, {
        timeout: 60000,
        label: 'clip on the timeline',
      });
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const v2 = st.timelines[0].tracks.video[1];
      assert.equal(v2.length, 1, 'placed on V2 because V1 is occupied at the playhead');
      assert.equal(v2[0].start, st.timelines[0].startFrame + 250);
      assert.equal(v2[0].end - v2[0].start, 50, 'in/out 1s–3s at 25 fps');
      await page.waitForSelector('.toast.ok');
      await shot('06-sent-to-resolve');
    }

    // 5. Google Drive views.
    await page.keyboard.press('Escape');
    await page.click('[data-nav="drive-videos"]');
    await waitFor(async () => (await page.$$('.tile.loaded')).length >= 4, { label: 'drive thumbnails' });
    await shot('07-drive-videos');
    await page.click('[data-nav="drive-folder"]');
    await page.waitForSelector('.tile.kind-folder');
    await shot('08-drive-folders');
    await page.click('.tile.kind-folder');
    await waitFor(async () => (await page.$$('.tile.kind-video')).length === 3, { label: 'folder contents' });

    // 6. Downloads drawer and settings.
    await page.click('.status-dl');
    await page.waitForSelector('.drawer.open .dl-row');
    await shot('09-downloads');
    await page.click('.drawer .drawer-header .icon-btn');
    await page.click('[data-nav="settings"]');
    await page.waitForSelector('.dialog');
    if (spawnSync('ffmpeg', ['-version']).status === 0) {
      // The fragment option reports the ffmpeg it found.
      await waitFor(async () => /ffmpeg (найден|found): /.test(await page.textContent('.ffmpeg-status')), { label: 'ffmpeg status' });
    }
    await shot('10-settings');
    await page.keyboard.press('Escape');

    // 7. Everything that finished downloading shows up offline under "Downloaded".
    await waitFor(async () => {
      await page.click('[data-nav="local"]');
      return (await page.$$('.tile')).length >= 4;
    }, { timeout: 90000, interval: 2000, label: 'downloaded items' });
    await shot('11-downloaded');
    const files = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) walk(path.join(d, f.name));
        else files.push(path.join(d, f.name));
      }
    };
    walk(path.join(home, 'Videos', 'Cloud Pool'));
    assert.ok(files.some((f) => f.endsWith('.mp4')), 'videos downloaded into the library folder');
    assert.ok(files.some((f) => /Google Photos[\\/]\d{4}-\d{2}-\d{2}[\\/]/.test(f)), 'organised by date');

    const errors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
    assert.deepEqual(errors, [], `renderer errors:\n${errors.join('\n')}`);
    console.log(`E2E passed. Screenshots in ${OUT}`);
  } catch (err) {
    await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
    console.error(logs.join('\n'));
    throw err;
  } finally {
    if (lua) lua.kill();
    await app.close().catch(() => {});
    await fake.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
