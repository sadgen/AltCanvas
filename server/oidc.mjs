import crypto from 'crypto';

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'altcanvas';
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 15000);
const discoveryCache = new Map();

function decodeBase64UrlJson(value, label) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error(`OIDC ${label} 不是有效的 JSON`);
  }
}

function endpointUrl(value, baseOrigin, label) {
  if (!value) return null;
  const endpoint = new URL(value);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error(`OIDC ${label} 地址无效`);
  }
  const base = new URL(baseOrigin);
  const isSameHost = endpoint.host === base.host;
  if (!isSameHost && endpoint.origin !== baseOrigin && process.env.OIDC_ALLOW_CROSS_ORIGIN_ENDPOINTS !== 'true') {
    throw new Error(`OIDC ${label} 必须与 Altero 节点同源`);
  }
  if (base.protocol === 'https:' && endpoint.protocol === 'http:' && isSameHost) {
    endpoint.protocol = 'https:';
  }
  if (endpoint.protocol !== 'https:' && process.env.ALLOW_INSECURE_OAUTH !== 'true') {
    throw new Error(`OIDC ${label} 必须使用 HTTPS`);
  }
  return endpoint.toString();
}

export async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function getOidcConfiguration(alteroApi, { force = false } = {}) {
  const base = new URL(alteroApi);
  const cacheKey = base.toString().replace(/\/$/, '');
  const cached = discoveryCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const discoveryUrl = new URL('/.well-known/openid-configuration', base.origin);
  const response = await fetchWithTimeout(discoveryUrl, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`OIDC discovery 失败 (HTTP ${response.status})`);

  const raw = await response.json();
  const issuer = String(raw.issuer || '');
  if (!issuer) throw new Error('OIDC discovery 缺少 issuer');
  const issuerUrl = new URL(issuer);
  const isSameHost = issuerUrl.host === base.host;
  if (!isSameHost && issuerUrl.origin !== base.origin && process.env.OIDC_ALLOW_CROSS_ORIGIN_ENDPOINTS !== 'true') {
    throw new Error('OIDC issuer 必须与 Altero 节点同源');
  }

  const value = {
    issuer,
    authorizationEndpoint: endpointUrl(raw.authorization_endpoint, base.origin, 'authorization_endpoint'),
    tokenEndpoint: endpointUrl(raw.token_endpoint, base.origin, 'token_endpoint'),
    userinfoEndpoint: raw.userinfo_endpoint
      ? endpointUrl(raw.userinfo_endpoint, base.origin, 'userinfo_endpoint')
      : null,
    jwksUri: raw.jwks_uri
      ? endpointUrl(raw.jwks_uri, base.origin, 'jwks_uri')
      : null,
    revocationEndpoint: raw.revocation_endpoint
      ? endpointUrl(raw.revocation_endpoint, base.origin, 'revocation_endpoint')
      : null
  };
  discoveryCache.set(cacheKey, { value, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
  return value;
}

function verifyJwtSignature(alg, signingInput, signature, key) {
  const data = Buffer.from(signingInput, 'ascii');
  if (alg === 'RS256') return crypto.verify('RSA-SHA256', data, key, signature);
  if (alg === 'PS256') {
    return crypto.verify('RSA-SHA256', data, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, signature);
  }
  if (alg === 'ES256') {
    return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  if (alg === 'EdDSA') return crypto.verify(null, data, key, signature);
  throw new Error(`不支持的 ID Token 签名算法: ${alg || 'missing'}`);
}

export async function verifyIdToken(idToken, configuration, expectedNonce) {
  if (!idToken || typeof idToken !== 'string') throw new Error('令牌响应缺少 ID Token');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('ID Token 格式无效');
  const header = decodeBase64UrlJson(parts[0], 'header');
  const claims = decodeBase64UrlJson(parts[1], 'claims');
  if (!['RS256', 'PS256', 'ES256', 'EdDSA'].includes(header.alg)) {
    throw new Error(`ID Token 使用了不允许的签名算法: ${header.alg || 'missing'}`);
  }

  if (configuration.jwksUri) {
    const jwksResponse = await fetchWithTimeout(configuration.jwksUri, {
      headers: { Accept: 'application/json' }
    });
    if (!jwksResponse.ok) throw new Error(`OIDC JWKS 获取失败 (HTTP ${jwksResponse.status})`);
    const jwks = await jwksResponse.json();
    const candidates = Array.isArray(jwks.keys) ? jwks.keys : [];
    const jwk = candidates.find(key => (!header.kid || key.kid === header.kid)
      && (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg));
    if (!jwk) throw new Error('JWKS 中找不到匹配的 ID Token 签名密钥');

    let publicKey;
    try {
      publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new Error('JWKS 签名密钥无效');
    }
    const signature = Buffer.from(parts[2], 'base64url');
    if (!verifyJwtSignature(header.alg, `${parts[0]}.${parts[1]}`, signature, publicKey)) {
      throw new Error('ID Token 签名验证失败');
    }
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== configuration.issuer) {
    try {
      const claimIss = new URL(claims.iss);
      const confIss = new URL(configuration.issuer);
      if (claimIss.host !== confIss.host || claimIss.pathname !== confIss.pathname) {
        throw new Error('ID Token issuer 不匹配');
      }
    } catch {
      throw new Error('ID Token issuer 不匹配');
    }
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(OAUTH_CLIENT_ID)) throw new Error('ID Token audience 不匹配');
  if (audiences.length > 1 && claims.azp !== OAUTH_CLIENT_ID) throw new Error('ID Token azp 不匹配');
  if (!Number.isFinite(claims.exp) || claims.exp < now - CLOCK_SKEW_SECONDS) throw new Error('ID Token 已过期或缺少 exp');
  if (Number.isFinite(claims.nbf) && claims.nbf > now + CLOCK_SKEW_SECONDS) throw new Error('ID Token 尚未生效');
  if (Number.isFinite(claims.iat) && claims.iat > now + CLOCK_SKEW_SECONDS) throw new Error('ID Token iat 无效');
  if (!claims.sub || typeof claims.sub !== 'string') throw new Error('ID Token 缺少 subject');
  if (!expectedNonce || claims.nonce !== expectedNonce) throw new Error('ID Token nonce 不匹配');
  return claims;
}

export function clientAuthenticationHeaders() {
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!clientSecret) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${OAUTH_CLIENT_ID}:${clientSecret}`).toString('base64')}`
  };
}

export function extractZoteroIdentity(claims) {
  const userId = claims.zotero_user_id ?? claims.user_id ?? claims.sub ?? claims.id;
  if (userId === undefined || userId === null || !/^[A-Za-z0-9_-]+$/.test(String(userId))) {
    throw new Error('ID Token 缺少有效的 Zotero user_id 映射');
  }
  const rawGroups = claims.zotero_groups ?? claims.groups ?? [];
  const groupIds = (Array.isArray(rawGroups) ? rawGroups : [])
    .map(group => typeof group === 'object' && group ? (group.id ?? group.group_id) : group)
    .filter(group => group !== undefined && group !== null)
    .map(String)
    .filter(group => /^[A-Za-z0-9_-]+$/.test(group));
  return {
    subject: String(claims.sub || userId),
    userId: String(userId),
    username: String(claims.preferred_username || claims.username || claims.name || claims.sub || userId),
    displayName: String(claims.name || claims.displayName || claims.preferred_username || claims.username || claims.sub || `User ${userId}`),
    groupIds
  };
}
