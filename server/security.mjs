const rateBuckets = new Map();

export function isPrivateNetworkHost(hostname) {
  if (!hostname) return true;
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '::', '0.0.0.0'].includes(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:')) return true;
  const ipMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!ipMatch) return false;
  const octets = ipMatch.slice(1).map(Number);
  if (octets.some(value => value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function getRequestOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) {
    const configured = new URL(process.env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(configured.protocol) || configured.username || configured.password) {
      throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials');
    }
    return configured.origin;
  }

  const trustProxy = process.env.TRUST_PROXY === 'true';
  const forwardedProto = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const forwardedHost = trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  const host = forwardedHost || req.headers.host;
  if (!host || !['http', 'https'].includes(protocol)) throw new Error('Invalid request origin');

  const allowedHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (allowedHosts.length && !allowedHosts.includes(host)) throw new Error('Host is not allowed');
  return new URL(`${protocol}://${host}`).origin;
}

export function isSameOriginRequest(req, expectedOrigin) {
  const origin = req.headers?.origin;
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      return parsedOrigin.origin === expectedOrigin;
    } catch {
      return false;
    }
  }
  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
  return process.env.REQUIRE_ORIGIN !== 'true';
}

export function hasScope(session, ...acceptedScopes) {
  const scopes = new Set(session?.scopes || []);
  return acceptedScopes.some(scope => scopes.has(scope));
}

export function consumeRateLimit(req, bucketName, { limit, windowMs }) {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const address = forwarded || req.socket?.remoteAddress || 'unknown';
  const key = `${bucketName}:${address}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return {
    allowed: bucket.count <= limit,
    retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();
