// Keep the precision provided by the publication itself; never fill missing
// months/days from the current date or a file's filesystem timestamps.
export function normalizePublicationDate(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4})(?:[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?月?)?年?$/.exec(value.trim());
  if (!match) return '';
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1000 || year > 2999) return '';
  if (!match[2]) return match[1];
  if (month < 1 || month > 12) return '';
  const prefix = `${match[1]}-${String(month).padStart(2, '0')}`;
  if (!match[3]) return prefix;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return '';
  return `${prefix}-${String(day).padStart(2, '0')}`;
}

export function titleWithPublicationDate(title, publicationDate) {
  const date = normalizePublicationDate(publicationDate);
  if (!date) return title;
  const base = String(title || '').trim()
    .replace(/\s*[（(]\d{4}(?:[-/.]\d{1,2}){0,2}[）)]\s*$/, '').trim();
  if (base.includes(date)) return base.slice(0, 500);
  return `${base.slice(0, 498 - date.length)}（${date}）`;
}

export const PUBLICATION_DATE_INSTRUCTION = '发布日期 publicationDate 必须依据原文发布/出版日期（文件名仅作辅助），格式 YYYY-MM-DD；只确认年月则 YYYY-MM，只确认年份则 YYYY，无法确认留空。不能把样本区间、预测期、引用文献日期、下载时间或文件修改时间当作发布日期。cleanTitle 的日期后缀使用该日期，不补造月日。';
