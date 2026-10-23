'use strict';

// Copies the "Cloud Pool" bridge script into DaVinci Resolve's per-user Scripts folder so it
// shows up under Workspace ▸ Scripts (this is how the free edition talks to the app).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveScriptsDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts');
  return path.join(home, '.local', 'share', 'DaVinciResolve', 'Fusion', 'Scripts');
}

/**
 * @returns {{ installed: boolean, path: string, reason?: string, updated?: boolean }}
 */
function installLuaBridge(sourceFile, { force = false } = {}) {
  const scripts = resolveScriptsDir();
  const target = path.join(scripts, 'Utility', 'Cloud Pool.lua');
  // The "Fusion" folder exists once Resolve has been started on this account.
  if (!force && !fs.existsSync(path.dirname(scripts))) return { installed: false, path: target, reason: 'resolve-not-found' };
  const content = fs.readFileSync(sourceFile);
  try {
    if (fs.existsSync(target) && fs.readFileSync(target).equals(content)) return { installed: true, path: target, updated: false };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return { installed: true, path: target, updated: true };
  } catch (err) {
    return { installed: false, path: target, reason: err.message };
  }
}

/**
 * Windows: Lua's io/os functions use the ANSI code page, so a path containing characters outside
 * it (e.g. a Cyrillic user name on an English system) cannot be passed through. The 8.3 short
 * form of an existing path is plain ASCII.
 */
function shortPath(p) {
  if (process.platform !== 'win32' || /^[\x20-\x7e]*$/.test(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true }).trim();
    return out && fs.existsSync(out) ? out : p;
  } catch {
    return p;
  }
}

module.exports = { installLuaBridge, resolveScriptsDir, shortPath };
