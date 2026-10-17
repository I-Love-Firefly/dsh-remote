/** Local-only preview against an isolated Harness; never use these fixture keys in deployment. */
import { readFile } from 'node:fs/promises';
import { createRelay } from '../relay/server.mjs';
import { startTunnel } from '../src/tunnel.mjs';
const log=await readFile(process.argv[2],'utf8');
const localUrl=log.match(/dsh web: (http[^\s]+)/)?.[1];
if(!localUrl)throw new Error('Isolated Harness ready URL missing');
const relay=createRelay({bridgeKey:'b'.repeat(48),mobileKey:'m'.repeat(48),publicUrl:'http://127.0.0.1:31988/remote/',allowLocalTest:true});
relay.server.listen(31988,'127.0.0.1');
const tunnel=startTunnel({relayUrl:'ws://127.0.0.1:31988/remote',bridgeKey:'b'.repeat(48),deviceId:'test-pc',getLocalUrl:()=>localUrl,allowInsecureLocalTest:true,onStatus:status=>console.log(status)});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{tunnel.close();await relay.close();process.exit(0);});
