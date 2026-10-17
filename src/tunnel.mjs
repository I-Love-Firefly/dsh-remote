import WebSocket from 'ws';
import http from 'node:http';
import https from 'node:https';
import { MAX_FRAME, MAX_BODY, validDevice, safePath, cleanHeaders, send, encode, decode } from './protocol.mjs';

/** Only connects to the local Harness; relay messages cannot choose a host. */
export function startTunnel(options) {
  const { relayUrl, bridgeKey, deviceId, getLocalUrl, onStatus = () => {}, allowInsecureLocalTest = false } = options;
  if (!validDevice(deviceId) || typeof bridgeKey !== 'string' || bridgeKey.length < 32) throw new Error('Invalid device ID or bridge key');
  const remote = new URL(relayUrl);
  if (remote.protocol !== 'wss:' && !(allowInsecureLocalTest && remote.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(remote.hostname))) throw new Error('Relay must use WSS');
  remote.pathname = remote.pathname.replace(/\/$/, '') + '/bridge';
  remote.search = ''; remote.hash = '';
  let closed = false, socket, retry, attempt = 0;
  const active = new Map();
  const stopActive = () => { for (const value of active.values()) value.destroy?.(); active.clear(); };
  async function localAuth() {
    const url = new URL(await getLocalUrl());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('Harness target must be loopback HTTP(S)');
    const transport = url.protocol === 'https:' ? https : http;
    const cookie = await new Promise((resolve, reject) => {
      const req = transport.get(url, { headers: { 'accept-encoding': 'identity' }, timeout: 10000 }, res => {
        res.resume();
        if (![200, 302, 303, 307].includes(res.statusCode)) return reject(new Error('Harness authentication failed'));
        resolve((res.headers['set-cookie'] ?? []).map(x => x.split(';')[0]).join('; '));
      });
      req.on('timeout', () => req.destroy(new Error('Harness timeout'))); req.on('error', reject);
    });
    return { origin: url.origin, cookie, transport };
  }
  async function connect() {
    if (closed) return;
    let auth;
    try { auth = await localAuth(); } catch { onStatus('waiting-for-harness'); schedule(); return; }
    if (closed) return;
    const ws = socket = new WebSocket(remote, { headers: { Authorization: `Bearer ${bridgeKey}`, 'X-DSH-Device': deviceId }, maxPayload: MAX_FRAME, handshakeTimeout: 15000 });
    ws.on('open', () => { attempt = 0; onStatus('connected'); });
    ws.on('error', () => onStatus('connection-error'));
    ws.on('close', () => { stopActive(); onStatus('disconnected'); schedule(); });
    ws.on('message', raw => {
      try { dispatch(JSON.parse(raw), ws, auth); } catch { ws.close(1008, 'Invalid frame'); }
    });
  }
  function schedule() {
    if (!closed) { clearTimeout(retry); retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500); retry.unref?.(); }
  }
  function dispatch(f, ws, auth) {
    if (typeof f.id !== 'string') throw new Error('Missing request ID');
    if (f.t === 'cancel') { active.get(f.id)?.destroy?.(); active.delete(f.id); return; }
    if (f.t === 'ws-data') { const upstream = active.get(f.id); if (upstream?.readyState === 1) upstream.send(decode(f.data), { binary: !!f.binary }); return; }
    if (f.t === 'ws-close') { active.get(f.id)?.close?.(1000); active.delete(f.id); return; }
    if (f.t === 'http-body') { const req=active.get(f.id); if(!req) return; const chunk=decode(f.data); req.received=(req.received??0)+chunk.length; if(req.received>MAX_BODY)throw new Error('Upload too large'); req.write(chunk); return; }
    if (f.t === 'http-end') { active.get(f.id)?.end(); return; }
    if (!['http', 'ws-open'].includes(f.t) || active.has(f.id) || active.size >= 128) throw new Error('Invalid request');
    const path = safePath(f.path);
    const target = new URL(auth.origin); // assigning pathname avoids authority replacement
    const split = path.indexOf('?'); target.pathname = split < 0 ? path : path.slice(0, split); target.search = split < 0 ? '' : path.slice(split);
    const headers = { ...cleanHeaders(f.headers ?? {}), cookie: auth.cookie, origin: auth.origin, 'accept-encoding': 'identity' };
    if (f.t === 'ws-open') {
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      const upstream = new WebSocket(target, f.protocols?.length ? f.protocols : undefined, { headers, maxPayload: 512*1024, handshakeTimeout: 10000 });
      upstream.destroy = () => upstream.terminate(); active.set(f.id, upstream);
      upstream.on('open', () => send(ws, { t: 'ws-ready', id: f.id }));
      upstream.on('message', (data, binary) => { try { send(ws, {t:'ws-data', id:f.id, data:encode(data), binary}); } catch {upstream.terminate();} });
      upstream.on('close', () => { active.delete(f.id); try { send(ws, {t:'ws-close',id:f.id}); } catch {} });
      upstream.on('error', () => upstream.terminate()); return;
    }
    if (typeof f.method !== 'string') throw new Error('Invalid method');
    const req = auth.transport.request(target, {method:f.method, headers, timeout:120000}, res => {
      (async()=>{
        send(ws, {t:'headers',id:f.id,status:res.statusCode,headers:cleanHeaders(res.headers)});
        for await(const chunk of res){
          for(let i=0;i<chunk.length;i+=32768){
            await new Promise((resolve,reject)=>{
              if(ws.readyState!==1)return reject(new Error('Disconnected'));
              ws.send(JSON.stringify({t:'data',id:f.id,data:encode(chunk.subarray(i,i+32768))}),error=>error?reject(error):resolve());
            });
          }
        }
        active.delete(f.id);send(ws,{t:'end',id:f.id});
      })().catch(()=>req.destroy(new Error('Local response failed')));
    });
    active.set(f.id,req);
    req.on('timeout',()=>req.destroy(new Error('Local request timed out')));
    req.on('error',()=>{active.delete(f.id);try{send(ws,{t:'error',id:f.id});}catch{}});
    if(!f.streaming)req.end(decode(f.body??''));
  }
  connect();
  return { close() { closed=true; clearTimeout(retry); stopActive(); socket?.terminate(); }, get status() { return socket?.readyState === 1 ? 'connected' : 'disconnected'; } };
}
