'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FakeGoogle } = require('../support/fake-google');
const { hasFfmpeg, video, image, randomFile } = require('../support/fixtures');
const { signedInAuth, jsonStore, browserOpen, waitFor, quiet } = require('../support/helpers');
const { PhotosLibrary } = require('../../plugin/src/main/photos');
const { DriveApi } = require('../../plugin/src/main/drive');
const { MediaSources } = require('../../plugin/src/main/media-source');
const { ThumbCache } = require('../../plugin/src/main/thumbs');
const { MediaServer } = require('../../plugin/src/main/media-server');
const { request, readBody } = require('../../plugin/src/main/http');
const { probeMp4, cachedReader } = require('../../plugin/src/main/mp4');

const ffmpeg = hasFfmpeg();

async function stack(options = {}) {
  const v = ffmpeg ? video('clip-a.mp4', { seconds: 3, fps: 30 }) : { file: randomFile('fake.mp4', 200000) };
  const thumb = ffmpeg ? image('thumb-a.jpg', { width: 256, height: 144 }) : { file: randomFile('fake.jpg', 2000) };
  const fake = new FakeGoogle(
    {
      photos: [{ id: 'v1', filename: 'PXL_1.mp4', mimeType: 'video/mp4', type: 'VIDEO', createTime: '2026-10-20T10:00:00Z', width: 640, height: 360, fps: 30, file: v.file, thumb: thumb.file }],
      drive: [{ id: 'd1', name: 'drone.mp4', mimeType: 'video/mp4', createdTime: '2026-10-19T10:00:00Z', file: v.file, thumb: thumb.file, durationMillis: 3000 }],
    },
    options,
  );
  await fake.start();
  const { auth, endpoints, dir } = await signedInAuth(fake);
  const photos = new PhotosLibrary({ auth, base: endpoints.picker, store: jsonStore(dir, 'lib.json'), openExternal: browserOpen, logger: quiet });
  const picked = waitFor(photos, 'picked');
  await photos.startPicking();
  await picked;
  const drive = new DriveApi({ auth, base: endpoints.drive });
  const sources = new MediaSources({ auth, photos, drive });
  const thumbs = new ThumbCache({ dir: path.join(dir, 'thumbs'), fetcher: (item, size, signal) => sources.fetchThumbnail(item, size, signal), logger: quiet });
  const local = new Map();
  const server = new MediaServer({
    resolveItem: (key) => sources.resolve(key),
    localFile: (key) => local.get(key) || null,
    thumbs,
    openStream: (item, o) => sources.openStream(item, o),
    logger: quiet,
  });
  const base = await server.start();
  return { fake, server, base, thumbs, sources, local, video: v, dir, drive };
}

async function get(url, headers = {}) {
  const res = await request(url, { headers });
  const body = await readBody(res);
  return { status: res.statusCode, headers: res.headers, body };
}

test('media server rejects requests without the secret or with a foreign Host', async () => {
  const s = await stack();
  try {
    const noToken = await get(`http://127.0.0.1:${s.server.port}/wrong/ping`);
    assert.equal(noToken.status, 403);
    const rebinding = await get(`${s.base}/ping`, { Host: 'evil.example:80' });
    assert.equal(rebinding.status, 403);
    assert.equal((await get(`${s.base}/ping`)).status, 200);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('thumbnails are fetched once and then served from disk', async () => {
  const s = await stack();
  try {
    const url = `${s.base}/thumb/${encodeURIComponent('photos:v1')}?s=200`;
    const a = await get(url);
    assert.equal(a.status, 200);
    const b = await get(url);
    assert.equal(b.status, 200);
    assert.ok(a.body.equals(b.body));
    assert.equal(s.fake.requests(/\/media\/photos\/v1\/.+=w256-h256$/).length, 1);
    // A smaller size is served from the bigger cached file without another request.
    await get(`${s.base}/thumb/${encodeURIComponent('photos:v1')}?s=100`);
    assert.equal(s.fake.requests(/=w\d+-h\d+$/).length, 1);
    const d = await get(`${s.base}/thumb/${encodeURIComponent('drive:d1')}?s=300`);
    assert.equal(d.status, 200);
    assert.equal(s.fake.requests(/\/drive-thumb\/d1=s384$/).length, 1);
    assert.equal(s.thumbs.stats().files, 2);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('stream proxies Range requests to Google with authorisation', async () => {
  const s = await stack({ redirectMedia: true });
  try {
    const size = fs.statSync(s.video.file).size;
    const r = await get(`${s.base}/stream/${encodeURIComponent('photos:v1')}`, { Range: 'bytes=100-1099' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], `bytes 100-1099/${size}`);
    assert.equal(r.body.length, 1000);
    assert.ok(r.body.equals(fs.readFileSync(s.video.file).subarray(100, 1100)));
    const drive = await get(`${s.base}/stream/${encodeURIComponent('drive:d1')}`, { Range: 'bytes=0-9' });
    assert.equal(drive.status, 206);
    assert.equal(drive.body.length, 10);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('stream serves the local file once downloaded (with Range)', async () => {
  const s = await stack();
  try {
    const file = randomFile('local-copy.bin', 5000);
    s.local.set('photos:v1', file);
    const before = s.fake.log.length;
    const r = await get(`${s.base}/stream/${encodeURIComponent('photos:v1')}`, { Range: 'bytes=-100' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 4900-4999/5000');
    assert.equal(s.fake.log.length, before, 'no Google request');
    const bad = await get(`${s.base}/stream/${encodeURIComponent('photos:v1')}`, { Range: 'bytes=6000-7000' });
    assert.equal(bad.status, 416);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('unknown items return 404 and expired Photos items 410', async () => {
  const s = await stack();
  try {
    assert.equal((await get(`${s.base}/stream/${encodeURIComponent('photos:nope')}`)).status, 404);
    s.fake.sessions.clear();
    s.sources.photos.get('v1')._baseUrlAt = 0;
    assert.equal((await get(`${s.base}/stream/${encodeURIComponent('photos:v1')}`)).status, 410);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('mp4 probe reads duration and frame rate over HTTP ranges', { skip: !ffmpeg && 'ffmpeg not installed' }, async () => {
  const s = await stack();
  try {
    for (const faststart of [false, true]) {
      const v = video(faststart ? 'probe-fast.mp4' : 'probe-slow.mp4', { width: 360, height: 640, fps: 60, seconds: 2, faststart });
      s.fake.fixtures.photos[0].file = v.file;
      const size = fs.statSync(v.file).size;
      let reads = 0;
      const readAt = cachedReader(async (offset, length) => {
        reads++;
        const end = Math.min(size, offset + length) - 1;
        const res = await s.sources.openStream(s.sources.photos.get('v1'), { range: `bytes=${offset}-${end}` });
        return readBody(res);
      });
      const info = await probeMp4(readAt, size);
      assert.ok(Math.abs(info.durationSec - 2) < 0.1, `duration ${info.durationSec}`);
      assert.equal(info.video.fps, 60);
      assert.equal(info.video.width, 360);
      assert.equal(info.video.height, 640);
      assert.equal(info.video.codec, 'avc1');
      assert.equal(info.audio.codec, 'mp4a');
      assert.equal(info.audio.sampleRate, 48000);
      assert.ok(reads <= 4, `took ${reads} reads`);
    }
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('open-ended ranges are served from growing upstream chunks and stop when the client hangs up', async () => {
  const big = randomFile('stream-12m.bin', 12 * 1024 * 1024);
  const s = await stack();
  try {
    s.fake.fixtures.drive.push({ id: 'big', name: 'big.mp4', mimeType: 'video/mp4', createdTime: '2026-10-19T10:00:00Z', file: big });
    // Full read through the chunked path is byte-identical.
    const full = await get(`${s.base}/stream/${encodeURIComponent('drive:big')}`, { Range: 'bytes=0-' });
    assert.equal(full.status, 206);
    assert.equal(full.headers['content-range'], `bytes 0-${12 * 1024 * 1024 - 1}/${12 * 1024 * 1024}`);
    assert.ok(full.body.equals(fs.readFileSync(big)));
    // (The metadata lookup hits the same path without a Range.)
    const chunks = s.fake
      .requests(/\/files\/big$/)
      .map((r) => r.range)
      .filter(Boolean);
    assert.deepEqual(chunks.slice(0, 3), ['bytes=0-1048575', 'bytes=1048576-3145727', 'bytes=3145728-7340031']);

    // A player that seeks away after a few KB costs at most the first chunk.
    s.fake.bytesSent = 0;
    const res = await request(`${s.base}/stream/${encodeURIComponent('drive:big')}`, { headers: { Range: 'bytes=4194304-' } });
    assert.equal(res.statusCode, 206);
    await new Promise((resolve) => {
      res.once('data', () => {
        res.destroy();
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(s.fake.bytesSent <= 1024 * 1024, `upstream sent ${s.fake.bytesSent} bytes`);

    // Requests without Range get a plain 200.
    const plain = await get(`${s.base}/stream/${encodeURIComponent('drive:big')}`);
    assert.equal(plain.status, 200);
    assert.equal(plain.body.length, 12 * 1024 * 1024);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});

test('a dropped connection between chunks is retried; a persistent failure breaks the response', async () => {
  const big = randomFile('stream-12m.bin', 12 * 1024 * 1024);
  const s = await stack();
  try {
    s.fake.fixtures.drive.push({ id: 'big', name: 'big.mp4', mimeType: 'video/mp4', createdTime: '2026-10-19T10:00:00Z', file: big });
    const url = `${s.base}/stream/${encodeURIComponent('drive:big')}`;
    // Injects the fault once the first chunk is flowing, so it hits the next chunk's request.
    const read = (onFirstData) =>
      request(url, { headers: { Range: 'bytes=0-' } }).then(
        (res) =>
          new Promise((resolve) => {
            const parts = [];
            const done = (ok) => resolve({ ok, body: Buffer.concat(parts) });
            res.once('data', onFirstData);
            res.on('data', (d) => parts.push(d));
            res.on('end', () => done(true));
            res.on('error', () => done(false));
            res.on('aborted', () => done(false));
          }),
      );
    const once = await read(() => s.fake.fail(/\/files\/big/, 'drop', 1));
    assert.equal(once.ok, true);
    assert.ok(once.body.equals(fs.readFileSync(big)), 'retried chunk keeps the bytes intact');

    const always = await read(() => s.fake.fail(/\/files\/big/, 'drop', 10));
    assert.equal(always.ok, false, 'the client sees an error, not a silently short file');
    assert.ok(always.body.length < 12 * 1024 * 1024);
  } finally {
    s.server.stop();
    await s.fake.stop();
  }
});
