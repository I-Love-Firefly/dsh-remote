import { timingSafeEqual } from 'node:crypto';
export const MAX_FRAME = 1024 * 1024;
export const MAX_BUFFER = 8 * 1024 * 1024;
export const MAX_BODY = 32 * 1024 * 1024;
export const validDevice = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(x);
export function equal(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function safePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path)) throw new Error('Invalid target path');
  return path;
}
const hop = new Set(['connection', 'upgrade', 'host', 'cookie', 'authorization', 'proxy-authorization', 'transfer-encoding', 'content-length', 'accept-encoding', 'origin', 'referer', 'forwarded', 'set-cookie']);
export function cleanHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !hop.has(k.toLowerCase()) && !k.toLowerCase().startsWith('x-forwarded-') && !k.toLowerCase().startsWith('sec-websocket-')));
}
export function send(ws, frame) {
  if (ws.readyState !== 1) throw new Error('Tunnel disconnected');
  if (ws.bufferedAmount > MAX_BUFFER) { ws.close(1013, 'Backpressure limit'); throw new Error('Tunnel overloaded'); }
  ws.send(JSON.stringify(frame));
}
export const encode = data => Buffer.from(data).toString('base64');
export const decode = data => Buffer.from(data, 'base64');
