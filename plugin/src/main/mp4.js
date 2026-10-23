'use strict';

// Reads duration, frame rate, resolution and codecs from an MP4/QuickTime file using only a few
// small reads (works over HTTP Range requests, so cloud videos can be inspected without
// downloading them). Google Photos does not report video durations, this fills the gap.

const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 240];

function snapRate(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  // 59.94 and 60 differ by only 0.1 %, so snap to the closest standard rate and only when
  // the measured average is (almost) exact; variable-frame-rate phone clips keep their average.
  let best = null;
  let bestErr = Infinity;
  for (const r of COMMON_RATES) {
    const err = Math.abs(fps - r) / r;
    if (err < bestErr) {
      best = r;
      bestErr = err;
    }
  }
  return bestErr < 0.0004 ? best : Math.round(fps * 1000) / 1000;
}

function readBoxes(buf, start = 0, end = buf.length) {
  const boxes = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    boxes.push({ type, start: off + header, end: off + size });
    off += size;
  }
  return boxes;
}

function child(buf, box, type) {
  return readBoxes(buf, box.start, box.end).find((b) => b.type === type) || null;
}

function parseMvhd(buf, box) {
  const version = buf[box.start];
  if (version === 1) return { timescale: buf.readUInt32BE(box.start + 20), duration: Number(buf.readBigUInt64BE(box.start + 24)) };
  return { timescale: buf.readUInt32BE(box.start + 12), duration: buf.readUInt32BE(box.start + 16) };
}

function parseTrak(buf, trak) {
  const mdia = child(buf, trak, 'mdia');
  if (!mdia) return null;
  const hdlr = child(buf, mdia, 'hdlr');
  const mdhd = child(buf, mdia, 'mdhd');
  if (!hdlr || !mdhd) return null;
  const handler = buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
  const { timescale, duration } = parseMvhd(buf, mdhd);
  const out = { handler, timescale, duration };
  const stbl = child(buf, child(buf, mdia, 'minf') || { start: 0, end: 0 }, 'stbl');
  if (stbl) {
    const stsd = child(buf, stbl, 'stsd');
    if (stsd && stsd.end - stsd.start >= 16) {
      const entry = stsd.start + 8;
      out.codec = buf.toString('latin1', entry + 4, entry + 8);
      if (handler === 'vide' && entry + 36 <= stsd.end) {
        out.width = buf.readUInt16BE(entry + 32);
        out.height = buf.readUInt16BE(entry + 34);
      }
      if (handler === 'soun' && entry + 36 <= stsd.end) {
        out.channels = buf.readUInt16BE(entry + 24);
        out.sampleRate = buf.readUInt32BE(entry + 32) >>> 16;
      }
    }
    const stts = child(buf, stbl, 'stts');
    if (stts) {
      const count = buf.readUInt32BE(stts.start + 4);
      let samples = 0;
      let ticks = 0;
      for (let i = 0; i < count && stts.start + 8 + i * 8 + 8 <= stts.end; i++) {
        const n = buf.readUInt32BE(stts.start + 8 + i * 8);
        const d = buf.readUInt32BE(stts.start + 12 + i * 8);
        samples += n;
        ticks += n * d;
      }
      out.samples = samples;
      out.sampleTicks = ticks;
    }
  }
  const tkhd = child(buf, trak, 'tkhd');
  if (tkhd && handler === 'vide') {
    const v = buf[tkhd.start];
    const wOff = tkhd.start + (v === 1 ? 88 : 76);
    if (wOff + 8 <= tkhd.end) {
      const w = buf.readUInt32BE(wOff) / 65536;
      const h = buf.readUInt32BE(wOff + 4) / 65536;
      if (w && h) {
        out.displayWidth = Math.round(w);
        out.displayHeight = Math.round(h);
      }
      // Rotation matrix: a phone video recorded upright has a 90° matrix.
      const a = buf.readInt32BE(tkhd.start + (v === 1 ? 52 : 40));
      const b = buf.readInt32BE(tkhd.start + (v === 1 ? 56 : 44));
      if (a === 0 && b !== 0) out.rotation = b > 0 ? 90 : 270;
      else if (a < 0) out.rotation = 180;
    }
  }
  return out;
}

/** Parses an in-memory `moov` box payload. */
function parseMoov(moovBuf) {
  const moov = { start: 0, end: moovBuf.length };
  const mvhdBox = child(moovBuf, moov, 'mvhd');
  const result = { durationSec: null, video: null, audio: null };
  if (mvhdBox) {
    const { timescale, duration } = parseMvhd(moovBuf, mvhdBox);
    if (timescale) result.durationSec = duration / timescale;
  }
  for (const trak of readBoxes(moovBuf, 0, moovBuf.length).filter((b) => b.type === 'trak')) {
    const t = parseTrak(moovBuf, trak);
    if (!t) continue;
    if (t.handler === 'vide' && !result.video) {
      const seconds = t.timescale ? t.duration / t.timescale : 0;
      const fps = t.samples && t.sampleTicks && t.timescale ? (t.samples * t.timescale) / t.sampleTicks : null;
      const rotated = t.rotation === 90 || t.rotation === 270;
      const w = t.displayWidth || t.width || null;
      const h = t.displayHeight || t.height || null;
      result.video = {
        codec: t.codec || null,
        width: rotated ? h : w,
        height: rotated ? w : h,
        rotation: t.rotation || 0,
        fps: snapRate(fps),
        frames: t.samples || null,
        durationSec: seconds || null,
      };
      if (!result.durationSec && seconds) result.durationSec = seconds;
    } else if (t.handler === 'soun' && !result.audio) {
      result.audio = { codec: t.codec || null, channels: t.channels || null, sampleRate: t.sampleRate || null };
    }
  }
  return result;
}

/**
 * Locates and parses `moov` with random reads.
 * @param {(offset: number, length: number) => Promise<Buffer>} readAt
 * @param {number} fileSize
 */
async function probeMp4(readAt, fileSize, { maxMoovBytes = 64 * 1024 * 1024 } = {}) {
  let offset = 0;
  for (let i = 0; i < 64 && offset + 8 <= fileSize; i++) {
    const head = await readAt(offset, Math.min(16, fileSize - offset));
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < header) break;
    if (type === 'moov') {
      if (size - header > maxMoovBytes) throw new Error('moov box too large');
      return parseMoov(await readAt(offset + header, size - header));
    }
    offset += size;
  }
  throw new Error('No moov box found');
}

/** Wraps a reader so small header reads are served from one larger prefetch. */
function cachedReader(read, prefetch = 256 * 1024) {
  const blocks = [];
  return async (offset, length) => {
    for (const b of blocks) {
      if (offset >= b.offset && offset + length <= b.offset + b.buf.length) return b.buf.subarray(offset - b.offset, offset - b.offset + length);
    }
    const want = Math.max(length, length <= 16 ? prefetch : length);
    const buf = await read(offset, want);
    blocks.push({ offset, buf });
    return buf.subarray(0, Math.min(length, buf.length));
  };
}

module.exports = { probeMp4, parseMoov, cachedReader, snapRate };
