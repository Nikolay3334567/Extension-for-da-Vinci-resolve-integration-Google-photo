'use strict';

// Renders the app icons (plugin/ui/img/*.png) from SVG with Electron. Run: npx electron scripts/build-icons.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8ef7"/><stop offset="1" stop-color="#7c5cf0"/></linearGradient></defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <path d="M78 178h104a40 40 0 0 0 5-79.7A54 54 0 0 0 82 104a36 36 0 0 0-4 74z" fill="#fff"/>
  <path d="M112 128v38l30-19z" fill="#5b74f3"/>
</svg>`;

const out = path.join(__dirname, '..', 'plugin', 'ui', 'img');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const size = 256;
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`)}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size });
  fs.writeFileSync(path.join(out, 'icon.png'), img.toPNG());
  fs.writeFileSync(path.join(out, 'drag.png'), img.resize({ width: 96, height: 96, quality: 'best' }).toPNG());
  win.destroy();
  app.quit();
});
