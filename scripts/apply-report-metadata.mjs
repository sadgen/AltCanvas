import fs from 'node:fs';
import { openAgentStore, resolveAgentActor, metadataKey, isMain } from './agent-library-runtime.mjs';
export function applyReportMetadata(list, { store: provided, username, logFn = console.log } = {}) {
  if (!Array.isArray(list)) throw new TypeError('metadata must be an array');
  if (!list.length) return { updated: 0, skipped: 0 };
  const store = provided || openAgentStore();
  try {
    const actor = resolveAgentActor(store, username);
    const workspaces = store.listWorkspaces(actor);
    const seen = new Set();
    const prepared = list.map(item => {
      let doc;
      if (item.documentId) doc = store.getDocument(actor, item.documentId);
      else {
        const identifier = String(item.reportId || item.filename || '').trim();
        if (!identifier) throw new TypeError('documentId or a unique report identifier is required');
        const matches = store.db.prepare(`SELECT DISTINCT d.id FROM documents d
          JOIN source_files sf ON sf.document_id=d.id AND sf.deleted_at IS NULL AND sf.status='active'
          WHERE d.owner_key=? AND d.deleted_at IS NULL
            AND (sf.filename=? OR sf.relative_path=? OR instr(sf.filename,?)>0) LIMIT 2`).all(actor, identifier, identifier, identifier);
        if (matches.length !== 1) throw new Error('Report identifier is missing or ambiguous; use documentId');
        doc = store.getDocument(actor, matches[0].id);
      }
      if (!doc) throw new Error('Document does not belong to this account or is deleted');
      if (seen.has(doc.id)) throw new Error('Repeated documentId in metadata batch');
      seen.add(doc.id);
      const existing = store.getDocumentMeta(actor, metadataKey(doc.id));
      const attachment = store.db.prepare('SELECT id,version FROM attachments WHERE document_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1').get(doc.id);
      const topics = Array.isArray(item.topics) ? item.topics : item.topic ? [item.topic] : [];
      const ids = [...new Set(topics.flatMap(topic => {
        const matches = workspaces.filter(w => w.id === topic || w.name === topic);
        if (matches.length !== 1) throw new Error('Topic is unknown or ambiguous; use an existing workspace ID');
        return matches[0].id;
      }))];
      const meta = { ...metadataKey(doc.id), ...existing, attachmentKey: attachment?.id || null,
        attachmentVersion: attachment?.version ?? null, source: 'ai_classification' };
      for (const field of ['cleanTitle','institution','reportTitle','subtitle','year','publicationDate','summary']) {
        if (item[field] !== undefined) {
          if (typeof item[field] !== 'string') throw new TypeError(`${field} must be a string`);
          meta[field] = item[field].trim().slice(0, field === 'summary' ? 4000 : 500);
        }
      }
      meta.cleanTitle ||= doc.title;
      return { doc, meta, ids, previousMeta: JSON.stringify(existing), manual: existing?.source === 'manual' };
    });
    let updated = 0, skipped = 0;
    store.transaction(() => {
      for (const entry of prepared) {
        if (entry.manual || store.getDocument(actor, entry.doc.id)?.version !== entry.doc.version || JSON.stringify(store.getDocumentMeta(actor, metadataKey(entry.doc.id))) !== entry.previousMeta) { skipped++; continue; }
        store.saveDocumentMeta(actor, entry.meta);
        if (entry.ids.length) store.addDocumentTopics(actor, entry.doc.id, entry.ids, { origin: 'ai_suggestion' });
        updated++;
      }
    });
    logFn(`[AltCanvas ApplyMetadata] updated=${updated}, preservedManual=${skipped}`);
    return { updated, skipped };
  } finally { if (!provided) store.close(); }
}
if (isMain(import.meta.url)) {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2] || 0, 'utf8'));
    console.log(JSON.stringify(applyReportMetadata(Array.isArray(input) ? input : input.reports || [input])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
