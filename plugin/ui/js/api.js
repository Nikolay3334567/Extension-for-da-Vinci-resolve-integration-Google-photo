// Thin wrapper over the preload bridge: turns { ok, value | message, code } into promises.

const bridge = window.cloudpool;

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code || null;
    this.status = status || null;
  }
}

export async function call(channel, payload) {
  const res = await bridge.invoke(channel, payload);
  if (res && res.ok) return res.value;
  throw new ApiError((res && res.message) || 'Request failed', res && res.code, res && res.status);
}

export function onEvent(handler) {
  return bridge.onEvent(handler);
}

export function startDrag(keys) {
  bridge.startDrag(keys);
}
