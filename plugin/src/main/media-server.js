'use strict';

// Loopback HTTP server that feeds the UI with thumbnails and video.
//  • /thumb/<key>?s=<px>  — cached, Google-rendered thumbnails
//  • /stream/<key>        — the local file once downloaded, otherwise a Range-preserving proxy
//                           to Google (adding the OAuth header), so <video> can start playing
//                           and seek instantly, exactly like Google Photos' own player.
// Every URL carries a random secret and the Host header is checked, so other local software
// or web pages cannot use the server.

const fs = require('fs');
const http = require('http');
const { randomToken, isAbortError, mimeForFile, abortError } = require('./util');
const { sniffImageType } = require('./thumbs');
const { parseContentRange, isTransientError } = require('./http');

const FIRST_CHUNK = 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

class MediaServer {
  /**
   * @param {object} opts
   * @param {(key: string) => Promise<object>} opts.resolveItem
   * @param {(key: string) => string|null} opts.localFile        path of a finished download
   * @param {import('./thumbs').ThumbCache} opts.thumbs
   * @param {(item: object, opts: object) => Promise<import('http').IncomingMessage>} opts.openStream
   */
  constructor({ resolveItem, localFile, thumbs, openStream, logger = console }) {
    this.resolveItem = resolveItem;
    this.localFile = localFile;
    this.thumbs = thumbs;
    this.openStream = openStream;
    this.logger = logger;
    this.token = randomToken(18);
    this.server = null;
    this.port = 0;
  }

  get base() {
    return `http://127.0.0.1:${this.port}/${this.token}`;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.keepAliveTimeout = 30000;
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.base);
      });
    });
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
    this.server = null;
  }

  _send(res, status, text) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  async _handle(req, res) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      this._send(res, 403, 'Forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this._send(res, 405, 'Method not allowed');
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    const parts = url.pathname.split('/');
    // ['', token, route, key]
    if (parts[1] !== this.token) {
      this._send(res, 403, 'Forbidden');
      return;
    }
    const route = parts[2];
    if (route === 'ping') {
      this._send(res, 200, 'ok');
      return;
    }
    let key;
    try {
      key = decodeURIComponent(parts.slice(3).join('/'));
    } catch {
      this._send(res, 400, 'Bad key');
      return;
    }
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      if (route === 'thumb') await this._thumb(req, res, key, Number(url.searchParams.get('s')) || 256, controller.signal);
      else if (route === 'stream') await this._stream(req, res, key, controller.signal);
      else this._send(res, 404, 'Not found');
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        if (!res.headersSent) res.destroy();
        return;
      }
      const status = err.code === 'PHOTOS_EXPIRED' ? 410 : err.code === 'AUTH_REQUIRED' ? 401 : err.status && err.status >= 400 ? err.status : 502;
      if (status >= 500) this.logger.warn(`[media] ${route} ${key}: ${err.message}`);
      this._send(res, status, err.message || 'Error');
    }
  }

  async _thumb(req, res, key, size, signal) {
    let hit;
    try {
      hit = await this.thumbs.get(await this.resolveItem(key), size, signal);
    } catch (err) {
      // Offline, signed out or the item left the library: a cached thumbnail is still useful.
      hit = !isAbortError(err) && (await this.thumbs.getCached(key, size));
      if (!hit) throw err;
    }
    const { file } = hit;
    const buf = await fs.promises.readFile(file);
    if (signal.aborted) return;
    res.writeHead(200, {
      'Content-Type': sniffImageType(buf),
      'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=600',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  async _stream(req, res, key, signal) {
    const local = this.localFile(key);
    if (local && fs.existsSync(local)) {
      this._serveFile(req, res, local);
      return;
    }
    const item = await this.resolveItem(key);
    const open = /^bytes=(\d+)-$/.exec(String(req.headers.range || 'bytes=0-').trim());
    if (open && req.method === 'GET') {
      await this._streamChunked(res, item, Number(open[1]), signal, !!req.headers.range);
      return;
    }
    const upstream = await this.openStream(item, { range: req.headers.range || null, signal });
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    for (const h of PASS_HEADERS) if (upstream.headers[h]) headers[h] = upstream.headers[h];
    if (!headers['content-type'] || /octet-stream/.test(headers['content-type'])) headers['content-type'] = item.mimeType;
    res.writeHead(upstream.statusCode, headers);
    if (req.method === 'HEAD') {
      upstream.destroy();
      res.end();
      return;
    }
    upstream.on('error', () => res.destroy());
    upstream.pipe(res);
  }

  /**
   * Players and ffmpeg ask for "bytes=N-" and simply hang up when they seek. Passing that on to
   * Google would keep pulling data nobody reads, so the response is assembled from upstream
   * chunks that grow (1 MB → 16 MB) while the client keeps reading; a seek wastes at most one.
   */
  async _streamChunked(res, item, start, signal, partial) {
    // Nothing of a chunk has been sent when it is opened, so a reused keep-alive socket that
    // Google already closed (ECONNRESET) is simply retried instead of breaking playback.
    const open = async (from, to) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.openStream(item, { range: `bytes=${from}-${to}`, signal });
        } catch (err) {
          if (attempt >= 2 || signal.aborted || !isTransientError(err)) throw err;
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    };
    let chunk = FIRST_CHUNK;
    let upstream = await open(start, start + chunk - 1);
    const cr = parseContentRange(upstream.headers['content-range']);
    if (upstream.statusCode !== 206 || !cr || cr.total == null || cr.start !== start) {
      // The source ignores ranges (or answered differently): pass it through untouched.
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      for (const h of PASS_HEADERS) if (upstream.headers[h]) headers[h] = upstream.headers[h];
      if (!headers['content-type'] || /octet-stream/.test(headers['content-type'])) headers['content-type'] = item.mimeType;
      res.writeHead(upstream.statusCode, headers);
      upstream.on('error', () => res.destroy());
      upstream.pipe(res);
      return;
    }
    const total = cr.total;
    let type = upstream.headers['content-type'];
    if (!type || /octet-stream/.test(type)) type = item.mimeType;
    const headers = {
      'Content-Type': type,
      'Content-Length': total - start,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${total - 1}/${total}`;
    res.writeHead(partial ? 206 : 200, headers);
    const pump = (src, expected) =>
      new Promise((resolve, reject) => {
        let got = 0;
        const onData = (d) => {
          got += d.length;
        };
        const cleanup = () => {
          res.off('close', onClose);
          src.off('data', onData);
          src.off('end', onEnd);
          src.off('error', onError);
        };
        const onClose = () => {
          cleanup();
          src.destroy();
          reject(abortError());
        };
        const onEnd = () => {
          cleanup();
          // A short chunk must not shift the rest of the file: break the response instead.
          if (got === expected) resolve();
          else reject(new Error(`upstream chunk ended after ${got} of ${expected} bytes`));
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        res.on('close', onClose);
        src.on('end', onEnd);
        src.on('error', onError);
        src.pipe(res, { end: false });
        src.on('data', onData);
      });
    let pos = start;
    for (;;) {
      const range = parseContentRange(upstream.headers['content-range']);
      if (upstream.statusCode !== 206 || !range || range.start !== pos) {
        upstream.destroy();
        res.destroy();
        return;
      }
      await pump(upstream, range.end - range.start + 1);
      pos = range.end + 1;
      if (pos >= total || signal.aborted) break;
      chunk = Math.min(MAX_CHUNK, chunk * 2);
      upstream = await open(pos, Math.min(total, pos + chunk) - 1);
    }
    res.end();
  }

  _serveFile(req, res, file) {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      this._send(res, 404, 'Missing file');
      return;
    }
    const headers = {
      'Content-Type': mimeForFile(file),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (req.headers.range) {
      const r = parseRange(req.headers.range, size);
      if (!r) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      ({ start, end } = r);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

module.exports = { MediaServer, parseRange };
