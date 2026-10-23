'use strict';

// Optional accelerator for long videos: when ffmpeg is installed, a clip with In/Out marks is
// cut straight from the cloud stream (stream copy, starting exactly on a keyframe) instead of
// downloading the whole file. ffmpeg reads through the local media server, which handles Google
// authorisation and seeks with Range requests, so only the needed part is transferred.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { abortError } = require('./util');

const EXE = process.platform === 'win32' ? '.exe' : '';

function candidates(configured) {
  const dirs = [];
  if (configured) dirs.push(fs.existsSync(configured) && fs.statSync(configured).isDirectory() ? configured : path.dirname(configured));
  dirs.push(...String(process.env.PATH || '').split(path.delimiter).filter(Boolean));
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin');
  if (process.platform === 'win32') {
    const env = process.env;
    dirs.push(
      'C:\\ffmpeg\\bin',
      path.join(env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
      path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
      path.join(env.ProgramFiles || 'C:\\Program Files', 'WinGet', 'Links'),
      path.join(os.homedir(), 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
    );
  }
  if (process.platform === 'linux') dirs.push('/usr/bin', '/usr/local/bin', '/snap/bin');
  return [...new Set(dirs)];
}

function run(cmd, args, { signal, onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let buf = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      out += d;
      if (onLine) {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      }
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve(out);
      else if (signal && signal.aborted) reject(abortError());
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`));
    });
  });
}

class FfmpegTools {
  constructor({ getConfiguredPath = () => '', logger = console } = {}) {
    this.getConfiguredPath = getConfiguredPath;
    this.logger = logger;
    this.found = undefined;
  }

  /** Finds ffmpeg + ffprobe once; returns { ffmpeg, ffprobe } or null. */
  async detect({ refresh = false } = {}) {
    if (this.found !== undefined && !refresh) return this.found;
    this.found = null;
    for (const dir of candidates(this.getConfiguredPath())) {
      const ffmpeg = path.join(dir, `ffmpeg${EXE}`);
      const ffprobe = path.join(dir, `ffprobe${EXE}`);
      if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) continue;
      try {
        const v = await run(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 8000 });
        this.found = { ffmpeg, ffprobe, version: (v.split('\n')[0] || '').replace(/^ffmpeg version\s*/i, '').split(' ')[0] };
        break;
      } catch {
        /* try the next location */
      }
    }
    return this.found;
  }

  /** Presentation time of the last keyframe at or before `time` (seconds). */
  async keyframeBefore(url, time, { signal } = {}) {
    const tools = await this.detect();
    if (!tools) return null;
    for (const window of [6, 20, 60]) {
      const from = Math.max(0, time - window);
      const out = await run(
        tools.ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', '-read_intervals', `${from.toFixed(3)}%${(time + 0.001).toFixed(3)}`, url],
        { signal, timeoutMs: 60000 },
      );
      const times = out
        .split(/\r?\n/)
        .map((l) => parseFloat(l))
        .filter((n) => Number.isFinite(n) && n <= time + 1e-3);
      if (times.length) return Math.max(...times);
      if (from === 0) return 0;
    }
    return 0;
  }

  /** Copies [start, start + duration) without re-encoding; start must be a keyframe time. */
  async extract({ url, start, duration, dest, onProgress, signal }) {
    const tools = await this.detect();
    if (!tools) throw new Error('ffmpeg not found');
    const tmp = dest.replace(/(\.[^.\\/]+)?$/, '.part$1'); // keeps the extension: ffmpeg picks the muxer by it
    const args = [
      '-hide_banner', '-nostdin', '-y',
      // The MP4 index has everything stream copy needs: keep probing (= extra cloud reads) small.
      '-probesize', '262144', '-analyzeduration', '1000000',
      '-ss', start.toFixed(6),
      '-i', url,
      '-t', duration.toFixed(6),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      // No -avoid_negative_ts: the muxer's edit list then absorbs the B-frame delay, so the
      // first (key)frame sits at t = 0 both by timestamp and by frame index.
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      tmp,
    ];
    try {
      await run(tools.ffmpeg, args, {
        signal,
        timeoutMs: 30 * 60 * 1000,
        onLine: (line) => {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
        },
      });
      fs.renameSync(tmp, dest);
      return dest;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

module.exports = { FfmpegTools };
