import crypto from 'crypto';
import dns from 'dns/promises';
import {
  generateRandomToken,
  storeAuthTransaction,
  consumeAuthTransaction,
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getSessionIdFromRequest,
  parseCookies
} from './session.mjs';
import {
  clientAuthenticationHeaders,
  extractZoteroIdentity,
  fetchWithTimeout,
  getOidcConfiguration,
  verifyIdToken
} from './oidc.mjs';
import { isPrivateNetworkHost } from './security.mjs';
import { canvasActorKey } from './canvas-store.mjs';

const DEFAULT_ALTERO_API = (process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, '');
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'altcanvas';
const DEFAULT_SCOPES = 'openid profile library.read library.write annotations.read annotations.write files.read';
const OAUTH_BINDING_COOKIE = 'altcanvas_oauth_binding';

function tokenHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isSecureRequest(req) {
  return process.env.PUBLIC_ORIGIN?.startsWith('https://') || req.socket?.encrypted
    || (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https');
}

function oauthBindingCookie(value, req, maxAge) {
  const parts = [
    `${OAUTH_BINDING_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/auth/callback',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

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
  if (process.env.ALLOW_PRIVATE_HOSTS === 'true') return false;
  return isPrivateNetworkHost(hostname);
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

async function assertSafeAlteroResolution(alteroApi) {
  if (process.env.ALLOW_PRIVATE_HOSTS === 'true') return;
  const { hostname } = new URL(alteroApi);
  if (isPrivateHost(hostname)) throw new Error('Altero 节点不能指向本机或私有网络');
  if (/[:]/.test(hostname) || /^\d+(?:\.\d+){3}$/.test(hostname)) return;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateHost(address))) {
    throw new Error('Altero 节点解析到了不允许的网络地址');
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
  const requestedAlteroApi = url.searchParams.get('altero_api') || url.searchParams.get('server');
  const alteroApi = sanitizeAlteroUrl(requestedAlteroApi);
  const configuredAlteroApi = sanitizeAlteroUrl(DEFAULT_ALTERO_API);
  if (requestedAlteroApi && alteroApi !== configuredAlteroApi && process.env.ALLOW_DYNAMIC_ALTERO !== 'true') {
    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({
      error: 'dynamic_altero_disabled',
      message: '此部署未启用用户自选 Altero 节点'
    }));
    return;
  }
  const state = generateRandomToken(24);
  const nonce = generateRandomToken(24);
  const codeVerifier = generateRandomToken(32);
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const binding = generateRandomToken(24);

  let oidc;
  try {
    await assertSafeAlteroResolution(alteroApi);
    oidc = await getOidcConfiguration(alteroApi);
  } catch (err) {
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'oidc_discovery_failed', message: formatFetchError(err) }));
    return;
  }

  storeAuthTransaction({
    state,
    nonce,
    codeVerifier,
    returnTo,
    alteroApi,
    issuer: oidc.issuer,
    bindingHash: tokenHash(binding)
  });

  const redirectUri = `${selfOrigin}/auth/callback`;
  const authUrl = new URL(oidc.authorizationEndpoint);
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
    'Cache-Control': 'no-store',
    'Set-Cookie': oauthBindingCookie(binding, req, 600)
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
  const binding = parseCookies(req)[OAUTH_BINDING_COOKIE];
  const actualBindingHash = binding ? tokenHash(binding) : '';
  const expectedBinding = Buffer.from(tx.bindingHash || '', 'hex');
  const actualBinding = Buffer.from(actualBindingHash, 'hex');
  if (!expectedBinding.length || expectedBinding.length !== actualBinding.length
      || !crypto.timingSafeEqual(expectedBinding, actualBinding)) {
    res.writeHead(302, {
      'Location': `/?auth_error=${encodeURIComponent('授权浏览器绑定无效，请重新发起登录')}`,
      'Cache-Control': 'no-store',
      'Set-Cookie': oauthBindingCookie('', req, 0)
    });
    res.end();
    return;
  }

  const redirectUri = `${selfOrigin}/auth/callback`;
  const alteroApi = tx.alteroApi || DEFAULT_ALTERO_API;

  try {
    const oidc = await getOidcConfiguration(alteroApi);
    if (oidc.issuer !== tx.issuer) throw new Error('OIDC issuer 在登录过程中发生变化');
    const tokenRes = await fetchWithTimeout(oidc.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...clientAuthenticationHeaders()
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
    if (!tokenData.access_token || typeof tokenData.access_token !== 'string') {
      throw new Error('令牌响应缺少 access_token');
    }
    if (tokenData.token_type && String(tokenData.token_type).toLowerCase() !== 'bearer') {
      throw new Error('令牌响应使用了不支持的 token_type');
    }
    let claims;
    if (tokenData.id_token) {
      claims = await verifyIdToken(tokenData.id_token, oidc, tx.nonce);
    } else if (oidc.userinfoEndpoint) {
      const userinfoRes = await fetchWithTimeout(oidc.userinfoEndpoint, {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Accept': 'application/json'
        }
      });
      if (!userinfoRes.ok) {
        throw new Error(`获取用户信息失败 (HTTP ${userinfoRes.status})`);
      }
      claims = await userinfoRes.json();
    } else {
      throw new Error('Altero 未返回 ID Token 或 UserInfo 端点');
    }
    const identity = extractZoteroIdentity(claims);
    const now = Date.now();
    const expiresIn = Number(tokenData.expires_in);
    const expiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86400) : 3600) * 1000;

    const session = createSession({
      userId: identity.userId,
      subject: identity.subject,
      username: identity.username,
      displayName: identity.displayName,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      scopes: tokenData.scope ? tokenData.scope.split(' ') : DEFAULT_SCOPES.split(' '),
      groupIds: identity.groupIds,
      alteroApi,
      issuer: oidc.issuer
    });

    setSessionCookie(res, session.id, req);
    res.setHeader('Set-Cookie', [
      ...(Array.isArray(res.getHeader('Set-Cookie')) ? res.getHeader('Set-Cookie') : [res.getHeader('Set-Cookie')]),
      oauthBindingCookie('', req, 0)
    ]);

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

export function getAuthMode() {
  if (process.env.AUTH_MODE === 'altero') return 'altero';
  if (process.env.AUTH_MODE === 'local') return 'local';
  return 'local';
}

async function readRequestBody(req, maxBytes = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const err = new Error('Request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

export function isLocalAuthAllowed() {
  const mode = getAuthMode();
  if (mode === 'local') return true;
  return process.env.ALLOW_LOCAL_AUTH_IN_ALTERO === 'true';
}

/**
 * Handle POST /auth/setup (Local Admin Initialization)
 */
export async function handleLocalSetup(req, res, store) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!isLocalAuthAllowed()) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'local_auth_disabled', message: '当前部署模式未启用本地账户认证' }));
    return;
  }

  if (!store) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'store_unavailable', message: 'Storage not available' }));
    return;
  }

  if (store.hasUsers()) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'already_initialized', message: '系统已初始化，管理员账户已存在' }));
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    res.writeHead(err.status || 400);
    res.end(JSON.stringify({ error: 'invalid_request', message: err.message }));
    return;
  }

  const { username, password } = body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 3) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid_username', message: '用户名至少需要 3 个字符' }));
    return;
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid_password', message: '密码至少需要 8 个字符' }));
    return;
  }

  let user;
  try {
    user = store.createUser({ username, password, role: 'admin' });
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'creation_failed', message: err.message }));
    return;
  }

  const session = createSession({
    userId: user.id,
    subject: user.id,
    username: user.username,
    displayName: user.username,
    role: user.role,
    authMode: 'local',
    scopes: ['*'],
    expiresAt: Date.now() + 30 * 86400 * 1000,
    issuer: 'local',
    actorKey: canvasActorKey('local', user.id)
  });

  setSessionCookie(res, session.id, req);
  res.writeHead(201);
  res.end(JSON.stringify({
    data: {
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    }
  }));
}

/**
 * Handle POST /auth/login (Local Password Authentication)
 */
export async function handleLocalLogin(req, res, store) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (!isLocalAuthAllowed()) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'local_auth_disabled', message: '当前部署模式未启用本地账户认证' }));
    return;
  }

  if (!store) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'store_unavailable', message: 'Storage not available' }));
    return;
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    res.writeHead(err.status || 400);
    res.end(JSON.stringify({ error: 'invalid_request', message: err.message }));
    return;
  }

  const { username, password } = body || {};
  if (!username || !password) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'missing_credentials', message: '请输入用户名和密码' }));
    return;
  }

  const user = store.verifyUserPassword(username, password);
  if (!user) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'invalid_credentials', message: '用户名或密码错误' }));
    return;
  }

  const session = createSession({
    userId: user.id,
    subject: user.id,
    username: user.username,
    displayName: user.username,
    role: user.role,
    authMode: 'local',
    scopes: ['*'],
    expiresAt: Date.now() + 30 * 86400 * 1000,
    issuer: 'local',
    actorKey: canvasActorKey('local', user.id)
  });

  setSessionCookie(res, session.id, req);
  res.writeHead(200);
  res.end(JSON.stringify({
    data: {
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    }
  }));
}

/**
 * Handle GET /auth/session
 */
export async function handleSession(req, res, store = null) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);
  const authMode = getAuthMode();
  const needsSetup = authMode === 'local' && store ? !store.hasUsers() : false;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const allowDirectMode = process.env.NODE_ENV !== 'production' && process.env.ALLOW_DIRECT_AUTH !== 'false';
  const allowDynamicAltero = process.env.ALLOW_DYNAMIC_ALTERO === 'true';

  if (!session) {
    res.writeHead(200);
    res.end(JSON.stringify({
      authenticated: false,
      authMode,
      needsSetup,
      allowDirectMode,
      allowDynamicAltero,
      defaultAlteroApi: DEFAULT_ALTERO_API
    }));
    return;
  }

  const isAltero = (session.authMode || authMode) === 'altero';
  const capabilities = {
    nativeUpload: true,
    collections: isAltero,
    upstreamSync: isAltero,
    externalLibrary: isAltero
  };

  res.writeHead(200);
  res.end(JSON.stringify({
    authenticated: true,
    authMode: session.authMode || authMode,
    capabilities,
    user: {
      id: session.userId,
      username: session.username,
      displayName: session.displayName || session.username,
      role: session.role || 'user'
    },
    library: {
      id: session.userId,
      type: isAltero ? 'user' : 'native'
    },
    alteroApi: session.alteroApi || null,
    scopes: session.scopes || ['*'],
    needsSetup: false,
    allowDirectMode,
    allowDynamicAltero,
    defaultAlteroApi: DEFAULT_ALTERO_API
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
    getOidcConfiguration(alteroApi).then(oidc => {
      if (!oidc.revocationEndpoint) return;
      return fetchWithTimeout(oidc.revocationEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...clientAuthenticationHeaders()
        },
        body: new URLSearchParams({
          client_id: OAUTH_CLIENT_ID,
          token: session.refreshToken,
          token_type_hint: 'refresh_token'
        }).toString()
      });
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
