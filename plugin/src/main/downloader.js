'use strict';

// Accelerated, resumable downloads. A file is split into fixed-size chunks that several
// keep-alive connections fetch in order with HTTP Range requests and write straight to their
// offsets in a pre-sized ".part" file. Finished chunks are recorded, so pausing, a crash or a
// network drop only loses the chunks that were in flight. Chunks are taken front-to-back, which
// keeps writes nearly sequential (friendly to NTFS/HDDs) and makes the file fill in order.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request, readBody, errorFromResponse, parseContentRange, isTransientError, HttpError } = require('./http');
const { sleep, isAbortError, abortError, uniquePath, sha1, throttle } = require('./util');

const MiB = 1024 * 1024;
const URGENT = 100;
const MAX_ATTEMPTS = 7;

async function moveFile(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

async function md5File(file, signal) {
  const hash = crypto.createHash('md5');
  const stream = fs.createReadStream(file, { highWaterMark: 4 * MiB });
  for await (const chunk of stream) {
    if (signal && signal.aborted) {
      stream.destroy();
      throw abortError();
    }
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function backoff(attempt, base) {
  return Math.min(15000, base * 2 ** attempt) + Math.floor(Math.random() * (base / 2));
}

class DownloadManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.dir   working directory for .part files (same volume as the library)
   * @param {(key: string, opts: {force: boolean}) => Promise<{url: string, headers: object}>} opts.targetFor
   * @param {() => void} [opts.onUnauthorized]  invalidates the cached access token
   */
  constructor({ dir, targetFor, onUnauthorized = () => {}, maxActive = 2, connections = 6, chunkSize = 8 * MiB, retryBaseMs = 500, logger = console }) {
    super();
    this.dir = dir;
    this.targetFor = targetFor;
    this.onUnauthorized = onUnauthorized;
    this.maxActive = maxActive;
    this.connections = connections;
    this.chunkSize = chunkSize;
    this.retryBaseMs = retryBaseMs;
    this.processingRetryMs = 30000;
    this.logger = logger;
    this.jobs = new Map();
    this.seq = 0;
    this.reserved = new Set();
    this._persistQueue = throttle(() => this._writeQueue(), 1000);
  }

  setLimits({ maxActive, connections }) {
    if (maxActive) this.maxActive = Math.max(1, Math.min(6, maxActive));
    if (connections) this.connections = Math.max(1, Math.min(16, connections));
    this._pump();
  }

  snapshot(job) {
    return {
      key: job.key,
      name: job.name,
      state: job.state,
      priority: job.priority,
      received: job.received,
      total: job.total,
      speed: job.speed,
      eta: job.speed > 0 && job.total ? Math.max(0, (job.total - job.received) / job.speed) : null,
      error: job.error,
      errorCode: job.errorCode || null,
      path: job.path || null,
      ranged: job.ranged,
    };
  }

  get(key) {
    const job = this.jobs.get(key);
    return job ? this.snapshot(job) : null;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.snapshot(j));
  }

  /**
   * Adds (or re-prioritises) a download.
   * spec: { key, name, dir, fileName, expectedSize, md5, priority, meta }
   */
  enqueue(spec) {
    let job = this.jobs.get(spec.key);
    if (job) {
      if (spec.priority != null && spec.priority > job.priority) job.priority = spec.priority;
      if (job.state === 'error' || job.state === 'canceled' || (job.state === 'paused' && spec.resume)) {
        job.state = 'queued';
        job.error = null;
        job.errorCode = null;
      }
      Object.assign(job, { dir: spec.dir || job.dir, fileName: spec.fileName || job.fileName, meta: spec.meta || job.meta });
      this._changed(job);
      this._pump();
      return this.snapshot(job);
    }
    const id = sha1(spec.key);
    job = {
      key: spec.key,
      name: spec.name || spec.fileName,
      dir: spec.dir,
      fileName: spec.fileName,
      expectedSize: spec.expectedSize || null,
      md5: spec.md5 || null,
      meta: spec.meta || {},
      priority: spec.priority || 0,
      seq: ++this.seq,
      state: spec.paused ? 'paused' : 'queued',
      received: 0,
      total: spec.expectedSize || null,
      speed: 0,
      error: null,
      partFile: path.join(this.dir, `${id}.part`),
      planFile: path.join(this.dir, `${id}.part.json`),
      waiters: [],
      samples: [],
    };
    this.jobs.set(job.key, job);
    this._changed(job);
    this._pump();
    return this.snapshot(job);
  }

  /** Resolves with the final path once the job completes. */
  whenDone(key) {
    const job = this.jobs.get(key);
    if (!job) return Promise.reject(new Error('Unknown download'));
    if (job.state === 'done') return Promise.resolve(job.path);
    return new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
  }

  pause(key) {
    const job = this.jobs.get(key);
    if (!job) return;
    if (job.state === 'active' || job.state === 'verifying') {
      job.pauseRequested = true;
      job.controller.abort();
    } else if (job.state === 'queued' || job.state === 'error') {
      job.state = 'paused';
      this._changed(job);
    }
  }

  resume(key) {
    const job = this.jobs.get(key);
    if (!job || job.state === 'active' || job.state === 'verifying' || job.state === 'done') return;
    job.state = 'queued';
    job.error = null;
    job.errorCode = null;
    job.retryAt = 0;
    this._changed(job);
    this._pump();
  }

  async cancel(key) {
    const job = this.jobs.get(key);
    if (!job) return;
    if (job.state === 'active' || job.state === 'verifying') {
      job.cancelRequested = true;
      job.controller.abort();
      return;
    }
    await this._discard(job);
  }

  async _discard(job) {
    this.jobs.delete(job.key);
    for (const f of [job.partFile, job.planFile]) await fsp.unlink(f).catch(() => {});
    job.state = 'canceled';
    const err = new Error('Download cancelled');
    err.code = 'CANCELED';
    for (const w of job.waiters.splice(0)) w.reject(err);
    this.emit('removed', job.key);
    this._persistQueue();
  }

  clearFinished() {
    for (const job of [...this.jobs.values()]) {
      if (job.state === 'done') {
        this.jobs.delete(job.key);
        this.emit('removed', job.key);
      }
    }
  }

  _changed(job) {
    this.emit('update', this.snapshot(job));
    this._persistQueue();
  }

  _pump() {
    const all = [...this.jobs.values()];
    const active = all.filter((j) => j.state === 'active');
    const now = Date.now();
    const queued = all.filter((j) => j.state === 'queued' && !(j.retryAt > now)).sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    let activeCount = active.length;
    let urgentActive = active.filter((j) => j.priority >= URGENT).length;
    for (const job of queued) {
      const urgent = job.priority >= URGENT;
      // Clips the user is waiting on (sent to the timeline / dragged) never wait for background downloads.
      if (urgent ? urgentActive < 4 : activeCount < this.maxActive) {
        activeCount++;
        if (urgent) urgentActive++;
        this._run(job);
      }
    }
  }

  async _run(job) {
    job.state = 'active';
    job.error = null;
    job.errorCode = null;
    job.pauseRequested = false;
    job.cancelRequested = false;
    job.controller = new AbortController();
    job.samples = [];
    this._changed(job);
    const signal = job.controller.signal;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      let plan = await this._loadPlan(job);
      if (job.total) await this._ensureSpace(job.total - (plan ? plan.done.size * plan.chunkSize : 0));
      const fh = await fsp.open(job.partFile, plan ? 'r+' : 'w');
      try {
        if (!plan) plan = await this._start(job, fh, signal);
        job.plan = plan;
        if (plan.ranged) await this._runChunks(job, fh, plan, signal);
        await fh.sync().catch(() => {});
      } finally {
        job.plan = null;
        await fh.close().catch(() => {});
      }
      if (job.md5) {
        job.state = 'verifying';
        this._changed(job);
        const actual = await md5File(job.partFile, signal);
        if (actual.toLowerCase() !== job.md5.toLowerCase()) {
          await fsp.unlink(job.planFile).catch(() => {});
          await fsp.unlink(job.partFile).catch(() => {});
          throw Object.assign(new Error('Checksum mismatch — the file will be downloaded again'), { code: 'CHECKSUM' });
        }
      }
      await fsp.mkdir(job.dir, { recursive: true });
      const dest = uniquePath(job.dir, job.fileName, this.reserved);
      this.reserved.add(dest);
      try {
        await moveFile(job.partFile, dest);
      } finally {
        this.reserved.delete(dest);
      }
      await fsp.unlink(job.planFile).catch(() => {});
      job.path = dest;
      job.state = 'done';
      job.speed = 0;
      job.received = job.total = job.total || job.received;
      this._changed(job);
      this.emit('done', { ...this.snapshot(job), meta: job.meta, fileName: path.basename(dest) });
      for (const w of job.waiters.splice(0)) w.resolve(dest);
    } catch (err) {
      job.speed = 0;
      if (job.cancelRequested) {
        await this._discard(job);
      } else if (isAbortError(err) || job.pauseRequested) {
        job.state = 'paused';
        this._changed(job);
      } else if (err.code === 'PROCESSING') {
        // Google Photos is still transcoding the video; try again shortly.
        job.state = 'queued';
        job.error = err.message;
        job.errorCode = err.code;
        job.retryAt = Date.now() + this.processingRetryMs;
        this._changed(job);
        const timer = setTimeout(() => this._pump(), this.processingRetryMs + 50);
        if (timer.unref) timer.unref();
      } else {
        job.state = 'error';
        job.error = err.message || String(err);
        job.errorCode = err.code || (err instanceof HttpError ? `HTTP_${err.status}` : null);
        if (!(err.code === 'PHOTOS_EXPIRED' || err.code === 'AUTH_REQUIRED')) this.logger.warn(`[download] ${job.name}: ${job.error}`);
        this._changed(job);
        for (const w of job.waiters.splice(0)) w.reject(err);
      }
    } finally {
      this._pump();
    }
  }

  async _ensureSpace(bytes) {
    if (!bytes || typeof fsp.statfs !== 'function') return;
    try {
      const st = await fsp.statfs(this.dir);
      const free = st.bavail * st.bsize;
      if (free < bytes + 200 * MiB) {
        throw Object.assign(new Error(`Not enough disk space (${Math.round(free / MiB)} MB free)`), { code: 'ENOSPC' });
      }
    } catch (err) {
      if (err.code === 'ENOSPC') throw err;
    }
  }

  async _open(job, range, signal, force) {
    const { url, headers } = await this.targetFor(job.key, { force });
    const res = await request(url, { headers: range ? { ...headers, Range: range } : headers, signal, timeout: 30000 });
    if (res.statusCode >= 400) {
      const body = await readBody(res, { limit: 64 * 1024 }).catch(() => Buffer.alloc(0));
      let data = null;
      try {
        data = JSON.parse(body.toString('utf8'));
      } catch {
        /* not JSON */
      }
      throw errorFromResponse(res, data, body.toString('utf8'));
    }
    return res;
  }

  /** Runs `attemptFn(force)` with token/URL refresh and exponential back-off. */
  async _withRetry(job, signal, attemptFn) {
    let force = false;
    for (let attempt = 0; ; attempt++) {
      try {
        return await attemptFn(force);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) throw abortError();
        if (attempt >= MAX_ATTEMPTS - 1) throw err;
        if (err instanceof HttpError) {
          if (err.status === 401) {
            this.onUnauthorized();
            continue;
          }
          if (err.status === 403 || err.status === 410) {
            if (attempt >= 2) throw err;
            force = true; // Google Photos base URL expired: ask for a fresh one
            continue;
          }
          if (err.status === 404 || err.status === 416) throw err;
        }
        if (!isTransientError(err) && !err.retryable) throw err;
        await sleep(backoff(attempt, this.retryBaseMs), signal);
      }
    }
  }

  async _start(job, fh, signal) {
    const chunkSize = this.chunkSize;
    let first;
    await this._withRetry(job, signal, async (force) => {
      first = await this._open(job, `bytes=0-${chunkSize - 1}`, signal, force);
    });
    const range = first.statusCode === 206 ? parseContentRange(first.headers['content-range']) : null;
    if (range && range.start === 0 && range.total != null) {
      job.total = range.total;
      job.ranged = true;
      await this._ensureSpace(range.total);
      await fh.truncate(range.total);
      const plan = { ranged: true, total: range.total, chunkSize, chunks: Math.max(1, Math.ceil(range.total / chunkSize)), done: new Set(), first };
      this._savePlan(job, plan);
      return plan;
    }
    // No usable Range support: one sequential stream, restarted from zero on failure.
    job.ranged = false;
    let res = first.statusCode === 200 ? first : null;
    if (!res) first.destroy();
    await this._withRetry(job, signal, async (force) => {
      if (!res) res = await this._open(job, null, signal, force);
      const current = res;
      res = null;
      job.total = Number(current.headers['content-length']) || job.expectedSize || null;
      if (job.total) await this._ensureSpace(job.total);
      job.received = 0;
      await fh.truncate(0);
      await this._pipe(job, fh, current, 0, job.total ? job.total - 1 : Infinity, signal, { written: 0 });
    });
    return { ranged: false };
  }

  async _runChunks(job, fh, plan, signal) {
    const { chunkSize, total, done } = plan;
    const pending = [];
    for (let i = 0; i < plan.chunks; i++) if (!done.has(i) && !(plan.first && i === 0)) pending.push(i);
    job.received = 0;
    for (const i of done) job.received += Math.min(chunkSize, total - i * chunkSize);
    this._changed(job);

    const failure = new AbortController();
    const onJobAbort = () => failure.abort();
    signal.addEventListener('abort', onJobAbort, { once: true });
    let next = 0;
    const take = () => (next < pending.length ? pending[next++] : -1);
    const fetchChunk = async (index, initial) => {
      const start = index * chunkSize;
      const end = Math.min(total, start + chunkSize) - 1;
      let res = initial || null;
      const progress = { written: 0 };
      await this._withRetry(job, failure.signal, async (force) => {
        job.received -= progress.written;
        progress.written = 0;
        if (!res) res = await this._open(job, `bytes=${start}-${end}`, failure.signal, force);
        const current = res;
        res = null;
        const cr = parseContentRange(current.headers['content-range']);
        if (current.statusCode !== 206 || !cr || cr.start !== start) {
          current.resume();
          throw Object.assign(new Error('Server ignored the requested range'), { retryable: true });
        }
        await this._pipe(job, fh, current, start, end, failure.signal, progress);
      });
      done.add(index);
      this._planDirty(job, plan);
    };
    const worker = async (initialIndex, initialRes) => {
      if (initialRes) await fetchChunk(initialIndex, initialRes);
      for (let idx = take(); idx !== -1; idx = take()) await fetchChunk(idx, null);
    };
    const workers = [];
    const first = plan.first;
    plan.first = null;
    if (first) workers.push(worker(0, first));
    const extra = Math.min(this.connections - workers.length, pending.length);
    for (let i = 0; i < extra; i++) workers.push(worker(-1, null));
    try {
      const results = await Promise.allSettled(workers.map((w) => w.catch((err) => {
        failure.abort();
        throw err;
      })));
      const failed = results.find((r) => r.status === 'rejected' && !isAbortError(r.reason));
      if (failed) throw failed.reason;
      if (signal.aborted || results.some((r) => r.status === 'rejected')) throw abortError();
    } finally {
      signal.removeEventListener('abort', onJobAbort);
      this._savePlan(job, plan);
    }
    if (done.size !== plan.chunks) throw Object.assign(new Error('Download incomplete'), { retryable: true });
  }

  /** Streams a response body to `fh` at `start`, coalescing writes into ~1 MiB blocks. */
  async _pipe(job, fh, res, start, end, signal, progress) {
    let pos = start;
    let bufs = [];
    let buffered = 0;
    const limit = end - start + 1;
    const flush = async () => {
      if (!buffered) return;
      const buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, buffered);
      bufs = [];
      buffered = 0;
      await fh.write(buf, 0, buf.length, pos);
      pos += buf.length;
    };
    try {
      for await (let chunk of res) {
        if (signal.aborted) throw abortError();
        const room = limit - (pos - start) - buffered;
        if (chunk.length > room) chunk = chunk.subarray(0, Math.max(0, room));
        if (!chunk.length) break;
        bufs.push(chunk);
        buffered += chunk.length;
        progress.written += chunk.length;
        job.received += chunk.length;
        this._tick(job);
        if (buffered >= MiB) await flush();
      }
      await flush();
    } finally {
      res.destroy();
    }
    if (signal.aborted) throw abortError();
    if (Number.isFinite(limit) && pos - start !== limit) {
      throw Object.assign(new Error('Connection closed early'), { retryable: true });
    }
  }

  _tick(job) {
    const now = Date.now();
    const s = job.samples;
    if (!s.length || now - s[s.length - 1].t >= 250) {
      s.push({ t: now, b: job.received });
      while (s.length > 2 && now - s[0].t > 4000) s.shift();
      if (s.length >= 2) {
        const dt = (s[s.length - 1].t - s[0].t) / 1000;
        if (dt > 0) job.speed = Math.max(0, (s[s.length - 1].b - s[0].b) / dt);
      }
      this.emit('update', this.snapshot(job));
    }
  }

  async _loadPlan(job) {
    try {
      const raw = JSON.parse(await fsp.readFile(job.planFile, 'utf8'));
      const st = await fsp.stat(job.partFile);
      if (raw.v !== 1 || !raw.total || st.size !== raw.total) throw new Error('stale');
      job.total = raw.total;
      job.ranged = true;
      return { ranged: true, total: raw.total, chunkSize: raw.chunkSize, chunks: Math.ceil(raw.total / raw.chunkSize), done: new Set(raw.done), first: null };
    } catch {
      return null;
    }
  }

  _savePlan(job, plan) {
    if (!plan || !plan.ranged) return;
    const data = JSON.stringify({ v: 1, key: job.key, total: plan.total, chunkSize: plan.chunkSize, done: [...plan.done] });
    try {
      fs.writeFileSync(job.planFile, data);
    } catch {
      /* resume data is best-effort */
    }
  }

  _planDirty(job, plan) {
    const now = Date.now();
    if (!job.planSavedAt || now - job.planSavedAt > 2000) {
      job.planSavedAt = now;
      this._savePlan(job, plan);
    }
  }

  // ── Queue persistence (so downloads continue after the plugin is reopened) ──

  _writeQueue() {
    const queue = [...this.jobs.values()]
      .filter((j) => j.state !== 'done')
      .map((j) => ({
        key: j.key,
        name: j.name,
        dir: j.dir,
        fileName: j.fileName,
        expectedSize: j.expectedSize,
        md5: j.md5,
        meta: j.meta,
        priority: Math.min(j.priority, URGENT - 1),
        paused: j.state === 'paused',
      }));
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'queue.json'), JSON.stringify(queue));
    } catch {
      /* best-effort */
    }
  }

  restore() {
    let queue = [];
    try {
      queue = JSON.parse(fs.readFileSync(path.join(this.dir, 'queue.json'), 'utf8'));
    } catch {
      return [];
    }
    for (const spec of queue) if (spec && spec.key && !this.jobs.has(spec.key)) this.enqueue(spec);
    return queue.map((s) => s.key);
  }

  /** Pauses everything (keeping resume data) — used on quit. */
  shutdown() {
    for (const job of this.jobs.values()) {
      if (job.state === 'active' || job.state === 'verifying') {
        if (job.plan) this._savePlan(job, job.plan);
        job.pauseRequested = true;
        job.controller.abort();
      }
    }
    this._writeQueue();
  }
}

module.exports = { DownloadManager, URGENT, md5File, moveFile };
