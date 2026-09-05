import assert from 'assert/strict';
import fs from 'fs';

console.log('🧪 Running AltCanvas Canvas UI structure tests...');

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const devServer = fs.readFileSync(new URL('../scripts/dev-server.mjs', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 1, 'workspace should have one inline application script');
assert.doesNotThrow(() => new Function(scripts[0]), 'application script must parse');

for (const id of [
  'canvas-cards', 'canvas-world', 'canvas-edges', 'canvas-nodes', 'canvas-empty',
  'btn-canvas-add-note', 'btn-canvas-import', 'btn-canvas-connect', 'btn-canvas-ai',
  'btn-canvas-export-json', 'lbl-canvas-import-json', 'input-canvas-import-file',
  'btn-canvas-history', 'provenance-modal', 'provenance-list',
  'btn-canvas-clear', 'btn-canvas-cross-report',
  'cross-report-modal', 'cross-report-panel', 'btn-close-cross-report', 'cross-report-focal-text', 'cross-report-relations-list', 'btn-cancel-cross-report', 'btn-expand-selected-relations',
  'btn-canvas-ai-translate', 'btn-canvas-ai-synthesize',
  'btn-canvas-ai-document', 'input-ai-auto-translate',
  'ai-modal', 'ai-panel', 'ai-selected-chips', 'input-ai-prompt', 'btn-submit-ai',
  'btn-close-ai', 'btn-cancel-ai', 'btn-open-ai-settings',
  'ai-provider-status', 'ai-provider-name', 'ai-provider-model', 'btn-test-ai-conn',
  'input-ai-base-url', 'input-ai-model', 'input-ai-key', 'btn-clear-ai-config',
  'btn-canvas-zoom-out', 'btn-canvas-zoom-reset', 'btn-canvas-zoom-in', 'canvas-save-state',
  'select-topic-workspace', 'btn-open-topic-settings', 'btn-toggle-canvas-max',
  'topic-settings-modal', 'topic-settings-panel', 'btn-close-topic-settings', 'input-topic-name', 'input-topic-desc', 'input-topic-question', 'input-topic-inclusion', 'input-topic-exclusion', 'btn-save-topic-meta', 'btn-delete-topic', 'topic-docs-list',
  // M4 原始文件视图与文库过滤
  'btn-library-view-files', 'library-files-panel', 'source-files-root-select', 'btn-source-rescan', 'btn-source-new-dir', 'btn-source-up', 'source-files-path-label', 'source-files-items',
  'library-filter-chips', 'btn-library-ai-classify',
  'file-name-modal', 'file-name-modal-title', 'file-name-modal-hint', 'file-name-modal-input', 'file-name-modal-extra', 'file-name-modal-dir-input', 'file-name-modal-error', 'btn-close-file-name-modal', 'btn-cancel-file-name-modal', 'btn-confirm-file-name-modal',
  'doc-meta-modal', 'doc-meta-panel', 'btn-close-doc-meta', 'input-doc-meta-clean-title', 'input-doc-meta-institution', 'input-doc-meta-year', 'input-doc-meta-report-title', 'input-doc-meta-subtitle', 'input-doc-meta-summary', 'btn-doc-meta-ai-extract', 'btn-cancel-doc-meta', 'btn-save-doc-meta', 'btn-doc-edit-title', 'btn-doc-ai-title',
  'btn-canvas-quick-import', 'quick-import-modal', 'quick-import-panel', 'btn-close-quick-import', 'input-quick-import-query', 'btn-quick-import-resolve', 'quick-import-result-card', 'btn-cancel-quick-import', 'btn-quick-import-topic',
  'quick-import-directory-section', 'quick-import-target-root', 'quick-import-target-dir', 'quick-import-filename', 'quick-import-dir-topics', 'btn-quick-import-directory',
  'canvas-evidence-popover', 'evidence-popover-panel', 'btn-close-evidence-popover', 'evidence-popover-title', 'evidence-popover-page-badge', 'evidence-popover-doc-title', 'evidence-popover-quote-box', 'btn-dismiss-evidence-popover', 'btn-evidence-popover-jump'
]) {
  assert.equal((html.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length, 1, `${id} must exist exactly once`);
}

assert.match(html, /function docMetaKey\(/);
assert.match(html, /function openDocMetaModal\(/);
assert.match(html, /async function saveDocMetaModal\(/);
assert.match(html, /async function extractDocumentChineseMetadata\(/);
assert.match(html, /btn-item-edit-meta/);
assert.match(html, /function openQuickEvidencePopover\(/, 'Canvas cards must support in-place evidence quick verification popover');
assert.match(html, /function openQuickImportModal\(/, 'Canvas and Inbox must support quick DOI/arXiv/URL import');
assert.match(html, /async function resolveQuickImport\(\)/, 'Quick import must resolve metadata and duplicate detection');
assert.match(html, /async function executeQuickImport\(/, 'Quick import must execute durable import into workspace');
assert.match(html, /async function executeQuickDirectoryImport\(/, 'M4 quick import must support archiving PDFs into library-root directories');
assert.match(html, /async function scanLibraryRootWithFeedback|function sourceScanFlow\(/, 'M4 source-files view must support recursive scanning with feedback');
assert.match(html, /function promptM4FileName\(/, 'M4 must provide the original-filename conflict dialog');
assert.match(html, /M4_SOURCE_STATUS_LABELS/, 'M4 must label source-file states (正常/重复/缺失/损坏/回收站)');
assert.match(html, /function loadMoreSourceFiles\(/, 'source-files view must consume nextCursor pagination');
assert.match(html, /btn-source-load-more/, 'source-files view must render a load-more control while nextCursor exists');
assert.match(html, /append: true/, 'directory pagination must append pages instead of dropping entries beyond the first');
assert.match(html, /目录项目过多，当前结果不完整/, 'the UI must surface meta.truncated as an explicit incompleteness notice');
assert.match(html, /canvas-node-quick-verify/, 'Canvas cards with sourceRef must render quick-verify button');
assert.match(html, /documentMetas\.get\(docMetaKey\(/,
  'rendering must use composite key to lookup document metadata');
assert.match(html, /documentMetas\.clear\(\)/,
  'library reloading and logout must clear in-memory document metadata');

assert.match(html, /async function initCanvasWorkspace\(\)/);
assert.match(html, /async function importCurrentAnnotations\(\)/);
assert.match(html, /function beginCanvasNodeDrag\(/);
assert.match(html, /function beginCanvasNodeResize\(/);
assert.match(html, /async function saveCanvasLayout\(\)/);
assert.match(html, /async function handleCanvasConnectSelection\(/);
assert.match(html, /async function undoLastCanvasAction\(/);
assert.match(html, /async function deleteCanvasNodes\(nodes\)/);
assert.match(html, /async function clearCanvas\(\)/,
  'the toolbar must support clearing the board through the existing undoable bulk-delete path');
assert.match(html, /btn-canvas-clear[^\n]*Ctrl\+Z 撤销/,
  'clearing a board must advertise that the action is undoable without a confirmation modal');
assert.match(html, /\['Delete', 'Backspace'\]\.includes\(event\.key\)/,
  'Delete and Backspace must remove selected Canvas cards');
assert.match(html, /modifier && event\.key\.toLowerCase\(\) === 'a'/,
  'Ctrl/Cmd+A must select all cards while Canvas has focus');
assert.match(html, /if \(key === 'n'\)/);
assert.match(html, /if \(key === 'c'\)/);
assert.match(html, /if \(key === 'h'\)/);
assert.match(html, /async function jumpToSourceAnnotation\(/);
assert.match(html, /async function waitForReaderPageReady\(/);
assert.doesNotMatch(html, /await waitForReaderPageReady\(currentReaderInstance/,
  'ordinary document opening must not wait on annotation navigation readiness');
assert.match(html, /await waitForReaderPageReady\(reader, pageIndex, documentController\?\.signal\)/,
  'annotation jumps must wait for the target PDF page viewport');
assert.match(html, /pageView\?\.viewport/);
assert.match(html, /async function exportCurrentBoard\(/);
assert.match(html, /async function importBoardFile\(/);
assert.match(html, /async function checkSourcesFreshness\(\)/);
assert.match(html, /function renderCanvasSelectedState\(\)/);
assert.match(html, /function updateCanvasAiToolbar\(\)/);
assert.match(html, /function openAiModal\(/);
assert.match(html, /async function executeAiGeneration\(\{ task = currentAiTask, prompt = null, quick = false \} = \{\}\)/);
assert.match(html, /async function autoTranslatePdfAnnotation\(annotation\)/,
  'new PDF highlights must support translation back into the same Reader annotation');
assert.match(html, /_annotationManager\?\.updateAnnotations\(\[\{/,
  'inline translation must update the existing PDF annotation comment');
assert.match(html, /async function extractCurrentPdfPages\(\)/);
assert.match(html, /textChars > maxTextChars \|\| estimatedRequestBytes > maxRequestBytes/,
  'whole-document extraction must stop at the browser memory boundary before reading every page');
assert.match(html, /while \(pageDataCache\.size > 2\)/,
  'batch evidence conversion must keep a bounded PDF character-layer cache');
assert.match(html, /async function generateCurrentPdfUnderstandingCanvas\(\)/);
assert.match(html, /sourceRef\.quoteSnapshot \|\| sourceRef\.position\?\.textQuote/,
  'document-map source navigation must use the persisted verbatim quote');
assert.match(html, /_primaryView\?\.find/,
  'clicking an AI citation must ask Reader to highlight the exact quoted text');
assert.match(html, /async function locatePdfEvidence\(pageIndex, quote, pageDataCache = null\)/,
  'exact evidence navigation must derive PDF rectangles from the real character layer');
assert.match(html, /ALT-AI-EVIDENCE-HIGHLIGHT/,
  'exact evidence navigation must render a stable session-only Reader highlight');
assert.match(html, /readOnly: true,[\s\S]*isExternal: true/,
  'the evidence highlight must not become a writable Altero annotation');
assert.match(html, /AI 卡片原文证据（临时定位，不写回文库）/);
assert.match(html, /原文 p\.\$\{escapeHTML\(displayPageLabel \|\| '1'\)\} ↗/,
  'AI cards must expose an explicit exact-source action rather than only a page jump');
assert.match(html, /\/boards\/\$\{canvasBoard\.id\}\/ai\/document-map/,
  'the current PDF must be able to create a full understanding canvas');
assert.match(html, /正文会发送给当前 AI 服务/,
  'whole-document analysis must disclose that PDF text leaves AltCanvas');
assert.match(html, /executeAiGeneration\(\{ task: 'translate', prompt: '', quick: true \}\)/,
  'selected cards must support one-click translation without opening the AI modal');
assert.match(html, /executeAiGeneration\(\{ task: 'synthesize', prompt: '', quick: true \}\)/,
  'selected cards must support one-click synthesis without opening the AI modal');
assert.doesNotMatch(html, /showToast\(currentAiTask === 'translate'/,
  'successful AI generation must use inline Canvas state instead of a redundant toast');
assert.match(html, /async function loadAiConfig\(\)/);
assert.match(html, /async function saveAiConfig\(/);
assert.match(html, /async function clearAiConfig\(/);
assert.match(html, /canvasFetch\('\/ai\/config', \{ method: 'POST'/,
  'users must be able to save a personal AI provider through the BFF');
assert.match(html, /canvasFetch\('\/ai\/config', \{ method: 'DELETE'/,
  'users must be able to clear their personal AI provider');
assert.match(html, /function focusAiInputSources\(/);
assert.match(html, /忠实中译/);
assert.match(html, /综合总结/);
assert.match(html, /观点对比/);
assert.match(html, /原注已删/);
assert.match(html, /原文已更/);
assert.match(html, /\/boards\/\$\{loadingBoardId\}\/snapshot/);
assert.match(html, /\/boards\/\$\{savingBoardId\}\/layout/);
assert.match(html, /\/boards\/\$\{canvasBoard\.id\}\/export/);
assert.match(html, /\/boards\/\$\{canvasBoard\.id\}\/provenance/);
assert.match(html, /\/boards\/\$\{canvasBoard\.id\}\/ai\/generate/);
assert.match(html, /canvasFetch\('\/ai\/config'\)/);
assert.match(html, /canvasFetch\('\/ai\/test'/);
assert.match(html, /\/workspaces\/\$\{canvasWorkspace\.id\}\/boards\/import/);
assert.match(html, /\/nodes\/\$\{node\.id\}\/restore/);
assert.match(html, /event\.ctrlKey \|\| event\.metaKey/,
  'Ctrl/Cmd + wheel must be reserved for canvas zooming');
assert.match(html, /event\.target\.closest\?\.\('\.canvas-node-body, \.custom-scrollbar'\)/,
  'mouse wheel over scrollable card body must allow native card content scrolling');
assert.match(html, /viewportState\.x -= event\.deltaX;[\s\S]*viewportState\.y -= event\.deltaY/,
  'normal mouse wheel must pan canvas smoothly');
assert.match(html, /async function restoreCanvasAnnotationToPdf\(/,
  'restore button must be wired to the annotation restore handler');
assert.match(html, /id="btn-canvas-evidence-annotate"/);
assert.match(html, /async function convertAllEvidenceToAnnotations\(/,
  'evidence-to-annotation batch conversion must be implemented');
assert.match(html, /async function convertOneEvidence\(/);
assert.match(html, /async function waitForCanvasLayoutIdle\(/,
  'evidence conversion must not race an in-flight layout write and repeatedly conflict');
assert.match(html, /while \(canvasSaveInFlight && Date\.now\(\) < deadline\)/);
assert.match(html, /canvas-node-annotate/);
assert.match(html, /已转批注 ✓/);
assert.match(html, /await waitForAnnotationServerKey\(annotation\.id\)/);
assert.match(html, /err\.status !== 412/,
  'source restore must recover from a concurrent card edit without duplicating the PDF annotation');
assert.match(html, /node\.type === 'ai_output' \|\| node\.type === 'annotation'/,
  'PDF-derived annotation cards must be editable');
assert.match(html, /button, input, textarea, select, \[contenteditable="true"\]/,
  'Canvas card selection must not steal focus from its editing controls');
assert.match(html, /Ctrl\+Z 撤销/);
assert.match(html, /已连线 · Ctrl\+Z 撤销/);
assert.doesNotMatch(html, /showToast\('已从画板移除/);
assert.doesNotMatch(html, /showToast\('已添加连线/);
assert.doesNotMatch(html, /showToast\([^\n]*已删除标注/,
  'successful PDF annotation deletion must not show a redundant toast');
assert.match(html, /event\.key\.toLowerCase\(\) === 'z'/);
assert.match(html, /const savingBoardId = canvasBoard\.id/);
assert.match(html, /if \(canvasBoard\?\.id !== savingBoardId\) return/,
  'late layout responses from a previous board must be ignored');
assert.match(html, /clearTimeout\(canvasLayoutTimer\);[\s\S]*canvasLayoutTimer = null;[\s\S]*const text = await file\.text\(\)/,
  'import must cancel delayed layout writes from the previous board');
assert.match(html, /#provenance-panel \{ max-height: min\(70vh, 44rem\); overflow: hidden; \}/);
assert.match(html, /#provenance-list \{[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/,
  'long provenance history must scroll inside a viewport-bounded panel');
assert.doesNotMatch(html, /confirm\('从画板移除/);
assert.doesNotMatch(html, /prompt\('关系类型/);
assert.doesNotMatch(html, /prompt\('卡片标题/);
assert.doesNotMatch(html, /prompt\('卡片内容/);
assert.doesNotMatch(html, /localStorage\.setItem\('altcanvas\.aiConfig'/,
  'AI provider keys must not be persisted in browser storage');
assert.doesNotMatch(html, /(?:localStorage|sessionStorage)\.setItem\([^\n]*input-ai-key/,
  'a personal AI key must never be stored in browser storage');
assert.match(html, /不会自动发送整篇 PDF/,
  'AI UI must disclose the exact selected-card data boundary');

// --- T1 Topic Workspaces, Research Inbox, and Batch Actions ---
// --- T3 Cross-Report Relations & Progressive Expansion ---
assert.match(html, /async function openCrossReportRelationsModal\(/);
assert.match(html, /function closeCrossReportRelationsModal\(\)/);
assert.match(html, /async function expandSelectedCrossReportRelations\(\)/);
assert.match(html, /canvas-node-cross-report/);
assert.match(html, /\/workspaces\/\$\{canvasWorkspace\.id\}\/related-knowledge/);
assert.match(html, /\/boards\/\$\{canvasBoard\.id\}\/expand-related/);

assert.match(html, /async function loadTopicWorkspaces\(/);
assert.match(html, /async function switchTopicWorkspace\(/);
assert.match(html, /async function openTopicSettingsModal\(/);
assert.match(html, /async function saveTopicMetadata\(\)/);
// [M4] Retired inbox/collection UI and functions must be GONE from the page.
for (const retired of [
  'id="btn-open-inbox"', 'id="inbox-modal"', 'id="inbox-unread-badge"', 'id="inbox-items-container"',
  'id="btn-inbox-scan-now"', 'id="btn-inbox-classify-ai"', 'id="btn-inbox-generate-topics-ai"',
  'id="btn-inbox-accept-ai"', 'id="btn-inbox-batch-assign"', 'id="btn-quick-import-inbox-only"',
  'id="batch-topics-modal"', 'id="select-bind-collection"', 'id="btn-submit-bind-collection"',
  'id="topic-bindings-list"', 'data-tab="bindings"',
]) {
  assert.equal((html.match(new RegExp(retired.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))) || []).length, 0,
    `${retired} must be absent after the M4 retirement`);
}
for (const retiredFn of ['renderInboxEntries', 'scanAlteroInbox', 'classifyInboxWithAi', 'acceptAllAiSuggestions',
  'openBatchTopicsModal', 'confirmBatchTopicAssignment', 'loadTopicBindings', 'submitAddCollectionBinding',
  'syncCollectionBinding', 'loadAlteroCollectionsForBinding', 'openInboxEntryForReading']) {
  assert.doesNotMatch(html, new RegExp(`(async )?function ${retiredFn}\\(`),
    `${retiredFn} must be removed after the M4 retirement`);
}
assert.doesNotMatch(html, /\/inbox\/(scan|classify|generate-topics|batch-action)/,
  'page must not call retired inbox endpoints');
assert.doesNotMatch(html, /collection-bindings/, 'page must not call retired collection-binding endpoints');

// M4 additions: 原始文件视图、文库过滤、双名称、冲突对话框、回收站、文库级 AI
assert.match(html, /id="btn-library-view-files"/);
assert.match(html, /id="library-files-panel"/);
assert.match(html, /id="source-files-root-select"/);
assert.match(html, /id="btn-source-rescan"/);
assert.match(html, /id="btn-source-new-dir"/);
assert.match(html, /async function loadSourceFiles\(/, 'M4 source-files view must load the real directory tree');
assert.match(html, /async function applyLibraryFilter\(/, 'M4 library must support 未分类/无 PDF/文件缺失/回收站 filters');
assert.match(html, /async function libraryAiClassifyFlow\(/, 'AI topic suggestion must be a library-level batch operation');
assert.match(html, /data-native-action="rename-original"/, 'library items must expose explicit original-file rename');
assert.match(html, /data-native-action="trash"/, 'library items must expose trash actions');
assert.match(html, /data-native-action="restore"/, 'library items must expose restore actions');
assert.match(html, /原始文件名（磁盘文件名）/, 'library items must display the original disk filename');

// --- Behavioral test: libraryAiClassifyFlow applies >=0.7 suggestions via batch-topics ---
{
  const fnMatch = /async function libraryAiClassifyFlow\(\)\s*\{([\s\S]*?)\n    \}/.exec(scripts[0]);
  assert.ok(fnMatch, 'libraryAiClassifyFlow must be found in script');

  const m4Calls = [];
  const toastCalls = [];
  const buttonState = { disabled: false, text: '' };
  const mockDocument = {
    getElementById: () => ({ disabled: false, textContent: '' })
  };
  const runner = new Function(
    'm4Fetch', 'document', 'showToast', 'userWorkspaces', 'canvasFetch', 'applyLibraryFilter', 'libraryFilterState',
    `return (async () => { ${fnMatch[1]} })();`
  );
  await runner(
    async (path, options) => {
      m4Calls.push({ path, body: options?.body });
      if (path === '/native/classify/generate-topics') {
        return { data: {
          createdWorkspaces: [{ id: 'ws-new' }],
          classifications: {
            'doc-1': [
              { workspaceId: 'ws-A', confidence: 0.9, reason: 'fit' },
              { workspaceId: 'ws-B', confidence: 0.5, reason: 'weak' }
            ],
            'doc-2': [
              { workspaceId: 'ws-A', confidence: 0.8, reason: 'fit' }
            ]
          }
        } };
      }
      if (path === '/native/documents/batch-topics') {
        return { data: (options.body.documentIds || []).map(id => ({ documentId: id, ok: true })) };
      }
      if (path === '/workspaces') return [{ id: 'ws-A' }];
      return { data: [] };
    },
    mockDocument,
    (msg, type) => toastCalls.push({ msg, type }),
    [{ id: 'ws-A', name: 'Topic A' }],
    async (path) => [{ id: 'ws-A', name: 'Topic A' }],
    async () => {},
    'all'
  );

  const batchCalls = m4Calls.filter(c => c.path === '/native/documents/batch-topics');
  assert.equal(batchCalls.length, 1, 'Only one workspace received >=0.7 suggestions');
  assert.deepEqual(batchCalls[0].body, { documentIds: ['doc-1', 'doc-2'], topicIds: ['ws-A'] });
  assert.equal(toastCalls.some(t => t.type === 'success' && /采纳 2 条/.test(t.msg)), true,
    'must report the number of applied suggestions');
}

assert.match(html, /局域网 HTTP 会明文传输卡片内容与凭据/,
  'AI settings must warn about plaintext private-network transport');
assert.match(html, /libraryType === 'native'/,
  'normalizeLibraryContext must preserve native library type without mapping to user');
assert.match(html, /function libraryApiPrefix\(\) \{\s*throw new Error\('Altero 外部文库已于 M4 移除'\);\s*\}/,
  'libraryApiPrefix must be reduced to the explicit M4-removal guard');
assert.match(html, /async function uploadNativePdfFile\(/,
  'UI must provide uploadNativePdfFile handler for PDF uploads');
assert.match(html, /async function openNativeDocument\(/,
  'UI must provide openNativeDocument for opening native documents and attachments');
assert.match(html, /function setupNativePdfUpload\(/,
  'UI must setup file drop and file input event handlers for native PDF uploads');
assert.match(html, /id="btn-upload-pdf-top"/,
  'UI header must provide native PDF upload button');

assert.match(html, /async function reloadAndSyncReaderAnnotations\(/,
  'UI must provide reloadAndSyncReaderAnnotations to resync reader state on annotation write/delete conflict or failure');
assert.match(html, /setAnnotations\(readerAnnotations\)/,
  'reloadAndSyncReaderAnnotations must update reader in-memory annotations');

assert.match(html, /async function openDocument\(/,
  'UI must provide unified openDocument router');
assert.match(html, /await openItem\(itemData, nativeLib\)/,
  'openNativeDocument must call openItem with nativeLib');
assert.doesNotMatch(html, /Native library does not support Zotero API endpoints/,
  'the Zotero-era native rejection must be gone together with the external library');

// --- Behavioral Execution Tests for Native Opening & Reader Annotation Sync ---
{
  // 1. Test openNativeDocument execution
  let openItemCalled = null;
  const mockOpenNativeContext = {
    openItem: async (itemData, lib) => { openItemCalled = { itemData, lib }; },
    showToast: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ data: {} }) })
  };

  const openNativeDocMatch = html.match(/async function openNativeDocument\(doc, attachment\) \{([\s\S]*?)\n    \}/);
  assert.ok(openNativeDocMatch, 'openNativeDocument definition must exist');

  const openNativeDocRunner = new Function(
    'openItem', 'showToast', 'fetch', 'doc', 'attachment',
    `return (async () => { ${openNativeDocMatch[1]} })();`
  );

  const testDoc = { id: 'doc-123', version: 1, title: 'Test Native Doc', itemType: 'journalArticle', creators: [{ name: 'Author A' }] };
  const testAtt = { id: 'att-456', version: 1, originalFilename: 'doc.pdf', mimeType: 'application/pdf', title: 'Test Native Doc' };

  await openNativeDocRunner(
    mockOpenNativeContext.openItem,
    mockOpenNativeContext.showToast,
    mockOpenNativeContext.fetch,
    testDoc,
    testAtt
  );

  assert.ok(openItemCalled, 'openNativeDocument must successfully call openItem');
  assert.equal(openItemCalled.itemData.key, 'doc-123');
  assert.equal(openItemCalled.itemData.isNative, true);
  assert.equal(openItemCalled.itemData.children.length, 1);
  assert.equal(openItemCalled.itemData.children[0].key, 'att-456');
  assert.equal(openItemCalled.lib.libraryType, 'native');

  // 2. Test reloadAndSyncReaderAnnotations error resilience on HTTP 500
  const annotationsMap = new Map([['ann-1', { version: 1, data: { annotationText: 'Preserved Text' } }]]);
  const clientMap = new Map([['client-1', 'ann-1']]);
  const mockReader = { _primaryView: { _annotationManager: { setAnnotations: () => {} } } };

  const reloadFnMatch = html.match(/async function reloadAndSyncReaderAnnotations\(attachmentKey\) \{([\s\S]*?)\n    \}/);
  assert.ok(reloadFnMatch, 'reloadAndSyncReaderAnnotations definition must exist');

  const reloadRunner = new Function(
    'currentReaderInstance', 'currentAttachment', 'currentDocumentLibrary', 'currentAnnotationsMap', 'clientAnnotationIdMap',
    'getAnnotationPosition', 'getAnnotationPageIndex', 'cleanAnnotationText', 'renderAnnotationCards', 'fetch', 'libraryApiPrefix', 'getApiUrl', 'getHeaders', 'console',
    'attachmentKey',
    `return (async () => { ${reloadFnMatch[1]} })();`
  );

  // Simulate HTTP 500 error on native annotation fetch
  await reloadRunner(
    mockReader,
    { key: 'att-456', isNative: true },
    { libraryType: 'native', libraryId: 'local' },
    annotationsMap,
    clientMap,
    () => ({}),
    () => 0,
    s => s,
    () => {},
    async () => ({ ok: false, status: 500 }),
    () => { throw new Error('should not call'); },
    s => s,
    () => ({}),
    { warn: () => {} },
    'att-456'
  );

  assert.equal(annotationsMap.has('ann-1'), true, 'Annotations map must NOT be cleared when fetch returns HTTP 500');
  assert.equal(annotationsMap.get('ann-1').data.annotationText, 'Preserved Text');

  // 3. Test reloadAndSyncReaderAnnotations race condition when document switched in-flight
  await reloadRunner(
    mockReader,
    { key: 'att-NEW-DOCUMENT', isNative: true }, // Document switched
    { libraryType: 'native', libraryId: 'local' },
    annotationsMap,
    clientMap,
    () => ({}),
    () => 0,
    s => s,
    () => {},
    async () => ({ ok: true, json: async () => ({ data: [{ id: 'ann-OLD', version: 1, quote: 'Old Quote' }] }) }),
    () => { throw new Error('should not call'); },
    s => s,
    () => ({}),
    { warn: () => {} },
    'att-456' // Old attachmentKey
  );

  assert.equal(annotationsMap.has('ann-OLD'), false, 'In-flight response for old document must not overwrite active annotations map');

  // 4. Test openItem error handling on initial annotation fetch failure (HTTP 500)
  // Assert previous document A annotations are cleared and not retained in a mixed state
  let readerPlaceholderTitle = '';
  let toastErrorShown = '';
  const mockOpenItemDom = {
    'current-doc-title': { textContent: '' },
    'btn-doc-edit-title': { classList: { remove: () => {}, add: () => {} } },
    'btn-doc-ai-title': { classList: { remove: () => {}, add: () => {} } },
    'reader-loading': { classList: { remove: () => {}, add: () => {} } },
    'reader-loading-text': { textContent: '' },
    'reader-placeholder': { classList: { remove: () => {}, add: () => {} } },
    'reader-wrapper': { classList: { remove: () => {}, add: () => {} } },
    'reader-placeholder-title': { set textContent(val) { readerPlaceholderTitle = val; }, get textContent() { return readerPlaceholderTitle; } },
    'reader-placeholder-subtitle': { textContent: '' }
  };

  const openItemFnMatch = html.match(/async function openItem\(item, libraryContext = null\) \{([\s\S]*?)\n    \}/);
  assert.ok(openItemFnMatch, 'openItem definition must exist');

  const resetFnMatch = html.match(/function resetCurrentDocumentState\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(resetFnMatch, 'resetCurrentDocumentState definition must exist');

  const openItemRunner = new Function(
    'openRequestId', 'documentController', 'currentItem', 'currentReaderInstance', 'updateCanvasAiToolbar',
    'currentDocumentLibrary', 'normalizeLibraryContext', 'libraryApiPrefix', 'renderItems', 'mobileMedia', 'setMobilePane',
    'config', 'documentMetas', 'docMetaKey', 'document', 'fetch', 'getApiUrl', 'getHeaders', 'showToast',
    'currentAttachment', 'currentAnnotationsMap', 'clientAnnotationIdMap', 'getAnnotationPosition', 'getAnnotationPageIndex',
    'cleanAnnotationText', 'renderAnnotationCards', 'initReaderEngine', 'reportApplicationError', 'errorMessage', 'resetCurrentDocumentState',
    'item', 'libraryContext',
    `return (async () => { ${openItemFnMatch[1]} })();`
  );

  // Document A already had annotations in memory
  const docAAnnotations = new Map([['doc-A-ann', { version: 1, data: { text: 'Doc A Note' } }]]);
  const docAClientMap = new Map([['client-A', 'doc-A-ann']]);
  let currentDocLibrary = { libraryType: 'user', libraryId: '42' };

  const mockReset = () => {
    docAAnnotations.clear();
    docAClientMap.clear();
    currentDocLibrary = null;
  };

  await openItemRunner(
    0, null, { key: 'doc-A' }, null, () => {},
    null, s => s, () => '/users/0', () => {}, { matches: false }, () => {},
    { userId: '42' }, new Map(), () => '',
    { getElementById: id => mockOpenItemDom[id] || { textContent: '', classList: { add: () => {}, remove: () => {} } } },
    async (url) => {
      if (url.includes('/annotations')) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({}) };
    },
    s => s, () => ({}), (msg) => { toastErrorShown = msg; },
    { key: 'att-A' }, docAAnnotations, docAClientMap, () => ({}), () => 0,
    s => s, () => {}, async () => {}, () => {}, err => err.message, mockReset,
    { key: 'doc-B', isNative: true, children: [{ key: 'att-B', data: { contentType: 'application/pdf' }, isNative: true }] },
    { libraryType: 'native', libraryId: 'local' }
  );

  assert.equal(readerPlaceholderTitle, 'PDF 加载失败', 'Annotation fetch failure on initial open must trigger error state');
  assert.match(toastErrorShown, /500/, 'Toast must report actual error status');
  assert.equal(docAAnnotations.size, 0, 'Opening doc B failure must clear doc A annotations to prevent cross-doc mixed state');
  assert.equal(docAClientMap.size, 0, 'Opening doc B failure must clear client annotation mapping');
  assert.equal(currentDocLibrary, null, 'Opening doc B failure must reset currentDocumentLibrary to null');
}

assert.match(html, /function resetCurrentDocumentState\(\)/,
  'UI must provide unified resetCurrentDocumentState function');
assert.match(html, /currentDocumentLibrary = null;/,
  'resetCurrentDocumentState must reset currentDocumentLibrary to null on failure');

assert.match(html, /function isSameLibrary\(/,
  'cross-library source matching must include the library identity');
assert.match(html, /canUsePersonalLibraryCache/,
  'group-library source jumps must not reuse personal-library cache entries');
assert.match(html, /无权访问/);
assert.match(html, /状态未知/);
assert.match(html, /function editCanvasNote\(node, element\)/);
assert.match(html, /placeholder = '输入卡片内容…'/);
assert.doesNotMatch(html, /onOpenContextMenu:\s*\(\)\s*=>\s*\{\}/,
  'reader must keep its built-in annotation context menu');
assert.match(html, /const itemUrl = getApiUrl\(`\$\{libraryApiPrefix\(currentDocumentLibrary\)\}\/items\/\$\{encodeURIComponent\(serverId\)\}`\)/,
  'annotation deletion must try the exact item endpoint in the active library first');
assert.match(html, /items\?itemKey=\$\{encodeURIComponent\(serverId\)\}/,
  'annotation deletion must retain the Altero library-version compatibility fallback');
assert.match(html, /JSON\.stringify\(\{ deleted: true \}\)/,
  'annotation deletion must retain the recoverable Altero trash fallback');
assert.match(html, /If-Unmodified-Since-Version/);
assert.match(html, /body\[data-mobile-pane="annotations"\] #annotations-pane/);
assert.match(html, /ANN_ABSOLUTE_MAX = 1600, READER_MIN = 288/,
  'desktop Canvas width must use the viewport while retaining a usable Reader minimum');
assert.match(html, /window\.innerWidth - libraryWidth - READER_MIN - DIVIDERS_WIDTH/,
  'the right-pane maximum must be computed from available viewport width');
assert.doesNotMatch(html, /ANN_MAX = 700/,
  'the Canvas must not retain the old fixed 700px width ceiling');
assert.doesNotMatch(html, /研究标注白板 \(Cards\)/);
assert.match(html, /function autoFitCanvasNodeHeight\(node, element\)/,
  'card resize handle must support content auto-fit on double click');
assert.match(html, /拖拽调整大小，双击自适应内容高度/,
  'card resize handle must provide tooltip for drag and double click auto-fit');
assert.match(html, /id="canvas-evidence-popover"/,
  'evidence verification popover must be present in DOM');
assert.match(html, /function openQuickEvidencePopover\(/);

// --- Behavioral test: openQuickEvidencePopover must not reference undefined helpers ---
{
  assert.doesNotMatch(html, /getCachedDocumentMeta/,
    'openQuickEvidencePopover must not call undefined getCachedDocumentMeta');

  const evidencePopoverMatch = /function openQuickEvidencePopover\(node, sourceRef\) \{([\s\S]*?)\n    \}/.exec(scripts[0]);
  assert.ok(evidencePopoverMatch, 'openQuickEvidencePopover must be extractable from script');

  const popoverClasses = {
    'canvas-evidence-popover': new Set(['hidden'])
  };
  const popoverTexts = {};
  const popoverDoc = {
    getElementById: (id) => ({
      classList: {
        add: (c) => popoverClasses[id]?.add(c),
        remove: (c) => popoverClasses[id]?.delete(c)
      },
      set textContent(v) { popoverTexts[id] = v; },
      get textContent() { return popoverTexts[id] || ''; }
    })
  };
  const documentMetas = new Map([
    ['native|local|DOC_EV_1', { cleanTitle: '【机构】证据文献标题（2024）' }]
  ]);

  const evidenceRunner = new Function(
    'node', 'sourceRef', 'document', 'documentMetas', 'docMetaKey', 'currentEvidencePopoverSourceRef',
    evidencePopoverMatch[1]
  );

  evidenceRunner(
    { title: '卡片标题', body: '卡片正文' },
    { libraryType: 'native', libraryId: 'local', itemKey: 'DOC_EV_1', pageLabel: '5', quoteSnapshot: '原文引用内容' },
    popoverDoc,
    documentMetas,
    (t, l, k) => `${t}|${l}|${k}`,
    null
  );

  assert.ok(!popoverClasses['canvas-evidence-popover'].has('hidden'), 'popover must be visible after open');
  assert.equal(popoverTexts['evidence-popover-doc-title'], '【机构】证据文献标题（2024）', 'popover title must come from documentMetas cache');
  assert.equal(popoverTexts['evidence-popover-page-badge'], 'p.5');
}

// --- Capabilities-Driven UI Tests (M4: local-only capabilities) ---
assert.match(html, /function applyCapabilitiesUI\(\)/,
  'UI must define applyCapabilitiesUI to control capability-driven views');
assert.match(html, /config\.capabilities = data\.capabilities \|\| \{ nativeUpload: true \}/,
  'checkSession must store capabilities with nativeUpload as the only local default');
assert.doesNotMatch(html, /caps\.(collections|upstreamSync|externalLibrary)/,
  'Altero-only capability flags must be gone from the capability UI');
assert.doesNotMatch(html, /collections-container/,
  'the Altero collections filter container must be gone from the library pane');
assert.match(html, /function openQuickImportModal\(/);
assert.match(html, /async function resolveQuickImport\(\)/);
assert.match(html, /快速导入文献 \(DOI \/ arXiv \/ URL \/ BibTeX \/ RIS\)/,
  'quick-import modal title must indicate BibTeX and RIS support');
assert.match(html, /<textarea id="input-quick-import-query"/,
  'quick-import query input must use textarea for multi-line bibliography support');

// --- M4: openLoginModal must be local-only (no Altero section, no mode toggle) ---
{
  const openLoginMatch = /function openLoginModal\(\)\s*\{([\s\S]*?)\n    \}/.exec(scripts[0]);
  assert.ok(openLoginMatch, 'openLoginModal must be extractable from script');

  assert.doesNotMatch(openLoginMatch[0], /altero|oauth|toggle-auth-mode|dynamicAlteroAllowed|externalLibrary/i,
    'openLoginModal must not retain any Altero auth logic after M4');
  assert.doesNotMatch(html, /id="altero-auth-section"/,
    'the Altero auth section markup must be gone');
  assert.doesNotMatch(html, /id="btn-toggle-auth-mode"/,
    'the auth-mode toggle button must be gone');
  assert.doesNotMatch(html, /id="input-oauth-server"/,
    'the OAuth server input must be gone');

  const classes = { 'login-modal': new Set(['hidden']), 'local-auth-error': new Set() };
  const texts = {};
  const focusedIds = [];

  const mockDoc = {
    getElementById: (id) => ({
      classList: {
        add: (c) => classes[id]?.add(c),
        remove: (c) => classes[id]?.delete(c),
        contains: (c) => classes[id]?.has(c) ?? false
      },
      set textContent(v) { texts[id] = v; },
      get textContent() { return texts[id] || ''; },
      focus: () => focusedIds.push(id)
    })
  };

  const openLoginRunner = new Function(
    'document', 'needsSetup', 'config', 'requestAnimationFrame',
    openLoginMatch[1]
  );

  // Whatever config.capabilities claims, the modal must stay purely local:
  // there is no altero section to reveal and no toggle button to show.
  openLoginRunner(
    mockDoc,
    false,
    { capabilities: { externalLibrary: true } },
    (fn) => fn()
  );

  assert.ok(!classes['login-modal'].has('hidden'), 'login modal must open');
  assert.equal(texts['login-title-text'], '登录 AltCanvas', 'login modal must use the local login title');
  assert.deepEqual(focusedIds, ['input-local-username'], 'focus must go to the local username input only');

  // First-run bootstrap copy stays on the same local-only modal.
  openLoginRunner(mockDoc, true, {}, (fn) => fn());
  assert.equal(texts['login-title-text'], '🎉 创建管理员账户', 'first-run must render admin setup copy');
  assert.deepEqual(focusedIds, ['input-local-username', 'input-local-username'], 'focus must stay on the local username input');
}

// =========================================================================
// --- M3.0: Unified authenticated-app initialization behavioral tests ---
// =========================================================================
{
  const initAppMatch = /async function initializeAuthenticatedApp\(\) \{([\s\S]*?)\n    \}/.exec(scripts[0]);
  const submitLoginMatch = /async function submitLogin\(\) \{([\s\S]*?)\n    \}/.exec(scripts[0]);
  assert.ok(initAppMatch, 'initializeAuthenticatedApp must be extractable');
  assert.ok(submitLoginMatch, 'submitLogin must be extractable');

  // Structural: the ONLY init sequence is checkSession -> initializeAuthenticatedApp,
  // on both startup and post-login paths; no parallel ad-hoc init remains.
  assert.match(html, /await checkSession\(\);\s*\n\s*loadKnownDeletedAnnotations\(\);\s*\n\s*await initializeAuthenticatedApp\(\);/,
    'startup IIFE must route through the unified initializeAuthenticatedApp entry');
  const startupIife = scripts[0].slice(scripts[0].lastIndexOf('--- Init App on Load ---'));
  assert.ok(startupIife.includes('initializeAuthenticatedApp'), 'startup IIFE region must be extracted correctly');
  assert.doesNotMatch(startupIife, /loadAiConfig\(\)|initCanvasWorkspace\(\)|loadCollectionsAndLibrary\(\)/,
    'startup IIFE must not run any direct init calls outside the unified initializer');
  const submitLoginSrc = submitLoginMatch[0];
  assert.match(submitLoginSrc, /await initializeAuthenticatedApp\(\);/,
    'submitLogin must call the unified initializer after login');
  assert.doesNotMatch(submitLoginSrc, /loadCollectionsAndLibrary|loadInboxEntries/,
    'submitLogin must NOT duplicate library/inbox loading outside the unified initializer');
  assert.match(submitLoginSrc, /const sessionOk = await checkSession\(\);/,
    'submitLogin must confirm the session before initializing');
  assert.match(html, /let appInitInFlight = null;/,
    'concurrency lock variable must exist for the unified initializer');

  // --- Case 1: initializeAuthenticatedApp call order + concurrency lock ---
  {
    const calls = [];
    let releaseCanvas;
    const canvasGate = new Promise(resolve => { releaseCanvas = resolve; });

    const runner = new Function(
      'config', 'localStorage',
      'loadAiConfig', 'initCanvasWorkspace', 'loadCollectionsAndLibrary', 'updateAuthUI',
      'reportApplicationError', 'showToast', 'errorMessage',
      `
      let appInitInFlight = null;
      ${initAppMatch[0]}
      return initializeAuthenticatedApp;
      `
    );

    let canvasInitCount = 0;
    const initApp = runner(
      { mode: 'bff', user: { id: 'u1' }, userId: 'u1' },
      { removeItem: () => calls.push('localstorage-clear') },
      async () => { calls.push('ai-config'); },
      async () => { canvasInitCount++; calls.push('canvas-init'); await canvasGate; },
      async () => { calls.push('library'); },
      () => { calls.push('auth-ui'); },
      () => {},
      () => {},
      e => e.message
    );

    // Two CONCURRENT invocations (double-click login race): the lock must deduplicate.
    const p1 = initApp();
    const p2 = initApp();
    releaseCanvas();
    await Promise.all([p1, p2]);

    assert.equal(canvasInitCount, 1, 'Concurrent initializeAuthenticatedApp calls must run initCanvasWorkspace exactly ONCE');
    assert.deepEqual(calls.filter(c => c !== 'localstorage-clear'),
      ['ai-config', 'canvas-init', 'library', 'auth-ui'],
      'Initialization order must be: AI config -> canvas(incl. inbox) -> library -> auth UI');

    // Sequential re-run after completion must work again (e.g. re-login).
    releaseCanvas = () => {};
    const calls2 = [];
    const initApp2 = runner(
      { mode: 'bff', user: { id: 'u1' }, userId: 'u1' },
      { removeItem: () => {} },
      async () => { calls2.push('ai-config'); },
      async () => { calls2.push('canvas-init'); },
      async () => { calls2.push('library'); },
      () => { calls2.push('auth-ui'); },
      () => {}, () => {}, e => e.message
    );
    await initApp2();
    assert.deepEqual(calls2, ['ai-config', 'canvas-init', 'library', 'auth-ui'],
      'A later sequential initialization must run the full sequence again');
  }

  // --- Case 2: initialization failure keeps login state, shows init error (NOT a login prompt) ---
  {
    const toasts = [];
    const reported = [];
    const config = { mode: 'bff', user: { id: 'u1' }, userId: 'u1' };
    const runner = new Function(
      'config', 'localStorage',
      'loadAiConfig', 'initCanvasWorkspace', 'loadCollectionsAndLibrary', 'updateAuthUI',
      'reportApplicationError', 'showToast', 'errorMessage',
      `
      let appInitInFlight = null;
      ${initAppMatch[0]}
      return initializeAuthenticatedApp;
      `
    );
    const initApp = runner(
      config,
      { removeItem: () => {} },
      async () => { throw new Error('AI 配置接口 500'); },
      async () => {},
      async () => {},
      () => {},
      (src, err) => { reported.push(src); },
      (msg) => { toasts.push(msg); },
      e => e.message
    );
    await initApp();
    assert.equal(config.mode, 'bff', 'Failed initialization must NOT clear the login state');
    assert.ok(config.user, 'Failed initialization must NOT clear the user object');
    assert.ok(toasts.some(t => t.includes('应用初始化失败')), 'Failure must surface a specific init-failure toast');
    assert.ok(!toasts.some(t => /请登录|重新登录|OIDC/.test(t)), 'Failure must NOT be presented as a login/OIDC problem');
    assert.ok(reported.includes('app.initialize'), 'Failure must be reported under the app.initialize source');
  }

  // --- Case 3: submitLogin local branch — full call order and no refresh needed ---
  {
    const calls = [];
    const texts = {};
    const classes = { 'login-modal': new Set([]), 'local-auth-error': new Set(['hidden']) };
    const inputs = { 'input-local-username': { value: ' researcher ' }, 'input-local-password': { value: 'Passw0rd!' } };
    const mockDoc = {
      getElementById: (id) => ({
        get value() { return inputs[id]?.value ?? ''; },
        classList: {
          add: c => classes[id]?.add(c),
          remove: c => classes[id]?.delete(c),
          contains: c => classes[id]?.has(c) ?? false
        },
        set textContent(v) { texts[id] = v; },
        get textContent() { return texts[id] || ''; },
        focus: () => {}
      })
    };
    const requestedUrls = [];

    const runner = new Function(
      'authMode', 'needsSetup', 'document', 'fetch', 'localStorage',
      'closeLoginModal', 'showToast', 'checkSession', 'initializeAuthenticatedApp', 'openLoginModal',
      'window',
      `return async function submitLogin() { ${submitLoginMatch[1]} };`
    );

    let loginModalClosed = false;
    const submit = runner(
      'local',
      false,
      mockDoc,
      async (url) => {
        requestedUrls.push(url);
        calls.push(`fetch:${url}`);
        return { ok: true, json: async () => ({ data: { user: { id: 'u1' } } }) };
      },
      { },
      () => { loginModalClosed = true; calls.push('close-modal'); },
      (msg) => { calls.push(`toast:${msg}`); },
      async () => { calls.push('checkSession'); return true; },
      async () => { calls.push('init-app'); },
      () => { calls.push('open-login-modal'); },
      { location: { href: '' } }
    );
    await submit();

    assert.deepEqual(calls, ['fetch:/auth/login', 'close-modal', 'toast:登录成功！', 'checkSession', 'init-app'],
      'Local login order must be: login POST -> modal close -> session confirm -> unified init');
    assert.ok(loginModalClosed, 'Login modal must close before initialization');
    assert.ok(!calls.includes('open-login-modal'), 'Successful login must not re-open the login modal');
    assert.ok(!requestedUrls.some(u => u.includes('/api/users/') || u.includes('/api/groups/')),
      'Login + init must not issue Altero API requests');
  }

  // --- Case 4: submitLogin — session confirmation failure aborts initialization ---
  {
    const calls = [];
    const texts = {};
    const classes = { 'login-modal': new Set(['hidden']), 'local-auth-error': new Set(['hidden']) };
    const inputs = { 'input-local-username': { value: 'researcher' }, 'input-local-password': { value: 'Passw0rd!' } };
    const mockDoc = {
      getElementById: (id) => ({
        get value() { return inputs[id]?.value ?? ''; },
        classList: {
          add: c => classes[id]?.add(c),
          remove: c => classes[id]?.delete(c)
        },
        set textContent(v) { texts[id] = v; },
        get textContent() { return texts[id] || ''; },
        focus: () => {}
      })
    };
    const runner = new Function(
      'authMode', 'needsSetup', 'document', 'fetch', 'localStorage',
      'closeLoginModal', 'showToast', 'checkSession', 'initializeAuthenticatedApp', 'openLoginModal',
      'window',
      `return async function submitLogin() { ${submitLoginMatch[1]} };`
    );
    const submit = runner(
      'local', false, mockDoc,
      async () => ({ ok: true, json: async () => ({ data: {} }) }),
      {},
      () => {},
      () => {},
      async () => false, // session confirmation FAILED
      async () => { calls.push('init-app'); },
      () => { calls.push('open-login-modal'); },
      { location: { href: '' } }
    );
    await submit();
    assert.equal(calls.filter(c => c === 'init-app').length, 0,
      'Failed session confirmation must NOT trigger app initialization');
    assert.ok(calls.includes('open-login-modal'),
      'Failed session confirmation must re-open the login modal for retry');
    assert.match(texts['local-auth-error'], /登录会话确认失败/,
      'Session confirmation failure must show a specific error message');
  }

  // --- Case 5: [M4] The Altero OAuth server redirect branch must be GONE ---
  {
    assert.doesNotMatch(submitLoginSrc, /input-oauth-server|altcanvas_altero_server|altero_api|altero\.example\.com/,
      'submitLogin must not retain the Altero OAuth server redirect path');
    assert.doesNotMatch(submitLoginSrc, /window\.location\.href/,
      'local login must never hard-redirect the page');
  }
}

// --- Behavioral test: native library multi-page pagination and safety cap ---
{
  const loadNativeFn = html.match(/async function loadNativeLibrary\(signal\) \{([\s\S]*?)\n    \}/);
  assert.ok(loadNativeFn, 'loadNativeLibrary must exist');

  const buildRunner = () => new Function(
    'fetch', 'nativeDocumentToLibraryItem', 'renderCollections', 'renderItems', 'documentMetas', 'docMetaKey',
    `
    let allItems = ['sentinel'];
    ${loadNativeFn[0]}
    return { run: (signal) => loadNativeLibrary(signal), getAllItems: () => allItems };
    `
  );

  // Case A: real multi-page result 100 + 100 + 1 -> all 201 items loaded
  {
    let callIndex = 0;
    const makeDocs = (count, base) => Array.from({ length: count }, (_, i) => ({ id: `doc-${base}-${i}`, title: `Doc ${base}-${i}` }));
    const mockFetch = async (url) => {
      callIndex++;
      if (callIndex === 1) return { ok: true, status: 200, json: async () => ({ data: makeDocs(100, 'p1') }) };
      if (callIndex === 2) return { ok: true, status: 200, json: async () => ({ data: makeDocs(100, 'p2') }) };
      return { ok: true, status: 200, json: async () => ({ data: makeDocs(1, 'p3') }) };
    };
    const instance = buildRunner()(
      mockFetch,
      d => ({ key: d.id, isNative: true, libraryType: 'native', libraryId: 'local' }),
      () => {}, () => {}, new Map(), () => ''
    );
    await instance.run();
    const items = instance.getAllItems();
    assert.equal(items.length, 201, 'Multi-page 100+100+1 must load all 201 documents');
    assert.equal(items[0].key, 'doc-p1-0');
    assert.equal(items[200].key, 'doc-p3-0');
  }

  // Case B: safety cap reached with a full last page -> throws and does NOT clobber allItems
  {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `doc-cap-${i}`, title: `Cap ${i}` }));
    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls++;
      return { ok: true, status: 200, json: async () => ({ data: fullPage }) };
    };
    const instance = buildRunner()(
      mockFetch,
      d => ({ key: d.id, isNative: true, libraryType: 'native', libraryId: 'local' }),
      () => {}, () => {}, new Map(), () => ''
    );
    await assert.rejects(() => instance.run(), /分页安全上限/,
      'Cap-exceeded library must throw instead of silently truncating');
    assert.equal(fetchCalls, 100, 'All 100 safety-cap pages must have been attempted');
    assert.deepEqual(instance.getAllItems(), ['sentinel'], 'allItems must NOT be overwritten with truncated result');
  }
}

// --- Behavioral test: autoFitCanvasNodeHeight execution ---
{
  const autoFitMatch = /function autoFitCanvasNodeHeight\(node, element\)\s*\{([\s\S]*?)\n    \}/.exec(scripts[0]);
  assert.ok(autoFitMatch, 'autoFitCanvasNodeHeight must be extractable from script');

  const mockNode = { id: 'node-1', type: 'manual_note', height: 400 };
  const mockElement = {
    style: { height: '400px' },
    offsetHeight: 142,
    scrollHeight: 142
  };
  let edgesRendered = false;
  let layoutSaved = false;

  const autoFitRunner = new Function(
    'node', 'element', 'renderCanvasEdges', 'scheduleCanvasLayoutSave',
    autoFitMatch[1]
  );

  autoFitRunner(
    mockNode,
    mockElement,
    () => { edgesRendered = true; },
    () => { layoutSaved = true; }
  );

  assert.equal(mockNode.height, 142, 'autoFitCanvasNodeHeight must adjust node.height to measured natural height');
  assert.equal(mockElement.style.height, '142px', 'autoFitCanvasNodeHeight must update element.style.height');
  assert.equal(edgesRendered, true, 'autoFitCanvasNodeHeight must trigger renderCanvasEdges');
  assert.equal(layoutSaved, true, 'autoFitCanvasNodeHeight must schedule layout save');
}

// --- P1 Native Library Routing & Capability Isolation Tests ---
assert.doesNotMatch(html, /\ballLibraryItems\b/, 'allLibraryItems must not exist in index.html');
assert.match(html, /async function loadNativeLibrary\(/, 'loadNativeLibrary must exist');
assert.doesNotMatch(html, /async function loadExternalLibrary\(/,
  'loadExternalLibrary must be removed after the M4 native migration');
assert.doesNotMatch(html, /config\.authMode === 'altero'/,
  'altero routing must be gone from the library loader');
assert.match(html, /function nativeDocumentToLibraryItem\(/, 'nativeDocumentToLibraryItem must exist');
assert.match(html, /function renderNativeLibraryError\(/, 'renderNativeLibraryError must exist');

// --- M4 structural guarantees: the Altero/Zotero external library is fully removed ---
assert.match(html, /function getApiUrl\(\)/,
  'getApiUrl must remain only as an explicit throwing placeholder');
assert.match(html, /Altero 外部文库已于 M4 移除/,
  'the M4 removal guard message must be present (getApiUrl / libraryApiPrefix)');
assert.doesNotMatch(html, /altero\.example\.com/, 'no Altero example host may remain');
assert.doesNotMatch(html, /Zotero-API-Key/, 'no Zotero API key header may remain');
assert.doesNotMatch(html, /Zotero-API-Version/, 'no Zotero API version header may remain');
assert.doesNotMatch(html, /altcanvas_altero_server/, 'no Altero server storage key may remain');
assert.doesNotMatch(html, /dynamicAlteroAllowed|allowDynamicAltero/,
  'dynamic Altero login flags must be gone');
assert.doesNotMatch(html, /altero-auth-section|btn-toggle-auth-mode|input-oauth-server/,
  'Altero auth markup and handlers must be gone');
assert.doesNotMatch(html, /legacy-direct-settings|btn-test-conn|btn-toggle-key|input-user-id/,
  'direct-mode settings markup and handlers must be gone');
assert.doesNotMatch(html, /upstreamSync|externalLibrary/,
  'Altero-only capability flags must be gone');
assert.doesNotMatch(html, /renderCollections|currentSelectedCollection|collections-container/,
  'collection filtering UI and state must be gone');
assert.match(html, /function getHeaders\(extra = \{\}\) \{\s*return \{\s*'Accept': 'application\/json'/,
  'getHeaders must only send Accept JSON');

  // Behavioral Test: loadCollectionsAndLibrary in Local + externalLibrary: false mode
  {
  const loadFnMatch = html.match(/async function loadCollectionsAndLibrary\(\) \{([\s\S]*?)\n    \}/);
  const loadNativeFnMatch = html.match(/async function loadNativeLibrary\(signal\) \{([\s\S]*?)\n    \}/);
  const renderNativeErrMatch = html.match(/function renderNativeLibraryError\(err\) \{([\s\S]*?)\n    \}/);
  const nativeDocToItemMatch = html.match(/function nativeDocumentToLibraryItem\(doc\) \{([\s\S]*?)\n    \}/);

  assert.ok(loadFnMatch && loadNativeFnMatch && renderNativeErrMatch && nativeDocToItemMatch, 'Native library loading functions must exist');
  assert.match(loadNativeFnMatch[0], /limit=\$\{PAGE_SIZE\}&offset=\$\{offset\}/, 'loadNativeLibrary must paginate through the entire library');

  // Case 1: Local mode (externalLibrary: false) - Success 200
  {
    const requestedUrls = [];
    let itemsRendered = false;
    let collectionsRendered = false;
    let localAllItems = [];
    let containerHtml = '';

    const mockDocument = {
      getElementById: (id) => ({
        innerHTML: '',
        set innerHTML(val) { containerHtml = val; },
        get innerHTML() { return containerHtml; },
        addEventListener: () => {}
      })
    };

    const mockConfig = {
      userId: 'local-user-1',
      authMode: 'local',
      capabilities: { externalLibrary: false }
    };

    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.startsWith('/canvas/native/documents')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                id: 'doc-nat-1',
                version: 1,
                title: 'Native Paper 1',
                attachments: [{ id: 'att-nat-1', version: 1, originalFilename: 'paper1.pdf', mimeType: 'application/pdf' }]
              }
            ]
          })
        };
      }
      if (url.startsWith('/canvas/documents/metadata')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: false, status: 404 };
    };

    const nativeDocToItemRunner = new Function(
      'doc',
      `return (${nativeDocToItemMatch[0]})(doc);`
    );

    const testNativeRunner = new Function(
      'config', 'document', 'fetch', 'documentMetas', 'docMetaKey', 'renderCollections', 'renderItems',
      'nativeDocumentToLibraryItem', 'renderNativeLibraryError', 'errorMessage', 'escapeHTML', 'updateAuthUI', 'openSettingsModal', 'beginLogin',
      `
      let libraryController = null;
      let allItems = [];
      ${nativeDocToItemMatch[0]}
      ${renderNativeErrMatch[0]}
      ${loadNativeFnMatch[0]}
      ${loadFnMatch[0]}
      return {
        run: async () => { await loadCollectionsAndLibrary(); return allItems; }
      };
      `
    );

    const instance = testNativeRunner(
      mockConfig,
      mockDocument,
      mockFetch,
      new Map(),
      () => '',
      () => { collectionsRendered = true; },
      () => { itemsRendered = true; },
      nativeDocToItemRunner,
      () => {},
      e => e.message,
      s => s,
      () => {},
      () => {},
      () => {}
    );

    const resultingItems = await instance.run();
    assert.equal(resultingItems.length, 1, 'allItems must contain 1 native document');
    assert.equal(resultingItems[0].key, 'doc-nat-1');
    assert.equal(resultingItems[0].isNative, true);
    assert.equal(resultingItems[0].libraryType, 'native');
    assert.equal(resultingItems[0].children.length, 1);
    assert.equal(itemsRendered, true, 'renderItems must be called');
    assert.equal(collectionsRendered, false, 'renderCollections must no longer exist or be invoked after M4');

    // Verify NO Altero requests were made
    assert.ok(requestedUrls.some(u => u.includes('/canvas/native/documents')), 'Must request native documents');
    assert.ok(requestedUrls.some(u => u.includes('limit=')), 'Native library request must carry pagination params');
    assert.ok(!requestedUrls.some(u => u.includes('/api/users/') || u.includes('/api/groups/')), 'Local mode must never query /api/users/ or /api/groups/');
  }

  // Case 2: Local mode - Native documents returns 500
  {
    const requestedUrls = [];
    let containerHtml = '';

    const mockDocument = {
      getElementById: (id) => ({
        innerHTML: '',
        set innerHTML(val) { containerHtml = val; },
        get innerHTML() { return containerHtml; },
        addEventListener: () => {},
        querySelector: () => null
      })
    };

    const mockConfig = {
      userId: 'local-user-1',
      authMode: 'local',
      capabilities: { externalLibrary: false }
    };

    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.startsWith('/canvas/native/documents')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: false, status: 500 };
    };

    const testNativeRunner500 = new Function(
      'config', 'document', 'fetch', 'documentMetas', 'docMetaKey', 'renderCollections', 'renderItems',
      'renderNativeLibraryError', 'errorMessage', 'escapeHTML', 'updateAuthUI', 'openSettingsModal', 'beginLogin',
      `
      let libraryController = null;
      let allItems = [];
      function nativeDocumentToLibraryItem(d) { return d; }
      ${renderNativeErrMatch[0]}
      ${loadNativeFnMatch[0]}
      ${loadFnMatch[0]}
      return {
        run: async () => { await loadCollectionsAndLibrary(); return { allItems }; }
      };
      `
    );

    const instance500 = testNativeRunner500(
      mockConfig,
      mockDocument,
      mockFetch,
      new Map(),
      () => '',
      () => {},
      () => {},
      () => {},
      e => e.message,
      s => s,
      () => {},
      () => {},
      () => {}
    );

    await instance500.run();

    // Verify container rendered native library error and did NOT fallback to Altero
    assert.match(containerHtml, /Native 文库加载失败/, '500 error must render Native error message');
    assert.doesNotMatch(containerHtml, /重新授权/, '500 Native error must not display 重新授权');
    assert.ok(!requestedUrls.some(u => u.includes('/api/users/') || u.includes('/api/groups/')), '500 Native error must not fallback to Altero API');
  }

  // Case 3: [M4] Even an altero-shaped config must stay on the native loading path
  {
    const requestedUrls = [];

    const mockDocument = {
      getElementById: (id) => ({
        innerHTML: '',
        addEventListener: () => {},
        querySelector: () => null
      })
    };

    const mockConfig = {
      userId: 'altero-user-123',
      authMode: 'altero',
      capabilities: { externalLibrary: true }
    };

    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.startsWith('/canvas/native/documents')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'doc-nat-2', version: 1, title: 'Native Paper 2' }] })
        };
      }
      if (url.startsWith('/canvas/documents/metadata')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: false, status: 404 };
    };

    const testLocalOnlyRunner = new Function(
      'config', 'document', 'fetch', 'documentMetas', 'docMetaKey', 'renderCollections', 'renderItems',
      'nativeDocumentToLibraryItem', 'renderNativeLibraryError', 'errorMessage', 'escapeHTML', 'updateAuthUI', 'openSettingsModal', 'beginLogin',
      `
      let libraryController = null;
      let allItems = [];
      ${nativeDocToItemMatch[0]}
      ${renderNativeErrMatch[0]}
      ${loadNativeFnMatch[0]}
      ${loadFnMatch[0]}
      return {
        run: async () => { await loadCollectionsAndLibrary(); return { allItems }; }
      };
      `
    );

    const instanceLocalOnly = testLocalOnlyRunner(
      mockConfig,
      mockDocument,
      mockFetch,
      new Map(),
      () => '',
      () => {},
      () => {},
      (d) => d,
      () => {},
      e => e.message,
      s => s,
      () => {},
      () => {},
      () => {}
    );

    const result = await instanceLocalOnly.run();
    assert.equal(result.allItems.length, 1, 'altero-shaped config must still load the NATIVE library');
    assert.ok(requestedUrls.some(u => u.includes('/canvas/native/documents')), 'native documents endpoint must be requested');
    assert.ok(!requestedUrls.some(u => u.includes('/api/') || u.includes('/collections') || u.includes('/items/top')),
      'altero-shaped config must never issue Altero collections/items requests');
  }
}

// Behavioral Test: Native topic documents opening and jumpToSourceAnnotation (0 Altero calls)
{
  const jumpSourceMatch = html.match(/async function jumpToSourceAnnotation\(sourceRef\) \{([\s\S]*?)\n    \}/);
  const resolveTopicPdfMatch = html.match(/async function resolveTopicLibraryPdf\(doc\) \{([\s\S]*?)\n    \}/);
  assert.ok(jumpSourceMatch && resolveTopicPdfMatch, 'Jump and topic resolve functions must exist');

  // 1. Test resolveTopicLibraryPdf for Native
  let alteroCalled = false;
  const resolveTopicRunner = new Function(
    'normalizeLibraryContext', 'getNativeLibraryItem', 'allItems', 'config',
    'getApiUrl', 'libraryApiPrefix', 'fetch', 'getHeaders',
    'doc',
    `return (async () => { ${resolveTopicPdfMatch[1]} })();`
  );

  const nativeResolved = await resolveTopicRunner(
    s => ({ libraryType: s.libraryType || 'native', libraryId: s.libraryId || 'local' }),
    async (docId) => ({
      key: docId,
      isNative: true,
      children: [{ key: 'att-10', data: { contentType: 'application/pdf' }, isNative: true }]
    }),
    [],
    { userId: 'user-1' },
    s => s,
    () => { alteroCalled = true; throw new Error('libraryApiPrefix called'); },
    async () => ({ ok: true }),
    () => ({}),
    { itemKey: 'doc-native-1', libraryType: 'native', libraryId: 'local' }
  );

  assert.ok(nativeResolved, 'resolveTopicLibraryPdf must resolve native document PDF');
  assert.equal(nativeResolved.attachment.key, 'att-10');
  assert.equal(alteroCalled, false, 'resolveTopicLibraryPdf must not call Altero for native doc');

  // 2. Test jumpToSourceAnnotation for Native
  let openItemJumpCalled = null;
  alteroCalled = false;

  const jumpSourceRunner = new Function(
    'getAnnotationPageIndex', 'normalizeLibraryContext', 'currentAttachment', 'isSameLibrary',
    'currentDocumentLibrary', 'currentAnnotationsMap', 'rememberDeletedAnnotation', 'saveKnownDeletedAnnotations',
    'renderCanvas', 'showToast', 'jumpToAnnotation', 'getNativeLibraryItem', 'config', 'allItems',
    'getApiUrl', 'libraryApiPrefix', 'fetch', 'getHeaders', 'openItem', 'reportApplicationError', 'errorMessage',
    'sourceRef',
    `return (async () => { ${jumpSourceMatch[1]} })();`
  );

  const nativeSourceRef = {
    annotationKey: 'ann-nat-1',
    itemKey: 'doc-nat-1',
    attachmentKey: 'att-nat-1',
    libraryType: 'native',
    libraryId: 'local'
  };

  await jumpSourceRunner(
    () => 0,
    s => ({ libraryType: s.libraryType || 'native', libraryId: s.libraryId || 'local' }),
    null, // not current doc
    () => false,
    null,
    new Map([['ann-nat-1', {}]]),
    () => {},
    () => {},
    () => {},
    () => {},
    async () => {},
    async (docId) => ({ key: docId, isNative: true, children: [] }),
    { userId: 'user-1' },
    [],
    s => s,
    () => { alteroCalled = true; throw new Error('libraryApiPrefix called'); },
    async () => ({ ok: true }),
    () => ({}),
    async (item, src) => { openItemJumpCalled = { item, src }; },
    () => {},
    e => e.message,
    nativeSourceRef
  );

  assert.ok(openItemJumpCalled, 'jumpToSourceAnnotation must open native item');
  assert.equal(openItemJumpCalled.item.key, 'doc-nat-1');
  assert.equal(alteroCalled, false, 'jumpToSourceAnnotation must not call Altero for native source');
}

// [M4] The inbox-entry reading behavior test was retired with the inbox;
// native routing coverage continues through the openDocument router test below.

// Behavioral Test: Unified openDocument router
{
  const openDocMatch = html.match(/async function openDocument\(identity\) \{([\s\S]*?)\n    \}/);
  assert.ok(openDocMatch, 'openDocument definition must exist');

  let openNativeDocCalled = null;
  let openItemCalled = null;

  const openDocRunner = new Function(
    'normalizeLibraryContext', 'getNativeLibraryItem', 'showToast', 'openNativeDocument',
    'nativeLibraryItemToDocument', 'nativeLibraryChildToAttachment', 'config', 'openItem',
    'identity',
    `return (async () => { ${openDocMatch[1]} })();`
  );

  const mockNativeItem = {
    key: 'doc-uni-1',
    version: 2,
    libraryType: 'native',
    libraryId: 'local',
    isNative: true,
    data: { title: 'Unified Doc', itemType: 'journalArticle' },
    children: [{ key: 'att-uni-1', version: 1, data: { contentType: 'application/pdf', filename: 'u.pdf' }, isNative: true }]
  };

  await openDocRunner(
    s => ({ libraryType: s.libraryType || (s.isNative ? 'native' : 'user'), libraryId: s.libraryId || 'local' }),
    async () => mockNativeItem,
    () => {},
    async (doc, att) => { openNativeDocCalled = { doc, att }; },
    item => ({ id: item.key, version: item.version, title: item.data?.title }),
    child => ({ id: child?.key, version: child?.version, originalFilename: child?.data?.filename }),
    { userId: '42' },
    async (item, lib) => { openItemCalled = { item, lib }; },
    { itemKey: 'doc-uni-1', libraryType: 'native' }
  );

  assert.ok(openNativeDocCalled, 'openDocument with native identity must delegate to openNativeDocument');
  assert.equal(openNativeDocCalled.doc.id, 'doc-uni-1');
  assert.equal(openNativeDocCalled.att.id, 'att-uni-1');
}

// Behavioral Test: Quick-Import UI multiline keyboard interactions, badges, 503/400 errors, and ISBN retention
{
  const resolveQuickImportMatch = html.match(/async function resolveQuickImport\(\) \{([\s\S]*?)\n    \}/);
  const executeQuickImportMatch = html.match(/async function executeQuickImport\(targetWorkspaceId = null, confirmFuzzy = false\) \{([\s\S]*?)\n    \}/);
  assert.ok(resolveQuickImportMatch && executeQuickImportMatch, 'Quick import functions must exist');

  // 1. Keyboard event handling on #input-quick-import-query
  const keydownMatch = html.match(/document\.getElementById\('input-quick-import-query'\)\?\.addEventListener\('keydown',\s*event\s*=>\s*\{([\s\S]*?)\n    \}\);/);
  assert.ok(keydownMatch, 'input-quick-import-query keydown listener must exist');

  let resolveCalled = false;
  const keydownRunner = new Function('event', 'resolveQuickImport', keydownMatch[1]);

  // 1a. Single-line Enter triggers resolve and prevents default newline
  let prevented = false;
  resolveCalled = false;
  keydownRunner(
    { key: 'Enter', ctrlKey: false, metaKey: false, target: { value: '10.1038/s41586' }, preventDefault: () => { prevented = true; } },
    () => { resolveCalled = true; }
  );
  assert.equal(prevented, true, 'Single-line Enter must call preventDefault');
  assert.equal(resolveCalled, true, 'Single-line Enter must trigger resolveQuickImport');

  // 1b. Multi-line plain Enter retains newline (does NOT trigger resolve, does NOT preventDefault)
  prevented = false;
  resolveCalled = false;
  keydownRunner(
    { key: 'Enter', ctrlKey: false, metaKey: false, target: { value: '@article{key,\n  title={A}\n}' }, preventDefault: () => { prevented = true; } },
    () => { resolveCalled = true; }
  );
  assert.equal(prevented, false, 'Multi-line plain Enter must NOT call preventDefault (preserves newline)');
  assert.equal(resolveCalled, false, 'Multi-line plain Enter must NOT trigger resolveQuickImport');

  // 1c. Multi-line Ctrl+Enter or Cmd+Enter triggers resolve
  prevented = false;
  resolveCalled = false;
  keydownRunner(
    { key: 'Enter', ctrlKey: true, metaKey: false, target: { value: '@article{key,\n  title={A}\n}' }, preventDefault: () => { prevented = true; } },
    () => { resolveCalled = true; }
  );
  assert.equal(prevented, true, 'Multi-line Ctrl+Enter must call preventDefault');
  assert.equal(resolveCalled, true, 'Multi-line Ctrl+Enter must trigger resolveQuickImport');

  // 2. resolveQuickImport badge and error semantics
  const runResolve = async (fetchMock) => {
    const texts = {};
    const classes = { 'quick-import-result-card': new Set(['hidden']), 'quick-import-duplicate-warning': new Set(['hidden']) };
    const elements = {};
    const getEl = (id) => {
      if (!elements[id]) {
        elements[id] = {
          value: '@article{test, title={TS Paper}}',
          set textContent(v) { texts[id] = v; },
          get textContent() { return texts[id] || ''; },
          set innerHTML(v) { texts[`${id}_html`] = v; },
          classList: {
            add: (c) => classes[id]?.add(c),
            remove: (c) => classes[id]?.delete(c),
            contains: (c) => classes[id]?.has(c) ?? false
          },
          disabled: false
        };
      }
      return elements[id];
    };
    const toasts = [];
    const resolveRunner = new Function(
      'document', 'canvasFetch', 'showToast', 'errorMessage', 'escapeHTML', 'texts', 'elements', 'toasts',
      `
      let currentResolvedImport = null;
      ${resolveQuickImportMatch[0]}
      return {
        run: async () => { await resolveQuickImport(); return { currentResolvedImport, texts, elements, toasts }; }
      };
      `
    );
    return resolveRunner(
      { getElementById: getEl },
      fetchMock,
      (msg, type) => toasts.push({ msg, type }),
      e => e.message,
      s => s,
      texts,
      elements,
      toasts
    ).run();
  };

  // 2a. Translation Server parsed item shows (TS) badge with purple styling
  const tsRes = await runResolve(async () => ({
    resolved: { title: 'TS Paper', sourceType: 'bibtex', creators: [{ name: 'A' }] },
    duplicateCandidates: [],
    parsedBy: 'translation_server'
  }));
  assert.equal(tsRes.elements['quick-import-source-badge'].textContent, 'BIBTEX (TS)', 'Translation server parse must display (TS) badge');
  assert.match(tsRes.elements['quick-import-source-badge'].className, /bg-purple-950/, 'Translation server badge must use purple background');

  // 2b. Native resolver parsed item shows clean source badge without (TS)
  const nativeRes = await runResolve(async () => ({
    resolved: { title: 'DOI Paper', sourceType: 'doi', creators: [{ name: 'A' }] },
    duplicateCandidates: [],
    parsedBy: 'native_resolver'
  }));
  assert.equal(nativeRes.elements['quick-import-source-badge'].textContent, 'DOI', 'Native resolver parse must not display (TS)');
  assert.match(nativeRes.elements['quick-import-source-badge'].className, /bg-indigo-950/, 'Native resolver badge must use indigo background');

  // 2c. HTTP 503 branches to the dedicated "Translation Server 未配置" toast.
  // The raw error message is IDENTICAL across 2c/2d/2e — only the status differs,
  // so these assertions prove the branch keys on err.status, not on message text.
  const unavail503Res = await runResolve(async () => {
    const err = new Error('SAME_MESSAGE_DIFFERENT_STATUS');
    err.status = 503;
    err.code = 'translation_server_unavailable';
    throw err;
  });
  assert.ok(unavail503Res.toasts.some(t => t.msg.includes('解析服务未配置') && t.msg.includes('Translation Server')), '503 must branch to the unconfigured Translation Server toast');
  assert.ok(!unavail503Res.toasts.some(t => t.msg.includes('SAME_MESSAGE_DIFFERENT_STATUS')), '503 toast must not passthrough the raw error message');

  // 2d. HTTP 504 branches to the timeout toast, not the generic passthrough.
  const timeout504Res = await runResolve(async () => {
    const err = new Error('SAME_MESSAGE_DIFFERENT_STATUS');
    err.status = 504;
    err.code = 'total_timeout';
    throw err;
  });
  assert.ok(timeout504Res.toasts.some(t => t.msg.includes('解析服务响应超时')), '504 must branch to the timeout toast');
  assert.ok(!timeout504Res.toasts.some(t => t.msg.includes('SAME_MESSAGE_DIFFERENT_STATUS')), '504 toast must not passthrough the raw error message');

  // 2e. HTTP 400 keeps the generic branch and surfaces the server message verbatim.
  const err400Res = await runResolve(async () => {
    const err = new Error('Syntax error on line 4');
    err.status = 400;
    err.code = 'translation_server_error';
    throw err;
  });
  assert.ok(err400Res.toasts.some(t => t.msg.includes('解析失败') && t.msg.includes('Syntax error on line 4')), '400 error toast must surface syntax error detail via the generic branch');

  // 3. executeQuickImport preserves resolved.isbn through the fetch payload
  let postedPayload = null;
  const execRunner = new Function(
    'currentResolvedImport', 'document', 'fetch', 'showToast', 'closeQuickImportModal',
    'loadCollectionsAndLibrary', 'errorMessage',
    `
    ${executeQuickImportMatch[0]}
    return executeQuickImport;
    `
  );
  const execFn = execRunner(
    { title: 'Book With ISBN', isbn: '978-1-4028-9462-6', sourceType: 'ris' },
    { getElementById: (id) => id === 'btn-quick-import-topic' ? { disabled: false } : null },
    async (url, opts) => {
      postedPayload = JSON.parse(opts.body);
      return { ok: true, status: 201, json: async () => ({ data: { outcome: 'created' } }) };
    },
    () => {},
    () => {},
    () => {},
    e => e.message
  );
  await execFn(null, false);
  assert.ok(postedPayload, 'executeQuickImport must post payload to /canvas/imports/native');
  assert.equal(postedPayload.resolved.isbn, '978-1-4028-9462-6', 'Resolved ISBN must be preserved in the POST payload');
}

// ============================================================
// 5.1 [M4 final] 登录初始化行为测试：loadInboxEntries 不存在、零 inbox/Altero 请求
// ============================================================
{
  const initCanvasMatch = scripts[0].match(/async function initCanvasWorkspace\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(initCanvasMatch, 'initCanvasWorkspace must exist in script');
  assert.doesNotMatch(initCanvasMatch[0], /loadInboxEntries/,
    'initCanvasWorkspace must not reference loadInboxEntries');
  assert.doesNotMatch(html, /loadInboxEntries\s*\(/,
    'html must contain zero loadInboxEntries calls');

  const canvasFetchCalls = [];
  let saveState = '';
  let canvasReadyState = null;
  let renderCanvasCalled = false;
  let selectorCalledWith = null;
  let snapshotLoaded = false;
  const localStorageStore = new Map();

  const mockCanvasFetch = async (path, opts) => {
    canvasFetchCalls.push({ path, opts });
    if (path === '/workspaces') return [{ id: 'ws-init-1', name: '我的研究主题' }];
    if (path === '/workspaces/ws-init-1/boards') return [{ id: 'board-init-1', name: '研究画板' }];
    return {};
  };

  const initCanvasRunner = new Function(
    'config', 'setCanvasSaveState', 'localStorage', 'canvasFetch',
    'renderTopicWorkspaceSelector', 'loadCanvasSnapshot', 'reportApplicationError',
    'showToast', 'errorMessage', 'renderCanvas',
    `
    let userWorkspaces = [];
    let canvasWorkspace = null;
    let canvasBoard = null;
    let canvasReady = false;
    // NOTE: loadInboxEntries is deliberately UNDEFINED here.
    return (async () => {
      ${initCanvasMatch[1]}
      return { userWorkspaces, canvasWorkspace, canvasBoard, canvasReady };
    })();
    `
  );

  const result = await initCanvasRunner(
    { mode: 'bff', user: { id: 'u1' }, userId: 'u1' },
    (state, kind) => { saveState = state; },
    {
      getItem: k => localStorageStore.get(k) || null,
      setItem: (k, v) => localStorageStore.set(k, String(v))
    },
    mockCanvasFetch,
    (wsId) => { selectorCalledWith = wsId; },
    async () => { snapshotLoaded = true; },
    (src, err) => { throw err; },
    () => {},
    e => e.message,
    () => { renderCanvasCalled = true; }
  );

  assert.equal(result.canvasWorkspace.id, 'ws-init-1', 'Workspace must be selected');
  assert.equal(result.canvasBoard.id, 'board-init-1', 'Board must be selected');
  assert.equal(selectorCalledWith, 'ws-init-1', 'Topic selector must be populated');
  assert.equal(snapshotLoaded, true, 'Canvas snapshot must be loaded');
  assert.ok(canvasFetchCalls.every(c => !c.path.includes('/inbox')), 'Must make ZERO inbox requests');
  assert.ok(canvasFetchCalls.every(c => !c.path.includes('/api/')), 'Must make ZERO /api/ proxy requests');
  assert.ok(canvasFetchCalls.every(c => !c.path.toLowerCase().includes('altero')), 'Must make ZERO Altero requests');
  assert.ok(canvasFetchCalls.every(c => !c.path.toLowerCase().includes('oidc')), 'Must make ZERO OIDC requests');
  assert.ok(canvasFetchCalls.every(c => !c.path.toLowerCase().includes('oauth')), 'Must make ZERO OAuth requests');
}

// ============================================================
// 5.2 [M4 final] 快速导入真实 DOM 契约测试（严格 ID 白名单，未知 ID 返回 null）
// ============================================================
{
  const openQuickImportMatch = scripts[0].match(/function openQuickImportModal\(\) \{([\s\S]*?)\n    \}/);
  const resolveQuickImportMatch = scripts[0].match(/async function resolveQuickImport\(\) \{([\s\S]*?)\n    \}/);
  const execQuickImportMatch = scripts[0].match(/async function executeQuickImport\([\s\S]*?\{([\s\S]*?)\n    \}/);
  const execDirectoryMatch = scripts[0].match(/async function executeQuickDirectoryImport\([\s\S]*?\{([\s\S]*?)\n    \}/);

  assert.ok(openQuickImportMatch);
  assert.ok(resolveQuickImportMatch);
  assert.ok(execQuickImportMatch);
  assert.ok(execDirectoryMatch);

  // 1. openQuickImportModal: strict DOM provides ONLY existing IDs.
  //    btn-quick-import-inbox-only returns null; code must NOT touch it.
  {
    const element = (tag = 'div') => ({
      disabled: false, value: 'pre', textContent: '',
      focusCalls: 0, focus() { this.focusCalls++; },
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) { if (force !== undefined) force ? this.classes.add(c) : this.classes.delete(c); else this.classes.has(c) ? this.classes.delete(c) : this.classes.add(c); },
        contains(c) { return this.classes.has(c); }
      }
    });

    const strictElements = {
      'quick-import-modal': element(),
      'input-quick-import-query': element('textarea'),
      'quick-import-result-card': element(),
      'btn-quick-import-topic': element('button'),
      'quick-import-duplicate-warning': element(),
      'btn-quick-import-directory': element('button'),
      'quick-import-directory-section': element(),
      'quick-import-default-location': element(),
      'quick-import-default-location-text': element(),
      'quick-import-target-root': element('select'),
      'quick-import-target-dir': element('input'),
      'quick-import-filename': element('input'),
      'quick-import-dir-topics': element('select')
    };

    const strictDoc = {
      getElementById: (id) => strictElements[id] || null
    };

    assert.equal(strictDoc.getElementById('btn-quick-import-inbox-only'), null,
      'Precondition: retired inbox-only button must be absent from strict DOM');

    const openRunner = new Function(
      'document', 'initQuickImportDirectorySection',
      `
      let currentResolvedImport = null;
      ${openQuickImportMatch[1]}
      return { currentResolvedImport };
      `
    );

    // Must NOT throw TypeError: Cannot set properties of null
    const openRes = openRunner(strictDoc, () => {});
    assert.equal(strictElements['input-quick-import-query'].value, '');
    assert.equal(strictElements['btn-quick-import-topic'].disabled, true, 'Topic import stays disabled before resolve');
    assert.equal(strictElements['btn-quick-import-directory'].disabled, true, 'Directory archive stays disabled before resolve');
    assert.equal(strictElements['input-quick-import-query'].focusCalls, 1);
    assert.equal(openRes.currentResolvedImport, null);
  }

  // 2. resolveQuickImport: enables actions based on real available state
  {
    const makeResolveDom = () => ({
      'input-quick-import-query': { value: '10.1038/nature', focus() {} },
      'btn-quick-import-resolve': { disabled: false, textContent: '🔍 解析' },
      'quick-import-result-card': { classList: { remove() {}, add() {} } },
      'quick-import-result-title': { textContent: '' },
      'quick-import-result-meta': { innerHTML: '' },
      'quick-import-result-abstract': { textContent: '' },
      'quick-import-source-badge': { textContent: '', className: '' },
      'quick-import-duplicate-warning': { classList: { remove() {}, add() {} } },
      'quick-import-duplicate-details': { innerHTML: '' },
      'btn-quick-import-topic': { disabled: true },
      'btn-quick-import-directory': { disabled: true }
    });

    const runResolveTest = async ({ workspace, roots, canvasFetchImpl }) => {
      const dom = makeResolveDom();
      const doc = { getElementById: id => dom[id] || null };
      const toasts = [];
      const runner = new Function(
        'document', 'canvasFetch', 'showToast', 'errorMessage', 'escapeHTML',
        'canvasWorkspace', 'sourceFilesState', 'updateQuickImportDefaultLocation', 'dom', 'toasts',
        `
        let currentResolvedImport = null;
        return (async () => {
          ${resolveQuickImportMatch[1]}
          return { currentResolvedImport, dom, toasts };
        })();
        `
      );
      return runner(
        doc, canvasFetchImpl,
        (msg, type) => toasts.push({ msg, type }),
        e => e.message,
        s => String(s),
        workspace,
        { roots },
        () => {},
        dom, toasts
      );
    };

    // Success with workspace & roots: both buttons enabled, zero inbox calls
    const calls = [];
    const successRes = await runResolveTest({
      workspace: { id: 'ws-1' },
      roots: [{ id: 'r-1', displayName: '根' }],
      canvasFetchImpl: async (path, opts) => {
        calls.push(path);
        return {
          resolved: { sourceType: 'doi', title: 'Resolved Paper', creators: [{ name: 'A' }] },
          parsedBy: 'native_resolver'
        };
      }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], '/imports/resolve');
    assert.equal(successRes.dom['btn-quick-import-topic'].disabled, false, 'Enabled when workspace exists');
    assert.equal(successRes.dom['btn-quick-import-directory'].disabled, false, 'Enabled when roots exist');

    // Success without a workspace: topic button stays disabled, directory button enabled
    const noWsRes = await runResolveTest({
      workspace: null,
      roots: [{ id: 'r-1' }],
      canvasFetchImpl: async () => ({ resolved: { title: 'T' } })
    });
    assert.equal(noWsRes.dom['btn-quick-import-topic'].disabled, true, 'Topic import disabled without a workspace');
    assert.equal(noWsRes.dom['btn-quick-import-directory'].disabled, false);

    // Resolve failure: both buttons stay disabled, error toast surfaces
    const failRes = await runResolveTest({
      workspace: { id: 'ws-1' },
      roots: [{ id: 'r-1' }],
      canvasFetchImpl: async () => { throw new Error('resolve failed'); }
    });
    assert.equal(failRes.dom['btn-quick-import-topic'].disabled, true);
    assert.equal(failRes.dom['btn-quick-import-directory'].disabled, true);
    assert.ok(failRes.toasts.some(t => t.msg.includes('resolve failed')));
  }

  // 3. executeQuickImport: strict DOM, zero inbox references in body, duplicate_content handling
  {
    const topicBtn = { disabled: false };
    const doc = { getElementById: id => id === 'btn-quick-import-topic' ? topicBtn : null };
    const toasts = [];
    let modalClosed = false;
    let libraryReloaded = false;

    const runner = new Function(
      'currentResolvedImport', 'document', 'fetch', 'showToast', 'closeQuickImportModal',
      'loadCollectionsAndLibrary', 'errorMessage',
      `
      return (async (targetWorkspaceId, confirmFuzzy) => {
        ${execQuickImportMatch[1]}
      });
      `
    );

    let postedOpts = null;
    const execute = runner(
      { sourceType: 'doi', title: 'Topic Paper' },
      doc,
      async (url, opts) => {
        postedOpts = opts;
        return {
          ok: true, status: 201,
          json: async () => ({ data: { outcome: 'created' } })
        };
      },
      (msg, type) => toasts.push({ msg, type }),
      () => { modalClosed = true; },
      () => { libraryReloaded = true; },
      e => e.message
    );

    await execute('ws-1', false);
    assert.ok(postedOpts);
    const body = JSON.parse(postedOpts.body);
    assert.equal(body.targetWorkspaceId, 'ws-1');
    assert.equal('inbox' in body, false);
    assert.equal('inboxOnly' in body, false);
    assert.equal(modalClosed, true);
    assert.equal(libraryReloaded, true);

    // 409 duplicate_content surfaces specific toast and keeps topicBtn enabled
    modalClosed = false;
    const dupExecute = runner(
      { sourceType: 'doi', title: 'Topic Paper' },
      doc,
      async () => ({
        ok: false, status: 409,
        json: async () => ({
          error: { code: 'duplicate_content' },
          data: { document: { title: '已存在的文献' } }
        })
      }),
      (msg, type) => toasts.push({ msg, type }),
      () => { modalClosed = true; },
      () => {},
      e => e.message
    );
    await dupExecute('ws-1', false);
    assert.equal(modalClosed, false, 'Modal stays open on duplicate');
    assert.ok(toasts.some(t => t.msg.includes('相同 SHA-256') && t.msg.includes('已存在的文献')));
    assert.equal(topicBtn.disabled, false, 'Button re-enabled after duplicate refusal');
  }

  // 4. executeQuickDirectoryImport: empty targetDir sends undefined (server defaults to 网页导入)
  {
    const dirBtn = { disabled: false, textContent: '按钮' };
    const elements = {
      'quick-import-target-root': { value: 'root-strict' },
      'quick-import-target-dir': { value: '   ' }, // blank -> defaults on server
      'quick-import-filename': { value: '' },
      'quick-import-dir-topics': { selectedOptions: [{ value: 'ws-dir-1' }] },
      'btn-quick-import-directory': dirBtn
    };
    const doc = { getElementById: id => elements[id] || null };
    let postedBody = null;
    let modalClosed = false;

    const runner = new Function(
      'currentResolvedImport', 'document', 'fetch', 'showToast', 'closeQuickImportModal',
      'loadCollectionsAndLibrary', 'promptM4FileName', 'resetQuickDirectoryButton', 'errorMessage',
      `
      return (async (confirmFuzzy, overrideFilename) => {
        ${execDirectoryMatch[1]}
      });
      `
    );

    const executeDir = runner(
      { sourceType: 'doi', title: 'Directory Paper' },
      doc,
      async (url, opts) => {
        postedBody = JSON.parse(opts.body);
        return {
          ok: true, status: 201,
          json: async () => ({ data: { outcome: 'created' } })
        };
      },
      () => {},
      () => { modalClosed = true; },
      () => {},
      async () => ({ ok: true }),
      () => { dirBtn.disabled = false; },
      e => e.message
    );

    await executeDir(false, null);
    assert.ok(postedBody);
    assert.equal(postedBody.rootId, 'root-strict');
    assert.equal(postedBody.targetDir, undefined, 'Empty directory input must not send a blank string; server applies 网页导入');
    assert.deepEqual(postedBody.topicIds, ['ws-dir-1']);
    assert.equal(modalClosed, true);
  }
}

// [M4 UX] Manual topic binding entry on native library rows; the topic-tab
// empty state must not reference the retired inbox.
assert.ok(html.includes('data-native-action="add-topic"'), 'library rows must expose the manual 主题 binding button');
assert.equal((html.match(/id=["']add-to-topic-modal["']/g) || []).length, 1, 'add-to-topic modal must exist exactly once');
assert.ok(html.includes('openAddToTopicModal(item)'), 'library row clicks must wire openAddToTopicModal');
assert.ok(html.includes('btn-confirm-add-to-topic'), 'add-to-topic confirm button must exist');
assert.ok(!html.includes('可在“收件箱”中先完成 AI 分类'), 'topic-tab empty state must not reference the retired inbox');

// [M4 UX] 扫描 → AI 刷新元数据（分类 + 标题识别同一次调用）自动闭环。
assert.ok(html.includes('refreshLibraryMetadataWithAi(enrolledIds)'),
  'a scan with newly enrolled documents must trigger the AI metadata refresh');
assert.ok(html.includes("AI 刷新元数据"), 'the scan button must surface the metadata-refresh phase');
assert.ok(html.includes('ai_not_configured') && html.includes('暂以文件名作为文库文件名'),
  'an unconfigured AI must degrade gracefully after enrollment');
assert.ok(/async function libraryAiClassifyFlow[\s\S]*?refreshLibraryMetadataWithAi\(null\)/.test(html),
  'the manual AI button must reuse the shared metadata-refresh flow');
// 刷新必须读取 PDF 真实正文（与「✨ 识别标题」同深度），而不是只凭元数据。
assert.ok(html.includes("import('/reader/pdf/build/pdf.mjs')"),
  'the refresh flow must reuse the vendored PDF.js build for text extraction');
assert.ok(html.includes('extractAttachmentPdfText('),
  'the refresh flow must extract real page text per document');
assert.ok(html.includes('documentTexts'),
  'classification must receive the client-extracted document texts');
// 网关（nginx 60s）超时防御：刷新必须分批，任何单请求都远小于 60s。
assert.ok(html.includes('AI_REFRESH_BATCH_SIZE = 10'),
  'the metadata refresh must run in small batches under the gateway timeout');
assert.ok(html.includes("'/native/documents/classify'"),
  'follow-up batches must reuse the classify-only endpoint instead of re-minting topics');
assert.ok(html.includes('批失败'),
  'partial batch failure must be surfaced instead of a fake success');
// [M4 UX] 文库与主题分类合并为一个 Tab：主题筛选内联到文库面板，
// 排序控件（时间/名称）作用于文库列表与主题视图。
assert.ok(!html.includes('btn-library-view-topics'), 'the separate 主题分类 tab must be merged away');
assert.ok(!html.includes('library-topics-panel') && !html.includes('topic-library-items'),
  'removed topic-tab panels must not linger in the DOM');
assert.ok(html.includes('let libraryTopicFilter'), 'the topic filter must keep its own selection state');
assert.ok(html.includes("allOption.textContent = '全部主题'"), 'the topic filter must offer an all-topics empty state');
assert.ok(html.includes('id="select-library-sort"'), 'the library must expose a sort control');
assert.ok(html.includes('function sortLibraryItems'), 'library items must be sortable');
assert.ok(html.includes('libraryItemTimestamp'), 'sorting must support timestamp modes');
assert.ok(html.includes('zh-Hans-CN'), 'title sorting must use Chinese-aware collation');
// [M4 UX] AI 识别分增量与强制两档：✨ 只识别未命名文献（跳过已有 AI 元数据），
// 🔁 才会全量重识别并覆盖。
assert.ok(html.includes('btn-library-ai-reclassify'), 'a force re-recognize entry must exist');
assert.ok(html.includes('refreshLibraryMetadataWithAi(null, { onProgress: t => { if (btn) btn.textContent = t; }, force })'),
  'the shared refresh must honor the force flag');
assert.ok(html.includes("meta.source === 'ai_classification'"),
  'documents with current AI metadata must be skipped on incremental runs');
assert.ok(html.includes('全部文献均已识别过 AI 元数据'),
  'an all-recognized library must surface a no-op notice instead of a fake AI run');
// 「已识别」必须指"按当前附件内容识别过"（记录了附件 id + 版本），
// 而不是仅仅存在一条早期元数据——否则未读正文的旧记录会被误跳过。
assert.ok(html.includes('recognizedVersion >= currentVersion'),
  'the skip check must compare the recognized attachment version');
assert.ok(html.includes('meta.attachmentKey !== (attachment.key || attachment.data?.key)'),
  'the skip check must bind recognition to the current attachment id');

assert.match(devServer, /style-src-attr 'unsafe-inline'/, 'CSP must permit dynamic Canvas geometry styles');
assert.match(devServer, /script-src 'self'/, 'script CSP must remain restricted');

console.log('✅ Canvas DOM, controls, persistence hooks, C3 export/import/provenance, C5 AI synthesis UI, and mobile pane wiring passed');
