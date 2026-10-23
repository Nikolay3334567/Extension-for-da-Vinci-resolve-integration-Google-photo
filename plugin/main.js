'use strict';

// Electron main process. Runs in two ways:
//  • as a DaVinci Resolve Studio Workflow Integration (Workspace ▸ Workflow Integrations ▸
//    Cloud Pool) — Resolve launches this file with its bundled Electron and WorkflowIntegration.node
//    sits next to it;
//  • as a standalone app (`npm start`), e.g. for the free edition of Resolve, which is driven
//    through the "Cloud Pool" bridge script and native drag & drop.

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeImage, Menu, session, screen, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

const { APP_NAME, DATA_DIR_NAME } = require('./src/main/config');
const { createLogger } = require('./src/main/logger');
const { request, readBody } = require('./src/main/http');
const { splitKey } = require('./src/main/items');
const { installLuaBridge, shortPath } = require('./src/main/lua-install');

const userData = process.env.CLOUDPOOL_USER_DATA || path.join(app.getPath('appData'), DATA_DIR_NAME);
app.setPath('userData', userData);
app.setName(APP_NAME);

const logger = createLogger(path.join(userData, 'logs'));
let core = null;
let win = null;
let statusTimer = null;
let luaBridge = null;

process.on('uncaughtException', (err) => logger.error('uncaught', err));
process.on('unhandledRejection', (err) => logger.error('unhandled rejection', err));

function language() {
  const setting = core && core.settings.language;
  if (setting && setting !== 'auto') return setting;
  return /^(ru|uk|be|kk)/i.test(app.getLocale() || '') ? 'ru' : 'en';
}

async function openExternal(url) {
  if (process.env.CLOUDPOOL_TEST_BROWSER === 'fetch') {
    // End-to-end tests: behave like a browser that is already signed in and consents.
    const res = await request(url, { maxRedirects: 10 });
    await readBody(res);
    return;
  }
  await shell.openExternal(url);
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function safeBounds(saved) {
  if (!saved) return {};
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 80 && saved.x + saved.width > a.x + 80 && saved.y < a.y + a.height - 80 && saved.y + saved.height > a.y;
  });
  return visible ? saved : { width: saved.width, height: saved.height };
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const saved = safeBounds(core.settings.window);
  win = new BrowserWindow({
    width: saved.width || 1320,
    height: saved.height || 840,
    x: saved.x,
    y: saved.y,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: 'Cloud Pool — Google Photos & Drive',
    backgroundColor: '#141518',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', 'img', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (core.settings.pinned) win.setAlwaysOnTop(true, 'floating');
  win.once('ready-to-show', () => win.show());
  win.on('focus', () => core.photos.pollNow());
  const saveBounds = () => {
    if (!win || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    core.updateSettings({ window: win.getBounds() });
  };
  let boundsTimer = null;
  const saveSoon = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 500);
  };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
    // A Workflow Integration must exit when its window closes (otherwise Resolve keeps the
    // process — and the files of the plugin — locked).
    app.quit();
  });

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) e.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

function dragIcon(key) {
  const file = core.thumbs.peekFile(key);
  if (file) {
    try {
      const img = nativeImage.createFromBuffer(fs.readFileSync(file));
      if (!img.isEmpty()) return img.resize({ width: 112 });
    } catch {
      /* fall through */
    }
  }
  return nativeImage.createFromPath(path.join(__dirname, 'ui', 'img', 'drag.png'));
}

function registerIpc() {
  const handlers = {
    'app:init': () => ({
      ...core.snapshot(),
      version: app.getVersion(),
      platform: process.platform,
      language: language(),
      dataDir: userData,
      logFile: logger.file,
      luaBridge,
    }),
    'app:openExternal': ({ url }) => {
      if (!/^https:\/\//i.test(String(url))) throw new Error('Only https links can be opened');
      return shell.openExternal(url);
    },
    'app:openPath': ({ which }) => {
      const target = which === 'downloads' ? core.settings.downloadDir : which === 'logs' ? logger.dir : userData;
      fs.mkdirSync(target, { recursive: true });
      return shell.openPath(target);
    },
    'app:installLuaBridge': () => {
      luaBridge = installLuaBridge(path.join(__dirname, 'resolve', 'Cloud Pool.lua'), { force: true });
      return luaBridge;
    },
    'auth:setClient': ({ config }) => core.auth.setClient(config),
    'auth:pickClientFile': async () => {
      const r = await dialog.showOpenDialog(win, { title: 'client_secret….json', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
      if (r.canceled || !r.filePaths[0]) return core.auth.snapshot();
      return core.auth.setClient(fs.readFileSync(r.filePaths[0], 'utf8'));
    },
    'auth:signIn': async () => {
      const snap = await core.auth.signIn({ sources: core.settings.sources });
      focusWindow();
      return snap;
    },
    'auth:cancelSignIn': () => core.auth.cancelSignIn(),
    'auth:signOut': () => core.auth.signOut(),
    'photos:list': () => core.listPhotos(),
    'photos:pick': () => core.photos.startPicking(),
    'photos:cancelPick': () => core.photos.cancelPicking(),
    'photos:reopenPicker': () => core.photos.reopenPicker(),
    'photos:remove': ({ keys }) => core.photos.remove(keys.map((k) => splitKey(k).id)),
    'drive:list': (params) => core.listDrive(params),
    'drive:breadcrumbs': ({ folderId }) => core.drive.folderPath(folderId),
    'local:list': () => core.listLocal(),
    'local:delete': ({ keys }) => core.deleteLocal(keys),
    'local:reveal': ({ key }) => {
      const p = core.localPath(key);
      if (p && fs.existsSync(p)) shell.showItemInFolder(p);
      else shell.openPath(core.settings.downloadDir);
    },
    'local:copyPath': ({ key }) => {
      const p = core.localPath(key);
      if (p) clipboard.writeText(p);
      return !!p;
    },
    'items:probe': ({ keys }) => core.probe(keys),
    'downloads:start': ({ keys, urgent }) => core.startDownloads(keys, { urgent: !!urgent }),
    'downloads:pause': ({ keys }) => keys.forEach((k) => core.downloads.pause(k)),
    'downloads:resume': ({ keys }) => keys.forEach((k) => core.downloads.resume(k)),
    'downloads:cancel': ({ keys }) => Promise.all(keys.map((k) => core.downloads.cancel(k))),
    'downloads:clearFinished': () => {
      core.downloads.clearFinished();
      core.jobs.clearFinished();
    },
    'resolve:status': () => core.refreshResolveStatus(),
    'resolve:send': (req) => core.sendToResolve(req),
    'resolve:cancelJob': ({ id }) => core.jobs.cancel(id),
    'settings:set': (patch) => {
      const s = core.updateSettings(patch);
      if (win && patch && 'pinned' in patch) win.setAlwaysOnTop(!!s.pinned, 'floating');
      return s;
    },
    'settings:chooseDownloadDir': async () => {
      const r = await dialog.showOpenDialog(win, { defaultPath: core.settings.downloadDir, properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return core.settings;
      return core.updateSettings({ downloadDir: r.filePaths[0] });
    },
    'cache:stats': () => core.cacheStats(),
    'cache:clear': () => core.clearCache(),
  };

  ipcMain.handle('cp:invoke', async (event, channel, payload) => {
    const fn = handlers[channel];
    if (!fn || event.sender !== (win && win.webContents)) return { ok: false, message: 'Unknown request', code: 'BAD_CHANNEL' };
    try {
      const value = await fn(payload || {});
      return { ok: true, value: value === undefined ? null : value };
    } catch (err) {
      if (err && err.code !== 'AUTH_REQUIRED' && err.code !== 'PHOTOS_EXPIRED') logger.warn(`[ipc] ${channel}: ${err.message}`);
      return { ok: false, message: err ? err.message : 'Error', code: (err && err.code) || null, status: (err && err.status) || null };
    }
  });

  ipcMain.on('cp:drag', (event, keys) => {
    const files = (Array.isArray(keys) ? keys : [])
      .map((k) => core.localPath(k))
      .filter((p) => p && fs.existsSync(p));
    if (!files.length) return;
    event.sender.startDrag({ file: files[0], files, icon: dragIcon(keys[0]) });
  });
}

function startStatusPolling() {
  const tick = async () => {
    if (!win || win.isMinimized()) return;
    try {
      await core.refreshResolveStatus();
    } catch (err) {
      logger.warn(`[resolve] status: ${err.message}`);
    }
  };
  tick();
  statusTimer = setInterval(tick, core.isPlugin ? 3000 : 2000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusWindow);

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'fullscreen'));
    buildMenu();
    const { CloudPoolCore } = require('./src/main/core');
    core = new CloudPoolCore({
      userData,
      pluginDir: __dirname,
      defaultDownloadDir: path.join(app.getPath('videos'), 'Cloud Pool'),
      cipher: {
        get available() {
          try {
            return safeStorage.isEncryptionAvailable();
          } catch {
            return false;
          }
        },
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (buf) => safeStorage.decryptString(buf),
      },
      openExternal,
      getLanguage: language,
      logger,
    });
    await core.start();
    logger.info(`[app] started (${core.isPlugin ? 'Workflow Integration' : 'standalone'}) v${app.getVersion()} electron ${process.versions.electron}`);
    registerIpc();
    core.on('event', (ev) => {
      if (win && !win.isDestroyed()) win.webContents.send('cp:event', ev);
    });
    core.on('resolve-quit', () => app.quit());
    // The user just pressed "Done" in the browser: bring Cloud Pool back to the front.
    core.photos.on('picked', () => focusWindow());
    if (!core.isPlugin) {
      const exe = shortPath(process.execPath);
      core.mailbox.writeLaunchInfo(exe, app.isPackaged ? [] : [shortPath(app.getAppPath())]);
      luaBridge = installLuaBridge(path.join(__dirname, 'resolve', 'Cloud Pool.lua'));
    }
    createWindow();
    startStatusPolling();
  });

  app.on('before-quit', () => {
    clearInterval(statusTimer);
    if (core) {
      try {
        core.shutdown();
      } catch (err) {
        logger.error('shutdown', err);
      }
    }
    // Never linger: Resolve waits for plugin processes to exit.
    setTimeout(() => app.exit(0), 4000).unref();
  });

  app.on('window-all-closed', () => app.quit());
}
