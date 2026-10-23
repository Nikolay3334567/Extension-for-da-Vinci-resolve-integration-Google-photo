'use strict';

// Sandboxed preload: exposes a minimal, promise-based API to the UI. All real work happens in
// the main process.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cloudpool', {
  // Resolves with { ok, value } or { ok: false, message, code } — error objects lose their
  // custom fields when crossing the context bridge, so the UI turns these into exceptions.
  invoke(channel, payload) {
    return ipcRenderer.invoke('cp:invoke', channel, payload);
  },
  onEvent(handler) {
    const listener = (_e, ev) => handler(ev);
    ipcRenderer.on('cp:event', listener);
    return () => ipcRenderer.removeListener('cp:event', listener);
  },
  startDrag(keys) {
    ipcRenderer.send('cp:drag', keys);
  },
});
