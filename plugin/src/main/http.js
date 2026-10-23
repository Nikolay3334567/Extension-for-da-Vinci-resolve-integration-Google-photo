'use strict';

// Minimal HTTP(S) client built on Node's http/https modules. It is used instead of fetch()
// because downloads need fine control over keep-alive sockets, Range requests, streaming
// writes and idle timeouts, and because it behaves the same on every Electron version that
// DaVinci Resolve has shipped.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { abortError } = require('./util');

const AGENTS = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, keepAliveMsecs: 15000 }),
};

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.reason = extra.reason || null;
    this.body = extra.body;
    this.headers = extra.headers || {};
    this.url = extra.url || null;
  }
}

// OAuth bearer tokens must only ever travel to Google. Extra hosts can be trusted explicitly
// (the test-suite's fake Google server).
const TRUSTED_SUFFIXES = ['googleapis.com', 'googleusercontent.com', 'google.com', 'ggpht.com'];
const extraTrustedHosts = new Set();

function trustHost(host) {
  extraTrustedHosts.add(String(host).toLowerCase());
}

function isTrustedUrl(input) {
  const u = typeof input === 'string' ? new URL(input) : input;
  if (extraTrustedHosts.has(u.host.toLowerCase())) return true;
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  return TRUSTED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function withoutHeader(headers, name) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase() !== name) out[k] = v;
  }
  return out;
}

/**
 * Performs a request and resolves with the (unconsumed) IncomingMessage once headers arrive.
 * Redirects are followed; the Authorization header is dropped when leaving trusted hosts.
 * The abort signal stays bound to the response so streaming bodies can be cancelled.
 */
function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body = null, signal = null, timeout = 30000, maxRedirects = 6 } = opts;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!mod) {
      reject(new Error(`Unsupported protocol: ${target.protocol}`));
      return;
    }
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    let sendHeaders = headers;
    if (!isTrustedUrl(target)) sendHeaders = withoutHeader(headers, 'authorization');

    let response = null;
    const onAbort = () => {
      const err = abortError();
      if (response) response.destroy(err);
      req.destroy(err);
    };
    const unbind = () => signal && signal.removeEventListener('abort', onAbort);

    const req = mod.request(target, { method, headers: sendHeaders, agent: AGENTS[target.protocol], timeout }, (res) => {
      if (REDIRECT_CODES.has(res.statusCode) && res.headers.location && maxRedirects > 0) {
        unbind();
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, target);
        } catch (err) {
          reject(err);
          return;
        }
        const nextMethod = res.statusCode === 303 ? 'GET' : method;
        resolve(
          request(next.href, {
            ...opts,
            method: nextMethod,
            body: nextMethod === 'GET' || nextMethod === 'HEAD' ? null : body,
            maxRedirects: maxRedirects - 1,
          }),
        );
        return;
      }
      response = res;
      res.url = target.href;
      res.once('close', unbind);
      resolve(res);
    });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => {
      const err = new Error(`Network timeout (${target.host})`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
      if (response) response.destroy(err);
    });
    req.on('error', (err) => {
      unbind();
      reject(err);
    });
    if (body != null) req.end(body);
    else req.end();
  });
}

function readBody(res, { limit = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.destroy(new Error('Response too large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('Connection aborted')));
  });
}

function errorFromResponse(res, data, text) {
  let message = `HTTP ${res.statusCode}`;
  let reason = null;
  if (data && typeof data.error === 'object' && data.error) {
    message = data.error.message || message;
    reason = data.error.status || (data.error.errors && data.error.errors[0] && data.error.errors[0].reason) || null;
  } else if (data && typeof data.error === 'string') {
    reason = data.error;
    message = data.error_description ? `${data.error}: ${data.error_description}` : data.error;
  } else if (text && text.length < 300) {
    message = `${message}: ${text.trim()}`;
  }
  return new HttpError(res.statusCode, message, { reason, body: data || text, headers: res.headers, url: res.url });
}

/** JSON request helper. Supports `json` (request body) and `form` (x-www-form-urlencoded). */
async function fetchJson(url, opts = {}) {
  const headers = { Accept: 'application/json', ...(opts.headers || {}) };
  let body = opts.body != null ? opts.body : null;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['Content-Type'] = 'application/json; charset=utf-8';
  } else if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
  const res = await request(url, { ...opts, headers, body });
  const buf = await readBody(res, { limit: opts.limit || 32 * 1024 * 1024 });
  const text = buf.toString('utf8');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (res.statusCode < 200 || res.statusCode >= 300) throw errorFromResponse(res, data, text);
  return data || {};
}

/** Parses "bytes 0-99/1234" (Content-Range). */
function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || '').trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/** Network-level failures that are worth retrying. */
function isTransientError(err) {
  if (!err) return false;
  if (err instanceof HttpError) return err.status === 408 || err.status === 429 || err.status >= 500;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(err.code)
    || /socket hang up|aborted|premature/i.test(err.message || '');
}

module.exports = {
  HttpError,
  request,
  readBody,
  fetchJson,
  errorFromResponse,
  parseContentRange,
  isTransientError,
  isTrustedUrl,
  trustHost,
};
