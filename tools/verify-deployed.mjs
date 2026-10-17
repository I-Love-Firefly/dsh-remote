/** Verifies a deployed relay using an isolated Harness; never prints keys or tokens. */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startTunnel } from '../src/tunnel.mjs';
const [configFile,mobileKeyFile,harnessLog]=process.argv.slice(2);
if(!harnessLog)throw new Error('Usage: node tools/verify-deployed.mjs computer.json mobile-key.txt isolated-harness.log');
const config=JSON.parse(await readFile(configFile,'utf8'));
const mobileKey=(await readFile(mobileKeyFile,'utf8')).trim();
const localUrl=(await readFile(harnessLog,'utf8')).match(/dsh web: (http[^\s]+)/)?.[1];
if(!localUrl)throw new Error('Harness not ready');
const base=new URL(config.relayUrl);base.protocol='https:';if(!base.pathname.endsWith('/'))base.pathname+='/';
const health=await fetch(new URL('health',base));assert.equal(health.status,200);
assert.equal((await fetch(new URL('device/verification-pc/',base))).status,401);
const login=await fetch(new URL('login',base),{method:'POST',redirect:'manual',headers:{origin:base.origin},body:new URLSearchParams({key:mobileKey})});
assert.equal(login.status,303);const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
const tunnel=startTunnel({...config,deviceId:'verification-pc',getLocalUrl:()=>localUrl});
try{
  const device=new URL('device/verification-pc/',base);
  let page;
  for(let i=0;i<50;i++){page=await fetch(device,{headers:{cookie}});if(page.status===200)break;await page.arrayBuffer();await new Promise(r=>setTimeout(r,200));}
  assert.equal(page.status,200);assert.match(await page.text(),/DeepSeek Harness/);
  const target=new URL('api/remote.mux',device);target.protocol='wss:';
  const ws=new WebSocket(target,{headers:{cookie,origin:base.origin},handshakeTimeout:15000});
  const result=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Gateway timeout')),15000);
    ws.on('error',reject);ws.on('message',raw=>{const frame=JSON.parse(raw);if(frame.type==='item'){clearTimeout(timer);resolve(frame);}else if(frame.type==='error'){clearTimeout(timer);reject(new Error('Gateway rejected request'));}});
  });
  await once(ws,'open');ws.send(JSON.stringify({type:'open',streamId:'verify',endpoint:'remoteAccess/follow',payload:{args:{}}}));
  const frame=await result;assert.deepEqual(frame.value,{type:'baseline',owner:true});ws.terminate();
  console.log(JSON.stringify({httpsHealth:true,unauthenticatedBlocked:true,realHarnessHtml:true,publicWebSocketGateway:true,remoteAccessBaseline:frame.value}));
}finally{tunnel.close();}
