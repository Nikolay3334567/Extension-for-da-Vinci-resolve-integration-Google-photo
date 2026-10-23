'use strict';

// In-memory model of the parts of DaVinci Resolve's scripting API that Cloud Pool uses, with the
// behaviour observed on real Resolve 19–21 builds:
//  • AppendToTimeline endFrame is exclusive; a clipInfo whose record range overlaps an existing
//    item on its track is silently dropped (not returned).
//  • ImportMedia imports into the *current* folder.
//  • Frame numbers are absolute (timeline start = 01:00:00:00 → 86400 at 24 fps).
// `async: true` wraps every method in a Promise, like the 20.1+ promise API.

const { tcToFrames, framesToTc, parseRate } = require('../../plugin/src/main/resolve/timecode');

class Item {
  constructor(path, media) {
    this.path = path;
    this.media = media;
    this.metadata = {};
    this.third = {};
  }

  GetName() {
    return this.path.split(/[\\/]/).pop();
  }

  GetClipProperty(key) {
    const m = this.media;
    const props = {
      'File Path': this.path,
      FPS: String(m.fps || 0),
      Frames: String(m.frames || 0),
      Type: m.still ? 'Still' : m.audio ? 'Video + Audio' : 'Video',
      'Audio Ch': m.audio ? '2' : '0',
      'Audio Codec': m.audio ? 'AAC' : '',
    };
    return key ? props[key] : props;
  }

  SetMetadata(k, v) {
    this.metadata[k] = v;
    return true;
  }

  SetThirdPartyMetadata(k, v) {
    this.third[k] = v;
    return true;
  }
}

class Folder {
  constructor(name) {
    this.name = name;
    this.clips = [];
    this.subs = [];
  }

  GetName() {
    return this.name;
  }

  GetClipList() {
    return this.clips.slice();
  }

  GetSubFolderList() {
    return this.subs.slice();
  }
}

class TimelineItem {
  constructor({ item, start, end, track, type }) {
    Object.assign(this, { item, start, end, track, type });
  }

  GetStart() {
    return this.start;
  }

  GetEnd() {
    return this.end;
  }

  GetName() {
    return this.item.GetName();
  }
}

class Timeline {
  constructor(name, { fps = 24, startTc = '01:00:00:00' } = {}) {
    this.name = name;
    this.fps = fps;
    this.startTc = startTc;
    this.startFrame = tcToFrames(startTc, fps);
    this.playhead = this.startFrame;
    this.tracks = { video: [[]], audio: [[]] };
    this.locked = { video: new Set(), audio: new Set() };
  }

  GetName() {
    return this.name;
  }

  GetSetting(key) {
    return key === 'timelineFrameRate' ? String(this.fps) : '';
  }

  GetStartFrame() {
    return this.startFrame;
  }

  GetEndFrame() {
    let end = this.startFrame;
    for (const lane of [...this.tracks.video, ...this.tracks.audio]) for (const it of lane) end = Math.max(end, it.end);
    return end;
  }

  GetStartTimecode() {
    return this.startTc;
  }

  GetCurrentTimecode() {
    const df = this.startTc.includes(';');
    return framesToTc(tcToFrames(this.startTc, this.fps) + (this.playhead - this.startFrame), this.fps, df);
  }

  SetCurrentTimecode(tc) {
    this.playhead = this.startFrame + (tcToFrames(tc, this.fps) - tcToFrames(this.startTc, this.fps));
    return true;
  }

  GetTrackCount(type) {
    return this.tracks[type] ? this.tracks[type].length : 0;
  }

  AddTrack(type) {
    if (!this.tracks[type]) return false;
    this.tracks[type].push([]);
    return true;
  }

  GetItemListInTrack(type, index) {
    return (this.tracks[type][index - 1] || []).slice();
  }

  GetIsTrackLocked(type, index) {
    return this.locked[type].has(index);
  }

  _place(info) {
    const isInfo = !(info instanceof Item);
    const item = isInfo ? info.mediaPoolItem : info;
    const m = item.media;
    const srcStart = isInfo && info.startFrame != null ? info.startFrame : 0;
    const srcEnd = isInfo && info.endFrame != null ? info.endFrame : m.still ? Math.round(5 * (m.fps || this.fps)) : m.frames;
    const length = m.still ? (isInfo && info.endFrame != null ? srcEnd - srcStart : 5 * this.fps) : Math.round(((srcEnd - srcStart) / m.fps) * this.fps);
    const track = (isInfo && info.trackIndex) || 1;
    const start = isInfo && info.recordFrame != null ? info.recordFrame : this.GetEndFrame();
    const end = start + length;
    const lanes = [['video', true], ['audio', !!m.audio && !m.still]];
    for (const [type, used] of lanes) {
      if (!used) continue;
      const lane = this.tracks[type][track - 1];
      if (!lane || this.locked[type].has(track)) return null;
      if (lane.some((it) => it.start < end && it.end > start)) return null; // silently dropped
    }
    let placed = null;
    for (const [type, used] of lanes) {
      if (!used) continue;
      const it = new TimelineItem({ item, start, end, track, type });
      this.tracks[type][track - 1].push(it);
      if (type === 'video') placed = it;
    }
    return placed;
  }
}

class MediaPool {
  constructor(resolve) {
    this.resolve = resolve;
    this.root = new Folder('Master');
    this.current = this.root;
  }

  GetRootFolder() {
    return this.root;
  }

  AddSubFolder(parent, name) {
    const f = new Folder(name);
    parent.subs.push(f);
    return f;
  }

  GetCurrentFolder() {
    return this.current;
  }

  SetCurrentFolder(f) {
    this.current = f;
    return true;
  }

  ImportMedia(paths) {
    const out = [];
    for (const p of paths) {
      const media = this.resolve.media[p];
      if (!media) continue;
      const item = new Item(p, media);
      this.current.clips.push(item);
      out.push(item);
    }
    this.resolve.importCalls.push(paths.slice());
    return out.reverse(); // Resolve does not promise any particular order
  }

  CreateEmptyTimeline(name) {
    const t = new Timeline(name, this.resolve.newTimelineOptions);
    this.resolve.project.timelines.push(t);
    return t;
  }

  AppendToTimeline(list) {
    const t = this.resolve.project.current;
    if (!t) return [];
    return list.map((info) => t._place(info)).filter(Boolean);
  }
}

class Project {
  constructor(resolve) {
    this.pool = new MediaPool(resolve);
    this.timelines = [];
    this.current = null;
  }

  GetName() {
    return 'Test Project';
  }

  GetMediaPool() {
    return this.pool;
  }

  GetCurrentTimeline() {
    return this.current;
  }

  SetCurrentTimeline(t) {
    this.current = t;
    return true;
  }

  GetTimelineCount() {
    return this.timelines.length;
  }

  GetTimelineByIndex(i) {
    return this.timelines[i - 1];
  }
}

/** media: { [path]: { fps, frames, audio, still } } */
function createFakeResolve({ media = {}, async = false, newTimelineOptions = {} } = {}) {
  const resolve = {
    media,
    importCalls: [],
    newTimelineOptions,
    pages: [],
    GetProductName: () => 'DaVinci Resolve Studio',
    GetVersionString: () => '21.1.0.14',
    OpenPage: (p) => {
      resolve.pages.push(p);
      return true;
    },
    GetProjectManager: () => ({ GetCurrentProject: () => resolve.project }),
  };
  resolve.project = new Project(resolve);
  return async ? promisify(resolve) : resolve;
}

/** Wraps an API object so every method returns a Promise and every returned object is wrapped too. */
function promisify(target, cache = new WeakMap()) {
  if (target === null || typeof target !== 'object') return target;
  if (cache.has(target)) return cache.get(target);
  const proxy = new Proxy(target, {
    get(obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function' || !/^[A-Z]/.test(String(prop))) return value;
      return (...args) => Promise.resolve().then(() => {
        const unwrapped = args.map((a) => unwrap(a));
        const result = value.apply(obj, unwrapped);
        if (Array.isArray(result)) return result.map((r) => promisify(r, cache));
        return promisify(result, cache);
      });
    },
  });
  cache.set(target, proxy);
  RAW.set(proxy, target);
  return proxy;
}

const RAW = new WeakMap();
function unwrap(v) {
  if (v && typeof v === 'object') {
    if (RAW.has(v)) return RAW.get(v);
    if (Array.isArray(v)) return v.map(unwrap);
    if (Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = unwrap(val);
      return out;
    }
  }
  return v;
}

module.exports = { createFakeResolve, Timeline, parseRate };
