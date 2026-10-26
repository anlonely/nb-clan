import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root, runtimeEnvironment, validateRuntimeEnvironment, optionsFrom } from './support/v2-admin-ui/config.mjs';
import { createNotificationDouble, targetFixtures } from './support/v2-admin-ui/notification-double.mjs';
import { seedIdentities, controlledProviders } from './support/v2-member-space/fixtures.mjs';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { planIdentityMigration, applyIdentityMigration } from '../server/v2/identity/migration.js';
import { SchedulingRepository, installSchedulingSchema } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { planSchedulingMigration, applySchedulingMigration } from '../server/v2/scheduling/migration.js';
async function setup(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());installIdentitySchema(db);const ir=new IdentityRepository(db);applyIdentityMigration(ir,planIdentityMigration({}));seedIdentities(ir);
 installSchedulingSchema(db);const sr=new SchedulingRepository(db);applySchedulingMigration(sr,planSchedulingMigration({}));
 const controlled=controlledProviders('http://127.0.0.1:4326'),identity=new IdentityService(ir,{providers:controlled.providers}),scheduling=new SchedulingService(sr,identity);
 for(const key of ['alpha','beta','leader','admin','foreign'])await identity.checkEligibility('discord',`discord_g05_${key}`);
 const actor=identity.actorForAccount('g05_account_admin'),now=Date.now(),at=h=>new Date(now+h*3600000).toISOString();
 const wipe=scheduling.createWipe(actor,{title:'Runtime fixture',description:'Synthetic description',serverProfileId:'fixture',serverSnapshot:{name:'Fixture'},serverScheduleSource:'manual',audience:{squadIds:['g05_squad'],memberIds:[],includeUnassigned:false},timeZone:'Asia/Shanghai',signupOpensAt:at(-1),signupClosesAt:at(3),musterAt:at(4),serverScheduledWipeAt:at(4),autoOpenSignup:false,autoStart:false},{operationId:'fixture-create'}).current;
 const service=createNotificationDouble({identity,scheduling});const input={expectedContentRevision:wipe.contentRevision,templateId:'wipe-notification',templateRevision:1,purpose:'signup_open',purposeInstance:'primary',repeatOfIntentId:null,reason:null,duplicateRiskAcknowledged:false,targets:targetFixtures.map(t=>({targetId:t.id,language:'zh-CN',mentionMode:'none',roleIds:[]})),audience:wipe.audience,schedule:null};
 const preview=()=>service.createPreview(actor,wipe.id,input,{operationId:'preview-1'}).current;
 const publish=()=>{const p=preview();return service.createIntent(actor,wipe.id,{previewId:p.id,contentHash:p.contentHash,expectedContentRevision:p.contentRevision,purpose:p.purpose,purposeInstance:p.purposeInstance},{operationId:'intent-1'}).current;};
 return {db,ir,sr,identity,scheduling,actor,wipe,service,input,preview,publish};
}
const code=(errorCode)=>error=>error.errorCode===errorCode;
test('runtime environment discards inherited credentials, proxies and custom Node options',()=>{
 const env=runtimeEnvironment(path.join(root,'work/g06-a/runtime-test'),{port:0},{PATH:'/usr/bin:/bin',DISCORD_TOKEN:'do-not-inherit',HTTP_PROXY:'http://example.invalid',NODE_OPTIONS:'--require=evil'});
 assert.equal(env.DISCORD_TOKEN,undefined);assert.equal(env.HTTP_PROXY,undefined);assert.match(env.NODE_OPTIONS,/loopback-only/);assert.equal(env.NB_DISABLE_BACKGROUND_JOBS,'1');assert.equal(env.NB_STORAGE_MODE,'sqlite-primary');validateRuntimeEnvironment(env);
});
test('runtime validation rejects changed paths, extra environment and invalid ports',()=>{
 const env=runtimeEnvironment(path.join(root,'work/g06-a/runtime-test'));
 assert.throws(()=>validateRuntimeEnvironment({...env,SECRET:'x'}),/Unexpected inherited/);assert.throws(()=>validateRuntimeEnvironment({...env,NB_SQLITE_FILE:'/tmp/existing.sqlite'}),/Unsafe/);
 assert.throws(()=>runtimeEnvironment('/isolated-forbidden-production-data'));assert.throws(()=>optionsFrom(['--port','80']));assert.throws(()=>optionsFrom(['--host','0.0.0.0']));
});
test('admin list uses real G04 safe DTO and scoped catalog, not fixture wipe arrays',async t=>{
 const {service,actor,wipe,identity}=await setup(t);assert.equal(service.listAdminWipes(actor).items[0].wipe.id,wipe.id);assert.equal(service.listAdminWipes(actor).countScope,'authorized_wipes');
 const foreign=identity.actorForAccount('g05_account_foreign');assert.equal(service.listAdminWipes(foreign).items.length,0);assert.ok(service.listWipeOptions(actor,{kind:'members'}).items.some(m=>m.id==='g05_beta'));
});
test('notification options exactly expose frozen targets without transport secrets',async t=>{
 const {service,actor,wipe}=await setup(t),opts=service.getOptions(actor,wipe.id);assert.equal(opts.targets.length,2);assert.equal(opts.targets[0].runtimeMode,'isolated');assert.equal(opts.templates[0].revision,1);assert.equal('transportKey' in opts.targets[0],false);
});
test('preview double persists SQLite state and does not create a wipe or delivery',async t=>{
 const x=await setup(t),count=x.sr.all('wipes').length,p=x.preview();assert.equal(x.sr.all('wipes').length,count);assert.equal(x.service.inspect().deliveries.length,0);assert.equal(p.targets[0].selection.mentionMode,'none');assert.equal(p.targets[0].warnings[0].code,'CONTRACT_DOUBLE');
 const reopened=createNotificationDouble(x);assert.equal(reopened.getOperation(x.actor,'preview-1').current.id,p.id);
});
test('preview rejects unknown fields, unsupported language, role IDs and audience expansion',async t=>{
 const x=await setup(t),run=input=>x.service.createPreview(x.actor,x.wipe.id,input,{operationId:'invalid-preview'});
 assert.throws(()=>run({...x.input,extra:true}),code('NOTIFICATION_INPUT_INVALID'));
 assert.throws(()=>run({...x.input,targets:[{...x.input.targets[0],language:'fr'}]}),code('LANGUAGE_UNSUPPORTED'));
 assert.throws(()=>run({...x.input,targets:[{...x.input.targets[0],mentionMode:'roles',roleIds:['foreign-role']}]}),code('MENTION_INVALID'));
 assert.throws(()=>run({...x.input,audience:{squadIds:[],memberIds:['g05_foreign'],includeUnassigned:false}}),code('NOTIFICATION_AUDIENCE_DENIED'));
});
test('same operation key replays current resource and changed body conflicts',async t=>{
 const x=await setup(t),p=x.preview();assert.equal(x.service.createPreview(x.actor,x.wipe.id,x.input,{operationId:'preview-1'}).replayed,true);
 assert.throws(()=>x.service.createPreview(x.actor,x.wipe.id,{...x.input,purpose:'reminder'},{operationId:'preview-1'}),code('IDEMPOTENCY_CONFLICT'));
 assert.equal(x.service.getOperation(x.actor,'preview-1').current.id,p.id);assert.throws(()=>x.service.getOperation(x.actor,'temporarily-unseen'),code('RESOURCE_NOT_FOUND'));
});
test('content changes stale the preview before intent creation',async t=>{
 const x=await setup(t),p=x.preview();x.scheduling.updateWipe(x.actor,x.wipe.id,{expectedRevision:x.wipe.revision,description:'changed'},{operationId:'edit-1'});
 assert.throws(()=>x.service.createIntent(x.actor,x.wipe.id,{previewId:p.id,contentHash:p.contentHash,expectedContentRevision:p.contentRevision,purpose:p.purpose,purposeInstance:p.purposeInstance},{operationId:'send-1'}),code('PREVIEW_STALE'));
});
test('per-target mixed sent and unknown retains needs_attention, no invented message URL',async t=>{
 const x=await setup(t),intent=x.publish(),ids=intent.deliveryIds;
 x.service.control({deliveryId:ids[0],status:'sent',messageId:'constructed-message'});x.service.control({deliveryId:ids[1],status:'delivery_unknown'});
 const result=x.service.getIntent(x.actor,intent.id);assert.equal(result.intent.status,'needs_attention');assert.equal(result.intent.counts.sent,1);assert.equal(result.intent.counts.delivery_unknown,1);assert.equal(result.deliveries[0].messageRefs[0].messageUrl,null);
});
test('unknown is excluded from retry while proven failed can be queued',async t=>{
 const x=await setup(t),intent=x.publish(),ids=intent.deliveryIds;x.service.control({deliveryId:ids[0],status:'failed'});x.service.control({deliveryId:ids[1],status:'delivery_unknown'});
 const current=x.service.getIntent(x.actor,intent.id).intent,result=x.service.retryFailed(x.actor,intent.id,{expectedRevision:current.revision,reason:'Isolated retry'},{operationId:'retry-1'}).current;
 assert.deepEqual(result.queuedIds,[ids[0]]);assert.deepEqual(result.skippedIds,[ids[1]]);assert.throws(()=>x.service.commandDelivery(x.actor,ids[1],'retry',{expectedRevision:2,reason:'Unsafe retry'},{operationId:'retry-2'}),code('DELIVERY_NOT_RETRYABLE'));
});
test('unknown lookup remains unknown until explicit evidence, then known failure is retryable',async t=>{
 const x=await setup(t),id=x.publish().deliveryIds[0];x.service.control({deliveryId:id,status:'delivery_unknown'});
 let d=x.service.commandDelivery(x.actor,id,'reconcile',{expectedRevision:2,decision:'request_lookup',reason:'Inspect synthetic provider',evidence:'',messageRef:null},{operationId:'lookup-1'}).current;
 assert.equal(d.status,'delivery_unknown');assert.equal(x.service.getDelivery(x.actor,id).messageOperations[0].status,'unknown');
 d=x.service.commandDelivery(x.actor,id,'reconcile',{expectedRevision:d.revision,decision:'confirmed_not_sent',reason:'Checked fixture',evidence:'Synthetic channel history has no matching delivery',messageRef:null},{operationId:'reconcile-1'}).current;
 assert.equal(d.status,'failed');assert.equal(d.actions.retry,true);
});
test('explicit repeat requires original unknown target, non-primary instance, reason and acknowledgement',async t=>{
 const x=await setup(t),intent=x.publish(),id=intent.deliveryIds[0];x.service.control({deliveryId:id,status:'delivery_unknown'});
 const repeat={...x.input,purposeInstance:'explicit-repeat-1',repeatOfIntentId:intent.id,reason:'Synthetic provider cannot prove result',targets:[x.input.targets[0]]};
 assert.throws(()=>x.service.createPreview(x.actor,x.wipe.id,repeat,{operationId:'repeat-1'}),code('DUPLICATE_RISK_NOT_ACKNOWLEDGED'));
 assert.ok(x.service.createPreview(x.actor,x.wipe.id,{...repeat,duplicateRiskAcknowledged:true},{operationId:'repeat-2'}).current.id);
});
test('current revocation invalidates stale actor and admin demotion blocks notification writes',async t=>{
 const x=await setup(t);x.preview();x.identity.revokeAccountScope(x.actor.id,'fixture-change');assert.throws(()=>x.service.getOperation(x.actor,'preview-1'),code('PERMISSIONS_CHANGED'));
 const account=x.ir.get('accounts',x.actor.id);x.ir.put('accounts',{...account,roleId:'member',adminAssignedByOwner:false,grants:[...account.grants,{capability:'notifications.preview',effect:'deny',scope:{type:'platformTargets',ids:['g06_discord']}}]});
 const current=x.identity.actorForAccount(x.actor.id);assert.equal(x.service.getOptions(current,x.wipe.id).targets.length,0);assert.throws(()=>x.service.createPreview(current,x.wipe.id,x.input,{operationId:'deny-preview'}),code('ACCESS_DENIED'));
});
test('same canonical business snapshot maps different operation keys to the original intent',async t=>{
 const x=await setup(t),p=x.preview(),body={previewId:p.id,contentHash:p.contentHash,expectedContentRevision:p.contentRevision,purpose:p.purpose,purposeInstance:p.purposeInstance};
 const first=x.service.createIntent(x.actor,x.wipe.id,body,{operationId:'publish-first'}),second=x.service.createIntent(x.actor,x.wipe.id,body,{operationId:'publish-second'});
 assert.equal(second.current.id,first.current.id);assert.equal(second.replayed,true);assert.equal(x.service.inspect().deliveries.length,2);assert.equal(x.service.getOperation(x.actor,'publish-second').current.id,first.current.id);
});
test('confirmed sent accepts frozen PlatformMessageRef input and emits full MessageRefDTO',async t=>{
 const x=await setup(t),id=x.publish().deliveryIds[0];x.service.control({deliveryId:id,status:'delivery_unknown'});
 const t0=targetFixtures[0];const result=x.service.commandDelivery(x.actor,id,'reconcile',{expectedRevision:2,decision:'confirmed_sent',reason:'Synthetic proof inspected',evidence:'Fixture provider record confirmed',messageRef:{platform:t0.platform,guildId:t0.guildId,channelId:t0.channelId,messageId:'synthetic-found-message',messageUrl:null}},{operationId:'confirm-sent'}).current;
 assert.equal(result.status,'sent');assert.equal(result.messageRefs[0].contentRevision,x.wipe.contentRevision);assert.equal(result.messageRefs[0].state,'active');assert.ok(result.messageRefs[0].id);
});
test('explicit eligibility refresh lasts one hour; roster membership remains stable without refreshing expired evidence',async t=>{
 const { fixtureEligibilityTtlMs,refreshFixtureEligibility }=await import('./support/v2-admin-ui/fixture-eligibility.mjs');
 const x=await setup(t);let clock=Date.now();x.identity.now=()=>clock;x.scheduling.now=()=>clock;x.identity.eligibilityTtl=fixtureEligibilityTtlMs;
 const refreshed=await refreshFixtureEligibility(x.identity);assert.equal(refreshed.count,10);assert.equal(refreshed.eligibilityTtlMs,3600000);
 assert.ok(refreshed.refreshed.every(row=>Date.parse(row.expiresAt)-Date.parse(row.checkedAt)===3600000));
 clock+=8*60*1000;assert.equal(x.scheduling.summary(x.actor,x.wipe.id).counts.eligibleTotal,4);
 clock+=60*60*1000;const before=x.ir.all('eligibility');assert.equal(x.scheduling.summary(x.actor,x.wipe.id).counts.eligibleTotal,4);assert.deepEqual(x.ir.all('eligibility'),before);
 const restored=await refreshFixtureEligibility(x.identity);assert.equal(restored.count,10);assert.equal(x.scheduling.summary(x.actor,x.wipe.id).counts.eligibleTotal,4);
 await assert.rejects(refreshFixtureEligibility(x.identity,{fixture:'not-a-fixture'}),code('FIXTURE_INVALID'));
});
