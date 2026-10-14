import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const helpers = html.slice(html.indexOf('    function compactEvidenceText('), html.indexOf('    async function extractCurrentPdfPages('));
let navigated = null;
const reader = {
  _primaryView: { _iframeWindow: { PDFViewerApplication: { pdfDocument: {
    getPageData: async () => ({ chars: [
      { u: 'A', rect: [0, 0, 10, 10], inlineRect: [0, 0, 10, 10] },
      { u: 'ﬃ', rect: [10, 0, 20, 10], lineBreakAfter: true },
      { u: 'B', rect: [0, 20, 10, 30], inlineRect: [0, 20, 10, 30] },
      { u: 'C', rect: [10, 20, 20, 30] }
    ] })
  } } } },
  navigate: async location => { navigated = location; },
  setAnnotations() { assert.fail('Evidence must not create or replace annotations'); },
  setSelectedAnnotations() { assert.fail('Evidence must not select a synthetic annotation'); }
};
const context = vm.createContext({ currentReaderInstance: reader, cleanAnnotationText: s => s.trim() });
vm.runInContext(helpers, context);
assert.equal(await context.showPdfEvidenceHighlight({ quoteSnapshot: 'Affi\n B C' }, 3), true);
assert.equal(navigated.position.pageIndex, 3);
assert.equal(navigated.position.rects.length, 2, 'Wrapped evidence must highlight both lines');
navigated = null;
assert.equal(await context.showPdfEvidenceHighlight({ quoteSnapshot: 'absent' }, 3), false);
assert.equal(navigated, null, 'Never highlight an unrelated nearby sentence');
assert.equal(await context.showPdfEvidenceHighlight({ quoteSnapshot: null }, 3), false);
let complete;
reader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument.getPageData = () => new Promise(resolve => { complete = resolve; });
const pending = context.showPdfEvidenceHighlight({ quoteSnapshot: 'A' }, 3);
context.currentReaderInstance = { navigate() { assert.fail('Old evidence must not jump in the newly opened document'); } };
complete({ chars: [{ u: 'A', rect: [0, 0, 10, 10] }] });
assert.equal(await pending, false);
assert.equal(navigated, null);
console.log('✅ Evidence uses transient position highlighting, preserves annotations and guards document switches');
