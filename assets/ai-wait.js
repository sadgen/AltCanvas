(function(global){
  let active=null;
  async function fetchWithDeadline(url,options={}) {
    if(active){const error=new Error('已有 AI 请求正在处理，请等待完成或取消后再试');error.code='ai_busy';throw error;}
    const isDocument=String(url).includes('/document-map');
    const milliseconds=isDocument?270000:190000;
    const controller=new AbortController();
    const start=Date.now();let timedOut=false;
    const host=document.getElementById('ai-wait-status');
    const text=document.getElementById('ai-wait-text');
    const cancel=document.getElementById('btn-ai-cancel');
    active={controller};
    const render=()=>{if(text)text.textContent=`${isDocument?'AI 正在阅读全文':'AI 正在识别'} · 已等待 ${Math.floor((Date.now()-start)/1000)} 秒`;};
    if(host)host.hidden=false;
    if(cancel)cancel.onclick=()=>controller.abort();
    render();const interval=setInterval(render,1000);
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},milliseconds);
    const externalAbort=()=>controller.abort();options.signal?.addEventListener('abort',externalAbort,{once:true});
    try {if(options.signal?.aborted)controller.abort();const response=await fetch(url,{...options,signal:controller.signal});
      // Consume the body under the same deadline; callers still receive a Response.
      const bytes=await response.arrayBuffer();
      return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){if(controller.signal.aborted){const cancelled=new Error(timedOut?'AI 请求超过等待上限，已停止；请稍后重试':'已取消本次 AI 请求');cancelled.code=timedOut?'ai_timeout':'ai_cancelled';throw cancelled;}throw error;}
    finally{clearTimeout(timer);clearInterval(interval);options.signal?.removeEventListener('abort',externalAbort);active=null;if(host)host.hidden=true;if(cancel)cancel.onclick=null;}
  }
  global.AltCanvasAiWait={fetch:fetchWithDeadline};
})(globalThis);
