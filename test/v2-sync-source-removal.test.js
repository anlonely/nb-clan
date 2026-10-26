import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
const op=()=>({operationId:randomUUID()}),scope={kind:'members',memberIds:['g05_alpha']};
function setup(t){const f=fixture();t.after(()=>f.close());const a=f.repo.get('accounts','g05_account_admin');f.repo.put('accounts',{...a,adminAssignedByOwner:true});return f;}
test('source removal stops its rules and queued work, preserves history, and restores paused',async t=>{
  const f=setup(t),actor=f.actor();
  const {rule}=await f.service.saveRule(actor,null,{name:'Steam plan',type:'member_profile',scope,enabled:true,intervalMinutes:5,expectedRevision:0},op());
  const {job}=await f.service.request(actor,{type:'member_profile',scope},op());
  const other=f.service.sourceStatus('battlemetrics');
  const receipt=op(),body={expectedRevision:1,delete:true};
  const result=await f.service.saveSource(actor,'steam',body,receipt);
  assert.deepEqual(await f.service.saveSource(actor,'steam',body,receipt),result);
  assert.deepEqual(f.service.operation(actor,receipt.operationId),result);
  assert.equal(result.source.paused,true);
  assert.equal(f.service.sources(actor).items.some(s=>s.id==='steam'),false);
  assert.equal(f.service.sources(actor).removedItems[0].id,'steam');
  assert.equal(f.service.repo.get('rule',rule.id).enabled,false);
  assert.equal(f.service.detail(actor,job.id).status,'cancelled');
  assert.deepEqual(f.service.sourceStatus('battlemetrics'),other);
  assert.equal(await f.worker.step(),null);
  await assert.rejects(f.service.request(actor,{type:'member_profile',scope},op()),{errorCode:'SYNC_SOURCE_REMOVED'});
  const restored=await f.service.saveSource(actor,'steam',{expectedRevision:2,restore:true},op());
  assert.equal(restored.source.deleted,false);assert.equal(restored.source.paused,true);
  assert.equal(f.service.sources(actor).items.some(s=>s.id==='steam'),true);
  assert.equal(f.service.repo.get('rule',rule.id).enabled,false);
});
test('source deletion obeys permission and stale revision checks without mutation',async t=>{
  const f=setup(t);
  await assert.rejects(f.service.saveSource(f.actor('alpha'),'steam',{expectedRevision:1,delete:true},op()),{errorCode:'ACCESS_DENIED'});
  await assert.rejects(f.service.saveSource(f.actor(),'steam',{expectedRevision:99,delete:true},op()),{errorCode:'REVISION_CONFLICT'});
  assert.equal(f.service.sourceStatus('steam').deleted,undefined);
});
test('source removal fences a result already in flight',async t=>{
  const f=setup(t);let finishRequest,started;const waiting=new Promise(r=>started=r);
  f.outcomes.set('member_profile',[()=>new Promise(resolve=>{finishRequest=resolve;started();})]);
  const {job}=await f.service.request(f.actor(),{type:'member_profile',scope},op());
  const running=f.worker.step();await waiting;
  const current=f.service.sourceStatus('steam');
  await f.service.saveSource(f.actor(),'steam',{expectedRevision:current.revision,delete:true},op());
  finishRequest({outcome:'success',data:{value:123}});await running;
  assert.equal(f.service.detail(f.actor(),job.id).status,'cancelled');assert.equal(f.commits.length,0);
});
