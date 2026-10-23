'use strict';

// Talks to DaVinci Resolve Studio through Blackmagic's WorkflowIntegration.node module (the
// supported way for a Workflow Integration plugin). Prefers the promise API of Resolve 20.1+
// so long imports never block the plugin's main process.

const fs = require('fs');
const { EventEmitter } = require('events');
const { SerialQueue } = require('../util');
const { importAndPlace } = require('./placement');
const { parseRate } = require('./timecode');

class WorkflowBridge extends EventEmitter {
  constructor({ modulePath, pluginId, logger = console }) {
    super();
    this.kind = 'workflow';
    this.modulePath = modulePath;
    this.pluginId = pluginId;
    this.logger = logger;
    this.module = null;
    this.resolve = null;
    this.queue = new SerialQueue();
    this.loadError = null;
  }

  /** Loads the native module; returns false when not running inside Resolve. */
  load() {
    if (this.module) return true;
    if (!fs.existsSync(this.modulePath)) return false;
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      this.module = require(this.modulePath);
      return true;
    } catch (err) {
      this.loadError = err.message;
      this.logger.warn(`[resolve] could not load WorkflowIntegration.node: ${err.message}`);
      return false;
    }
  }

  get available() {
    return !!this.module;
  }

  async _connect() {
    if (this.resolve) return this.resolve;
    if (!this.module && !this.load()) throw new Error('DaVinci Resolve integration module is not available');
    const m = this.module;
    const ok = typeof m.InitializePromise === 'function' ? await m.InitializePromise(this.pluginId) : await m.Initialize(this.pluginId);
    if (!ok) throw new Error('DaVinci Resolve refused the connection (plugin id mismatch?)');
    if (typeof m.SetAPITimeout === 'function') {
      try {
        await m.SetAPITimeout(60);
      } catch {
        /* optional */
      }
    }
    const resolve = typeof m.GetResolvePromise === 'function' ? await m.GetResolvePromise() : await m.GetResolve();
    if (!resolve) throw new Error('Could not get the Resolve object');
    try {
      m.RegisterCallback('ResolveQuit', () => this.emit('quit'));
    } catch {
      /* older Resolve builds */
    }
    this.resolve = resolve;
    return resolve;
  }

  status() {
    return this.queue.run(async () => {
      try {
        const resolve = await this._connect();
        const out = {
          connected: true,
          via: 'workflow',
          product: String((await resolve.GetProductName()) || 'DaVinci Resolve'),
          version: String((await resolve.GetVersionString()) || ''),
          project: null,
          timeline: null,
        };
        const pm = await resolve.GetProjectManager();
        const project = pm && (await pm.GetCurrentProject());
        if (project) {
          out.project = String(await project.GetName());
          const timeline = await project.GetCurrentTimeline();
          if (timeline) {
            out.timeline = {
              name: String(await timeline.GetName()),
              fps: parseRate(await timeline.GetSetting('timelineFrameRate')),
            };
          }
        }
        return out;
      } catch (err) {
        return { connected: false, via: 'workflow', error: err.message };
      }
    });
  }

  /** request: { action, clips, binName, switchToEdit } */
  place(request) {
    return this.queue.run(async () => importAndPlace(await this._connect(), request));
  }

  dispose() {
    if (this.module) {
      try {
        this.module.CleanUp();
      } catch {
        /* Resolve may already be gone */
      }
    }
    this.resolve = null;
  }
}

module.exports = { WorkflowBridge };
