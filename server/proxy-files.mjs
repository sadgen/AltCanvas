import { getSessionIdFromRequest, getSession } from './session.mjs';

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

  // Parse path: /files/users/:userId/items/:attachmentKey
  const parts = url.pathname.split('/').filter(Boolean); // ['files', 'users', '1', 'items', 'EID853QT']
  if (parts.length < 5 || parts[0] !== 'files' || parts[1] !== 'users' || parts[3] !== 'items') {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 Bad Request: 无效的附件访问路径');
    return;
  }

  const targetUserId = parts[2];
  const attachmentKey = parts[4];

  if (targetUserId !== session.userId && session.userId !== 'admin') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 无权访问该用户的附件文件');
    return;
  }

  const alteroApi = session.alteroApi || DEFAULT_ALTERO_API;
  // Build upstream Altero file content URL
  const upstreamUrl = `${alteroApi}/users/${encodeURIComponent(targetUserId)}/items/${encodeURIComponent(attachmentKey)}/file/content`;

  const forwardHeaders = {
    'Authorization': `Bearer ${session.accessToken}`,
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
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: forwardHeaders
    });

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
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();

  } catch (err) {
    console.error('File Streaming Proxy Error:', err);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`502 Bad Gateway: 附件流式传输失败: ${err.message}`);
    }
  }
}
