'use strict';

// Fragment extraction for long videos: only the In/Out part is pulled from the cloud with
// ffmpeg (stream copy, starting on a keyframe) and the clip lands at the right frames.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FakeGoogle } = require('../support/fake-google');
const { hasFfmpeg, video } = require('../support/fixtures');
const { tmpDir, browserOpen, quiet, waitFor } = require('../support/helpers');

const ffmpeg = hasFfmpeg();

function frameHash(file, t) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return crypto.createHash('md5').update(raw).digest('hex');
}

function frameHashByIndex(file, n) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-vsync', '0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return crypto.createHash('md5').update(raw).digest('hex');
}

function startTime(file, stream) {
  return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=start_time', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
}

function durationOf(file) {
  return parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
}

function longVideo() {
  return video('long-60s-720p.mp4', { width: 1280, height: 720, fps: 30, seconds: 60, gop: 30 });
}

async function setup(fixtures, fakeOptions = {}) {
  const fake = new FakeGoogle(fixtures, fakeOptions);
  await fake.start();
  process.env.CLOUDPOOL_GOOGLE_BASE = fake.base;
  const { CloudPoolCore } = require('../../plugin/src/main/core');
  const dir = tmpDir('cloudpool-seg-');
  const core = new CloudPoolCore({
    userData: path.join(dir, 'data'),
    defaultDownloadDir: path.join(dir, 'Videos'),
    pluginDir: dir,
    openExternal: browserOpen,
    logger: quiet,
  });
  await core.start();
  core.auth.setClient({ clientId: 'seg.apps.googleusercontent.com', clientSecret: 's' });
  await core.auth.signIn();
  const placed = [];
  core.mailbox.place = async (req) => (placed.push(req), { imported: 1, placed: 1, timeline: 'T' });
  const close = async () => {
    core.shutdown();
    delete process.env.CLOUDPOOL_GOOGLE_BASE;
    await fake.stop();
  };
  return { fake, core, dir, placed, close };
}

function finished(core, id) {
  return new Promise((resolve) => {
    const onUpdate = (s) => {
      if (s.id !== id || !['done', 'error', 'canceled'].includes(s.state)) return;
      core.jobs.off('update', onUpdate);
      resolve(s);
    };
    core.jobs.on('update', onUpdate);
  });
}

function filesUnder(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

test('long video: In/Out fetches only the fragment, frame-accurately', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const long = longVideo();
  const s = await setup({ drive: [{ id: 'long', name: 'GX010042.MP4', mimeType: 'video/mp4', createdTime: '2026-10-01T10:00:00Z', file: long.file, durationMillis: 60000 }] });
  try {
    const marks = { 'drive:long': { in: 30.4, out: 34.0 } };
    const job = s.core.sendToResolve({ keys: ['drive:long'], action: 'append', marks });
    const done = await finished(s.core, job.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.entries[0].segment, true, 'fragment mode was used');

    const clip = s.placed[0].clips[0];
    assert.match(path.basename(clip.path), /^GX010042 \[00-30_00-34\]\.mp4$/);
    // Keyframes every second: the fragment starts at the keyframe at 29 s (0.5 s handle before In).
    const offset = 30.4 - clip.inSec;
    assert.ok(Math.abs(offset - 29) < 0.02, `fragment starts at ${offset}`);
    assert.ok(Math.abs(clip.outSec - (34 - offset)) < 1e-6);
    const segDuration = durationOf(clip.path);
    assert.ok(segDuration > 5.5 && segDuration < 6.6, `fragment is ${segDuration}s`);

    // The frame at In inside the fragment is exactly the frame at In in the original — both for
    // players that use timestamps and for ones that count frames from the first frame.
    assert.equal(startTime(clip.path, 'v:0'), 0);
    assert.equal(frameHash(clip.path, clip.inSec), frameHash(long.file, 30.4));
    assert.equal(frameHash(clip.path, clip.outSec - 0.5), frameHash(long.file, 33.5));
    assert.equal(frameHashByIndex(clip.path, Math.round(clip.inSec * 30)), frameHashByIndex(long.file, Math.round(30.4 * 30)));

    // Far less than the whole file came over the network.
    const size = fs.statSync(long.file).size;
    assert.ok(s.fake.bytesSent < size * 0.45, `transferred ${s.fake.bytesSent} of ${size} bytes`);
    // The whole file was not downloaded.
    assert.equal(s.core.localPath('drive:long'), null);

    // Sending the same marks again (e.g. after an undo in Resolve) reuses the fragment.
    const sent = s.fake.bytesSent;
    const again = s.core.sendToResolve({ keys: ['drive:long'], action: 'append', marks });
    assert.equal((await finished(s.core, again.id)).state, 'done');
    assert.equal(s.placed[1].clips[0].path, clip.path);
    assert.equal(s.placed[1].clips[0].inSec, clip.inSec);
    assert.equal(s.fake.bytesSent, sent, 'nothing was transferred again');
  } finally {
    await s.close();
  }
});

test('Google Photos video: the duration is read from the stream, then only the fragment is fetched', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 120000 }, async () => {
  const long = longVideo();
  // Google Photos reports no duration: it comes from probing the MP4 index over Range.
  const s = await setup({ photos: [{ id: 'p1', filename: 'PXL_20261001_101500.mp4', mimeType: 'video/mp4', type: 'VIDEO', createTime: '2026-10-01T10:15:00Z', width: 1280, height: 720, file: long.file }] });
  try {
    s.core.updateSettings({ autoDownloadVideos: false });
    const picked = waitFor(s.core.photos, 'picked');
    await s.core.photos.startPicking();
    await picked;
    const job = s.core.sendToResolve({ keys: ['photos:p1'], action: 'append', marks: { 'photos:p1': { in: 40, out: 42 } } });
    const done = await finished(s.core, job.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.entries[0].segment, true, 'fragment mode was used');
    const clip = s.placed[0].clips[0];
    assert.match(path.basename(clip.path), /^PXL_20261001_101500 \[00-40_00-42\]\.mp4$/);
    assert.ok(Math.abs(40 - clip.inSec - 39) < 0.02, `fragment starts at ${40 - clip.inSec}`);
    assert.equal(frameHash(clip.path, clip.inSec), frameHash(long.file, 40));
    assert.ok(s.fake.bytesSent < fs.statSync(long.file).size * 0.3, `transferred ${s.fake.bytesSent} bytes`);
  } finally {
    await s.close();
  }
});

test('cancelling a job stops the fragment download and leaves no partial file', { skip: !ffmpeg && 'ffmpeg not installed', timeout: 60000 }, async () => {
  const long = longVideo();
  // ~256 KB/s per connection: the fragment takes many seconds, plenty of time to cancel.
  const s = await setup({ drive: [{ id: 'long', name: 'GX010043.MP4', mimeType: 'video/mp4', createdTime: '2026-10-01T10:00:00Z', file: long.file, durationMillis: 60000 }] }, { throttleBytesPerSec: 256 * 1024 });
  try {
    const job = s.core.sendToResolve({ keys: ['drive:long'], action: 'append', marks: { 'drive:long': { in: 20, out: 30 } } });
    const result = finished(s.core, job.id);
    const videos = path.join(s.dir, 'Videos');
    const deadline = Date.now() + 20000;
    while (!(fs.existsSync(videos) && filesUnder(videos).some((f) => f.endsWith('.part.mp4')))) {
      assert.ok(Date.now() < deadline, 'ffmpeg never started writing');
      await new Promise((r) => setTimeout(r, 50));
    }
    s.core.jobs.cancel(job.id);
    const done = await result;
    assert.equal(done.state, 'canceled');
    assert.equal(s.placed.length, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(filesUnder(videos), [], 'no fragment left behind');
    // Cancelling must not fall back to downloading the whole file.
    assert.equal(s.core.downloads.get('drive:long'), null);
  } finally {
    await s.close();
  }
});

test('short clips and unmarked clips still download the whole file', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const short = video('short-8s.mp4', { seconds: 8 });
  const s = await setup({ drive: [{ id: 'short', name: 'short.mp4', mimeType: 'video/mp4', createdTime: '2026-10-01T10:00:00Z', file: short.file, durationMillis: 8000 }] });
  try {
    assert.equal(await s.core.ensureSegment('drive:short', { inSec: 2, outSec: 4 }), null);
  } finally {
    await s.close();
  }
});
