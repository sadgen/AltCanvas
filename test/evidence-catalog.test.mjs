import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildEvidenceCatalog } from '../server/evidence-catalog.mjs';

const pages = [
  { pageNumber: 1, text: 'This is background context. The evidence is on the next page.' },
  { pageNumber: 2, text: 'Actual original evidence supports the mechanism. It must never be rewritten.' }
];
const catalog = buildEvidenceCatalog(pages);
assert.ok(catalog.some(entry => entry.pageNumber === 2));
for (const entry of catalog) assert.ok(pages.find(page => page.pageNumber === entry.pageNumber).text.includes(entry.quote));
const large = buildEvidenceCatalog(Array.from({ length: 500 }, (_, i) => ({ pageNumber: i + 1, text: 'Many original words form a long paragraph. '.repeat(500) })));
assert.ok(large.reduce((sum, entry) => sum + entry.quote.length, 0) <= 32000);
assert.equal(new Set(large.map(entry => entry.pageNumber)).size, 500, 'catalog must cover late pages within budget');

const code = fs.readFileSync(new URL('../server/canvas-api.mjs', import.meta.url), 'utf8');
const start = code.indexOf('function searchableText(');
const end = code.indexOf('function normalizeDocumentGraph(', start);
const context = vm.createContext({ buildEvidenceCatalog });
vm.runInContext(code.slice(start, end), context);
const index = context.buildEvidenceIndex(pages);
const entry = index.catalog.find(entry => entry.pageNumber === 2);
let evidence = context.verifiedEvidence({ evidenceId: entry.id, evidenceQuote: 'invented sentence', evidencePage: 1 }, index, 1, 1);
assert.equal(evidence.evidenceQuote, entry.quote, 'known IDs always resolve to original text, never model text');
assert.equal(evidence.evidencePage, 2, 'actual evidence page overrides erroneous inferred ranges');
evidence = context.verifiedEvidence({ evidenceId: 'unknown', evidenceQuote: 'invented sentence' }, index, 1, 2);
assert.equal(evidence.evidenceQuote, null, 'unknown IDs must not manufacture evidence');
evidence = context.verifiedEvidence({ evidenceQuote: entry.quote, evidencePage: 1 }, index, 1, 1);
assert.equal(evidence.evidencePage, 2, 'exact original quotes remain discoverable outside an incorrect range');
console.log('✅ Original evidence IDs, bounded whole-document coverage, page correction and fabricated quote rejection passed');
