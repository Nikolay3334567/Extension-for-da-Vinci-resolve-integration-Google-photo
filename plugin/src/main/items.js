'use strict';

// Normalised media item model shared by every source. Fields prefixed with an underscore in the
// comments below are internal and never sent to the renderer (see publicItem()).
//
// {
//   key: 'photos:<id>' | 'drive:<id>',  source, id, name, mimeType,
//   kind: 'video' | 'photo' | 'folder' | 'other',
//   createdAt (ISO, capture time when known), width, height, durationMs, fps, size, camera,
//   processing ('READY' | 'PROCESSING' | 'FAILED' | null)    — Google Photos videos
//   _baseUrl, _baseUrlAt, _sessionId                          — Google Photos (Picker API)
//   _thumbnailLink, md5, parents, modifiedAt                   — Google Drive
// }

const { withExtension } = require('./util');

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function kindForMime(mime) {
  const m = String(mime || '');
  if (m === FOLDER_MIME) return 'folder';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'photo';
  return 'other';
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fromPicked(m, sessionId, now = Date.now()) {
  const file = m.mediaFile || {};
  const meta = file.mediaFileMetadata || {};
  const video = meta.videoMetadata || null;
  const isVideo = m.type === 'VIDEO' || String(file.mimeType || '').startsWith('video/');
  const mimeType = file.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
  const fallbackName = `${isVideo ? 'VID' : 'IMG'}_${String(m.id).slice(0, 10)}`;
  return {
    key: `photos:${m.id}`,
    source: 'photos',
    id: m.id,
    name: withExtension(file.filename || fallbackName, mimeType),
    mimeType,
    kind: isVideo ? 'video' : 'photo',
    createdAt: m.createTime || null,
    width: num(meta.width),
    height: num(meta.height),
    durationMs: null,
    fps: video ? num(video.fps) : null,
    size: null,
    camera: [meta.cameraMake, meta.cameraModel].filter(Boolean).join(' ') || null,
    processing: video ? video.processingStatus || 'UNSPECIFIED' : null,
    _baseUrl: file.baseUrl || null,
    _baseUrlAt: now,
    _sessionId: sessionId,
  };
}

/** Drive EXIF time "2026:10:22 14:03:11" → local ISO "2026-10-22T14:03:11". */
function exifTimeToIso(value) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

const DRIVE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,md5Checksum,parents,' +
  'videoMediaMetadata(width,height,durationMillis),imageMediaMetadata(width,height,time,cameraMake,cameraModel)';

function fromDrive(f) {
  const vm = f.videoMediaMetadata || {};
  const im = f.imageMediaMetadata || {};
  return {
    key: `drive:${f.id}`,
    source: 'drive',
    id: f.id,
    name: f.name || f.id,
    mimeType: f.mimeType || 'application/octet-stream',
    kind: kindForMime(f.mimeType),
    createdAt: exifTimeToIso(im.time) || f.createdTime || f.modifiedTime || null,
    modifiedAt: f.modifiedTime || null,
    width: num(vm.width) || num(im.width),
    height: num(vm.height) || num(im.height),
    durationMs: num(vm.durationMillis),
    fps: null,
    size: num(f.size),
    camera: [im.cameraMake, im.cameraModel].filter(Boolean).join(' ') || null,
    processing: null,
    md5: f.md5Checksum || null,
    parents: f.parents || [],
    _thumbnailLink: f.thumbnailLink || null,
  };
}

/** Strips internal fields before handing an item to the renderer. */
function publicItem(item, extra) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (k[0] !== '_') out[k] = v;
  }
  if (item.source === 'drive') out.hasThumb = !!item._thumbnailLink;
  else out.hasThumb = true;
  return extra ? Object.assign(out, extra) : out;
}

function splitKey(key) {
  const i = String(key).indexOf(':');
  if (i <= 0) return null;
  return { source: key.slice(0, i), id: key.slice(i + 1) };
}

module.exports = { FOLDER_MIME, DRIVE_FIELDS, kindForMime, fromPicked, fromDrive, exifTimeToIso, publicItem, splitKey };
