// Settings dialog.

import { el, clear, formatBytes } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { call } from './api.js';
import { sourcePicker } from './onboarding.js';
import { showError } from './errors.js';

export class SettingsDialog {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks; // { onLanguage(lang), onSignIn(), onChangeClient() }
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  close() {
    this.root.classList.remove('open');
    clear(this.root);
  }

  async open() {
    this.root.classList.add('open');
    this.render();
    this.refreshFfmpeg();
    try {
      const stats = await call('cache:stats');
      const node = this.root.querySelector('.cache-size');
      if (node) node.textContent = t('st.cacheSize', { size: formatBytes(stats.thumbs.bytes), n: stats.thumbs.files });
    } catch {
      /* ignore */
    }
  }

  refreshFfmpeg() {
    call('ffmpeg:status', { refresh: true })
      .then((f) => {
        const node = this.root.querySelector('.ffmpeg-status');
        if (node) node.textContent = f.found ? t('st.ffmpegFound', { path: f.path, version: f.version || '' }) : t('st.ffmpegMissing');
      })
      .catch(() => {});
  }

  async set(patch) {
    try {
      state.settings = await call('settings:set', patch);
    } catch (err) {
      showError(err);
    }
  }

  render() {
    const s = state.settings;
    const auth = state.auth;
    clear(this.root);
    const check = (key, label) =>
      el('label.check', el('input', { type: 'checkbox', checked: !!s[key], on: { change: (e) => this.set({ [key]: e.target.checked }) } }), el('span', label));
    const number = (key, label, min, max) =>
      el(
        'label.field.inline',
        el('span', label),
        el('input', {
          type: 'number',
          min: String(min),
          max: String(max),
          value: String(s[key]),
          on: { change: (e) => this.set({ [key]: Math.max(min, Math.min(max, Number(e.target.value) || min)) }) },
        }),
      );
    const text = (key, label) =>
      el('label.field', el('span', label), el('input', { type: 'text', value: s[key] || '', on: { change: (e) => this.set({ [key]: e.target.value.trim() || s[key] }) } }));
    const section = (title, ...children) => el('section.st-section', el('h4', title), ...children);

    const account = section(
      t('st.account'),
      auth.signedIn
        ? el(
            'div.st-row',
            el('div.st-account', el('strong', (auth.account && auth.account.name) || ''), el('span.muted', (auth.account && auth.account.email) || '')),
            el('button.btn', { on: { click: async () => { await call('auth:signOut'); this.close(); } } }, el('span', { html: icon('logout') }), t('st.signOut')),
          )
        : el('div.st-row', el('button.btn.primary', { on: { click: () => { this.close(); this.hooks.onSignIn(); } } }, t('st.signIn'))),
      sourcePicker(),
      el('p.muted.small', t('st.sourcesNote')),
      el(
        'div.st-row.muted',
        el('span', `${t('st.client')}: ${auth.clientId ? `${auth.clientId.slice(0, 18)}…` : '—'}`),
        el('button.btn.small', { on: { click: () => { this.close(); this.hooks.onChangeClient(); } } }, t('ob.changeClient')),
      ),
    );

    const downloads = section(
      t('st.downloads'),
      el(
        'div.field',
        el('span', t('st.folder')),
        el(
          'div.st-row',
          el('code.path', s.downloadDir),
          el('button.btn.small', { on: { click: async () => { state.settings = await call('settings:chooseDownloadDir'); this.render(); } } }, t('st.choose')),
          el('button.btn.small', { on: { click: () => call('app:openPath', { which: 'downloads' }) } }, t('st.open')),
        ),
      ),
      check('organizeByDate', t('st.byDate')),
      check('autoDownloadVideos', t('st.autoVideo')),
      check('autoDownloadPhotos', t('st.autoPhoto')),
      el('div.st-grid', number('maxParallelDownloads', t('st.parallel'), 1, 6), number('connectionsPerDownload', t('st.connections'), 1, 16)),
    );

    const bridge = state.luaBridge;
    const resolve = section(
      t('st.resolve'),
      el('p.muted', state.mode === 'plugin' ? t('st.mode.plugin') : t('st.mode.standalone')),
      el('div.st-grid', text('binName', t('st.bin')), text('driveBinName', t('st.binDrive'))),
      check('switchToEditPage', t('st.editPage')),
      check('segmentDownloads', t('st.segments')),
      el(
        'div.st-row',
        el('span.muted.small.ffmpeg-status', '…'),
        el('button.btn.small', {
          on: {
            click: async () => {
              state.settings = await call('settings:chooseFfmpeg');
              this.render();
              this.refreshFfmpeg();
            },
          },
        }, t('st.ffmpegChoose')),
        s.ffmpegPath
          ? el('button.btn.small', {
              on: {
                click: async () => {
                  await this.set({ ffmpegPath: '' });
                  this.render();
                  this.refreshFfmpeg();
                },
              },
            }, t('st.ffmpegAuto'))
          : null,
      ),
      state.mode === 'standalone'
        ? el(
            'div.st-row',
            el('span.muted', bridge && bridge.installed ? t('st.bridgeInstalled', { path: bridge.path }) : t('st.bridgeMissing')),
            el('button.btn.small', {
              on: {
                click: async () => {
                  state.luaBridge = await call('app:installLuaBridge');
                  this.render();
                },
              },
            }, t('st.installBridge')),
          )
        : null,
    );

    const langSelect = el(
      'select',
      { on: { change: (e) => { this.set({ language: e.target.value }); this.hooks.onLanguage(e.target.value); } } },
      [['auto', t('st.lang.auto')], ['ru', 'Русский'], ['en', 'English']].map(([v, label]) => el('option', { value: v, selected: s.language === v }, label)),
    );
    const ui = section(
      t('st.ui'),
      el('label.field.inline', el('span', t('st.language')), langSelect),
      check('hoverPreview', t('st.hover')),
      check('hoverPreviewSound', t('st.hoverSound')),
      check('pinned', t('st.pinned')),
    );

    const cache = section(
      t('st.cache'),
      el(
        'div.st-row',
        el('span.cache-size.muted', '…'),
        el('button.btn.small', {
          on: {
            click: async () => {
              await call('cache:clear');
              this.open();
            },
          },
        }, t('st.clearCache')),
      ),
      number('thumbCacheMB', t('st.cacheLimit'), 100, 20000),
    );

    const about = section(
      t('st.about'),
      el('p.muted', `Cloud Pool ${state.version || ''} · ${state.platform} · Electron`),
      el(
        'div.st-row',
        el('button.btn.small', { on: { click: () => call('app:openPath', { which: 'logs' }) } }, t('st.logs')),
        el('button.btn.small', { on: { click: () => call('app:openPath', { which: 'data' }) } }, t('st.data')),
      ),
      el('p.muted.small', t('kb.list')),
    );

    const dialog = el(
      'div.dialog',
      el('div.dialog-header', el('h3', t('st.title')), el('span.flex'), el('button.icon-btn', { html: icon('x'), on: { click: () => this.close() } })),
      el('div.dialog-body', account, downloads, resolve, ui, cache, about),
    );
    this.root.append(dialog);
  }
}
