import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {remoteAssetPolicy} from '../src/asset-policy.mjs';
test('remote animation is replaced locally and preserves the module contract',()=>{
  const result=remoteAssetPolicy('/plugins/??dsh-theme-firefly/client.js&rev=abc');
  assert.equal(result.path,null);assert.ok(result.tail.length<200);
  let module;vm.runInNewContext(result.tail,{window:{__ModuleLoader__:{load(value){module=value;}}}});
  assert.equal(module.id,'dsh-theme-firefly');assert.equal(module.factory().isPlugin,true);
});
test('mixed bundles keep other plugins and explicit opt-in bypasses filtering',()=>{
  const input='/plugins/??other/client.js,dsh-theme-firefly/client.js&rev=abc';
  assert.equal(remoteAssetPolicy(input).path,'/plugins/??other/client.js&rev=abc');
  assert.deepEqual(remoteAssetPolicy(input,false),{path:input,tail:''});
  assert.equal(remoteAssetPolicy('/other/file.js').path,'/other/file.js');
});
