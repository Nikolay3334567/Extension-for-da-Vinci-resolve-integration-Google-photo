'use strict';

// A small in-process imitation of the Google endpoints the plugin uses: OAuth (auth + token +
// revoke), the Photos Picker API, Drive v3 and the media hosts (Range-capable). It lets the
// unit tests and the Electron end-to-end test exercise real HTTP flows without a Google account.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const { Transform } = require('stream');
const { URL } = require('url');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(claims) {
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

class FakeGoogle {
  /**
   * @param {object} fixtures
   *   photos: [{ id, filename, mimeType, type: 'VIDEO'|'PHOTO', createTime, width, height, fps, file, thumb, processing }]
   *   drive:  [{ id, name, mimeType, createdTime, parents, file, thumb, durationMillis, width, height, md5, shared }]
   */
  constructor(fixtures = {}, options = {}) {
    this.fixtures = { photos: fixtures.photos || [], drive: fixtures.drive || [] };
    this.options = {
      autoPick: true, // visiting the picker URI immediately "selects" the items
      pickIds: null, // subset of photo ids to pick (null = all)
      baseUrlTtlMs: 60 * 60 * 1000,
      accessTokenTtlS: 3600,
      redirectMedia: false, // 302 media through a second URL (like googleusercontent CDNs)
      throttleBytesPerSec: 0, // per connection
      rangeSupport: true,
      ...options,
    };
    this.codes = new Map();
    this.accessTokens = new Map(); // token -> expiresAt
    this.refreshTokens = new Set();
    this.sessions = new Map();
    this.faults = []; // { match: RegExp, status, times, body }
    this.log = [];
    this.connections = 0;
    this.peakConnections = 0;
    this.server = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('connection', (socket) => {
      socket.on('close', () => {});
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    // Let the plugin's HTTP client send bearer tokens to this fake host.
    require('../../plugin/src/main/http').trustHost(new URL(this.base).host);
    return this.base;
  }

  stop() {
    if (!this.server) return Promise.resolve();
    if (this.server.closeAllConnections) this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Make the next `times` requests whose path matches `match` fail with `status`. */
  fail(match, status, times = 1, body = null) {
    this.faults.push({ match, status, times, body });
  }

  /** Invalidates every access token (simulates expiry → 401). */
  expireAccessTokens() {
    this.accessTokens.clear();
  }

  revokeRefreshTokens() {
    this.refreshTokens.clear();
  }

  requests(match) {
    return this.log.filter((r) => match.test(r.path));
  }

  _issueAccess() {
    const token = `at-${crypto.randomBytes(9).toString('hex')}`;
    this.accessTokens.set(token, Date.now() + this.options.accessTokenTtlS * 1000);
    return token;
  }

  _authorized(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const exp = this.accessTokens.get(m[1]);
    return !!exp && exp > Date.now();
  }

  _json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  _error(res, status, message, reason) {
    this._json(res, status, { error: { code: status, message, status: reason || 'ERROR' } });
  }

  async _body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  async _handle(req, res) {
    this.connections++;
    this.peakConnections = Math.max(this.peakConnections, this.connections);
    res.on('close', () => this.connections--);
    const url = new URL(req.url, this.base);
    const entry = { method: req.method, path: url.pathname, query: url.search, range: req.headers.range || null, auth: req.headers.authorization || null };
    this.log.push(entry);

    const fault = this.faults.find((f) => f.match.test(url.pathname + url.search) && f.times > 0);
    if (fault) {
      fault.times--;
      if (fault.status === 'drop') {
        req.socket.destroy();
        return;
      }
      if (fault.body) this._json(res, fault.status, fault.body);
      else this._error(res, fault.status, `Injected ${fault.status}`);
      return;
    }

    try {
      const p = url.pathname;
      if (p === '/o/oauth2/v2/auth') return this._authorize(url, res);
      if (p === '/token' && req.method === 'POST') return this._token(await this._body(req), res);
      if (p === '/revoke') {
        const body = new URLSearchParams(await this._body(req));
        this.refreshTokens.delete(body.get('token'));
        return this._json(res, 200, {});
      }
      if (p.startsWith('/picker-ui/')) return this._pickerUi(p, res);
      if (p.startsWith('/picker/v1/')) {
        if (!this._authorized(req)) return this._error(res, 401, 'Invalid Credentials', 'UNAUTHENTICATED');
        return this._picker(req, url, res);
      }
      if (p.startsWith('/drive/v3/')) {
        if (!this._authorized(req)) return this._error(res, 401, 'Invalid Credentials', 'UNAUTHENTICATED');
        return this._drive(req, url, res);
      }
      if (p.startsWith('/media/photos/')) {
        if (!this._authorized(req)) return this._error(res, 401, 'Unauthorized');
        return this._photosMedia(req, url, res);
      }
      if (p.startsWith('/cdn/')) return this._cdn(req, url, res);
      if (p.startsWith('/drive-thumb/')) {
        if (!this._authorized(req)) return this._error(res, 401, 'Unauthorized');
        const m = /^\/drive-thumb\/([^=]+)=s(\d+)$/.exec(p);
        const f = m && this.fixtures.drive.find((d) => d.id === m[1]);
        if (!f || !f.thumb) return this._error(res, 404, 'No thumbnail');
        return this._sendFile(req, res, f.thumb, 'image/jpeg', false);
      }
      this._error(res, 404, 'Not found');
    } catch (err) {
      this._error(res, 500, err.message);
    }
  }

  _authorize(url, res) {
    const redirect = url.searchParams.get('redirect_uri');
    const code = `code-${crypto.randomBytes(6).toString('hex')}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge'),
      redirect,
      scope: url.searchParams.get('scope'),
      clientId: url.searchParams.get('client_id'),
    });
    const target = new URL(redirect);
    target.searchParams.set('code', code);
    target.searchParams.set('state', url.searchParams.get('state'));
    target.searchParams.set('scope', url.searchParams.get('scope'));
    res.writeHead(302, { Location: target.href });
    res.end();
  }

  _token(raw, res) {
    const body = new URLSearchParams(raw);
    const grant = body.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = this.codes.get(body.get('code'));
      if (!entry) return this._json(res, 400, { error: 'invalid_grant', error_description: 'Bad code' });
      this.codes.delete(body.get('code'));
      const challenge = b64url(crypto.createHash('sha256').update(body.get('code_verifier') || '').digest());
      if (challenge !== entry.challenge) return this._json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
      if (body.get('redirect_uri') !== entry.redirect) return this._json(res, 400, { error: 'redirect_uri_mismatch' });
      const refresh = `rt-${crypto.randomBytes(9).toString('hex')}`;
      this.refreshTokens.add(refresh);
      return this._json(res, 200, {
        access_token: this._issueAccess(),
        expires_in: this.options.accessTokenTtlS,
        refresh_token: refresh,
        scope: entry.scope,
        token_type: 'Bearer',
        id_token: fakeJwt({ email: 'editor@example.com', name: 'Test Editor', picture: '' }),
      });
    }
    if (grant === 'refresh_token') {
      if (!this.refreshTokens.has(body.get('refresh_token'))) {
        return this._json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      return this._json(res, 200, { access_token: this._issueAccess(), expires_in: this.options.accessTokenTtlS, token_type: 'Bearer' });
    }
    return this._json(res, 400, { error: 'unsupported_grant_type' });
  }

  // ── Picker ──

  _pickerUi(p, res) {
    const id = p.split('/')[2];
    const s = this.sessions.get(id);
    if (!s) return this._error(res, 404, 'No session');
    if (this.options.autoPick) {
      const ids = this.options.pickIds || this.fixtures.photos.map((x) => x.id);
      s.picked = ids;
      s.mediaItemsSet = true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Picked</body></html>');
  }

  _sessionJson(s) {
    return {
      id: s.id,
      pickerUri: `${this.base}/picker-ui/${s.id}`,
      pollingConfig: s.mediaItemsSet ? undefined : { pollInterval: '0.2s', timeoutIn: '600s' },
      expireTime: new Date(s.expireAt).toISOString(),
      mediaItemsSet: !!s.mediaItemsSet,
    };
  }

  async _picker(req, url, res) {
    const p = url.pathname.replace('/picker/v1', '');
    if (p === '/sessions' && req.method === 'POST') {
      const raw = await this._body(req);
      const id = `s-${crypto.randomBytes(5).toString('hex')}`;
      const s = { id, createdAt: Date.now(), expireAt: Date.now() + 60 * 60 * 1000, mediaItemsSet: false, picked: [], config: raw ? JSON.parse(raw) : {} };
      this.sessions.set(id, s);
      return this._json(res, 200, this._sessionJson(s));
    }
    const sm = /^\/sessions\/([^/]+)$/.exec(p);
    if (sm) {
      const s = this.sessions.get(decodeURIComponent(sm[1]));
      if (!s) return this._error(res, 404, 'Session not found', 'NOT_FOUND');
      if (req.method === 'DELETE') {
        this.sessions.delete(s.id);
        return this._json(res, 200, {});
      }
      return this._json(res, 200, this._sessionJson(s));
    }
    if (p === '/mediaItems') {
      const s = this.sessions.get(url.searchParams.get('sessionId'));
      if (!s) return this._error(res, 404, 'Session not found', 'NOT_FOUND');
      if (!s.mediaItemsSet) return this._error(res, 400, 'User has not picked yet', 'FAILED_PRECONDITION');
      const pageSize = Number(url.searchParams.get('pageSize')) || 25;
      const offset = Number(url.searchParams.get('pageToken')) || 0;
      const ids = s.picked.slice(offset, offset + pageSize);
      const now = Date.now();
      const mediaItems = ids.map((id) => {
        const f = this.fixtures.photos.find((x) => x.id === id);
        return {
          id: f.id,
          createTime: f.createTime,
          type: f.type,
          mediaFile: {
            baseUrl: `${this.base}/media/photos/${encodeURIComponent(f.id)}/${s.id}~${now}`,
            mimeType: f.mimeType,
            filename: f.filename,
            mediaFileMetadata: {
              width: f.width,
              height: f.height,
              cameraMake: f.cameraMake,
              cameraModel: f.cameraModel,
              ...(f.type === 'VIDEO' ? { videoMetadata: { fps: f.fps, processingStatus: f.processing || 'READY' } } : { photoMetadata: {} }),
            },
          },
        };
      });
      const next = offset + pageSize < s.picked.length ? String(offset + pageSize) : undefined;
      return this._json(res, 200, { mediaItems, nextPageToken: next });
    }
    return this._error(res, 404, 'Unknown picker route');
  }

  _photosMedia(req, url, res) {
    // /media/photos/<id>/<session>~<issuedAt>=<params>
    const m = /^\/media\/photos\/([^/]+)\/([^~]+)~(\d+)=(.+)$/.exec(url.pathname);
    if (!m) return this._error(res, 400, 'Bad media URL');
    const f = this.fixtures.photos.find((x) => x.id === decodeURIComponent(m[1]));
    if (!f) return this._error(res, 404, 'Unknown item');
    if (Date.now() - Number(m[3]) > this.options.baseUrlTtlMs) return this._error(res, 403, 'URL expired');
    const params = m[4];
    if (params === 'dv') {
      if (f.processing === 'PROCESSING') return this._error(res, 404, 'Not ready');
      if (this.options.redirectMedia) {
        res.writeHead(302, { Location: `${this.base}/cdn/${encodeURIComponent(f.id)}?k=${crypto.randomBytes(4).toString('hex')}` });
        res.end();
        return;
      }
      return this._sendFile(req, res, f.file, 'video/mp4', true);
    }
    if (params === 'd') return this._sendFile(req, res, f.file, f.mimeType, true);
    if (/^w\d+-h\d+/.test(params)) return this._sendFile(req, res, f.thumb, 'image/jpeg', false);
    return this._error(res, 400, 'Unknown params');
  }

  _cdn(req, url, res) {
    const id = decodeURIComponent(url.pathname.split('/')[2]);
    const f = this.fixtures.photos.find((x) => x.id === id);
    if (!f) return this._error(res, 404, 'Unknown');
    return this._sendFile(req, res, f.file, 'video/mp4', true);
  }

  // ── Drive ──

  _driveJson(f) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.file ? String(fs.statSync(f.file).size) : undefined,
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime || f.createdTime,
      parents: f.parents || ['root'],
      md5Checksum: f.md5,
      thumbnailLink: f.thumb ? `${this.base}/drive-thumb/${f.id}=s220` : undefined,
      videoMediaMetadata: f.mimeType.startsWith('video/') ? { width: f.width, height: f.height, durationMillis: f.durationMillis ? String(f.durationMillis) : undefined } : undefined,
      imageMediaMetadata: f.mimeType.startsWith('image/') ? { width: f.width, height: f.height } : undefined,
    };
  }

  _drive(req, url, res) {
    const p = url.pathname.replace('/drive/v3', '');
    if (p === '/files') {
      const q = url.searchParams.get('q') || '';
      let files = this.fixtures.drive.slice();
      const wantVideo = q.includes("mimeType contains 'video/'");
      const wantImage = q.includes("mimeType contains 'image/'");
      const wantFolder = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      files = files.filter((f) => {
        const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
        if (isFolder) return wantFolder;
        if (f.mimeType.startsWith('video/')) return wantVideo;
        if (f.mimeType.startsWith('image/')) return wantImage;
        return false;
      });
      const parent = /'([^']+)' in parents/.exec(q);
      if (parent) files = files.filter((f) => (f.parents || ['root']).includes(parent[1]));
      if (q.includes('sharedWithMe = true')) files = files.filter((f) => f.shared);
      const name = /name contains '((?:[^'\\]|\\.)*)'/.exec(q);
      if (name) {
        const needle = name[1].replace(/\\(.)/g, '$1').toLowerCase();
        files = files.filter((f) => f.name.toLowerCase().includes(needle));
      }
      const order = url.searchParams.get('orderBy') || '';
      if (order.includes('createdTime desc')) files.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
      else if (order.includes('createdTime')) files.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      const pageSize = Number(url.searchParams.get('pageSize')) || 100;
      const offset = Number(url.searchParams.get('pageToken')) || 0;
      const page = files.slice(offset, offset + pageSize).map((f) => this._driveJson(f));
      return this._json(res, 200, { files: page, nextPageToken: offset + pageSize < files.length ? String(offset + pageSize) : undefined });
    }
    const fm = /^\/files\/([^/]+)$/.exec(p);
    if (fm) {
      const f = this.fixtures.drive.find((x) => x.id === decodeURIComponent(fm[1]));
      if (!f) return this._error(res, 404, 'File not found', 'notFound');
      if (url.searchParams.get('alt') === 'media') return this._sendFile(req, res, f.file, f.mimeType, true);
      return this._json(res, 200, this._driveJson(f));
    }
    return this._error(res, 404, 'Unknown drive route');
  }

  // ── Bytes ──

  _sendFile(req, res, file, type, allowRange) {
    const size = fs.statSync(file).size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers = { 'Content-Type': type };
    const rangeHeader = req.headers.range;
    if (allowRange && this.options.rangeSupport) {
      headers['Accept-Ranges'] = 'bytes';
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
      if (m) {
        if (m[1] === '') {
          start = Math.max(0, size - Number(m[2]));
        } else {
          start = Number(m[1]);
          if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
        }
        if (start >= size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
    const rate = this.options.throttleBytesPerSec;
    if (!rate) {
      // Count what is actually handed to the socket (respecting backpressure).
      const counter = new Transform({
        transform: (chunk, _enc, cb) => {
          this.bytesSent = (this.bytesSent || 0) + chunk.length;
          cb(null, chunk);
        },
      });
      stream.pipe(counter).pipe(res);
      res.on('close', () => {
        stream.destroy();
        counter.destroy();
      });
      return;
    }
    // Throttled delivery to emulate per-connection bandwidth limits.
    stream.pause();
    let sent = 0;
    const startedAt = Date.now();
    stream.on('data', (chunk) => {
      stream.pause();
      sent += chunk.length;
      this.bytesSent = (this.bytesSent || 0) + chunk.length;
      res.write(chunk);
      const due = startedAt + (sent / rate) * 1000;
      setTimeout(() => stream.resume(), Math.max(0, due - Date.now()));
    });
    stream.on('end', () => res.end());
    res.on('close', () => stream.destroy());
    stream.resume();
  }
}

module.exports = { FakeGoogle, fakeJwt };
