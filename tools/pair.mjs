import {randomBytes} from 'node:crypto';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
const url=new URL(process.argv[2]??'https://example.com/dshremote/');
if(url.protocol!=='https:'||url.search||url.hash||url.username||url.password)throw new Error('Use a clean HTTPS relay URL');
const out=resolve(process.argv[3]??'.private');
await mkdir(out,{recursive:true,mode:0o700});
for(const file of ['server.env','computer.json','mobile-key.txt']){
  try{await access(resolve(out,file));throw new Error('Pairing files already exist. Choose a new output directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
}
const bridge=randomBytes(32).toString('hex'),mobile=randomBytes(32).toString('hex'),session=randomBytes(32).toString('hex');
await writeFile(resolve(out,'server.env'),`DSH_PUBLIC_URL=${url.href}\nDSH_BRIDGE_KEY=${bridge}\nDSH_MOBILE_KEY=${mobile}\nDSH_SESSION_KEY=${session}\n`,{mode:0o600,flag:'wx'});
url.protocol='wss:';
await writeFile(resolve(out,'computer.json'),JSON.stringify({relayUrl:url.href,deviceId:'my-pc',bridgeKey:bridge},null,2)+'\n',{mode:0o600,flag:'wx'});
await writeFile(resolve(out,'mobile-key.txt'),mobile+'\n',{mode:0o600,flag:'wx'});
console.log('Pairing files written to the private output directory. Keep all three files out of Git.');
