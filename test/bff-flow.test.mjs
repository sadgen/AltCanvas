import assert from 'assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';

process.env.ALLOW_PRIVATE_HOSTS = 'true';
process.env.ALLOW_INSECURE_OAUTH = 'true';
process.env.ALLOW_DYNAMIC_ALTERO = 'true';
process.env.ALLOW_DIRECT_AUTH = 'false';
process.env.OAUTH_CLIENT_ID = 'altcanvas';

const { handleLogin, handleCallback, handleSession, handleLogout } = await import('../server/auth.mjs');
const { handleApiProxy, refreshAccessToken } = await import('../server/proxy-api.mjs');
const { handleFilesProxy } = await import('../server/proxy-files.mjs');
const { createSession, getSession } = await import('../server/session.mjs');

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
    this.ended = false;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.ended = true;
    this.emit('finish');
  }

  destroy() {
    this.ended = true;
    this.emit('close');
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function mockRequest({ method = 'GET', headers = {} } = {}) {
  return {
    method,
    headers,
    socket: { encrypted: false, remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {}
  };
}

function firstCookie(setCookie, name) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const cookie = values.find(value => String(value).startsWith(`${name}=`));
  assert.ok(cookie, `missing ${name} cookie`);
  return String(cookie).split(';', 1)[0];
}

function createIdToken(privateKey, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'flow-key', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: 'http://altero.test',
    aud: 'altcanvas',
    exp: now + 300,
    iat: now,
    nonce,
    sub: 'subject-42',
    zotero_user_id: '42',
    zotero_groups: ['7'],
    preferred_username: 'flow-user',
    name: 'Flow Researcher'
  })).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

console.log('🧪 Running AltCanvas BFF flow integration test...');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
Object.assign(publicJwk, { kid: 'flow-key', alg: 'RS256', use: 'sig' });

let expectedNonce;
let refreshCount = 0;
let authorizationCodeExchangeCount = 0;
const upstreamRequests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  upstreamRequests.push({ url: url.toString(), options });

  if (url.pathname === '/.well-known/openid-configuration') {
    return Response.json({
      issuer: 'http://altero.test',
      authorization_endpoint: 'http://altero.test/oauth/authorize',
      token_endpoint: 'http://altero.test/oauth/token',
      jwks_uri: 'http://altero.test/.well-known/jwks.json',
      revocation_endpoint: 'http://altero.test/oauth/revoke'
    });
  }
  if (url.pathname === '/oauth/token') {
    const body = new URLSearchParams(options.body);
    if (body.get('grant_type') === 'refresh_token') {
      if (body.get('refresh_token') === 'invalid-refresh-token') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      refreshCount += 1;
      assert.equal(body.get('refresh_token'), 'flow-refresh-token');
      return Response.json({
        access_token: 'flow-refreshed-access-token',
        refresh_token: 'flow-rotated-refresh-token',
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile library.read library.write annotations.read annotations.write files.read'
      });
    }
    assert.equal(body.get('grant_type'), 'authorization_code');
    authorizationCodeExchangeCount += 1;
    assert.ok(body.get('code_verifier'));
    return Response.json({
      access_token: 'flow-access-token',
      refresh_token: 'flow-refresh-token',
      token_type: 'Bearer',
      expires_in: 30,
      scope: 'openid profile library.read library.write annotations.read annotations.write files.read',
      id_token: createIdToken(privateKey, expectedNonce)
    });
  }
  if (url.pathname === '/.well-known/jwks.json') {
    return Response.json({ keys: [publicJwk] });
  }
  if (url.pathname === '/users/42/items/top') {
    assert.equal(options.headers.Authorization, 'Bearer flow-refreshed-access-token');
    return Response.json([{ key: 'ITEM0001', data: { itemType: 'journalArticle', title: 'Flow Item' } }], {
      headers: { 'Total-Results': '1', 'Zotero-API-Version': '3' }
    });
  }
  if (url.pathname === '/users/42/items/ATTACH01/file/content') {
    assert.equal(options.headers.Authorization, 'Bearer flow-refreshed-access-token');
    assert.equal(options.headers.Range, 'bytes=0-15');
    return new Response(Buffer.from('%PDF-1.7 flow-test'), {
      status: 206,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Range': 'bytes 0-15/18',
        'Accept-Ranges': 'bytes',
        'Content-Length': '18'
      }
    });
  }
  if (url.pathname === '/groups/7/items/GROUPPDF/file/content') {
    assert.equal(options.headers.Authorization, 'Bearer flow-refreshed-access-token');
    return new Response(Buffer.from('%PDF-1.7 group-test'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '19' }
    });
  }
  if (url.pathname === '/oauth/revoke') {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('token'), 'flow-rotated-refresh-token');
    return new Response(null, { status: 200 });
  }
  throw new Error(`Unexpected upstream request: ${url}`);
};

try {
  const selfOrigin = 'http://canvas.test';
  const loginResponse = new MockResponse();
  await handleLogin(
    mockRequest(),
    loginResponse,
    new URL('/auth/login?altero_api=http%3A%2F%2Faltero.test&return_to=%2F', selfOrigin),
    selfOrigin
  );
  assert.equal(loginResponse.statusCode, 302);
  const authorizationUrl = new URL(loginResponse.getHeader('location'));
  assert.equal(authorizationUrl.origin, 'http://altero.test');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  expectedNonce = authorizationUrl.searchParams.get('nonce');
  assert.ok(expectedNonce);
  const state = authorizationUrl.searchParams.get('state');
  const bindingCookie = firstCookie(loginResponse.getHeader('set-cookie'), 'altcanvas_oauth_binding');

  const callbackResponse = new MockResponse();
  await handleCallback(
    mockRequest({ headers: { cookie: bindingCookie } }),
    callbackResponse,
    new URL(`/auth/callback?code=flow-code&state=${encodeURIComponent(state)}`, selfOrigin),
    selfOrigin
  );
  assert.equal(callbackResponse.statusCode, 303);
  assert.equal(callbackResponse.getHeader('location'), '/');
  const sessionCookie = firstCookie(callbackResponse.getHeader('set-cookie'), 'altcanvas_session');

  const sessionResponse = new MockResponse();
  await handleSession(mockRequest({ headers: { cookie: sessionCookie } }), sessionResponse);
  assert.equal(sessionResponse.statusCode, 200);
  const sessionPayload = JSON.parse(sessionResponse.text);
  assert.equal(sessionPayload.authenticated, true);
  assert.equal(sessionPayload.user.id, '42');
  assert.equal(sessionPayload.user.displayName, 'Flow Researcher');
  assert.equal(getSession(sessionCookie.split('=', 2)[1]).subject, 'subject-42');
  assert.equal(sessionPayload.allowDirectMode, false);

  const apiResponse = new MockResponse();
  await handleApiProxy(
    mockRequest({ headers: { cookie: sessionCookie, accept: 'application/json' } }),
    apiResponse,
    new URL('/api/users/42/items/top?limit=1', selfOrigin)
  );
  assert.equal(apiResponse.statusCode, 200);
  assert.equal(JSON.parse(apiResponse.text)[0].key, 'ITEM0001');
  assert.equal(apiResponse.getHeader('total-results'), '1');
  assert.equal(refreshCount, 1, 'near-expiry token should be refreshed exactly once');

  const fileResponse = new MockResponse();
  await handleFilesProxy(
    mockRequest({ headers: { cookie: sessionCookie, range: 'bytes=0-15' } }),
    fileResponse,
    new URL('/files/users/42/items/ATTACH01', selfOrigin)
  );
  assert.equal(fileResponse.statusCode, 206);
  assert.equal(fileResponse.getHeader('content-range'), 'bytes 0-15/18');
  assert.match(fileResponse.text, /^%PDF-1\.7/);
  assert.equal(refreshCount, 1, 'subsequent Range request should reuse the refreshed token');

  const groupFileResponse = new MockResponse();
  await handleFilesProxy(
    mockRequest({ headers: { cookie: sessionCookie } }),
    groupFileResponse,
    new URL('/files/groups/7/items/GROUPPDF', selfOrigin)
  );
  assert.equal(groupFileResponse.statusCode, 200);
  assert.match(groupFileResponse.text, /group-test/);

  const upstreamCountBeforeDeniedGroup = upstreamRequests.length;
  const deniedGroupResponse = new MockResponse();
  await handleFilesProxy(
    mockRequest({ headers: { cookie: sessionCookie } }),
    deniedGroupResponse,
    new URL('/files/groups/8/items/GROUPPDF', selfOrigin)
  );
  assert.equal(deniedGroupResponse.statusCode, 403);
  assert.equal(upstreamRequests.length, upstreamCountBeforeDeniedGroup,
    'unauthorized group attachment access must be rejected before upstream fetch');

  const logoutResponse = new MockResponse();
  await handleLogout(mockRequest({ method: 'POST', headers: { cookie: sessionCookie } }), logoutResponse);
  assert.equal(logoutResponse.statusCode, 200);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(upstreamRequests.some(request => new URL(request.url).pathname === '/oauth/revoke'));

  const loggedOutSessionResponse = new MockResponse();
  await handleSession(mockRequest({ headers: { cookie: sessionCookie } }), loggedOutSessionResponse);
  assert.equal(JSON.parse(loggedOutSessionResponse.text).authenticated, false);

  const reboundLoginResponse = new MockResponse();
  await handleLogin(
    mockRequest(),
    reboundLoginResponse,
    new URL('/auth/login?altero_api=http%3A%2F%2Faltero.test', selfOrigin),
    selfOrigin
  );
  const reboundAuthorizationUrl = new URL(reboundLoginResponse.getHeader('location'));
  const exchangesBeforeRejectedCallback = authorizationCodeExchangeCount;
  const rejectedCallbackResponse = new MockResponse();
  await handleCallback(
    mockRequest({ headers: { cookie: 'altcanvas_oauth_binding=wrong-browser-binding' } }),
    rejectedCallbackResponse,
    new URL(`/auth/callback?code=rejected-code&state=${encodeURIComponent(reboundAuthorizationUrl.searchParams.get('state'))}`, selfOrigin),
    selfOrigin
  );
  assert.equal(rejectedCallbackResponse.statusCode, 302);
  assert.match(rejectedCallbackResponse.getHeader('location'), /auth_error=/);
  assert.equal(authorizationCodeExchangeCount, exchangesBeforeRejectedCallback, 'browser-binding failure must stop before token exchange');

  const invalidRefreshSession = createSession({
    userId: '42',
    accessToken: 'expired-access-token',
    refreshToken: 'invalid-refresh-token',
    expiresAt: Date.now() - 1000,
    scopes: ['library.read'],
    alteroApi: 'http://altero.test'
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await refreshAccessToken(getSession(invalidRefreshSession.id), invalidRefreshSession.id), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(getSession(invalidRefreshSession.id), null, 'invalid_grant must destroy the local session');

  assert.ok(upstreamRequests.some(request => request.url.endsWith('/.well-known/openid-configuration')));
  assert.ok(upstreamRequests.some(request => request.url.includes('/users/42/items/top?limit=1')));
  console.log('✅ OIDC login → refresh rotation → API/PDF Range → revoke/logout flow passed');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('🎉 AltCanvas BFF flow integration test passed');
