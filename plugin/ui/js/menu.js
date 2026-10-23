import { el } from './util.js';
import { icon } from './icons.js';

let open = null;

function close() {
  if (open) {
    open.remove();
    open = null;
  }
}

/** items: [{ label, icon, hint, run, disabled, danger } | 'sep'] */
export function showMenu(x, y, items) {
  close();
  const menu = el('div.ctx-menu', { role: 'menu' });
  for (const item of items) {
    if (item === 'sep') {
      menu.append(el('div.ctx-sep'));
      continue;
    }
    const btn = el(
      'button.ctx-item',
      { disabled: !!item.disabled, class: item.danger ? 'danger' : '' },
      el('span.ctx-icon', { html: item.icon ? icon(item.icon) : '' }),
      el('span.ctx-label', item.label),
      item.hint ? el('span.ctx-hint', item.hint) : null,
    );
    btn.addEventListener('click', () => {
      close();
      item.run();
    });
    menu.append(btn);
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  open = menu;
}

window.addEventListener('mousedown', (e) => {
  if (open && !open.contains(e.target)) close();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
}, true);
window.addEventListener('blur', close);
window.addEventListener('resize', close);

export const closeMenu = close;
