import http from 'node:http';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_FRAME, MAX_BUFFER, MAX_BODY, validDevice, equal, send, encode, decode, cleanHeaders } from '../src/protocol.mjs';

export function createRelay({ bridgeKey, mobileKey, publicUrl, sessionKey = randomBytes(32).toString('hex'), allowLocalTest = false }) {
  for (const key of [bridgeKey, mobileKey, sessionKey]) if (typeof key !== 'string' || key.length < 32) throw new Error('All relay keys must contain at least 32 characters');
  if (equal(bridgeKey, mobileKey)) throw new Error('Bridge and mobile keys must be different');
  const root = new URL(publicUrl);
  if (root.protocol !== 'https:' && !(allowLocalTest && root.hostname === '127.0.0.1')) throw new Error('Public URL must use HTTPS');
  const base = root.pathname.replace(/\/$/, '');
  const devices = new Map(), pending = new Map(), failures = new Map();
  const bridges = new WebSocketServer({noServer:true,maxPayload:MAX_FRAME,perMessageDeflate:false});
  const browsers = new WebSocketServer({noServer:true,maxPayload:512*1024,perMessageDeflate:false});
  const signature = data => createHmac('sha256',sessionKey).update(data).digest('base64url');
  const cookieName = 'dsh_remote_session';
  const cookiePath = base || '/';
  function hasSession(req) {
    const token = (req.headers.cookie ?? '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    if (!token) return false;
    const [exp, nonce, mac] = token.split('.');
    return /^\d+$/.test(exp) && Number(exp) > Date.now() && nonce?.length === 32 && equal(mac,signature(`${exp}.${nonce}`));
  }
  const validOrigin = req => req.headers.origin === root.origin;
  const json = (res,status,value) => {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  function done(id) { const entry=pending.get(id); if(entry) {clearTimeout(entry.timer);pending.delete(id);} return entry; }
  function cancel(id) { const entry=done(id); if(entry) try{send(entry.bridge,{t:entry.ws?'ws-close':'cancel',id});}catch{} }
  function attach(id, entry) {
    entry.timer=setTimeout(()=>{const old=done(id);if(old?.ws)old.ws.close(1011,'Request timed out');else if(old?.res){if(!old.res.headersSent)old.res.writeHead(504);old.res.end();}try{send(entry.bridge,{t:'cancel',id});}catch{}},120000);
    entry.timer.unref?.();pending.set(id,entry);
  }
  function touch(entry) { entry?.timer?.refresh(); }
  const server = http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');
    try {
      const u=new URL(req.url,'http://relay.local');
      if (u.pathname===base+'/health') return json(res,200,{service:'dsh-remote',version:'0.1.0'});
      if (u.pathname===base+'/' && req.method==='GET') {
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"});
        res.end(loginPage(base,hasSession(req),[...devices.keys()]));return;
      }
      if (u.pathname===base+'/login' && req.method==='POST') {
        if (!validOrigin(req)) return json(res,403,{error:'origin'});
        // Single reverse proxy on loopback supplies a trusted client address.
        const address=req.socket.remoteAddress?.includes('127.0.0.1')||req.socket.remoteAddress==='::1' ? (req.headers['x-real-ip']??req.socket.remoteAddress) : req.socket.remoteAddress;
        const previous=failures.get(address);
        if(previous && previous.until>Date.now() && previous.count>=10)return json(res,429,{error:'Too many attempts; wait 15 minutes'});
        let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return json(res,413,{error:'body'});}
        if(!equal(new URLSearchParams(body).get('key'),mobileKey)) {
          if(failures.size>10000)failures.clear();
          failures.set(address,{count:previous?.until>Date.now()?previous.count+1:1,until:Date.now()+900000});
          return json(res,401,{error:'Invalid access key'});
        }
        failures.delete(address);
        const data=`${Date.now()+7*86400000}.${randomBytes(16).toString('hex')}`;
        res.writeHead(303,{'set-cookie':`${cookieName}=${data}.${signature(data)}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=604800${root.protocol==='https:'?'; Secure':''}`,location:base+'/','cache-control':'no-store'});res.end();return;
      }
      if (u.pathname===base+'/logout' && req.method==='POST') {
        if(!validOrigin(req))return json(res,403,{error:'origin'});
        res.writeHead(303,{'set-cookie':`${cookieName}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${root.protocol==='https:'?'; Secure':''}`,location:base+'/'});res.end();return;
      }
      if(!hasSession(req))return json(res,401,{error:'Sign in at '+base+'/'});
      if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!validOrigin(req))return json(res,403,{error:'origin'});
      const match=u.pathname.slice(base.length).match(/^\/device\/([a-zA-Z0-9_-]{1,64})(\/.*)$/);
      if(!u.pathname.startsWith(base+'/device/')||!match)return json(res,404,{error:'not found'});
      const bridge=devices.get(match[1]);if(!bridge)return json(res,503,{error:'Computer offline. Start Harness with the remote plugin.'});
      if(pending.size>=128)return json(res,503,{error:'Busy'});
      const id=randomUUID(); attach(id,{bridge,res,device:match[1]});
      res.on('close',()=>cancel(id));
      send(bridge,{t:'http',id,path:match[2]+u.search,method:req.method,headers:cleanHeaders(req.headers),streaming:true});
      let length=0;
      for await(const chunk of req){
        length+=chunk.length;if(length>MAX_BODY){cancel(id);return json(res,413,{error:'Upload exceeds 32 MiB'});}
        for(let offset=0;offset<chunk.length;offset+=32768){
          await new Promise((resolve,reject)=>{
            if(bridge.readyState!==1)return reject(new Error('Disconnected'));
            bridge.send(JSON.stringify({t:'http-body',id,data:encode(chunk.subarray(offset,offset+32768))}),error=>error?reject(error):resolve());
          });
        }
      }
      send(bridge,{t:'http-end',id});
    }catch{if(!res.headersSent)res.writeHead(502);res.end();}
  });
  server.on('upgrade',(req,socket,head)=>{
    const reject=status=>{socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);};
    const u=new URL(req.url,'http://relay.local');
    if(u.pathname===base+'/bridge'){
      const device=req.headers['x-dsh-device'];
      if(!equal(req.headers.authorization,`Bearer ${bridgeKey}`)||!validDevice(device))return reject('401 Unauthorized');
      if(devices.has(device))return reject('409 Conflict');
      return bridges.handleUpgrade(req,socket,head,ws=>{
        devices.set(device,ws);ws.alive=true;
        ws.on('pong',()=>ws.alive=true);
        ws.on('message',raw=>{
          try {
            const f=JSON.parse(raw),entry=pending.get(f.id);
            if(!entry||entry.bridge!==ws)return;
            touch(entry);
            if(f.t==='ws-ready'){entry.ready=true;clearTimeout(entry.timer);entry.timer=undefined;for(const frame of entry.queue??[])send(ws,frame);entry.queue=[];entry.queued=0;return;}
            if(f.t==='ws-data'&&entry.ws){if(entry.ws.bufferedAmount>MAX_BUFFER)return entry.ws.close(1013);entry.ws.send(decode(f.data),{binary:!!f.binary});return;}
            if(f.t==='ws-close'&&entry.ws){done(f.id);entry.ws.close(1000);return;}
            if(f.t==='headers'&&entry.res){
              const headers=cleanHeaders(f.headers??{});
              // DSH token and cookies stay on the computer; the phone uses relay auth only.
              if(headers.location?.startsWith('/'))headers.location=`${base}/device/${entry.device}${headers.location}`;
              headers['cache-control']='no-store';
              entry.res.writeHead(f.status,headers);return;
            }
            if(f.t==='data'&&entry.res){if(!entry.res.write(decode(f.data))&&entry.res.writableLength>MAX_BUFFER)entry.res.destroy();return;}
            if(f.t==='end'){done(f.id)?.res?.end();return;}
            if(f.t==='error'){const old=done(f.id);if(old?.res){if(!old.res.headersSent)old.res.writeHead(502);old.res.end();}old?.ws?.close(1011);}
          }catch{ws.close(1008,'Invalid frame');}
        });
        ws.on('close',()=>{
          if(devices.get(device)===ws)devices.delete(device);
          for(const [id,entry]of pending)if(entry.bridge===ws){done(id);entry.ws?.close(1012);if(entry.res){if(!entry.res.headersSent)entry.res.writeHead(503);entry.res.end();}}
        });ws.on('error',()=>{});
      });
    }
    const match=u.pathname.slice(base.length).match(/^\/device\/([a-zA-Z0-9_-]{1,64})(\/.*)$/);
    if(!hasSession(req)||!validOrigin(req))return reject('401 Unauthorized');
    if(!u.pathname.startsWith(base+'/device/')||!match)return reject('404 Not Found');
    const bridge=devices.get(match[1]);if(!bridge||pending.size>=128)return reject('503 Service Unavailable');
    browsers.handleUpgrade(req,socket,head,ws=>{
      const id=randomUUID();attach(id,{bridge,ws,device:match[1],queue:[],queued:0,ready:false});
      try{send(bridge,{t:'ws-open',id,path:match[2]+u.search,headers:cleanHeaders(req.headers),protocols:(req.headers['sec-websocket-protocol']??'').split(',').map(x=>x.trim()).filter(Boolean)});}catch{ws.close(1011);}
      ws.on('message',(data,binary)=>{
        const entry=pending.get(id);touch(entry);if(!entry)return;
        const frame={t:'ws-data',id,data:encode(data),binary};
        if(!entry.ready){entry.queued+=data.length;if(entry.queued>MAX_BUFFER)return ws.close(1013);entry.queue.push(frame);return;}
        try{send(bridge,frame);}catch{ws.close(1011);}
      });
      ws.on('close',()=>cancel(id));ws.on('error',()=>{});
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of devices.values()){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},25000);heartbeat.unref();
  return {server,devices,close(){clearInterval(heartbeat);for(const ws of devices.values())ws.terminate();for(const ws of browsers.clients)ws.terminate();for(const [id]of pending)cancel(id);server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}};
}

function loginPage(base,authenticated,devices){
  const links=devices.map(id=>`<a class="device" href="${base}/device/${id}/"><b>● ${id}</b><span>打开电脑上的 DSH →</span></a>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>DSH Remote</title><style>*{box-sizing:border-box}body{margin:0;background:#101419;color:#eaf2f5;font:16px system-ui;padding:28px 20px;min-height:100vh}main{max-width:520px;margin:9vh auto}.mark{color:#7fe1c2;letter-spacing:3px;font-size:12px}h1{font-size:38px;margin:18px 0}p{color:#9daeb9;line-height:1.8}input,button{width:100%;padding:16px;border-radius:14px;font:inherit;margin:10px 0}input{background:#1b242d;color:white;border:1px solid #34424c}button{background:#7fe1c2;border:0;color:#0b2720;font-weight:700}.device{display:block;text-decoration:none;color:inherit;padding:22px;background:#1b242d;border:1px solid #34424c;border-radius:18px;margin:16px 0}.device b{color:#7fe1c2}.device span{display:block;margin-top:14px;color:#a4b8c3}.note{font-size:12px;border-top:1px solid #29343d;padding-top:20px;margin-top:30px}</style><main><div class="mark">DEEPSEEK HARNESS / REMOTE</div><h1>电脑的能力，<br>随身连接。</h1><p>通过安全中转连接已启动的电脑，继续会话、审批操作与执行任务。</p>${authenticated?`${links||'<p>电脑暂未连接。请在电脑 DSH 中启用远程插件。</p>'}<form method="post" action="${base}/logout"><button>退出连接</button></form>`:`<form method="post" action="${base}/login"><label for="key">手机访问密钥</label><input id="key" name="key" type="password" required autocomplete="current-password" placeholder="输入配对时提供的密钥"><button>安全连接</button></form>`}<p class="note">所有命令在电脑端运行。电脑需保持开机、联网且 DSH 正在运行。请仅在自己的设备上登录。</p></main></html>`;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const relay=createRelay({bridgeKey:process.env.DSH_BRIDGE_KEY,mobileKey:process.env.DSH_MOBILE_KEY,sessionKey:process.env.DSH_SESSION_KEY,publicUrl:process.env.DSH_PUBLIC_URL});
  relay.server.listen(Number(process.env.PORT??8787),process.env.HOST??'127.0.0.1',()=>console.log('DSH Remote relay ready'));
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>relay.close().then(()=>process.exit(0)));
}
