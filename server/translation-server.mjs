import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isPrivateNetworkHost } from './security.mjs';

// M3.1 Translation Server adapter.
//
// Security contract (audited):
//  - The server address comes ONLY from server-side configuration
//    (TRANSLATION_SERVER_URL). Callers supply input text, never an address.
//  - Loopback and Unix-socket targets are the trusted default; any remote
//    target additionally requires ALLOW_REMOTE_TRANSLATION_SERVER=true and
//    passes a full SSRF gate: DNS is ALWAYS resolved (allowPrivate only
//    decides acceptance, never whether resolution/pinning happens), private
//    ranges are rejected unless explicitly allowed, and the connection is
//    pinned to the validated addresses — never falling back to system DNS.
//  - Redirects are NEVER followed: a 3xx response is an error.
//  - A single total deadline covers the WHOLE task (target resolution/DNS,
//    connection, headers, body, parsing). The connect timer is cleared once
//    the socket connects; the response timer then covers waiting for headers
//    AND reading the body. Every timeout destroys the request and socket.
//  - Request and response bodies are size-capped (final serialized request
//    body included).
//  - This module only PARSES. It performs no database or Blob writes; its
//    output is a DTO intended for normalizeNativeImportItem + the M2 executor.

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;       // 1 MiB serialized request body
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;  // 2 MiB parsed metadata
const MAX_CREATORS = 100;                          // collection element cap

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class TranslationError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'TranslationError';
    this.code = code;
  }
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTranslationServerConfig(env = process.env) {
  const rawUrl = String(env.TRANSLATION_SERVER_URL || '').trim();
  return {
    url: rawUrl || null,
    connectTimeoutMs: positiveInt(env.TRANSLATION_CONNECT_TIMEOUT_MS, 5_000),
    responseTimeoutMs: positiveInt(env.TRANSLATION_RESPONSE_TIMEOUT_MS, 30_000),
    totalTimeoutMs: positiveInt(env.TRANSLATION_TOTAL_TIMEOUT_MS, 60_000),
    allowRemote: env.ALLOW_REMOTE_TRANSLATION_SERVER === 'true',
    allowPrivate: env.ALLOW_PRIVATE_TRANSLATION_HOSTS === 'true'
  };
}

export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  const clean = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isLoopbackAddress(clean);
}

// Any address inside 127.0.0.0/8 or the IPv6 loopback ::1.
function isLoopbackAddress(address) {
  const addr = String(address || '');
  return addr.startsWith('127.') || addr === '::1';
}

function isIpLiteral(hostname) {
  const host = String(hostname || '');
  return /^\d+\.\d+\.\d+\.\d+$/.test(host)
    || (host.startsWith('[') && host.endsWith(']'))
    || host.includes(':');
}

async function resolveHostAddresses(hostname, lookupFn) {
  const lookup = typeof lookupFn === 'function' ? lookupFn : dns.lookup;
  const result = await lookup(hostname, { all: true, verbatim: true });
  const list = Array.isArray(result) ? result : [result];
  return list
    .map(record => (typeof record === 'string' ? { address: record, family: record.includes(':') ? 6 : 4 } : record))
    .filter(record => record && typeof record.address === 'string' && record.address.length > 0);
}

// Resolve the configured target into a transport description.
//   { kind: 'disabled' }
//   { kind: 'socket', socketPath }
//   { kind: 'loopback', parsed, pinnedAddresses }
//   { kind: 'remote', parsed, pinnedAddresses }
// Every network target carries pinnedAddresses: the connection is dialed to a
// validated address and NEVER falls back to a second system-DNS resolution.
export async function resolveTranslationTarget(config, { lookupFn } = {}) {
  if (!config.url) return { kind: 'disabled' };

  if (config.url.startsWith('unix://')) {
    const socketPath = decodeURIComponent(new URL(config.url).pathname);
    if (!socketPath || socketPath === '/') {
      throw new TranslationError('invalid_target', 'unix:// translation target requires a socket path');
    }
    return { kind: 'socket', socketPath };
  }

  let parsed;
  try {
    parsed = new URL(config.url);
  } catch {
    throw new TranslationError('invalid_target', 'TRANSLATION_SERVER_URL is not a valid URL');
  }
  if (parsed.username || parsed.password) {
    throw new TranslationError('invalid_target', 'embedded credentials are not allowed in TRANSLATION_SERVER_URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TranslationError('invalid_target', 'translation target must be http(s) or unix://');
  }

  const hostname = parsed.hostname.toLowerCase();

  // IP-literal loopback: any 127.0.0.0/8 address or IPv6 ::1 literal.
  const cleanHost = (hostname.startsWith('[') && hostname.endsWith(']'))
    ? hostname.slice(1, -1)
    : hostname;
  if (isLoopbackAddress(cleanHost)) {
    return {
      kind: 'loopback',
      parsed,
      pinnedAddresses: [{ address: cleanHost, family: cleanHost.includes(':') ? 6 : 4 }]
    };
  }

  // The 'localhost' name must resolve and every result must be loopback.
  if (hostname === 'localhost') {
    const addresses = await resolveHostAddresses(hostname, lookupFn);
    if (!addresses.length) {
      throw new TranslationError('invalid_target', 'localhost resolved to no addresses; refusing to dial');
    }
    for (const record of addresses) {
      if (!isLoopbackAddress(record.address)) {
        throw new TranslationError(
          'invalid_target',
          `localhost resolved to non-loopback address ${record.address}; refusing to dial`
        );
      }
    }
    // Prefer the IPv4 loopback when available: dual-stack hosts list ::1 first
    // verbatim, and the conventional AltCanvas listener binds 127.0.0.1.
    const preferred = addresses.find(a => !String(a.address).includes(':')) ?? addresses[0];
    return { kind: 'loopback', parsed, pinnedAddresses: [preferred] };
  }

  if (!config.allowRemote) {
    throw new TranslationError(
      'remote_target_forbidden',
      'remote translation server requires ALLOW_REMOTE_TRANSLATION_SERVER=true; prefer a loopback or unix:// target'
    );
  }

  // Remote target: DNS is ALWAYS resolved so the connection can be pinned.
  // allowPrivate only decides acceptance of private ranges, never whether
  // resolution and pinning happen.
  const addresses = await resolveHostAddresses(hostname, lookupFn);
  if (!addresses.length) {
    throw new TranslationError(
      'invalid_target',
      `translation host ${hostname} resolved to no usable addresses; refusing to fall back to system DNS`
    );
  }
  if (!config.allowPrivate) {
    for (const record of addresses) {
      if (isPrivateNetworkHost(record.address)) {
        throw new TranslationError(
          'forbidden_address',
          `translation host ${hostname} resolves to forbidden private address ${record.address}`
        );
      }
    }
  }
  return { kind: 'remote', parsed, pinnedAddresses: addresses };
}

// Single-shot HTTP(S) request with socketPath support, pinned dialing,
// connect/response/total timers with correct lifecycle, and response size
// capping. `transportFn` injection keeps this deterministic in tests.
async function httpJsonRequest(target, { payload, bodyBuffer }, config, { transportFn, deadline }) {
  if (typeof transportFn === 'function') {
    // Injected transports must obey the same hard total deadline as the real
    // transport; otherwise a hanging test/adapter could stall forever.
    let timer;
    try {
      return await Promise.race([
        transportFn(target, payload, config),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(
            new TranslationError('total_timeout', `translation task exceeded total timeout of ${config.totalTimeoutMs}ms`)
          ), Math.max(0, deadline - Date.now()));
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const isHttps = target.kind !== 'socket' && target.parsed.protocol === 'https:';
  const requester = isHttps ? https.request : http.request;

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': bodyBuffer.length
    }
  };
  if (target.kind === 'socket') {
    options.socketPath = target.socketPath;
  } else {
    options.hostname = target.parsed.hostname;
    options.port = target.parsed.port || (isHttps ? 443 : 80);
    options.path = `${target.parsed.pathname}${target.parsed.search}`;
    options.servername = target.parsed.hostname;
    if (target.pinnedAddresses?.length) {
      // Node calls custom lookups in BOTH modes: with {all:true} (records array)
      // and without (single ip+family). Honor whichever mode is requested and
      // return ONLY validated addresses — never re-resolve via system DNS.
      const records = target.pinnedAddresses.map(a => ({
        address: a.address,
        family: a.family || (a.address.includes(':') ? 6 : 4)
      }));
      options.lookup = (h, opt, cb) => {
        if (opt && opt.all) cb(null, records);
        else cb(null, records[0].address, records[0].family);
      };
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer = null;
    let responseTimer = null;
    let req = null;
    let activeSocket = null;

    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
    };
    const finish = (fn, ...args) => {
      if (settled) return;
      settled = true;
      clearTimers();
      fn(...args);
    };
    const destroyConnection = () => {
      try { req?.destroy(); } catch {}
      try { activeSocket?.destroy(); } catch {}
    };

    // Total deadline: covers connection establishment, headers, and body.
    const totalRemaining = deadline - Date.now();
    if (totalRemaining <= 0) {
      finish(reject, new TranslationError('total_timeout', `translation task exceeded total timeout of ${config.totalTimeoutMs}ms`));
      return;
    }
    const totalTimer = setTimeout(() => {
      destroyConnection();
      finish(reject, new TranslationError('total_timeout', `translation task exceeded total timeout of ${config.totalTimeoutMs}ms`));
    }, totalRemaining);
    const originalFinish = finish;
    // ensure total timer cleared on any settlement
    const wrapFinish = (fn) => (...args) => { clearTimeout(totalTimer); originalFinish(fn, ...args); };
    const rejectWith = wrapFinish(reject);
    const resolveWith = wrapFinish(resolve);

    // Connect timer: armed now, cleared the moment the socket connects.
    connectTimer = setTimeout(() => {
      destroyConnection();
      rejectWith(new TranslationError('connect_timeout', `translation connection exceeded ${config.connectTimeoutMs}ms`));
    }, config.connectTimeoutMs);

    const armResponseTimer = () => {
      if (responseTimer || settled) return;
      // Response timer: covers waiting for headers AND reading the body,
      // armed as soon as the connection is established.
      responseTimer = setTimeout(() => {
        destroyConnection();
        rejectWith(new TranslationError('response_timeout', `translation response exceeded ${config.responseTimeoutMs}ms`));
      }, config.responseTimeoutMs);
    };

    const connected = () => {
      clearTimeout(connectTimer);
      armResponseTimer();
    };

    req = requester(options, (res) => {
      connected(); // Idempotent fallback: if headers arrived, socket is definitely connected
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BODY_BYTES) {
          destroyConnection();
          rejectWith(new TranslationError('response_too_large', `translation response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolveWith({
          status: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
      res.on('error', (err) => {
        rejectWith(new TranslationError('transport_error', err.message));
      });
    });

    req.on('socket', (sock) => {
      activeSocket = sock;
      if (!sock.connecting) {
        // Reused Keep-Alive socket: already connected, switch immediately to response timer
        connected();
      } else {
        sock.once('connect', connected);
        sock.once('secureConnect', connected);
      }
    });

    req.on('error', (err) => {
      rejectWith(new TranslationError('transport_error', err.message));
    });
    req.end(bodyBuffer);
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Strict validation of the translation server payload. Unknown fields are
// dropped; every retained field is type-, length-, and cardinality-checked.
export function validateTranslationPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TranslationError('invalid_payload', 'translation response must be a JSON object');
  }
  if (data.ok === false) {
    return { ok: false, error: String(data.error || 'translation failed').slice(0, 500) };
  }
  if (data.ok !== true) {
    throw new TranslationError('invalid_payload', 'translation response must carry an explicit ok flag');
  }

  const out = { ok: true, sourceType: '', title: '' };

  if (typeof data.sourceType !== 'string' || !data.sourceType || data.sourceType.length > 64) {
    throw new TranslationError('invalid_payload', 'sourceType must be a non-empty string of at most 64 characters');
  }
  out.sourceType = data.sourceType;

  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500) {
    throw new TranslationError('invalid_payload', 'title must be a non-empty string of at most 500 characters');
  }
  out.title = data.title.trim();

  if (data.creators !== undefined && data.creators !== null) {
    if (!Array.isArray(data.creators)) {
      throw new TranslationError('invalid_payload', 'creators must be an array');
    }
    if (data.creators.length > MAX_CREATORS) {
      throw new TranslationError('invalid_payload', `creators must contain at most ${MAX_CREATORS} entries`);
    }
    out.creators = data.creators.map(c => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        throw new TranslationError('invalid_payload', 'creators entries must be objects');
      }
      const entry = {};
      for (const field of ['creatorType', 'firstName', 'lastName', 'name']) {
        if (c[field] !== undefined && c[field] !== null) {
          if (typeof c[field] !== 'string' || c[field].length > 200) {
            throw new TranslationError('invalid_payload', `creators.${field} must be a string of at most 200 characters`);
          }
          entry[field] = c[field];
        }
      }
      // A creator with no name-ish field carries no information and would only
      // amplify into empty database rows downstream.
      if (!entry.firstName && !entry.lastName && !entry.name) {
        throw new TranslationError('invalid_payload', 'creators entries must carry at least one of firstName, lastName, or name');
      }
      return entry;
    });
  }

  if (data.year !== undefined && data.year !== null) {
    if (typeof data.year !== 'number' || !Number.isInteger(data.year) || data.year < 1400 || data.year > 2200) {
      throw new TranslationError('invalid_payload', 'year must be an integer between 1400 and 2200');
    }
    out.year = data.year;
  }

  const STRING_FIELDS = { doi: 2000, url: 2000, isbn: 64, arxivId: 64, abstractNote: 20_000, pdfUrl: 2000 };
  for (const [field, maxLen] of Object.entries(STRING_FIELDS)) {
    if (data[field] === undefined || data[field] === null) continue;
    if (typeof data[field] !== 'string' || data[field].length > maxLen) {
      throw new TranslationError('invalid_payload', `${field} must be a string of at most ${maxLen} characters`);
    }
    if (data[field]) out[field] = data[field];
  }
  if (out.pdfUrl && !/^https?:\/\//i.test(out.pdfUrl)) {
    throw new TranslationError('invalid_payload', 'pdfUrl must be an http(s) URL');
  }

  return out;
}

// Convert a validated translation result into an import-item DTO that flows
// through normalizeNativeImportItem and the M2 unified executor.
export function translationResultToImportItem(result) {
  if (!result || result.ok !== true) {
    throw new TypeError('translationResultToImportItem requires an ok:true result');
  }
  return {
    sourceType: result.sourceType,
    title: result.title,
    abstract: result.abstractNote || null,
    creators: result.creators || [],
    year: result.year ?? null,
    doi: result.doi || null,
    url: result.url || null,
    isbn: result.isbn || null,
    arxivId: result.arxivId || null,
    pdfUrl: result.pdfUrl || null
  };
}

// Primary entry: parse an input via the configured Translation Server.
// Never writes to the database or Blob storage. A single total deadline
// starts HERE and covers target resolution (DNS), connection, headers,
// body, and parsing.
export async function callTranslationServer({ input, format = null }, {
  config = getTranslationServerConfig(),
  lookupFn = null,
  transportFn = null
} = {}) {
  const deadline = Date.now() + config.totalTimeoutMs;

  let targetTimer = null;
  let target;
  try {
    target = await Promise.race([
      resolveTranslationTarget(config, lookupFn ? { lookupFn } : {}),
      new Promise((_, reject) => {
        targetTimer = setTimeout(() => reject(
          new TranslationError('total_timeout', `translation task exceeded total timeout of ${config.totalTimeoutMs}ms`)
        ), Math.max(0, deadline - Date.now()));
      })
    ]);
  } finally {
    clearTimeout(targetTimer);
  }
  if (target.kind === 'disabled') {
    return { available: false, reason: 'translation_server_not_configured' };
  }

  if (typeof input !== 'string' || !input.trim()) {
    throw new TranslationError('invalid_input', 'input must be a non-empty string');
  }
  if (format !== null && format !== undefined) {
    if (typeof format !== 'string' || format.length > 32) {
      throw new TranslationError('invalid_input', 'format must be a string of at most 32 characters');
    }
  }

  const payload = { input, format };
  const bodyBuffer = Buffer.from(JSON.stringify(payload), 'utf8');
  // Final serialized-size gate: the declared request cap applies to the body
  // actually put on the wire (JSON envelope included), shared by the real
  // and injected transports.
  if (bodyBuffer.length > MAX_REQUEST_BODY_BYTES) {
    throw new TranslationError('request_too_large', `serialized request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
  }

  const response = await httpJsonRequest(target, { payload, bodyBuffer }, config, { transportFn, deadline });

  // Belt-and-braces: the real transport enforces the cap while streaming; any
  // returned body (including injected transports) is re-checked here.
  if (Buffer.byteLength(response.body || '', 'utf8') > MAX_RESPONSE_BODY_BYTES) {
    throw new TranslationError('response_too_large', `translation response exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`);
  }

  if (REDIRECT_STATUSES.has(response.status) || response.headers?.location) {
    throw new TranslationError(
      'redirect_not_allowed',
      `translation server attempted a redirect to ${String(response.headers?.location || '').slice(0, 200)}; redirects are forbidden`
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new TranslationError('upstream_error', `translation server returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new TranslationError('invalid_payload', 'translation server returned non-JSON body');
  }

  const result = validateTranslationPayload(data);
  if (result.ok === false) {
    return { available: true, ok: false, error: result.error };
  }
  return { available: true, ok: true, item: translationResultToImportItem(result) };
}
