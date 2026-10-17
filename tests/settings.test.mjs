import test from 'node:test';
import assert from 'node:assert/strict';
import {Config,apply} from '../src/node.js';

test('settings are editable and bridge keys are structurally secret',()=>{
  const schema=Config;
  assert.equal(schema.meta.volatile,true);
  assert.equal(schema.dict.bridgeKey.meta.role,'secret');
  for(const field of ['enabled','relayUrl','deviceId','bridgeKey','configFile'])assert.ok(schema.dict[field]);
});

test('status never returns the bridge key and reflects live configuration changes',async()=>{
  let options={enabled:false,deviceId:'test-pc',bridgeKey:'actual-secret-test-value-0123456789'};
  const effects=[],events=new Map();let statusRpc;
  const ctx={
    effect(fn){const dispose=fn();if(dispose)effects.push(dispose);},
    on(event,fn){events.set(event,fn);return()=>events.delete(event);},
    connection:{rpc:{handle(_channel,handler){statusRpc=handler;return()=>{};}}},
    logger:{info(){}},
  };
  await apply(ctx,{get:()=>options});
  assert.equal((await statusRpc('status')).value.state,'disabled');
  options={...options,enabled:true,relayUrl:'invalid-url'};events.get('loader/volatile-update')();
  const status=(await statusRpc('status')).value;
  assert.equal(status.state,'configuration-error');
  assert.equal(JSON.stringify(status).includes(options.bridgeKey),false);
  assert.equal((await statusRpc('unknown')).ok,false);
  for(const dispose of effects.reverse())await dispose();
});
