'use strict';

const fs = require('fs');
const path = require('path');

/** Small rotating file logger (keeps the last two 2 MB files) that also mirrors to the console. */
function createLogger(dir) {
  let stream = null;
  const file = path.join(dir, 'cloudpool.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, path.join(dir, 'cloudpool.1.log'));
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
  const write = (level, args) => {
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`;
    if (stream) stream.write(line);
    if (level === 'error') console.error(text);
    else if (level === 'warn') console.warn(text);
    else if (process.env.CLOUDPOOL_DEBUG) console.log(text);
  };
  return {
    file,
    dir,
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    debug: (...a) => process.env.CLOUDPOOL_DEBUG && write('debug', a),
    close: () => stream && stream.end(),
  };
}

module.exports = { createLogger };
