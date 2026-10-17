const ANIMATION_MODULE='dsh-theme-firefly';
const stub=`\nwindow.__ModuleLoader__.load({id:${JSON.stringify(ANIMATION_MODULE)},factory:()=>({isPlugin:true,inject:[],apply(){}})});\n`;
/** Remove the embedded animation module before any bytes leave the computer. */
export function remoteAssetPolicy(path,skipRemoteAnimation=true){
  if(!skipRemoteAnimation)return {path,tail:''};
  const url=new URL(path,'http://local');
  if(url.pathname===`/plugins/${ANIMATION_MODULE}/client.js`)return {path:null,tail:stub};
  if(url.pathname!=='/plugins/'||!url.search.startsWith('??'))return {path,tail:''};
  const query=url.search.slice(2),split=query.indexOf('&');
  const modules=(split<0?query:query.slice(0,split)).split(',');
  const kept=modules.filter(item=>decodeURIComponent(item)!==`${ANIMATION_MODULE}/client.js`);
  if(kept.length===modules.length)return {path,tail:''};
  return {path:kept.length?`/plugins/??${kept.join(',')}${split<0?'':query.slice(split)}`:null,tail:stub};
}
