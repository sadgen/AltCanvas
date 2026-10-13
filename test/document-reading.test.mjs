import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { zipSync, strToU8 } from 'fflate';
import { documentMime, extractTextDocument, validateDocumentBytes } from '../server/document-formats.mjs';
import { clusteredLayout } from '../server/reading-policy.mjs';
import { CanvasStore, canvasActorKey } from '../server/canvas-store.mjs';
import { createCanvasHandler } from '../server/canvas-api.mjs';
import { createSession, destroySession } from '../server/session.mjs';
import { renameSourceFile, trashSourceFile, restoreSourceFile } from '../server/native-file-ops.mjs';
import { iteratePdfEntries } from '../server/library-scanner.mjs';

console.log('🧪 Document reading and multi-topic regressions');
const epub = zipSync({
  mimetype: strToU8('application/epub+zip'),
  'META-INF/container.xml': strToU8('<container><rootfile full-path="OEBPS/book.opf"/></container>'),
  'OEBPS/book.opf': strToU8('<package><dc:title>测试书</dc:title><dc:creator>作者</dc:creator><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>'),
  'OEBPS/a.xhtml': strToU8('<html><h1>第一章</h1><p>有效正文。</p><script>alert(1)</script><img src="https://external.test/track"></html>')
});
assert.equal(documentMime('book.EPUB'), 'application/epub+zip');
const book = extractTextDocument(epub, 'book.epub');
assert.equal(book.title, '测试书'); assert.deepEqual(book.authors, ['作者']);
assert.match(book.pages[0].text, /有效正文/); assert.doesNotMatch(book.pages[0].text, /alert|https:/);
assert.equal(validateDocumentBytes(epub, 'book.epub'), 'application/epub+zip');
assert.throws(() => validateDocumentBytes(Buffer.from('abc'), 'a.pdf'), /PDF/);
assert.throws(() => validateDocumentBytes(Buffer.from([0, 1, 2]), 'a.txt'), /二进制/);
assert.throws(() => extractTextDocument(zipSync({ '../evil.opf': strToU8('bad') }), 'a.epub'), /路径/);
assert.equal(extractTextDocument(Buffer.concat([Buffer.from([0xff,0xfe]), Buffer.from('中文', 'utf16le')]), 'a.txt').pages[0].text, '中文');

const nodes = [{ id: 'a', width: 400, height: 340 }, { id: 'b', width: 300, height: 120 }, { id: 'c', width: 600, height: 200 }];
const layout = clusteredLayout(nodes, [{ nodeIds: ['a', 'b', 'a'] }, { nodeIds: ['c'] }]);
assert.equal(layout.length, 3);
assert.ok(layout[1].y >= layout[0].y + nodes[0].height);
assert.ok(layout[2].x >= layout[0].x + nodes[0].width);

class Response extends EventEmitter {
  headers = {}; chunks = []; statusCode = 200;
  setHeader(k,v) { this.headers[k.toLowerCase()] = v; }
  writeHead(code,headers={}) { this.statusCode=code; Object.entries(headers).forEach(([k,v])=>this.setHeader(k,v)); }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
  end(chunk) { if(chunk) this.chunks.push(Buffer.from(chunk)); this.emit('finish'); }
  get payload() { return JSON.parse(Buffer.concat(this.chunks).toString() || 'null'); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altcanvas-reading-'));
const store = new CanvasStore(path.join(dir, 'canvas.sqlite'));
const session = createSession({ userId: 'reading-test', issuer: 'https://test.example', subject: 'reading', groupIds: [] });
const actor = canvasActorKey('https://test.example', 'reading');
let modelReply = {};
const handler = createCanvasHandler(store, {
  aiPublicConfig: () => ({ configured: true, model: 'mock-model' }),
  aiCompletion: async () => JSON.stringify(modelReply)
});
async function call(url, body, headers={}, method=body===undefined?'GET':'POST') {
  const response = new Response();
  const data = Buffer.isBuffer(body)?body:body===undefined?null:Buffer.from(JSON.stringify(body));
  const req = { method, headers: { cookie: `altcanvas_session=${session.id}`, ...headers }, socket: { encrypted: false, remoteAddress:'127.0.0.1' }, async *[Symbol.asyncIterator]() { if(data)yield data; } };
  await handler(req, response, new URL(url, 'http://test.example')); return response;
}
try {
  for (const [filename, bytes] of [['paper.txt', Buffer.from('研究问题。方法与证据。限制。')], ['book.epub', Buffer.from(epub)]]) {
    const uploaded = await call('/canvas/native/upload', bytes, { 'content-type':'application/octet-stream','x-filename':filename });
    assert.equal(uploaded.statusCode, 201, JSON.stringify(uploaded.payload));
    const att = uploaded.payload.data.attachment;
    assert.equal(att.mimeType, documentMime(filename));
    const read = await call(`/canvas/native/attachments/${att.id}/text`);
    assert.equal(read.statusCode, 200); assert.ok(read.payload.data.pages.length);
    const ann = await call(`/canvas/native/attachments/${att.id}/annotations`, { annotationType:'highlight', quote:read.payload.data.pages[0].text.slice(0,4), position:{pageIndex:0,textStart:0,textEnd:4},pageLabel:'1' });
    assert.equal(ann.statusCode, 201);
    const reread = await call(`/canvas/native/attachments/${att.id}/annotations`);
    assert.equal(reread.payload.data[0].position.textEnd,4);
  }
  const rootPath = path.join(dir, 'root'); fs.mkdirSync(rootPath);
  fs.writeFileSync(path.join(rootPath,'source.txt'), '目录文本');
  fs.writeFileSync(path.join(rootPath,'source.epub'), epub);
  const root = store.ensureLibraryRootsFromConfig(actor, [{ absolutePath:rootPath, displayName:'测试目录' }])[0];
  assert.equal([...iteratePdfEntries(rootPath)].length, 2);
  const sf = store.createSourceFile(actor,root.id,{relativePath:'source.txt',filename:'source.txt',sha256:crypto.createHash('sha256').update('目录文本').digest('hex'),sizeBytes:Buffer.byteLength('目录文本')});
  const enrolled = store.enrollExistingSourceFile(actor,sf.id); assert.equal(enrolled.attachment.mimeType,'text/plain');
  const openSync = fs.openSync, closeSync = fs.closeSync;
  let openedHandles=0, closedHandles=0;
  try {
    fs.openSync=(...args)=>{openedHandles++;return openSync(...args);};
    fs.closeSync=(...args)=>{closedHandles++;return closeSync(...args);};
    const invalid=await call(`/canvas/native/attachments/${enrolled.attachment.id}/file`,undefined,{range:'bytes=999999-'});
    assert.equal(invalid.statusCode,416);
    assert.equal(openedHandles,closedHandles,'invalid Range must close the verified file handle');
  } finally {fs.openSync=openSync;fs.closeSync=closeSync;}
  let row = store.getSourceFile(actor,sf.id);
  row = (await renameSourceFile(store,actor,row.id,row.version,'renamed.txt')).sourceFile;
  assert.equal(fs.existsSync(path.join(rootPath,'renamed.txt')),true);
  await assert.rejects(renameSourceFile(store,actor,row.id,row.version,'renamed.pdf'),/extension/);
  row = (await trashSourceFile(store,actor,row.id,row.version)).sourceFile;
  assert.ok(fs.existsSync(path.join(rootPath,`.altcanvas-trash/${row.id}.txt`)));
  row = (await restoreSourceFile(store,actor,row.id,row.version)).sourceFile;
  assert.ok(fs.existsSync(path.join(rootPath,'renamed.txt')));

  const t1=store.createWorkspace(actor,{name:'统计方法'}), t2=store.createWorkspace(actor,{name:'量化投资'});
  const doc = enrolled.document;
  modelReply={topics:[{name:'统计新方法',necessityReason:'模型试图增加类似主题但现有主题实际覆盖'}],classifications:{[doc.id]:[
    {workspaceId:t1.id,confidence:0.9},{workspaceId:t2.id,confidence:0.8},{topicName:'统计新方法',confidence:0.95}
  ]},documentMetadata:{[doc.id]:{cleanTitle:'目录文本'}}};
  const classified=await call('/canvas/native/classify/generate-topics',{documentIds:[doc.id],documentTexts:{[doc.id]:'统计方法用于量化投资'}});
  assert.equal(classified.statusCode,200); assert.equal(classified.payload.data.createdWorkspaces.length,0,'existing matches prevent needless new topics');
  assert.equal(classified.payload.data.classifications[doc.id].length,2,'all matching existing topics returned');
  modelReply={topics:[{name:'天文学'}],classifications:{[doc.id]:[{topicName:'天文学',confidence:0.99}]}};
  const unjustified=await call('/canvas/native/classify/generate-topics',{documentIds:[doc.id]});
  assert.equal(unjustified.payload.data.createdWorkspaces.length,0,'existing taxonomy requires explicit necessity');

  // Execute the actual frontend metadata flow to test multi-topic adoption.
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const body=html.match(/async function refreshLibraryMetadataWithAi\(documentIds = null, \{ onProgress = null, force = false \} = \{\}\) \{([\s\S]*?)\n    \}/)[1];
  const writes=[];
  const flow=new Function('allItems','documentMetas','docMetaKey','currentDocumentLibrary','config','AI_REFRESH_TEXT_MAX_DOCS','AI_REFRESH_BATCH_SIZE','extractAttachmentPdfText','isReadableAttachment','m4Fetch','showToast',`return (async()=>{const documentIds=null, onProgress=null, force=false;${body}})()`);
  await flow([{isNative:true,key:doc.id,children:[{key:'att',data:{contentType:'application/pdf'}}]}],new Map(),()=>'',null,{},50,4,async()=> '正文',()=>true,async(url,options)=>{
    if(url.includes('generate-topics')) return {data:{classifications:{[doc.id]:[{workspaceId:t1.id,confidence:.9},{workspaceId:t2.id,confidence:.8},{workspaceId:'weak',confidence:.2}]}}};
    writes.push(options.body);return {data:[{ok:true}]};
  },()=>{});
  assert.deepEqual(writes.map(w=>w.topicIds[0]),[t1.id,t2.id]);

  const board=store.createBoard(actor,t1.id,{name:'阅读图'});
  const graph={title:'样例',overview:'概览',evidenceQuote:'目录文本',evidencePage:1,guide:{question:'真实问题',takeaway:'真实结论',limitations:'范围有限'},
    sections:[{id:'section-0',title:'推理',body:'模型解释',pageStart:1,pageEnd:1,evidenceQuote:'目录文本',evidencePage:1}],concepts:[],claims:[],relations:[]};
  const input={model:'mock-model',promptVersion:'test',document:{libraryType:'native',libraryId:'local',itemKey:doc.id,attachmentKey:enrolled.attachment.id,pageCount:1},graph};
  const projected=store.projectDocumentAnalysisToBoard(actor,board.id,input);
  const overview=projected.nodes.find(n=>n.title.startsWith('全文概览 ·'));
  assert.equal(store.getSourceRef(actor,overview.sourceRefId).position.readingGuide.question,'真实问题','structured guide survives the snapshot/source projection');
  const section=projected.nodes.find(n=>n.title.startsWith('章节 ·'));
  store.updateNode(actor,section.id,section.version,{body:'我的人工补充'});
  store.projectDocumentAnalysisToBoard(actor,board.id,{...input,graph:{...graph,sections:[{...graph.sections[0],body:'新的 AI 解释'}]}});
  assert.equal(store.getNode(actor,section.id).body,'我的人工补充','regeneration must preserve user edits');

  // The actual extraction flow must process page 41 and refuse partial overflows.
  const extractBody=html.match(/async function extractAttachmentPdfPages\(attachmentId, \{ maxPages = 500, maxChars = 600_000 \} = \{\}\) \{([\s\S]*?)\n    \}/)[1];
  const fullText=new Function('allItems','loadHostPdfjs','assertFullTextBudget',`return (async()=>{const attachmentId='pdf';const maxPages=500;const maxChars=600000;${extractBody}})()`);
  const pagesRead=[];
  const pages=await fullText([],async()=>({getDocument:()=>({promise:Promise.resolve({numPages:41,getPage:async n=>{pagesRead.push(n);return {getTextContent:async()=>({items:[{str:`第${n}页`} ]})}},destroy(){}})})}),()=>{});
  assert.equal(pages.length,41);assert.equal(pagesRead.at(-1),41);

  const selectionBody=html.match(/async function addReaderSelectionToCanvas\(annotations\) \{([\s\S]*?)\n    \}/)[1];
  const savedAnnotations=new Map(), clientMap=new Map(); let importedIds=[];
  const addSelection=new Function('canvasReady','currentReaderInstance','currentAttachment','clientAnnotationIdMap','currentAnnotationsMap','importCurrentAnnotations','showToast','errorMessage',`return (async()=>{const annotations=[{text:'选区',position:{pageIndex:0,rects:[[1,1,2,2]]}}];${selectionBody}})()`);
  await addSelection(true,{_annotationManager:{addAnnotation(){savedAnnotations.set('server-id',{});clientMap.set('client-id','server-id');return {id:'client-id'};}}},{key:'att'},clientMap,savedAnnotations,async ids=>{importedIds=ids;},msg=>{throw new Error(msg);},err=>err.message);
  assert.deepEqual(importedIds,['server-id'],'unsaved selection is persisted before its source card is created');
  assert.ok(html.includes('currentReaderInstance.enableAddToNote?.(true)'), 'reader selection action must be enabled explicitly');
} finally {
  destroySession(session.id); store.close(); fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
console.log('✅ Formats, safe EPUB, annotations, source-file lifecycle, existing-first multi-topic and >40-page extraction passed');
