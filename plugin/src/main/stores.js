'use strict';

const fs = require('fs');
const path = require('path');

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows can briefly lock the destination (antivirus, indexer).
      if (attempt >= 4 || (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES')) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err;
      }
      // Short synchronous back-off; only happens on Windows lock contention.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
}

/** A JSON document persisted with debounced atomic writes. */
class JsonStore {
  constructor(file, defaults = {}, { debounceMs = 400 } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.data = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...structuredClone(this.defaults), ...parsed };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.saveSoon();
  }

  update(fn) {
    fn(this.data);
    this.saveSoon();
  }

  saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      writeFileAtomic(this.file, JSON.stringify(this.data));
    } catch (err) {
      // Persisting state must never crash the app; the next write will retry.
      console.error(`[store] failed to write ${this.file}: ${err.message}`);
    }
  }
}

/**
 * Stores a small JSON secret encrypted with the OS keychain (Electron safeStorage) when available.
 * `cipher` = { available: boolean, encrypt(string) -> Buffer, decrypt(Buffer) -> string }.
 */
class SecureStore {
  constructor(file, cipher) {
    this.file = file;
    this.cipher = cipher;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      return null;
    }
    try {
      if (raw[0] === 0x7b /* "{" */) return JSON.parse(raw.toString('utf8'));
      if (!this.cipher || !this.cipher.available) return null;
      return JSON.parse(this.cipher.decrypt(raw));
    } catch {
      return null;
    }
  }

  save(value) {
    const json = JSON.stringify(value);
    if (this.cipher && this.cipher.available) writeFileAtomic(this.file, this.cipher.encrypt(json), 0o600);
    else writeFileAtomic(this.file, json, 0o600);
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { JsonStore, SecureStore, writeFileAtomic };
