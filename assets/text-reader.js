// EPUB is displayed as extracted plain text: no book scripts, remote resources or HTML.
window.createTextReader = function ({ container, pages, annotations, onSaveAnnotations, onDeleteAnnotations, onAddToNote }) {
  let currentAnnotations = [...annotations];
  container.replaceChildren();
  const toolbar = document.createElement('div');
  toolbar.className = 'text-reader-toolbar';
  const hint = document.createElement('span');
  hint.textContent = '选中文字后划线 · 位置按文本块编号';
  const mark = document.createElement('button'); mark.textContent = '划线标注';
  toolbar.append(mark, hint);
  const content = document.createElement('div'); content.className = 'text-reader-content';
  container.append(toolbar, content);
  function render() {
    content.replaceChildren();
    pages.forEach((page, index) => {
      const section = document.createElement('section'); section.dataset.pageIndex = index;
      const heading = document.createElement('h3'); heading.textContent = `${page.title || '正文'} · 文本块 ${index + 1}`;
      const text = document.createElement('div'); text.className = 'text-reader-block'; text.dataset.pageIndex = index;
      const ranges = currentAnnotations.filter(a => a.position?.pageIndex === index)
        .map(a => ({ start: a.position.textStart, end: a.position.textEnd }))
        .filter(r => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= page.text.length)
        .sort((a, b) => a.start - b.start);
      let cursor = 0;
      for (const range of ranges) {
        if (range.start < cursor) continue;
        text.append(document.createTextNode(page.text.slice(cursor, range.start)));
        const highlighted = document.createElement('mark'); highlighted.textContent = page.text.slice(range.start, range.end);
        text.appendChild(highlighted); cursor = range.end;
      }
      text.append(document.createTextNode(page.text.slice(cursor)));
      section.append(heading, text);
      const entries = currentAnnotations.filter(a => a.position?.pageIndex === index);
      for (const a of entries) {
        const row = document.createElement('div'); row.className = 'text-reader-annotation'; row.dataset.annotationId = a.id;
        const quote = document.createElement('button'); quote.textContent = `“${a.text}”`; quote.onclick = () => highlightQuote(index, a.text);
        const comment = document.createElement('textarea'); comment.value = a.comment || ''; comment.placeholder = '笔记';
        comment.onchange = () => { a.comment = comment.value; void onSaveAnnotations([a]); };
        const add = document.createElement('button'); add.textContent = '加入理解图'; add.onclick = () => onAddToNote([a]);
        const del = document.createElement('button'); del.textContent = '删除'; del.onclick = () => onDeleteAnnotations([a.id]);
        row.append(quote, comment, add, del); section.appendChild(row);
      }
      content.appendChild(section);
    });
  }
  function highlightQuote(index, quote) {
    const block = content.querySelector(`.text-reader-block[data-page-index="${index}"]`);
    if (!block) return false;
    const text = pages[index]?.text || '';
    const offset = text.indexOf(quote);
    block.replaceChildren();
    if (offset >= 0 && quote) {
      const highlighted = document.createElement('mark'); highlighted.textContent = quote;
      block.append(document.createTextNode(text.slice(0, offset)), highlighted, document.createTextNode(text.slice(offset + quote.length)));
      highlighted.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else { block.textContent = text; block.scrollIntoView({ block: 'start' }); }
    return offset >= 0;
  }
  mark.onmousedown = e => e.preventDefault();
  mark.onclick = async () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const parent = range.startContainer.parentElement?.closest('.text-reader-block');
    if (!parent || !parent.contains(range.endContainer)) return;
    const prefix = range.cloneRange(); prefix.selectNodeContents(parent); prefix.setEnd(range.startContainer, range.startOffset);
    const pageIndex = Number(parent.dataset.pageIndex);
    const text = selection.toString();
    if (!text.trim()) return;
    const ann = { id: crypto.randomUUID(), type: 'highlight', text, comment: '', color: '#ffd400', pageIndex,
      pageLabel: String(pageIndex + 1), position: { pageIndex, textStart: prefix.toString().length, textEnd: prefix.toString().length + text.length, locationKind: 'text-block' } };
    await onSaveAnnotations([ann]);
  };
  render();
  return {
    textPages: pages,
    _annotationManager: { addAnnotation(value) {
      const annotation = { ...value, id: crypto.randomUUID(), pageIndex: value.position?.pageIndex || 0 };
      void onSaveAnnotations([annotation]); return annotation;
    } },
    highlightQuote,
    _primaryView: { _annotationManager: { setAnnotations(items) { currentAnnotations = items; render(); } }, navigate({ pageIndex, position } = {}) {
      const index = position?.pageIndex ?? pageIndex ?? 0;
      content.querySelector(`section[data-page-index="${index}"]`)?.scrollIntoView({ block: 'start' });
    } },
    setAnnotations(items) { currentAnnotations = items.filter(a => a.id !== 'ALT-AI-EVIDENCE-HIGHLIGHT'); render(); },
    unsetAnnotations(ids) { currentAnnotations = currentAnnotations.filter(a => !ids.includes(a.id)); render(); },
    setSelectedAnnotations(ids) {
      const annotation = currentAnnotations.find(a => ids.includes(a.id));
      if (annotation) highlightQuote(annotation.position?.pageIndex || 0, annotation.text);
    }
  };
};
