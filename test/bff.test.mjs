import assert from 'assert/strict';
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
assert.equal(retrieved.id, session.id, 'getSession must return matching session');

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
storeAuthTransaction({ state, nonce, codeVerifier: verifier, returnTo: '/doc/123' });

const tx = consumeAuthTransaction(state);
assert.ok(tx, 'Transaction must be retrieved');
assert.equal(tx.nonce, nonce);
assert.equal(tx.codeVerifier, verifier);
assert.equal(tx.returnTo, '/doc/123');

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

// 5. Test SSRF Protection in sanitizeAlteroUrl
import { sanitizeAlteroUrl } from '../server/auth.mjs';

assert.equal(sanitizeAlteroUrl('http://192.168.5.1'), process.env.ALTERO_API || 'http://localhost:8000');
assert.equal(sanitizeAlteroUrl('http://10.0.0.1:9000'), process.env.ALTERO_API || 'http://localhost:8000');
assert.equal(sanitizeAlteroUrl('https://my-valid-altero.com/'), 'https://my-valid-altero.com');
console.log('✅ SSRF Protection & URL sanitization passed');

console.log('🎉 All AltCanvas BFF Unit Tests Passed Successfully!');
