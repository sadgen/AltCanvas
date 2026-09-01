import { destroySession, getSessionIdFromRequest, getSession, updateSession } from './session.mjs';
import { formatFetchError } from './auth.mjs';
import { clientAuthenticationHeaders, fetchWithTimeout, getOidcConfiguration } from './oidc.mjs';
import { hasScope } from './security.mjs';
import { pipeWebBodyToNode } from './stream.mjs';

const DEFAULT_ALTERO_API = (process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, '');
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'altcanvas';
const refreshPromises = new Map();

/**
 * Check if the target route path matches our strict allowlist
 */
export function isAllowedApiPath(pathname, session) {
  if (!session || session.authMode !== 'altero') return false;
  const parts = pathname.split('/').filter(Boolean); // e.g. ['api', 'users', '1', 'items', 'top']
  if (parts[0] !== 'api') return false;

  // Allow /api/users/<userId>/[collections|items|tags|searches]...
  if (parts[1] === 'users') {
    const targetUserId = parts[2];
    if (targetUserId !== session.userId && session.userId !== 'admin') {
      return false; // Prevent IDOR (accessing other users' private libraries)
    }
    const resource = parts[3];
    return ['collections', 'items', 'tags', 'searches'].includes(resource);
  }

  // Allow /api/groups/<groupId>/[collections|items|tags]...
  if (parts[1] === 'groups') {
    const targetGroupId = parts[2];
    if (session.userId !== 'admin' && !session.groupIds?.includes(targetGroupId)) return false;
    const resource = parts[3];
    return ['collections', 'items', 'tags'].includes(resource);
  }

  return false;
}

/**
 * Refresh expired access token using session refresh token
 */
async function refreshAccessTokenOnce(session, sessionId) {
  if (!session.refreshToken) return null;
  const alteroApi = session.alteroApi || DEFAULT_ALTERO_API;

  try {
    const oidc = await getOidcConfiguration(alteroApi);
    const res = await fetchWithTimeout(oidc.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...clientAuthenticationHeaders()
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: session.refreshToken
      }).toString()
    });

    if (!res.ok) {
      console.warn('Silent token refresh rejected by upstream:', res.status);
      if ([400, 401, 403].includes(res.status)) destroySession(sessionId);
      return null;
    }

    const data = await res.json();
    if (!data.access_token || typeof data.access_token !== 'string') {
      console.warn('Silent token refresh response did not contain access_token');
      return null;
    }
    const now = Date.now();
    const expiresIn = Number(data.expires_in);
    const expiresAt = now + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86400) : 3600) * 1000;

    const updated = updateSession(sessionId, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || session.refreshToken,
      tokenExpiresAt: expiresAt,
      ...(data.scope ? { scopes: String(data.scope).split(' ').filter(Boolean) } : {})
    });

    return updated ? updated.accessToken : null;
  } catch (err) {
    console.error('Silent token refresh network error:', err);
    return null;
  }
}

export async function refreshAccessToken(session, sessionId) {
  const existing = refreshPromises.get(sessionId);
  if (existing) return existing;
  const refresh = refreshAccessTokenOnce(session, sessionId)
    .finally(() => refreshPromises.delete(sessionId));
  refreshPromises.set(sessionId, refresh);
  return refresh;
}

/**
 * Handle API Proxy requests (/api/* -> Altero API)
 */
export async function handleApiProxy(req, res, url) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);

  if (!session) {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'unauthorized', message: '未授权或会话已过期，请重新登录' }));
    return;
  }

  if (session.authMode !== 'altero') {
    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'external_library_disabled', message: '当前本地认证模式未启用 Altero 外部文库代理' }));
    return;
  }

  const pathname = url.pathname;
  if (!isAllowedApiPath(pathname, session)) {
    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'forbidden', message: '访问被拒绝：路径未在允许列表中或存在跨用户越权访问' }));
    return;
  }

  const isRead = ['GET', 'HEAD'].includes(req.method);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE' });
    res.end();
    return;
  }
  if (isRead ? !hasScope(session, 'library.read') : !hasScope(session, 'library.write')) {
    res.writeHead(403, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ error: 'insufficient_scope', message: '当前会话缺少所需的文库权限' }));
    return;
  }

  // Preemptive token refresh if within 60 seconds of expiry
  let token = session.accessToken;
  if (session.tokenExpiresAt && Date.now() > session.tokenExpiresAt - 60000) {
    const refreshed = await refreshAccessToken(session, sessionId);
    if (refreshed) token = refreshed;
  }

  const alteroApi = session.alteroApi || DEFAULT_ALTERO_API;
  // Construct target Altero URL (replace /api with empty prefix)
  const targetPath = pathname.replace(/^\/api/, '');
  const targetUrl = new URL(`${alteroApi}${targetPath}`);
  targetUrl.search = url.search;

  // Prepare upstream headers
  const forwardHeaders = {
    'Authorization': `Bearer ${token}`,
    'Zotero-API-Version': '3',
    'Accept': req.headers['accept'] || 'application/json'
  };

  if (req.headers['content-type']) {
    forwardHeaders['Content-Type'] = req.headers['content-type'];
  }
  if (req.headers['if-unmodified-since-version']) {
    forwardHeaders['If-Unmodified-Since-Version'] = req.headers['if-unmodified-since-version'];
  }
  if (req.headers['if-match']) {
    forwardHeaders['If-Match'] = req.headers['if-match'];
  }
  if (req.headers['zotero-write-token']) {
    forwardHeaders['Zotero-Write-Token'] = req.headers['zotero-write-token'];
  }

  // Read request body if present
  let bodyBuffer = null;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const maxBodyBytes = Number(process.env.MAX_API_BODY_BYTES || 1024 * 1024);
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxBodyBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'payload_too_large' }));
      return;
    }
    const chunks = [];
    let receivedBytes = 0;
    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBodyBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
    }
    if (chunks.length > 0) {
      bodyBuffer = Buffer.concat(chunks);
    }
  }

  async function executeUpstream(currentToken) {
    forwardHeaders['Authorization'] = `Bearer ${currentToken}`;
    return await fetchWithTimeout(targetUrl.toString(), {
      method: req.method,
      headers: forwardHeaders,
      body: bodyBuffer
    });
  }

  try {
    let upstreamRes = await executeUpstream(token);

    // If upstream returns 401 Unauthorized, attempt immediate one-time token refresh
    if (upstreamRes.status === 401 && session.refreshToken) {
      const refreshed = await refreshAccessToken(session, sessionId);
      if (refreshed) {
        token = refreshed;
        upstreamRes = await executeUpstream(token);
      }
    }

    // Forward response headers
    const passHeaders = {
      'Cache-Control': 'no-store, no-cache',
      'X-Content-Type-Options': 'nosniff'
    };

    const copyHeaderKeys = [
      'content-type',
      'zotero-api-version',
      'last-modified-version',
      'link',
      'total-results',
      'etag'
    ];

    for (const key of copyHeaderKeys) {
      const val = upstreamRes.headers.get(key);
      if (val) passHeaders[key] = val;
    }

    res.writeHead(upstreamRes.status, passHeaders);

    // Stream upstream response body directly to client
    if (upstreamRes.body) {
      await pipeWebBodyToNode(upstreamRes.body, res);
    }
    res.end();
  } catch (err) {
    console.error('API Proxy Upstream Error:', err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'bad_gateway', message: `上游 Altero 服务通信异常: ${formatFetchError(err)}` }));
  }
}
