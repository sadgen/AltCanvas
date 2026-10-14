import { scanLibraryRoot } from '../server/library-scanner.mjs';
import { openAgentStore, resolveAgentActor, resolveAgentRoot, boundedLimit, isMain } from './agent-library-runtime.mjs';
export async function enrollResearchLibrary({ targetRootName = '投研报告', username,
  limit = 1000, dryRun = false, store: provided, scan = scanLibraryRoot, logFn = console.log } = {}) {
  limit = boundedLimit(limit);
  const store = provided || openAgentStore();
  try {
    const actorKey = resolveAgentActor(store, username);
    const root = resolveAgentRoot(store, actorKey, targetRootName);
    const scanResult = dryRun ? null : await scan(store, actorKey, root.id);
    if (scanResult?.alreadyRunning) throw new Error('Library scan is already running; retry later');
    const pending = store.db.prepare(`SELECT sf.id,sf.filename,sf.relative_path FROM source_files sf
      WHERE owner_key=? AND root_id=? AND status='active' AND document_id IS NULL AND deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM attachments a JOIN documents d ON d.id=a.document_id WHERE a.source_file_id=sf.id AND d.deleted_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM source_files h JOIN documents d ON d.id=h.document_id WHERE h.owner_key=sf.owner_key AND h.sha256=sf.sha256 AND h.deleted_at IS NULL AND d.deleted_at IS NULL)
      ORDER BY sf.created_at,sf.id LIMIT ?`).all(actorKey, root.id, limit);
    if (dryRun) return { scanReport: null, enrolled: [], pendingCount: pending.length, failed: 0, dryRun: true };
    const enrolled = [];
    let failed = 0;
    // Each store call owns its transaction; no outer transaction catches partial writes.
    for (const sf of pending) {
      try {
        const result = store.enrollExistingSourceFile(actorKey, sf.id);
        if (result?.document && !result.duplicate) enrolled.push({ documentId: result.document.id, sourceFileId: sf.id,
          filename: sf.filename, relativePath: sf.relative_path });
      } catch { failed++; logFn('[AltCanvas Enroll] One file failed; remaining files continue'); }
    }
    logFn(`[AltCanvas Enroll] enrolled=${enrolled.length}, failed=${failed}`);
    return { scanReport: scanResult?.report || null, enrolled, failed };
  } finally { if (!provided) store.close(); }
}
if (isMain(import.meta.url)) {
  try {
    const result = await enrollResearchLibrary({ dryRun: process.argv.includes('--dry-run') });
    console.log(JSON.stringify({ enrolled: result.enrolled.length, pending: result.pendingCount, failed: result.failed, dryRun: result.dryRun }));
    if (result.failed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
