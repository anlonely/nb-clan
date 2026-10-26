import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture } from './support/v2-notifications/fixture.js';
import { callbackFixture, replyText } from './support/v2-notification-platforms/fixture.mjs';
import { nativeEnvelopes } from './support/v2-notification-platforms/native-envelopes.mjs';
import { renderNotification } from '../server/v2/notification-platforms/renderer.js';
import { assertCardViewProof } from '../server/v2/notification-platforms/card-language-view.js';
import { interactionText } from '../server/v2/notification-platforms/interaction-language.js';
import { installNotificationBusinessSchema, installNotificationPlatformCardSchema } from '../server/v2/notifications/index.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createPlatformCards } from '../server/v2/platform-admin/cards.js';
import { welcomeGuideTargetId } from '../server/v2/platform-admin/welcome-guide-card.js';

const locales = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ru', 'tr', 'th', 'ko', 'de', undefined, '<@everyone>'];
const database = f => ({ records: f.db.prepare('SELECT collection,id,payload_json FROM json_records ORDER BY collection,id').all(), scalars: f.db.prepare('SELECT * FROM json_scalars ORDER BY key').all(), cards: f.db.prepare("SELECT kind,id,payload FROM platform_admin_records ORDER BY kind,id").all() });
const envelope = (native, value, ref, locale, patch={}) => native.discord(value, { locale, guild_locale: locale==='zh-CN'?'en-US':'zh-CN', guild_id:ref.guildId, channel_id:ref.channelId, message:{id:ref.messageId}, ...patch });

async function signup(t) {
  const f=createFixture({adminRole:true,renderer:renderNotification,wipeInput:{title:'Vital EU',description:'',serverSnapshot:{name:'Vital EU',connectCommand:'client.connect eu-medium.vitalrust.com:28014'}},options:{resolveConnectIp:async()=> '168.100.161.200'}});
  installPlatformAdminSchema(f.db);t.after(()=>f.close());
  f.catalog.setTarget('discord-1',{signupMode:'discord_only'});
  const service=f.system.service;
  const preview=service.createPreview(f.actor(),f.wipe.id,f.input(),f.operation('preview')).current;
  const intent=service.createIntent(f.actor(),f.wipe.id,{previewId:preview.id,contentHash:preview.contentHash,expectedContentRevision:preview.contentRevision,purpose:preview.purpose,purposeInstance:preview.purposeInstance},f.operation('publish')).current;
  await f.system.worker.runOnce({workerId:'language-view'});await f.system.worker.runOnce({workerId:'language-view'});
  const delivery=service.repo.get('deliveries',intent.deliveryIds[0]),ref=service.repo.all('messageRefs').find(r=>r.deliveryId===delivery.id);
  const original=f.transport.messages.get(ref.messageId).payload;
  const button=original.components.flatMap(r=>r.components).find(b=>b.custom_id?.startsWith('nblang:signup:'));
  assert.ok(button);
  return {f,service,ref,original,button,native:nativeEnvelopes({now:()=>f.clock.now})};
}

test('signed client locale renders original signup privately in all six languages without any writes',async t=>{
 const {f,service,ref,original,button,native}=await signup(t),before=database(f),calls=f.transport.calls.length;
 for(const locale of locales){
  const proof=native.verifiers.discord(envelope(native,button.custom_id,ref,locale)),payload=service.localizedDiscordView(proof);
  assert.ok(payload.embeds[0].description.includes('168.100.161.200:28014'));
  assert.ok(JSON.stringify(payload.embeds).includes('Vital EU'));
  assert.deepEqual(payload.allowed_mentions,{parse:[],roles:[],users:[],replied_user:false});
  assert.equal(payload.components.flatMap(r=>r.components).some(b=>b.custom_id?.startsWith('nblang:')),false);
  if(['zh-CN','zh-TW'].includes(locale))assert.match(payload.embeds[0].description,/无需绑定 Steam/);
  else if(locale==='ru')assert.match(payload.embeds[0].description,/Привязка Steam/);
  else if(locale==='tr')assert.match(payload.embeds[0].description,/Steam bağlantısı/);
  else if(locale==='th')assert.match(payload.embeds[0].description,/ไม่ต้องเชื่อมโยง Steam/);
  else if(locale==='ko')assert.match(payload.embeds[0].description,/Steam 연결 없이/);
  else assert.match(payload.embeds[0].description,/No Steam link required/);
 }
 assert.deepEqual(database(f),before);assert.equal(f.transport.calls.length,calls);assert.deepEqual(f.transport.messages.get(ref.messageId).payload,original);
});

test('signup language view rejects copied proofs, wrong original message, channel and guild, and deleted refs',async t=>{
 const {f,service,ref,button,native}=await signup(t);
 const proof=native.verifiers.discord(envelope(native,button.custom_id,ref,'ko'));
 assert.throws(()=>service.localizedDiscordView(structuredClone(proof)),/PLATFORM_AUTH_INVALID/);
 for(const patch of [{message:{id:'other-message'}},{channel_id:'other-channel'},{guild_id:'other-guild'}]){
  const changed=native.verifiers.discord(envelope(native,button.custom_id,ref,'ko',patch));
  assert.throws(()=>service.localizedDiscordView(changed));
 }
 service.repo.put('messageRefs',{...ref,state:'deleted'});
 assert.throws(()=>service.localizedDiscordView(proof));
});

async function welcome(t){
 const f=createFixture({adminRole:true});t.after(()=>f.close());
 installPlatformAdminSchema(f.db);installNotificationBusinessSchema(f.db);installNotificationPlatformCardSchema(f.db);
 const owner=new PlatformAdminService({identity:f.identity,now:()=>f.clock.now});
 const base={id:'welcome-base',guildId:'1554983512321425488',channelId:'200000000000000001',welcomeGuideChannelId:'200000000000000005',electricianChannelId:'200000000000000004',serverConnectChannelId:'200000000000000003',enabled:true,enabledCommandIds:['welcome_guide_card']};
 owner.save(f.actor(),'discord',{expectedRevision:0,config:{enabled:true,targets:[base],commands:[{id:'welcome_guide_card',name:'Welcome',type:'persistent_card',enabled:true}]}},{operationId:randomUUID()});
 const targetId=welcomeGuideTargetId(base.id,'discord');
 f.catalog.targets.set(targetId,{...f.catalog.getTarget('discord-1'),id:targetId,guildId:base.guildId,channelId:base.welcomeGuideChannelId});
 const cards=createPlatformCards({identity:f.identity,scheduling:f.scheduling,notifications:f.system.service,platformService:owner,runStoreWriteTask:async fn=>fn(),now:()=>f.clock.now});
 owner.adapters.cards=cards;
 const input={expectedRevision:1,cardType:'welcome_guide',targetId,language:'en'};
 const preview=(await owner.execute(f.actor(),'discord','card_preview',input,{operationId:randomUUID()})).result.preview;
 const published=await owner.execute(f.actor(),'discord','card_publish',{...input,previewId:preview.id,contentHash:preview.contentHash},{operationId:randomUUID()});
 await f.system.worker.runOnce({workerId:'welcome-language'});
 const ref=f.system.service.repo.all('messageRefs').find(r=>r.deliveryId===published.result.reference);
 assert.ok(ref?.messageId,JSON.stringify(published));
 const original=f.transport.messages.get(ref.messageId).payload,button=original.components.flatMap(r=>r.components).find(b=>b.custom_id?.startsWith('nblang:card:'));
 assert.ok(button);return {f,owner,cards,ref,original,button,native:nativeEnvelopes({now:()=>f.clock.now})};
}

test('unbound Discord users can view the exact welcome card using their client locale without changing public data',async t=>{
 const {f,cards,ref,original,button,native}=await welcome(t),before=database(f);
 const titles=new Set();
 for(const locale of ['zh-CN','en-US','ru','tr','th','ko','de']){
  const proof=native.verifiers.discord(envelope(native,button.custom_id,ref,locale,{externalId:'unbound-visitor'}));
  const payload=cards.localizedView(proof);titles.add(payload.embeds[0].title);
  assert.equal(payload.components.flatMap(r=>r.components).some(b=>b.custom_id?.startsWith('nblang:')),false);
  assert.ok(payload.components.flatMap(r=>r.components).every(b=>b.style===5));
 }
 assert.equal(titles.size,6);assert.deepEqual(database(f),before);assert.deepEqual(f.transport.messages.get(ref.messageId).payload,original);
});

test('durable language views reject tampered proofs, other original messages and disabled current targets',async t=>{
 const {f,owner,cards,ref,button,native}=await welcome(t);
 const proof=native.verifiers.discord(envelope(native,button.custom_id,ref,'ru'));
 assert.throws(()=>cards.localizedView({...proof}),/PLATFORM_AUTH_INVALID/);
 assert.throws(()=>cards.localizedView(native.verifiers.discord(envelope(native,button.custom_id,ref,'ru',{message:{id:'other-message'}}))));
 f.catalog.setTarget(ref.targetId||welcomeGuideTargetId('welcome-base','discord'),{enabled:false});
 assert.throws(()=>cards.localizedView(proof));
});

test('language view callbacks acknowledge privately, retain native proof, and localize failures',async t=>{
 for(const locale of locales)await t.test(String(locale),async s=>{
  const f=await callbackFixture(s),native=nativeEnvelopes({now:()=>f.state.now});
  const handler=f.handler('discord',{verify:native.verifiers.discord,viewDiscordCard:proof=>{assertCardViewProof(proof);throw Object.assign(new Error('not found'),{errorCode:'RESOURCE_NOT_FOUND'});}});
  await handler(native.discord('nblang:card:'+'a'.repeat(64),{locale,message:{id:'original'}}),f.io);
  assert.deepEqual(f.acks,[{type:5,data:{flags:64}}]);
  assert.equal(replyText(f.privateReplies[0]),interactionText('discord',{locale},'cardUnavailable',{code:'RESOURCE_NOT_FOUND'}));
 });
});

test('long custom Discord cards use embeds within native limits and retain configured content',async t=>{
 const {f,owner}=await welcome(t);
 const config=owner.config('discord');config.revision++;
 config.commands.push({id:'custom-test',name:'Custom',type:'persistent_card',enabled:true,titleTemplate:'Configured title',bodyTemplate:'x'.repeat(3500)});
 owner.repo.put('config','discord','discord',f.actor().id,f.clock.now,config);
 const target=config.targets[0];f.catalog.targets.set(target.id,{...f.catalog.getTarget('discord-1'),id:target.id,guildId:target.guildId,channelId:target.channelId});
 const input={expectedRevision:config.revision,cardType:'custom',commandId:'custom-test',targetId:target.id,language:'ru'};
 const preview=(await owner.execute(f.actor(),'discord','card_preview',input,{operationId:randomUUID()})).result.preview;
 const queued=await owner.execute(f.actor(),'discord','card_publish',{...input,previewId:preview.id,contentHash:preview.contentHash},{operationId:randomUUID()});
 assert.equal(queued.status,'queued',JSON.stringify(queued));await f.system.worker.runOnce({workerId:'custom-language'});
 const delivery=f.system.service.repo.get('deliveries',queued.result.reference),body=delivery.payload;
 assert.equal(body.content,'');assert.equal(body.embeds[0].description.length,3500);assert.equal(body.embeds[0].title,'Configured title');
 assert.ok(body.components.flatMap(row=>row.components).some(button=>button.custom_id?.startsWith('nblang:card:')));
});
