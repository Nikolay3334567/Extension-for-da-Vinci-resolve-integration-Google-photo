// Main UI controller: layout, data loading, events from the main process, actions, shortcuts.

import { call, onEvent, startDrag } from './api.js';
import { setLanguage, t } from './i18n.js';
import { el, clear, debounce, formatSpeed, formatBytes, isEditableTarget } from './util.js';
import { icon } from './icons.js';
import { state, getItem, isLocal, viewItems, groupingFor } from './state.js';
import { Grid } from './grid.js';
import { Preview } from './preview.js';
import { DownloadsPanel, downloadSummary } from './downloads.js';
import { SettingsDialog } from './settings.js';
import { Onboarding } from './onboarding.js';
import { toast } from './toast.js';
import { showMenu, closeMenu } from './menu.js';

const $ = (sel) => document.querySelector(sel);
const appendAll = (node, ...children) => node.append(...children.filter((c) => c != null && c !== false));
const ui = {};
let grid;
let preview;
let drawer;
let settings;
let onboarding;
const prefs = loadPrefs();

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('cloudpool.ui') || '{}');
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem('cloudpool.ui', JSON.stringify(prefs));
  } catch {
    /* storage unavailable */
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const init = await call('app:init');
  Object.assign(state, {
    mode: init.mode,
    platform: init.platform,
    mediaBase: init.mediaBase,
    auth: init.auth,
    settings: init.settings,
    picker: init.picker,
    resolve: init.resolve,
    luaBridge: init.luaBridge,
    version: init.version,
  });
  document.body.classList.add(`platform-${init.platform}`);
  setLanguage(init.language);
  for (const d of init.downloads || []) state.downloads.set(d.key, d);
  for (const j of init.jobs || []) state.jobs.set(j.id, j);
  if (prefs.view) Object.assign(state.view, prefs.view, { search: '', folderId: null, trail: [] });

  buildLayout();
  onEvent(handleEvent);
  document.addEventListener('keydown', onKey);
  route();
  if (state.auth.signedIn) await loadAll();
  else refreshGrid({ resetScroll: true });
}

async function loadAll() {
  await Promise.all([loadPhotos(), loadLocal()]);
  if (state.view.source === 'drive') await loadDrive(true);
  else refreshGrid({ resetScroll: true });
}

function route() {
  if (state.auth.signedIn) onboarding.hide();
  else onboarding.show();
  renderSidebar();
}

// ── Layout ───────────────────────────────────────────────────────────────────

function buildLayout() {
  ui.sidebar = $('#sidebar');
  ui.toolbar = $('#toolbar');
  ui.selbar = $('#selbar');
  ui.gridRoot = $('#grid');
  ui.empty = $('#empty');
  ui.banner = $('#picker-banner');
  ui.status = $('#statusbar');
  ui.content = $('#content');
  ui.splitter = $('#splitter');

  grid = new Grid(ui.gridRoot, {
    onOpen: (key) => openPreview(key),
    onOpenFolder: (item) => openFolder(item),
    onContext: (key, x, y) => contextMenu(key, x, y),
    onDragStart: (keys) => dragOut(keys),
    onSelectionChange: () => renderSelbar(),
    onVisible: (keys) => probeVisible(keys),
    onEndReached: () => {
      if (state.view.source === 'drive' && state.drive.nextPageToken && !state.drive.loading) loadDrive(false);
    },
  });
  grid.tileSize = state.settings.tileSize || 168;
  grid.setFit(state.settings.tileFit || 'cover');

  preview = new Preview($('#preview'), {
    onClose: () => ui.content.classList.remove('with-preview'),
    onAction: (action, keys) => runAction(action, keys),
    onMarksChange: (key) => grid.updateTile(key),
    onPickAgain: () => pick(),
  });
  drawer = new DownloadsPanel($('#drawer'));
  settings = new SettingsDialog($('#settings'), {
    onLanguage: (lang) => {
      if (lang === 'auto') return;
      setLanguage(lang);
      rerenderAll();
    },
    onSignIn: () => onboarding.show(),
    onChangeClient: () => onboarding.show({ editClient: true }),
  });
  onboarding = new Onboarding($('#onboarding'));

  if (prefs.previewWidth) document.documentElement.style.setProperty('--preview-w', `${prefs.previewWidth}px`);
  setupSplitter();
  renderSidebar();
  renderToolbar();
  renderSelbar();
  renderBanner();
  renderStatus();
  window.addEventListener('focus', () => call('resolve:status').catch(() => {}));
}

function rerenderAll() {
  renderSidebar();
  renderToolbar();
  renderSelbar();
  renderBanner();
  renderStatus();
  refreshGrid();
  if (preview.isOpen) preview.render();
  if (drawer.isOpen) drawer.render();
  onboarding.render();
}

function setupSplitter() {
  let startX = 0;
  let startW = 0;
  ui.splitter.addEventListener('pointerdown', (e) => {
    ui.splitter.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startW = $('#preview').getBoundingClientRect().width;
    document.body.classList.add('resizing');
  });
  ui.splitter.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('resizing')) return;
    const w = Math.max(300, Math.min(window.innerWidth * 0.7, startW + (startX - e.clientX)));
    document.documentElement.style.setProperty('--preview-w', `${w}px`);
    prefs.previewWidth = Math.round(w);
  });
  ui.splitter.addEventListener('pointerup', () => {
    document.body.classList.remove('resizing');
    savePrefs();
    grid.relayout(true);
  });
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function navItem({ id, label, ic, count, active, onClick, cls = '' }) {
  return el(
    `button.nav-item${cls}`,
    { class: active ? 'active' : '', dataset: { nav: id }, on: { click: onClick } },
    el('span.nav-icon', { html: icon(ic) }),
    el('span.nav-label', label),
    count != null ? el('span.nav-count', String(count)) : null,
  );
}

function renderSidebar() {
  if (!ui.sidebar) return;
  const v = state.view;
  const sources = state.auth.sources || [];
  const activeDl = downloadSummary().active;
  clear(ui.sidebar);
  ui.sidebar.append(
    el('div.brand', el('span.brand-logo', { html: icon('cloud') }), el('span.brand-name', 'Cloud Pool')),
    el('div.nav-section', t('src.photos')),
    el('button.btn.primary.pick-btn', { disabled: !state.auth.signedIn || !sources.includes('photos'), on: { click: () => pick() } }, el('span', { html: icon('plus') }), t('nav.pick')),
    navItem({ id: 'photos', label: t('nav.library'), ic: 'photos', count: state.photos.size, active: v.source === 'photos', onClick: () => setSource('photos') }),
  );
  if (sources.includes('drive')) {
    ui.sidebar.append(
      el('div.nav-section', t('src.drive')),
      navItem({ id: 'drive-videos', label: t('nav.driveVideos'), ic: 'film', active: v.source === 'drive' && v.driveView === 'videos', onClick: () => setDrive('videos') }),
      navItem({ id: 'drive-photos', label: t('nav.drivePhotos'), ic: 'image', active: v.source === 'drive' && v.driveView === 'photos', onClick: () => setDrive('photos') }),
      navItem({ id: 'drive-folder', label: t('nav.driveFolders'), ic: 'drive', active: v.source === 'drive' && v.driveView === 'folder', onClick: () => setDrive('folder') }),
      navItem({ id: 'drive-shared', label: t('nav.driveShared'), ic: 'shared', active: v.source === 'drive' && v.driveView === 'shared', onClick: () => setDrive('shared') }),
    );
  }
  ui.sidebar.append(
    el('div.nav-section', t('src.local')),
    navItem({ id: 'local', label: t('nav.downloaded'), ic: 'computer', count: state.local.size, active: v.source === 'local', onClick: () => setSource('local') }),
    el('div.flex'),
    navItem({ id: 'downloads', label: t('nav.downloads'), ic: 'download', count: activeDl || null, onClick: () => drawer.toggle(), cls: '.compact' }),
    navItem({ id: 'settings', label: t('nav.settings'), ic: 'settings', onClick: () => settings.open(), cls: '.compact' }),
  );
  const acc = state.auth.account;
  if (acc) {
    ui.sidebar.append(
      el(
        'div.account',
        { title: acc.email },
        el('span.avatar', (acc.name || acc.email || '?').trim().charAt(0).toUpperCase()),
        el('span.account-text', el('span.account-name', acc.name || ''), el('span.account-mail', acc.email || '')),
      ),
    );
  }
}

function setSource(source) {
  state.view.source = source;
  state.view.search = '';
  afterViewChange();
}

function setDrive(view) {
  Object.assign(state.view, { source: 'drive', driveView: view, folderId: null, trail: [], search: '' });
  afterViewChange();
}

function afterViewChange() {
  prefs.view = { source: state.view.source, driveView: state.view.driveView, filter: state.view.filter, sort: state.view.sort };
  savePrefs();
  state.selection.clear();
  renderSidebar();
  renderToolbar();
  renderSelbar();
  if (state.view.source === 'drive') loadDrive(true);
  else refreshGrid({ resetScroll: true });
}

async function openFolder(item) {
  state.view.folderId = item.id;
  state.view.trail = [...state.view.trail, { id: item.id, name: item.name }];
  state.view.driveView = 'folder';
  state.selection.clear();
  renderToolbar();
  renderSelbar();
  await loadDrive(true);
}

// ── Toolbar & selection bar ─────────────────────────────────────────────────

function viewTitle() {
  const v = state.view;
  if (v.source === 'photos') return [t('src.photos'), t('nav.library')];
  if (v.source === 'local') return [t('src.local'), t('nav.downloaded')];
  const name = { videos: t('nav.driveVideos'), photos: t('nav.drivePhotos'), folder: t('nav.driveFolders'), shared: t('nav.driveShared') }[v.driveView];
  return [t('src.drive'), name];
}

function renderToolbar() {
  if (!ui.toolbar) return;
  const v = state.view;
  const [section, title] = viewTitle();
  clear(ui.toolbar);
  const crumbs = el('div.crumbs', el('span.crumb-section', section), el('span.crumb-sep', { html: icon('chevronRight') }));
  if (v.source === 'drive' && v.driveView === 'folder' && v.trail.length) {
    crumbs.append(el('button.crumb', { on: { click: () => { v.folderId = null; v.trail = []; loadDrive(true); renderToolbar(); } } }, title));
    v.trail.forEach((c, i) => {
      crumbs.append(el('span.crumb-sep', { html: icon('chevronRight') }));
      crumbs.append(
        el('button.crumb', {
          on: {
            click: () => {
              v.trail = v.trail.slice(0, i + 1);
              v.folderId = c.id;
              loadDrive(true);
              renderToolbar();
            },
          },
        }, c.name),
      );
    });
  } else {
    crumbs.append(el('span.crumb.current', title));
  }
  crumbs.append(el('span.crumb-count', ''));

  const search = el('input.search', {
    type: 'search',
    placeholder: t(v.source === 'drive' ? 'search.drive' : v.source === 'local' ? 'search.local' : 'search.photos'),
    value: v.search,
    spellcheck: false,
  });
  const runSearch = debounce(() => {
    v.search = search.value.trim();
    if (v.source === 'drive') loadDrive(true);
    else refreshGrid({ resetScroll: true });
  }, v.source === 'drive' ? 400 : 120);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      runSearch();
      search.blur();
    }
  });

  const filter = el(
    'div.segmented',
    ['all', 'video', 'photo'].map((f) =>
      el('button', {
        class: v.filter === f ? 'on' : '',
        on: {
          click: () => {
            v.filter = f;
            afterViewChange();
          },
        },
      }, t(`filter.${f}`)),
    ),
  );

  const sortOptions = v.source === 'drive' ? ['newest', 'oldest', 'name', 'size'] : ['newest', 'oldest', 'name', 'duration', 'size'];
  const sort = el(
    'select.select',
    { title: t('sort.newest'), on: { change: (e) => { v.sort = e.target.value; afterViewChange(); } } },
    sortOptions.map((s) => el('option', { value: s, selected: v.sort === s }, t(`sort.${s}`))),
  );
  const setView = async (patch) => {
    state.settings = await call('settings:set', patch);
    if (patch.tileFit) grid.setFit(patch.tileFit);
    if (patch.groupBy) refreshGrid();
  };
  const viewMenu = el('button.icon-btn', {
    title: `${t('group.day')} / ${t('view.fit')}`,
    html: icon('fit'),
    on: {
      click: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const g = state.settings.groupBy || 'day';
        const f = state.settings.tileFit || 'cover';
        showMenu(r.left - 150, r.bottom + 4, [
          ...['day', 'month', 'none'].map((v) => ({ label: t(`group.${v}`), icon: g === v ? 'check' : null, run: () => setView({ groupBy: v }) })),
          'sep',
          { label: t('view.fill'), icon: f === 'cover' ? 'check' : null, run: () => setView({ tileFit: 'cover' }) },
          { label: t('view.fit'), icon: f === 'contain' ? 'check' : null, run: () => setView({ tileFit: 'contain' }) },
        ]);
      },
    },
  });
  const size = el('input.size-slider', {
    type: 'range',
    min: '90',
    max: '380',
    step: '2',
    value: String(grid.tileSize),
    title: t('view.size'),
  });
  size.addEventListener('input', () => grid.setTileSize(Number(size.value)));
  size.addEventListener('change', () => call('settings:set', { tileSize: Number(size.value) }).then((s) => (state.settings = s)));

  ui.toolbar.append(crumbs, search, filter, sort, viewMenu, el('span.size-wrap', el('span', { html: icon('grid') }), size));
  updateCount();
}

function updateCount() {
  const node = ui.toolbar && ui.toolbar.querySelector('.crumb-count');
  if (!node) return;
  const n = grid ? grid.items.filter((i) => i.kind !== 'folder').length : 0;
  node.textContent = n ? t('misc.items', { n }) : '';
}

function renderSelbar() {
  if (!ui.selbar) return;
  const keys = selectedKeys();
  clear(ui.selbar);
  ui.selbar.classList.toggle('open', keys.length > 0);
  if (!keys.length) return;
  const btn = (action, label, ic, hint, primary) =>
    el(`button.btn${primary ? '.primary' : ''}`, { title: hint || label, on: { click: () => runAction(action, keys) } }, el('span', { html: icon(ic) }), label);
  const allLocal = keys.every((k) => isLocal(k));
  appendAll(
    ui.selbar,
    el('span.sel-count', t('sel.count', { n: keys.length })),
    btn('append', t('act.append'), 'timeline', t('act.appendHint'), true),
    btn('playhead', t('act.playhead'), 'playhead', t('act.playheadHint')),
    btn('import', t('act.import'), 'bin', t('act.importHint')),
    allLocal ? null : btn('download', t('act.download'), 'download'),
    el('button.icon-btn', {
      title: '…',
      html: icon('more'),
      on: {
        click: (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          contextMenu(keys[0], r.left, r.bottom + 4);
        },
      },
    }),
    el('span.flex'),
    state.resolve.connected ? null : el('span.sel-hint', t('resolve.dragHint')),
    el('button.icon-btn', {
      title: t('act.clearSel'),
      html: icon('x'),
      on: {
        click: () => {
          state.selection.clear();
          grid.refreshSelection();
          renderSelbar();
        },
      },
    }),
  );
}

function selectedKeys() {
  return [...state.selection].filter((k) => {
    const it = getItem(k);
    return it && it.kind !== 'folder';
  });
}

// ── Grid data ────────────────────────────────────────────────────────────────

function refreshGrid({ resetScroll = false } = {}) {
  if (!grid) return;
  const items = viewItems();
  grid.setItems(items, { groupBy: groupingFor(), resetScroll });
  for (const key of [...state.selection]) if (!grid.index.has(key)) state.selection.delete(key);
  renderEmpty(items);
  updateCount();
  renderSelbar();
}

const refreshGridSoon = debounce(() => refreshGrid(), 120);

function renderEmpty(items) {
  clear(ui.empty);
  const v = state.view;
  const loading = v.source === 'drive' && state.drive.loading && !items.length;
  ui.empty.classList.toggle('open', !items.length || !!(v.source === 'drive' && state.drive.error));
  if (loading) {
    ui.empty.append(el('div.empty-box', el('span.spinner'), el('p', t('misc.loading'))));
    return;
  }
  if (v.source === 'drive' && state.drive.error) {
    ui.empty.append(el('div.empty-box', el('div.empty-icon', { html: icon('alert') }), el('p', t('misc.error', { message: state.drive.error }))));
    return;
  }
  if (items.length) return;
  if (v.search) {
    ui.empty.append(el('div.empty-box', el('div.empty-icon', { html: icon('search') }), el('p', t('empty.search'))));
  } else if (v.source === 'photos') {
    ui.empty.append(
      el(
        'div.empty-box.wide',
        el('div.empty-icon.big', { html: icon('photos') }),
        el('h2', t('empty.photos.title')),
        el('p', t('empty.photos.text')),
        el('button.btn.primary.large', { disabled: !state.auth.signedIn, on: { click: () => pick() } }, el('span', { html: icon('plus') }), t('nav.pick')),
        el('p.muted.small', t('empty.photos.why')),
      ),
    );
  } else if (v.source === 'local') {
    ui.empty.append(el('div.empty-box', el('div.empty-icon', { html: icon('computer') }), el('p', t('empty.local'))));
  } else {
    ui.empty.append(el('div.empty-box', el('div.empty-icon', { html: icon('drive') }), el('p', t('empty.drive'))));
  }
}

async function loadPhotos() {
  try {
    const items = await call('photos:list');
    state.photos = new Map(items.map((i) => [i.key, i]));
  } catch (err) {
    toast(t('toast.error', { message: err.message }), { level: 'error' });
  }
  renderSidebar();
}

async function loadLocal() {
  try {
    const items = await call('local:list');
    state.local = new Map(items.map((i) => [i.key, i]));
  } catch {
    /* ignore */
  }
  renderSidebar();
}

async function loadDrive(reset) {
  const v = state.view;
  const d = state.drive;
  const req = ++d.req;
  if (reset) {
    d.items = [];
    d.index = new Map();
    d.nextPageToken = null;
    d.error = null;
  }
  d.loading = true;
  if (reset) refreshGrid({ resetScroll: true });
  try {
    const kind = v.filter === 'all' ? 'all' : v.filter;
    const res = await call('drive:list', { view: v.driveView, folderId: v.folderId, search: v.search, kind, order: v.sort, pageToken: reset ? '' : d.nextPageToken });
    if (req !== d.req) return;
    for (const item of res.items) {
      if (d.index.has(item.key)) continue;
      d.index.set(item.key, item);
      d.items.push(item);
    }
    d.nextPageToken = res.nextPageToken;
  } catch (err) {
    if (req !== d.req) return;
    d.error = err.message;
    if (err.code === 'AUTH_REQUIRED') toast(t('toast.expired'), { level: 'warn' });
  } finally {
    if (req === d.req) {
      d.loading = false;
      if (reset) refreshGrid({ resetScroll: true });
      else {
        const top = ui.gridRoot.scrollTop;
        refreshGrid();
        ui.gridRoot.scrollTop = top;
      }
    }
  }
}

const probeVisible = debounce((keys) => {
  const missing = keys.filter((k) => {
    const it = state.photos.get(k);
    return it && it.kind === 'video' && !it.durationMs && it.reachable !== false;
  });
  if (missing.length) call('items:probe', { keys: missing }).catch(() => {});
}, 300);

// ── Picker ───────────────────────────────────────────────────────────────────

async function pick() {
  try {
    state.picker = await call('photos:pick');
  } catch (err) {
    toast(t('toast.error', { message: err.message }), { level: 'error' });
  }
  if (state.view.source !== 'photos') setSource('photos');
  renderBanner();
}

function renderBanner() {
  if (!ui.banner) return;
  const p = state.picker || {};
  clear(ui.banner);
  const busy = p.state === 'creating' || p.state === 'waiting' || p.state === 'fetching';
  ui.banner.classList.toggle('open', busy);
  if (!busy) return;
  const text = t(`picker.${p.state}`);
  ui.banner.append(
    el(
      'div.banner-card',
      el('span.spinner'),
      el('div.banner-text', el('strong', text), p.state === 'waiting' ? el('span.muted', t('picker.waitingHint')) : null),
      p.state === 'waiting' ? el('button.btn', { on: { click: () => call('photos:reopenPicker') } }, el('span', { html: icon('external') }), t('picker.reopen')) : null,
      el('button.btn', { on: { click: () => call('photos:cancelPick') } }, t('act.cancel')),
    ),
  );
}

// ── Status bar ───────────────────────────────────────────────────────────────

function renderStatus() {
  if (!ui.status) return;
  const r = state.resolve || {};
  clear(ui.status);
  const parts = [];
  if (r.connected) {
    parts.push(el('span.dot.ok'));
    parts.push(el('span.status-strong', t('resolve.connected', { product: r.product || 'DaVinci Resolve', version: r.version || '' })));
    parts.push(el('span.status-sep', '·'), el('span', r.project ? t('resolve.project', { name: r.project }) : t('resolve.noProject')));
    if (r.project) parts.push(el('span.status-sep', '·'), el('span', r.timeline ? `${t('resolve.timeline', { name: r.timeline.name })}${r.timeline.fps ? ` (${r.timeline.fps} fps)` : ''}` : t('resolve.noTimeline')));
  } else {
    parts.push(el('span.dot.off'));
    parts.push(el('span', state.mode === 'plugin' ? t('resolve.offlinePlugin') : t('resolve.offlineBridge')));
  }
  const sum = downloadSummary();
  const dl = el(
    'button.status-dl',
    { on: { click: () => drawer.toggle() } },
    el('span', { html: icon('download') }),
    sum.active ? t('dl.summary', { n: sum.active, speed: formatSpeed(sum.speed) }) + (sum.left ? ` · ${formatBytes(sum.left)}` : '') : t('nav.downloads'),
  );
  const pin = el('button.icon-btn.small', {
    class: state.settings.pinned ? 'on' : '',
    title: t('st.pinned'),
    html: icon('pin'),
    on: {
      click: async () => {
        state.settings = await call('settings:set', { pinned: !state.settings.pinned });
        renderStatus();
      },
    },
  });
  ui.status.append(el('div.status-left', parts), el('span.flex'), dl, pin);
}

const renderStatusSoon = debounce(renderStatus, 300);

// ── Events from the main process ─────────────────────────────────────────────

function handleEvent({ type, payload }) {
  switch (type) {
    case 'auth': {
      const wasSignedIn = state.auth.signedIn;
      state.auth = payload;
      route();
      if (payload.signedIn && !wasSignedIn) loadAll();
      if (!payload.signedIn && wasSignedIn && payload.lastError === 'expired') toast(t('toast.expired'), { level: 'warn' });
      renderBanner();
      break;
    }
    case 'picker': {
      state.picker = payload;
      renderBanner();
      if (payload.state === 'done') {
        toast(payload.updated ? t('picker.done', { added: payload.added || 0, updated: payload.updated }) : t('picker.added', { n: payload.added || 0 }), { level: 'ok' });
        window.focus();
      } else if (payload.state === 'timeout') toast(t('picker.timeout'), { level: 'warn' });
      else if (payload.state === 'error') toast(t('toast.error', { message: payload.error }), { level: 'error' });
      break;
    }
    case 'photos': {
      for (const item of payload.upsert || []) state.photos.set(item.key, item);
      for (const key of payload.remove || []) state.photos.delete(key);
      if (state.view.source === 'photos' && (payload.remove?.length || (payload.upsert || []).some((i) => !grid.index.has(i.key)))) {
        refreshGridSoon();
      } else {
        for (const item of payload.upsert || []) {
          const i = grid.index.get(item.key);
          if (i != null) Object.assign(grid.items[i], item);
          grid.updateTile(item.key);
        }
      }
      if (preview.isOpen) preview.refresh();
      renderSidebar();
      break;
    }
    case 'local': {
      for (const entry of payload.upsert || []) {
        state.local.set(entry.key, { ...entry, local: true, reachable: true, hasThumb: true });
        const other = state.photos.get(entry.key) || state.drive.index.get(entry.key);
        if (other) other.local = true;
      }
      for (const key of payload.remove || []) {
        state.local.delete(key);
        const other = state.photos.get(key) || state.drive.index.get(key);
        if (other) other.local = false;
      }
      if (state.view.source === 'local') refreshGridSoon();
      else for (const k of [...(payload.upsert || []).map((e) => e.key), ...(payload.remove || [])]) grid.updateTile(k);
      if (preview.isOpen) preview.refresh();
      renderSidebar();
      renderSelbar();
      break;
    }
    case 'downloads': {
      for (const d of payload) {
        state.downloads.set(d.key, d);
        grid.updateTile(d.key);
        if (drawer.isOpen) drawer.update(d);
        if (preview.key === d.key) preview.refresh();
      }
      renderStatusSoon();
      break;
    }
    case 'download-removed': {
      state.downloads.delete(payload);
      grid.updateTile(payload);
      if (drawer.isOpen) drawer.remove(payload);
      renderStatusSoon();
      break;
    }
    case 'jobs': {
      const prev = state.jobs.get(payload.id);
      state.jobs.set(payload.id, payload);
      if (drawer.isOpen) drawer.updateJob(payload);
      if (prev && prev.state !== payload.state) jobFinished(payload);
      break;
    }
    case 'resolve': {
      state.resolve = payload;
      renderStatus();
      renderSelbar();
      break;
    }
    case 'meta': {
      for (const map of [state.photos, state.drive.index, state.local]) {
        const it = map.get(payload.key);
        if (it) Object.assign(it, payload);
      }
      grid.updateTile(payload.key);
      if (preview.key === payload.key) preview.refresh();
      break;
    }
    case 'settings': {
      state.settings = payload;
      break;
    }
    case 'toast': {
      toast(payload.message, { level: payload.level || 'info' });
      break;
    }
    default:
      break;
  }
}

function jobFinished(job) {
  if (job.state === 'done' && job.result) {
    const msg = job.action === 'import' ? t('job.imported', { n: job.result.imported + job.result.reused }) : t('job.placed', { n: job.result.placed, timeline: job.result.timeline || '' });
    toast(msg, { level: 'ok', timeout: 3500 });
  } else if (job.state === 'error') {
    if (job.errorCode === 'NO_RESOLVE' || job.errorCode === 'BRIDGE_OFFLINE') toast(t('toast.noResolve'), { level: 'warn', timeout: 9000 });
    else toast(t('toast.error', { message: job.error }), { level: 'error', timeout: 9000 });
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function runAction(action, keys) {
  keys = keys.filter((k) => {
    const it = getItem(k);
    return it && it.kind !== 'folder';
  });
  if (!keys.length) return;
  try {
    switch (action) {
      case 'append':
      case 'playhead':
      case 'import':
      case 'newTimeline': {
        const usable = keys.filter((k) => {
          const it = getItem(k);
          return isLocal(k) || !(it.source === 'photos' && it.reachable === false);
        });
        if (usable.length < keys.length) toast(t('tile.expired'), { level: 'warn' });
        if (!usable.length) return;
        const marks = {};
        for (const k of usable) if (state.marks[k]) marks[k] = state.marks[k];
        await call('resolve:send', { keys: usable, action, marks });
        const waiting = usable.filter((k) => !isLocal(k)).length;
        if (waiting) toast(t('toast.downloading', { n: waiting }), { timeout: 3500 });
        break;
      }
      case 'download':
        await call('downloads:start', { keys });
        break;
      case 'reveal':
        await call('local:reveal', { key: keys[0] });
        break;
      case 'copyPath':
        if (await call('local:copyPath', { key: keys[0] })) toast(t('toast.copied'), { level: 'ok', timeout: 2000 });
        break;
      case 'preview':
        openPreview(keys[0]);
        break;
      case 'remove': {
        const photos = keys.filter((k) => k.startsWith('photos:'));
        if (photos.length && window.confirm(`${t('act.remove')}: ${photos.length}?`)) {
          await call('photos:remove', { keys: photos });
          for (const k of photos) state.selection.delete(k);
          if (preview.isOpen && photos.includes(preview.key)) preview.close();
        }
        break;
      }
      case 'deleteLocal': {
        const local = keys.filter((k) => isLocal(k));
        if (local.length && window.confirm(`${t('act.deleteLocal')}: ${local.length}?`)) await call('local:delete', { keys: local });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    toast(t('toast.error', { message: err.message }), { level: 'error' });
  }
}

function contextMenu(key, x, y) {
  const keys = state.selection.has(key) ? selectedKeys() : [key];
  const item = getItem(key);
  const local = keys.every((k) => isLocal(k));
  const mod = state.platform === 'darwin' ? '⌘' : 'Ctrl+';
  showMenu(x, y, [
    { label: t('act.append'), icon: 'timeline', hint: 'Enter', run: () => runAction('append', keys) },
    { label: t('act.playhead'), icon: 'playhead', hint: 'F12', run: () => runAction('playhead', keys) },
    { label: t('act.import'), icon: 'bin', hint: `${mod}I`, run: () => runAction('import', keys) },
    { label: t('act.newTimeline'), icon: 'film', run: () => runAction('newTimeline', keys) },
    'sep',
    { label: t('act.preview'), icon: 'play', hint: 'Space', run: () => openPreview(key) },
    local ? null : { label: t('act.download'), icon: 'download', hint: 'D', run: () => runAction('download', keys) },
    { label: t('act.reveal'), icon: 'folder', disabled: !isLocal(key), run: () => runAction('reveal', [key]) },
    { label: t('act.copyPath'), icon: 'copy', disabled: !isLocal(key), run: () => runAction('copyPath', [key]) },
    'sep',
    item && item.source === 'photos' ? { label: t('act.remove'), icon: 'trash', danger: true, run: () => runAction('remove', keys) } : null,
    keys.some((k) => isLocal(k)) ? { label: t('act.deleteLocal'), icon: 'trash', danger: true, run: () => runAction('deleteLocal', keys) } : null,
  ].filter(Boolean).filter((it, i, arr) => !(it === 'sep' && (i === arr.length - 1 || arr[i + 1] === 'sep'))));
}

function dragOut(keys) {
  const missing = keys.filter((k) => !isLocal(k));
  if (!missing.length) {
    startDrag(keys);
    return;
  }
  call('downloads:start', { keys: missing, urgent: true }).catch(() => {});
  toast(t('toast.dragWait', { n: missing.length }), { level: 'info', timeout: 7000 });
}

function openPreview(key) {
  ui.content.classList.add('with-preview');
  preview.open(key);
  grid.relayout(true);
  grid.scrollToKey(key);
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

function onKey(e) {
  if (isEditableTarget(e.target)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (document.querySelector('.ctx-menu')) return;
  if ($('#onboarding').classList.contains('open')) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key;
  const sel = selectedKeys();
  const focus = grid.focusKey || sel[0];
  const pv = preview.isOpen && preview.video;
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (key === 'Escape') {
    if (settings.isOpen) settings.close();
    else if (drawer.isOpen) drawer.toggle(false);
    else if (preview.isOpen) preview.close();
    else if (state.selection.size) {
      state.selection.clear();
      grid.refreshSelection();
      renderSelbar();
    }
    return handled();
  }
  if (settings.isOpen) return;
  if (mod && key.toLowerCase() === 'a') {
    for (const it of grid.items) if (it.kind !== 'folder') state.selection.add(it.key);
    grid.refreshSelection();
    renderSelbar();
    return handled();
  }
  if (mod && key.toLowerCase() === 'f') {
    const s = ui.toolbar.querySelector('.search');
    if (s) s.focus();
    return handled();
  }
  if (mod && key.toLowerCase() === 'i') {
    if (sel.length) runAction('import', sel);
    return handled();
  }
  if (mod) return;
  switch (key) {
    case ' ':
      if (pv) preview.togglePlay();
      else if (focus) openPreview(focus);
      return handled();
    case 'Enter':
      if (sel.length) runAction(e.shiftKey ? 'playhead' : 'append', sel);
      return handled();
    case 'F12':
      if (sel.length) runAction(e.shiftKey ? 'append' : 'playhead', sel);
      return handled();
    case 'ArrowLeft':
    case 'ArrowRight': {
      const dir = key === 'ArrowLeft' ? -1 : 1;
      if (pv) {
        if (e.shiftKey) preview.jump(dir);
        else preview.step(dir);
      } else grid.moveFocus(dir, 0, e.shiftKey);
      return handled();
    }
    case 'ArrowUp':
    case 'ArrowDown':
      grid.moveFocus(0, key === 'ArrowUp' ? -1 : 1, e.shiftKey);
      if (preview.isOpen && grid.focusKey) preview.open(grid.focusKey);
      return handled();
    case 'Delete':
    case 'Backspace':
      if (sel.length) runAction(state.view.source === 'local' ? 'deleteLocal' : 'remove', sel);
      return handled();
    case '+':
    case '=':
      grid.setTileSize(Math.min(380, grid.tileSize + 24));
      return handled();
    case '-':
    case '_':
      grid.setTileSize(Math.max(90, grid.tileSize - 24));
      return handled();
    default:
      break;
  }
  const k = key.toLowerCase();
  if (k === 'd' && sel.length) return runAction('download', sel), handled();
  if (!pv) return;
  if (k === 'i') return preview.markIn(), handled();
  if (k === 'o') return preview.markOut(), handled();
  if (k === 'j') return preview.shuttleBackward(), handled();
  if (k === 'k') return preview.stop(), handled();
  if (k === 'l') return preview.shuttleForward(), handled();
  if (k === 'm') return preview.toggleMute(), handled();
  if (k === 'x' && e.altKey) return preview.clearMarks(), handled();
}

window.addEventListener('blur', closeMenu);

boot().catch((err) => {
  console.error(err);
  document.body.append(el('pre.fatal', String(err && (err.stack || err.message || err))));
});
