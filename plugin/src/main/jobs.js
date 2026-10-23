'use strict';

// "Send to Resolve" jobs. A job keeps the order the user chose: every clip starts downloading
// immediately (in parallel, with top priority), and clips are handed to Resolve strictly in
// order as soon as each one — and every clip before it — is on disk. The first clips land on
// the timeline while the rest are still downloading.

const { EventEmitter } = require('events');
const { randomToken } = require('./util');

class ResolveJobs extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => object|null} opts.getBridge          WorkflowBridge | MailboxBridge | null
   * @param {(key: string) => Promise<string>} opts.ensureLocal   resolves with the local path
   * @param {(key: string) => object} opts.describe     { name, kind, fps, comment, source }
   * @param {() => object} opts.options                 { binName, driveBinName, switchToEdit }
   */
  constructor({ getBridge, ensureLocal, describe, options, logger = console }) {
    super();
    this.getBridge = getBridge;
    this.ensureLocal = ensureLocal;
    this.describe = describe;
    this.options = options;
    this.logger = logger;
    this.jobs = [];
    this.running = false;
  }

  snapshot(job) {
    return {
      id: job.id,
      action: job.action,
      state: job.state,
      createdAt: job.createdAt,
      error: job.error,
      errorCode: job.errorCode,
      result: job.result,
      entries: job.entries.map((e) => ({ key: e.key, name: e.name, state: e.state, error: e.error })),
    };
  }

  list() {
    return this.jobs.map((j) => this.snapshot(j));
  }

  _emit(job) {
    this.emit('update', this.snapshot(job));
  }

  /**
   * @param {object} req  { keys: string[], action: 'import'|'append'|'playhead'|'newTimeline',
   *                        marks: { [key]: { in?: number, out?: number } } }
   */
  add({ keys, action = 'append', marks = {} }) {
    const job = {
      id: randomToken(6),
      action,
      state: 'queued',
      createdAt: Date.now(),
      error: null,
      errorCode: null,
      result: null,
      canceled: false,
      entries: keys.map((key) => {
        const info = this.describe(key) || {};
        const mark = marks[key] || {};
        return {
          key,
          name: info.name || key,
          info,
          inSec: Number.isFinite(mark.in) ? mark.in : null,
          outSec: Number.isFinite(mark.out) ? mark.out : null,
          state: 'downloading',
          error: null,
          path: null,
          promise: null,
        };
      }),
    };
    // Downloads start right away, even while an earlier job is still being placed.
    for (const entry of job.entries) {
      entry.promise = this.ensureLocal(entry.key).then(
        (p) => {
          entry.path = p;
          if (entry.state === 'downloading') entry.state = 'ready';
          this._emit(job);
          return p;
        },
        (err) => {
          entry.state = 'error';
          entry.error = err.message;
          entry.errorCode = err.code || null;
          this._emit(job);
          return null;
        },
      );
    }
    this.jobs.push(job);
    if (this.jobs.length > 50) this.jobs.splice(0, this.jobs.length - 50);
    this._emit(job);
    this._pump();
    return this.snapshot(job);
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.state === 'done' || job.state === 'error') return;
    job.canceled = true;
    if (job.state === 'queued') {
      job.state = 'canceled';
      this._emit(job);
    }
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.state === 'queued' || j.state === 'running');
    this.emit('cleared');
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.state === 'queued');
        if (!job) break;
        await this._process(job);
      }
    } finally {
      this.running = false;
    }
  }

  _clip(entry) {
    const info = entry.info || {};
    return {
      path: entry.path,
      name: entry.name,
      key: entry.key,
      kind: info.kind,
      fps: info.fps || null,
      comment: info.comment || null,
      inSec: entry.inSec,
      outSec: entry.outSec,
    };
  }

  async _process(job) {
    job.state = 'running';
    this._emit(job);
    const opts = this.options();
    const total = { imported: 0, reused: 0, placed: 0, timeline: null, createdTimeline: false, skipped: 0 };
    let firstBatch = true;
    let next = 0;
    try {
      while (next < job.entries.length) {
        if (job.canceled) throw Object.assign(new Error('Cancelled'), { code: 'CANCELED' });
        await job.entries[next].promise;
        // Take the run of consecutive entries that are ready now (keeps the order intact).
        const batch = [];
        while (next < job.entries.length) {
          const e = job.entries[next];
          if (e.state === 'error') {
            total.skipped++;
            next++;
            continue;
          }
          if (e.state !== 'ready') break;
          batch.push(e);
          next++;
        }
        if (!batch.length) continue;
        const bridge = this.getBridge();
        if (!bridge) {
          const err = new Error('Not connected to DaVinci Resolve — the files are downloaded, drag them into Resolve');
          err.code = 'NO_RESOLVE';
          throw err;
        }
        for (const e of batch) e.state = 'placing';
        this._emit(job);
        const source = batch[0].info && batch[0].info.source;
        const action = !firstBatch && job.action === 'newTimeline' ? 'append' : job.action;
        let result;
        try {
          result = await bridge.place({
            action,
            clips: batch.map((e) => this._clip(e)),
            binName: source === 'drive' ? opts.driveBinName || opts.binName : opts.binName,
            switchToEdit: !!opts.switchToEdit && firstBatch,
          });
        } catch (err) {
          for (const e of batch) {
            e.state = 'error';
            e.error = err.message;
          }
          throw err;
        }
        firstBatch = false;
        for (const e of batch) e.state = job.action === 'import' ? 'imported' : 'placed';
        total.imported += result.imported || 0;
        total.reused += result.reused || 0;
        total.placed += result.placed || 0;
        total.timeline = result.timeline || total.timeline;
        total.createdTimeline = total.createdTimeline || !!result.createdTimeline;
        job.result = { ...total };
        this._emit(job);
      }
      job.result = total;
      if (total.imported + total.reused === 0 && total.skipped) {
        const err = new Error(job.entries.find((e) => e.error)?.error || 'Nothing could be downloaded');
        err.code = job.entries.find((e) => e.errorCode)?.errorCode || 'DOWNLOAD';
        throw err;
      }
      job.state = 'done';
    } catch (err) {
      job.state = err.code === 'CANCELED' ? 'canceled' : 'error';
      job.error = err.message;
      job.errorCode = err.code || null;
      for (const e of job.entries) if (e.state === 'downloading' || e.state === 'ready') e.state = 'skipped';
      if (job.state === 'error' && err.code !== 'NO_RESOLVE' && err.code !== 'BRIDGE_OFFLINE') this.logger.warn(`[jobs] ${err.message}`);
    }
    this._emit(job);
  }
}

module.exports = { ResolveJobs };
