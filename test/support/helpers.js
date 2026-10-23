'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { request, readBody } = require('../../plugin/src/main/http');
const { SecureStore, JsonStore } = require('../../plugin/src/main/stores');
const { GoogleAuth } = require('../../plugin/src/main/oauth');
const { resolveEndpoints } = require('../../plugin/src/main/config');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function tmpDir(prefix = 'cloudpool-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Imitates the system browser: GETs the URL and follows redirects (to the loopback server). */
async function browserOpen(url) {
  const res = await request(url, { maxRedirects: 10 });
  await readBody(res);
  return res.statusCode;
}

/** A signed-in GoogleAuth wired to the fake server. */
async function signedInAuth(fake, dir = tmpDir()) {
  const endpoints = resolveEndpoints({ CLOUDPOOL_GOOGLE_BASE: fake.base });
  const auth = new GoogleAuth({
    store: new SecureStore(path.join(dir, 'auth.json'), null),
    endpoints,
    openExternal: browserOpen,
    logger: quiet,
  });
  auth.setClient({ installed: { client_id: 'test-client.apps.googleusercontent.com', client_secret: 'secret' } });
  await auth.signIn();
  return { auth, endpoints, dir };
}

function jsonStore(dir, name, defaults = {}) {
  return new JsonStore(path.join(dir, name), defaults, { debounceMs: 10 });
}

function waitFor(emitter, event, predicate = () => true, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(value);
    }
    emitter.on(event, handler);
  });
}

module.exports = { quiet, tmpDir, browserOpen, signedInAuth, jsonStore, waitFor };
