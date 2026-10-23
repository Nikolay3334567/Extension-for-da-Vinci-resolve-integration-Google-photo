import { el } from './util.js';
import { icon } from './icons.js';

let host = null;

/** level: 'info' | 'ok' | 'warn' | 'error'; action: { label, run } */
export function toast(message, { level = 'info', timeout = 5000, action = null } = {}) {
  if (!host) {
    host = el('div.toasts');
    document.body.append(host);
  }
  const ic = { ok: 'checkCircle', warn: 'alert', error: 'alert', info: 'info' }[level] || 'info';
  const node = el(`div.toast.${level}`, el('span.toast-icon', { html: icon(ic) }), el('span.toast-text', message));
  if (action) {
    node.append(
      el('button.btn.small', {
        on: {
          click: () => {
            action.run();
            dismiss();
          },
        },
      }, action.label),
    );
  }
  const close = el('button.icon-btn.small', { html: icon('x'), on: { click: () => dismiss() } });
  node.append(close);
  host.append(node);
  requestAnimationFrame(() => node.classList.add('in'));
  let timer = timeout ? setTimeout(dismiss, timeout) : null;
  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => {
    if (timeout) timer = setTimeout(dismiss, 2500);
  });
  function dismiss() {
    clearTimeout(timer);
    node.classList.remove('in');
    setTimeout(() => node.remove(), 200);
  }
  while (host.children.length > 4) host.firstChild.remove();
  return dismiss;
}
