/* Browser module registered using the Harness client-module contract; React stays host-owned. */
window.__ModuleLoader__.load({id:'dsh-remote',factory:require=>{
  const React=require('react'),h=React.createElement;
  const labels={connected:'已连接',connecting:'正在连接',disconnected:'连接已断开，正在重试','connection-error':'连接失败，正在重试','waiting-for-harness':'等待本机 DSH 就绪','needs-configuration':'等待填写配置',disabled:'已暂停','configuration-error':'配置有误'};
  function StatusCard({readStatus}){
    const [value,setValue]=React.useState(null);
    React.useEffect(()=>{
      let disposed=false,timer;
      async function refresh(){try{const result=await readStatus();if(!disposed)setValue(result.ok?result.value:{state:'unavailable'});}catch{if(!disposed)setValue({state:'unavailable'});}finally{if(!disposed)timer=setTimeout(refresh,3000);}}
      void refresh();return()=>{disposed=true;clearTimeout(timer);};
    },[readStatus]);
    return h('div',{style:{padding:'16px',border:'1px solid var(--ds-border-color, #6664)',borderRadius:'12px'}},
      h('h3',null,'DSH Remote · 远程连接'),
      h('p',{'aria-live':'polite'},'连接状态：',value?(labels[value.state]??'暂时无法读取状态'):'读取中…'),
      value?.deviceId?h('p',null,'电脑名称：',value.deviceId):null,
      value?.mobileUrl?h('p',null,'手机访问地址：',h('a',{href:value.mobileUrl,target:'_blank',rel:'noreferrer'},value.mobileUrl)):null,
      h('p',null,'电脑连接密钥：',value?.keyConfigured?'已配置（不显示明文）':'尚未配置'),
      value?.issue?h('p',{role:'alert'},value.issue):null,
      h('p',null,'在下方配置表单中填写服务器地址、电脑名称和电脑连接密钥。保存后自动重新连接。手机使用独立的手机登录密钥。'));
  }
  return {isPlugin:true,inject:['slots','connection'],apply(ctx){
    const readStatus=()=>ctx.connection.rpc.call('/dsh-remote','status',{});
    ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'dsh-remote',inject:()=>({readStatus})},StatusCard));
  }};
}});
