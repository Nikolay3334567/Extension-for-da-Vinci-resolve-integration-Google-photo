'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function abortError(message = 'Aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 24) {
  return base64url(crypto.randomBytes(bytes));
}

function sha1(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

/** Parses a protobuf Duration string such as "3.5s" into milliseconds. */
function parseGoogleDuration(value, fallbackMs) {
  if (typeof value !== 'string') return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m ? Math.round(parseFloat(m[1]) * 1000) : fallbackMs;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Makes a cloud file name safe for every desktop file system while keeping it recognisable. */
function sanitizeFilename(name, fallback = 'file') {
  let out = String(name || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (!out) out = fallback;
  const ext = path.extname(out);
  const stem = out.slice(0, out.length - ext.length);
  if (WINDOWS_RESERVED.test(stem)) out = `_${out}`;
  // Keep well below the 255-byte limit of most file systems.
  while (Buffer.byteLength(out, 'utf8') > 180) {
    const e = path.extname(out);
    const s = out.slice(0, out.length - e.length);
    out = s.slice(0, Math.max(1, s.length - 8)) + e;
  }
  return out;
}

/**
 * Returns a path in `dir` that does not exist yet and is not reserved, appending " (2)", " (3)"...
 * `reserved` is a Set of absolute paths that other in-flight jobs intend to use.
 */
function uniquePath(dir, fileName, reserved = new Set()) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, i === 1 ? fileName : `${stem} (${i})${ext}`);
    if (!reserved.has(candidate) && !fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${randomToken(4)}${ext}`);
}

const MIME_EXT = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/3gpp': '.3gp',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpg',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tif',
  'image/x-adobe-dng': '.dng',
};

const EXT_MIME = Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m]));
Object.assign(EXT_MIME, { '.jpeg': 'image/jpeg', '.m4v': 'video/mp4', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.dng': 'image/x-adobe-dng' });

function extForMime(mime) {
  return MIME_EXT[String(mime || '').toLowerCase()] || '';
}

function mimeForFile(file) {
  return EXT_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Ensures `name` carries the extension implied by `mime` (Google sometimes omits it). */
function withExtension(name, mime) {
  const ext = extForMime(mime);
  if (!ext) return name;
  const current = path.extname(name).toLowerCase();
  if (current === ext || (ext === '.jpg' && current === '.jpeg') || (ext === '.mp4' && current === '.m4v')) return name;
  if (current && EXT_MIME[current] && EXT_MIME[current].split('/')[0] === mime.split('/')[0]) return name;
  return name + ext;
}

/** Runs async tasks one after another; `run(fn)` resolves with fn's result. */
class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(fn) {
    const result = this.tail.then(() => fn());
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  return function throttled(...args) {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn.apply(this, args);
    } else {
      pendingArgs = args;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          const a = pendingArgs;
          pendingArgs = null;
          fn.apply(this, a);
        }, wait);
      }
    }
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  abortError,
  isAbortError,
  sleep,
  base64url,
  randomToken,
  sha1,
  parseGoogleDuration,
  sanitizeFilename,
  uniquePath,
  extForMime,
  mimeForFile,
  withExtension,
  SerialQueue,
  throttle,
  clamp,
};
