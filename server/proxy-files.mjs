import { getSessionIdFromRequest, getSession } from './session.mjs';
import { formatFetchError } from './auth.mjs';
import { fetchWithTimeout } from './oidc.mjs';
import { refreshAccessToken } from './proxy-api.mjs';
import { hasScope } from './security.mjs';
import { pipeWebBodyToNode } from './stream.mjs';

const DEFAULT_ALTERO_API = (process.env.ALTERO_API || 'http://localhost:8000').replace(/\/$/, '');

/**
 * Handle Streaming PDF File Proxy (/files/users/:userId/items/:key)
 */
export async function handleFilesProxy(req, res, url) {
  const sessionId = getSessionIdFromRequest(req);
  const session = getSession(sessionId);

  if (!session) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('401 Unauthorized: 请先登录以阅读文档附件');
    return;
  }
  if (session.authMode !== 'altero') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 当前本地认证模式未启用 Altero 外部文件代理');
    return;
  }
  if (!hasScope(session, 'files.read')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 当前会话缺少 files.read 权限');
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  // Parse path: /files/users/:id/items/:key or /files/groups/:id/items/:key
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 5 || parts[0] !== 'files' || !['users', 'groups'].includes(parts[1]) || parts[3] !== 'items') {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: 无效的附件访问路径');
    return;
  }

  const libraryType = parts[1];
  const libraryId = parts[2];
  const attachmentKey = parts[4];
  if (!/^[A-Za-z0-9_-]+$/.test(libraryId) || !/^[A-Za-z0-9_-]+$/.test(attachmentKey)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: 无效的用户或附件标识');
    return;
  }

  const allowed = session.userId === 'admin' || (libraryType === 'users'
    ? libraryId === session.userId
    : (session.groupIds || []).map(String).includes(libraryId));
  if (!allowed) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 无权访问该文库的附件文件');
    return;
  }

  const alteroApi = session.alteroApi || DEFAULT_ALTERO_API;
  // Build upstream Altero file content URL
  const upstreamUrl = `${alteroApi}/${libraryType}/${encodeURIComponent(libraryId)}/items/${encodeURIComponent(attachmentKey)}/file/content`;

  let token = session.accessToken;
  if (session.tokenExpiresAt && Date.now() > session.tokenExpiresAt - 60000) {
    token = await refreshAccessToken(session, sessionId) || token;
  }
  const forwardHeaders = {
    'Authorization': `Bearer ${token}`,
    'Zotero-API-Version': '3'
  };

  // Forward Range and caching headers from client
  if (req.headers['range']) {
    forwardHeaders['Range'] = req.headers['range'];
  }
  if (req.headers['if-range']) {
    forwardHeaders['If-Range'] = req.headers['if-range'];
  }
  if (req.headers['if-none-match']) {
    forwardHeaders['If-None-Match'] = req.headers['if-none-match'];
  }
  if (req.headers['if-modified-since']) {
    forwardHeaders['If-Modified-Since'] = req.headers['if-modified-since'];
  }

  try {
    let upstreamRes = await fetchWithTimeout(upstreamUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: forwardHeaders
    });
    if (upstreamRes.status === 401 && session.refreshToken) {
      const refreshed = await refreshAccessToken(session, sessionId);
      if (refreshed) {
        forwardHeaders.Authorization = `Bearer ${refreshed}`;
        upstreamRes = await fetchWithTimeout(upstreamUrl, {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers: forwardHeaders
        });
      }
    }

    const upstreamType = upstreamRes.headers.get('content-type') || '';
    if (upstreamRes.ok && upstreamType && !upstreamType.includes('pdf') && !upstreamType.includes('octet-stream')) {
      await upstreamRes.body?.cancel();
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('502 Bad Gateway: 上游附件类型不是 PDF');
      return;
    }

    const passHeaders = {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox",
      'Referrer-Policy': 'no-referrer'
    };

    const copyHeaderKeys = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'content-disposition',
      'etag',
      'last-modified',
      'zotero-api-version'
    ];

    for (const key of copyHeaderKeys) {
      const val = upstreamRes.headers.get(key);
      if (val) passHeaders[key] = val;
    }

    res.writeHead(upstreamRes.status, passHeaders);

    if (req.method === 'HEAD' || !upstreamRes.body) {
      res.end();
      return;
    }

    // Stream chunks directly from Altero to the client without buffering
    await pipeWebBodyToNode(upstreamRes.body, res);
    res.end();

  } catch (err) {
    console.error('File Streaming Proxy Error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`502 Bad Gateway: 附件流式传输失败: ${formatFetchError(err)}`);
    } else {
      res.destroy();
    }
  }
}
