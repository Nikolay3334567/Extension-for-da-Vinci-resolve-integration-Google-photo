'use strict';

const { trustHost } = require('./http');

const PLUGIN_ID = 'com.cloudpool.resolve.googlephotos';
const APP_NAME = 'Cloud Pool';
const DATA_DIR_NAME = 'Cloud Pool for Resolve';

const SCOPES = {
  photos: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
  identity: ['openid', 'email', 'profile'],
};

/**
 * Google endpoints. CLOUDPOOL_GOOGLE_BASE points every endpoint at a single server; the test
 * suite uses it to run the whole app against a local fake Google implementation.
 */
function resolveEndpoints(env = process.env) {
  const base = env.CLOUDPOOL_GOOGLE_BASE;
  if (base) {
    const root = base.replace(/\/+$/, '');
    trustHost(new URL(root).host);
    return {
      auth: `${root}/o/oauth2/v2/auth`,
      token: `${root}/token`,
      revoke: `${root}/revoke`,
      picker: `${root}/picker/v1`,
      drive: `${root}/drive/v3`,
    };
  }
  return {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    picker: 'https://photospicker.googleapis.com/v1',
    drive: 'https://www.googleapis.com/drive/v3',
  };
}

const DEFAULT_SETTINGS = {
  language: 'auto', // 'auto' | 'ru' | 'en'
  downloadDir: '', // filled in at startup with <Videos>/Cloud Pool
  organizeByDate: true,
  autoDownloadVideos: true,
  autoDownloadPhotos: true,
  maxParallelDownloads: 2,
  connectionsPerDownload: 6,
  binName: 'Google Photos',
  driveBinName: 'Google Drive',
  thumbCacheMB: 1024,
  hoverPreview: true,
  hoverPreviewSound: false,
  tileSize: 168,
  tileFit: 'cover', // 'cover' | 'contain'
  groupBy: 'day', // 'day' | 'month' | 'none'
  sources: ['photos', 'drive'],
  pinned: false,
  switchToEditPage: false,
  segmentDownloads: true, // long videos with In/Out: fetch only the marked part (needs ffmpeg)
  ffmpegPath: '',
  window: null,
};

module.exports = { PLUGIN_ID, APP_NAME, DATA_DIR_NAME, SCOPES, DEFAULT_SETTINGS, resolveEndpoints };
