import { t, lang } from './i18n.js';

/** Tiny element factory: el('div.cls#id', { attrs, on: { click } }, children...) */
export function el(spec, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const node = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === 'class') node.className += ` ${v}`;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function rafThrottle(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = lang() === 'ru' ? ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bps) {
  return `${formatBytes(bps)}/${lang() === 'ru' ? 'с' : 's'}`;
}

/** 83.4 → "1:23", 4000 → "1:06:40" */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Timecode-like "00:01:23:12" for the viewer. */
export function formatTimecode(seconds, fps = 30) {
  if (!Number.isFinite(seconds)) seconds = 0;
  const base = Math.max(1, Math.round(fps));
  const totalFrames = Math.floor(seconds * fps + 1e-6);
  const ff = totalFrames % base;
  const total = Math.floor(totalFrames / base);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}:${p(ff)}`;
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} ${lang() === 'ru' ? 'с' : 's'}`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${lang() === 'ru' ? 'мин' : 'min'}`;
  return `${(seconds / 3600).toFixed(1)} ${lang() === 'ru' ? 'ч' : 'h'}`;
}

function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dayKey(iso) {
  const d = parseDate(iso);
  if (!d) return '0000-00-00';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function monthKey(iso) {
  return dayKey(iso).slice(0, 7);
}

export function formatDayHeader(key) {
  if (key === '0000-00-00') return t('misc.unknownDate');
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(date)) / 86400000);
  if (diff === 0) return t('unit.today');
  if (diff === 1) return t('unit.yesterday');
  const opts = { weekday: 'short', day: 'numeric', month: 'long' };
  if (y !== today.getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat(lang(), opts).format(date);
}

export function formatMonthHeader(key) {
  if (key.startsWith('0000')) return t('misc.unknownDate');
  const [y, m] = key.split('-').map(Number);
  const s = new Intl.DateTimeFormat(lang(), { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDateTime(iso) {
  const d = parseDate(iso);
  if (!d) return '—';
  return new Intl.DateTimeFormat(lang(), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function resolutionLabel(w, h) {
  if (!w || !h) return '';
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 3800 || short >= 2100) return '4K';
  if (long >= 2500 || short >= 1400) return '2.7K';
  if (short >= 1070) return 'HD';
  if (short >= 700) return '720';
  return '';
}

export function isEditableTarget(target) {
  return !!target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
}
