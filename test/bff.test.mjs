import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSession,
  getSession,
  updateSession,
  destroySession,
  storeAuthTransaction,
  consumeAuthTransaction,
  generateRandomToken
} from '../server/session.mjs';
import { generateCodeChallenge, formatFetchError } from '../server/auth.mjs';
import { extractZoteroIdentity, verifyIdToken } from '../server/oidc.mjs';
import { isAllowedApiPath } from '../server/proxy-api.mjs';
import { hasScope, isPrivateNetworkHost, isSameOriginRequest } from '../server/security.mjs';

console.log('🧪 Running AltCanvas BFF Unit Tests...');

// 1. Test Session Management
const session = createSession({
  userId: '1',
  username: 'sadgen',
  displayName: 'Sadgen Researcher',
  accessToken: 'test_access_token_123',
  refreshToken: 'test_refresh_token_456',
  scopes: ['library.read', 'annotations.write', 'files.read']
});

assert.ok(session.id, 'Session must have an ID');
assert.equal(session.userId, '1');
assert.equal(session.displayName, 'Sadgen Researcher');

const retrieved = getSession(session.id);
assert.equal(retrieved.userId, session.userId, 'getSession must return matching session data');
assert.equal(retrieved.id, undefined, 'raw session ID must not be retained in the server-side store');

updateSession(session.id, { accessToken: 'new_access_token_789' });
const updated = getSession(session.id);
assert.equal(updated.accessToken, 'new_access_token_789', 'updateSession must update access token');

destroySession(session.id);
assert.equal(getSession(session.id), null, 'destroySession must remove session');
console.log('✅ Session creation, retrieval, update, and destruction passed');

// 2. Test PKCE Challenge Generation
const verifier = generateRandomToken(32);
const challenge = generateCodeChallenge(verifier);
assert.ok(challenge && challenge.length > 20, 'PKCE S256 challenge must be generated');

// 3. Test OAuth Transaction Store
const state = generateRandomToken(24);
const nonce = generateRandomToken(24);
storeAuthTransaction({
  state,
  nonce,
  codeVerifier: verifier,
  returnTo: '/doc/123',
  alteroApi: 'https://altero.example.org',
  issuer: 'https://altero.example.org',
  bindingHash: 'abc123'
});

const tx = consumeAuthTransaction(state);
assert.ok(tx, 'Transaction must be retrieved');
assert.equal(tx.nonce, nonce);
assert.equal(tx.codeVerifier, verifier);
assert.equal(tx.returnTo, '/doc/123');
assert.equal(tx.alteroApi, 'https://altero.example.org', 'OAuth transaction must retain the selected Altero node');
assert.equal(tx.issuer, 'https://altero.example.org');
assert.equal(tx.bindingHash, 'abc123');

assert.equal(consumeAuthTransaction(state), null, 'Transaction must be single-use only');
console.log('✅ PKCE & Auth Transaction Store passed');

// 4. Test formatFetchError
const simpleErr = new Error('fetch failed');
assert.equal(formatFetchError(simpleErr), 'fetch failed');

const errWithCause = new Error('fetch failed');
errWithCause.cause = new Error('connect ECONNREFUSED 127.0.0.1:8000');
assert.equal(formatFetchError(errWithCause), 'fetch failed (connect ECONNREFUSED 127.0.0.1:8000)');

const errWithCode = new Error('fetch failed');
errWithCode.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
assert.equal(formatFetchError(errWithCode), 'fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)');
console.log('✅ formatFetchError diagnostics test passed');

// 5. Test SSRF Protection in sanitizeAlteroUrl & isPrivateHost
import { sanitizeAlteroUrl, isPrivateHost } from '../server/auth.mjs';

const defaultFallback = process.env.ALTERO_API || 'http://localhost:8000';
const originalAllowPrivateHosts = process.env.ALLOW_PRIVATE_HOSTS;
process.env.ALLOW_PRIVATE_HOSTS = 'false';

// IPv4 private ranges
assert.equal(sanitizeAlteroUrl('http://192.168.5.1'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://10.0.0.1:9000'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://172.16.1.1'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://127.0.0.1:8000'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://0.0.0.0:8000'), defaultFallback);

// IPv6 private & loopback & link-local ranges
assert.equal(sanitizeAlteroUrl('http://[::1]'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://[::]:8000'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://[fe80::1]'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://[fc00::1]'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://[fd12:3456::1]'), defaultFallback);
assert.equal(sanitizeAlteroUrl('http://[::ffff:127.0.0.1]'), defaultFallback);

// Valid public domains
assert.equal(sanitizeAlteroUrl('https://my-valid-altero.com/'), 'https://my-valid-altero.com');
assert.equal(sanitizeAlteroUrl('https://altero.example.org:8443'), 'https://altero.example.org:8443');

if (originalAllowPrivateHosts === undefined) delete process.env.ALLOW_PRIVATE_HOSTS;
else process.env.ALLOW_PRIVATE_HOSTS = originalAllowPrivateHosts;

console.log('✅ SSRF Protection & URL sanitization (IPv4 & IPv6) passed');

// 6. Test OIDC ID Token signature, claims, nonce, and Zotero identity mapping
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
publicJwk.kid = 'audit-key';
publicJwk.alg = 'RS256';
publicJwk.use = 'sig';
const oidcConfig = {
  issuer: 'https://altero.example.org',
  jwksUri: 'https://altero.example.org/.well-known/jwks.json'
};
const oidcHeader = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'audit-key', typ: 'JWT' })).toString('base64url');
const oidcClaims = Buffer.from(JSON.stringify({
  iss: oidcConfig.issuer,
  aud: 'altcanvas',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  nonce: 'expected-nonce',
  sub: 'subject-123',
  zotero_user_id: '42',
  zotero_groups: ['7', { id: '8' }],
  preferred_username: 'researcher'
})).toString('base64url');
const oidcSigningInput = `${oidcHeader}.${oidcClaims}`;
const oidcSignature = crypto.sign('RSA-SHA256', Buffer.from(oidcSigningInput), privateKey).toString('base64url');
const idToken = `${oidcSigningInput}.${oidcSignature}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
});
try {
  const claims = await verifyIdToken(idToken, oidcConfig, 'expected-nonce');
  const identity = extractZoteroIdentity(claims);
  assert.equal(identity.subject, 'subject-123');
  assert.equal(identity.userId, '42');
  assert.deepEqual(identity.groupIds, ['7', '8']);
  await assert.rejects(() => verifyIdToken(idToken, oidcConfig, 'wrong-nonce'), /nonce/);
} finally {
  globalThis.fetch = originalFetch;
}
console.log('✅ OIDC signature, claims, nonce, and identity mapping passed');

// 7. Test BFF authorization boundaries and CSRF origin checks
const authorizationSession = {
  userId: '42',
  groupIds: ['7'],
  scopes: ['library.read', 'files.read']
};
assert.equal(isAllowedApiPath('/api/users/42/items/top', authorizationSession), true);
assert.equal(isAllowedApiPath('/api/users/43/items/top', authorizationSession), false);
assert.equal(isAllowedApiPath('/api/groups/7/items/top', authorizationSession), true);
assert.equal(isAllowedApiPath('/api/groups/8/items/top', authorizationSession), false);
assert.equal(isAllowedApiPath('/api/keys/current', authorizationSession), false);
assert.equal(hasScope(authorizationSession, 'library.read'), true);
assert.equal(hasScope(authorizationSession, 'library.write'), false);
assert.equal(isSameOriginRequest({ headers: { origin: 'https://canvas.example.org' } }, 'https://canvas.example.org'), true);
assert.equal(isSameOriginRequest({ headers: { origin: 'http://canvas.example.org' } }, 'https://canvas.example.org'), false);
assert.equal(isSameOriginRequest({ headers: { origin: 'https://evil.example.org' } }, 'https://canvas.example.org'), false);
assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'cross-site' } }, 'https://canvas.example.org'), false);
assert.equal(isPrivateNetworkHost('192.168.1.20'), true);
assert.equal(isPrivateNetworkHost('999.1.1.1'), true);
assert.equal(isPrivateNetworkHost('8.8.8.8'), false);
console.log('✅ API allowlist, scope, group membership, and same-origin checks passed');

// 8. Test encrypted session persistence across process restarts
const persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-session-test-'));
const previousDataDir = process.env.DATA_DIR;
const previousSessionSecret = process.env.SESSION_SECRET;
process.env.DATA_DIR = persistenceDir;
process.env.SESSION_SECRET = 'test-only-session-secret-with-32-bytes';
try {
  const creatingStore = await import(`../server/session.mjs?create=${Date.now()}`);
  const created = creatingStore.createSession({
    userId: '99', accessToken: 'persisted-access-token', refreshToken: 'persisted-refresh-token',
    scopes: ['library.read'], alteroApi: 'https://altero.example.org'
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const restoredStore = await import(`../server/session.mjs?restore=${Date.now()}`);
  assert.equal(restoredStore.getSession(created.id)?.userId, '99');
  await new Promise(resolve => setTimeout(resolve, 100));
  const persistedPayload = fs.readFileSync(path.join(persistenceDir, 'sessions.enc.json'), 'utf8');
  assert.equal(persistedPayload.includes('persisted-access-token'), false);
  assert.equal(persistedPayload.includes('persisted-refresh-token'), false);
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
  fs.rmSync(persistenceDir, { recursive: true, force: true });
}
console.log('✅ Encrypted session persistence across process restarts passed');

console.log('🎉 All AltCanvas BFF Unit Tests Passed Successfully!');
