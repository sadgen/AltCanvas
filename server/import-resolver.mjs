import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isPrivateNetworkHost } from './security.mjs';
import { callTranslationServer } from './translation-server.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB

export async function validateExternalUrl(rawUrl, { allowPrivate = false, lookupFn = dns.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('Only http: and https: protocols are permitted');
  }

  if (parsed.username || parsed.password) {
    throw new TypeError('Embedded URL credentials are not allowed');
  }

  const hostname = parsed.hostname;
  const validatedAddresses = [];
  if (!allowPrivate) {
    if (isPrivateNetworkHost(hostname)) {
      throw new Error(`Forbidden address: ${hostname} is a private or loopback host`);
    }

    try {
      const addresses = await lookupFn(hostname, { all: true, verbatim: true });
      const addrList = Array.isArray(addresses) ? addresses : [addresses];
      for (const record of addrList) {
        const addr = typeof record === 'string' ? record : record?.address;
        if (addr && isPrivateNetworkHost(addr)) {
          throw new Error(`Forbidden address: ${hostname} resolves to private IP ${addr}`);
        }
        if (addr) validatedAddresses.push(typeof record === 'string' ? { address: record, family: record.includes(':') ? 6 : 4 } : record);
      }
    } catch (err) {
      if (err.message.includes('Forbidden address')) throw err;
      throw new Error(`DNS lookup failed for ${hostname}: ${err.message}`);
    }
  }

  return { url: parsed.toString(), parsed, validatedAddresses };
}

export function extractDoi(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim();
  const doiRegex = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/;
  const match = doiRegex.exec(cleaned);
  return match ? match[1].replace(/[.,;)]+$/, '') : null;
}

export function extractArxivId(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim();
  const arxivRegex = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|^(?:arxiv:\s*)?([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)$/i;
  const match = arxivRegex.exec(cleaned);
  return match ? (match[1] || match[2]) : null;
}

function requestWithPinnedIp(parsedUrl, pinnedAddress, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const isHttps = parsedUrl.protocol === 'https:';
    const requester = isHttps ? https.request : http.request;
    const headers = {
      'User-Agent': 'AltCanvas/1.0 (Research Assistant; mailto:support@altcanvas.local)',
      'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
      'Host': parsedUrl.host,
      ...(options.headers || {})
    };

    const reqOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method || 'GET',
      headers,
      lookup: (h, opt, cb) => {
        if (pinnedAddress?.address) {
          cb(null, pinnedAddress.address, pinnedAddress.family || 4);
        } else {
          cb(null, h, 4);
        }
      },
      servername: parsedUrl.hostname
    };

    const req = requester(reqOptions, (res) => {
      resolve(res);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function safeFetchText(url, options = {}, { allowPrivate = false, maxRedirects = 5, lookupFn = dns.lookup, transportFn = null } = {}) {
  let currentUrl = url;
  let redirectsCount = 0;

  while (true) {
    const validation = await validateExternalUrl(currentUrl, { allowPrivate, lookupFn });
    const parsed = validation.parsed;
    const validatedAddresses = validation.validatedAddresses;

    let res;
    if (typeof transportFn === 'function') {
      res = await transportFn(currentUrl, options, { parsed, validatedAddresses });
    } else {
      let lastErr = null;
      const addrCandidates = validatedAddresses.length ? validatedAddresses : [null];
      for (const addr of addrCandidates) {
        try {
          res = await requestWithPinnedIp(parsed, addr, options, options.timeout || REQUEST_TIMEOUT_MS);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!res) {
        throw lastErr || new Error(`Connection to ${parsed.hostname} failed on all resolved addresses`);
      }
    }

    const statusCode = res.status || res.statusCode || 200;
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      redirectsCount++;
      if (redirectsCount > maxRedirects) {
        throw new Error(`Too many redirects (limit: ${maxRedirects})`);
      }
      const location = (res.headers && typeof res.headers.get === 'function')
        ? res.headers.get('location')
        : (res.headers?.['location'] || null);
      if (!location) {
        throw new Error(`Redirect status HTTP ${statusCode} without Location header`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Upstream returned HTTP ${statusCode} ${res.statusMessage || res.statusText || ''}`);
    }

    if (typeof res.text === 'function') {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        const err = new Error(`Response body exceeds maximum allowed size (${MAX_RESPONSE_BYTES} bytes)`);
        err.status = 413;
        throw err;
      }
      return text;
    }

    const chunks = [];
    let bytesRead = 0;
    for await (const chunk of res) {
      const buf = Buffer.from(chunk);
      bytesRead += buf.length;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        if (typeof res.destroy === 'function') res.destroy();
        const err = new Error(`Response body exceeds maximum allowed size (${MAX_RESPONSE_BYTES} bytes)`);
        err.status = 413;
        throw err;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

export async function safeDownloadPdfFile(url, targetDir, {
  allowPrivate = false,
  maxRedirects = 5,
  lookupFn = dns.lookup,
  transportFn = null,
  maxBytes = 104_857_600 // 100 MiB
} = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const tempFileName = `download-${crypto.randomBytes(16).toString('hex')}.tmp`;
  const tempFilePath = path.join(targetDir, tempFileName);
  const writeStream = fs.createWriteStream(tempFilePath, { mode: 0o600 });
  const hash = crypto.createHash('sha256');

  let currentUrl = url;
  let redirectsCount = 0;
  let totalBytes = 0;
  let firstChunk = null;

  const cleanup = () => {
    try { writeStream.destroy(); } catch {}
    try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch {}
  };

  try {
    while (true) {
      const validation = await validateExternalUrl(currentUrl, { allowPrivate, lookupFn });
      const parsed = validation.parsed;
      const validatedAddresses = validation.validatedAddresses;

      let res;
      if (typeof transportFn === 'function') {
        res = await transportFn(currentUrl, { accept: 'application/pdf' }, { parsed, validatedAddresses });
      } else {
        let lastErr = null;
        const addrCandidates = validatedAddresses.length ? validatedAddresses : [null];
        for (const addr of addrCandidates) {
          try {
            res = await requestWithPinnedIp(parsed, addr, { accept: 'application/pdf,*/*' }, REQUEST_TIMEOUT_MS);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (!res) throw lastErr || new Error(`Connection to ${parsed.hostname} failed on all resolved addresses`);
      }

      const statusCode = res.status || res.statusCode || 200;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        redirectsCount++;
        if (redirectsCount > maxRedirects) throw new Error(`Too many redirects (limit: ${maxRedirects})`);
        const location = (res.headers && typeof res.headers.get === 'function')
          ? res.headers.get('location')
          : (res.headers?.['location'] || null);
        if (!location) throw new Error(`Redirect status HTTP ${statusCode} without Location header`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`Upstream PDF server returned HTTP ${statusCode}`);
      }

      if (typeof res.body?.getReader === 'function') {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            const err = new Error('PDF file exceeds maximum allowed size (100MB)');
            err.status = 413;
            throw err;
          }
          if (!firstChunk && chunk.length > 0) firstChunk = chunk.slice(0, 5);
          hash.update(chunk);
          writeStream.write(chunk);
        }
      } else {
        for await (const chunk of res) {
          const buf = Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > maxBytes) {
            if (typeof res.destroy === 'function') res.destroy();
            const err = new Error('PDF file exceeds maximum allowed size (100MB)');
            err.status = 413;
            throw err;
          }
          if (!firstChunk && buf.length > 0) firstChunk = buf.slice(0, 5);
          hash.update(buf);
          writeStream.write(buf);
        }
      }
      break;
    }

    await new Promise((resolve, reject) => {
      writeStream.end(err => err ? reject(err) : resolve());
    });

    const fd = fs.openSync(tempFilePath, 'r');
    const headBuf = Buffer.alloc(5);
    fs.readSync(fd, headBuf, 0, 5, 0);
    fs.closeSync(fd);
    if (!headBuf.toString('ascii').startsWith('%PDF-')) {
      cleanup();
      throw new Error('Downloaded file is not a valid PDF (%PDF- header missing)');
    }

    const sha256 = hash.digest('hex');
    const stat = fs.statSync(tempFilePath);
    return {
      tempFilePath,
      sha256,
      sizeBytes: stat.size,
      mimeType: 'application/pdf'
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export async function resolveDoi(doi, { fetchFn = safeFetchText, allowPrivate = false } = {}) {
  const cleanDoi = extractDoi(doi) || doi;
  const endpoint = `https://doi.org/${encodeURIComponent(cleanDoi)}`;
  const text = await fetchFn(endpoint, {
    accept: 'application/vnd.citationstyles.csl+json',
    headers: { 'Accept': 'application/vnd.citationstyles.csl+json' }
  }, { allowPrivate });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Failed to parse DOI citation metadata JSON');
  }

  const title = String(data.title || '').replace(/<\/?[^>]+(>|$)/g, '').trim() || `DOI: ${cleanDoi}`;
  const creators = Array.isArray(data.author) ? data.author.map(a => {
    if (a.given && a.family) {
      return { creatorType: 'author', firstName: String(a.given).trim(), lastName: String(a.family).trim() };
    }
    if (a.name) {
      return { creatorType: 'author', name: String(a.name).trim() };
    }
    if (a.family) {
      return { creatorType: 'author', lastName: String(a.family).trim(), firstName: '' };
    }
    return null;
  }).filter(Boolean) : [];

  let year = null;
  const dateParts = data.issued?.['date-parts'] || data.published?.['date-parts'] || data['published-print']?.['date-parts'] || data['published-online']?.['date-parts'];
  if (Array.isArray(dateParts) && Array.isArray(dateParts[0]) && dateParts[0][0]) {
    const y = Number(dateParts[0][0]);
    if (Number.isFinite(y) && y > 1000 && y < 3000) year = y;
  }

  const abstractNote = String(data.abstract || '').replace(/<\/?[^>]+(>|$)/g, '').trim().slice(0, 20_000);
  const publisher = String(data.publisher || data['container-title'] || '').trim();
  const pdfUrl = data.link?.find(l => l['content-type'] === 'application/pdf')?.URL || null;

  return {
    sourceType: 'doi',
    doi: cleanDoi,
    url: data.URL || `https://doi.org/${cleanDoi}`,
    pdfUrl,
    title,
    creators,
    year,
    abstractNote,
    publisher,
    rawMetadata: {
      type: data.type,
      containerTitle: data['container-title']
    }
  };
}

export async function resolveArxiv(arxivId, { fetchFn = safeFetchText, allowPrivate = false } = {}) {
  const cleanId = extractArxivId(arxivId) || arxivId;
  const endpoint = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
  const xml = await fetchFn(endpoint, { accept: 'application/atom+xml' }, { allowPrivate });

  // Lightweight XML parsing without heavy external deps
  const entryMatch = /<entry[\s\S]*?<\/entry>/.exec(xml);
  if (!entryMatch) {
    throw new Error(`ArXiv paper ${cleanId} not found`);
  }
  const entryXml = entryMatch[0];

  const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(entryXml);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : `arXiv:${cleanId}`;

  const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(entryXml);
  const abstractNote = summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim().slice(0, 20_000) : '';

  const publishedMatch = /<published>(\d{4})-\d{2}-\d{2}/.exec(entryXml);
  const year = publishedMatch ? Number(publishedMatch[1]) : null;

  const creators = [];
  const authorRegex = /<author>\s*<name>([\s\S]*?)<\/name>/g;
  let aMatch;
  while ((aMatch = authorRegex.exec(entryXml)) !== null) {
    const fullName = aMatch[1].trim();
    const parts = fullName.split(/\s+/);
    if (parts.length > 1) {
      creators.push({
        creatorType: 'author',
        firstName: parts.slice(0, -1).join(' '),
        lastName: parts[parts.length - 1]
      });
    } else {
      creators.push({ creatorType: 'author', name: fullName });
    }
  }

  const doiMatch = /<arxiv:doi[\s\S]*?>([\s\S]*?)<\/arxiv:doi>/.exec(entryXml);
  const doi = doiMatch ? doiMatch[1].trim() : null;

  return {
    sourceType: 'arxiv',
    arxivId: cleanId,
    doi,
    url: `https://arxiv.org/abs/${cleanId}`,
    pdfUrl: `https://arxiv.org/pdf/${cleanId}.pdf`,
    title,
    creators,
    year,
    abstractNote,
    publisher: 'arXiv'
  };
}

export async function resolveHtmlUrl(rawUrl, { fetchFn = safeFetchText, allowPrivate = false } = {}) {
  const safeUrl = await validateExternalUrl(rawUrl, { allowPrivate });
  const html = await fetchFn(safeUrl, { accept: 'text/html,application/xhtml+xml' }, { allowPrivate });

  const getMeta = name => {
    const reg = new RegExp(`<meta\\s+(?:name|property)=["'](?:${name})["']\\s+content=["']([\\s\\S]*?)["']`, 'i');
    const altReg = new RegExp(`<meta\\s+content=["']([\\s\\S]*?)["']\\s+(?:name|property)=["'](?:${name})["']`, 'i');
    const m = reg.exec(html) || altReg.exec(html);
    return m ? m[1].trim() : null;
  };

  const title = getMeta('citation_title')
    || getMeta('og:title')
    || getMeta('twitter:title')
    || (/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim())
    || safeUrl;

  const abstractNote = (getMeta('citation_abstract')
    || getMeta('description')
    || getMeta('og:description')
    || getMeta('twitter:description')
    || '').slice(0, 20_000);

  const creators = [];
  const authorRegex = /<meta\s+name=["']citation_author["']\s+content=["']([\s\S]*?)["']/gi;
  let aMatch;
  while ((aMatch = authorRegex.exec(html)) !== null) {
    const name = aMatch[1].trim();
    if (name) creators.push({ creatorType: 'author', name });
  }

  let year = null;
  const dateStr = getMeta('citation_publication_date') || getMeta('citation_date') || getMeta('article:published_time');
  if (dateStr) {
    const yMatch = /\b(\d{4})\b/.exec(dateStr);
    if (yMatch) year = Number(yMatch[1]);
  }

  const doi = getMeta('citation_doi') || extractDoi(html) || null;
  const pdfUrl = getMeta('citation_pdf_url') || null;
  const publisher = getMeta('citation_publisher') || getMeta('og:site_name') || '';

  return {
    sourceType: 'url',
    url: safeUrl,
    doi,
    pdfUrl,
    title: title.replace(/\s+/g, ' ').trim(),
    creators,
    year,
    abstractNote,
    publisher
  };
}

export function detectInputFormat(input) {
  if (typeof input !== 'string') return 'unknown';
  const trimmed = input.trim();
  if (!trimmed) return 'unknown';

  // BibTeX: starts with @type{ (e.g. @article{, @book{, @inproceedings{)
  if (/^\s*@[a-zA-Z]+\s*\{/m.test(trimmed)) {
    return 'bibtex';
  }

  // RIS: lines starting with TY  - (standard RIS entry start tag)
  if (/(?:^|\n)\s*TY\s+-\s+/m.test(trimmed)) {
    return 'ris';
  }

  // DOI (bare DOI, not full URL)
  const doi = extractDoi(trimmed);
  if (doi && !trimmed.includes('arxiv.org') && !/^\s*https?:\/\//i.test(trimmed)) {
    return 'doi';
  }

  // arXiv (bare arXiv ID, not full URL)
  const arxivId = extractArxivId(trimmed);
  if (arxivId && !/^\s*https?:\/\//i.test(trimmed)) {
    return 'arxiv';
  }

  // Web URL
  if (/^https?:\/\//i.test(trimmed)) {
    if (trimmed.includes('arxiv.org')) return 'arxiv';
    if (doi) return 'doi';
    return 'url';
  }

  return 'text';
}

export async function resolveImportInput(input, options = {}) {
  if (!input || typeof input !== 'string') {
    throw new TypeError('Input query or URL is required');
  }
  const cleanInput = input.trim();
  const format = options.format || detectInputFormat(cleanInput);
  const callTs = options.translationServerFn || callTranslationServer;

  // 1. Bibliography text (BibTeX, RIS, or explicitly requested format)
  if (format === 'bibtex' || format === 'ris') {
    let tsRes;
    try {
      tsRes = await callTs({ input: cleanInput, format }, {
        config: options.translationServerConfig,
        lookupFn: options.lookupFn,
        transportFn: options.transportFn
      });
    } catch (tsErr) {
      if (['total_timeout', 'connect_timeout', 'response_timeout'].includes(tsErr.code)) {
        tsErr.status = 504;
        throw tsErr;
      }
      if (['upstream_error', 'transport_error', 'redirect_not_allowed', 'forbidden_address', 'invalid_payload'].includes(tsErr.code)) {
        tsErr.status = 502;
        throw tsErr;
      }
      if (tsErr.code === 'request_too_large' || tsErr.code === 'response_too_large') {
        tsErr.status = 413;
        throw tsErr;
      }
      tsErr.status = tsErr.status || 502;
      throw tsErr;
    }

    if (!tsRes.available) {
      const err = new Error(`Translation Server 未配置，无法解析 ${format.toUpperCase()} 书目内容（需配置 TRANSLATION_SERVER_URL）`);
      err.code = 'translation_server_unavailable';
      err.status = 503;
      throw err;
    }
    if (!tsRes.ok) {
      const err = new Error(`Translation Server 解析失败: ${tsRes.error || '未知错误'}`);
      err.code = 'translation_server_error';
      err.status = 400;
      throw err;
    }
    const item = tsRes.item;
    return {
      sourceType: item.sourceType || format,
      title: item.title,
      abstractNote: item.abstract || item.abstractNote || '',
      abstract: item.abstract || item.abstractNote || '',
      creators: item.creators || [],
      year: item.year || null,
      doi: item.doi || null,
      url: item.url || null,
      isbn: item.isbn || null,
      arxivId: item.arxivId || null,
      pdfUrl: item.pdfUrl || null,
      resolvedBy: 'translation_server'
    };
  }

  // 2. DOI
  const doi = extractDoi(cleanInput);
  if (doi && !cleanInput.includes('arxiv.org') && (format === 'doi' || !format || format === 'url')) {
    const res = await resolveDoi(doi, options);
    return { ...res, resolvedBy: 'native_resolver' };
  }

  // 3. arXiv
  const arxivId = extractArxivId(cleanInput);
  if (arxivId && (format === 'arxiv' || !format || format === 'url')) {
    const res = await resolveArxiv(arxivId, options);
    return { ...res, resolvedBy: 'native_resolver' };
  }

  // 4. Web URL
  if (/^https?:\/\//i.test(cleanInput)) {
    const res = await resolveHtmlUrl(cleanInput, options);
    return { ...res, resolvedBy: 'native_resolver' };
  }

  // 5. Fallback for raw citation text / unrecognized formats via Translation Server
  let fallbackTs;
  try {
    fallbackTs = await callTs({ input: cleanInput, format: options.format || null }, {
      config: options.translationServerConfig,
      lookupFn: options.lookupFn,
      transportFn: options.transportFn
    });
  } catch (tsErr) {
    // If Translation Server encountered a real runtime/timeout/upstream failure,
    // do NOT swallow it into "unrecognized input"! Propagate with authoritative HTTP status.
    if (['total_timeout', 'connect_timeout', 'response_timeout'].includes(tsErr.code)) {
      tsErr.status = 504;
      throw tsErr;
    }
    if (['upstream_error', 'transport_error', 'redirect_not_allowed', 'forbidden_address', 'invalid_payload'].includes(tsErr.code)) {
      tsErr.status = 502;
      throw tsErr;
    }
    if (tsErr.code === 'request_too_large' || tsErr.code === 'response_too_large') {
      tsErr.status = 413;
      throw tsErr;
    }
    throw tsErr;
  }

  if (fallbackTs && fallbackTs.available) {
    if (fallbackTs.ok && fallbackTs.item?.title) {
      const item = fallbackTs.item;
      return {
        sourceType: item.sourceType || 'text',
        title: item.title,
        abstractNote: item.abstract || item.abstractNote || '',
        abstract: item.abstract || item.abstractNote || '',
        creators: item.creators || [],
        year: item.year || null,
        doi: item.doi || null,
        url: item.url || null,
        isbn: item.isbn || null,
        arxivId: item.arxivId || null,
        pdfUrl: item.pdfUrl || null,
        resolvedBy: 'translation_server'
      };
    }
    if (!fallbackTs.ok && fallbackTs.error) {
      const err = new Error(`Translation Server 解析失败: ${fallbackTs.error}`);
      err.code = 'translation_server_error';
      err.status = 400;
      throw err;
    }
  }

  const unsupportedErr = new Error('Input could not be recognized as a valid DOI, arXiv identifier, HTTP(S) URL, or supported bibliography format (BibTeX/RIS)');
  unsupportedErr.code = 'unsupported_import_input';
  unsupportedErr.status = 400;
  throw unsupportedErr;
}

export function findDuplicateCandidates(store, actorKey, metadata) {
  if (!store || !actorKey || !metadata) return [];
  const candidates = [];
  const seenIds = new Set();

  const normalizeTitle = t => String(t || '').toLowerCase().replace(/[\s\-_:：,，.。;；/\\()（）[\]【】]+/g, '');
  const targetNormTitle = normalizeTitle(metadata.title);
  const targetDoi = metadata.doi ? metadata.doi.toLowerCase().trim() : null;

  // 1. Check by DOI match
  if (targetDoi) {
    const doiRows = store.db.prepare(`
      SELECT * FROM inbox_entries
      WHERE owner_key = ? AND deleted_at IS NULL
        AND (doi = ? OR doi LIKE ? OR abstract_note LIKE ? OR title LIKE ?)
      LIMIT 20
    `).all(actorKey, targetDoi, `%${targetDoi}%`, `%${targetDoi}%`, `%${targetDoi}%`);

    for (const entry of doiRows) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        candidates.push({
          id: entry.id,
          itemKey: entry.item_key,
          title: entry.title,
          cleanTitle: entry.clean_title || null,
          year: entry.year,
          doi: entry.doi || null,
          state: entry.state,
          matchReason: `DOI 匹配 (${targetDoi})`,
          targetType: 'inbox'
        });
      }
    }
  }

  // 2. Check by Title match
  if (targetNormTitle && targetNormTitle.length >= 4) {
    const keywords = (metadata.title || '').split(/[\s:：,，.。;；/\\()（）[\]【】]+/).filter(w => w.length >= 3).slice(0, 5);
    let candidateRows = [];
    if (keywords.length) {
      const clauses = keywords.map(() => '(title LIKE ? OR clean_title LIKE ?)').join(' OR ');
      const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);
      candidateRows = store.db.prepare(`
        SELECT * FROM inbox_entries
        WHERE owner_key = ? AND deleted_at IS NULL AND (${clauses})
        LIMIT 50
      `).all(actorKey, ...params);
    } else {
      candidateRows = store.db.prepare(`
        SELECT * FROM inbox_entries
        WHERE owner_key = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 100
      `).all(actorKey);
    }

    for (const entry of candidateRows) {
      const entryNormTitle = normalizeTitle(entry.title);
      const cleanNormTitle = normalizeTitle(entry.clean_title || '');
      const isTitleMatch = entryNormTitle === targetNormTitle
        || (entryNormTitle.length >= 6 && targetNormTitle.length >= 6 && (entryNormTitle.includes(targetNormTitle) || targetNormTitle.includes(entryNormTitle)))
        || (cleanNormTitle.length >= 6 && targetNormTitle.length >= 6 && (cleanNormTitle.includes(targetNormTitle) || targetNormTitle.includes(cleanNormTitle)));

      if (isTitleMatch && !seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        candidates.push({
          id: entry.id,
          itemKey: entry.item_key,
          title: entry.title,
          cleanTitle: entry.clean_title || null,
          year: entry.year,
          state: entry.state,
          matchReason: '标题高度相似',
          targetType: 'inbox'
        });
      }
    }
  }

  // 2b. [M4] Check native library documents (primary identity store since the
  // inbox retirement; inbox_entries remain as a deprecated read-only source).
  if (targetDoi || (targetNormTitle && targetNormTitle.length >= 4)) {
    let docRows = [];
    if (targetDoi) {
      docRows = store.db.prepare(`
        SELECT * FROM documents
        WHERE owner_key = ? AND deleted_at IS NULL AND doi IS NOT NULL AND LOWER(doi) = ?
        LIMIT 20
      `).all(actorKey, targetDoi);
    }
    if (!docRows.length && targetNormTitle && targetNormTitle.length >= 4) {
      const keywords = (metadata.title || '').split(/[\s:：,，.。;；/\\()（）[\]【】]+/).filter(w => w.length >= 3).slice(0, 5);
      if (keywords.length) {
        const clauses = keywords.map(() => 'title LIKE ?').join(' OR ');
        docRows = store.db.prepare(`
          SELECT * FROM documents
          WHERE owner_key = ? AND deleted_at IS NULL AND (${clauses})
          ORDER BY updated_at DESC
          LIMIT 50
        `).all(actorKey, ...keywords.map(k => `%${k}%`));
      }
    }
    for (const doc of docRows) {
      const docNormTitle = normalizeTitle(doc.title);
      const isTitleMatch = docNormTitle === targetNormTitle
        || (docNormTitle.length >= 6 && targetNormTitle.length >= 6 && (docNormTitle.includes(targetNormTitle) || targetNormTitle.includes(docNormTitle)));
      if ((targetDoi && doc.doi && doc.doi.toLowerCase().trim() === targetDoi) || isTitleMatch) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          candidates.push({
            id: doc.id,
            itemKey: doc.id,
            title: doc.title,
            cleanTitle: doc.title,
            year: doc.year,
            doi: doc.doi || null,
            state: 'accepted',
            matchReason: doc.doi && targetDoi && doc.doi.toLowerCase().trim() === targetDoi ? `DOI 匹配 (${targetDoi})` : '标题高度相似',
            targetType: 'document'
          });
        }
      }
    }
  }

  // 3. Also check document_metas
  if (targetDoi) {
    const metaDoiRows = store.db.prepare(`
      SELECT * FROM document_metas
      WHERE owner_key = ? AND (doi = ? OR doi LIKE ? OR summary LIKE ?)
      LIMIT 20
    `).all(actorKey, targetDoi, `%${targetDoi}%`, `%${targetDoi}%`);
    for (const dm of metaDoiRows) {
      const key = `meta_${dm.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        candidates.push({
          id: dm.id,
          itemKey: dm.item_key,
          title: dm.clean_title || dm.report_title || '已分析文献',
          cleanTitle: dm.clean_title || null,
          year: dm.year ? Number(dm.year) : null,
          doi: dm.doi || null,
          state: 'analyzed',
          matchReason: `DOI 匹配 (${targetDoi})`,
          targetType: 'document_meta'
        });
      }
    }
  }

  return candidates;
}
