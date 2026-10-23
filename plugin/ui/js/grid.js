// Virtualised, date-grouped thumbnail grid. Only the rows near the viewport exist in the DOM,
// so libraries with thousands of items scroll smoothly; thumbnails for rows that scroll away are
// cancelled (the media server drops their queued Google requests).

import { el, rafThrottle, debounce, formatDuration, dayKey, monthKey, formatDayHeader, formatMonthHeader, resolutionLabel } from './util.js';
import { icon } from './icons.js';
import { state, thumbUrl, streamUrl, isLocal } from './state.js';
import { t } from './i18n.js';

const PAD = 16;
const GAP = 6;
const HEADER_H = 44;
const SEG_GAP = 22;
const RING = 2 * Math.PI * 9;

export class Grid {
  /**
   * hooks: { onOpen(key), onOpenFolder(item), onContext(key, x, y), onDragStart(keys),
   *          onSelectionChange(), onVisible(keys), onEndReached() }
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.canvas = el('div.grid-canvas');
    root.append(this.canvas);
    this.items = [];
    this.index = new Map();
    this.rows = [];
    this.rendered = new Map(); // row index -> element
    this.tiles = new Map(); // key -> tile element
    this.tileSize = 168;
    this.fit = 'cover';
    this.groupBy = 'day';
    this.cols = 1;
    this.tileW = 168;
    this.focusKey = null;
    this.hover = { key: null, timer: null, video: null, seeking: false, pendingSeek: null, playTimer: null };

    root.addEventListener('scroll', rafThrottle(() => this.render()), { passive: true });
    this.resizeObserver = new ResizeObserver(rafThrottle(() => this.relayout()));
    this.resizeObserver.observe(root);
    this._reportVisible = debounce(() => this.hooks.onVisible && this.hooks.onVisible([...this.tiles.keys()]), 250);

    this.canvas.addEventListener('click', (e) => this._onClick(e));
    this.canvas.addEventListener('dblclick', (e) => this._onDblClick(e));
    this.canvas.addEventListener('contextmenu', (e) => this._onContext(e));
    this.canvas.addEventListener('dragstart', (e) => this._onDragStart(e));
    this.canvas.addEventListener('mouseover', (e) => this._onHover(e));
    this.canvas.addEventListener('mousemove', (e) => this._onMove(e));
    this.canvas.addEventListener('mouseleave', () => this._endHover());
    root.addEventListener('click', (e) => {
      if (e.target === root || e.target === this.canvas) {
        if (state.selection.size) {
          state.selection.clear();
          this.refreshSelection();
          this.hooks.onSelectionChange();
        }
      }
    });
  }

  setItems(items, { groupBy = 'day', resetScroll = false } = {}) {
    this._endHover();
    this.items = items;
    this.index = new Map(items.map((it, i) => [it.key, i]));
    this.groupBy = groupBy;
    if (resetScroll) this.root.scrollTop = 0;
    this.relayout(true);
  }

  setTileSize(px) {
    const anchor = this._topVisibleKey();
    this.tileSize = px;
    this.relayout(true);
    if (anchor) this.scrollToKey(anchor, 'start');
  }

  setFit(fit) {
    this.fit = fit;
    this.root.classList.toggle('fit-contain', fit === 'contain');
  }

  _topVisibleKey() {
    const top = this.root.scrollTop;
    for (const row of this.rows) {
      if (row.type !== 'header' && row.y + row.h > top) return this.items[row.start] && this.items[row.start].key;
    }
    return null;
  }

  relayout(force = false) {
    const width = this.root.clientWidth;
    if (!width) return;
    const cols = Math.max(1, Math.floor((width - PAD * 2 + GAP) / (this.tileSize + GAP)));
    const tileW = (width - PAD * 2 - GAP * (cols - 1)) / cols;
    if (!force && cols === this.cols && Math.abs(tileW - this.tileW) < 0.5) return;
    this.cols = cols;
    this.tileW = tileW;
    this.root.style.setProperty('--tile-w', `${tileW}px`);
    this.root.style.setProperty('--cols', String(cols));
    this.root.classList.toggle('tiles-small', tileW < 120);
    this.root.classList.toggle('tiles-large', tileW >= 220);

    const rows = [];
    let y = 8;
    const pushTiles = (start, end) => {
      for (let i = start; i < end; i += cols) {
        rows.push({ type: 'tiles', y, h: tileW + GAP, start: i, end: Math.min(end, i + cols) });
        y += tileW + GAP;
      }
    };
    if (this.groupBy === 'none') {
      pushTiles(0, this.items.length);
    } else {
      const keyFn = this.groupBy === 'month' ? monthKey : dayKey;
      const inner = width - PAD * 2;
      let line = null;
      const flush = () => {
        if (!line) return;
        rows.push({ type: 'line', y, h: HEADER_H + tileW + GAP, segs: line.segs, start: line.segs[0].start, end: line.segs[line.segs.length - 1].end });
        y += HEADER_H + tileW + GAP;
        line = null;
      };
      let start = 0;
      while (start < this.items.length) {
        const g = keyFn(this.items[start].createdAt);
        let end = start + 1;
        while (end < this.items.length && keyFn(this.items[end].createdAt) === g) end++;
        const n = end - start;
        if (n <= cols) {
          // Small groups share a line, each with its own date label (as Google Photos does).
          const w = n * tileW + (n - 1) * GAP;
          if (line && line.x + SEG_GAP + w > inner + 0.5) flush();
          if (!line) line = { x: 0, segs: [] };
          else line.x += SEG_GAP;
          line.segs.push({ group: g, start, end, x: PAD + line.x, w });
          line.x += w;
        } else {
          flush();
          rows.push({ type: 'header', y, h: HEADER_H, group: g, start, end });
          y += HEADER_H;
          pushTiles(start, end);
        }
        start = end;
      }
      flush();
    }
    this.rows = rows;
    this.canvas.style.height = `${y + PAD}px`;
    for (const elx of this.rendered.values()) this._removeRow(elx);
    this.rendered.clear();
    this.tiles.clear();
    this.render();
  }

  render() {
    const top = this.root.scrollTop;
    const h = this.root.clientHeight;
    const from = top - h * 0.6;
    const to = top + h * 1.6;
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].y + this.rows[mid].h < from) lo = mid + 1;
      else hi = mid;
    }
    const keep = new Set();
    for (let i = lo; i < this.rows.length && this.rows[i].y < to; i++) {
      keep.add(i);
      if (!this.rendered.has(i)) {
        const rowEl = this._renderRow(this.rows[i]);
        this.rendered.set(i, rowEl);
        this.canvas.append(rowEl);
      }
    }
    for (const [i, rowEl] of this.rendered) {
      if (!keep.has(i)) {
        this._removeRow(rowEl);
        this.rendered.delete(i);
      }
    }
    this._reportVisible();
    if (this.hooks.onEndReached && this.rows.length && top + h * 2 > this.rows[this.rows.length - 1].y) this.hooks.onEndReached();
  }

  _removeRow(rowEl) {
    for (const tile of rowEl.querySelectorAll('.tile')) {
      const img = tile.querySelector('img');
      if (img) img.removeAttribute('src'); // cancels the request if still loading
      if (this.hover.key === tile.dataset.key) this._endHover();
      this.tiles.delete(tile.dataset.key);
    }
    rowEl.remove();
  }

  _groupHeader(group, start, end) {
    const keys = this.items.slice(start, end).map((i) => i.key);
    const label = group.startsWith('0000') ? t('misc.unknownDate') : this.groupBy === 'month' ? formatMonthHeader(group) : formatDayHeader(group);
    const check = el('button.group-check', { title: t('act.selectAll'), html: icon('checkCircle'), dataset: { start, end } });
    check.classList.toggle('on', keys.every((k) => state.selection.has(k)));
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      const allNow = keys.every((k) => state.selection.has(k));
      for (const k of keys) {
        if (allNow) state.selection.delete(k);
        else state.selection.add(k);
      }
      this.refreshSelection();
      this.hooks.onSelectionChange();
    });
    return [check, el('span.group-label', label), el('span.group-count', t('misc.items', { n: end - start }))];
  }

  _renderRow(row) {
    if (row.type === 'header') {
      return el('div.grid-row.grid-header', { style: { transform: `translateY(${row.y}px)`, height: `${row.h}px` } }, this._groupHeader(row.group, row.start, row.end));
    }
    if (row.type === 'line') {
      const rowEl = el('div.grid-row.grid-line', { style: { transform: `translateY(${row.y}px)`, height: `${row.h}px` } });
      for (const seg of row.segs) {
        rowEl.append(el('div.seg-header', { style: { left: `${seg.x}px`, width: `${Math.max(seg.w, this.tileW)}px`, height: `${HEADER_H}px` } }, this._groupHeader(seg.group, seg.start, seg.end)));
        for (let i = seg.start; i < seg.end; i++) {
          const tile = this._tile(this.items[i]);
          tile.style.left = `${seg.x + (i - seg.start) * (this.tileW + GAP)}px`;
          tile.style.top = `${HEADER_H}px`;
          rowEl.append(tile);
        }
      }
      return rowEl;
    }
    const rowEl = el('div.grid-row.grid-tiles', { style: { transform: `translateY(${row.y}px)`, height: `${this.tileW}px` } });
    for (let i = row.start; i < row.end; i++) rowEl.append(this._tile(this.items[i]));
    return rowEl;
  }

  _tile(item) {
    const tile = el('div.tile', { dataset: { key: item.key }, draggable: item.kind !== 'folder' ? 'true' : 'false' });
    tile.classList.add(`kind-${item.kind}`);
    if (item.kind === 'folder') {
      tile.append(el('div.tile-folder', { html: icon('folder') }), el('div.tile-name.always', item.name));
      this.tiles.set(item.key, tile);
      return tile;
    }
    const media = el('div.tile-media');
    if (item.hasThumb !== false) {
      const img = el('img', { alt: '', decoding: 'async' });
      img.draggable = false;
      img.addEventListener('load', () => tile.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => tile.classList.add('broken'), { once: true });
      img.src = thumbUrl(item.key, this.tileW * (window.devicePixelRatio || 1));
      media.append(img);
    } else {
      tile.classList.add('broken');
    }
    media.append(el('div.tile-placeholder', { html: icon(item.kind === 'video' ? 'film' : 'image') }));
    tile.append(
      media,
      el('div.tile-shade'),
      el('div.tile-check', { html: icon('check') }),
      el('div.tile-status'),
      el('div.tile-badges'),
      el('div.tile-name', item.name),
    );
    this.tiles.set(item.key, tile);
    this.updateTile(item.key);
    return tile;
  }

  /** Refreshes selection state, badges and download status of one rendered tile. */
  updateTile(key) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    const i = this.index.get(key);
    const item = i != null ? this.items[i] : null;
    if (!item || item.kind === 'folder') return;
    tile.classList.toggle('selected', state.selection.has(key));
    tile.classList.toggle('focused', this.focusKey === key);
    const dl = state.downloads.get(key);
    const local = isLocal(key);
    const expired = item.source === 'photos' && item.reachable === false && !local;
    const processing = item.processing === 'PROCESSING';
    tile.classList.toggle('expired', expired);

    const status = tile.querySelector('.tile-status');
    let html = '';
    let title = '';
    let cls = '';
    if (local) {
      html = icon('checkCircle');
      cls = 'ok';
      title = t('tile.local');
    } else if (processing) {
      html = icon('clock');
      cls = 'warn';
      title = t('tile.processing');
    } else if (dl && (dl.state === 'active' || dl.state === 'queued' || dl.state === 'verifying' || dl.state === 'paused')) {
      const p = dl.total ? Math.min(1, dl.received / dl.total) : 0;
      html = `<svg class="ring" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" class="ring-bg"/><circle cx="12" cy="12" r="9" class="ring-fg" stroke-dasharray="${RING}" stroke-dashoffset="${RING * (1 - p)}"/></svg>`;
      cls = dl.state === 'paused' ? 'paused' : 'busy';
      title = `${Math.round(p * 100)}%`;
    } else if (dl && dl.state === 'error') {
      html = icon('alert');
      cls = 'bad';
      title = dl.error || '';
    } else if (expired) {
      html = icon('alert');
      cls = 'bad';
      title = t('tile.expired');
    } else {
      html = icon('cloud');
      cls = 'cloud';
      title = t('tile.cloud');
    }
    if (status.dataset.html !== html) {
      status.innerHTML = html;
      status.dataset.html = html;
    }
    status.className = `tile-status ${cls}`;
    status.title = title;

    const badges = tile.querySelector('.tile-badges');
    const parts = [];
    const mark = state.marks[key];
    if (mark && (mark.in != null || mark.out != null)) parts.push(`<span class="badge mark">${icon('scissors')}</span>`);
    const res = resolutionLabel(item.width, item.height);
    if (res && item.kind === 'video') parts.push(`<span class="badge res">${res}</span>`);
    if (item.kind === 'video') parts.push(`<span class="badge dur">${item.durationMs ? formatDuration(item.durationMs / 1000) : icon('play')}</span>`);
    const bhtml = parts.join('');
    if (badges.dataset.html !== bhtml) {
      badges.innerHTML = bhtml;
      badges.dataset.html = bhtml;
    }
  }

  updateAll() {
    for (const key of this.tiles.keys()) this.updateTile(key);
  }

  refreshSelection() {
    for (const key of this.tiles.keys()) this.updateTile(key);
    for (const btn of this.canvas.querySelectorAll('.group-check')) {
      const s = Number(btn.dataset.start);
      const e = Number(btn.dataset.end);
      btn.classList.toggle('on', e > s && this.items.slice(s, e).every((i) => state.selection.has(i.key)));
    }
  }

  scrollToKey(key, align = 'nearest') {
    const i = this.index.get(key);
    if (i == null) return;
    const row = this.rows.find((r) => r.type !== 'header' && i >= r.start && i < r.end);
    if (!row) return;
    const top = this.root.scrollTop;
    const h = this.root.clientHeight;
    if (align === 'start') this.root.scrollTop = Math.max(0, row.y - 8 - HEADER_H);
    else if (row.y < top + 4) this.root.scrollTop = Math.max(0, row.y - (row.type === 'line' ? 4 : HEADER_H + 4));
    else if (row.y + row.h > top + h) this.root.scrollTop = row.y + row.h - h + 4;
    this.render();
  }

  // ── Selection & keyboard focus ─────────────────────────────────────────────

  _keyFromEvent(e) {
    const tile = e.target.closest && e.target.closest('.tile');
    return tile ? tile.dataset.key : null;
  }

  select(key, { toggle = false, range = false } = {}) {
    const prevFocus = this.focusKey;
    if (range && state.anchor && this.index.has(state.anchor)) {
      const a = this.index.get(state.anchor);
      const b = this.index.get(key);
      if (!toggle) state.selection.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selection.add(this.items[i].key);
    } else if (toggle) {
      if (state.selection.has(key)) state.selection.delete(key);
      else state.selection.add(key);
      state.anchor = key;
    } else {
      state.selection.clear();
      state.selection.add(key);
      state.anchor = key;
    }
    this.focusKey = key;
    if (prevFocus && prevFocus !== key) this.updateTile(prevFocus);
    this.refreshSelection();
    this.hooks.onSelectionChange();
  }

  moveFocus(dx, dy, extend) {
    if (!this.items.length) return;
    let i = this.index.has(this.focusKey) ? this.index.get(this.focusKey) : -1;
    if (i === -1) i = 0;
    else if (dx) i += dx;
    else if (dy) {
      // Move by visual columns inside the current group.
      const row = this.rows.find((r) => r.type !== 'header' && i >= r.start && i < r.end);
      const col = row ? i - row.start : 0;
      const rowIdx = this.rows.indexOf(row);
      let r = rowIdx;
      do r += dy; while (this.rows[r] && this.rows[r].type === 'header');
      const target = this.rows[r];
      if (target) i = Math.min(target.end - 1, target.start + col);
    }
    i = Math.max(0, Math.min(this.items.length - 1, i));
    const key = this.items[i].key;
    this.select(key, { range: extend });
    this.scrollToKey(key);
  }

  _onClick(e) {
    const key = this._keyFromEvent(e);
    if (!key) return;
    const item = this.items[this.index.get(key)];
    if (item && item.kind === 'folder') {
      this.hooks.onOpenFolder(item);
      return;
    }
    const additive = e.metaKey || e.ctrlKey || !!e.target.closest('.tile-check');
    this.select(key, { toggle: additive, range: e.shiftKey });
  }

  _onDblClick(e) {
    const key = this._keyFromEvent(e);
    if (!key) return;
    const item = this.items[this.index.get(key)];
    if (item && item.kind !== 'folder') this.hooks.onOpen(key);
  }

  _onContext(e) {
    const key = this._keyFromEvent(e);
    if (!key) return;
    e.preventDefault();
    const item = this.items[this.index.get(key)];
    if (!item || item.kind === 'folder') return;
    if (!state.selection.has(key)) this.select(key);
    this.hooks.onContext(key, e.clientX, e.clientY);
  }

  _onDragStart(e) {
    const key = this._keyFromEvent(e);
    e.preventDefault();
    if (!key) return;
    this._endHover();
    if (!state.selection.has(key)) this.select(key);
    this.hooks.onDragStart([...state.selection].filter((k) => this.index.has(k)));
  }

  // ── Hover preview / skimming ───────────────────────────────────────────────

  _onHover(e) {
    const key = this._keyFromEvent(e);
    if (key === this.hover.key) return;
    this._endHover();
    if (!key || !state.settings.hoverPreview) return;
    const item = this.items[this.index.get(key)];
    if (!item || item.kind !== 'video') return;
    if (item.source === 'photos' && item.reachable === false && !isLocal(key)) return;
    this.hover.key = key;
    this.hover.timer = setTimeout(() => this._startHoverVideo(key), 280);
  }

  _startHoverVideo(key) {
    const tile = this.tiles.get(key);
    if (!tile || this.hover.key !== key) return;
    const video = el('video.tile-video', { muted: true, playsInline: true, preload: 'auto', loop: true });
    video.muted = !state.settings.hoverPreviewSound;
    video.src = streamUrl(key);
    video.addEventListener('loadeddata', () => {
      if (this.hover.video !== video) return;
      tile.classList.add('previewing');
      if (this.hover.pendingSeek != null) this._seekHover(this.hover.pendingSeek);
      else video.play().catch(() => {});
    });
    video.addEventListener('seeked', () => {
      this.hover.seeking = false;
      if (this.hover.pendingSeek != null && this.hover.video === video) {
        const next = this.hover.pendingSeek;
        this.hover.pendingSeek = null;
        this._seekHover(next);
      }
    });
    video.addEventListener('loadedmetadata', () => {
      const item = this.items[this.index.get(key)];
      if (item && !item.durationMs && Number.isFinite(video.duration)) item.durationMs = Math.round(video.duration * 1000);
    });
    tile.querySelector('.tile-media').append(video);
    this.hover.video = video;
  }

  _onMove(e) {
    if (!this.hover.key) return;
    const tile = this.tiles.get(this.hover.key);
    if (!tile) return;
    const rect = tile.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    tile.style.setProperty('--skim', `${frac * 100}%`);
    tile.classList.add('skimming');
    const video = this.hover.video;
    clearTimeout(this.hover.playTimer);
    if (!video || video.readyState < 1) {
      this.hover.pendingSeek = frac;
      return;
    }
    video.pause();
    if (this.hover.seeking) this.hover.pendingSeek = frac;
    else this._seekHover(frac);
    // Resume playback when the mouse rests.
    this.hover.playTimer = setTimeout(() => {
      if (this.hover.video === video) {
        tile.classList.remove('skimming');
        video.play().catch(() => {});
      }
    }, 700);
  }

  _seekHover(frac) {
    const video = this.hover.video;
    if (!video || !Number.isFinite(video.duration)) {
      this.hover.pendingSeek = frac;
      return;
    }
    this.hover.seeking = true;
    const time = Math.min(video.duration - 0.05, frac * video.duration);
    if (typeof video.fastSeek === 'function') video.fastSeek(time);
    else video.currentTime = time;
  }

  _endHover() {
    clearTimeout(this.hover.timer);
    clearTimeout(this.hover.playTimer);
    const tile = this.hover.key && this.tiles.get(this.hover.key);
    if (tile) tile.classList.remove('previewing', 'skimming');
    if (this.hover.video) {
      this.hover.video.pause();
      this.hover.video.removeAttribute('src');
      this.hover.video.load();
      this.hover.video.remove();
    }
    this.hover = { key: null, timer: null, video: null, seeking: false, pendingSeek: null, playTimer: null };
  }
}
