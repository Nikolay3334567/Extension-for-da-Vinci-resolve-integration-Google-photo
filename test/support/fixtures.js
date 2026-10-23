'use strict';

// Generates (and caches) small media files for tests. Real H.264/AAC files are created with
// ffmpeg when it is available so the MP4 probe and the Electron player can be exercised.

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'cloudpool-test-fixtures-v3');

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

function randomFile(name, bytes) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  if (!fs.existsSync(file) || fs.statSync(file).size !== bytes) {
    const buf = crypto.randomBytes(bytes);
    fs.writeFileSync(file, buf);
  }
  return file;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Videos: { file, width, height, fps, seconds }. `faststart` puts the moov box first.
 */
function video(name, { width = 640, height = 360, fps = 30, seconds = 4, hue = 0, faststart = false } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}`,
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
      '-t', String(seconds),
      '-vf', `hue=h=${hue}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(fps),
      '-c:a', 'aac', '-shortest',
      ...(faststart ? ['-movflags', '+faststart'] : []),
      file,
    ]);
  }
  return { file, width, height, fps, seconds };
}

function image(name, { width = 1200, height = 800, hue = 0, from = null } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    if (from) ffmpeg(['-ss', '1', '-i', from, '-frames:v', '1', '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,hue=h=${hue}`, '-q:v', '4', file]);
    else ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=1`, '-frames:v', '1', '-vf', `hue=h=${hue}`, '-q:v', '3', file]);
  }
  return { file, width, height };
}

module.exports = { DIR, hasFfmpeg, randomFile, md5, video, image };
