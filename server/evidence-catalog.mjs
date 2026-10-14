// Quotes come from document text; AI selects IDs instead of reconstructing sentences.
export function buildEvidenceCatalog(pages, maxChars = 32000) {
  const perPage = Math.max(40, Math.floor(maxChars / Math.max(1, pages.length)));
  const catalog = [];
  let used = 0;
  for (const page of pages) {
    const candidates = [];
    for (const paragraph of String(page.text || '').split(/\n\s*\n/)) {
      const sentences = paragraph.match(/[^。！？.!?]+[。！？.!?]+|[^。！？.!?]+$/g) || [];
      for (const sentence of sentences) {
        const quote = sentence.trim();
        if (quote.length < 8) continue;
        // Keep a contiguous original excerpt even for long paragraphs/formulas.
        for (let offset = 0; offset < quote.length; offset += 300) {
          const part = quote.slice(offset, offset + Math.min(300, perPage)).trim();
          if (part.length >= 8) candidates.push(part);
        }
      }
    }
    const count = Math.min(candidates.length, Math.max(1, Math.floor(perPage / 300)));
    for (let i = 0; i < count; i++) {
      const index = count === 1 ? 0 : Math.round(i * (candidates.length - 1) / (count - 1));
      const quote = candidates[index];
      if (used + quote.length > maxChars) break;
      catalog.push({ id: `p${page.pageNumber}-e${i + 1}`, pageNumber: page.pageNumber, quote });
      used += quote.length;
    }
  }
  return catalog;
}

export function formatEvidenceCatalog(catalog) {
  return catalog.map(entry => `[${entry.id}] PDF第${entry.pageNumber}页：${entry.quote}`).join('\n');
}
