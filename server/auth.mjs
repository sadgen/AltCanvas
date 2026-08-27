import crypto from 'crypto';
import {
  generateRandomToken,
  storeAuthTransaction,
  consumeAuthTransaction,
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionIdFromRequest
} from './session.mjs';

const DEFAULT_ALTERO_API = (process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, '');
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'altcanvas';
const DEFAULT_SCOPES = 'openid profile library.read library.write annotations.read annotations.write files.read';

/**
 * Generate PKCE S256 code challenge from verifier
 */
export function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Sanitize and validate Altero server URL
 */
export function sanitizeAlteroUrl(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_ALTERO_API;
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      return DEFAULT_ALTERO_API;
    }
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_ALTERO_API;
  }
}

/**
 * Sanitize and validate relative return_to path
 */
function sanitizeReturnTo(returnTo) {
  if (!returnTo || typeof returnTo !== 'string') return '/';
  if (returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.includes('\\')) {
    return returnTo;
  }
  return '/';
}

/**
 * Handle GET /auth/login
 */
export async function handleLogin(req, res, url, selfOrigin) {
  const returnTo = sanitizeReturnTo(url.searchParams.get('return_to'));
  const alteroApi = sanitizeAlteroUrl(url.searchParams.get('altero_api') || url.searchParams.get('server'));
  const state = generateRandomToken(24);
  const nonce = generateRandomToken(24);
  const codeVerifier = generateRandomToken(32);
  const codeChallenge = generateCodeChallenge(codeVerifier);

  storeAuthTransaction({ state, nonce, codeVerifier, returnTo, alteroApi });

  const redirectUri = `${selfOrigin}/auth/callback`;
  const authUrl = new URL(`${alteroApi}/oauth/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', DEFAULT_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  res.writeHead(302, {
    'Location': authUrl.toString(),
    'Cache-Control': 'no-store'
  });
  res.end();
}

/**
 * Handle GET /auth/callback
 */
export async function handleCallback(req, res, url, selfOrigin) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h3>授权失败</h3><p>${error}: ${errorDesc || '用户取消或拒绝授权'}</p><p><a href="/">返回首页</a></p>`);
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: 缺少 code 或 state 参数');
    return;
  }

  const tx = consumeAuthTransaction(state);
  if (!tx) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h3>授权会话已过期或无效</h3><p>请重新发起登录。</p><p><a href="/">重新登录</a></p>');
    return;
  }

  const redirectUri = `${selfOrigin}/auth/callback`;
  const alteroApi = tx.alteroApi || DEFAULT_ALTERO_API;

  try {
    const tokenRes = await fetch(`${alteroApi}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OAUTH_CLIENT_ID,
        code,
        code_verifier: tx.codeVerifier,
        redirect_uri: redirectUri
      }).toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Token endpoint responded HTTP ${tokenRes.status}: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const now = Date.now();
    const expiresAt = tokenData.expires_in ? now + tokenData.expires_in * 1000 : now + 3600 * 1000;

    const session = createSession({
      userId: tokenData.user_id || tokenData.userId || '1',
      username: tokenData.username || tokenData.preferred_username || 'Researcher',
      displayName: tokenData.display_name || tokenData.displayName || tokenData.username || 'Researcher',
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      scopes: tokenData.scope ? tokenData.scope.split(' ') : DEFAULT_SCOPES.split(' '),
      alteroApi
    });

    setSessionCookie(res, session.id, req);

    res.writeHead(303, {
      'Location': tx.returnTo || '/',
      'Cache-Control': 'no-store'
    });
    res.end();
  } catch (err) {
    console.error('OAuth Callback Error:', err);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h3>令牌换取失败</h3><p>${err.message}</p><p><a href="/">返回首页</a></p>`);
  }
}

/**
 * Handle GET /auth/session
 */
export async function handleSession(req, res) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!session) {
    res.writeHead(200);
    res.end(JSON.stringify({ authenticated: false, defaultServer: DEFAULT_ALTERO_API }));
    return;
  }

  res.writeHead(200);
  res.end(JSON.stringify({
    authenticated: true,
    user: {
      id: session.userId,
      username: session.username,
      displayName: session.displayName
    },
    alteroApi: session.alteroApi,
    scopes: session.scopes
  }));
}

/**
 * Handle POST /auth/logout
 */
export async function handleLogout(req, res) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);

  if (session && session.refreshToken) {
    const alteroApi = session.alteroApi || DEFAULT_ALTERO_API;
    // Notify Altero to revoke token in background
    fetch(`${alteroApi}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        token: session.refreshToken,
        token_type_hint: 'refresh_token'
      }).toString()
    }).catch(err => console.warn('Token revocation notice failed:', err.message));
  }

  if (sessionId) {
    destroySession(sessionId);
  }

  clearSessionCookie(res, req);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(200);
  res.end(JSON.stringify({ success: true }));
}
