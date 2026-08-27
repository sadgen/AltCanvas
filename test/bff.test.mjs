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
import { generateCodeChallenge } from '../server/auth.mjs';

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

console.log('🎉 All AltCanvas BFF Unit Tests Passed Successfully!');
