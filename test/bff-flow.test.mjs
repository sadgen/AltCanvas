import assert from 'assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

process.env.ALLOW_DIRECT_AUTH = 'false';

const { handleLocalSetup, handleLocalLogin, handleSession, handleLogout } = await import('../server/auth.mjs');
const { createCanvasHandler } = await import('../server/canvas-api.mjs');
const { CanvasStore } = await import('../server/canvas-store.mjs');

console.log('🧪 Running AltCanvas BFF flow integration test...');

// [M4] Zero-Altero guarantee: any server-side outgoing fetch during the local
// authentication flow must be counted so we can assert none ever happens. The
// test client below intentionally uses originalFetch and is not counted.
let upstreamFetchCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  upstreamFetchCount++;
  return originalFetch(...args);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-bff-flow-test-'));
const dbPath = path.join(tempDir, 'bff-flow.sqlite');
const store = new CanvasStore(dbPath);
const canvasHandler = createCanvasHandler(store);

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

// Minimal mirror of the dev-server BFF router: local auth endpoints, the
// AltCanvas-owned /canvas API, and the M4-retired Altero proxy endpoints.
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    send(res, 400, '400 Bad Request');
    return;
  }
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // Same-origin CSRF guard, identical in spirit to scripts/dev-server.mjs.
  const isUnsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const isCookieAuthenticatedRoute = pathname === '/auth/logout' || pathname.startsWith('/canvas/');
  if (isUnsafe && isCookieAuthenticatedRoute) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      send(res, 403, '403 Forbidden: cross-origin request rejected');
      return;
    }
  }

  if (pathname === '/auth/setup' && method === 'POST') {
    return await handleLocalSetup(req, res, store);
  }
  if (pathname === '/auth/login' && method === 'POST') {
    return await handleLocalLogin(req, res, store);
  }
  if (pathname === '/auth/session' && ['GET', 'HEAD'].includes(method)) {
    return await handleSession(req, res, store);
  }
  if (pathname === '/auth/logout' && method === 'POST') {
    return await handleLogout(req, res);
  }
  if (pathname === '/auth/callback' && ['GET', 'HEAD'].includes(method)) {
    send(res, 410, JSON.stringify({ error: 'feature_retired', message: 'Altero OAuth 已于 M4 移除，请使用本地账户登录' }), { 'Content-Type': 'application/json' });
    return;
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/files/')) {
    send(res, 410, JSON.stringify({ error: 'feature_retired', message: 'Altero 代理已于 M4 移除' }), { 'Content-Type': 'application/json' });
    return;
  }
  if (pathname.startsWith('/canvas/')) {
    return await canvasHandler(req, res, url);
  }
  send(res, 404, '404 Not Found');
});

const listenPort = await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const baseOrigin = `http://127.0.0.1:${listenPort}`;

function extractSessionCookie(setCookieValues) {
  const values = Array.isArray(setCookieValues) ? setCookieValues : [setCookieValues];
  const cookie = values.find(value => String(value).startsWith('altcanvas_session='));
  assert.ok(cookie, 'missing altcanvas_session cookie');
  return String(cookie).split(';', 1)[0];
}

try {
  // 1. Fresh store: session reports unauthenticated and needsSetup
  const preSessionRes = await originalFetch(`${baseOrigin}/auth/session`);
  assert.equal(preSessionRes.status, 200);
  const preSession = await preSessionRes.json();
  assert.equal(preSession.authenticated, false);
  assert.equal(preSession.authMode, 'local', 'auth mode must be local before any setup');
  assert.equal(preSession.needsSetup, true, 'fresh store must require first-run admin setup');

  // 2. POST /auth/setup creates the first admin and issues the session cookie
  const setupRes = await originalFetch(`${baseOrigin}/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'flowadmin', password: 'FlowPassword123!' })
  });
  assert.equal(setupRes.status, 201, 'first-run setup must succeed with 201');
  assert.equal((await setupRes.json()).data.user.role, 'admin');
  const adminCookie = extractSessionCookie(setupRes.headers.getSetCookie());
  assert.match(adminCookie, /^altcanvas_session=/);

  // 3. Authenticated session introspection with the setup cookie
  const authedSessionRes = await originalFetch(`${baseOrigin}/auth/session`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(authedSessionRes.status, 200);
  const authedSession = await authedSessionRes.json();
  assert.equal(authedSession.authenticated, true);
  assert.equal(authedSession.authMode, 'local');
  assert.deepEqual(authedSession.capabilities, { nativeUpload: true }, 'local sessions must expose native upload capability');
  assert.equal(authedSession.user.username, 'flowadmin');
  assert.equal(authedSession.needsSetup, false);

  // 4. /canvas/* without a cookie must be rejected with 401
  const anonCanvasRes = await originalFetch(`${baseOrigin}/canvas/workspaces`);
  assert.equal(anonCanvasRes.status, 401, 'unauthenticated canvas access must be rejected with 401');
  assert.equal((await anonCanvasRes.json()).error.code, 'authentication_required');

  // 5. The same /canvas endpoint accepts the authenticated session
  const authedCanvasRes = await originalFetch(`${baseOrigin}/canvas/workspaces`, {
    headers: { cookie: adminCookie }
  });
  assert.equal(authedCanvasRes.status, 200, 'authenticated canvas access must succeed');

  // 6. Logout destroys the session and clears the cookie
  const logoutRes = await originalFetch(`${baseOrigin}/auth/logout`, {
    method: 'POST',
    headers: { cookie: adminCookie, origin: baseOrigin }
  });
  assert.equal(logoutRes.status, 200);
  assert.equal((await logoutRes.json()).success, true);
  const clearedCookie = extractSessionCookie(logoutRes.headers.getSetCookie());
  assert.match(clearedCookie, /^altcanvas_session=$/, 'logout must clear the session cookie');

  const loggedOutSessionRes = await originalFetch(`${baseOrigin}/auth/session`, {
    headers: { cookie: adminCookie }
  });
  assert.equal((await loggedOutSessionRes.json()).authenticated, false,
    'destroyed session must no longer authenticate requests');

  // 7. Local password login re-establishes a session on the same server
  const loginRes = await originalFetch(`${baseOrigin}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'flowadmin', password: 'FlowPassword123!' })
  });
  assert.equal(loginRes.status, 200, 'local login with correct credentials must succeed');
  const loginCookie = extractSessionCookie(loginRes.headers.getSetCookie());
  const reloginSessionRes = await originalFetch(`${baseOrigin}/auth/session`, {
    headers: { cookie: loginCookie }
  });
  assert.equal((await reloginSessionRes.json()).authenticated, true, 'login-issued cookie must authenticate');

  // 8. [M4] Retired Altero endpoints answer 410 feature_retired
  const callbackRes = await originalFetch(`${baseOrigin}/auth/callback?code=legacy-code&state=legacy-state`);
  assert.equal(callbackRes.status, 410, '/auth/callback must be retired with 410');
  assert.equal((await callbackRes.json()).error, 'feature_retired');

  for (const retiredPath of ['/api/foo', '/files/x']) {
    const retiredRes = await originalFetch(`${baseOrigin}${retiredPath}`);
    assert.equal(retiredRes.status, 410, `${retiredPath} must be retired with 410`);
    assert.equal((await retiredRes.json()).error, 'feature_retired');
  }

  // 9. [M4] The whole local flow must have made zero upstream (Altero) requests
  assert.equal(upstreamFetchCount, 0, 'local authentication flow must never touch the network');
  console.log('✅ local setup → session → canvas 401/200 → logout → login → retired 410 flow passed');
} finally {
  server.close();
  store.close();
  globalThis.fetch = originalFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('🎉 AltCanvas BFF flow integration test passed');
