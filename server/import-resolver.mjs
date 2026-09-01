import dns from 'node:dns/promises';
import { isPrivateNetworkHost } from './security.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB

export async function validateExternalUrl(rawUrl, { allowPrivate = false } = {}) {
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
  if (!allowPrivate) {
    if (isPrivateNetworkHost(hostname)) {
      throw new Error(`Forbidden address: ${hostname} is a private or loopback host`);
    }

    try {
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
      for (const record of addresses) {
        if (isPrivateNetworkHost(record.address)) {
          throw new Error(`Forbidden address: ${hostname} resolves to private IP ${record.address}`);
        }
      }
    } catch (err) {
      if (err.message.includes('Forbidden address')) throw err;
      throw new Error(`DNS lookup failed for ${hostname}: ${err.message}`);
    }
  }

  return parsed.toString();
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
  const arxivRegex = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i;
  const match = arxivRegex.exec(cleaned);
  return match ? match[1] : null;
}

export async function safeFetchText(url, options = {}, { allowPrivate = false } = {}) {
  const safeUrl = await validateExternalUrl(url, { allowPrivate });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(safeUrl, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'AltCanvas/1.0 (Research Assistant; mailto:support@altcanvas.local)',
        'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        ...(options.headers || {})
      }
    });

    if (!res.ok) {
      throw new Error(`Upstream returned HTTP ${res.status} ${res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return text.slice(0, MAX_RESPONSE_BYTES);
    }

    const chunks = [];
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      chunks.push(value);
      if (bytesRead > MAX_RESPONSE_BYTES) {
        controller.abort();
        break;
      }
    }
    const combined = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  } finally {
    clearTimeout(timer);
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

export async function resolveImportInput(input, options = {}) {
  if (!input || typeof input !== 'string') {
    throw new TypeError('Input query or URL is required');
  }
  const cleanInput = input.trim();

  // 1. DOI
  const doi = extractDoi(cleanInput);
  if (doi && !cleanInput.includes('arxiv.org')) {
    return resolveDoi(doi, options);
  }

  // 2. arXiv
  const arxivId = extractArxivId(cleanInput);
  if (arxivId) {
    return resolveArxiv(arxivId, options);
  }

  // 3. Web URL
  if (/^https?:\/\//i.test(cleanInput)) {
    return resolveHtmlUrl(cleanInput, options);
  }

  throw new TypeError('Input could not be recognized as a valid DOI, arXiv identifier, or HTTP(S) URL');
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
        AND (abstract_note LIKE ? OR title LIKE ?)
      LIMIT 20
    `).all(actorKey, `%${targetDoi}%`, `%${targetDoi}%`);

    for (const entry of doiRows) {
      if (!seenIds.has(entry.id)) {
        seenIds.add(entry.id);
        candidates.push({
          id: entry.id,
          itemKey: entry.item_key,
          title: entry.title,
          cleanTitle: entry.clean_title || null,
          year: entry.year,
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

  return candidates;
}
