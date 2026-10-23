'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResolveJobs } = require('../../plugin/src/main/jobs');
const { quiet } = require('../support/helpers');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup({ bridge } = {}) {
  const downloads = new Map();
  const calls = [];
  const jobs = new ResolveJobs({
    getBridge: () =>
      bridge === null
        ? null
        : bridge || {
          place: async (req) => {
            calls.push(req);
            return { imported: req.clips.length, reused: 0, placed: req.action === 'import' ? 0 : req.clips.length, timeline: 'T' };
          },
        },
    ensureLocal: (key) => {
      if (!downloads.has(key)) downloads.set(key, deferred());
      return downloads.get(key).promise;
    },
    describe: (key) => ({ name: key, kind: 'video', source: key.split(':')[0] }),
    options: () => ({ binName: 'Google Photos', driveBinName: 'Google Drive' }),
    logger: quiet,
  });
  const finished = (id) =>
    new Promise((resolve) => {
      const check = (s) => {
        if (s.id === id && ['done', 'error', 'canceled'].includes(s.state)) {
          jobs.off('update', check);
          resolve(s);
        }
      };
      jobs.on('update', check);
    });
  return { jobs, downloads, calls, finished };
}

test('clips are placed in the chosen order even when they finish downloading out of order', async () => {
  const { jobs, downloads, calls, finished } = setup();
  const job = jobs.add({ keys: ['photos:a', 'photos:b', 'photos:c'], action: 'append', marks: { 'photos:b': { in: 1, out: 3 } } });
  const done = finished(job.id);
  downloads.get('photos:c').resolve('/x/c.mp4');
  downloads.get('photos:b').resolve('/x/b.mp4');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0, 'nothing placed before the first clip is ready');
  downloads.get('photos:a').resolve('/x/a.mp4');
  const result = await done;
  assert.equal(result.state, 'done');
  assert.equal(calls.length, 1, 'ready clips are sent together');
  assert.deepEqual(calls[0].clips.map((c) => c.path), ['/x/a.mp4', '/x/b.mp4', '/x/c.mp4']);
  assert.equal(calls[0].clips[1].inSec, 1);
  assert.equal(calls[0].clips[1].outSec, 3);
  assert.equal(calls[0].binName, 'Google Photos');
});

test('the first clip goes to Resolve while later ones are still downloading', async () => {
  const { jobs, downloads, calls, finished } = setup();
  const job = jobs.add({ keys: ['drive:a', 'drive:b'], action: 'newTimeline' });
  const done = finished(job.id);
  downloads.get('drive:a').resolve('/x/a.mp4');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'newTimeline');
  assert.equal(calls[0].binName, 'Google Drive');
  downloads.get('drive:b').resolve('/x/b.mp4');
  await done;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'append', 'later batches append to the new timeline');
});

test('failed downloads are skipped, the rest is placed', async () => {
  const { jobs, downloads, calls, finished } = setup();
  const job = jobs.add({ keys: ['photos:a', 'photos:b'], action: 'append' });
  const done = finished(job.id);
  downloads.get('photos:a').reject(Object.assign(new Error('expired'), { code: 'PHOTOS_EXPIRED' }));
  downloads.get('photos:b').resolve('/x/b.mp4');
  const result = await done;
  assert.equal(result.state, 'done');
  assert.equal(result.result.skipped, 1);
  assert.deepEqual(calls[0].clips.map((c) => c.key), ['photos:b']);
  assert.equal(result.entries[0].state, 'error');
});

test('without a Resolve connection the job reports NO_RESOLVE after downloading', async () => {
  const { jobs, downloads, finished } = setup({ bridge: null });
  const job = jobs.add({ keys: ['photos:a'], action: 'append' });
  const done = finished(job.id);
  downloads.get('photos:a').resolve('/x/a.mp4');
  const result = await done;
  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'NO_RESOLVE');
});

test('jobs run one after another', async () => {
  const order = [];
  const bridge = {
    place: async (req) => {
      order.push(req.clips[0].key);
      return { imported: 1, placed: 1 };
    },
  };
  const { jobs, downloads, finished } = setup({ bridge });
  const j1 = jobs.add({ keys: ['photos:slow'], action: 'append' });
  const j2 = jobs.add({ keys: ['photos:fast'], action: 'append' });
  const d2 = finished(j2.id);
  downloads.get('photos:fast').resolve('/x/fast.mp4');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  downloads.get('photos:slow').resolve('/x/slow.mp4');
  await d2;
  assert.deepEqual(order, ['photos:slow', 'photos:fast']);
  assert.equal(jobs.list().find((j) => j.id === j1.id).state, 'done');
});
