'use strict';

// Disk-backed thumbnail cache with a prioritised, cancellable fetch queue.
// Google renders thumbnails server-side at any requested size, so the grid always downloads
// exactly the resolution it needs. The newest requests are served first (they belong to what
// is on screen right now) and requests for tiles that scrolled away are dropped.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sha1, abortError, isAbortError } = require('./util');

const BUCKETS = [96, 128, 192, 256, 384, 512, 768, 1024, 1600, 2048];

function bucketFor(size) {
  const s = Number(size) || 256;
  return BUCKETS.find((b) => b >= s) || BUCKETS[BUCKETS.length - 1];
}

function sniffImageType(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

class TaskQueue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = []; // LIFO
  }

  /** `task` = { run: () => Promise, waiters: number, settle } */
  push(task) {
    this.pending.push(task);
    this._pump();
  }

  drop(task) {
    const i = this.pending.indexOf(task);
    if (i >= 0) this.pending.splice(i, 1);
    return i >= 0;
  }

  _pump() {
    while (this.running < this.concurrency && this.pending.length) {
      const task = this.pending.pop();
      this.running++;
      task.started = true;
      task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running--;
          this._pump();
        });
    }
  }
}

class ThumbCache {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {number} opts.maxBytes
   * @param {(item: object, size: number, signal: AbortSignal) => Promise<Buffer>} opts.fetcher
   */
  constructor({ dir, maxBytes = 1024 * 1024 * 1024, fetcher, concurrency = 8, logger = console }) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.fetcher = fetcher;
    this.logger = logger;
    this.queue = new TaskQueue(concurrency);
    this.inflight = new Map(); // cacheKey -> task
    this.index = new Map(); // sha -> Map(bucket -> { size, t })
    this.totalBytes = 0;
    this.scanned = this._scan();
    this.evicting = null;
  }

  async _scan() {
    let shards = [];
    try {
      shards = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const shard of shards) {
      let files = [];
      try {
        files = await fsp.readdir(path.join(this.dir, shard));
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^([0-9a-f]{40})_(\d+)\.img$/.exec(f);
        if (!m) continue;
        try {
          const st = await fsp.stat(path.join(this.dir, shard, f));
          this._indexAdd(m[1], Number(m[2]), st.size, st.mtimeMs);
        } catch {
          /* raced with deletion */
        }
      }
    }
  }

  _indexAdd(sha, bucket, size, t = Date.now()) {
    let entry = this.index.get(sha);
    if (!entry) {
      entry = new Map();
      this.index.set(sha, entry);
    }
    const prev = entry.get(bucket);
    if (prev) this.totalBytes -= prev.size;
    entry.set(bucket, { size, t });
    this.totalBytes += size;
  }

  fileFor(sha, bucket) {
    return path.join(this.dir, sha.slice(0, 2), `${sha}_${bucket}.img`);
  }

  /** Best cached size for `sha`: the smallest ≥ wanted, else the largest below it. */
  _cachedBucket(sha, bucket, { allowSmaller }) {
    const entry = this.index.get(sha);
    if (!entry || !entry.size) return null;
    const sizes = [...entry.keys()].sort((a, b) => a - b);
    const bigger = sizes.find((s) => s >= bucket);
    if (bigger) return bigger;
    return allowSmaller ? sizes[sizes.length - 1] : null;
  }

  /**
   * Returns { file, bucket, type } for an item thumbnail, downloading it if needed.
   * Rejects with AbortError when every caller gave up before the fetch started.
   */
  async get(item, size, signal) {
    await this.scanned;
    const bucket = bucketFor(size);
    const sha = sha1(item.key);
    const hit = this._cachedBucket(sha, bucket, { allowSmaller: false });
    if (hit) return this._hit(sha, hit);

    const cacheKey = `${sha}_${bucket}`;
    let task = this.inflight.get(cacheKey);
    if (!task) {
      task = { waiters: 0, started: false };
      task.promise = new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
      });
      task.run = () => this._fetch(item, sha, bucket);
      this.inflight.set(cacheKey, task);
      task.promise.then(
        () => this.inflight.delete(cacheKey),
        () => this.inflight.delete(cacheKey),
      );
      this.queue.push(task);
    }
    task.waiters++;
    let result;
    try {
      result = await waitWithSignal(task.promise, signal, () => {
        task.waiters--;
        if (task.waiters <= 0 && !task.started && this.queue.drop(task)) task.reject(abortError());
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Could not refresh (e.g. Google Photos access expired) — fall back to any cached size.
      const fallback = this._cachedBucket(sha, bucket, { allowSmaller: true });
      if (fallback) return this._hit(sha, fallback);
      throw err;
    }
    return result;
  }

  /** Any cached thumbnail for `key` (used when the item itself can no longer be resolved). */
  async getCached(key, size) {
    await this.scanned;
    const sha = sha1(key);
    const bucket = this._cachedBucket(sha, bucketFor(size), { allowSmaller: true });
    return bucket ? this._hit(sha, bucket) : null;
  }

  /** Path of the best cached thumbnail, synchronously (for drag icons). */
  peekFile(key) {
    const sha = sha1(key);
    const bucket = this._cachedBucket(sha, 256, { allowSmaller: true });
    return bucket ? this.fileFor(sha, bucket) : null;
  }

  _hit(sha, bucket) {
    const meta = this.index.get(sha).get(bucket);
    meta.t = Date.now();
    return { file: this.fileFor(sha, bucket), bucket };
  }

  async _fetch(item, sha, bucket) {
    const buf = await this.fetcher(item, bucket);
    const file = this.fileFor(sha, bucket);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    this._indexAdd(sha, bucket, buf.length);
    if (this.totalBytes > this.maxBytes) this._evictSoon();
    return { file, bucket };
  }

  _evictSoon() {
    if (this.evicting) return;
    this.evicting = (async () => {
      const entries = [];
      for (const [sha, buckets] of this.index) {
        for (const [bucket, meta] of buckets) entries.push({ sha, bucket, ...meta });
      }
      entries.sort((a, b) => a.t - b.t);
      const target = this.maxBytes * 0.8;
      for (const e of entries) {
        if (this.totalBytes <= target) break;
        try {
          await fsp.unlink(this.fileFor(e.sha, e.bucket));
        } catch {
          /* already gone */
        }
        const buckets = this.index.get(e.sha);
        if (buckets && buckets.delete(e.bucket)) this.totalBytes -= e.size;
        if (buckets && !buckets.size) this.index.delete(e.sha);
      }
    })().finally(() => {
      this.evicting = null;
    });
  }

  stats() {
    let files = 0;
    for (const b of this.index.values()) files += b.size;
    return { bytes: this.totalBytes, files };
  }

  async clear() {
    await this.scanned;
    this.index.clear();
    this.totalBytes = 0;
    await fsp.rm(this.dir, { recursive: true, force: true });
  }
}

function waitWithSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

module.exports = { ThumbCache, bucketFor, sniffImageType, BUCKETS };
