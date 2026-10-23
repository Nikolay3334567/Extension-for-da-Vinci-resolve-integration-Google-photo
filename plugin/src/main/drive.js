'use strict';

const { fetchJson, HttpError } = require('./http');
const { fromDrive, DRIVE_FIELDS, FOLDER_MIME } = require('./items');

const ORDER = {
  newest: 'createdTime desc',
  oldest: 'createdTime',
  modified: 'modifiedTime desc',
  name: 'name_natural',
  size: 'quotaBytesUsed desc',
};

function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Builds a Drive v3 `q` expression.
 * view: 'videos' | 'photos' | 'media' | 'folder' | 'shared'
 */
function buildQuery({ view = 'videos', folderId = null, search = '', kind = 'all' } = {}) {
  const parts = ['trashed = false'];
  const video = "mimeType contains 'video/'";
  const image = "mimeType contains 'image/'";
  const media = `(${video} or ${image})`;
  let mediaFilter = kind === 'video' ? video : kind === 'photo' ? image : media;
  if (view === 'videos') mediaFilter = video;
  if (view === 'photos') mediaFilter = image;

  if (view === 'folder') {
    parts.push(`${quote(folderId || 'root')} in parents`);
    // Inside folders we also list sub-folders so the user can navigate.
    parts.push(search ? mediaFilter : `(${mediaFilter} or mimeType = '${FOLDER_MIME}')`);
  } else if (view === 'shared') {
    parts.push('sharedWithMe = true');
    parts.push(`(${mediaFilter} or mimeType = '${FOLDER_MIME}')`);
  } else {
    parts.push(mediaFilter);
  }
  if (search) {
    const q = quote(search);
    parts.push(`(name contains ${q} or fullText contains ${q})`);
  }
  return parts.join(' and ');
}

class DriveApi {
  constructor({ auth, base }) {
    this.auth = auth;
    this.base = base;
    this.cache = new Map(); // id -> item, so the media server can resolve keys without a round-trip
  }

  _remember(item) {
    this.cache.delete(item.id);
    this.cache.set(item.id, item);
    if (this.cache.size > 50000) this.cache.delete(this.cache.keys().next().value);
    return item;
  }

  async list({ view = 'videos', folderId = null, search = '', kind = 'all', order = 'newest', pageToken = '', pageSize = 200 } = {}) {
    const params = new URLSearchParams({
      q: buildQuery({ view, folderId, search, kind }),
      fields: `nextPageToken,files(${DRIVE_FIELDS})`,
      pageSize: String(pageSize),
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      spaces: 'drive',
    });
    // Drive refuses to sort full-text searches; results then come back by relevance.
    if (!search) params.set('orderBy', view === 'folder' || view === 'shared' ? `folder,${ORDER[order] || ORDER.newest}` : ORDER[order] || ORDER.newest);
    if (pageToken) params.set('pageToken', pageToken);
    const data = await this.auth.withAuth((headers) => fetchJson(`${this.base}/files?${params.toString()}`, { headers, timeout: 30000 }));
    const items = (data.files || []).map((f) => this._remember(fromDrive(f)));
    return { items, nextPageToken: data.nextPageToken || null };
  }

  async get(id, { force = false } = {}) {
    if (!force && this.cache.has(id)) return this.cache.get(id);
    const params = new URLSearchParams({ fields: DRIVE_FIELDS, supportsAllDrives: 'true' });
    const data = await this.auth.withAuth((headers) =>
      fetchJson(`${this.base}/files/${encodeURIComponent(id)}?${params.toString()}`, { headers, timeout: 20000 }),
    );
    return this._remember(fromDrive(data));
  }

  async folderPath(id) {
    // Walks up the parents chain for breadcrumbs (stops at My Drive).
    const crumbs = [];
    let current = id;
    for (let i = 0; i < 20 && current && current !== 'root'; i++) {
      let item;
      try {
        item = await this.get(current);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) break;
        throw err;
      }
      crumbs.unshift({ id: item.id, name: item.name });
      current = item.parents && item.parents[0];
    }
    if (crumbs.length && crumbs[0].name === 'My Drive') crumbs.shift();
    return crumbs;
  }

  mediaUrl(id) {
    return `${this.base}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
  }

  /** Drive thumbnail links end with "=s220"; any size can be requested by swapping the suffix. */
  static thumbnailUrl(link, size) {
    if (!link) return null;
    const base = link.replace(/=s\d+(-[a-z0-9-]+)?$/i, '');
    return `${base}=s${size}`;
  }
}

module.exports = { DriveApi, buildQuery };
