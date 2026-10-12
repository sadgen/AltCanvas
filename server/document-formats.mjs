import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

export const DOCUMENT_MIMES = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.epub': 'application/epub+zip' };
export const documentExtension = filename => path.extname(String(filename || '')).toLowerCase();
export const documentMime = filename => DOCUMENT_MIMES[documentExtension(filename)] || null;
export const isDocumentFile = filename => Boolean(documentMime(filename));

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}
function plainMarkup(value) {
  return String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(?:p|div|h[1-6]|li|section)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
    }).replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, e => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[e])
    .replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1], m[3]]));
function epubContents(bytes) {
  let expanded = 0;
  const files = unzipSync(bytes, { filter(entry) {
    expanded += entry.originalSize;
    if (expanded > 20 * 1024 * 1024 || entry.originalSize > 5 * 1024 * 1024) throw new TypeError('EPUB 解压内容超限');
    if (entry.name.startsWith('/') || entry.name.split('/').includes('..') || entry.name.includes('\\')) throw new TypeError('EPUB 路径无效');
    return /(?:\.opf|\.xhtml|\.html|\.htm|container\.xml|^mimetype)$/i.test(entry.name);
  } });
  if (strFromU8(files.mimetype || new Uint8Array()).trim() !== 'application/epub+zip') throw new TypeError('无效 EPUB：缺少 mimetype');
  const container = strFromU8(files['META-INF/container.xml'] || new Uint8Array());
  const opfPath = attributes(container.match(/<rootfile\b[^>]*>/i)?.[0] || '')['full-path'];
  if (!opfPath || !files[opfPath]) throw new TypeError('无效 EPUB：缺少书籍目录');
  const opf = strFromU8(files[opfPath]);
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map(m => attributes(m[0])).map(a => [a.id, a]));
  const title = plainMarkup(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '');
  const authors = [...opf.matchAll(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map(m => plainMarkup(m[1]));
  const chapters = [...opf.matchAll(/<itemref\b[^>]*>/g)].map(m => attributes(m[0]))
    .filter(a => a.linear !== 'no').map(a => manifest.get(a.idref)).filter(Boolean).map(a => {
      let href; try { href = decodeURIComponent(a.href.split('#')[0]); } catch { throw new TypeError('EPUB 章节路径无效'); }
      const key = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), href));
      if (!files[key]) throw new TypeError('EPUB 章节缺失');
      const markup = strFromU8(files[key]);
      return { title: plainMarkup(markup.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] || ''), text: plainMarkup(markup) };
    });
  if (!chapters.length) throw new TypeError('EPUB 没有可阅读章节');
  return { title, authors, chapters };
}

export function extractTextDocument(bytes, filename) {
  const ext = documentExtension(filename);
  if (ext !== '.txt' && ext !== '.epub') throw new TypeError('不支持此文本格式');
  const book = ext === '.epub' ? epubContents(new Uint8Array(bytes))
    : { title: path.basename(filename, ext), authors: [], chapters: [{ title: '', text: decodeText(bytes).replace(/\r\n?/g, '\n').trim() }] };
  const pages = [];
  let total = 0;
  for (const [index, chapter] of book.chapters.entries()) {
    total += chapter.text.length;
    if (total > 2_000_000) throw new TypeError('文本超过阅读上限（200 万字符）');
    // Stable text blocks, explicitly not printed book page numbers.
    for (let offset = 0; offset < chapter.text.length; offset += 6000) {
      pages.push({ pageNumber: pages.length + 1, title: chapter.title || `章节 ${index + 1}`, text: chapter.text.slice(offset, offset + 6000) });
    }
  }
  if (!pages.length) throw new TypeError('文档没有可提取文本');
  return { title: book.title, authors: book.authors, format: ext.slice(1), locationKind: 'text-block', pages };
}

export function validateDocumentBytes(bytes, filename) {
  const mime = documentMime(filename);
  if (!mime) throw new TypeError('支持 PDF、TXT、EPUB 文件');
  if (mime === 'application/pdf') {
    if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new TypeError('File is not a valid PDF (%PDF- header missing)');
  } else {
    if (bytes.length > 20 * 1024 * 1024) throw new TypeError('TXT/EPUB 文件超过 20 MiB 上限');
    if (mime === 'text/plain' && Buffer.from(bytes).subarray(0, 4096).includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) throw new TypeError('TXT 文件包含二进制内容');
    extractTextDocument(bytes, filename);
  }
  return mime;
}
