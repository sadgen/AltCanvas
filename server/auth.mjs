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

// Allow self-signed TLS certificates for self-hosted Altero instances unless explicitly configured
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const DEFAULT_ALTERO_API = (process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, '');
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'altcanvas';
const DEFAULT_SCOPES = 'openid profile library.read library.write annotations.read annotations.write files.read';

/**
 * Format fetch/network error including cause details
 */
export function formatFetchError(err) {
  if (!err) return '未知错误';
  if (err.cause) {
    const cause = err.cause;
    if (cause instanceof Error) {
      return `${err.message} (${cause.message || cause.code || '网络/SSL连接异常'})`;
    }
    if (typeof cause === 'object') {
      if (Array.isArray(cause.errors) && cause.errors.length > 0) {
        const errDetails = cause.errors.map(e => e.message || e.code || String(e)).join('; ');
        return `${err.message} (${errDetails})`;
      }
      if (cause.code || cause.message) {
        return `${err.message} (${cause.code || cause.message})`;
      }
      try {
        return `${err.message} (${JSON.stringify(cause)})`;
      } catch {
        return `${err.message} (${String(cause)})`;
      }
    }
    return `${err.message} (${String(cause)})`;
  }
  return err.message || String(err);
}

/**
 * Generate PKCE S256 code challenge from verifier
 */
export function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Check if a hostname/IP is private/internal (SSRF protection)
 */
export function isPrivateHost(hostname) {
  if (!hostname) return true;
  if (process.env.ALLOW_PRIVATE_HOSTS === 'true') return false;

  // Remove IPv6 square brackets and normalize
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Localhost and all-zeros
  if (['localhost', '127.0.0.1', '::1', '::', '0.0.0.0'].includes(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;

  // IPv6 Link-Local (fe80::/10), Unique Local Address (fc00::/7, fd00::/8), and IPv4-mapped (::ffff:)
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:')) {
    return true;
  }

  // IPv4 private ranges
  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-Local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
  }
  return false;
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
    // Block SSRF to local/private network
    if (isPrivateHost(u.hostname)) {
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
    const errorMsg = `授权失败: ${error}${errorDesc ? ` (${errorDesc})` : ' (用户取消或拒绝授权)'}`;
    res.writeHead(302, {
      'Location': `/?auth_error=${encodeURIComponent(errorMsg)}`,
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }

  if (!code || !state) {
    res.writeHead(302, {
      'Location': `/?auth_error=${encodeURIComponent('缺少授权参数 (code 或 state)')}`,
      'Cache-Control': 'no-store'
    });
    res.end();
    return;
  }

  const tx = consumeAuthTransaction(state);
  if (!tx) {
    res.writeHead(302, {
      'Location': `/?auth_error=${encodeURIComponent('授权会话已过期或无效，请重新发起登录')}`,
      'Cache-Control': 'no-store'
    });
    res.end();
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
      let errDetail = '';
      try {
        const errJson = await tokenRes.json();
        errDetail = errJson.error_description || errJson.error || JSON.stringify(errJson);
      } catch {
        errDetail = await tokenRes.text();
      }
      throw new Error(`Altero 拒绝换取令牌 (HTTP ${tokenRes.status}${errDetail ? `: ${errDetail}` : ''})`);
    }

    const tokenData = await tokenRes.json();
    const now = Date.now();
    const expiresAt = tokenData.expires_in ? now + tokenData.expires_in * 1000 : now + 3600 * 1000;

    const session = createSession({
      userId: String(tokenData.user_id || tokenData.userId || '1'),
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
    const detailedMessage = formatFetchError(err);
    console.error('OAuth Callback Error:', err);
    res.writeHead(302, {
      'Location': `/?auth_error=${encodeURIComponent(`令牌换取失败: ${detailedMessage}`)}`,
      'Cache-Control': 'no-store'
    });
    res.end();
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
    res.end(JSON.stringify({ authenticated: false }));
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
