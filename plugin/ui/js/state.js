// Shared UI state + a tiny topic-based event bus.

export const state = {
  mode: 'plugin',
  platform: 'darwin',
  mediaBase: '',
  auth: {},
  settings: {},
  picker: { state: 'idle' },
  resolve: { connected: false },
  luaBridge: null,
  view: {
    source: 'photos', // photos | drive | local
    driveView: 'videos', // videos | photos | folder | shared
    folderId: null,
    trail: [], // breadcrumbs [{ id, name }]
    filter: 'all', // all | video | photo
    sort: 'newest',
    search: '',
  },
  photos: new Map(), // key -> item
  local: new Map(), // key -> local entry
  drive: { items: [], index: new Map(), nextPageToken: null, loading: false, error: null, req: 0 },
  downloads: new Map(), // key -> snapshot
  jobs: new Map(), // id -> job
  selection: new Set(),
  anchor: null,
  marks: {}, // key -> { in, out }
  previewKey: null,
};

const topics = new Map();

export function on(topic, fn) {
  if (!topics.has(topic)) topics.set(topic, new Set());
  topics.get(topic).add(fn);
  return () => topics.get(topic).delete(fn);
}

export function emit(topic, payload) {
  for (const fn of topics.get(topic) || []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
}

export function getItem(key) {
  return state.photos.get(key) || state.drive.index.get(key) || state.local.get(key) || null;
}

export function isLocal(key) {
  const item = state.photos.get(key) || state.drive.index.get(key);
  return state.local.has(key) || !!(item && item.local);
}

export function thumbUrl(key, px) {
  return `${state.mediaBase}/thumb/${encodeURIComponent(key)}?s=${Math.round(px)}`;
}

export function streamUrl(key) {
  return `${state.mediaBase}/stream/${encodeURIComponent(key)}`;
}

const SORTERS = {
  newest: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
  oldest: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  duration: (a, b) => (b.durationMs || 0) - (a.durationMs || 0),
  size: (a, b) => (b.size || 0) - (a.size || 0),
};

function matches(item, query) {
  if (!query) return true;
  const hay = `${item.name} ${item.camera || ''} ${item.createdAt || ''} ${item.mimeType || ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** Items of the current view after filter / search / sort. */
export function viewItems() {
  const v = state.view;
  let list;
  if (v.source === 'photos') list = [...state.photos.values()];
  else if (v.source === 'local') list = [...state.local.values()];
  else {
    const items = state.drive.items.filter((i) => v.filter === 'all' || i.kind === v.filter || i.kind === 'folder');
    // Folders first (Drive's own "folder" ordering), keeping the server order otherwise.
    return [...items.filter((i) => i.kind === 'folder'), ...items.filter((i) => i.kind !== 'folder')];
  }
  list = list.filter((i) => (v.filter === 'all' || i.kind === v.filter) && matches(i, v.search));
  list.sort(SORTERS[v.sort] || SORTERS.newest);
  return list;
}

/** Date grouping only makes sense when the list is sorted by date. */
export function groupingFor() {
  const v = state.view;
  if (v.source === 'drive' && (v.driveView === 'folder' || v.driveView === 'shared' || v.search)) return 'none';
  if (v.sort !== 'newest' && v.sort !== 'oldest') return 'none';
  return state.settings.groupBy || 'day';
}
