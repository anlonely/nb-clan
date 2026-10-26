import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-forward-reconcile/fixture.mjs';
import { createForwardingAdapter } from '../server/v2/platform-admin/forwarding.js';
import { createG06MessageGateway } from '../server/v2/platform-admin/cards.js';
import { grant } from '../server/v2/identity/permissions.js';
async function setup(t){const f=await fixture();t.after(()=>f.close());return f;}
const error=code=>e=>e.errorCode===code;
async function lost(f){f.transport.enqueue({kind:'response_lost',operation:'send'});const r=await f.run();assert.equal(r.result.counts.unknown,1);return f.record();}
async function knownLost(f){
 const original=f.ir.get('accounts','admin');
 f.hooks.afterSend=()=>{f.ir.put('accounts',{...original,roleId:'member',adminAssignedByOwner:false,permissionVersion:original.permissionVersion+1,grants:original.grants.filter(g=>g.capability!=='platforms.configure')});};
 await f.run();f.hooks.afterSend=null;f.ir.put('accounts',original);
 assert.equal(f.record().status,'unknown');assert.equal(f.record().delivery.outcome,'sent');return f.record();
}
test('lost native send response preserves unknown with no ID; reconcile and duplicate run never resend',async t=>{
 const f=await setup(t);const r=await lost(f);assert.equal(f.transport.getMessages().length,1);assert.ok(r.dispatch.payloadHash);assert.equal(r.delivery.outcome,'unknown');
 const reconciled=await f.reconcile('no-id-reconcile');assert.equal(reconciled.result.state,'unknown');assert.equal(reconciled.result.items[0].label,'NO_EXACT_MESSAGE_REFERENCE');
 await f.reconcile('another-no-id');await f.run();await f.run();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,1);assert.equal(f.record().status,'unknown');
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='lookup').length,0);
});
test('persisted exact G06 receipt survives post-send revocation; native lookup confirms delivered',async t=>{
 const f=await setup(t),r=await knownLost(f);const result=await f.reconcile('known-ref-reconcile');
 assert.equal(result.result.state,'succeeded');assert.equal(result.result.items[0].label,'EXACT_MESSAGE_REFERENCE_FOUND');
 assert.equal(f.record().status,'succeeded');assert.equal(f.record().messageId,r.delivery.messageRef.messageId);
 assert.equal(f.transport.getCalls().at(-1).operation,'lookup');await f.run();assert.equal(f.transport.getMessages().length,1);
 assert.ok(f.platformService.repo.get('forward-echo',(await import('../server/v2/platform-admin/model.js')).hash({platform:r.to,channel:r.destination,messageId:f.record().messageId})));
});
test('missing/deleted exact message ID remains unknown and cannot authorize retry',async t=>{
 const f=await setup(t),r=await knownLost(f);f.transport.deleteMessage(r.delivery.messageRef);
 const result=await f.reconcile();assert.equal(result.result.state,'unknown');assert.equal(f.record().status,'unknown');await f.run();assert.equal(f.transport.getMessages().length,1);
});
test('unsupported lookup, malformed lookup not_sent and timeout cannot prove original non-delivery',async t=>{
 const f=await setup(t);await knownLost(f);
 f.transport.enqueue({kind:'lookup_unsupported',operation:'lookup'});assert.equal((await f.reconcile()).result.state,'unknown');
 f.hooks.lookup=()=>({outcome:'not_sent',errorCode:'DISCORD_REJECTED_10008'});assert.equal((await f.reconcile()).result.state,'unknown');f.hooks.lookup=null;
 f.transport.enqueue({kind:'response',operation:'lookup',response:{status:200,headers:{},body:{code:0,data:{id:'wrong',channel_id:'foreign'}}}});
 assert.equal((await f.reconcile()).result.state,'unknown');assert.equal(f.record().status,'unknown');await f.run();assert.equal(f.transport.getMessages().length,1);
});
test('reliable original native rate-limit not_sent permits one explicit retry, preserving record and old receipt',async t=>{
 const f=await setup(t);f.transport.enqueue({kind:'rate_limit',operation:'send'});const failed=await f.run();assert.equal(failed.result.counts.failed,1);assert.equal(f.record().delivery.outcome,'not_sent');
 const key=f.record().key,reconciled=await f.reconcile('safe-retry-reconcile');assert.equal(reconciled.result.items[0].status,'retry_ready');assert.equal(f.record().status,'retry_ready');
 const replay=await f.reconcile('safe-retry-reconcile');assert.equal(replay.replayed,true);assert.equal(f.record().key,key);
 await f.run();assert.equal(f.record().status,'succeeded');assert.equal(f.record().attempt,2);assert.equal(f.transport.getMessages().length,1);
 await f.reconcile('safe-retry-reconcile');assert.equal(f.record().status,'succeeded');assert.equal(f.record().attempt,2);await f.run();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,2);
});
test('legacy failed flag without original not_sent proof stays unknown',async t=>{
 const f=await setup(t);await lost(f);const r=f.record();delete r.version;delete r.phase;delete r.delivery;delete r.dispatch;r.status='failed';f.update(r);
 const result=await f.reconcile();assert.equal(result.result.state,'unknown');assert.equal(f.record().status,'unknown');await f.run();assert.equal(f.transport.getMessages().length,1);
});
test('record binding rejects body target/route overrides and current disabled/changed routes',async t=>{
 const f=await setup(t);await lost(f);const key=f.record().key;
 for(const field of ['messageId','routeId','targetId','destination']){
  const r=await f.call('forward_reconcile',{recordId:key,[field]:'forged'});assert.equal(r.status,'result_unknown');assert.equal(r.errorCode,'FORWARD_RECONCILE_INPUT_INVALID');
 }
 const c=f.platformService.config('bridge');f.platformService.repo.put('config','bridge','bridge','admin',f.now(),{...c,routes:c.routes.map(r=>({...r,enabled:false}))});
 await assert.rejects(f.reconcile(),error('FORWARD_ROUTE_CHANGED'));assert.equal(f.transport.getCalls().length,1);
});
test('bridge config revision, disabled destination and destination target replacement reject before lookup',async t=>{
 const f=await setup(t);await knownLost(f);const c=f.platformService.config('kook');
 f.platformService.repo.put('config','kook','kook','admin',f.now(),{...c,targets:c.targets.map(t=>({...t,enabled:false}))});
 await assert.rejects(f.reconcile(),error('PLATFORM_TARGET_SCOPE_MISMATCH'));
 f.platformService.repo.put('config','kook','kook','admin',f.now(),{...c,revision:c.revision+1});
 assert.equal((await f.reconcile()).errorCode,'FORWARD_TARGET_CHANGED');
 f.platformService.repo.put('config','kook','kook','admin',f.now(),c);const bridge=f.platformService.config('bridge');f.platformService.repo.put('config','bridge','bridge','admin',f.now(),{...bridge,revision:bridge.revision+1});
 await assert.rejects(f.reconcile(),error('FORWARD_CONFIG_CHANGED'));assert.equal(f.transport.getCalls().filter(c=>c.operation==='lookup').length,0);
});
test('stored custom grants cannot promote a member into bridge reconciliation',async t=>{
 const f=await setup(t);await lost(f);const admin=f.ir.get('accounts','admin');
 const a={...admin,id:'limited',roleId:'member',adminAssignedByOwner:false,legacyUserId:undefined,memberId:null,grants:[grant('platforms.configure',{type:'platformTargets',ids:['discord_kook_bridge']}),grant('notifications.reconcile',{type:'platformTargets',ids:['discord-target']})]};
 f.ir.put('accounts',a);await assert.rejects(f.call('forward_reconcile',{recordId:f.record().key},'limited-call',f.identity.actorForAccount('limited')),error('ACCESS_DENIED'));
 f.ir.put('accounts',{...a,grants:[...a.grants,grant('notifications.reconcile',{type:'all'}),grant('notifications.reconcile',{type:'platformTargets',ids:['kook-target']},{effect:'deny'})]});
 await assert.rejects(f.call('forward_reconcile',{recordId:f.record().key},'deny-call',f.identity.actorForAccount('limited')),error('ACCESS_DENIED'));
});
test('inflight lookup target mutation fences found response and preserves unknown',async t=>{
 const f=await setup(t);await knownLost(f);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.hooks.beforeLookup=async()=>{entered();await gate;};const pending=f.reconcile();await ready;
 const config=f.platformService.config('kook');f.platformService.repo.put('config','kook','kook','admin',f.now(),{...config,revision:config.revision+1});release();
 const r=await pending;assert.equal(r.status,'result_unknown');assert.equal(f.record().status,'unknown');assert.equal(f.record().reconciliation.evidence,'RECONCILIATION_INTERRUPTED');
});
test('inflight revocation prevents accepting lookup result; same actor command receipt cannot bypass admin demotion',async t=>{
 const f=await setup(t);await knownLost(f);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.hooks.beforeLookup=async()=>{entered();await gate;};const pending=f.reconcile('revoked-reconcile');await ready;
 const a=f.ir.get('accounts','admin');f.ir.put('accounts',{...a,roleId:'member',adminAssignedByOwner:false,permissionVersion:a.permissionVersion+1,grants:a.grants});release();
 assert.equal((await pending).status,'result_unknown');assert.equal(f.record().status,'unknown');
 await assert.rejects(f.reconcile('revoked-reconcile'),error('ACCESS_DENIED'));
 assert.throws(()=>f.platformService.receipt(f.actor('admin'),'revoked-reconcile'),error('ACCESS_DENIED'));
 // Host wraps both fast replay and adapter dispatch because the frozen ACTIONS entry lacks extra.
 await assert.rejects(f.host.adapters.forwarding.reconcile({actor:f.actor('admin'),config:f.platformService.config('bridge'),input:{recordId:f.record().key},operationId:'new-revoked',assertCurrent:()=>f.actor('admin')}),error('ACCESS_DENIED'));
});
test('host stop aborts native lookup and drains logical operation without updating delivery',async t=>{
 const f=await setup(t);await knownLost(f);f.transport.enqueue({kind:'timeout',operation:'lookup'});
 const pending=f.reconcile();while(!f.transport.getCalls().some(c=>c.operation==='lookup'))await new Promise(r=>setImmediate(r));
 await f.host.stop();const result=await pending;assert.equal(result.status,'result_unknown');assert.equal(f.record().status,'unknown');assert.equal(f.host.diagnostics().operations,0);assert.equal(f.host.diagnostics().externalCalls,0);
 assert.equal(f.db.prepare('SELECT 1 n').get().n,1);assert.equal(f.transport.getMessages().length,1);
});
test('owner bounds timeout as unknown, tracks reconcile and waits for noncooperative lookup completion on stop',async t=>{
 const f=await setup(t);await lost(f);let release,entered;const ready=new Promise(r=>entered=r);
 const owner=createForwardingAdapter({db:f.db,timeoutMs:20,source:{},messages:{reconcile:()=>{entered();return new Promise(r=>release=r);}}});
 const pending=owner.reconcile({actor:f.actor('admin'),config:f.platformService.config('bridge'),input:{recordId:f.record().key},operationId:'owner-drain',assertCurrent:()=>{}});const rejected=assert.rejects(pending,/FORWARD_IO_ABORTED/);await ready;
 let stopped=false;const stop=owner.stop().then(()=>stopped=true);await rejected;assert.equal(stopped,false);release({state:'unknown'});await stop;assert.equal(stopped,true);assert.equal(f.record().status,'unknown');
});
test('owner original preparation failure is provably not dispatched; fabricated lookup absence cannot erase claim',async t=>{
 const f=await setup(t),config=structuredClone(f.platformService.config('bridge'));config.routes[0].translate=true;
 f.platformService.repo.put('config','bridge','bridge','admin',f.now(),config);
 const gateway=createG06MessageGateway({platforms:f.platforms,targets:f.targets});
 const owner=createForwardingAdapter({db:f.db,messages:gateway,source:{read:async()=>f.sourcePages.get('discord:200000000000000001')},translate:async()=>{throw Error('preparation failed');}});t.after(()=>owner.stop());
 await owner.run({actor:f.actor('admin'),config,input:{},operationId:'prepare-fail',assertCurrent:()=>{}});assert.equal(f.record().delivery.kind,'local-not-dispatched');assert.equal(f.transport.getCalls().length,0);
 const result=await owner.reconcile({actor:f.actor('admin'),config,input:{recordId:f.record().key},operationId:'prepare-reconcile',assertCurrent:()=>{}});assert.equal(result.items[0].status,'retry_ready');assert.equal(f.record().status,'retry_ready');
});
test('native Discord/KOOK exact nonexistent IDs remain unknown; no lookup by attempt proves absence',async t=>{
 const f=await setup(t),gateway=createG06MessageGateway({platforms:f.native,targets:f.targets});
 for(const platform of ['discord','kook']){
  const target=f.targets().find(x=>x.platform===platform);
  const result=await gateway.reconcile({record:{to:platform,destination:target.channelId,messageId:'nonexistent-message'},operationId:`forward:missing-${platform}`,assertCurrent:()=>{}});
  assert.equal(result.state,'unknown');assert.equal(result.evidence,'LOOKUP_UNCONFIRMED');
 }
 assert.equal(f.transport.getCalls().length,2);assert.ok(f.transport.getCalls().every(c=>c.operation==='lookup'));
});
test('unsupported lookup method and native server error after storing a message retain unknown',async t=>{
 const f=await setup(t);f.transport.enqueue({kind:'server_error',operation:'send',storeBeforeResponse:true});await f.run();assert.equal(f.transport.getMessages().length,1);
 f.platforms.kook.lookup=undefined;const result=await f.reconcile();assert.equal(result.result.state,'unknown');assert.equal(result.result.items[0].label,'LOOKUP_UNSUPPORTED');
 await f.run();assert.equal(f.transport.getMessages().length,1);
});
test('fabricated not_delivered from custom lookup never clears an unproven original attempt',async t=>{
 const f=await setup(t);await lost(f);const key=f.record().key;
 const owner=createForwardingAdapter({db:f.db,messages:{reconcile:async()=>({state:'not_delivered',proof:'G06_NOT_SENT'})},source:{}});t.after(()=>owner.stop());
 const result=await owner.reconcile({actor:f.actor('admin'),config:f.platformService.config('bridge'),input:{recordId:key},operationId:'false-absence',assertCurrent:()=>{}});
 assert.equal(result.state,'unknown');assert.equal(result.items[0].label,'ABSENCE_DOES_NOT_PROVE_NOT_SENT');assert.equal(f.record().key,key);assert.equal(f.record().status,'unknown');
});
test('direct reconcile same-key replay and simultaneous calls cannot advance/delete a later attempt',async t=>{
 const f=await setup(t);f.transport.enqueue({kind:'rate_limit',operation:'send'});await f.run();const key=f.record().key;
 const args={actor:f.actor('admin'),config:f.platformService.config('bridge'),input:{recordId:key},operationId:'direct-replay',assertCurrent:()=>f.actor('admin')};
 const first=await f.host.adapters.forwarding.reconcile(args);await f.run();assert.equal(f.record().attempt,2);
 const second=await f.host.adapters.forwarding.reconcile(args);assert.deepEqual(second,first);assert.equal(f.record().status,'succeeded');
 assert.equal(f.transport.getMessages().length,1);
});
test('authenticated loopback HTTP exposes real conservative reconcile and checks CSRF/current target on replay',async t=>{
 const f=await setup(t);await lost(f);const app=express(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`,auth=createIdentityRouter({service:f.identity,origin,providers:{}});
 app.use('/api/v2',(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:opts=>auth.authenticate(opts)(req)};next();});app.use('/api/v2',f.host.adminRouter);
 t.after(async()=>{await auth.stopEvents();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const session=await authenticatedSession(f.identity,'admin');
 const headers={Cookie:`nb_v2_session=${session.token}`,Origin:origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json','Idempotency-Key':'http-reconcile'};
 const send=h=>fetch(origin+'/api/v2/platform-admin/bridge/actions/forward_reconcile',{method:'POST',headers:h,body:JSON.stringify({expectedRevision:1,recordId:f.record().key})});
 assert.equal((await send({...headers,'X-CSRF-Token':'bad'})).status,403);
 const response=await send(headers);assert.equal(response.status,200);const result=await response.json();assert.equal(result.data.result.state,'unknown');
 assert.equal((await (await send(headers)).json()).data.replayed,true);
 const a=f.ir.get('accounts','admin');f.ir.put('accounts',{...a,roleId:'member',adminAssignedByOwner:false,permissionVersion:a.permissionVersion+1,grants:a.grants});
 assert.equal((await send(headers)).status,401);
 const renewed=await authenticatedSession(f.identity,'admin');assert.equal((await send({...headers,Cookie:`nb_v2_session=${renewed.token}`,'X-CSRF-Token':renewed.csrfToken})).status,403);
 assert.equal(f.transport.getMessages().length,1);
});
test('concurrent reconciliation keys fence stale lookup and never create another send',async t=>{
 const f=await setup(t);await lost(f);
 const results=await Promise.all([f.reconcile('concurrent-one'),f.reconcile('concurrent-two')]);
 assert.ok(results.every(r=>r.status==='result_unknown'||r.result?.state==='unknown'));
 assert.equal(f.record().status,'unknown');await f.run();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,1);
});
test('same-attempt delivery progress during lookup fences stale unknown without downgrading confirmed success',async t=>{
 const f=await setup(t);await knownLost(f);let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.hooks.beforeLookup=async()=>{entered();await gate;};f.hooks.lookup=()=>({outcome:'unknown',errorCode:'LOOKUP_UNCONFIRMED'});
 const pending=f.reconcile('progress-during-lookup');await ready;const r=f.record();f.update({...r,status:'succeeded',messageId:r.delivery.messageRef.messageId});release();
 assert.equal((await pending).status,'result_unknown');assert.equal(f.record().status,'succeeded');await f.run();assert.equal(f.transport.getMessages().length,1);
});
