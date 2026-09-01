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
  'select-topic-workspace', 'btn-open-topic-settings', 'btn-open-inbox', 'inbox-unread-badge', 'btn-toggle-canvas-max',
  'inbox-modal', 'inbox-panel', 'btn-close-inbox', 'btn-inbox-scan-now', 'btn-inbox-classify-ai', 'btn-inbox-accept-ai', 'input-inbox-search', 'inbox-items-container',
  'btn-inbox-batch-assign', 'btn-inbox-batch-defer', 'btn-inbox-batch-ignore',
  'batch-topics-modal', 'batch-topics-panel', 'btn-close-batch-topics', 'batch-topics-list', 'input-new-topic-quick', 'btn-create-topic-quick', 'btn-confirm-batch-topics',
  'topic-settings-modal', 'topic-settings-panel', 'btn-close-topic-settings', 'input-topic-name', 'input-topic-desc', 'input-topic-question', 'input-topic-inclusion', 'input-topic-exclusion', 'btn-save-topic-meta', 'btn-delete-topic', 'select-bind-collection', 'select-bind-mode', 'btn-submit-bind-collection', 'topic-bindings-list', 'topic-docs-list',
  'doc-meta-modal', 'doc-meta-panel', 'btn-close-doc-meta', 'input-doc-meta-clean-title', 'input-doc-meta-institution', 'input-doc-meta-year', 'input-doc-meta-report-title', 'input-doc-meta-subtitle', 'input-doc-meta-summary', 'btn-doc-meta-ai-extract', 'btn-cancel-doc-meta', 'btn-save-doc-meta', 'btn-doc-edit-title', 'btn-doc-ai-title',
  'btn-canvas-quick-import', 'btn-inbox-quick-import', 'quick-import-modal', 'quick-import-panel', 'btn-close-quick-import', 'input-quick-import-query', 'btn-quick-import-resolve', 'quick-import-result-card', 'btn-cancel-quick-import', 'btn-quick-import-inbox-only', 'btn-quick-import-topic',
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
assert.match(html, /async function executeQuickImport\(/, 'Quick import must execute durable import into workspace or inbox');
assert.match(html, /canvas-node-quick-verify/, 'Canvas cards with sourceRef must render quick-verify button');
assert.match(html, /documentMetas\.get\(docMetaKey\(entry\.libraryType, entry\.libraryId, entry\.itemKey\)\)/,
  'inbox rendering must use composite key to lookup document metadata');
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
assert.match(html, /async function loadTopicBindings\(\)/);
assert.match(html, /async function syncCollectionBinding\(/);
assert.match(html, /async function loadInboxEntries\(/);
assert.match(html, /function renderInboxEntries\(\)/);
assert.match(html, /async function scanAlteroInbox\(\)/);
assert.match(html, /async function classifyInboxWithAi\(\)/);
assert.match(html, /async function acceptAllAiSuggestions\(\)/);
assert.match(html, /id="btn-library-view-all"/);
assert.match(html, /id="btn-library-view-topics"/);
assert.match(html, /id="select-library-topic"/);
assert.match(html, /async function loadTopicLibraryDocuments\(\)/);
assert.match(html, /resolveTopicLibraryPdf/);
assert.match(html, /rememberDocumentMetas\(result\?\.documentMetas\)/,
  'AI classification must display Chinese names returned by the same request');

// --- Behavioral test: Directly invoking production acceptAllAiSuggestions from index.html ---
{
  const fnMatch = /async function acceptAllAiSuggestions\(\)\s*\{([\s\S]*?)\n    \}/.exec(scripts[0]);
  assert.ok(fnMatch, 'acceptAllAiSuggestions must be found in script');

  const inboxAiClassifications = new Map();
  inboxAiClassifications.set('entry-1', [
    { workspaceId: 'ws-A', workspaceName: 'Topic A', confidence: 0.9 },
    { workspaceId: 'ws-B', workspaceName: 'Topic B', confidence: 0.85 }
  ]);

  const calls = [];
  const toastCalls = [];
  const mockContext = {
    inboxAiClassifications,
    showToast: (msg, type) => toastCalls.push({ msg, type }),
    canvasFetch: async (path, options) => {
      calls.push({ path, options });
      const targetWs = options.body.targetWorkspaceIds[0];
      if (targetWs === 'ws-A') return { processed: 1 };
      throw new Error('Network error on Topic B');
    },
    document: {
      getElementById: () => ({ disabled: false })
    },
    loadInboxEntries: async () => {},
    loadTopicDocuments: async () => {},
    console: { warn: () => {} }
  };

  const runner = new Function(
    'inboxAiClassifications', 'showToast', 'canvasFetch', 'document', 'loadInboxEntries', 'loadTopicDocuments', 'console',
    `return (async () => { ${fnMatch[1]} })();`
  );

  await runner(
    mockContext.inboxAiClassifications,
    mockContext.showToast,
    mockContext.canvasFetch,
    mockContext.document,
    mockContext.loadInboxEntries,
    mockContext.loadTopicDocuments,
    mockContext.console
  );

  assert.equal(calls.length, 2, 'Must attempt both topics');
  assert.equal(toastCalls.length, 1, 'Must show error toast on partial failure');
  assert.match(toastCalls[0].msg, /1 个主题处理失败/);
  assert.equal(inboxAiClassifications.has('entry-1'), true, 'Entry must be retained when Topic B fails');
  assert.deepEqual(inboxAiClassifications.get('entry-1'), [
    { workspaceId: 'ws-B', workspaceName: 'Topic B', confidence: 0.85 }
  ], 'Only failed topic recommendations should remain in the map for retry');
}

assert.match(html, /async function executeInboxBatchAction\(/);
assert.match(html, /id="inbox-scroll-region"/);
assert.match(html, /#inbox-panel\s*\{[\s\S]*height:\s*min\(46rem, calc\(100dvh - 2rem\)\)/,
  'the inbox must stay within the viewport and scroll only its document region');
assert.match(html, /id="btn-inbox-batch-reopen"/);
assert.match(html, /action === 'reopen'/);
assert.match(html, /已归入的主题不会被移除/);
assert.match(html, /function openBatchTopicsModal\(/);
assert.match(html, /async function confirmBatchTopicAssignment\(\)/);
assert.match(html, /function toggleCanvasMaximize\(\)/);
assert.match(html, /id="btn-inbox-generate-topics-ai"/);
assert.match(html, /async function generateTopicsWithAi\(\)/);
assert.match(html, /async function openInboxEntryForReading\(/);
assert.match(html, /class="btn-entry-read/);
assert.match(html, /\/inbox\/scan/);
assert.match(html, /\/inbox\/classify/);
assert.match(html, /\/inbox\/generate-topics/);
assert.match(html, /\/inbox\/batch-action/);
assert.match(html, /已直接复用现有全文分析图谱/);
assert.match(html, /async function loadAlteroCollectionsForBinding\(\)/);
assert.match(html, /const seenKeys = new Set\(\);[\s\S]*Duplicate collection key/);
assert.match(html, /Collections count exceeded safety limit/);
assert.match(html, /\/collection-bindings\/\$\{bindingId\}\/sync/);
assert.match(html, /局域网 HTTP 会明文传输卡片内容与凭据/,
  'AI settings must warn about plaintext private-network transport');
assert.match(html, /libraryType === 'native'/,
  'normalizeLibraryContext must preserve native library type without mapping to user');
assert.match(html, /library\.libraryType === 'native'/,
  'libraryApiPrefix must handle native library without mapping to users');
assert.match(html, /async function uploadNativePdfFile\(/,
  'UI must provide uploadNativePdfFile handler for PDF uploads');
assert.match(html, /async function openNativeDocument\(/,
  'UI must provide openNativeDocument for opening native documents and attachments');
assert.match(html, /function setupNativePdfUpload\(/,
  'UI must setup file drop and file input event handlers for native PDF uploads');
assert.match(html, /id="btn-upload-pdf-top"/,
  'UI header must provide native PDF upload button');

console.log('✅ All Canvas UI Tests Passed Successfully!');
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
assert.match(devServer, /style-src-attr 'unsafe-inline'/, 'CSP must permit dynamic Canvas geometry styles');
assert.match(devServer, /script-src 'self'/, 'script CSP must remain restricted');

console.log('✅ Canvas DOM, controls, persistence hooks, C3 export/import/provenance, C5 AI synthesis UI, and mobile pane wiring passed');
