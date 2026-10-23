// Line icons (24×24, stroke = currentColor). Drawn for Cloud Pool.

const P = {
  cloud: '<path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.6 10.1 4 4 0 0 0 7 18z"/>',
  cloudDown: '<path d="M7 18h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.6 10.1 4 4 0 0 0 7 18z"/><path d="M12 11v6m-2.5-2.5L12 17l2.5-2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.5 9.4"/>',
  alert: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5m0 2.8v.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  play: '<path d="M7.5 5.5v13l11-6.5-11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
  film: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 4.5v15m9-15v15M3.5 9h4m-4 6h4m9-6h4m-4 6h4"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17.5 4.8-4.8 3.7 3.7 2.6-2.6 4.9 4.6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4m0 13.6v2.4M4.9 4.9l1.7 1.7m10.8 10.8 1.7 1.7M2.8 12h2.4m13.6 0h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.7 4-5.5 7.5-5.5s6.3 1.8 7.5 5.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5z"/>',
  drive: '<path d="m8.5 4h7l6 10.5-3.5 6h-11l-3.5-6L8.5 4z"/><path d="m8.5 4 6.5 11.5M15.5 4 9 15.5m-6.5-1h19"/>',
  photos: '<path d="M12 12V3.5a4.25 4.25 0 0 1 0 8.5zm0 0h8.5a4.25 4.25 0 0 1-8.5 0zm0 0v8.5a4.25 4.25 0 0 1 0-8.5zm0 0H3.5a4.25 4.25 0 0 1 8.5 0z"/>',
  computer: '<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M8.5 20h7M12 16.5V20"/>',
  shared: '<circle cx="9" cy="9" r="3.2"/><path d="M3 19c.8-3.2 3.2-4.8 6-4.8s5.2 1.6 6 4.8"/><circle cx="17" cy="8" r="2.5"/><path d="M16.5 13.2c2.3.2 3.9 1.6 4.5 4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  timeline: '<path d="M3 7.5h10m-10 4.5h14M3 16.5h8"/><path d="M19 6v12" stroke-width="2.2"/>',
  playhead: '<path d="M12 3v18"/><path d="M8.5 3h7l-3.5 4-3.5-4z" fill="currentColor"/><path d="M3 12h5m8 0h5"/>',
  bin: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5z"/><path d="M12 11v5m-2.5-2.5h5"/>',
  download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/>',
  pin: '<path d="M9 3.5h6l-1 5.5 3.5 3.5h-11L10 9 9 3.5zM12 12.5V20.5"/>',
  logout: '<path d="M14.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 4v16A1.5 1.5 0 0 0 5 21.5h8a1.5 1.5 0 0 0 1.5-1.5v-1.5"/><path d="M10 12h11m-3.5-3.5L21 12l-3.5 3.5"/>',
  external: '<path d="M13.5 4.5h6v6m0-6-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  trash: '<path d="M4.5 6.5h15m-10-3h5m-7.5 3 .8 12.2a1.5 1.5 0 0 0 1.5 1.3h5.4a1.5 1.5 0 0 0 1.5-1.3l.8-12.2"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.6"/><circle cx="6.5" cy="17" r="2.6"/><path d="m8.6 8.6 11 9m-11-2.2 11-9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10.5v6m0-9.3v.3"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  fit: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><rect x="7" y="8.5" width="10" height="7" rx="1"/>',
  fill: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M3.5 12h17M12 5.5v13"/>',
  volume: '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6m2.5-8.5a7.6 7.6 0 0 1 0 11"/>',
  mute: '<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  markIn: '<path d="M7 4v16M7 4h6M7 20h6"/><path d="m13 12 5-4v8z" fill="currentColor"/>',
  markOut: '<path d="M17 4v16m0-16h-6m6 16h-6"/><path d="m11 12-5-4v8z" fill="currentColor"/>',
  stepBack: '<path d="M7 5.5v13M18 6l-8.5 6 8.5 6z"/>',
  stepFwd: '<path d="M17 5.5v13M6 6l8.5 6L6 18z"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.8"/><path d="M15.5 8.5V5.8A1.8 1.8 0 0 0 13.7 4H5.8A1.8 1.8 0 0 0 4 5.8v7.9a1.8 1.8 0 0 0 1.8 1.8h2.7"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
  google: '<path d="M20.6 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h4.8a4.2 4.2 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" fill="#4285F4" stroke="none"/><path d="M12 21c2.4 0 4.5-.8 5.9-2.2l-2.9-2.2c-.8.5-1.8.9-3 .9-2.3 0-4.3-1.6-5-3.7H4v2.3A9 9 0 0 0 12 21z" fill="#34A853" stroke="none"/><path d="M7 13.8a5.4 5.4 0 0 1 0-3.6V7.9H4a9 9 0 0 0 0 8.2l3-2.3z" fill="#FBBC05" stroke="none"/><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 4 7.9l3 2.3c.7-2.1 2.7-3.6 5-3.6z" fill="#EA4335" stroke="none"/>',
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

export function iconEl(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'icon-wrap';
  span.innerHTML = icon(name, cls);
  return span.firstElementChild;
}
