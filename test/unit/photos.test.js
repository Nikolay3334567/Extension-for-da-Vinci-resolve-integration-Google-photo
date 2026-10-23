'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeGoogle } = require('../support/fake-google');
const { randomFile } = require('../support/fixtures');
const { signedInAuth, jsonStore, browserOpen, waitFor, quiet } = require('../support/helpers');
const { PhotosLibrary } = require('../../plugin/src/main/photos');

function photoFixtures(n = 3) {
  const file = randomFile('photo-media.bin', 64 * 1024);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `p${i}`,
      filename: i % 2 ? `IMG_${i}.HEIC` : `PXL_${i}.mp4`,
      mimeType: i % 2 ? 'image/heic' : 'video/mp4',
      type: i % 2 ? 'PHOTO' : 'VIDEO',
      createTime: `2026-10-0${i + 1}T12:00:00Z`,
      width: 1920,
      height: 1080,
      fps: 30,
      cameraMake: 'Google',
      cameraModel: 'Pixel 9',
      file,
      thumb: file,
    });
  }
  return out;
}

async function makeLibrary(fake) {
  const { auth, endpoints, dir } = await signedInAuth(fake);
  const store = jsonStore(dir, 'library.json', { items: {}, sessions: {} });
  const lib = new PhotosLibrary({ auth, base: endpoints.picker, store, openExternal: browserOpen, logger: quiet });
  return { lib, store, auth, dir };
}

test('picking adds the selected items to the library', async () => {
  const fake = new FakeGoogle({ photos: photoFixtures(5) });
  await fake.start();
  try {
    const { lib } = await makeLibrary(fake);
    const picked = waitFor(lib, 'picked');
    const state = await lib.startPicking();
    assert.equal(state.state, 'waiting');
    // Opening the picker URL used the /autoclose variant.
    assert.ok(fake.requests(/\/picker-ui\/.+\/autoclose$/).length === 1);
    const { added } = await picked;
    assert.equal(added.length, 5);
    assert.equal(lib.pickerState().state, 'done');
    const video = lib.get('p0');
    assert.equal(video.kind, 'video');
    assert.equal(video.camera, 'Google Pixel 9');
    assert.equal(video.processing, 'READY');
    assert.ok(video._baseUrl.startsWith(fake.base));
    const photo = lib.get('p1');
    assert.equal(photo.kind, 'photo');
    assert.equal(photo.name, 'IMG_1.HEIC');
  } finally {
    await fake.stop();
  }
});

test('picking the same item again refreshes it instead of duplicating', async () => {
  const fake = new FakeGoogle({ photos: photoFixtures(2) });
  await fake.start();
  try {
    const { lib } = await makeLibrary(fake);
    let picked = waitFor(lib, 'picked');
    await lib.startPicking();
    await picked;
    const firstUrl = lib.get('p0')._baseUrl;
    await new Promise((r) => setTimeout(r, 5));
    picked = waitFor(lib, 'picked');
    await lib.startPicking();
    const result = await picked;
    assert.equal(result.added.length, 0);
    assert.equal(result.updated.length, 2);
    assert.equal(lib.list().length, 2);
    assert.notEqual(lib.get('p0')._baseUrl, firstUrl);
  } finally {
    await fake.stop();
  }
});

test('freshBaseUrl re-lists the session when the URL is old', async () => {
  const fake = new FakeGoogle({ photos: photoFixtures(1) });
  await fake.start();
  try {
    const { lib } = await makeLibrary(fake);
    const picked = waitFor(lib, 'picked');
    await lib.startPicking();
    await picked;
    const item = lib.get('p0');
    item._baseUrlAt -= 55 * 60 * 1000; // pretend it is 55 minutes old
    const before = fake.requests(/\/picker\/v1\/mediaItems/).length;
    const url = await lib.freshBaseUrl('p0');
    assert.ok(url.startsWith(fake.base));
    assert.equal(fake.requests(/\/picker\/v1\/mediaItems/).length, before + 1);
    assert.ok(Date.now() - lib.get('p0')._baseUrlAt < 5000);
  } finally {
    await fake.stop();
  }
});

test('items of a deleted session report as expired', async () => {
  const fake = new FakeGoogle({ photos: photoFixtures(1) });
  await fake.start();
  try {
    const { lib } = await makeLibrary(fake);
    const picked = waitFor(lib, 'picked');
    await lib.startPicking();
    await picked;
    fake.sessions.clear(); // Google forgot the session
    lib.get('p0')._baseUrlAt = 0;
    await assert.rejects(lib.freshBaseUrl('p0'), (err) => err.code === 'PHOTOS_EXPIRED');
    assert.equal(lib.isReachable(lib.get('p0')), false);
  } finally {
    await fake.stop();
  }
});

test('cancelling picking deletes the session', async () => {
  const fake = new FakeGoogle({ photos: photoFixtures(1) }, { autoPick: false });
  await fake.start();
  try {
    const { lib } = await makeLibrary(fake);
    await lib.startPicking();
    assert.equal(fake.sessions.size, 1);
    lib.cancelPicking();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.sessions.size, 0);
    assert.equal(lib.pickerState().state, 'cancelled');
  } finally {
    await fake.stop();
  }
});

test('removing items releases sessions nobody uses any more', async () => {
  const fake = new FakeGoogle({ photos: photoFixtures(2) });
  await fake.start();
  try {
    const { lib } = await makeLibrary(fake);
    const picked = waitFor(lib, 'picked');
    await lib.startPicking();
    await picked;
    lib.remove(['p0']);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.sessions.size, 1, 'session still backs p1');
    lib.remove(['p1']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fake.sessions.size, 0);
  } finally {
    await fake.stop();
  }
});
