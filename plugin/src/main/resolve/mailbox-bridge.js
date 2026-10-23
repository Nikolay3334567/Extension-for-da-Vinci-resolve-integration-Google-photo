'use strict';

// Bridge for the free edition of DaVinci Resolve (and for running Cloud Pool as a standalone
// app). Blackmagic reserves external scripting and Workflow Integration plugins for Studio, but
// scripts started from Workspace ▸ Scripts run in every edition. The bundled Lua script
// "Cloud Pool" starts this app and then serves a tiny JSON mailbox in a shared folder:
//   request.json  (app → Resolve)   { seq, action, payload }
//   response.json (Resolve → app)   { seq, ok, result | error }
//   status.json   (Resolve → app)   heartbeat + current project/timeline
//   app.json      (app → Resolve)   heartbeat, so the script stops when the app closes

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { SerialQueue, sleep } = require('../util');

const STATUS_FRESH_MS = 6000;

class MailboxBridge extends EventEmitter {
  constructor({ dir, logger = console }) {
    super();
    this.kind = 'mailbox';
    this.dir = dir;
    this.logger = logger;
    this.queue = new SerialQueue();
    this.seq = Date.now();
    this.heartbeat = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  get available() {
    return true;
  }

  start() {
    const beat = () => {
      const file = path.join(this.dir, 'app.json');
      fs.promises
        .writeFile(`${file}.tmp`, JSON.stringify({ heartbeat: Math.floor(Date.now() / 1000), pid: process.pid }))
        .then(() => fsp.rename(`${file}.tmp`, file))
        .catch(() => {});
    };
    beat();
    this.heartbeat = setInterval(beat, 5000);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  async _readJson(name) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir, name), 'utf8'));
    } catch {
      return null;
    }
  }

  async status() {
    const s = await this._readJson('status.json');
    const fresh = s && s.heartbeat && Date.now() / 1000 - s.heartbeat < STATUS_FRESH_MS / 1000;
    if (!fresh) return { connected: false, via: 'mailbox' };
    return {
      connected: true,
      via: 'mailbox',
      product: s.product || 'DaVinci Resolve',
      version: s.version || '',
      project: s.project || null,
      timeline: s.timeline ? { name: s.timeline, fps: Number(s.fps) || null } : null,
    };
  }

  _call(action, payload, timeoutMs) {
    return this.queue.run(async () => {
      const st = await this.status();
      if (!st.connected) {
        const err = new Error('Start "Cloud Pool" from Workspace ▸ Scripts in DaVinci Resolve to connect');
        err.code = 'BRIDGE_OFFLINE';
        throw err;
      }
      const seq = ++this.seq;
      const file = path.join(this.dir, 'request.json');
      await fsp.writeFile(`${file}.tmp`, JSON.stringify({ seq, action, payload }));
      await fsp.rename(`${file}.tmp`, file);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(120);
        const res = await this._readJson('response.json');
        if (res && res.seq === seq) {
          if (res.ok) return res.result;
          const err = new Error(res.error || 'Resolve reported an error');
          err.code = res.code || 'BRIDGE_ERROR';
          throw err;
        }
      }
      const err = new Error('DaVinci Resolve did not answer in time');
      err.code = 'BRIDGE_TIMEOUT';
      throw err;
    });
  }

  /** request: { action, clips, binName, switchToEdit } — same contract as WorkflowBridge.place */
  place(request) {
    return this._call('place', request, 5 * 60 * 1000);
  }

  dispose() {
    clearInterval(this.heartbeat);
  }
}

module.exports = { MailboxBridge };
