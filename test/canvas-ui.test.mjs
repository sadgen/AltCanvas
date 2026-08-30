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
  'ai-modal', 'ai-panel', 'ai-selected-chips', 'input-ai-prompt', 'btn-submit-ai',
  'btn-close-ai', 'btn-cancel-ai', 'btn-open-ai-settings',
  'ai-provider-status', 'ai-provider-name', 'ai-provider-model', 'btn-test-ai-conn',
  'btn-canvas-zoom-out', 'btn-canvas-zoom-reset', 'btn-canvas-zoom-in', 'canvas-save-state'
]) {
  assert.equal((html.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length, 1, `${id} must exist exactly once`);
}

assert.match(html, /async function initCanvasWorkspace\(\)/);
assert.match(html, /async function importCurrentAnnotations\(\)/);
assert.match(html, /function beginCanvasNodeDrag\(/);
assert.match(html, /function beginCanvasNodeResize\(/);
assert.match(html, /async function saveCanvasLayout\(\)/);
assert.match(html, /async function handleCanvasConnectSelection\(/);
assert.match(html, /async function undoLastCanvasAction\(/);
assert.match(html, /async function deleteCanvasNodes\(nodes\)/);
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
assert.match(html, /async function executeAiGeneration\(\)/);
assert.match(html, /async function loadAiConfig\(\)/);
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
assert.doesNotMatch(html, /modelConfig:\s*aiConfig/,
  'the browser must not choose an arbitrary AI endpoint per request');
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
assert.doesNotMatch(html, /研究标注白板 \(Cards\)/);
assert.match(devServer, /style-src-attr 'unsafe-inline'/, 'CSP must permit dynamic Canvas geometry styles');
assert.match(devServer, /script-src 'self'/, 'script CSP must remain restricted');

console.log('✅ Canvas DOM, controls, persistence hooks, C3 export/import/provenance, C5 AI synthesis UI, and mobile pane wiring passed');
