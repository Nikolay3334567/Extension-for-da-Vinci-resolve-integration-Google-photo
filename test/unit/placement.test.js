'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeResolve, Timeline } = require('../support/fake-resolve');
const { importAndPlace } = require('../../plugin/src/main/resolve/placement');
const { tcToFrames, framesToTc } = require('../../plugin/src/main/resolve/timecode');

const MEDIA = {
  '/m/a.mp4': { fps: 30, frames: 300, audio: true }, // 10 s
  '/m/b.mp4': { fps: 60, frames: 240, audio: true }, // 4 s
  '/m/c.jpg': { still: true },
  '/m/silent.mp4': { fps: 25, frames: 100, audio: false },
};

function clip(path, extra = {}) {
  return { path, name: path.split('/').pop(), key: `photos:${path}`, kind: path.endsWith('.jpg') ? 'photo' : 'video', comment: 'Google Photos', ...extra };
}

for (const asyncApi of [false, true]) {
  const label = asyncApi ? '(promise API)' : '(sync API)';

  test(`imports into a named bin and reuses clips on the second import ${label}`, async () => {
    const resolve = createFakeResolve({ media: MEDIA, async: asyncApi });
    const r1 = await importAndPlace(resolve, { action: 'import', clips: [clip('/m/a.mp4'), clip('/m/b.mp4')], binName: 'Google Photos' });
    assert.deepEqual([r1.imported, r1.reused, r1.placed], [2, 0, 0]);
    const pool = resolve.project.pool;
    const bin = pool.root.subs.find((f) => f.name === 'Google Photos');
    assert.equal(bin.clips.length, 2);
    assert.equal(pool.current, pool.root, 'current folder restored');
    assert.equal(bin.clips[0].metadata.Comments, 'Google Photos');
    assert.equal(bin.clips.find((c) => c.path === '/m/a.mp4').third['Cloud Pool Source'], 'photos:/m/a.mp4');
    const r2 = await importAndPlace(resolve, { action: 'import', clips: [clip('/m/a.mp4')], binName: 'Google Photos' });
    assert.deepEqual([r2.imported, r2.reused], [0, 1]);
    assert.equal(bin.clips.length, 2);
    assert.equal(pool.root.subs.length, 1);
  });

  test(`append creates a timeline when none is open and honours in/out marks ${label}`, async () => {
    const resolve = createFakeResolve({ media: MEDIA, async: asyncApi });
    const r = await importAndPlace(resolve, {
      action: 'append',
      clips: [clip('/m/a.mp4', { inSec: 1, outSec: 2.5 }), clip('/m/b.mp4')],
      binName: 'Google Photos',
    });
    assert.equal(r.createdTimeline, true);
    assert.equal(r.placed, 2);
    const t = resolve.project.current;
    const v1 = t.tracks.video[0];
    assert.equal(v1.length, 2);
    // 1.0–2.5 s of a 30 fps clip = 45 source frames = 36 frames at 24 fps
    assert.equal(v1[0].end - v1[0].start, 36);
    // b.mp4 (4 s) appended right after
    assert.equal(v1[1].start, v1[0].end);
    assert.equal(v1[1].end - v1[1].start, 96);
  });

  test(`playhead insert avoids occupied tracks, chains clips and moves the playhead ${label}`, async () => {
    const resolve = createFakeResolve({ media: MEDIA, async: asyncApi });
    const project = resolve.project;
    const t = new Timeline('Edit', { fps: 24 });
    project.timelines.push(t);
    project.current = t;
    // Existing clip on V1/A1 from 01:00:00:00 to 01:00:20:00.
    const existing = createFakeResolve({ media: MEDIA }).project.pool;
    const [item] = existing.ImportMedia(['/m/a.mp4']);
    t.tracks.video[0].push({ start: t.startFrame, end: t.startFrame + 480, GetStart() { return this.start; }, GetEnd() { return this.end; } });
    t.tracks.audio[0].push({ start: t.startFrame, end: t.startFrame + 480, GetStart() { return this.start; }, GetEnd() { return this.end; } });
    t.SetCurrentTimecode('01:00:05:00');
    assert.ok(item);
    const r = await importAndPlace(resolve, { action: 'playhead', clips: [clip('/m/b.mp4'), clip('/m/c.jpg'), clip('/m/silent.mp4')], binName: 'Google Photos' });
    assert.equal(r.placed, 3);
    assert.equal(t.tracks.video.length, 2, 'a second video track was added');
    const v2 = t.tracks.video[1];
    const at5s = t.startFrame + 5 * 24;
    assert.equal(v2[0].start, at5s);
    assert.equal(v2[0].end, at5s + 96);
    assert.equal(t.tracks.audio[1][0].start, at5s, 'linked audio on A2');
    // The still follows directly (5 s) and the silent clip after it.
    assert.equal(v2[1].start, at5s + 96);
    assert.equal(v2[1].end - v2[1].start, 120);
    assert.equal(v2[2].start, at5s + 96 + 120);
    assert.equal(v2[2].end - v2[2].start, 96); // 100 frames @25 → 4 s @24
    assert.equal(t.GetCurrentTimecode(), framesToTc(tcToFrames('01:00:05:00', 24) + 96 + 120 + 96, 24));
  });

  test(`playhead insert skips locked tracks and uses free space on V1 ${label}`, async () => {
    const resolve = createFakeResolve({ media: MEDIA, async: asyncApi });
    const t = new Timeline('Edit', { fps: 25 });
    t.AddTrack('video');
    t.AddTrack('audio');
    resolve.project.timelines.push(t);
    resolve.project.current = t;
    t.locked.video.add(1);
    t.SetCurrentTimecode('01:00:10:00');
    await importAndPlace(resolve, { action: 'playhead', clips: [clip('/m/silent.mp4')], binName: 'B' });
    assert.equal(t.tracks.video[0].length, 0);
    assert.equal(t.tracks.video[1].length, 1);
    assert.equal(t.tracks.video[1][0].start, t.startFrame + 250);
  });

  test(`newTimeline always creates a fresh timeline ${label}`, async () => {
    const resolve = createFakeResolve({ media: MEDIA, async: asyncApi });
    await importAndPlace(resolve, { action: 'append', clips: [clip('/m/a.mp4')], binName: 'B' });
    const first = resolve.project.current;
    const r = await importAndPlace(resolve, { action: 'newTimeline', clips: [clip('/m/b.mp4')], binName: 'B' });
    assert.equal(r.createdTimeline, true);
    assert.notEqual(resolve.project.current, first);
    assert.equal(resolve.project.timelines.length, 2);
    assert.notEqual(resolve.project.timelines[0].name, resolve.project.timelines[1].name);
  });
}

test('drop-frame timelines keep the playhead exact', async () => {
  const resolve = createFakeResolve({ media: MEDIA, newTimelineOptions: { fps: 29.97, startTc: '01:00:00;00' } });
  const t = resolve.project.pool.CreateEmptyTimeline('DF');
  resolve.project.current = t;
  t.SetCurrentTimecode('01:10:00;02');
  await importAndPlace(resolve, { action: 'playhead', clips: [clip('/m/a.mp4', { inSec: 0, outSec: 1 })], binName: 'B' });
  const placed = t.tracks.video[0][0];
  assert.equal(placed.start, t.startFrame + (tcToFrames('01:10:00;02', 29.97) - tcToFrames('01:00:00;00', 29.97)));
  assert.equal(placed.end - placed.start, 30);
  assert.equal(t.GetCurrentTimecode(), framesToTc(tcToFrames('01:10:00;02', 29.97) + 30, 29.97, true));
});

test('timecode round-trips including drop-frame', () => {
  for (const [fps, df] of [[24, false], [25, false], [29.97, true], [59.94, true], [30, false]]) {
    for (const f of [0, 1, 1799, 1800, 17982, 107892, 123456]) {
      assert.equal(tcToFrames(framesToTc(f, fps, df), fps), f, `${fps} ${f}`);
    }
  }
  assert.equal(tcToFrames('01:00:00;00', 29.97), 107892);
  assert.equal(framesToTc(1800, 29.97, true), '00:01:00;02');
});

test('reports a clear error when Resolve cannot import a file', async () => {
  const resolve = createFakeResolve({ media: {} });
  await assert.rejects(importAndPlace(resolve, { action: 'import', clips: [clip('/m/missing.mov')], binName: 'B' }), /could not import "missing.mov"/);
});
