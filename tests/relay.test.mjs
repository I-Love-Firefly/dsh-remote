import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import WebSocket, {WebSocketServer} from 'ws';
import { createRelay } from '../relay/server.mjs';
import { startTunnel } from '../src/tunnel.mjs';
import { safePath } from '../src/protocol.mjs';

const bridgeKey='b'.repeat(8),mobileKey='m'.repeat(8);
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const waitFor=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out');};

test('authenticated relay: HTTP, streaming upload, streaming response, WebSocket, isolation and disconnect',async t=>{
  let localOrigin;
  const local=http.createServer(async(req,res)=>{
    if(req.url==='/?token=fixture-token') {res.writeHead(303,{'set-cookie':'owner=fixture; Path=/; HttpOnly',location:'/'});return res.end();}
    if(req.headers.cookie!=='owner=fixture'){res.writeHead(401);return res.end();}
    assert.equal(req.headers.origin,localOrigin);
    if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('first\n');setTimeout(()=>res.end('second\n'),150);return;}
    if(req.url==='/upload'){const hash=createHash('sha256');for await(const chunk of req)hash.update(chunk);return res.end(hash.digest('hex'));}
    if(req.url==='/large'){res.writeHead(200);for(let i=0;i<640;i++)if(!res.write(Buffer.alloc(32768,65)))await once(res,'drain');return res.end();}
    res.writeHead(200,{'content-type':'application/json','set-cookie':'must-not-leak=true'});
    res.end(JSON.stringify({url:req.url,authorization:req.headers.authorization??null}));
  });
  localOrigin=`http://127.0.0.1:${await listen(local)}`;
  const upstreamWS=new WebSocketServer({server:local});
  upstreamWS.on('connection',(ws,req)=>{assert.equal(req.headers.cookie,'owner=fixture');assert.equal(req.headers.origin,localOrigin);ws.on('message',(data,binary)=>ws.send(data,{binary}));});
  // Listen first with a reserved local port; the relay enforces the resulting exact origin.
  const reserved=http.createServer();const port=await listen(reserved);await new Promise(r=>reserved.close(r));
  const origin=`http://127.0.0.1:${port}`,base='/remote';
  const relay=createRelay({bridgeKey,mobileKey,publicUrl:origin+base+'/',allowLocalTest:true});
  await new Promise(r=>relay.server.listen(port,'127.0.0.1',r));
  let tunnel;
  t.after(async()=>{tunnel?.close();for(const ws of upstreamWS.clients)ws.terminate();await relay.close();local.closeAllConnections();await new Promise(r=>local.close(r));});
  const call=(path,options)=>fetch(origin+base+path,{redirect:'manual',...options});
  assert.equal((await call('/device/pc/')).status,401);
  assert.equal((await call('/login',{method:'POST',headers:{origin},body:'key=bad'})).status,401);
  assert.equal((await call('/login',{method:'POST',headers:{origin:'https://evil.test'},body:'key='+mobileKey})).status,403);
  const login=await call('/login',{method:'POST',headers:{origin},body:'key='+mobileKey});
  assert.equal(login.status,303);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const failedStatuses=[];
  const rejectedTunnel=startTunnel({relayUrl:origin.replace('http:','ws:')+base,bridgeKey:'wrong-key',deviceId:'rejected-pc',getLocalUrl:()=>localOrigin+'/?token=fixture-token',allowInsecureLocalTest:true,onStatus:state=>failedStatuses.push(state)});
  try { await waitFor(()=>failedStatuses.includes('authentication-failed'));assert.equal(relay.devices.has('rejected-pc'),false); }
  finally { rejectedTunnel.close(); }
  tunnel=startTunnel({relayUrl:origin.replace('http:','ws:')+base,bridgeKey,deviceId:'pc',getLocalUrl:()=>localOrigin+'/?token=fixture-token',allowInsecureLocalTest:true});
  await waitFor(()=>relay.devices.has('pc'));
  const response=await call('/device/pc/a?q=1',{headers:{cookie,authorization:'Bearer mobile-should-not-leak'}});
  assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);
  assert.deepEqual(await response.json(),{url:'/a?q=1',authorization:null});
  assert.equal((await call('/device/other/',{headers:{cookie}})).status,503);
  assert.equal((await call('/device/pc/write',{method:'POST',headers:{cookie,origin:'https://evil.test'}})).status,403);
  const payload=Buffer.alloc(2*1024*1024,73);
  const upload=await call('/device/pc/upload',{method:'POST',headers:{cookie,origin},body:payload});
  assert.equal(upload.status,200);assert.equal(await upload.text(),createHash('sha256').update(payload).digest('hex'));
  const stream=await call('/device/pc/stream',{headers:{cookie}}),reader=stream.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'first\n');
  assert.equal(Buffer.from((await reader.read()).value).toString(),'second\n');
  const large=await new Promise((resolve,reject)=>{
    http.get(origin+base+'/device/pc/large',{headers:{cookie}},response=>{
      let length=0;const hash=createHash('sha256');response.pause();setTimeout(()=>response.resume(),250);
      response.on('data',chunk=>{length+=chunk.length;hash.update(chunk);});response.on('end',()=>resolve({length,hash:hash.digest('hex')}));response.on('error',reject);
    }).on('error',reject);
  });
  assert.equal(large.length,20*1024*1024);assert.equal(large.hash,createHash('sha256').update(Buffer.alloc(20*1024*1024,65)).digest('hex'));
  const ws=new WebSocket(origin.replace('http:','ws:')+base+'/device/pc/api',{headers:{cookie,origin}});
  await once(ws,'open');const next=once(ws,'message');ws.send('immediate-before-upstream-ready');
  assert.equal(String((await next)[0]),'immediate-before-upstream-ready');
  // Existing session snapshots exceed both the old 512 KiB message limit and the 8 MiB bridge buffer.
  for(const binary of [false,true]){
    const history=Buffer.from('历史 snapshot 🐋\n'.repeat(700000));
    const echoed=once(ws,'message');
    ws._socket.pause();setTimeout(()=>ws._socket.resume(),150);
    ws.send(history,{binary});
    const [actual,actualBinary]=await echoed;
    assert.equal(actualBinary,binary);assert.equal(actual.length,history.length);
    assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(history).digest('hex'));
  }
  const ordered=[];ws.on('message',data=>ordered.push(String(data)));
  for(const value of ['','after-history-1','after-history-2'])ws.send(value);
  await waitFor(()=>ordered.length===3);assert.deepEqual(ordered,['','after-history-1','after-history-2']);
  ws.close();await once(ws,'close');
  for(let i=0;i<3;i++){
    const previous=relay.devices.get('pc');previous.terminate();
    await waitFor(()=>relay.devices.has('pc')&&relay.devices.get('pc')!==previous);
    assert.equal((await call('/device/pc/reconnected',{headers:{cookie}})).status,200);
  }
  const badWS=new WebSocket(origin.replace('http:','ws:')+base+'/bridge',{headers:{Authorization:'Bearer wrong','X-DSH-Device':'intruder'}});
  const rejection=await new Promise(resolve=>{badWS.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);});badWS.on('error',()=>{});});assert.equal(rejection,401);
  tunnel.close();await waitFor(()=>!relay.devices.has('pc'));
  assert.equal((await call('/device/pc/',{headers:{cookie}})).status,503);
});

test('configuration rejects insecure remote endpoints and unsafe target paths',()=>{
  assert.throws(()=>startTunnel({relayUrl:'wss://example.com',bridgeKey:'1234567',deviceId:'pc',getLocalUrl:()=>''}));
  assert.throws(()=>createRelay({bridgeKey:'1234567',mobileKey,publicUrl:'https://example.com/'}));
  assert.throws(()=>createRelay({bridgeKey,mobileKey:'1234567',publicUrl:'https://example.com/'}));
  assert.throws(()=>createRelay({bridgeKey,mobileKey,sessionKey:'s'.repeat(31),publicUrl:'https://example.com/'}));
  for(const path of ['//evil.test/','http://evil.test','/x\\y','/x\r\n'])assert.throws(()=>safePath(path));
  assert.throws(()=>startTunnel({relayUrl:'ws://example.com',bridgeKey,deviceId:'pc',getLocalUrl:()=>''}));
  assert.throws(()=>createRelay({bridgeKey,mobileKey:bridgeKey,publicUrl:'https://example.com/'}));
  assert.throws(()=>createRelay({bridgeKey,mobileKey,publicUrl:'http://example.com/'}));
});
