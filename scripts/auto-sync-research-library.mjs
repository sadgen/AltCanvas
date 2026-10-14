import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanLibraryRoot } from '../server/library-scanner.mjs';
import { requestAiCompletion, getAiPublicConfig } from '../server/ai-provider.mjs';
import { openFileInsideRoot } from '../server/native-fs.mjs';
import { extractTextDocument } from '../server/document-formats.mjs';
import { enrollResearchLibrary } from './auto-enroll-library.mjs';
import { openAgentStore, resolveAgentActor, resolveAgentRoot, boundedLimit, metadataKey, isMain } from './agent-library-runtime.mjs';

export function extractAgentSnippet(root, relativePath, filename) {
  const opened = openFileInsideRoot(root, relativePath);
  try {
    if (/\.pdf$/i.test(filename)) {
      const target = process.platform === 'linux' ? '/proc/self/fd/3' : opened.realpath;
      const options = { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 };
      if (process.platform === 'linux') options.stdio = ['ignore','pipe','pipe',opened.fd];
      return execFileSync('pdftotext', ['-f','1','-l','3',target,'-'], options).slice(0,6000);
    }
    if (fs.fstatSync(opened.fd).size > 16 * 1024 * 1024) throw new Error('Text document exceeds snippet budget');
    return extractTextDocument(fs.readFileSync(opened.fd), filename).pages.slice(0,2).map(p=>p.text).join('\n').slice(0,6000);
  } finally { fs.closeSync(opened.fd); }
}
function parseAiJson(raw) {
  try { return JSON.parse(String(raw || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); }
  catch { return null; }
}
async function runClassificationBatch({ store, actorKey, entries, workspaces, aiConfig, aiCompletion }) {
  const systemPrompt = [
    '你是专业学术研究助手。你的任务是根据用户的多个研究主题及其纳入/排除规则，评估给定的文献是否适合归入各主题。',
    '只输出一个合法的 JSON 对象，不要 Markdown 代码块。',
    'JSON 格式示例：',
    '{"classifications": {',
    '  "entry-id-1": [',
    '    {"workspaceId": "ws-1", "workspaceName": "主题名称", "confidence": 0.92, "reason": "匹配纳入规则：聚焦于大模型逻辑推理机制"}',
    '  ]',
    '}, "documentMetadata": {',
    '  "entry-id-1": {"cleanTitle": "【机构】规范中文标题（2025）", "institution": "机构", "reportTitle": "中文主标题", "subtitle": "", "year": "2025", "summary": "一句话中文摘要"}',
    '}}',
    '【规则】',
    '1. 优先匹配已有主题，符合核心内容才给 confidence >=0.7；命中排除规则不推荐；无法合理覆盖可返回空数组，禁止硬塞；',
    '2. reason 简述推荐或不推荐的核心理由（30字以内）；',
    '3. 同一篇文献必须推荐给所有实质相关的已有主题（多对多归类），不限定仅一个；不要因弱关键词关联推荐；',
    '4. 必须在同一次返回中为每篇文献生成 documentMetadata；cleanTitle 必须是准确、自然、可直接展示的简体中文名，保留真实可辨识的机构与年份；',
    '5. 若文献附带「正文节选」，标题/机构/年份的识别必须优先依据正文内容，元数据仅作辅助；',
    '6. 机构或年份无法确定时：cleanTitle 直接省略对应装饰，institution 与 year 字段留空字符串。严禁编造「未注明机构」「未知年份」之类的占位词。'
  ].join('\n');

  const topicContexts = workspaces.map((w, idx) =>
    `[主题 ${idx + 1}] ID: ${w.id}\n名称: ${w.name}\n研究问题: ${w.researchQuestion || '无'}\n纳入规则: ${w.inclusionRules || '无'}\n排除规则: ${w.exclusionRules || '无'}`
  ).join('\n\n');

  const docContexts = entries.map(e =>
    `[待分拣文献] ID: ${e.id}\n文件名: ${e.filename}\n现有标题: ${e.title}${e.textSnippet ? `\n正文节选（PDF 前几页）:\n${e.textSnippet}` : ''}`
  ).join('\n\n');

  const responseText = await aiCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `【候选研究主题】\n\n${topicContexts}\n\n【待分类文献列表】\n\n${docContexts}` }
    ],
    temperature: 0.2, timeoutMs: 180000, stage: 'classify',
    maxTokens: 8000
  }, aiConfig);

  const parsed = parseAiJson(responseText);
  if (!parsed?.documentMetadata || !parsed?.classifications) throw new Error('AI response is incomplete');
  const metaMap = parsed.documentMetadata || {};
  const classMap = parsed.classifications || {};

  const results = [];
  for (const entry of entries) {
    const meta = metaMap[entry.id];
    if (!meta || typeof meta.cleanTitle !== 'string' || !meta.cleanTitle.trim() || !Array.isArray(classMap[entry.id])) throw new Error('AI omitted a document result');
    for (const field of ['institution','reportTitle','year','summary']) if (meta[field] !== undefined && typeof meta[field] !== 'string') throw new Error('Invalid metadata field');
    const classifications = (classMap[entry.id] || []).filter(c => c && c.workspaceId);

    // 规范化元数据
    const cleanTitle = (meta.cleanTitle || entry.title || entry.filename).trim();
    const institution = (meta.institution || '').trim();
    const reportTitle = (meta.reportTitle || cleanTitle).trim();
    const year = (meta.year || '').trim();
    const summary = (meta.summary || '').trim();

    results.push({
      documentId: entry.id,
      cleanTitle,
      institution,
      reportTitle,
      year,
      summary,
      classifications
    });
  }

  return results;
}

export async function syncResearchLibrary({ targetRootName = '投研报告', username,
  maxEnrollLimit = 20, maxClassifyLimit = 20, dryRun = false, logFn = console.log,
  store: provided, scan = scanLibraryRoot, aiCompletion = requestAiCompletion, extractSnippet = extractAgentSnippet } = {}) {
  maxEnrollLimit = boundedLimit(maxEnrollLimit); maxClassifyLimit = boundedLimit(maxClassifyLimit);
  const store = provided || openAgentStore();
  try {
    const actorKey = resolveAgentActor(store, username);
    const root = resolveAgentRoot(store, actorKey, targetRootName);
    const enrolled = await enrollResearchLibrary({ targetRootName, username, limit: maxEnrollLimit, dryRun, store, scan, logFn });
    const pendingDocs = store.db.prepare(`SELECT d.id,d.title,d.version,sf.filename,sf.relative_path,
      a.id AS attachment_id,a.version AS attachment_version FROM documents d
      JOIN source_files sf ON sf.document_id=d.id AND sf.deleted_at IS NULL AND sf.status='active'
      JOIN attachments a ON a.id=sf.attachment_id AND a.document_id=d.id AND a.deleted_at IS NULL
      LEFT JOIN document_metas dm ON dm.owner_key=d.owner_key AND dm.library_type='native' AND dm.library_id='local' AND dm.item_key=d.id
      WHERE d.owner_key=? AND sf.root_id=? AND d.deleted_at IS NULL
        AND (dm.id IS NULL OR dm.clean_title IS NULL OR dm.clean_title='')
      ORDER BY d.created_at,d.id LIMIT ?`).all(actorKey,root.id,maxClassifyLimit);
    if (dryRun) return { scanReport:null,enrolledCount:0,classifiedCount:0,pendingEnroll:enrolled.pendingCount,pendingClassify:pendingDocs.length,failed:0,dryRun:true };
    if (!pendingDocs.length) return {scanReport:enrolled.scanReport,enrolledCount:enrolled.enrolled.length,classifiedCount:0,failed:enrolled.failed};
    const aiConfig = store.getAiSettings(actorKey);
    if (!getAiPublicConfig(aiConfig).configured && aiCompletion === requestAiCompletion) throw new Error('AI is not configured');
    const workspaces = store.listWorkspaces(actorKey), allowedTopics = new Set(workspaces.map(w=>w.id));
    const entries=[]; let failed=enrolled.failed;
    for (const doc of pendingDocs) {
      try { entries.push({ ...doc, id:doc.id, attachmentId:doc.attachment_id, attachmentVersion:doc.attachment_version,
        textSnippet:extractSnippet(root.absolutePath,doc.relative_path,doc.filename) }); }
      catch { failed++; logFn('[AltCanvas Auto-Sync] One document could not be read safely; left pending'); }
    }
    let classifiedCount=0;
    for (let i=0;i<entries.length;i+=4) {
      const batch=entries.slice(i,i+4);
      try {
        const results=await runClassificationBatch({store,actorKey,entries:batch,workspaces,aiConfig,aiCompletion});
        for (const result of results) {
          const entry=batch.find(e=>e.id===result.documentId);
          store.transaction(()=>{
            const current=store.getDocument(actorKey,entry.id);
            const attachment=store.getAttachment(actorKey,entry.attachmentId);
            // Respect manual/concurrent edits made while the model was running.
            const currentMeta=store.getDocumentMeta(actorKey,metadataKey(entry.id));
            if (!current || current.version!==entry.version || attachment?.version!==entry.attachmentVersion || currentMeta?.source==='manual' || currentMeta?.cleanTitle) return;
            const topics=[...new Set(result.classifications.filter(c=>allowedTopics.has(c.workspaceId) && Number.isFinite(c.confidence) && c.confidence>=0.7 && c.confidence<=1).map(c=>c.workspaceId))];
            store.saveDocumentMeta(actorKey,{...metadataKey(entry.id),attachmentKey:entry.attachmentId,attachmentVersion:entry.attachmentVersion,
              cleanTitle:result.cleanTitle.slice(0,500),institution:result.institution.slice(0,500),reportTitle:result.reportTitle.slice(0,500),
              year:result.year.slice(0,40),summary:result.summary.slice(0,4000),source:'ai_classification'});
            // No match means unclassified; never force a default topic.
            if (topics.length) store.addDocumentTopics(actorKey,entry.id,topics,{origin:'ai_suggestion'});
            classifiedCount++;
          });
        }
      } catch { failed+=batch.length; logFn('[AltCanvas Auto-Sync] Batch failed; documents remain pending for retry'); }
    }
    logFn(`[AltCanvas Auto-Sync] enrolled=${enrolled.enrolled.length}, classified=${classifiedCount}, failed=${failed}`);
    return {scanReport:enrolled.scanReport,enrolledCount:enrolled.enrolled.length,classifiedCount,failed};
  } finally { if (!provided) store.close(); }
}
if (isMain(import.meta.url)) {
  try {
    const arg=process.argv.find(a=>a.startsWith('--limit='));const limit=arg?Number(arg.slice(8)):20;
    const result=await syncResearchLibrary({maxEnrollLimit:limit,maxClassifyLimit:limit,dryRun:process.argv.includes('--dry-run')});
    console.log(JSON.stringify(result));if(result.failed)process.exitCode=1;
  } catch(error){console.error(error.message);process.exitCode=1;}
}
