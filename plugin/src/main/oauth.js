'use strict';

// Google OAuth 2.0 for installed apps: the system browser + a loopback redirect + PKCE.
// Google does not allow sign-in inside embedded web views, so the user signs in with the
// browser they already use (and are usually already logged into).

const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');
const { fetchJson, HttpError } = require('./http');
const { base64url } = require('./util');
const { SCOPES } = require('./config');

class AuthRequiredError extends Error {
  constructor(reason = 'signed-out') {
    super(reason === 'expired' ? 'Google session expired, please sign in again' : 'Not signed in to Google');
    this.name = 'AuthRequiredError';
    this.code = 'AUTH_REQUIRED';
    this.reason = reason;
  }
}

/** Accepts the JSON downloaded from Google Cloud Console or a plain {clientId, clientSecret}. */
function parseClientConfig(input) {
  let data = input;
  if (typeof input === 'string') data = JSON.parse(input);
  if (!data || typeof data !== 'object') throw new Error('Invalid client configuration');
  const block = data.installed || data.web || data;
  const clientId = String(block.client_id || block.clientId || '').trim();
  const clientSecret = String(block.client_secret || block.clientSecret || '').trim();
  if (!clientId) throw new Error('Client ID is missing');
  if (!/\.apps\.googleusercontent\.com$/.test(clientId) && !process.env.CLOUDPOOL_GOOGLE_BASE) {
    throw new Error('Client ID must end with .apps.googleusercontent.com');
  }
  return { clientId, clientSecret };
}

function decodeIdToken(idToken) {
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return { email: claims.email || '', name: claims.name || claims.email || '', picture: claims.picture || '' };
  } catch {
    return null;
  }
}

function callbackPage(ok, lang) {
  const ru = lang === 'ru';
  const title = ok ? (ru ? 'Готово!' : 'All set!') : ru ? 'Вход не выполнен' : 'Sign-in failed';
  const text = ok
    ? ru
      ? 'Можно закрыть эту вкладку и вернуться в DaVinci Resolve.'
      : 'You can close this tab and return to DaVinci Resolve.'
    : ru
      ? 'Вернитесь в DaVinci Resolve и попробуйте ещё раз.'
      : 'Return to DaVinci Resolve and try again.';
  const color = ok ? '#4c8bf5' : '#e5534b';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cloud Pool</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#16171a;color:#e6e7ea;font:16px -apple-system,Segoe UI,Roboto,sans-serif}
.c{text-align:center}.i{width:64px;height:64px;border-radius:50%;background:${color};display:grid;place-items:center;margin:0 auto 18px;font-size:34px;color:#fff}
h1{font-weight:600;margin:0 0 8px}p{color:#9a9ca3;margin:0}</style></head>
<body><div class="c"><div class="i">${ok ? '&#10003;' : '!'}</div><h1>${title}</h1><p>${text}</p></div>
<script>setTimeout(function(){window.close()},1200)</script></body></html>`;
}

class GoogleAuth extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./stores').SecureStore} opts.store   persisted { client, refreshToken, scopes, account }
   * @param {object} opts.endpoints                       from config.resolveEndpoints()
   * @param {(url: string) => Promise<void>} opts.openExternal
   * @param {() => string} [opts.getLanguage]
   */
  constructor({ store, endpoints, openExternal, getLanguage = () => 'en', logger = console }) {
    super();
    this.store = store;
    this.endpoints = endpoints;
    this.openExternal = openExternal;
    this.getLanguage = getLanguage;
    this.logger = logger;
    this.state = store.load() || {};
    this.access = null;
    this.refreshing = null;
    this.pending = null; // in-progress interactive sign-in
  }

  get client() {
    return this.state.client || null;
  }

  setClient(config) {
    const client = parseClientConfig(config);
    const changed = !this.state.client || this.state.client.clientId !== client.clientId;
    this.state = changed ? { client } : { ...this.state, client };
    this.access = null;
    this._persist();
    this._emit();
    return this.snapshot();
  }

  isSignedIn() {
    return !!this.state.refreshToken;
  }

  /** Which of our sources the user actually granted (consent screens allow unticking scopes). */
  grantedSources() {
    const scopes = this.state.scopes || [];
    return Object.keys(SCOPES).filter((k) => k !== 'identity' && scopes.includes(SCOPES[k]));
  }

  snapshot() {
    return {
      hasClient: !!this.state.client,
      clientId: this.state.client ? this.state.client.clientId : null,
      signedIn: this.isSignedIn(),
      account: this.state.account || null,
      sources: this.grantedSources(),
      signingIn: !!this.pending,
      lastError: this.state.lastError || null,
    };
  }

  _persist() {
    this.store.save(this.state);
  }

  _emit() {
    this.emit('change', this.snapshot());
  }

  cancelSignIn() {
    if (this.pending) this.pending.cancel(new Error('Sign-in cancelled'));
  }

  /** Interactive sign-in. Resolves with the auth snapshot once tokens are stored. */
  async signIn({ sources = ['photos', 'drive'], timeoutMs = 10 * 60 * 1000 } = {}) {
    if (!this.state.client) throw new Error('NO_CLIENT');
    this.cancelSignIn();
    const { clientId, clientSecret } = this.state.client;
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const expectedState = base64url(crypto.randomBytes(24));
    const scopes = [...SCOPES.identity, ...sources.map((s) => SCOPES[s]).filter(Boolean)];

    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const lang = this.getLanguage();

    let settle;
    const codePromise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const timer = setTimeout(() => settle.reject(new Error('Sign-in timed out')), timeoutMs);
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage(false, lang));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(callbackPage(!!code && !error, lang));
      if (code && !error) settle.resolve({ code, scope: url.searchParams.get('scope') || '' });
      else settle.reject(new Error(error === 'access_denied' ? 'Access was denied in the browser' : `Sign-in failed: ${error || 'no code'}`));
    });

    const cleanup = () => {
      clearTimeout(timer);
      server.close();
      if (typeof server.closeAllConnections === 'function') setTimeout(() => server.closeAllConnections(), 200);
    };
    this.pending = { cancel: (err) => settle.reject(err) };
    this._emit();

    try {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: expectedState,
        access_type: 'offline',
        prompt: 'select_account consent',
        include_granted_scopes: 'true',
      });
      if (this.state.account && this.state.account.email) params.set('login_hint', this.state.account.email);
      await this.openExternal(`${this.endpoints.auth}?${params.toString()}`);
      const { code } = await codePromise;
      const tokens = await fetchJson(this.endpoints.token, {
        method: 'POST',
        form: {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        },
      });
      if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
      const account = (tokens.id_token && decodeIdToken(tokens.id_token)) || this.state.account || null;
      this.state = {
        client: this.state.client,
        refreshToken: tokens.refresh_token,
        scopes: String(tokens.scope || scopes.join(' ')).split(/\s+/).filter(Boolean),
        account,
        signedInAt: new Date().toISOString(),
      };
      this.access = { token: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
      this._persist();
      this.emit('signed-in', this.snapshot());
      return this.snapshot();
    } finally {
      cleanup();
      this.pending = null;
      this._emit();
    }
  }

  async signOut() {
    const token = this.state.refreshToken;
    this.state = { client: this.state.client };
    this.access = null;
    this._persist();
    this._emit();
    if (token) {
      try {
        await fetchJson(this.endpoints.revoke, { method: 'POST', form: { token }, timeout: 8000 });
      } catch (err) {
        this.logger.warn(`[auth] token revoke failed: ${err.message}`);
      }
    }
  }

  invalidateAccessToken() {
    this.access = null;
  }

  async getAccessToken() {
    if (this.access && this.access.expiresAt - 90 * 1000 > Date.now()) return this.access.token;
    if (!this.refreshing) {
      this.refreshing = this._refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async _refresh() {
    if (!this.state.refreshToken || !this.state.client) throw new AuthRequiredError();
    const { clientId, clientSecret } = this.state.client;
    try {
      const t = await fetchJson(this.endpoints.token, {
        method: 'POST',
        form: { client_id: clientId, client_secret: clientSecret, refresh_token: this.state.refreshToken, grant_type: 'refresh_token' },
        timeout: 20000,
      });
      this.access = { token: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
      if (t.scope) {
        const scopes = String(t.scope).split(/\s+/).filter(Boolean);
        if (scopes.join(' ') !== (this.state.scopes || []).join(' ')) {
          this.state.scopes = scopes;
          this._persist();
          this._emit();
        }
      }
      return this.access.token;
    } catch (err) {
      if (err instanceof HttpError && (err.reason === 'invalid_grant' || err.reason === 'unauthorized_client' || err.status === 401)) {
        // Refresh token revoked or expired (Google expires them after 7 days for apps in "Testing").
        this.state = { client: this.state.client, account: this.state.account, lastError: 'expired' };
        this.access = null;
        this._persist();
        this._emit();
        throw new AuthRequiredError('expired');
      }
      throw err;
    }
  }

  async authHeaders() {
    return { Authorization: `Bearer ${await this.getAccessToken()}` };
  }

  /** Runs `fn(headers)`; on HTTP 401 refreshes the access token once and retries. */
  async withAuth(fn) {
    try {
      return await fn(await this.authHeaders());
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        this.invalidateAccessToken();
        return fn(await this.authHeaders());
      }
      throw err;
    }
  }
}

module.exports = { GoogleAuth, AuthRequiredError, parseClientConfig, decodeIdToken };
