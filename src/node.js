import z from '@deepseek-ai/schemastery';
import { readFile } from 'node:fs/promises';
import { startTunnel } from './tunnel.mjs';
export const name = 'dsh-remote';
export const inject = ['webServer', 'connection'];
export const Config = z.object({
  enabled: z.boolean().default(true).description('启用远程连接'),
  skipRemoteAnimation: z.boolean().default(true).description('远程访问时跳过开屏动画：在电脑端拦截主题脚本，不消耗中转流量'),
  relayUrl: z.string().default('').description('中转服务器地址，例如 wss://example.com/dshremote/'),
  deviceId: z.string().default('my-pc').description('电脑名称：字母、数字、下划线或短横线'),
  bridgeKey: z.string().role('secret').default('').description('电脑连接密钥（不是手机登录密钥），保存后不会回传明文'),
  configFile: z.string().default('').description('高级：兼容旧版的本机配置文件路径；直接填写上面的配置即可留空'),
}).volatile();
export async function apply(ctx, config) {
  let tunnel, disposed=false, generation=0, fingerprint;
  let status={state:'needs-configuration',relayUrl:'',deviceId:'',keyConfigured:false,mobileUrl:'',issue:''};
  async function refresh() {
    const current=typeof config.get==='function'?config.get():config;
    const next=JSON.stringify(current);
    if(next===fingerprint)return;
    fingerprint=next;const own=++generation;
    tunnel?.close();tunnel=undefined;
    status={state:'needs-configuration',relayUrl:'',deviceId:current.deviceId??'my-pc',keyConfigured:false,mobileUrl:'',issue:''};
    if(current.enabled===false){status.state='disabled';return;}
    let legacy={};
    const file=current.configFile||process.env.DSH_REMOTE_CONFIG;
    if(file){try{legacy=JSON.parse(await readFile(file,'utf8'));}catch{status.issue='无法读取旧版配置文件，请检查路径或直接填写配置';return;}}
    if(disposed||own!==generation)return;
    const options={...legacy,skipRemoteAnimation:current.skipRemoteAnimation!==false,relayUrl:current.relayUrl||legacy.relayUrl,deviceId:current.deviceId||legacy.deviceId||'my-pc',bridgeKey:current.bridgeKey||legacy.bridgeKey};
    status.keyConfigured=!!options.bridgeKey;
    if(!options.relayUrl||!options.bridgeKey){status.issue='请填写中转服务器地址和电脑连接密钥';return;}
    try{
      const address=new URL(options.relayUrl);
      if(address.username||address.password||address.search||address.hash)throw new Error('地址不能包含账号、密钥、查询参数或片段');
      if(address.protocol==='https:')address.protocol='wss:';
      options.relayUrl=address.href;status.relayUrl=address.href;status.deviceId=options.deviceId;
      const mobile=new URL(address);mobile.protocol='https:';status.mobileUrl=mobile.href;
      status.state='connecting';
      tunnel=startTunnel({...options,
        getLocalUrl:()=>{const server=ctx.webServer;return ctx.connection.authenticatedUrl(`${server.protocol}//127.0.0.1:${server.port}/`);},
        onStatus:state=>{if(!disposed&&own===generation){status.state=state;ctx.logger.info(`Remote relay: ${state}`);}},
      });
    }catch{status.state='configuration-error';status.issue='配置无效：请使用 WSS/HTTPS 地址、有效电脑名称和至少 8 字符的电脑连接密钥';}
  }
  ctx.effect(()=>ctx.connection.rpc.handle('/dsh-remote',async endpoint=>endpoint==='status'
    ?{ok:true,value:{...status}}
    :{ok:false,error:{code:'not-found',message:'Unknown endpoint',details:{}}}));
  ctx.effect(() => {
    void refresh();
    const unwatch=ctx.on('loader/volatile-update',()=>void refresh());
    return ()=>{disposed=true;++generation;unwatch();tunnel?.close();};
  });
}
