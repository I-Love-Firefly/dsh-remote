/* Browser module registered using the Harness client-module contract; React stays host-owned. */
window.__ModuleLoader__.load({id:'dsh-remote',factory:require=>{
  const React=require('react'),h=React.createElement;
  const labels={connected:'已连接',connecting:'正在连接',disconnected:'连接已断开，正在重试','authentication-failed':'电脑连接密钥与服务器不匹配，请勿填入手机访问密钥','connection-error':'连接失败，正在重试','waiting-for-harness':'等待本机 DSH 就绪','needs-configuration':'等待填写配置',disabled:'已暂停','configuration-error':'配置有误'};
  function StatusCard({readStatus,form}){
    const [value,setValue]=React.useState(null);
    const [snapshot,setSnapshot]=React.useState(()=>form.getSnapshot());
    const [draft,setDraft]=React.useState({enabled:true,skipRemoteAnimation:true,relayUrl:'',deviceId:'my-pc',configFile:''});
    const [key,setKey]=React.useState(''),[saving,setSaving]=React.useState(false),[message,setMessage]=React.useState('');
    const dirty=React.useRef(false),prefix=React.useId();
    React.useEffect(()=>form.subscribe(()=>setSnapshot(form.getSnapshot())),[form]);
    React.useEffect(()=>{if(!dirty.current&&snapshot.value)setDraft({enabled:snapshot.value.enabled!==false,skipRemoteAnimation:snapshot.value.skipRemoteAnimation!==false,relayUrl:snapshot.value.relayUrl??'',deviceId:snapshot.value.deviceId??'my-pc',configFile:snapshot.value.configFile??''});},[snapshot]);
    React.useEffect(()=>{
      let disposed=false,timer;
      async function refresh(){try{const result=await readStatus();if(!disposed)setValue(result.ok?result.value:{state:'unavailable'});}catch{if(!disposed)setValue({state:'unavailable'});}finally{if(!disposed)timer=setTimeout(refresh,3000);}}
      void refresh();return()=>{disposed=true;clearTimeout(timer);};
    },[readStatus]);
    const change=(field,next)=>{dirty.current=true;setDraft(previous=>({...previous,[field]:next}));};
    async function save(event){
      event.preventDefault();setMessage('');
      try{if(draft.enabled){const address=new URL(draft.relayUrl);if(!['https:','wss:'].includes(address.protocol)||address.username||address.password||address.search||address.hash)throw new Error();if(!/^[A-Za-z0-9_-]{1,64}$/.test(draft.deviceId))throw new Error();if(key&&key.trim().length<8)throw new Error();}}catch{setMessage('请检查服务器地址、电脑名称和连接密钥（至少 8 字符）');return;}
      setSaving(true);
      try{const ops=Object.entries(draft).map(([field,next])=>({op:'set',path:[field],value:typeof next==='string'?next.trim():next}));if(key.trim())ops.push({op:'set',path:['bridgeKey'],value:key.trim()});const accepted=await form.mutate(ops);if(!accepted)throw new Error();dirty.current=false;setKey('');setMessage('配置已保存，连接状态会自动更新。');}catch{setMessage('保存失败，请刷新设置页后重试。');}finally{setSaving(false);}
    }
    const field=(name,label,type='text',placeholder='')=>h('label',{htmlFor:prefix+name,style:{display:'grid',gap:'6px',margin:'12px 0'}},label,h('input',{id:prefix+name,type,value:name==='bridgeKey'?key:draft[name],placeholder,autoComplete:name==='bridgeKey'?'new-password':'off',onChange:event=>name==='bridgeKey'?setKey(event.target.value):change(name,event.target.value),style:{font:'inherit',color:'inherit',background:'transparent',border:'1px solid #8886',borderRadius:'6px',padding:'10px',width:'100%',boxSizing:'border-box'}}));
    const toggle=(name,label)=>h('label',{style:{display:'block',margin:'12px 0'}},h('input',{type:'checkbox',checked:draft[name],onChange:event=>change(name,event.target.checked)}),' ',label);
    return h('div',{style:{padding:'16px',border:'1px solid var(--ds-border-color, #6664)',borderRadius:'12px'}},
      h('h3',null,'DSH Remote · 远程连接'),
      h('p',{'aria-live':'polite'},'连接状态：',value?(labels[value.state]??'暂时无法读取状态'):'读取中…'),
      value?.deviceId?h('p',null,'电脑名称：',value.deviceId):null,
      value?.mobileUrl?h('p',null,'手机访问地址：',h('a',{href:value.mobileUrl,target:'_blank',rel:'noreferrer'},value.mobileUrl)):null,
      h('p',null,'电脑连接密钥：',value?.keyConfigured?'已配置（不显示明文）':'尚未配置'),
      value?.issue?h('p',{role:'alert'},value.issue):null,
      h('p',null,'手机使用独立的手机登录密钥。下面的电脑连接密钥留空表示保留已保存值，不会回传明文。'),
      h('form',{onSubmit:save},
        toggle('enabled','启用远程连接'),
        field('relayUrl','中转服务器地址','url','wss://example.com/dshremote/'),
        field('deviceId','电脑名称'),
        field('bridgeKey','电脑连接密钥','password',value?.keyConfigured?'已配置；留空保留原值':'请输入电脑连接密钥'),
        toggle('skipRemoteAnimation','远程跳过开屏动画（电脑端拦截，不传服务器）'),
        h('details',null,h('summary',null,'高级：旧版配置文件'),field('configFile','本机配置文件路径（一般留空）')),
        h('button',{type:'submit',disabled:saving||!snapshot.writable,style:{padding:'10px 18px',font:'inherit',cursor:'pointer'}},saving?'正在保存…':'保存配置'),
        message?h('p',{role:'status'},message):null));
  }
  return {isPlugin:true,inject:['slots','connection','configForms'],apply(ctx){
    const readStatus=()=>ctx.connection.rpc.call('/dsh-remote','status',{});
    const form=ctx.configForms.get('remote-relay');
    ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'dsh-remote',inject:()=>({readStatus,form})},StatusCard));
  }};
}});
