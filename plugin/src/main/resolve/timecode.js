'use strict';

// SMPTE timecode <-> frame count, including 29.97/59.94 drop-frame.

function parseRate(value) {
  const fps = parseFloat(String(value || '').replace(',', '.'));
  return Number.isFinite(fps) && fps > 0 ? fps : 24;
}

function nominal(fps) {
  return Math.round(fps);
}

function dropFramesPerMinute(fps) {
  // 2 frames for 29.97, 4 for 59.94.
  return Math.round(fps * 0.066666);
}

function isDropFrameTc(tc) {
  return /[;,]\d+$/.test(String(tc || '').trim());
}

/** "01:00:05:12" / "01:00:05;12" -> absolute frame number. */
function tcToFrames(tc, fpsValue) {
  const fps = parseRate(fpsValue);
  const m = /^(\d{1,3}):(\d{2}):(\d{2})[:;.,](\d{2,3})$/.exec(String(tc || '').trim());
  if (!m) throw new Error(`Bad timecode: ${tc}`);
  const [hh, mm, ss, ff] = m.slice(1).map(Number);
  const base = nominal(fps);
  let frames = (hh * 3600 + mm * 60 + ss) * base + ff;
  if (isDropFrameTc(tc) && Math.abs(fps - base) > 0.001) {
    const totalMinutes = hh * 60 + mm;
    frames -= dropFramesPerMinute(fps) * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function framesToTc(totalFrames, fpsValue, dropFrame = false) {
  const fps = parseRate(fpsValue);
  const base = nominal(fps);
  let frames = Math.max(0, Math.round(totalFrames));
  const df = dropFrame && Math.abs(fps - base) > 0.001;
  if (df) {
    const drop = dropFramesPerMinute(fps);
    const per10 = Math.round(fps * 600);
    const perMin = base * 60 - drop;
    const tens = Math.floor(frames / per10);
    const rem = frames % per10;
    frames += drop * 9 * tens + (rem > drop ? drop * Math.floor((rem - drop) / perMin) : 0);
  }
  const ff = frames % base;
  const totalSeconds = Math.floor(frames / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${df ? ';' : ':'}${pad(ff, base > 99 ? 3 : 2)}`;
}

module.exports = { parseRate, tcToFrames, framesToTc, isDropFrameTc };
