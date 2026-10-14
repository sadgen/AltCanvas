(function (global) {
  const clean = value => String(value || '').trim();
  const gist = text => clean(text).split(/(?<=[。！？.!?])\s*|\n/)[0];
  const kind = (node, source) => source?.position?.readingKind ||
    (/^全文概览/.test(node.title) ? 'overview' : /^章节 ·/.test(node.title) ? 'section' : /^概念 ·/.test(node.title) ? 'concept' : /^论点 ·/.test(node.title) ? 'claim' :
      node.type === 'ai_output' && source?.position?.pageStart ? ({ '#7c3aed':'overview', '#2563eb':'section', '#0891b2':'concept', '#d97706':'claim' }[node.color] || 'note') : 'note');
  function overviewParts(text) {
    const parts = {};
    const pattern = /(?:^|\n)\s*(?:#{1,4}\s*)?(?:\*\*|【|\[)?(具体问题|研究问题|一句话结论|核心结论|核心发现|推理主线|方法|证据与方法|适用边界与未解问题|适用边界|限制|未解问题)(?:\*\*|】|\])?\s*[:：]?\s*/g;
    const matches = [...String(text || '').matchAll(pattern)];
    matches.forEach((m,i) => { parts[m[1]] = clean(text.slice(m.index+m[0].length, matches[i+1]?.index ?? text.length)); });
    return {
      question: parts['具体问题'] || parts['研究问题'] || '',
      takeaway: parts['一句话结论'] || parts['核心结论'] || parts['核心发现'] || '',
      limitations: parts['适用边界与未解问题'] || parts['适用边界'] || parts['限制'] || parts['未解问题'] || '',
      method: parts['证据与方法'] || parts['方法'] || ''
    };
  }
  function buildModel({ nodes, sources, edges, attachmentKey }) {
    const documents = new Map();
    for (const node of nodes) {
      const source = sources.get(node.sourceRefId);
      if (!source?.attachmentKey) continue;
      const key = `${source.libraryType}:${source.libraryId}:${source.attachmentKey}`;
      if (!documents.has(key)) documents.set(key, { key, attachmentKey: source.attachmentKey, nodes: [], groups: { overview: [], section: [], concept: [], claim: [], note: [] } });
      const doc = documents.get(key); const entry = { node, source, kind: kind(node, source) };
      doc.nodes.push(entry); doc.groups[entry.kind]?.push(entry);
    }
    for (const doc of documents.values()) {
      for (const entries of Object.values(doc.groups)) entries.sort((a,b) => (a.source.position?.pageStart || 1)-(b.source.position?.pageStart || 1) || a.node.zIndex-b.node.zIndex);
      const overview = doc.groups.overview[0];
      const parsed = overviewParts(overview?.node.body || '');
      doc.guide = { ...parsed, ...Object.fromEntries(Object.entries(overview?.source.position?.readingGuide || {}).filter(([,value]) => clean(value))) };
      doc.title = clean(overview?.node.title.replace(/^全文概览\s*·\s*/, '')) || '未生成概览的文章';
      doc.overview = overview;
    }
    const current = [...documents.values()].find(doc => doc.attachmentKey === attachmentKey) || null;
    return { current };
  }

  function mount(root, callbacks) {
    let context = null, tab = 'guide', lastKey = null, draft = '';
    const el = (tag, className, text) => { const e = document.createElement(tag); if(className)e.className=className;if(text!==undefined)e.textContent=text;return e; };
    const button = (text, action, className='reading-guide-link') => { const b=el('button',className,text);b.type='button';b.onclick=action;return b; };
    function sourceLink(entry) {
      const label = entry.source.position?.locationKind === 'text-block' ? '文本块 ' : 'p.';
      return button(`${entry.source.quoteSnapshot ? '查看依据' : '查看页码 · 引用待核验（无法高亮）'} · ${label}${entry.source.pageLabel || 1} ↗`,()=>callbacks.jump(entry.source));
    }
    function entryDetail(entry, index, mode='step') {
      const wrapper=el('section',mode==='step'?'reading-guide-step':'reading-guide-entry');
      if(mode==='step')wrapper.appendChild(el('span','reading-guide-number',String(index+1)));
      const body=el('div');
      body.appendChild(el('h4','',entry.node.title.replace(/^(章节|概念|论点)\s*·\s*/,'')));

      const detail=el('div','reading-guide-explanation');
      detail.appendChild(el('p','reading-guide-body',entry.node.body));
      if(entry.source.quoteSnapshot){
        const quote=el('blockquote');
        const link=button(entry.source.quoteSnapshot,()=>callbacks.jump(entry.source),'reading-guide-quote');
        link.title='定位并临时高亮原文';
        quote.appendChild(link);detail.appendChild(quote);
      }
      detail.appendChild(sourceLink(entry));
      detail.appendChild(button('编辑笔记',()=>callbacks.edit(entry.node)));
      body.appendChild(detail);wrapper.appendChild(body);return wrapper;
    }
    function section(title,text) { const s=el('section','reading-guide-section');s.appendChild(el('h3','',title));if(text)s.appendChild(el('p','reading-guide-body',text));return s; }
    function renderGuide(container, doc) {
      if(!doc?.overview){container.appendChild(section('还没有这篇文章的导读', '点击“阅读全文”，生成研究问题、推理主线、关键结论和适用边界。'));return;}
      const takeaway=doc.guide.takeaway || gist(doc.groups.claim[0]?.node.body || '');
      if(takeaway){const s=section('一句话结论',takeaway);s.classList.add('reading-guide-takeaway');s.appendChild(sourceLink(doc.overview));container.appendChild(s);}
      if(doc.guide.question)container.appendChild(section('作者想解决什么问题？',doc.guide.question));
      if(!doc.guide.question || !takeaway){const fallback=section('全文概览',doc.overview.node.body);fallback.appendChild(sourceLink(doc.overview));container.appendChild(fallback);}
      const steps=section('作者如何得出结论？');
      doc.groups.section.forEach((entry,i)=>steps.appendChild(entryDetail(entry,i)));
      if(!doc.groups.section.length)steps.appendChild(el('p','reading-guide-muted','原分析未单列推理步骤，可重新分析。'));
      container.appendChild(steps);
      if(doc.groups.concept.length){const s=section('理解文章需要的概念');doc.groups.concept.forEach((entry,i)=>s.appendChild(entryDetail(entry,i,'concept')));container.appendChild(s);}
      if(doc.groups.claim.length){const s=section('关键结论与证据');doc.groups.claim.forEach((entry,i)=>s.appendChild(entryDetail(entry,i,'claim')));container.appendChild(s);}
      container.appendChild(section('成立条件与未解问题',doc.guide.limitations || '原分析未单列适用边界；请查看结论中的条件说明，或重新分析。'));
    }
    function renderNotes(container,doc){
      const annotations=context.annotations || [];
      if(!annotations.length && !doc?.groups.note.length)container.appendChild(section('开始记录你的理解','在中间阅读器划线，或在这里写下疑问。'));
      annotations.forEach(item=>{const s=section(`标注 · ${context.locationKind==='text-block'?'文本块 ':'p.'}${item.data.annotationPageLabel || 1}`,item.data.annotationComment || '');s.appendChild(el('blockquote','',item.data.annotationText || ''));s.appendChild(button('回到原文 ↗',()=>callbacks.jumpAnnotation(item.id)));container.appendChild(s);});
      doc?.groups.note.filter(entry=>entry.node.type==='manual_note').forEach((entry,i)=>container.appendChild(entryDetail(entry,i,'note')));
      const form=section('写下我的疑问或笔记');
      const input=el('textarea');input.setAttribute('aria-label','阅读笔记');input.placeholder='例如：这个结论在什么情况下不成立？';input.value=draft;input.oninput=()=>{draft=input.value;};form.appendChild(input);
      const save=button('保存笔记',async()=>{if(!draft.trim())return;const savedKey=lastKey,savedText=draft;save.disabled=true;try{await callbacks.saveNote(savedText);if(lastKey===savedKey && draft===savedText){draft='';input.value='';}}catch(error){callbacks.error(error);}finally{save.disabled=false;render(context);}},'reading-guide-button');
      save.disabled=!context.attachmentKey || !context.ready;form.appendChild(save);container.appendChild(form);
    }
    function render(next){
      if(!next)return;const scroll=root.scrollTop;
      context=next;const key=next.attachmentKey;
      const changed = lastKey !== key;
      if(changed){draft='';tab='guide';lastKey=key;root.scrollTop=0;}
      const model=buildModel(next);root.replaceChildren();
      root.appendChild(el('p','reading-guide-document',next.title || '请从文库打开一篇文章'));
      const tabs=el('div','reading-guide-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','文章理解');
      const content=el('div','reading-guide-content');content.id='reading-guide-content';content.setAttribute('role','tabpanel');
      [['guide','导读'],['notes','我的标注']].forEach(([value,label])=>{const b=button(label,()=>{tab=value;render(context);},'reading-guide-tab');b.id=`reading-guide-tab-${value}`;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===value));b.setAttribute('aria-controls',content.id);tabs.appendChild(b);});root.appendChild(tabs);content.setAttribute('aria-labelledby',`reading-guide-tab-${tab}`);root.appendChild(content);
      if(!next.attachmentKey){content.appendChild(section('打开文章，开始阅读','导读跟随当前文章，保留你的标注与原文位置。'));}
      else if(tab==='guide')renderGuide(content,model.current);else renderNotes(content,model.current);
      if(!changed)root.scrollTop=scroll;
    }
    return { render };
  }
  global.AltCanvasReadingGuide={buildModel,overviewParts,mount};
})(globalThis);
