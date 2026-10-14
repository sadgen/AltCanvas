(function(global) {
  let popup, anchor, buttons = [];
  function close(restore = true) {
    if (!popup) return;
    popup.remove(); popup = null;
    anchor?.setAttribute('aria-expanded', 'false');
    if (restore && anchor?.isConnected) anchor.focus();
    anchor = null; buttons = [];
  }
  function open(trigger, { title, details = [], actions = [], error = () => {} }) {
    close(false); anchor = trigger;
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'true');
    popup = document.createElement('div'); popup.className = 'library-menu'; popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-label', title || '文章操作');
    if (details.length) {
      const info = document.createElement('div'); info.className = 'library-menu-info'; info.setAttribute('role', 'presentation');
      for (const text of details.filter(Boolean)) { const p = document.createElement('p'); p.textContent = text; info.appendChild(p); }
      popup.appendChild(info);
    }
    for (const action of actions) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'library-menu-action';
      button.textContent = action.label; button.setAttribute('role', 'menuitem');
      if (action.danger) button.classList.add('library-menu-danger');
      button.onclick = async event => { event.stopPropagation(); close(); try { await action.run(); } catch (e) { error(e); } };
      button.disabled = Boolean(action.disabled);
      if (!button.disabled) buttons.push(button);
      popup.appendChild(button);
    }
    document.body.appendChild(popup);
    const rect = trigger.getBoundingClientRect(), size = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.right - size.width, global.innerWidth - size.width - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(rect.bottom + 4, global.innerHeight - size.height - 8))}px`;
    buttons[0]?.focus();
  }
  document.addEventListener('click', event => {
    if (popup && !popup.contains(event.target) && !anchor?.contains(event.target)) close(false);
  });
  document.addEventListener('keydown', event => {
    if (!popup) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') { close(false); return; }
    const index = buttons.indexOf(document.activeElement);
    if (buttons.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  });
  global.addEventListener('resize', () => close(false));
  document.addEventListener('scroll', event => { if (popup && !popup.contains(event.target)) close(false); }, true);
  global.AltCanvasLibraryMenu = { open, close };
})(globalThis);
