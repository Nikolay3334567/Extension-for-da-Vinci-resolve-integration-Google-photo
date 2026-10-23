'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { FakeGoogle } = require('../support/fake-google');
const { signedInAuth, tmpDir, quiet, browserOpen } = require('../support/helpers');
const { GoogleAuth, parseClientConfig, AuthRequiredError } = require('../../plugin/src/main/oauth');
const { SecureStore } = require('../../plugin/src/main/stores');
const { resolveEndpoints } = require('../../plugin/src/main/config');
const { fetchJson } = require('../../plugin/src/main/http');

test('parses the client JSON downloaded from Google Cloud Console', () => {
  const cfg = parseClientConfig(JSON.stringify({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x' } }));
  assert.deepEqual(cfg, { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' });
  assert.throws(() => parseClientConfig({ installed: {} }), /Client ID/);
});

test('loopback + PKCE sign-in stores a refresh token and the account', async () => {
  const fake = new FakeGoogle();
  await fake.start();
  try {
    const { auth, dir } = await signedInAuth(fake);
    const snap = auth.snapshot();
    assert.equal(snap.signedIn, true);
    assert.equal(snap.account.email, 'editor@example.com');
    assert.deepEqual(snap.sources.sort(), ['drive', 'photos']);
    // The persisted state survives a restart.
    const again = new GoogleAuth({ store: new SecureStore(path.join(dir, 'auth.json'), null), endpoints: auth.endpoints, openExternal: browserOpen, logger: quiet });
    assert.equal(again.isSignedIn(), true);
    const token = await again.getAccessToken();
    assert.match(token, /^at-/);
  } finally {
    await fake.stop();
  }
});

test('withAuth retries once with a fresh access token after a 401', async () => {
  const fake = new FakeGoogle();
  await fake.start();
  try {
    const { auth, endpoints } = await signedInAuth(fake);
    await auth.getAccessToken();
    fake.expireAccessTokens();
    const data = await auth.withAuth((headers) => fetchJson(`${endpoints.drive}/files?q=x`, { headers }));
    assert.deepEqual(data.files, []);
  } finally {
    await fake.stop();
  }
});

test('a revoked refresh token signs the user out with an "expired" reason', async () => {
  const fake = new FakeGoogle();
  await fake.start();
  try {
    const { auth } = await signedInAuth(fake);
    auth.invalidateAccessToken();
    fake.revokeRefreshTokens();
    await assert.rejects(auth.getAccessToken(), (err) => err instanceof AuthRequiredError && err.reason === 'expired');
    assert.equal(auth.snapshot().signedIn, false);
    assert.equal(auth.snapshot().lastError, 'expired');
    assert.equal(auth.snapshot().hasClient, true);
  } finally {
    await fake.stop();
  }
});

test('sign-in can be cancelled while waiting for the browser', async () => {
  const dir = tmpDir();
  const auth = new GoogleAuth({
    store: new SecureStore(path.join(dir, 'auth.json'), null),
    endpoints: resolveEndpoints({ CLOUDPOOL_GOOGLE_BASE: 'http://127.0.0.1:9' }),
    openExternal: async () => {},
    logger: quiet,
  });
  auth.setClient({ clientId: 'x.apps.googleusercontent.com', clientSecret: 's' });
  const pending = auth.signIn();
  setTimeout(() => auth.cancelSignIn(), 50);
  await assert.rejects(pending, /cancelled/);
  assert.equal(auth.snapshot().signingIn, false);
});
