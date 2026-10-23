'use strict';

// Knows how to reach the bytes of an item in each Google service: thumbnails at any size,
// streamable video, and the file to download. Handles access-token refresh (401) and the
// Google Photos base-URL refresh (403 once the 60-minute URL has expired).

const { request, readBody, errorFromResponse, HttpError } = require('./http');
const { DriveApi } = require('./drive');
const { ExpiredError } = require('./photos');
const { splitKey } = require('./items');

const HEIF = /^image\/hei[cf]/i;

class MediaSources {
  /**
   * @param {object} opts
   * @param {import('./oauth').GoogleAuth} opts.auth
   * @param {import('./photos').PhotosLibrary} opts.photos
   * @param {import('./drive').DriveApi} opts.drive
   */
  constructor({ auth, photos, drive }) {
    this.auth = auth;
    this.photos = photos;
    this.drive = drive;
  }

  /** Finds the internal item for a key (fetching Drive metadata if it is not cached). */
  async resolve(key) {
    const parts = splitKey(key);
    if (!parts) throw new HttpError(400, 'Bad item key');
    if (parts.source === 'photos') {
      const item = this.photos.get(parts.id);
      if (!item) throw new HttpError(404, 'Item not in library');
      return item;
    }
    if (parts.source === 'drive') return this.drive.get(parts.id);
    throw new HttpError(400, `Unknown source ${parts.source}`);
  }

  peek(key) {
    const parts = splitKey(key);
    if (!parts) return null;
    if (parts.source === 'photos') return this.photos.get(parts.id);
    if (parts.source === 'drive') return this.drive.cache.get(parts.id) || null;
    return null;
  }

  async _photosUrl(item, suffix, force) {
    const base = await this.photos.freshBaseUrl(item.id, { force });
    return `${base}=${suffix}`;
  }

  /** URL + suffix used to fetch the full-quality file for download. */
  async downloadTarget(item, { force = false } = {}) {
    if (item.source === 'photos') {
      if (item.kind === 'video') return { url: await this._photosUrl(item, 'dv', force), headers: await this.auth.authHeaders() };
      // HEIC/HEIF stills are converted by Google to full-size JPEG, which Resolve can read.
      const suffix = HEIF.test(item.mimeType) && item.width && item.height ? `w${item.width}-h${item.height}` : 'd';
      return { url: await this._photosUrl(item, suffix, force), headers: await this.auth.authHeaders() };
    }
    return { url: this.drive.mediaUrl(item.id), headers: await this.auth.authHeaders() };
  }

  /** Local file name the download should get (HEIC stills become .jpg). */
  downloadName(item) {
    if (item.source === 'photos' && item.kind === 'photo' && HEIF.test(item.mimeType) && item.width && item.height) {
      return item.name.replace(/\.(heic|heif)$/i, '') + '.jpg';
    }
    return item.name;
  }

  /**
   * Opens the upstream response for streaming / probing (Range is passed through).
   * Retries once with a fresh token on 401 and with a fresh base URL on 403.
   */
  async openStream(item, { range = null, signal = null, timeout = 30000 } = {}) {
    let forceUrl = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = await this.downloadTarget(item, { force: forceUrl });
      const headers = { ...target.headers };
      if (range) headers.Range = range;
      const res = await request(target.url, { headers, signal, timeout });
      if (res.statusCode === 401 && attempt < 2) {
        res.resume();
        this.auth.invalidateAccessToken();
        continue;
      }
      if (res.statusCode === 403 && item.source === 'photos' && attempt < 2) {
        res.resume();
        forceUrl = true;
        continue;
      }
      if (res.statusCode >= 400) {
        const body = await readBody(res, { limit: 64 * 1024 }).catch(() => Buffer.alloc(0));
        let data = null;
        try {
          data = JSON.parse(body.toString('utf8'));
        } catch {
          /* not JSON */
        }
        throw errorFromResponse(res, data, body.toString('utf8'));
      }
      return res;
    }
    throw new HttpError(403, 'Access denied by Google');
  }

  /** Thumbnail bytes at `size` (longest edge) for the thumbnail cache. */
  async fetchThumbnail(item, size, signal) {
    if (item.source === 'photos') {
      let force = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const url = await this._photosUrl(item, `w${size}-h${size}`, force);
        const res = await request(url, { headers: await this.auth.authHeaders(), signal, timeout: 20000 });
        if (res.statusCode === 401) {
          res.resume();
          this.auth.invalidateAccessToken();
          continue;
        }
        if (res.statusCode === 403 || res.statusCode === 404) {
          res.resume();
          force = true;
          continue;
        }
        if (res.statusCode !== 200) {
          res.resume();
          throw new HttpError(res.statusCode, `Thumbnail failed (${res.statusCode})`);
        }
        return readBody(res, { limit: 16 * 1024 * 1024 });
      }
      throw new ExpiredError();
    }

    let current = item;
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = DriveApi.thumbnailUrl(current._thumbnailLink, size);
      if (!url) throw new HttpError(404, 'No thumbnail');
      const res = await request(url, { headers: await this.auth.authHeaders(), signal, timeout: 20000 });
      if (res.statusCode === 200) return readBody(res, { limit: 16 * 1024 * 1024 });
      res.resume();
      if (attempt === 0 && [401, 403, 404].includes(res.statusCode)) {
        if (res.statusCode === 401) this.auth.invalidateAccessToken();
        // Thumbnail links are short-lived; fetch fresh metadata and try again.
        current = await this.drive.get(item.id, { force: true });
        continue;
      }
      throw new HttpError(res.statusCode, `Thumbnail failed (${res.statusCode})`);
    }
    throw new HttpError(404, 'No thumbnail');
  }
}

module.exports = { MediaSources };
