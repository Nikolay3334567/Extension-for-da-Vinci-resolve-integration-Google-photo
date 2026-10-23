'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FakeGoogle } = require('../support/fake-google');
const { randomFile, md5 } = require('../support/fixtures');
const { DownloadManager, URGENT } = require('../../plugin/src/main/downloader');

const MiB = 1024 * 1024;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloudpool-dl-'));
}

async function setup(options = {}, files = {}) {
  const big = randomFile('big-20m.bin', 20 * MiB);
  const small = randomFile('small-300k.bin', 300 * 1024);
  const fake = new FakeGoogle(
    {
      drive: [
        { id: 'big', name: 'big.mp4', mimeType: 'video/mp4', createdTime: '2026-10-01T10:00:00Z', file: big, md5: md5(big) },
        { id: 'small', name: 'small.mp4', mimeType: 'video/mp4', createdTime: '2026-10-01T10:00:00Z', file: small },
        ...(files.extra || []),
      ],
    },
    options,
  );
  await fake.start();
  let token = fake._issueAccess();
  let unauthorizedCalls = 0;
  const dir = tmpDir();
  const mgr = new DownloadManager({
    dir: path.join(dir, '.incoming'),
    chunkSize: 1 * MiB,
    connections: 4,
    maxActive: 2,
    retryBaseMs: 20,
    logger: { warn() {}, error() {}, info() {} },
    targetFor: async (key) => ({ url: `${fake.base}/drive/v3/files/${key.split(':')[1]}?alt=media`, headers: { Authorization: `Bearer ${token}` } }),
    onUnauthorized: () => {
      unauthorizedCalls++;
      token = fake._issueAccess();
    },
  });
  return { fake, mgr, dir, big, small, unauthorized: () => unauthorizedCalls };
}

function spec(dir, key, extra = {}) {
  return { key, name: key, dir: path.join(dir, 'out'), fileName: `${key.split(':')[1]}.mp4`, ...extra };
}

test('parallel ranged download produces an identical file', async () => {
  const { fake, mgr, dir, big } = await setup({ throttleBytesPerSec: 8 * MiB });
  try {
    mgr.enqueue(spec(dir, 'drive:big'));
    const file = await mgr.whenDone('drive:big');
    assert.equal(md5(file), md5(big));
    const ranges = fake.requests(/\/files\/big$/).filter((r) => r.range);
    assert.equal(ranges.length, 20, 'one request per 1 MiB chunk');
    assert.ok(fake.peakConnections >= 3, `expected parallel connections, peak was ${fake.peakConnections}`);
    assert.equal(fs.readdirSync(path.join(dir, '.incoming')).filter((f) => f.endsWith('.part')).length, 0);
  } finally {
    await fake.stop();
  }
});

test('falls back to a single stream when the server ignores Range', async () => {
  const { fake, mgr, dir, big } = await setup({ rangeSupport: false });
  try {
    mgr.enqueue(spec(dir, 'drive:big'));
    const file = await mgr.whenDone('drive:big');
    assert.equal(md5(file), md5(big));
    assert.equal(mgr.get('drive:big').ranged, false);
  } finally {
    await fake.stop();
  }
});

test('retries transient errors and dropped connections', async () => {
  const { fake, mgr, dir, big } = await setup();
  try {
    fake.fail(/\/files\/big\?alt=media/, 503, 3);
    fake.fail(/\/files\/big\?alt=media/, 'drop', 2);
    mgr.enqueue(spec(dir, 'drive:big'));
    const file = await mgr.whenDone('drive:big');
    assert.equal(md5(file), md5(big));
  } finally {
    await fake.stop();
  }
});

test('refreshes the access token on 401', async () => {
  const { fake, mgr, dir, small, unauthorized } = await setup();
  try {
    fake.expireAccessTokens();
    mgr.enqueue(spec(dir, 'drive:small'));
    const file = await mgr.whenDone('drive:small');
    assert.equal(md5(file), md5(small));
    assert.ok(unauthorized() >= 1);
  } finally {
    await fake.stop();
  }
});

test('pause keeps finished chunks and resume does not download them again', async () => {
  const { fake, mgr, dir, big } = await setup({ throttleBytesPerSec: 2 * MiB });
  try {
    mgr.enqueue(spec(dir, 'drive:big'));
    await new Promise((resolve) => {
      const onUpdate = (s) => {
        if (s.key === 'drive:big' && s.received > 8 * MiB) {
          mgr.off('update', onUpdate);
          resolve();
        }
      };
      mgr.on('update', onUpdate);
    });
    mgr.pause('drive:big');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mgr.get('drive:big').state, 'paused');
    const plan = JSON.parse(fs.readFileSync(path.join(dir, '.incoming', fs.readdirSync(path.join(dir, '.incoming')).find((f) => f.endsWith('.part.json'))), 'utf8'));
    assert.ok(plan.done.length >= 4, `expected finished chunks, got ${plan.done.length}`);
    const before = fake.requests(/\/files\/big$/).length;
    fake.options.throttleBytesPerSec = 0;
    mgr.resume('drive:big');
    const file = await mgr.whenDone('drive:big');
    assert.equal(md5(file), md5(big));
    const after = fake.requests(/\/files\/big$/).length - before;
    assert.ok(after <= 20 - plan.done.length, `resumed run requested ${after} chunks, ${plan.done.length} were already done`);
  } finally {
    await fake.stop();
  }
});

test('verifies the Drive md5 checksum', async () => {
  const { fake, mgr, dir } = await setup();
  try {
    mgr.enqueue(spec(dir, 'drive:small', { md5: '0'.repeat(32) }));
    await assert.rejects(mgr.whenDone('drive:small'), /Checksum/);
    assert.equal(mgr.get('drive:small').state, 'error');
    assert.equal(mgr.get('drive:small').errorCode, 'CHECKSUM');
  } finally {
    await fake.stop();
  }
});

test('urgent jobs start even when background slots are busy', async () => {
  const extra = [1, 2].map((i) => ({
    id: `bg${i}`,
    name: `bg${i}.mp4`,
    mimeType: 'video/mp4',
    createdTime: '2026-10-01T10:00:00Z',
    file: randomFile(`bg-${i}.bin`, 6 * MiB),
  }));
  const { fake, mgr, dir } = await setup({ throttleBytesPerSec: 1 * MiB }, { extra });
  try {
    mgr.setLimits({ maxActive: 2, connections: 1 });
    mgr.enqueue(spec(dir, 'drive:bg1'));
    mgr.enqueue(spec(dir, 'drive:bg2'));
    mgr.enqueue(spec(dir, 'drive:big'));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(mgr.get('drive:big').state, 'queued');
    mgr.enqueue(spec(dir, 'drive:small', { priority: URGENT }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mgr.get('drive:small').state, 'active');
    await mgr.whenDone('drive:small');
    for (const k of ['drive:bg1', 'drive:bg2', 'drive:big']) await mgr.cancel(k);
  } finally {
    await fake.stop();
  }
});

test('queue survives a restart', async () => {
  const { fake, mgr, dir, big } = await setup({ throttleBytesPerSec: 2 * MiB });
  try {
    mgr.enqueue(spec(dir, 'drive:big'));
    await new Promise((r) => setTimeout(r, 1200));
    mgr.shutdown();
    await new Promise((r) => setTimeout(r, 300));
    fake.options.throttleBytesPerSec = 0;
    const token = fake._issueAccess();
    const mgr2 = new DownloadManager({
      dir: path.join(dir, '.incoming'),
      chunkSize: 1 * MiB,
      logger: { warn() {} },
      targetFor: async (key) => ({ url: `${fake.base}/drive/v3/files/${key.split(':')[1]}?alt=media`, headers: { Authorization: `Bearer ${token}` } }),
    });
    const restored = mgr2.restore();
    assert.deepEqual(restored, ['drive:big']);
    const file = await mgr2.whenDone('drive:big');
    assert.equal(md5(file), md5(big));
  } finally {
    await fake.stop();
  }
});

test('waits while Google Photos is still processing a video', async () => {
  const { fake, mgr, dir, small } = await setup();
  try {
    let processing = 2;
    const original = mgr.targetFor;
    mgr.processingRetryMs = 100;
    mgr.targetFor = async (key, opts) => {
      if (processing-- > 0) throw Object.assign(new Error('still processing'), { code: 'PROCESSING' });
      return original(key, opts);
    };
    mgr.enqueue(spec(dir, 'drive:small'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mgr.get('drive:small').state, 'queued');
    assert.equal(mgr.get('drive:small').errorCode, 'PROCESSING');
    const file = await mgr.whenDone('drive:small');
    assert.equal(md5(file), md5(small));
  } finally {
    await fake.stop();
  }
});
