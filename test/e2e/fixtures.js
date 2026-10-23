'use strict';

// Realistic-looking demo library for the end-to-end test (and screenshots): videos and photos
// spread over several days, a portrait clip, a still-processing upload, Drive folders.

const path = require('path');
const { video, image, md5 } = require('../support/fixtures');
const { execFileSync } = require('child_process');
const fs = require('fs');
const { DIR } = require('../support/fixtures');

function iso(daysAgo, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function lavfiVideo(name, source, { width = 640, height = 360, seconds = 5, fps = 30 } = {}) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true });
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `${source}${source.includes('=') ? ':' : '='}size=${width}x${height}:rate=${fps}`,
      '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(fps),
      '-c:a', 'aac', '-shortest', file,
    ]);
  }
  return { file, width, height, fps, seconds };
}

function frame(from, name, width = 512) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', '1', '-i', from, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', file]);
  }
  return file;
}

function buildLibrary() {
  const sources = [
    ['mandelbrot', 'mandelbrot'],
    ['gradients', 'gradients=speed=0.02:c0=0x1e3c72:c1=0xf7b733:c2=0xfc4a1a:c3=0x2a5298:n=4'],
    ['sunset', 'gradients=speed=0.03:c0=0xff7e5f:c1=0xfeb47b:c2=0x6a3093:n=3'],
    ['ocean', 'gradients=speed=0.02:c0=0x2193b0:c1=0x6dd5ed:c2=0x0f2027:n=3'],
    ['bars', 'smptehdbars'],
    ['test', 'testsrc2'],
    ['forest', 'gradients=speed=0.02:c0=0x134e5e:c1=0x71b280:c2=0xdce35b:n=3'],
    ['life', 'life=mold=10:ratio=0.3:death_color=#1b1f3a:life_color=#57c1eb'],
  ];
  const videos = [];
  sources.forEach(([name, src], i) => {
    const portrait = i === 2;
    videos.push({ name, ...lavfiVideo(`e2e-${name}.mp4`, src, { width: portrait ? 360 : 640, height: portrait ? 640 : 360, seconds: 4 + (i % 3) * 3 }) });
  });
  const thumbs = videos.map((v) => frame(v.file, `e2e-${v.name}-thumb.jpg`));
  const stills = videos.map((v) => image(`e2e-${v.name}-photo.jpg`, { width: 1600, height: 1067, from: v.file }));

  const photos = [];
  const dates = [[0, 18, 42], [0, 11, 5], [1, 20, 10], [1, 9, 30], [3, 14, 0], [12, 17, 45], [40, 12, 0], [300, 10, 30]];
  videos.forEach((v, i) => {
    const [d, h, m] = dates[i];
    photos.push({
      id: `pv-${v.name}`,
      filename: `PXL_${20261000 + i}_${v.name}.mp4`,
      mimeType: 'video/mp4',
      type: 'VIDEO',
      createTime: iso(d, h, m),
      width: v.width,
      height: v.height,
      fps: 30,
      cameraMake: 'Google',
      cameraModel: 'Pixel 9 Pro',
      file: v.file,
      thumb: thumbs[i],
      processing: i === 7 ? 'PROCESSING' : 'READY',
    });
    photos.push({
      id: `pp-${v.name}`,
      filename: `IMG_${4100 + i}.JPG`,
      mimeType: 'image/jpeg',
      type: 'PHOTO',
      createTime: iso(d, h, m + 3),
      width: 1600,
      height: 1067,
      cameraMake: 'Apple',
      cameraModel: 'iPhone 16',
      file: stills[i].file,
      thumb: stills[i].file,
    });
  });

  const drive = [
    { id: 'f-trip', name: 'Отпуск 2026', mimeType: 'application/vnd.google-apps.folder', createdTime: iso(5, 10) },
    { id: 'f-raw', name: 'Drone footage', mimeType: 'application/vnd.google-apps.folder', createdTime: iso(9, 10) },
  ];
  videos.slice(0, 6).forEach((v, i) => {
    drive.push({
      id: `dv-${v.name}`,
      name: `${['DJI_0042', 'GX010123', 'C0007', 'A001_C012', 'MVI_2201', 'DSCF0099'][i]}.MP4`,
      mimeType: 'video/mp4',
      createdTime: iso(i * 2, 9 + i),
      parents: [i < 3 ? 'f-trip' : 'root'],
      file: v.file,
      thumb: thumbs[i],
      width: v.width,
      height: v.height,
      durationMillis: v.seconds * 1000,
      md5: md5(v.file),
      shared: i === 5,
    });
  });
  stills.slice(0, 4).forEach((s, i) => {
    drive.push({ id: `dp-${i}`, name: `photo_${i + 1}.jpg`, mimeType: 'image/jpeg', createdTime: iso(i + 1, 15), parents: ['root'], file: s.file, thumb: s.file, width: 1600, height: 1067 });
  });
  return { photos, drive };
}

module.exports = { buildLibrary, video };
