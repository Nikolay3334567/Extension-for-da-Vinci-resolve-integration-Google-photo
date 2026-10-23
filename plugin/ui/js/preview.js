// Viewer: streams the clip straight from Google (or plays the local copy), with a source-viewer
// style transport — J/K/L shuttle, frame stepping, In/Out marks that travel with the clip to
// the timeline.

import { el, clear, formatTimecode, formatDuration, formatDateTime, formatBytes } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { state, getItem, isLocal, streamUrl, thumbUrl } from './state.js';

export class Preview {
  /** hooks: { onClose(), onAction(action, keys), onMarksChange(key), onPickAgain() } */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.key = null;
    this.video = null;
    this.reverseTimer = null;
    this.reverseRate = 0;
    this.scrubbing = false;
  }

  get isOpen() {
    return !!this.key;
  }

  get item() {
    return this.key ? getItem(this.key) : null;
  }

  fps() {
    const item = this.item;
    return (item && item.fps) || 30;
  }

  open(key) {
    if (this.key === key) return;
    this._teardown();
    this.key = key;
    state.previewKey = key;
    this.root.classList.add('open');
    this.render();
  }

  close() {
    this._teardown();
    this.key = null;
    state.previewKey = null;
    this.root.classList.remove('open');
    clear(this.root);
    this.hooks.onClose();
  }

  _teardown() {
    this._stopReverse();
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.video = null;
  }

  /** Re-renders info/actions (e.g. after the download finished) without restarting playback. */
  refresh() {
    if (!this.key) return;
    const info = this.root.querySelector('.pv-info');
    if (info) info.replaceWith(this._info());
    const actions = this.root.querySelector('.pv-actions');
    if (actions) actions.replaceWith(this._actions());
    this._updateMarks();
  }

  render() {
    const item = this.item;
    clear(this.root);
    if (!item) return;
    const header = el(
      'div.pv-header',
      el('div.pv-title', { title: item.name }, item.name),
      el('button.icon-btn', { title: t('act.close'), html: icon('x'), on: { click: () => this.close() } }),
    );
    const stage = el('div.pv-stage');
    if (item.kind === 'video') {
      const video = el('video.pv-video', { preload: 'auto', playsInline: true });
      video.poster = thumbUrl(item.key, 1024);
      video.src = streamUrl(item.key);
      video.addEventListener('timeupdate', () => this._updateTime());
      video.addEventListener('progress', () => this._updateBuffered());
      video.addEventListener('play', () => this._updatePlayButton());
      video.addEventListener('pause', () => this._updatePlayButton());
      video.addEventListener('ratechange', () => this._updatePlayButton());
      video.addEventListener('loadedmetadata', () => {
        if (!item.durationMs && Number.isFinite(video.duration)) item.durationMs = Math.round(video.duration * 1000);
        this._updateTime();
        this._updateMarks();
      });
      video.addEventListener('error', () => {
        stage.classList.add('failed');
        stage.append(el('div.pv-error', t('pv.noPreview')));
      });
      video.addEventListener('click', () => this.togglePlay());
      this.video = video;
      stage.append(video);
      video.play().catch(() => {});
    } else {
      stage.append(el('img.pv-image', { src: thumbUrl(item.key, 2048), alt: item.name }));
    }
    this.root.append(header, stage);
    if (item.kind === 'video') this.root.append(this._transport());
    this.root.append(this._actions(), this._info());
  }

  _transport() {
    const scrub = el('div.scrub', el('div.scrub-buffer'), el('div.scrub-range'), el('div.scrub-in'), el('div.scrub-out'), el('div.scrub-head'));
    const seekTo = (e) => {
      const rect = scrub.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      if (this.video && Number.isFinite(this.video.duration)) this.video.currentTime = frac * this.video.duration;
    };
    scrub.addEventListener('pointerdown', (e) => {
      scrub.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      seekTo(e);
    });
    scrub.addEventListener('pointermove', (e) => this.scrubbing && seekTo(e));
    scrub.addEventListener('pointerup', () => {
      this.scrubbing = false;
    });
    const btn = (name, title, fn, cls = '') => el(`button.icon-btn${cls}`, { title, html: icon(name), on: { click: fn } });
    return el(
      'div.pv-transport',
      scrub,
      el(
        'div.pv-controls',
        btn('stepBack', '←', () => this.step(-1)),
        el('button.icon-btn.pv-play', { title: 'Space', html: icon('play'), on: { click: () => this.togglePlay() } }),
        btn('stepFwd', '→', () => this.step(1)),
        el('span.pv-time', '00:00:00:00'),
        el('span.pv-rate'),
        el('span.flex'),
        btn('markIn', t('pv.in'), () => this.markIn()),
        btn('markOut', t('pv.out'), () => this.markOut()),
        btn('x', t('pv.clear'), () => this.clearMarks(), '.pv-clear'),
        el('button.icon-btn.pv-mute', { title: 'M', html: icon('volume'), on: { click: () => this.toggleMute() } }),
      ),
      el('div.pv-marks'),
    );
  }

  _actions() {
    const key = this.key;
    const item = this.item;
    const expired = item && item.source === 'photos' && item.reachable === false && !isLocal(key);
    if (expired) {
      return el(
        'div.pv-actions',
        el('div.pv-notice', t('tile.expired')),
        el('button.btn.primary', { on: { click: () => this.hooks.onPickAgain() } }, t('act.pickAgain')),
      );
    }
    const action = (name, label, ic, hint, primary = false) =>
      el(`button.btn${primary ? '.primary' : ''}`, { title: hint || label, on: { click: () => this.hooks.onAction(name, [key]) } }, el('span', { html: icon(ic) }), label);
    return el(
      'div.pv-actions',
      action('append', t('act.append'), 'timeline', t('act.appendHint'), true),
      action('playhead', t('act.playhead'), 'playhead', t('act.playheadHint')),
      action('import', t('act.import'), 'bin', t('act.importHint')),
      isLocal(key) ? action('reveal', t('act.reveal'), 'folder') : action('download', t('act.download'), 'download'),
    );
  }

  _info() {
    const item = this.item || {};
    const local = state.local.get(this.key);
    const dl = state.downloads.get(this.key);
    const rows = [
      [t('pv.date'), formatDateTime(item.createdAt)],
      [t('pv.resolution'), item.width && item.height ? `${item.width} × ${item.height}` : '—'],
    ];
    if (item.kind === 'video') {
      rows.push([t('pv.duration'), item.durationMs ? formatDuration(item.durationMs / 1000) : '—']);
      rows.push([t('pv.fps'), item.fps ? String(item.fps) : '—']);
    }
    if (item.camera) rows.push([t('pv.camera'), item.camera]);
    if (item.size || (local && local.size)) rows.push([t('pv.size'), formatBytes(item.size || local.size)]);
    rows.push([t('pv.source'), t(item.source === 'drive' ? 'src.drive' : 'src.photos')]);
    let status = t('pv.notLocal');
    if (local) status = local.path;
    else if (dl && dl.total) status = `${t('dl.active')} ${Math.round((dl.received / dl.total) * 100)}%`;
    rows.push([t('pv.local'), status]);
    const table = el('dl.pv-meta', rows.map(([k, v]) => [el('dt', k), el('dd', { title: v }, v)]));
    const extra = item.source === 'photos' && item.kind === 'video' ? el('p.pv-note', t('pv.transcoded')) : null;
    return el('div.pv-info', table, extra);
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  togglePlay() {
    const v = this.video;
    if (!v) return;
    this._stopReverse();
    if (v.paused) {
      v.playbackRate = 1;
      const m = state.marks[this.key];
      if (m && m.out != null && v.currentTime >= m.out - 0.05) v.currentTime = m.in || 0;
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  /** L: play forward, faster on repeat. */
  shuttleForward() {
    const v = this.video;
    if (!v) return;
    this._stopReverse();
    if (v.paused) {
      v.playbackRate = 1;
      v.play().catch(() => {});
    } else {
      v.playbackRate = Math.min(8, v.playbackRate * 2);
    }
  }

  /** J: play backwards (simulated by stepping), faster on repeat. */
  shuttleBackward() {
    const v = this.video;
    if (!v) return;
    v.pause();
    this.reverseRate = this.reverseRate ? Math.min(8, this.reverseRate * 2) : 1;
    clearInterval(this.reverseTimer);
    let last = performance.now();
    this.reverseTimer = setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      v.currentTime = Math.max(0, v.currentTime - dt * this.reverseRate);
      if (v.currentTime <= 0) this._stopReverse();
    }, 40);
    this._updatePlayButton();
  }

  stop() {
    this._stopReverse();
    if (this.video) this.video.pause();
  }

  _stopReverse() {
    clearInterval(this.reverseTimer);
    this.reverseTimer = null;
    this.reverseRate = 0;
    this._updatePlayButton();
  }

  step(frames) {
    const v = this.video;
    if (!v) return;
    this._stopReverse();
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + frames / this.fps()));
  }

  jump(seconds) {
    const v = this.video;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + seconds));
  }

  toggleMute() {
    if (!this.video) return;
    this.video.muted = !this.video.muted;
    const b = this.root.querySelector('.pv-mute');
    if (b) b.innerHTML = icon(this.video.muted ? 'mute' : 'volume');
  }

  markIn() {
    if (!this.video) return;
    const m = (state.marks[this.key] = state.marks[this.key] || {});
    m.in = this.video.currentTime;
    if (m.out != null && m.out <= m.in) delete m.out;
    this._marksChanged();
  }

  markOut() {
    if (!this.video) return;
    const m = (state.marks[this.key] = state.marks[this.key] || {});
    m.out = this.video.currentTime;
    if (m.in != null && m.in >= m.out) delete m.in;
    this._marksChanged();
  }

  clearMarks() {
    delete state.marks[this.key];
    this._marksChanged();
  }

  _marksChanged() {
    this._updateMarks();
    this.hooks.onMarksChange(this.key);
  }

  _updatePlayButton() {
    const b = this.root.querySelector('.pv-play');
    const v = this.video;
    if (!b || !v) return;
    const playing = !v.paused || !!this.reverseTimer;
    b.innerHTML = icon(playing ? 'pause' : 'play');
    const rate = this.root.querySelector('.pv-rate');
    if (rate) rate.textContent = this.reverseTimer ? `◀ ${this.reverseRate}×` : !v.paused && v.playbackRate !== 1 ? `${v.playbackRate}×` : '';
  }

  _updateTime() {
    const v = this.video;
    if (!v) return;
    const time = this.root.querySelector('.pv-time');
    if (time) time.innerHTML = `${formatTimecode(v.currentTime, this.fps())} <span class="dim">/ ${formatTimecode(v.duration || 0, this.fps())}</span>`;
    const head = this.root.querySelector('.scrub-head');
    if (head && v.duration) head.style.left = `${(v.currentTime / v.duration) * 100}%`;
    const m = state.marks[this.key];
    if (m && m.out != null && !v.paused && v.currentTime >= m.out) {
      v.pause();
      v.currentTime = m.out;
    }
  }

  _updateBuffered() {
    const v = this.video;
    const buf = this.root.querySelector('.scrub-buffer');
    if (!v || !buf || !v.duration || !v.buffered.length) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    buf.style.width = `${(end / v.duration) * 100}%`;
  }

  _updateMarks() {
    const v = this.video;
    const m = state.marks[this.key] || {};
    const d = v && v.duration;
    const set = (sel, prop, value) => {
      const node = this.root.querySelector(sel);
      if (node) node.style[prop] = value;
    };
    const has = m.in != null || m.out != null;
    if (d) {
      const a = ((m.in || 0) / d) * 100;
      const b = ((m.out != null ? m.out : d) / d) * 100;
      set('.scrub-range', 'left', `${a}%`);
      set('.scrub-range', 'width', `${Math.max(0, b - a)}%`);
      set('.scrub-in', 'left', `${a}%`);
      set('.scrub-out', 'left', `${b}%`);
    }
    this.root.classList.toggle('has-marks', has);
    const label = this.root.querySelector('.pv-marks');
    if (label) {
      label.textContent = has
        ? t('pv.marks', { in: formatTimecode(m.in || 0, this.fps()), out: formatTimecode(m.out != null ? m.out : d || 0, this.fps()) })
        : '';
    }
  }
}
