import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
const op=()=>({operationId:randomUUID()}),scope={kind:'members',memberIds:['g05_alpha','g05_beta']};
async function setup(t){let time=Date.now();const f=fixture({now:()=>time});f.advance=ms=>time+=ms;t.after(()=>f.close());const admin=f.repo.get('accounts','g05_account_admin');f.repo.put('accounts',{...admin,adminAssignedByOwner:true});const wipe=f.repo.get('schedulingWipes','fixture-wipe');f.repo.put('schedulingWipes',{...wipe,serverSnapshot:{provider:'vital',kdaProvider:'vital',vitalServerId:'19'}});return f;}
test('default coverage works without a current wipe; explicit wipe remains validated',async t=>{const f=await setup(t);f.db.prepare("DELETE FROM json_records WHERE collection='v2Wipes'").run();const before=f.db.prepare('SELECT total_changes() n').get().n;const result=f.service.coverage(f.actor());assert.equal(result.scope.kind,'all_members');assert.equal(result.coverage.total,5);assert.throws(()=>f.service.coverage(f.actor(),{scope:'current_wipe'}),{errorCode:'SYNC_WIPE_REQUIRED'});assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.calls.length,0);});
test('deleting an invalidated wipe plan preserves idempotency and revision guards',async t=>{const f=await setup(t);const {rule}=await f.service.saveRule(f.actor(),null,{expectedRevision:0,name:'expired wipe',type:'kda',scope:{kind:'current_wipe'},enabled:true,intervalMinutes:5},op());f.db.prepare("DELETE FROM json_records WHERE collection='v2Wipes'").run();await assert.rejects(f.service.saveRule(f.actor(),rule.id,{expectedRevision:0,delete:true},op()),{errorCode:'REVISION_CONFLICT'});const receipt=op(),body={expectedRevision:rule.revision,delete:true};const result=await f.service.saveRule(f.actor(),rule.id,body,receipt);assert.equal(result.rule.deleted,true);assert.equal(result.rule.enabled,false);assert.deepEqual(await f.service.saveRule(f.actor(),rule.id,body,receipt),result);assert.deepEqual(f.service.operation(f.actor(),receipt.operationId),result);assert.equal(f.service.rules(f.actor()).items.length,0);});
test('deleted plan history cannot hide live plans or starve scheduling and plan limits',async t=>{const f=await setup(t);for(let i=0;i<110;i++)f.service.repo.put('rule',{id:`000-deleted-${i}`,deleted:true,enabled:false,updatedAt:0});const {rule}=await f.service.saveRule(f.actor(),null,{expectedRevision:0,name:'live plan',type:'kda',scope,enabled:true,intervalMinutes:5},op());assert.deepEqual(f.service.rules(f.actor()).items.map(r=>r.id),[rule.id]);f.advance(300001);await f.service.tick();assert.equal(f.service.list(f.actor()).items.length,1);});
test('selected plan deletion is atomic, permission checked and idempotent',async t=>{
  const f=await setup(t),make=async name=>(await f.service.saveRule(f.actor(),null,{expectedRevision:0,name,type:'kda',scope,enabled:false,intervalMinutes:5},op())).rule;
  const a=await make('chosen A'),b=await make('chosen B'),c=await make('keep C');
  const rules=[a,b].map(r=>({id:r.id,expectedRevision:r.revision}));
  await assert.rejects(f.service.deleteRules(f.actor('alpha'),{rules},op()),{errorCode:'ACCESS_DENIED'});
  await assert.rejects(f.service.deleteRules(f.actor(),{rules:[rules[0],{...rules[1],expectedRevision:0}]},op()),{errorCode:'REVISION_CONFLICT'});
  assert.equal(f.service.repo.get('rule',a.id).deleted,undefined);
  await assert.rejects(f.service.deleteRules(f.actor(),{rules:[rules[0],rules[0]]},op()),{errorCode:'SYNC_INPUT_INVALID'});
  const receipt=op(),body={rules};const result=await f.service.deleteRules(f.actor(),body,receipt);
  assert.deepEqual(result.deletedRuleIds,[a.id,b.id]);assert.deepEqual(f.service.rules(f.actor()).items.map(r=>r.id),[c.id]);
  assert.deepEqual(await f.service.deleteRules(f.actor(),body,receipt),result);
  assert.deepEqual(f.service.operation(f.actor(),receipt.operationId),result);
  await assert.rejects(f.service.deleteRules(f.actor(),{rules:[rules[0]]},receipt),{errorCode:'IDEMPOTENCY_CONFLICT'});
});

test('Hexaytron retirement hides creation and plans, cancels persisted work, and preserves history and other sources',async t=>{
  const f=await setup(t),now=f.service.now();
  assert.ok(!f.service.sources(f.actor()).types.some(x=>x.id==='hexaytron_profile'));
  assert.ok(!f.service.sources(f.actor()).items.some(x=>x.id==='hexaytron'));
  await assert.rejects(f.service.request(f.actor(),{type:'hexaytron_profile',scope},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  await assert.rejects(f.service.saveRule(f.actor(),null,{expectedRevision:0,name:'retired',type:'hexaytron_profile',scope,enabled:true,intervalMinutes:5},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  await assert.rejects(f.service.saveSource(f.actor(),'steam_typo',{expectedRevision:1},op()),{errorCode:'SYNC_INPUT_INVALID'});
  await assert.rejects(f.service.saveSource(f.actor(),'hexaytron',{expectedRevision:1,paused:false},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  const rule={id:'legacy-hex-rule',type:'hexaytron_profile',enabled:true,nextRunAt:now+86400000,revision:3};f.service.repo.put('rule',rule);
  const template={id:'old-hex-job',type:'hexaytron_profile',source:'hexaytron',actorId:f.actor().id,scope,status:'queued',revision:2,generation:2,createdAt:now,updatedAt:now,deadlineAt:now+3600000,items:[{memberId:'g05_alpha',status:'succeeded'},{memberId:'g05_beta',status:'pending'}]};
  f.service.repo.put('job',template);f.service.repo.put('job',{...template,id:'finished-hex',status:'succeeded',items:[{memberId:'g05_alpha',status:'succeeded'}]});
  const historical=f.service.repo.get('job','finished-hex');
  f.service.repo.put('source',{id:'steam',source:'steam',paused:true,pauseReason:'MANUAL_PAUSE',revision:4,updatedAt:now});
  const steam=f.service.repo.get('source','steam');
  assert.equal(f.service.rules(f.actor()).items.length,0);await f.worker.step();await f.service.tick();
  const retired=f.service.repo.get('rule',rule.id),job=f.service.job(template.id);
  assert.equal(retired.deleted,true);assert.equal(retired.enabled,false);assert.equal(retired.errorCode,'SYNC_TYPE_RETIRED');
  assert.equal(job.status,'cancelled');assert.equal(job.items[0].status,'succeeded');assert.equal(job.items[1].status,'skipped');
  assert.equal(f.calls.length,0);assert.deepEqual(f.service.repo.get('source','steam'),steam);assert.deepEqual(f.service.repo.get('job','finished-hex'),historical);
  await assert.rejects(f.service.action(f.actor(),job.id,'continue',{expectedRevision:job.revision},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  const revision=job.revision;await f.worker.step();await f.service.tick();assert.equal(f.service.job(job.id).revision,revision);
});
test('retired local consistency source is absent and keeps only historical jobs',async t=>{
  const f=await setup(t),actor=f.actor(),now=f.service.now();
  f.service.repo.put('source',{id:'local',source:'local',paused:true,deleted:true,revision:3,updatedAt:now});
  assert.ok(!f.service.sources(actor).items.some(x=>x.id==='local'));
  assert.ok(!f.service.sources(actor).removedItems.some(x=>x.id==='local'));
  assert.ok(!f.service.sources(actor).types.some(x=>x.id==='local_consistency'));
  await assert.rejects(f.service.request(actor,{type:'local_consistency',scope},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  await assert.rejects(f.service.saveRule(actor,null,{expectedRevision:0,name:'old local',type:'local_consistency',scope,enabled:true,intervalMinutes:5},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  await assert.rejects(f.service.saveSource(actor,'local',{expectedRevision:3,restore:true},op()),{errorCode:'SYNC_TYPE_RETIRED'});
  const job={id:'old-local-job',type:'local_consistency',source:'local',actorId:actor.id,scope,status:'queued',revision:1,generation:0,createdAt:now,updatedAt:now,deadlineAt:now+3600000,items:[{memberId:'g05_alpha',status:'pending'}]};
  f.service.repo.put('job',job);
  await f.service.tick();
  assert.equal(f.service.detail(actor,job.id).status,'cancelled');
  assert.equal(f.service.detail(actor,job.id).reason,'SYNC_TYPE_RETIRED');
});
test('legacy Hexaytron migration preserves finished history but disables plans and active legacy jobs',async()=>{
  const { planSyncCenterMigration }=await import('../server/v2/sync-center/migration.js');
  const result=planSyncCenterMigration({syncJobs:[{id:'active',type:'hexaytron_profile',status:'running',totalCount:3,doneCount:1},{id:'done',type:'hexaytron_profile',status:'completed',totalCount:1,doneCount:1}],syncAutoRules:[{id:'rule',type:'hexaytron_profile',enabled:true}]});
  assert.equal(result.jobs[0].status,'cancelled');assert.equal(result.jobs[0].legacyCounts.succeeded,1);assert.equal(result.jobs[0].legacyCounts.skipped,2);
  assert.equal(result.jobs[1].status,'succeeded');assert.equal(result.rules[0].deleted,true);assert.equal(result.rules[0].enabled,false);
});
