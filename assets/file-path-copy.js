(function(global) {
  async function copy(text) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP origins need fallback */ }
    }
    const previous = document.activeElement;
    const input = document.createElement('textarea'); input.value = text; input.readOnly = true;
    input.style.position = 'fixed'; input.style.opacity = '0'; input.style.left = '-9999px';
    document.body.appendChild(input);
    let copied = false;
    try { input.focus(); input.select(); copied = document.execCommand('copy'); }
    finally { input.remove(); previous?.focus?.({ preventScroll: true }); }
    if (!copied) throw new Error('浏览器限制了剪贴板，请选中菜单里的路径后手动复制');
  }
  global.AltCanvasFilePathCopy = { copy };
})(globalThis);
