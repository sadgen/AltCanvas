import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createSession,
  getSession,
  updateSession,
  destroySession,
  generateRandomToken
} from '../server/session.mjs';
import { formatFetchError, getAuthMode, isLocalAuthAllowed } from '../server/auth.mjs';
import { isPrivateNetworkHost, isSameOriginRequest } from '../server/security.mjs';
import { validateExternalUrl, safeFetchText } from '../server/import-resolver.mjs';

console.log('🧪 Running AltCanvas BFF Unit Tests...');

// 1. Test Session Management (M4 local-only sessions carry no Altero tokens)
const session = createSession({
  userId: '1',
  username: 'sadgen',
  displayName: 'Sadgen Researcher',
  scopes: ['*']
});

assert.ok(session.id, 'Session must have an ID');
assert.equal(session.userId, '1');
assert.equal(session.displayName, 'Sadgen Researcher');
assert.equal(session.authMode, 'local', 'sessions must always be created in local auth mode');

const retrieved = getSession(session.id);
assert.equal(retrieved.userId, session.userId, 'getSession must return matching session data');
assert.equal(retrieved.id, undefined, 'raw session ID must not be retained in the server-side store');

updateSession(session.id, { note: 'x' });
const updated = getSession(session.id);
assert.equal(updated.note, 'x', 'updateSession must update arbitrary custom fields');

destroySession(session.id);
assert.equal(getSession(session.id), null, 'destroySession must remove session');
console.log('✅ Session creation, retrieval, update, and destruction passed');

// 2. Test formatFetchError
const simpleErr = new Error('fetch failed');
assert.equal(formatFetchError(simpleErr), 'fetch failed');

const errWithCause = new Error('fetch failed');
errWithCause.cause = new Error('connect ECONNREFUSED 127.0.0.1:8000');
assert.equal(formatFetchError(errWithCause), 'fetch failed (connect ECONNREFUSED 127.0.0.1:8000)');

const errWithCode = new Error('fetch failed');
errWithCode.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
assert.equal(formatFetchError(errWithCode), 'fetch failed (DEPTH_ZERO_SELF_SIGNED_CERT)');
console.log('✅ formatFetchError diagnostics test passed');

// 3. [M4] createSession tolerates legacy Altero-only arguments and stays local.
// OAuth tokens/groups were removed from the session model; leftover callers
// passing them must not crash, and the values must be ignored.
const legacySession = createSession({
  userId: '42',
  username: 'legacy-caller',
  accessToken: 'ignored-access-token',
  refreshToken: 'ignored-refresh-token',
  groupIds: ['7'],
  alteroApi: 'https://altero.example.org',
  authMode: 'altero'
});
assert.ok(legacySession.id, 'createSession must succeed even with legacy Altero arguments');
assert.equal(legacySession.authMode, 'local', 'session authMode must always default and stay local');
const legacyStored = getSession(legacySession.id);
assert.equal(legacyStored.accessToken, undefined, 'access token must not be stored on the session');
assert.equal(legacyStored.refreshToken, undefined, 'refresh token must not be stored on the session');
assert.equal(legacyStored.groupIds, undefined, 'group membership must not be stored on the session');
assert.equal(legacyStored.alteroApi, undefined, 'Altero node must not be stored on the session');
destroySession(legacySession.id);

// [M4] AUTH_MODE=altero no longer exists: the auth mode is pinned to local.
const originalAuthMode = process.env.AUTH_MODE;
try {
  process.env.AUTH_MODE = 'altero';
  assert.equal(getAuthMode(), 'local', 'getAuthMode must return local even when AUTH_MODE=altero is set');
  assert.equal(isLocalAuthAllowed(), true, 'local auth must always be allowed after M4');
} finally {
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
}
console.log('✅ Local-only auth mode pinning (AUTH_MODE=altero is inert) passed');

// 4. Test import-resolver safeFetchText SSRF and redirect defenses
const mockPublicLookup = async (hostname) => {
  if (hostname === '127.0.0.1' || hostname === 'localhost') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === '169.254.169.254') return [{ address: '169.254.169.254', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }];
};

await assert.rejects(async () => {
  await validateExternalUrl('http://127.0.0.1:8080', { lookupFn: mockPublicLookup });
}, /Forbidden address/);

await assert.rejects(async () => {
  await validateExternalUrl('http://admin:secret@example.com', { lookupFn: mockPublicLookup });
}, /Embedded URL credentials/);

await assert.rejects(async () => {
  await validateExternalUrl('ftp://example.com', { lookupFn: mockPublicLookup });
}, /Only http: and https: protocols/);

// Test redirect to private host rejection
await assert.rejects(async () => {
  await safeFetchText('https://example.com/redirect-to-private', {}, {
    allowPrivate: false,
    lookupFn: mockPublicLookup,
    transportFn: async (u) => {
      return {
        status: 302,
        statusText: 'Found',
        headers: new Headers({ 'Location': 'http://169.254.169.254/latest/meta-data' })
      };
    }
  });
}, /Forbidden address/);

// Test response size limit (>1MB) rejection
await assert.rejects(async () => {
  await safeFetchText('https://example.com/oversized-payload', {}, {
    allowPrivate: true,
    lookupFn: mockPublicLookup,
    transportFn: async () => {
      const hugeBuffer = Buffer.alloc(1024 * 1024 + 100);
      return [hugeBuffer];
    }
  });
}, /exceeds maximum allowed size/);
console.log('✅ import-resolver SSRF defenses (private redirect & size cap) passed');

// 5. Test CSRF origin checks and private-network host classification
assert.equal(isSameOriginRequest({ headers: { origin: 'https://canvas.example.org' } }, 'https://canvas.example.org'), true);
assert.equal(isSameOriginRequest({ headers: { origin: 'http://canvas.example.org' } }, 'https://canvas.example.org'), false);
assert.equal(isSameOriginRequest({ headers: { origin: 'https://evil.example.org' } }, 'https://canvas.example.org'), false);
assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'cross-site' } }, 'https://canvas.example.org'), false);
assert.equal(isPrivateNetworkHost('192.168.1.20'), true);
assert.equal(isPrivateNetworkHost('999.1.1.1'), true);
assert.equal(isPrivateNetworkHost('8.8.8.8'), false);
console.log('✅ Same-origin CSRF checks and private-network host classification passed');

// 6. Test encrypted session persistence across process restarts
const persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-session-test-'));
const previousDataDir = process.env.DATA_DIR;
const previousSessionSecret = process.env.SESSION_SECRET;
process.env.DATA_DIR = persistenceDir;
process.env.SESSION_SECRET = 'test-only-session-secret-with-32-bytes';
try {
  const creatingStore = await import(`../server/session.mjs?create=${Date.now()}`);
  const created = creatingStore.createSession({
    userId: '99', username: 'persisted-user',
    scopes: ['*']
  });
  creatingStore.updateSession(created.id, { note: 'persisted-private-note' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const restoredStore = await import(`../server/session.mjs?restore=${Date.now()}`);
  const restored = restoredStore.getSession(created.id);
  assert.equal(restored?.userId, '99');
  assert.equal(restored?.note, 'persisted-private-note', 'custom session fields must survive a restart');
  assert.equal(restored?.authMode, 'local', 'restored sessions must remain local');
  await new Promise(resolve => setTimeout(resolve, 100));
  const persistedPayload = fs.readFileSync(path.join(persistenceDir, 'sessions.enc.json'), 'utf8');
  assert.equal(persistedPayload.includes('persisted-private-note'), false,
    'persisted session store must be encrypted (no plaintext custom fields)');
  assert.equal(persistedPayload.includes('persisted-user'), false,
    'persisted session store must be encrypted (no plaintext usernames)');
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSessionSecret;
  fs.rmSync(persistenceDir, { recursive: true, force: true });
}
console.log('✅ Encrypted session persistence across process restarts passed');

// generateRandomToken stays available for non-OAuth uses (session IDs, CSRF state)
const randomToken = generateRandomToken(32);
assert.ok(randomToken && randomToken.length >= 32, 'generateRandomToken must produce URL-safe tokens');
assert.notEqual(randomToken, generateRandomToken(32), 'tokens must be unique per call');
console.log('✅ generateRandomToken sanity check passed');

console.log('🎉 All AltCanvas BFF Unit Tests Passed Successfully!');
