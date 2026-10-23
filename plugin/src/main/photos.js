'use strict';

// Google Photos via the Picker API. Since 31 March 2025 Google only lets third-party apps read a
// user's library through the Picker: the user selects items in Google's own Photos UI (with the
// full Google search), and the app receives temporary access to exactly those items.
// This module keeps every picked item in a local library so the user can work with them like
// a bin, refreshes the 60-minute base URLs while the picking session is alive, and reports
// items whose session has expired.

const { EventEmitter } = require('events');
const { fetchJson, HttpError, isTransientError } = require('./http');
const { fromPicked } = require('./items');
const { parseGoogleDuration, clamp, isAbortError, abortError } = require('./util');

const BASE_URL_TTL_MS = 50 * 60 * 1000; // Google: base URLs are valid for 60 minutes.
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

class ExpiredError extends Error {
  constructor(message = 'Google Photos access to this item has expired — pick it again') {
    super(message);
    this.name = 'ExpiredError';
    this.code = 'PHOTOS_EXPIRED';
  }
}

class PickerApi {
  constructor({ auth, base }) {
    this.auth = auth;
    this.base = base;
  }

  _call(method, path, json, signal) {
    return this.auth.withAuth((headers) => fetchJson(`${this.base}${path}`, { method, headers, json, signal, timeout: 30000 }));
  }

  createSession(maxItemCount) {
    const body = maxItemCount ? { pickingConfig: { maxItemCount: String(maxItemCount) } } : {};
    return this._call('POST', '/sessions', body);
  }

  getSession(id, signal) {
    return this._call('GET', `/sessions/${encodeURIComponent(id)}`, undefined, signal);
  }

  deleteSession(id) {
    return this._call('DELETE', `/sessions/${encodeURIComponent(id)}`);
  }

  async listAllItems(sessionId, signal) {
    const out = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ sessionId, pageSize: '100' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await this._call('GET', `/mediaItems?${q.toString()}`, undefined, signal);
      if (Array.isArray(page.mediaItems)) out.push(...page.mediaItems);
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    return out;
  }
}

class PhotosLibrary extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./oauth').GoogleAuth} opts.auth
   * @param {string} opts.base             Picker API base URL
   * @param {import('./stores').JsonStore} opts.store   { items: {id: item}, sessions: {id: session} }
   * @param {(url: string) => Promise<void>} opts.openExternal
   */
  constructor({ auth, base, store, openExternal, logger = console }) {
    super();
    this.api = new PickerApi({ auth, base });
    this.store = store;
    this.openExternal = openExternal;
    this.logger = logger;
    if (!store.data.items) store.data.items = {};
    if (!store.data.sessions) store.data.sessions = {};
    this.picking = null;
    this.lastPick = null;
    this.refreshing = new Map();
    this.processingTimer = null;
    this._pruneSessions();
    this._scheduleProcessingCheck();
  }

  get items() {
    return this.store.data.items;
  }

  get sessions() {
    return this.store.data.sessions;
  }

  list() {
    return Object.values(this.items);
  }

  get(id) {
    return this.items[id] || null;
  }

  /** True when the item can still be streamed or downloaded from Google. */
  isReachable(item) {
    if (!item) return false;
    if (item._baseUrl && Date.now() - item._baseUrlAt < BASE_URL_TTL_MS) return true;
    const s = this.sessions[item._sessionId];
    return !!s && !s.deleted && Date.parse(s.expireTime) > Date.now();
  }

  expiresAt(item) {
    const s = item && this.sessions[item._sessionId];
    return s && !s.deleted ? s.expireTime : null;
  }

  pickerState() {
    const p = this.picking;
    if (p) return { state: p.state, pickerUri: p.pickerUri, startedAt: p.startedAt, error: null };
    return this.lastPick || { state: 'idle' };
  }

  _emitPicker() {
    this.emit('picker', this.pickerState());
  }

  async startPicking({ maxItemCount = 2000 } = {}) {
    if (this.picking) {
      if (this.picking.openUri) await this.openExternal(this.picking.openUri);
      return this.pickerState();
    }
    const p = {
      state: 'creating',
      sessionId: null,
      pickerUri: null,
      openUri: null,
      startedAt: Date.now(),
      controller: new AbortController(),
      wake: null,
    };
    this.picking = p;
    this.lastPick = null;
    this._emitPicker();
    let session;
    try {
      session = await this._createSessionWithCleanup(maxItemCount);
    } catch (err) {
      this.picking = null;
      this.lastPick = { state: 'error', error: err.message, code: err.code || null };
      this._emitPicker();
      throw err;
    }
    if (p.controller.signal.aborted) {
      this.api.deleteSession(session.id).catch(() => {});
      return this.pickerState();
    }
    p.sessionId = session.id;
    p.pickerUri = session.pickerUri;
    // "/autoclose" makes Google close the tab when the user presses Done.
    p.openUri = `${String(session.pickerUri).replace(/\/+$/, '')}/autoclose`;
    p.pollMs = clamp(parseGoogleDuration(session.pollingConfig && session.pollingConfig.pollInterval, 3000), 1000, 10000);
    p.deadline = Date.now() + clamp(parseGoogleDuration(session.pollingConfig && session.pollingConfig.timeoutIn, 30 * 60 * 1000), 60 * 1000, 2 * 60 * 60 * 1000);
    this.sessions[session.id] = {
      id: session.id,
      createdAt: new Date().toISOString(),
      expireTime: session.expireTime || new Date(Date.now() + DEFAULT_SESSION_TTL_MS).toISOString(),
      deleted: false,
    };
    this.store.saveSoon();
    p.state = 'waiting';
    this._emitPicker();
    this._pollLoop(p).catch((err) => this.logger.error(`[photos] poll loop crashed: ${err.stack || err}`));
    await this.openExternal(p.openUri);
    return this.pickerState();
  }

  async _createSessionWithCleanup(maxItemCount) {
    try {
      return await this.api.createSession(maxItemCount);
    } catch (err) {
      // Too many live sessions: release the oldest ones and try once more.
      if (err instanceof HttpError && (err.status === 429 || err.reason === 'RESOURCE_EXHAUSTED')) {
        const live = Object.values(this.sessions).filter((s) => !s.deleted).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const s of live.slice(0, Math.max(1, Math.ceil(live.length / 2)))) await this._deleteSession(s.id);
        return this.api.createSession(maxItemCount);
      }
      throw err;
    }
  }

  reopenPicker() {
    if (this.picking && this.picking.openUri) return this.openExternal(this.picking.openUri);
    return Promise.resolve();
  }

  cancelPicking() {
    const p = this.picking;
    if (!p) return;
    p.controller.abort();
    this.picking = null;
    this.lastPick = { state: 'cancelled' };
    if (p.sessionId) this._deleteSession(p.sessionId);
    this._emitPicker();
  }

  /** Called when the app window regains focus: the user probably just pressed Done. */
  pollNow() {
    if (this.picking && this.picking.wake) this.picking.wake();
  }

  _wait(p, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      const signal = p.controller.signal;
      function finish() {
        clearTimeout(timer);
        p.wake = null;
        signal.removeEventListener('abort', finish);
        resolve();
      }
      p.wake = finish;
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  async _pollLoop(p) {
    let interval = p.pollMs;
    let failures = 0;
    const signal = p.controller.signal;
    while (!signal.aborted) {
      await this._wait(p, interval);
      if (signal.aborted) return;
      if (Date.now() > p.deadline) {
        this._finishPicking(p, { state: 'timeout' });
        this._deleteSession(p.sessionId);
        return;
      }
      let session;
      try {
        session = await this.api.getSession(p.sessionId, signal);
        failures = 0;
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return;
        if (isTransientError(err) && ++failures < 20) {
          interval = Math.min(15000, interval * 1.5);
          continue;
        }
        this._finishPicking(p, { state: 'error', error: err.message, code: err.code || null });
        return;
      }
      if (session.expireTime) this.sessions[p.sessionId].expireTime = session.expireTime;
      if (session.pollingConfig && session.pollingConfig.pollInterval) {
        interval = clamp(parseGoogleDuration(session.pollingConfig.pollInterval, interval), 1000, 10000);
      }
      if (!session.mediaItemsSet) continue;

      p.state = 'fetching';
      this._emitPicker();
      try {
        const picked = await this.api.listAllItems(p.sessionId, signal);
        const { added, updated } = this._merge(picked, p.sessionId);
        this._finishPicking(p, { state: 'done', added: added.length, updated: updated.length, total: picked.length });
        this.emit('picked', { added, updated, sessionId: p.sessionId });
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return;
        this._finishPicking(p, { state: 'error', error: err.message, code: err.code || null });
      }
      return;
    }
  }

  _finishPicking(p, result) {
    if (this.picking !== p) return;
    this.picking = null;
    this.lastPick = { ...result, finishedAt: Date.now() };
    this._emitPicker();
  }

  /** Merges Picker results into the library; returns the items that are new / refreshed. */
  _merge(picked, sessionId) {
    const now = Date.now();
    const added = [];
    const updated = [];
    const session = this.sessions[sessionId];
    if (session) session.itemIds = picked.map((m) => m.id);
    for (const m of picked) {
      if (!m || !m.id) continue;
      const fresh = fromPicked(m, sessionId, now);
      const existing = this.items[m.id];
      if (existing) {
        Object.assign(existing, {
          _baseUrl: fresh._baseUrl,
          _baseUrlAt: now,
          _sessionId: sessionId,
          processing: fresh.processing,
          width: fresh.width || existing.width,
          height: fresh.height || existing.height,
          fps: fresh.fps || existing.fps,
        });
        updated.push(existing);
      } else {
        fresh.addedAt = new Date(now).toISOString();
        this.items[m.id] = fresh;
        added.push(fresh);
      }
    }
    this.store.saveSoon();
    if (added.length || updated.length) this.emit('items', { upsert: [...added, ...updated] });
    this._scheduleProcessingCheck();
    return { added, updated };
  }

  /** Returns a base URL that is valid for at least ~10 more minutes, refreshing it if needed. */
  async freshBaseUrl(id, { force = false } = {}) {
    const item = this.items[id];
    if (!item) throw new Error('Unknown Google Photos item');
    if (!force && item._baseUrl && Date.now() - item._baseUrlAt < BASE_URL_TTL_MS) return item._baseUrl;
    await this.refreshSession(item._sessionId);
    const again = this.items[id];
    if (!again || !again._baseUrl || Date.now() - again._baseUrlAt >= BASE_URL_TTL_MS) throw new ExpiredError();
    return again._baseUrl;
  }

  /** Re-lists a session's items, which hands out fresh base URLs. Deduplicated per session. */
  refreshSession(sessionId) {
    const session = this.sessions[sessionId];
    if (!session || session.deleted || Date.parse(session.expireTime) <= Date.now()) {
      return Promise.reject(new ExpiredError());
    }
    if (this.refreshing.has(sessionId)) return this.refreshing.get(sessionId);
    const task = this.api
      .listAllItems(sessionId)
      .then((picked) => {
        this._merge(picked, sessionId);
      })
      .catch((err) => {
        if (err instanceof HttpError && [400, 403, 404].includes(err.status)) {
          session.deleted = true;
          this.store.saveSoon();
          this.emit('items', { upsert: this.list().filter((i) => i._sessionId === sessionId) });
          throw new ExpiredError();
        }
        throw err;
      })
      .finally(() => this.refreshing.delete(sessionId));
    this.refreshing.set(sessionId, task);
    return task;
  }

  setMeta(id, patch) {
    const item = this.items[id];
    if (!item) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (v != null && item[k] !== v) {
        item[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.store.saveSoon();
      this.emit('items', { upsert: [item] });
    }
  }

  remove(ids) {
    const removed = [];
    for (const id of ids) {
      if (this.items[id]) {
        delete this.items[id];
        removed.push(`photos:${id}`);
      }
    }
    // Release sessions that no longer back any item.
    const used = new Set(this.list().map((i) => i._sessionId));
    for (const s of Object.values(this.sessions)) {
      if (!s.deleted && !used.has(s.id) && (!this.picking || this.picking.sessionId !== s.id)) this._deleteSession(s.id);
    }
    this.store.saveSoon();
    if (removed.length) this.emit('items', { remove: removed });
    return removed;
  }

  _deleteSession(id) {
    const s = this.sessions[id];
    if (s) s.deleted = true;
    this.store.saveSoon();
    return this.api.deleteSession(id).catch((err) => {
      if (!(err instanceof HttpError && err.status === 404)) this.logger.warn(`[photos] could not delete session: ${err.message}`);
    });
  }

  _pruneSessions() {
    const now = Date.now();
    for (const [id, s] of Object.entries(this.sessions)) {
      // Keep expired sessions for a week so items can still explain why they are unavailable.
      if (Date.parse(s.expireTime) + 7 * 24 * 3600 * 1000 < now) delete this.sessions[id];
    }
  }

  /** Google may still be transcoding freshly uploaded videos; re-check them periodically. */
  _scheduleProcessingCheck() {
    if (this.processingTimer) return;
    const pending = this.list().filter((i) => i.processing === 'PROCESSING' && this.isReachable(i));
    if (!pending.length) return;
    this.processingTimer = setTimeout(async () => {
      this.processingTimer = null;
      const sessions = new Set(this.list().filter((i) => i.processing === 'PROCESSING').map((i) => i._sessionId));
      for (const sid of sessions) {
        try {
          await this.refreshSession(sid);
        } catch {
          /* reported through item state */
        }
      }
      this._scheduleProcessingCheck();
    }, 30000);
    if (this.processingTimer.unref) this.processingTimer.unref();
  }

  dispose() {
    if (this.picking) this.picking.controller.abort(abortError());
    clearTimeout(this.processingTimer);
  }
}

module.exports = { PhotosLibrary, PickerApi, ExpiredError, BASE_URL_TTL_MS };
