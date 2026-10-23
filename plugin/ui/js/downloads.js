// Drawer listing file downloads and "send to Resolve" jobs.

import { el, clear, formatBytes, formatSpeed, formatEta } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { call } from './api.js';

export class DownloadsPanel {
  constructor(root) {
    this.root = root;
    this.rows = new Map();
    this.jobRows = new Map();
    this.render();
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  toggle(force) {
    this.root.classList.toggle('open', force == null ? !this.isOpen : force);
    if (this.isOpen) this.render();
  }

  render() {
    clear(this.root);
    this.rows.clear();
    this.jobRows.clear();
    const header = el(
      'div.drawer-header',
      el('h3', t('dl.title')),
      el('span.flex'),
      el('button.btn.small', { on: { click: () => call('downloads:clearFinished') } }, t('dl.clear')),
      el('button.icon-btn', { title: t('act.close'), html: icon('x'), on: { click: () => this.toggle(false) } }),
    );
    this.jobsBox = el('div.drawer-section.jobs');
    this.list = el('div.drawer-section');
    this.root.append(header, this.jobsBox, this.list);
    for (const job of [...state.jobs.values()].reverse()) this.updateJob(job);
    const items = [...state.downloads.values()].sort((a, b) => rank(a) - rank(b));
    for (const d of items) this.update(d);
    this._empty();
  }

  _empty() {
    if (!this.list) return;
    const empty = this.list.querySelector('.drawer-empty');
    const has = this.rows.size > 0;
    if (!has && !empty) this.list.append(el('div.drawer-empty', t('dl.empty')));
    if (has && empty) empty.remove();
  }

  update(d) {
    if (!this.list) return;
    let row = this.rows.get(d.key);
    if (!row) {
      row = el(
        'div.dl-row',
        el('div.dl-name'),
        el('div.dl-bar', el('div.dl-fill')),
        el('div.dl-meta'),
        el('div.dl-actions'),
      );
      this.rows.set(d.key, row);
      this.list.prepend(row);
    }
    row.dataset.state = d.state;
    row.querySelector('.dl-name').textContent = d.name;
    const p = d.total ? d.received / d.total : d.state === 'done' ? 1 : 0;
    row.querySelector('.dl-fill').style.width = `${Math.round(p * 1000) / 10}%`;
    let meta = t(`dl.${d.state}`) || d.state;
    if (d.state === 'active') {
      meta = `${formatBytes(d.received)} / ${formatBytes(d.total)} · ${formatSpeed(d.speed)}`;
      if (d.eta != null) meta += ` · ${t('dl.left', { t: formatEta(d.eta) })}`;
    } else if (d.state === 'error') {
      meta = `${t('dl.error')}: ${d.error || ''}`;
    } else if (d.state === 'done') {
      meta = `${t('dl.done')} · ${formatBytes(d.total)}`;
    }
    row.querySelector('.dl-meta').textContent = meta;
    const actions = row.querySelector('.dl-actions');
    clear(actions);
    const btn = (ic, title, fn) => el('button.icon-btn.small', { title, html: icon(ic), on: { click: fn } });
    if (d.state === 'active' || d.state === 'queued') actions.append(btn('pause', t('act.pause'), () => call('downloads:pause', { keys: [d.key] })));
    if (d.state === 'paused' || d.state === 'error') actions.append(btn('refresh', d.state === 'error' ? t('act.retry') : t('act.resume'), () => call('downloads:resume', { keys: [d.key] })));
    if (d.state === 'done') actions.append(btn('folder', t('act.reveal'), () => call('local:reveal', { key: d.key })));
    if (d.state !== 'done') actions.append(btn('x', t('act.cancel'), () => call('downloads:cancel', { keys: [d.key] })));
    this._empty();
  }

  remove(key) {
    const row = this.rows.get(key);
    if (row) row.remove();
    this.rows.delete(key);
    this._empty();
  }

  updateJob(job) {
    if (!this.jobsBox) return;
    let row = this.jobRows.get(job.id);
    if (!row) {
      row = el('div.job-row', el('div.job-title'), el('div.job-meta'), el('div.job-actions'));
      this.jobRows.set(job.id, row);
      this.jobsBox.prepend(row);
    }
    row.dataset.state = job.state;
    const n = job.entries.length;
    row.querySelector('.job-title').textContent = `${t(`job.${job.action}`)} · ${n === 1 ? job.entries[0].name : t('misc.items', { n })}`;
    let meta = t(`job.${job.state}`);
    if (job.state === 'running' || job.state === 'queued') {
      const done = job.entries.filter((e) => e.state !== 'downloading').length;
      meta = t('job.waiting', { done, total: n });
    } else if (job.state === 'done' && job.result) {
      meta = job.action === 'import' ? t('job.imported', { n: job.result.imported + job.result.reused }) : t('job.placed', { n: job.result.placed, timeline: job.result.timeline || '' });
    } else if (job.state === 'error') {
      meta = job.error || t('job.error');
    }
    row.querySelector('.job-meta').textContent = meta;
    const actions = row.querySelector('.job-actions');
    clear(actions);
    if (job.state === 'running' || job.state === 'queued') {
      actions.append(el('button.icon-btn.small', { title: t('act.cancel'), html: icon('x'), on: { click: () => call('resolve:cancelJob', { id: job.id }) } }));
    }
    this.jobsBox.classList.toggle('has-jobs', this.jobRows.size > 0);
  }
}

function rank(d) {
  return { active: 0, verifying: 0, queued: 1, paused: 2, error: 3, done: 4 }[d.state] ?? 5;
}

/** Totals for the status bar. */
export function downloadSummary() {
  let active = 0;
  let speed = 0;
  let left = 0;
  for (const d of state.downloads.values()) {
    if (d.state === 'active' || d.state === 'queued' || d.state === 'verifying') {
      active++;
      speed += d.speed || 0;
      if (d.total) left += d.total - d.received;
    }
  }
  return { active, speed, left };
}
