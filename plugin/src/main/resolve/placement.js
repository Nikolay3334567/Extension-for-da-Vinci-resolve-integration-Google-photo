'use strict';

// Import + timeline placement against Resolve's scripting objects. Every call is awaited, so the
// same code works with the synchronous API (Resolve ≤ 20.0) and the promise API (20.1+).
//
// Behaviour of the API that this code relies on (verified by the community on Resolve 19–21):
//  • AppendToTimeline clipInfo endFrame is EXCLUSIVE: duration = endFrame - startFrame.
//  • A clipInfo whose record range overlaps an existing item on the same track is silently
//    dropped, so "place at playhead" first looks for a free track (adding one if needed).
//  • recordFrame is an absolute frame number (it includes the timeline start offset).
//  • CreateTimelineFromClips fails unless the current Media Pool folder holds the clips, so new
//    timelines are created empty and filled with AppendToTimeline.

const path = require('path');
const { parseRate, tcToFrames, framesToTc, isDropFrameTc } = require('./timecode');

const STILL_SECONDS = 5;

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((k) => value[k]);
  return [];
}

function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.normalize(String(a));
  const nb = path.normalize(String(b));
  return process.platform === 'win32' || process.platform === 'darwin' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

async function safe(fn, fallback = null) {
  try {
    const v = await fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

class PlacementError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlacementError';
    this.code = code;
  }
}

async function currentProject(resolve) {
  const pm = await resolve.GetProjectManager();
  const project = pm && (await pm.GetCurrentProject());
  if (!project) throw new PlacementError('Open a project in DaVinci Resolve first', 'NO_PROJECT');
  return project;
}

async function findOrCreateBin(mediaPool, name) {
  const root = await mediaPool.GetRootFolder();
  if (!name) return root;
  for (const folder of toArray(await root.GetSubFolderList())) {
    if ((await safe(() => folder.GetName())) === name) return folder;
  }
  const created = await mediaPool.AddSubFolder(root, name);
  if (!created) throw new PlacementError(`Could not create the "${name}" bin`, 'BIN');
  return created;
}

/** Imports files into `bin` (reusing clips already imported from the same path). */
async function importClips(mediaPool, bin, clips) {
  const existing = [];
  for (const item of toArray(await bin.GetClipList())) {
    existing.push({ item, path: await safe(() => item.GetClipProperty('File Path'), '') });
  }
  const results = new Array(clips.length).fill(null);
  const missing = [];
  clips.forEach((clip, i) => {
    const hit = existing.find((e) => samePath(e.path, clip.path));
    if (hit) results[i] = { item: hit.item, reused: true };
    else missing.push(i);
  });
  if (missing.length) {
    const previous = await safe(() => mediaPool.GetCurrentFolder());
    await mediaPool.SetCurrentFolder(bin);
    let imported = [];
    try {
      imported = toArray(await mediaPool.ImportMedia(missing.map((i) => clips[i].path)));
    } finally {
      if (previous) await safe(() => mediaPool.SetCurrentFolder(previous));
    }
    const fresh = [];
    for (const item of imported) fresh.push({ item, path: await safe(() => item.GetClipProperty('File Path'), '') });
    for (const i of missing) {
      const match = fresh.find((f) => samePath(f.path, clips[i].path)) || (missing.length === 1 && fresh.length === 1 ? fresh[0] : null);
      if (!match) continue;
      results[i] = { item: match.item, reused: false };
      const meta = clips[i];
      if (meta.comment) await safe(() => match.item.SetMetadata('Comments', meta.comment));
      if (meta.keywords) await safe(() => match.item.SetMetadata('Keywords', meta.keywords));
      if (meta.key) await safe(() => match.item.SetThirdPartyMetadata('Cloud Pool Source', meta.key));
    }
  }
  results.forEach((r, i) => {
    if (!r) throw new PlacementError(`DaVinci Resolve could not import "${clips[i].name || path.basename(clips[i].path)}"`, 'IMPORT');
  });
  return results;
}

/** Reads the source frame rate, length and audio presence of a MediaPoolItem. */
async function clipInfoOf(item, clip) {
  const props = (await safe(() => item.GetClipProperty())) || {};
  const fps = parseRate(props.FPS || (await safe(() => item.GetClipProperty('FPS'))) || clip.fps || 30);
  const frames = Number(props.Frames || (await safe(() => item.GetClipProperty('Frames')))) || 0;
  const type = String(props.Type || '');
  const still = clip.kind === 'photo' || /still/i.test(type);
  const audioCh = Number(props['Audio Ch'] || 0);
  const hasAudio = !still && (audioCh > 0 || (!!props['Audio Codec'] && props['Audio Codec'] !== ''));
  return { fps, frames, still, hasAudio };
}

/** Source range (half-open) for a clip with optional in/out marks in seconds. */
function sourceRange(info, clip) {
  if (info.still) return null;
  let start = clip.inSec != null ? Math.floor(clip.inSec * info.fps + 1e-6) : 0;
  let end = clip.outSec != null ? Math.ceil(clip.outSec * info.fps - 1e-6) : info.frames;
  if (info.frames) {
    start = Math.min(Math.max(0, start), Math.max(0, info.frames - 1));
    end = Math.min(Math.max(start + 1, end), info.frames);
  } else {
    end = Math.max(start + 1, end);
  }
  return { start, end };
}

function timelineFrames(info, range, tlFps) {
  if (info.still || !range) return Math.round(STILL_SECONDS * tlFps);
  return Math.max(1, Math.round(((range.end - range.start) / info.fps) * tlFps));
}

function overlaps(items, start, end) {
  return items.some((it) => it.start < end && it.end > start);
}

async function trackItems(timeline, type, index) {
  const out = [];
  for (const it of toArray(await safe(() => timeline.GetItemListInTrack(type, index), []))) {
    const start = Number(await safe(() => it.GetStart(), 0));
    const end = Number(await safe(() => it.GetEnd(), 0));
    out.push({ start, end });
  }
  return out;
}

async function addTrack(timeline, type) {
  if (type === 'audio') {
    if (await safe(() => timeline.AddTrack('audio', { audioType: 'stereo' }), false)) return true;
    if (await safe(() => timeline.AddTrack('audio', 'stereo'), false)) return true;
  }
  return !!(await safe(() => timeline.AddTrack(type), false));
}

async function ensureAudioTracks(timeline, count) {
  let a = Number(await safe(() => timeline.GetTrackCount('audio'), 0));
  while (a < count) {
    if (!(await addTrack(timeline, 'audio'))) return;
    a = Number(await timeline.GetTrackCount('audio'));
  }
}

/** First track index whose video (and audio, if needed) lanes are free in [start, end). */
async function findFreeTrack(timeline, start, end, needAudio) {
  const vCount = Number(await safe(() => timeline.GetTrackCount('video'), 1)) || 1;
  const aCount = Number(await safe(() => timeline.GetTrackCount('audio'), 0)) || 0;
  for (let t = 1; t <= vCount; t++) {
    if (await safe(() => timeline.GetIsTrackLocked('video', t), false)) continue;
    if (overlaps(await trackItems(timeline, 'video', t), start, end)) continue;
    if (needAudio) {
      if (t <= aCount) {
        if (await safe(() => timeline.GetIsTrackLocked('audio', t), false)) continue;
        if (overlaps(await trackItems(timeline, 'audio', t), start, end)) continue;
      } else {
        await ensureAudioTracks(timeline, t);
      }
    }
    return t;
  }
  // Nothing free: add a fresh video track (and enough audio tracks for its audio).
  if (!(await addTrack(timeline, 'video'))) throw new PlacementError('Could not add a video track', 'TRACK');
  const t = Number(await timeline.GetTrackCount('video'));
  if (needAudio) await ensureAudioTracks(timeline, t);
  return t;
}

function clipInfoFor(item, range, extra = {}) {
  const info = { mediaPoolItem: item, ...extra };
  if (range) {
    info.startFrame = range.start;
    info.endFrame = range.end;
  }
  return info;
}

function uniqueTimelineName(existing, base) {
  if (!existing.includes(base)) return base;
  for (let i = 2; i < 1000; i++) if (!existing.includes(`${base} (${i})`)) return `${base} (${i})`;
  return `${base} ${Date.now()}`;
}

async function timelineNames(project) {
  const n = Number(await safe(() => project.GetTimelineCount(), 0));
  const names = [];
  for (let i = 1; i <= n; i++) names.push(await safe(async () => (await project.GetTimelineByIndex(i)).GetName(), ''));
  return names;
}

function defaultTimelineName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Cloud Pool ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}`;
}

/**
 * Imports `clips` into `binName` and optionally places them.
 * action: 'import' | 'append' | 'playhead' | 'newTimeline'
 * clips:  [{ path, name, key, kind, fps, inSec, outSec, comment }]
 */
async function importAndPlace(resolve, { action = 'append', clips = [], binName = 'Google Photos', switchToEdit = false } = {}) {
  if (!clips.length) return { imported: 0, reused: 0, placed: 0 };
  const project = await currentProject(resolve);
  const mediaPool = await project.GetMediaPool();
  const bin = await findOrCreateBin(mediaPool, binName);
  const items = await importClips(mediaPool, bin, clips);
  const summary = {
    imported: items.filter((r) => !r.reused).length,
    reused: items.filter((r) => r.reused).length,
    placed: 0,
    timeline: null,
    createdTimeline: false,
  };
  if (action === 'import') return summary;

  let timeline = await safe(() => project.GetCurrentTimeline());
  if (!timeline || action === 'newTimeline') {
    const name = uniqueTimelineName(await timelineNames(project), defaultTimelineName());
    timeline = await mediaPool.CreateEmptyTimeline(name);
    if (!timeline) throw new PlacementError('Could not create a timeline', 'TIMELINE');
    await safe(() => project.SetCurrentTimeline(timeline));
    summary.createdTimeline = true;
  }
  summary.timeline = await safe(() => timeline.GetName(), '');

  const infos = [];
  for (let i = 0; i < clips.length; i++) infos.push(await clipInfoOf(items[i].item, clips[i]));

  if (action === 'playhead' && !summary.createdTimeline) {
    const tlFps = parseRate(await safe(() => timeline.GetSetting('timelineFrameRate'), 24));
    const startFrame = Number(await safe(() => timeline.GetStartFrame(), 0));
    const startTc = await safe(() => timeline.GetStartTimecode(), '00:00:00:00');
    const currentTc = await safe(() => timeline.GetCurrentTimecode(), startTc);
    const dropFrame = isDropFrameTc(currentTc) || isDropFrameTc(startTc);
    let cursor = startFrame + (tcToFrames(currentTc, tlFps) - tcToFrames(startTc, tlFps));
    for (let i = 0; i < clips.length; i++) {
      const range = sourceRange(infos[i], clips[i]);
      const length = timelineFrames(infos[i], range, tlFps);
      const track = await findFreeTrack(timeline, cursor, cursor + length, infos[i].hasAudio);
      const stillRange = infos[i].still ? { start: 0, end: length } : range;
      const placed = toArray(await mediaPool.AppendToTimeline([clipInfoFor(items[i].item, stillRange, { recordFrame: cursor, trackIndex: track })]));
      if (!placed.length) throw new PlacementError(`Resolve refused to place "${clips[i].name}" (is the track locked?)`, 'PLACE');
      summary.placed++;
      const end = Number(await safe(() => placed[0].GetEnd(), cursor + length));
      cursor = end > cursor ? end : cursor + length;
    }
    // Leave the playhead after the last clip so the next insert continues the sequence.
    await safe(() => timeline.SetCurrentTimecode(framesToTc(tcToFrames(startTc, tlFps) + (cursor - startFrame), tlFps, dropFrame)));
  } else {
    for (let i = 0; i < clips.length; i++) {
      const range = sourceRange(infos[i], clips[i]);
      const info = range && (clips[i].inSec != null || clips[i].outSec != null) ? clipInfoFor(items[i].item, range) : items[i].item;
      const placed = toArray(await mediaPool.AppendToTimeline([info]));
      if (!placed.length) throw new PlacementError(`Resolve refused to append "${clips[i].name}" (is the track locked?)`, 'PLACE');
      summary.placed++;
    }
  }
  if (switchToEdit) await safe(() => resolve.OpenPage('edit'));
  return summary;
}

module.exports = { importAndPlace, PlacementError, toArray, sourceRange, timelineFrames, defaultTimelineName, STILL_SECONDS };
