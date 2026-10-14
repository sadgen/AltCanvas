import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.className='';this.scrollTop=0;this.value='';this.listeners={};this.classList={add:v=>{this.className+=' '+v;}};}
  appendChild(child){this.children.push(child);return child;}
  replaceChildren(){this.children=[];this.text='';}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  set textContent(value){this.text=String(value);this.children=[];}
  get textContent(){return (this.text||'')+this.children.map(c=>c.textContent).join('');}
  dataset={};
}
const context={document:{createElement:tag=>new Element(tag)}};
vm.runInNewContext(fs.readFileSync(new URL('../assets/reading-guide.js',import.meta.url),'utf8'),context);
const {buildModel,overviewParts,mount}=context.AltCanvasReadingGuide;
const nodes=[
 {id:'a-overview',title:'全文概览 · A 文章',body:'具体问题：真实问题\n一句话结论：真实结论\n限制：小样本',sourceRefId:'a',zIndex:1},
 {id:'a-step',title:'章节 · 方法',body:'这是推理第一步。随后解释。',sourceRefId:'a-step-source',zIndex:2},
 {id:'b-overview',title:'全文概览 · B 文章',body:'具体问题：另一问题\n核心结论：另一结论\n限制：成本未验证',sourceRefId:'b',zIndex:1}
];
const sources=new Map([
 ['a',{libraryType:'native',libraryId:'local',attachmentKey:'att-a',pageLabel:'1',quoteSnapshot:'原文',position:{readingGuide:{question:'结构化问题',takeaway:'结构化结论',limitations:'明确边界',method:'实验方法'},readingKind:'overview'}}],
 ['a-step-source',{libraryType:'native',libraryId:'local',attachmentKey:'att-a',pageLabel:'2',quoteSnapshot:null,position:{pageStart:2}}],
 ['b',{libraryType:'native',libraryId:'local',attachmentKey:'att-b',pageLabel:'3',position:{}}]
]);
const edges=[{sourceNodeId:'a-step',targetNodeId:'b-overview',relation:'extends',label:'已建立的补充关系'}];
const data={nodes,sources,edges,attachmentKey:'att-a',title:'当前文章',ready:true,annotations:[]};
const model=buildModel(data);
assert.equal(model.current.guide.question,'结构化问题');
assert.equal(model.current.nodes.length,2,'single-article view must exclude another attachment');
const argumentModel=buildModel({...data,nodes:[...nodes,{id:'a-later-step',title:'章节 · 后续论证',body:'下一步',sourceRefId:'a-later-source',zIndex:3}],sources:new Map([...sources,['a-later-source',{libraryType:'native',libraryId:'local',attachmentKey:'att-a',position:{pageStart:1}}]])});
assert.equal(argumentModel.current.groups.section[0].node.id,'a-step','argument order must not be reordered by PDF page number');


assert.equal(overviewParts('【研究问题】\n问题\n【核心发现】\n发现\n【限制】\n限制').takeaway,'发现','legacy heading format must remain readable');
assert.equal(buildModel({...data,attachmentKey:'not-analyzed'}).current,null,'never silently show another article');
function walk(root){return [root,...root.children.flatMap(walk)];}
function find(root, predicate){const value=walk(root).find(predicate);assert.ok(value,'expected rendered element');return value;}
const root=new Element('section');let jumped=null,saved=null,error=null;
const controller=mount(root,{jump:source=>{jumped=source;},saveNote:async value=>{saved=value;},error:value=>{error=value;},edit(){},jumpAnnotation(){}});
controller.render(data);
assert.ok(root.textContent.indexOf('结构化结论') < root.textContent.indexOf('这些结论是怎样论证出来的？'),'conclusion must precede the argument');
assert.doesNotMatch(root.textContent,/作者想解决什么问题？/,'background must not be a separate section ahead of the argument');
assert.match(root.textContent,/结构化结论/);assert.match(root.textContent,/明确边界/);assert.doesNotMatch(root.textContent,/另一问题/);
find(root,e=>e.tag==='button'&&e.textContent.includes('引用待核验')).onclick();assert.equal(jumped.attachmentKey,'att-a');
const withQuote={...data,sources:new Map([...sources].map(([key,value])=>[key,key==='a-step-source'?{...value,quoteSnapshot:'可点击的证据'}:value]))};
controller.render(withQuote);
find(root,e=>e.tag==='button'&&e.textContent==='可点击的证据').onclick();
assert.equal(jumped.quoteSnapshot,'可点击的证据');
controller.render(data);

assert.match(root.textContent,/这是推理第一步。随后解释。/,'full explanation is visible by default');
assert.equal(walk(root).some(e=>e.tag==='details'),false,'explanations must not require repeated expansion');
assert.equal(root.textContent.split('这是推理第一步。').length-1,1,'do not repeat a gist before the explanation');
assert.doesNotMatch(root.textContent,/多篇对比|已建立的补充关系/,'unrelated articles must not be forced into comparisons');
find(root,e=>e.tag==='button'&&e.textContent==='我的标注').onclick();
let input=find(root,e=>e.tag==='textarea');input.value='<img src=x onerror=alert(1)> 我的问题';input.oninput();
root.scrollTop=123;controller.render(data);input=find(root,e=>e.tag==='textarea');assert.match(input.value,/我的问题/);assert.equal(root.scrollTop,123);
await find(root,e=>e.tag==='button'&&e.textContent==='保存笔记').onclick();assert.match(saved,/我的问题/);assert.equal(error,null);
controller.render({...data,attachmentKey:'att-b',title:'B'});assert.equal(root.scrollTop,0);assert.match(root.textContent,/另一结论/);assert.doesNotMatch(root.textContent,/结构化结论/);
controller.render({...data,attachmentKey:'missing'});assert.match(root.textContent,/还没有这篇文章/);
assert.equal(walk(root).some(e=>e.tag==='img'),false,'user content never becomes executable markup');
console.log('✅ Guided reading: per-article isolation, legacy fallback, visible prose, evidence, no forced comparison, draft preservation and navigation passed');
