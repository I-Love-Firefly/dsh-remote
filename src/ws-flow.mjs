import {MAX_BUFFER, encode} from './protocol.mjs';

export const MAX_WS_MESSAGE = 32 * 1024 * 1024;
const CHUNK = 32768, WINDOW = 1024 * 1024;
export function createWsFlow() { return {queued:0,unacknowledged:0,cancelled:false,tail:Promise.resolve()}; }
export function stopWsFlow(state) { if(state){state.cancelled=true;state.wake?.();} }
export function acknowledgeWs(state, bytes) {
  if(!state || !Number.isInteger(bytes) || bytes<=0 || bytes>state.unacknowledged)return;
  state.unacknowledged-=bytes;state.wake?.();state.wake=undefined;
}
/** Preserve message boundaries with RFC 6455 fragments; bound each bridge frame and in-flight bytes. */
export function queueWsMessage(bridge,id,data,binary,state,fragment=true) {
  if(data.length>MAX_WS_MESSAGE || state.queued+data.length>MAX_WS_MESSAGE)return Promise.reject(new Error('WebSocket message queue exceeds limit'));
  state.queued+=data.length;
  const task=state.tail.then(async()=>{
    if(state.cancelled)throw new Error('Cancelled');
    const size=fragment?CHUNK:Math.max(1,data.length);
    for(let offset=0;offset<data.length || offset===0;offset+=size){
      const part=data.subarray(offset,offset+size);
      if(fragment){while(state.unacknowledged>=WINDOW&&!state.cancelled)await new Promise(resolve=>state.wake=resolve);}
      if(state.cancelled || bridge.readyState!==1)throw new Error('Disconnected');
      if(bridge.bufferedAmount>MAX_BUFFER)throw new Error('Tunnel overloaded');
      if(fragment)state.unacknowledged+=part.length;
      const frame={t:'ws-data',id,data:encode(part),binary:!!binary};
      if(fragment){frame.fin=offset+size>=data.length;frame.flow=true;}
      await new Promise((resolve,reject)=>bridge.send(JSON.stringify(frame),error=>error?reject(error):resolve()));
      if(!part.length)break;
    }
  }).finally(()=>{state.queued-=data.length;});
  state.tail=task.catch(()=>{stopWsFlow(state);});
  return task;
}
