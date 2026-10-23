'use strict';

// Composition root: wires Google sign-in, both media sources, the thumbnail cache, the local
// media server, the download manager, the Resolve bridge and the job queue together, and exposes
// a plain-JSON API for the IPC layer. Nothing here depends on Electron, so it can be tested and
// reused by the standalone app.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

const { DEFAULT_SETTINGS, PLUGIN_ID, resolveEndpoints } = require('./config');
const { JsonStore, SecureStore } = require('./stores');
const { GoogleAuth } = require('./oauth');
const { PhotosLibrary } = require('./photos');
const { DriveApi } = require('./drive');
const { MediaSources } = require('./media-source');
const { ThumbCache } = require('./thumbs');
const { MediaServer } = require('./media-server');
const { DownloadManager, URGENT } = require('./downloader');
const { ResolveJobs } = require('./jobs');
const { WorkflowBridge } = require('./resolve/workflow-bridge');
const { MailboxBridge } = require('./resolve/mailbox-bridge');
const { probeMp4, cachedReader } = require('./mp4');
const { FfmpegTools } = require('./ffmpeg');
const { publicItem, splitKey } = require('./items');
const { readBody, parseContentRange } = require('./http');
const { sanitizeFilename, throttle, isAbortError, uniquePath } = require('./util');

function localDay(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return 'Unknown date';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class CloudPoolCore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.userData        app data folder
   * @param {string} opts.defaultDownloadDir
   * @param {string} opts.pluginDir       folder containing manifest.xml (and WorkflowIntegration.node in plugin mode)
   * @param {object} [opts.cipher]        { available, encrypt, decrypt } (Electron safeStorage)
   * @param {(url: string) => Promise<void>} opts.openExternal
   * @param {() => string} [opts.getLanguage]
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.logger = opts.logger || console;
    this.endpoints = resolveEndpoints();
    const ud = opts.userData;
    fs.mkdirSync(ud, { recursive: true });

    this.settingsStore = new JsonStore(path.join(ud, 'settings.json'), { ...DEFAULT_SETTINGS, downloadDir: opts.defaultDownloadDir });
    if (!this.settingsStore.data.downloadDir) this.settingsStore.data.downloadDir = opts.defaultDownloadDir;
    this.localStore = new JsonStore(path.join(ud, 'downloads.json'), { items: {} });
    this.libraryStore = new JsonStore(path.join(ud, 'library.json'), { items: {}, sessions: {} });

    this.auth = new GoogleAuth({
      store: new SecureStore(path.join(ud, 'account.bin'), opts.cipher),
      endpoints: this.endpoints,
      openExternal: opts.openExternal,
      getLanguage: opts.getLanguage,
      logger: this.logger,
    });
    this.photos = new PhotosLibrary({ auth: this.auth, base: this.endpoints.picker, store: this.libraryStore, openExternal: opts.openExternal, logger: this.logger });
    this.drive = new DriveApi({ auth: this.auth, base: this.endpoints.drive });
    this.sources = new MediaSources({ auth: this.auth, photos: this.photos, drive: this.drive });
    this.thumbs = new ThumbCache({
      dir: path.join(ud, 'Cache', 'thumbs'),
      maxBytes: this.settings.thumbCacheMB * 1024 * 1024,
      fetcher: (item, size, signal) => this.sources.fetchThumbnail(item, size, signal),
      logger: this.logger,
    });
    this.server = new MediaServer({
      resolveItem: (key) => this.sources.resolve(key),
      localFile: (key) => this.localPath(key),
      thumbs: this.thumbs,
      openStream: (item, o) => this.sources.openStream(item, o),
      logger: this.logger,
    });
    this.downloads = new DownloadManager({
      dir: path.join(this.settings.downloadDir, '.incoming'),
      maxActive: this.settings.maxParallelDownloads,
      connections: this.settings.connectionsPerDownload,
      targetFor: async (key, { force }) => this.sources.downloadTarget(await this.sources.resolve(key), { force }),
      onUnauthorized: () => this.auth.invalidateAccessToken(),
      logger: this.logger,
    });

    this.workflow = new WorkflowBridge({ modulePath: path.join(opts.pluginDir, 'WorkflowIntegration.node'), pluginId: PLUGIN_ID, logger: this.logger });
    this.isPlugin = this.workflow.load();
    this.mailbox = this.isPlugin ? null : new MailboxBridge({ dir: path.join(ud, 'resolve-bridge'), logger: this.logger });
    this.resolveStatus = { connected: false, via: this.isPlugin ? 'workflow' : 'mailbox' };
    this.ffmpeg = new FfmpegTools({ getConfiguredPath: () => this.settings.ffmpegPath, logger: this.logger });
    this.jobs = new ResolveJobs({
      getBridge: () => (this.isPlugin ? this.workflow : this.mailbox),
      ensureLocal: (key) => this.ensureLocal(key),
      ensureSegment: (key, opts) => this.ensureSegment(key, opts),
      describe: (key) => this._describe(key),
      options: () => this.settings,
      logger: this.logger,
    });

    this.probing = { queue: [], active: 0, failed: new Set(), pending: new Set() };
    this.probeInfo = new Map(); // key -> full probe result (incl. keyframe times), memory only
    this._wireEvents();
  }

  get settings() {
    return this.settingsStore.data;
  }

  async start() {
    this.mediaBase = await this.server.start();
    if (this.mailbox) this.mailbox.start();
    this.downloads.restore();
    this._loadBundledClient();
    return this.mediaBase;
  }

  _loadBundledClient() {
    if (this.auth.client) return;
    for (const candidate of [path.join(this.opts.pluginDir, 'credentials.json'), process.env.CLOUDPOOL_CLIENT_FILE].filter(Boolean)) {
      try {
        this.auth.setClient(fs.readFileSync(candidate, 'utf8'));
        this.logger.info(`[auth] loaded OAuth client from ${candidate}`);
        return;
      } catch {
        /* not present */
      }
    }
  }

  _emit(type, payload) {
    this.emit('event', { type, payload });
  }

  _wireEvents() {
    this.auth.on('change', (s) => this._emit('auth', s));
    this.photos.on('picker', (s) => this._emit('picker', s));
    this.photos.on('items', ({ upsert, remove }) => {
      this._emit('photos', { upsert: (upsert || []).map((i) => this.publicItem(i)), remove: remove || [] });
    });
    this.photos.on('picked', ({ added, updated }) => {
      this._prefetchThumbs([...added, ...updated]);
      this._autoDownload([...added, ...updated]);
    });
    // Videos that Google was still processing become downloadable once they are READY.
    this.photos.on('items', ({ upsert }) => {
      for (const item of upsert || []) {
        const job = this.downloads.jobs.get(item.key);
        if (job && job.errorCode === 'PROCESSING' && item.processing !== 'PROCESSING') {
          job.retryAt = 0;
          this.downloads.resume(item.key);
        }
      }
    });

    let pending = new Map();
    const flush = throttle(() => {
      const batch = [...pending.values()];
      pending = new Map();
      if (batch.length) this._emit('downloads', batch);
    }, 250);
    this.downloads.on('update', (s) => {
      pending.set(s.key, s);
      flush();
    });
    this.downloads.on('removed', (key) => this._emit('download-removed', key));
    this.downloads.on('done', (s) => this._onDownloaded(s));
    this.jobs.on('update', (j) => this._emit('jobs', j));
    this.workflow.on('quit', () => this.emit('resolve-quit'));
  }

  // ── Items ────────────────────────────────────────────────────────────────

  localPath(key) {
    const entry = this.localStore.data.items[key];
    return entry && entry.path ? entry.path : null;
  }

  publicItem(item) {
    const extra = { local: this.localStore.data.items[item.key] ? true : false };
    if (item.source === 'photos') {
      extra.reachable = this.photos.isReachable(item);
      extra.expiresAt = this.photos.expiresAt(item);
    } else {
      extra.reachable = true;
    }
    return publicItem(item, extra);
  }

  _describe(key) {
    const item = this.sources.peek(key) || this.localStore.data.items[key] || {};
    const source = splitKey(key) ? splitKey(key).source : null;
    const parts = [source === 'drive' ? 'Google Drive' : 'Google Photos'];
    if (item.createdAt) parts.push(String(item.createdAt).replace('T', ' ').slice(0, 16));
    if (item.camera) parts.push(item.camera);
    return { name: item.name || key, kind: item.kind, fps: item.fps, source, comment: parts.join(' · ') };
  }

  listPhotos() {
    return this.photos.list().map((i) => this.publicItem(i));
  }

  async listDrive(params) {
    const { items, nextPageToken } = await this.drive.list(params || {});
    return { items: items.map((i) => this.publicItem(i)), nextPageToken };
  }

  listLocal() {
    return Object.values(this.localStore.data.items)
      .filter((e) => e.path && fs.existsSync(e.path))
      .map((e) => ({ ...e, local: true, reachable: true, hasThumb: true }));
  }

  // ── Downloads ────────────────────────────────────────────────────────────

  _targetDir(item) {
    const root = this.settings.downloadDir;
    const sourceDir = item.source === 'drive' ? 'Google Drive' : 'Google Photos';
    return this.settings.organizeByDate ? path.join(root, sourceDir, localDay(item.createdAt)) : path.join(root, sourceDir);
  }

  _enqueue(item, priority = 0, extra = {}) {
    const meta = { ...publicItem(item) };
    return this.downloads.enqueue({
      key: item.key,
      name: item.name,
      dir: this._targetDir(item),
      fileName: sanitizeFilename(this.sources.downloadName(item)),
      expectedSize: item.size || null,
      md5: item.md5 || null,
      priority,
      meta,
      resume: true,
      ...extra,
    });
  }

  /**
   * Google Photos links expire, so cache a grid-sized thumbnail for every picked item while
   * they are fresh (on-screen thumbnails are still served first: the queue is newest-first).
   */
  _prefetchThumbs(items) {
    for (const item of items.slice(0, 2000)) {
      this.thumbs.get(item, 384).catch(() => {});
    }
  }

  _autoDownload(items) {
    const s = this.settings;
    for (const item of items) {
      if (this.localPath(item.key)) continue;
      if (item.kind === 'video' && s.autoDownloadVideos) this._enqueue(item, 0);
      else if (item.kind === 'photo' && s.autoDownloadPhotos) this._enqueue(item, 1);
    }
  }

  async startDownloads(keys, { urgent = false } = {}) {
    for (const key of keys) {
      if (this.localPath(key) && fs.existsSync(this.localPath(key))) continue;
      try {
        const item = await this.sources.resolve(key);
        this._enqueue(item, urgent ? URGENT : 10);
      } catch (err) {
        this._emit('toast', { level: 'error', message: err.message, code: err.code || null });
      }
    }
  }

  /** Resolves with a local path, downloading the item first if needed. */
  async ensureLocal(key) {
    const existing = this.localPath(key);
    if (existing && fs.existsSync(existing)) return existing;
    if (existing) this._forgetLocal(key);
    const item = await this.sources.resolve(key);
    this._enqueue(item, URGENT);
    return this.downloads.whenDone(key);
  }

  /**
   * Long video with In/Out marks: cut only the marked part (plus a little handle) from the
   * cloud with ffmpeg. Returns { path, offset } — offset is where the file starts in the
   * original — or null when the whole file should be downloaded instead.
   */
  async ensureSegment(key, { inSec = null, outSec = null, durationHint = null, onProgress = null, signal = null } = {}) {
    if (!this.settings.segmentDownloads) return null;
    const existing = this.localPath(key);
    if (existing && fs.existsSync(existing)) return null;
    const item = await this.sources.resolve(key);
    if (item.kind !== 'video') return null;
    if (!item.durationMs && item.source === 'photos') await this._probeOne(key).catch(() => {});
    const duration = (item.durationMs || 0) / 1000 || Number(durationHint) || 0;
    if (!duration) return null;
    const a = Math.max(0, inSec || 0);
    const b = Math.min(duration, outSec != null ? outSec : duration);
    if (duration < 45 || b - a > duration * 0.6) return null; // not worth it: fetch the whole file
    // The same marks sent again (e.g. after an undo in Resolve) reuse the fragment already cut.
    const segments = this.localStore.data.segments || (this.localStore.data.segments = {});
    const cacheKey = `${key}|${a.toFixed(3)}|${b.toFixed(3)}`;
    if (segments[cacheKey] && fs.existsSync(segments[cacheKey].path)) return segments[cacheKey];
    const dl = this.downloads.get(key);
    if (dl && dl.total && dl.received / dl.total > 0.4) return null; // the full download is nearly there
    if (!(await this.ffmpeg.detect())) return null;
    const url = `${this.mediaBase}/stream/${encodeURIComponent(key)}`;
    // Keyframe positions come from the file's index (one small Range read); ffprobe is the fallback.
    if (!this.probeInfo.has(key)) await this._probeOne(key).catch(() => {});
    const keyframes = this.probeInfo.has(key) && this.probeInfo.get(key).video ? this.probeInfo.get(key).video.keyframes : null;
    const target = Math.max(0, a - 0.5);
    const start = keyframes && keyframes.length
      ? keyframes.reduce((best, t) => (t <= target + 1e-6 && t > best ? t : best), 0)
      : await this.ffmpeg.keyframeBefore(url, target, { signal });
    const length = Math.min(duration, b + 1) - start;
    const p2 = (n) => String(Math.floor(n)).padStart(2, '0');
    const stamp = (t) => `${t >= 3600 ? `${Math.floor(t / 3600)}-` : ''}${p2((t % 3600) / 60)}-${p2(t % 60)}`;
    const base = this.sources.downloadName(item).replace(/\.[^.]+$/, '');
    const dir = this._targetDir(item);
    fs.mkdirSync(dir, { recursive: true });
    // Google Photos streams are MP4 transcodes; MOV originals stay MOV (e.g. PCM audio has no MP4 tag).
    const ext = item.source === 'drive' && /\.mov$/i.test(item.name) ? '.mov' : '.mp4';
    const dest = uniquePath(dir, sanitizeFilename(`${base} [${stamp(a)}_${stamp(b)}]${ext}`));
    await this.ffmpeg.extract({ url, start, duration: length, dest, onProgress, signal });
    this.logger.info(`[segment] ${item.name}: ${a.toFixed(2)}–${b.toFixed(2)} s → ${path.basename(dest)} (from ${start.toFixed(3)} s)`);
    for (const [k, v] of Object.entries(segments)) if (!fs.existsSync(v.path)) delete segments[k];
    segments[cacheKey] = { path: dest, offset: start };
    this.localStore.saveSoon();
    return segments[cacheKey];
  }

  _onDownloaded(s) {
    const meta = s.meta || {};
    const entry = {
      ...meta,
      key: s.key,
      path: s.path,
      size: s.total || meta.size || null,
      completedAt: new Date().toISOString(),
    };
    this.localStore.data.items[s.key] = entry;
    this.localStore.saveSoon();
    this._emit('local', { upsert: [entry] });
    const parts = splitKey(s.key);
    if (parts && parts.source === 'photos') {
      const item = this.photos.get(parts.id);
      if (item) this._emit('photos', { upsert: [this.publicItem(item)] });
    }
    if (meta.kind === 'video' && !meta.durationMs) this._probeLocal(s.key, s.path);
  }

  _forgetLocal(key) {
    delete this.localStore.data.items[key];
    this.localStore.saveSoon();
    this._emit('local', { remove: [key] });
  }

  async deleteLocal(keys) {
    for (const key of keys) {
      const p = this.localPath(key);
      if (p) await fsp.unlink(p).catch(() => {});
      this._forgetLocal(key);
      await this.downloads.cancel(key);
      const parts = splitKey(key);
      if (parts && parts.source === 'photos' && this.photos.get(parts.id)) {
        this._emit('photos', { upsert: [this.publicItem(this.photos.get(parts.id))] });
      }
    }
  }

  // ── Probing video metadata (Google Photos does not report durations) ────────

  probe(keys) {
    for (const key of keys) {
      if (this.probing.failed.has(key) || this.probing.pending.has(key)) continue;
      const parts = splitKey(key);
      if (!parts || parts.source !== 'photos') continue;
      const item = this.photos.get(parts.id);
      if (!item || item.kind !== 'video' || item.durationMs) continue;
      this.probing.pending.add(key);
      this.probing.queue.push(key);
    }
    this._pumpProbe();
  }

  _pumpProbe() {
    while (this.probing.active < 2 && this.probing.queue.length) {
      const key = this.probing.queue.pop(); // newest first: what the user is looking at
      this.probing.active++;
      this._probeOne(key)
        .catch((err) => {
          if (!isAbortError(err)) this.probing.failed.add(key);
        })
        .finally(() => {
          this.probing.active--;
          this.probing.pending.delete(key);
          this._pumpProbe();
        });
    }
  }

  async _probeOne(key) {
    const local = this.localPath(key);
    if (local && fs.existsSync(local)) return this._probeLocal(key, local);
    const item = this.sources.peek(key) || (await this.sources.resolve(key));
    if (!item || (item.source === 'photos' && !this.photos.isReachable(item))) throw new Error('unreachable');
    let size = null;
    const read = async (offset, length) => {
      const end = size ? Math.min(size, offset + length) - 1 : offset + length - 1;
      const res = await this.sources.openStream(item, { range: `bytes=${offset}-${end}`, timeout: 20000 });
      if (res.statusCode !== 206) {
        res.destroy();
        throw new Error('Range not supported');
      }
      const cr = parseContentRange(res.headers['content-range']);
      if (cr && cr.total) size = cr.total;
      return readBody(res, { limit: 80 * 1024 * 1024 });
    };
    const reader = cachedReader(read);
    await reader(0, 16);
    if (!size) throw new Error('Unknown size');
    this._applyProbe(key, await probeMp4(reader, size));
  }

  async _probeLocal(key, file) {
    try {
      const fh = await fsp.open(file, 'r');
      try {
        const { size } = await fh.stat();
        const info = await probeMp4(async (offset, length) => {
          const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
          await fh.read(buf, 0, buf.length, offset);
          return buf;
        }, size);
        this._applyProbe(key, info);
      } finally {
        await fh.close();
      }
    } catch {
      /* not an MP4/MOV — nothing to add */
    }
  }

  _applyProbe(key, info) {
    this.probeInfo.set(key, info);
    if (this.probeInfo.size > 200) this.probeInfo.delete(this.probeInfo.keys().next().value);
    const patch = {};
    if (info.durationSec) patch.durationMs = Math.round(info.durationSec * 1000);
    if (info.video && info.video.fps) patch.fps = info.video.fps;
    if (info.video && info.video.codec) patch.codec = info.video.codec;
    const parts = splitKey(key);
    if (parts.source === 'photos' && Object.keys(patch).length) this.photos.setMeta(parts.id, patch);
    const local = this.localStore.data.items[key];
    if (local) {
      Object.assign(local, patch);
      this.localStore.saveSoon();
    }
    this._emit('meta', { key, ...patch });
  }

  // ── Resolve ─────────────────────────────────────────────────────────────

  async refreshResolveStatus() {
    const bridge = this.isPlugin ? this.workflow : this.mailbox;
    const status = await bridge.status();
    const changed = JSON.stringify(status) !== JSON.stringify(this.resolveStatus);
    this.resolveStatus = status;
    if (changed) this._emit('resolve', status);
    return status;
  }

  sendToResolve({ keys, action, marks }) {
    return this.jobs.add({ keys, action, marks });
  }

  // ── Settings & cache ───────────────────────────────────────────────────────

  updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    const s = this.settings;
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) s[k] = v;
    this.settingsStore.saveSoon();
    this.downloads.setLimits({ maxActive: s.maxParallelDownloads, connections: s.connectionsPerDownload });
    this.thumbs.maxBytes = s.thumbCacheMB * 1024 * 1024;
    if (patch && patch.downloadDir) this.downloads.dir = path.join(s.downloadDir, '.incoming');
    if (patch && 'ffmpegPath' in patch) this.ffmpeg.found = undefined; // look again on next use
    this._emit('settings', s);
    return s;
  }

  cacheStats() {
    return { thumbs: this.thumbs.stats() };
  }

  async clearCache() {
    await this.thumbs.clear();
    return this.cacheStats();
  }

  snapshot() {
    return {
      mode: this.isPlugin ? 'plugin' : 'standalone',
      mediaBase: this.mediaBase,
      settings: this.settings,
      auth: this.auth.snapshot(),
      picker: this.photos.pickerState(),
      resolve: this.resolveStatus,
      downloads: this.downloads.list(),
      jobs: this.jobs.list(),
    };
  }

  shutdown() {
    this.downloads.shutdown();
    this.photos.dispose();
    this.server.stop();
    if (this.mailbox) this.mailbox.dispose();
    this.workflow.dispose();
    for (const s of [this.settingsStore, this.localStore, this.libraryStore]) s.flush();
  }
}

module.exports = { CloudPoolCore, localDay };
