import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/v2-native-interactions/fixture.mjs';
import {grant} from '../server/v2/identity/permissions.js';
import {retainedDiscordCommandSchemas} from '../server/v2/notification-platforms/native-interactions.js';
const setup=async t=>{const f=await fixture();t.after(()=>f.close());const listTargets=f.notifications.catalog.listTargets;f.notifications.catalog.listTargets=()=>listTargets().map(target=>({...target,languages:target.platform==='discord'?['zh-CN','en']:target.languages}));f.notifications.catalog.getTarget=id=>f.notifications.catalog.listTargets().find(target=>target.id===id);return f;};
test('signed Discord VIP open/provider/modal/submit stays self-only, version-bound and replay-safe',async t=>{
 const f=await setup(t),d=f.discord;
 const open=await f.send('discord',d('vip-open',3,{component_type:2,custom_id:'nb_vital_vip:open'}));assert.equal(open.ack.type,4);assert.equal(open.ack.data.flags,64);
 const provider=await f.send('discord',d('vip-provider',3,{component_type:3,custom_id:'nb_vital_vip:provider',values:['atlas']}));assert.ok(provider.ack.data.components[0].components[0].options.some(o=>o.value==='priority'));
 const modalEvent=d('vip-type',3,{component_type:3,custom_id:'nb_vital_vip:type:atlas',values:['priority']}),modal=await f.send('discord',modalEvent);assert.equal(modal.ack.type,9);const custom_id=modal.ack.data.custom_id;
 assert.deepEqual((await f.send('discord',modalEvent)).ack,modal.ack);
 const before=f.ir.get('members','m002'),submit=d('vip-submit',5,{custom_id,components:[{type:18,component:{type:3,custom_id:'date_month',values:['9']}},{type:18,component:{type:4,custom_id:'date_day',value:'8'}}]});
 f.transport.enqueue({platform:'discord',operation:'private',kind:'response_lost'});await assert.rejects(f.send('discord',submit),e=>e.errorCode==='PRIVATE_RESPONSE_UNKNOWN');const after=f.ir.get('members','m002');assert.equal(after.atlasVipType,'priority');assert.equal(after.revision,before.revision+1);
 assert.match((await f.send('discord',submit)).reply.payload.content,/Your VIP information has been saved/);assert.equal(f.ir.get('members','m002').revision,after.revision);
 const other=structuredClone(submit);other.id='vip-other';other.member.user.id='native-other';await f.send('discord',other);assert.equal(f.ir.get('members','m036').atlasVipType,undefined);
 const wrong=await f.send('discord',d('vip-wrong',3,{component_type:2,custom_id:'nb_vital_vip:open'},'member','outside'));assert.match(wrong.ack.data.content,/Could not open/);
 const staleModal=await f.send('discord',d('vip-stale-modal',3,{component_type:3,custom_id:'nb_vital_vip:type:atlas',values:['queue_skip']}));f.ir.put('members',{...after,revision:after.revision+1});const staleSubmit={...submit,id:'vip-stale',data:{...submit.data,custom_id:staleModal.ack.data.custom_id}};assert.ok(!(await f.send('discord',staleSubmit)).reply.payload.content.includes('has been saved'));assert.equal(f.ir.get('members','m002').atlasVipType,'priority');
 // Accounts now derive grants from their effective role. Inject the explicit
 // deny at that actor boundary while retaining the real role and self rules.
 const readActor=f.identity.readActorForAccount.bind(f.identity);f.identity.readActorForAccount=id=>{const actor=readActor(id);return id==='member'?{...actor,grants:[...actor.grants,grant('members.basic_edit',{type:'self'},{effect:'deny'})]}:actor;};
 const vipWrites=()=>['v2_member_admin_meta','v2_member_admin_operations','v2_member_admin_history','v2_member_admin_outbox'].map(name=>f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
 const beforeDenied=f.ir.get('members','m002'),beforeWrites=vipWrites(),deny=await f.send('discord',d('vip-deny',3,{component_type:3,custom_id:'nb_vital_vip:type:atlas',values:['none']}));assert.match(deny.reply.payload.content,/ACCESS_DENIED/);assert.ok(!deny.reply.payload.content.includes('has been saved'));assert.deepEqual(f.ir.get('members','m002'),beforeDenied);assert.deepEqual(vipWrites(),beforeWrites);
 assert.equal(f.transport.getCalls().length,0);
});
test('configured attendance slash requires explicit wipe and G06 permissions; original worker owns send/unknown',async t=>{
 const f=await setup(t),event=f.discord('wipe-slash',2,{name:'gather',options:[{name:'wipe',type:3,value:'host-wipe'}]},'admin');
 assert.deepEqual(retainedDiscordCommandSchemas(f.platformService.config('discord')).find(c=>c.name==='gather').options.map(o=>[o.name,o.type,o.required]),[['wipe',3,true],['mention_everyone',5,false]]);
 const queued=await f.send('discord',event);assert.match(queued.reply.payload.content,/queued/);assert.equal(f.transport.getCalls().length,0);
 const delivery=f.notifications.repo.all('deliveries')[0];assert.equal(delivery.wipeId,'host-wipe');assert.equal(delivery.status,'queued');assert.ok(delivery.actionReferenceIds.length);
 await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.notifications.repo.get('deliveries',delivery.id).status,'sent');await f.worker.runOnce({workerId:'native-worker',limit:10});await f.send('discord',event);assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,1);
 const unknownEvent={...event,id:'wipe-unknown',data:{...event.data,options:[{name:'wipe',type:3,value:'other-wipe'}]}};await f.send('discord',unknownEvent);const unknownDelivery=f.notifications.repo.all('deliveries').find(d=>d.wipeId==='other-wipe');
 f.transport.enqueue({platform:'discord',operation:'send',targetId:'discord-target',kind:'response_lost'});await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.notifications.repo.get('deliveries',unknownDelivery.id).status,'delivery_unknown');
 await f.send('discord',unknownEvent);await f.send('discord',{...unknownEvent,id:'wipe-again'});await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,2);assert.equal(f.notifications.repo.all('deliveries').length,2);
 const count=f.notifications.repo.all('intents').length;
 await f.send('discord',f.discord('wipe-deny',2,event.data,'member'));await f.send('discord',f.discord('wipe-channel',2,event.data,'admin','outside'));await f.send('discord',f.discord('wipe-unconfigured',2,{...event.data,name:'unknown'},'admin'));assert.equal(f.notifications.repo.all('intents').length,count);
 await assert.rejects(f.send('discord',f.discord('wipe-empty',2,{name:'gather',options:[]},'admin')),e=>e.errorCode==='PLATFORM_PAYLOAD_INVALID');
});
test('KOOK metric callback edits exact persistent message through original worker, checks scope and blocks unknown retry',async t=>{
 const f=await setup(t),actor=f.actor('admin'),input={expectedRevision:2,targetId:'kook-target',cardType:'ranking',wipeId:'host-wipe'};
 const p=(await f.platformService.execute(actor,'kook','card_preview',input,{operationId:'ranking-preview'})).result.preview;
 const q=await f.platformService.execute(actor,'kook','card_publish',{...input,previewId:p.id,contentHash:p.contentHash},{operationId:'ranking-publish'});assert.equal(q.status,'queued');
 await f.worker.runOnce({workerId:'native-worker',limit:10});await f.worker.runOnce({workerId:'native-worker',limit:10});const message=f.transport.getMessages()[0];assert.ok(JSON.stringify(message.payload).includes('nb_kook_member_ranking:metric:rockets'));
 const event=f.kook('kook-100',message.messageId),before=f.transport.getCalls().length;
 const reply=await f.send('kook',event);assert.match(reply.reply.payload.content,/已排队/);assert.equal(f.transport.getCalls().length,before);
 await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.transport.getCalls().at(-1).operation,'edit');assert.equal(f.transport.getCalls().at(-1).messageId,message.messageId);assert.match(JSON.stringify(f.transport.getMessages()[0].payload),/19 火箭/);
 await f.send('kook',event);await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.transport.getCalls().length,before+1);
 await f.send('kook',f.kook('kook-101',message.messageId,'kills','other'));await f.send('kook',f.kook('kook-102',message.messageId,'kills','member','outside'));await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.transport.getCalls().length,before+1);
 f.transport.enqueue({platform:'kook',operation:'edit',targetId:'kook-target',kind:'response_lost'});await f.send('kook',f.kook('kook-103',message.messageId,'kills'));await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.notifications.repo.all('messageOperations').filter(o=>o.status==='unknown').length,1);
 await f.send('kook',f.kook('kook-104',message.messageId,'deaths'));await f.worker.runOnce({workerId:'native-worker',limit:10});assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,1);assert.equal(f.transport.getCalls().length,before+2);
});
