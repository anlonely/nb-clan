import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {acquireProductionLease} from '../server/v2/production/migrations.js';
import { createFixture } from './support/v2-notifications/fixture.js';
import { installNotificationBusinessSchema, installNotificationPlatformCardSchema } from '../server/v2/notifications/index.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createPlatformCards } from '../server/v2/platform-admin/cards.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { createNotificationPlatforms } from '../server/v2/notification-platforms/platforms.js';
import { createIsolatedNotificationTransport } from '../server/v2/notification-platforms/isolated-transport.js';
import { renderNotification, listNotificationTemplates } from '../server/v2/notification-platforms/index.js';
import { createWipeCardSync } from '../server/v2/platform-admin/wipe-card-sync.js';
import { serverConnectTargetId } from '../server/v2/platform-admin/server-connect-card.js';
import { electricianTargetId, ELECTRICIAN_COMMAND_ID } from '../server/v2/platform-admin/electrician-card.js';
import { discordWipeNoticePayload } from '../server/v2/platform-admin/wipe-notice-card.js';

test('maintenance adoption CLI refuses missing stop proof and an active production lease before opening or changing business data',async t=>{
 const directory=await mkdtemp(path.join(await realpath(tmpdir()),'card-adoption-lease-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await chmod(directory,0o700);const databaseFile=path.join(directory,'nb-clan.sqlite'),db=new DatabaseSync(databaseFile);
 db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES(\'untouched\')');db.close();await chmod(databaseFile,0o600);
 const config={dataDirectory:directory,databaseFile},registration=await acquireProductionLease(config,{mode:'plan'});await registration.release();
 const planFile=path.join(directory,'adoption.json'),before=await readFile(databaseFile),hash=createHash('sha256').update(before).digest('hex');
 await writeFile(planFile,JSON.stringify({actorAccountId:'not-read',cards:[]}));
 const run=()=>spawnSync(process.execPath,['scripts/adopt-platform-card.mjs',planFile],{cwd:new URL('..',import.meta.url),env:{...process.env,NB_DATA_DIR:directory},encoding:'utf8',timeout:10000});
 const noProof=run();assert.notEqual(noProof.status,0);assert.match(noProof.stderr,/PRODUCTION_STOP_RECEIPT_REQUIRED/);
 const held=await acquireProductionLease(config,{mode:'runtime'});t.after(()=>held.release());
 await writeFile(planFile,JSON.stringify({actorAccountId:'not-read',cards:[],stopReceipt:{kind:'isolated-copy',observedAt:new Date().toISOString(),sourcePath:path.join(directory,'source.sqlite'),databaseSha256:hash}}));
 const blocked=run();assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/PRODUCTION_IN_USE/);
 assert.deepEqual(await readFile(databaseFile),before);
 await held.release();
});

async function setup(t) {
  const f=createFixture({adminRole:true});
  f.identity.repo.put('members',{id:'owner-member',steamId:'76561198999999001',memberStatus:'active'});
  f.identity.repo.put('accounts',{...f.identity.repo.get('accounts','admin'),memberId:'owner-member'});
  f.identity.repo.put('bindings',{id:'owner-binding',accountId:'admin',memberId:'owner-member',steamId:'76561198999999001',status:'verified'});
  installPlatformAdminSchema(f.db);installNotificationBusinessSchema(f.db);installNotificationPlatformCardSchema(f.db);
  const owner=new PlatformAdminService({identity:f.identity,now:()=>f.clock.now});
  for(const platform of ['discord','kook'])owner.save(f.actor(),platform,{expectedRevision:0,config:{enabled:true,
    targets:[{id:platform+'-base',guildId:platform==='kook'?'8900601550851301':'1554983512321425488',channelId:'200000000000000001',
      serverConnectChannelId:'200000000000000003',electricianChannelId:platform==='kook'?'1630990274298012':'200000000000000004',welcomeGuideChannelId:'200000000000000005',enabled:true,enabledCommandIds:['server_connect_card',ELECTRICIAN_COMMAND_ID,'welcome_guide_card',...(platform==='discord'?['wipe']:[])]},
      {id:platform+'-signup',guildId:platform==='kook'?'8900601550851301':'1554983512321425488',channelId:'200000000000000002',enabled:true,enabledCommandIds:[]}],
    commands:[...(platform==='discord'?[{id:'wipe',name:'wipe-react',type:'event_command',slashCommand:'wipe-react',signupMode:'member_required',enabled:true}]:[]),{id:'server_connect_card',name:'connect',type:'persistent_card',enabled:true},{id:'welcome_guide_card',name:'guide',type:'persistent_card',enabled:true},
      {id:ELECTRICIAN_COMMAND_ID,name:'electricians',type:'persistent_card',enabled:true,electriciansCn:'A | https://steamcommunity.com/id/electrician_a/',electriciansForeign:'B | https://steamcommunity.com/id/electrician_b/'}]}},{operationId:'config-'+platform});
  const production=createProductionNotificationOwner({getIdentity:async()=>f.identity,getPlatformService:()=>owner,publicOrigin:'https://nb.example',readCredentials:()=>({botToken:'fixture'})});
  const targets=()=>production.catalog.listTargets().map(target=>({...target,runtimeMode:'isolated',transportKey:'isolated:'+target.id}));
  Object.assign(f.system.service.catalog,{listTargets:targets,getTarget:id=>targets().find(target=>target.id===id)});
  const transport=createIsolatedNotificationTransport({now:()=>f.clock.now});
  f.system.service.platforms=createNotificationPlatforms({transport,now:()=>f.clock.now});
  let dnsIp='203.0.113.9';
  const cards=createPlatformCards({identity:f.identity,scheduling:f.scheduling,notifications:f.system.service,platformService:owner,
    runStoreWriteTask:async fn=>fn(),now:()=>f.clock.now,resolveConnectIp:async()=> dnsIp});
  owner.adapters.cards=cards;
  const change=patch=>{const wipe=f.scheduling.repo.get('wipes',f.wipe.id);f.scheduling.repo.put('wipes',{...wipe,...patch,revision:wipe.revision+1,contentRevision:wipe.contentRevision+1});};
  change({serverSnapshot:{name:'Atlas',connectCommand:'client.connect fixture.example:28010',mapLink:'https://rustmaps.com/map/first'}});
  const tick=()=>{f.clock.advance(15001);return f.system.worker.runOnce({workerId:'auto-sync-test',limit:20});};
  async function publish(platform,cardType,extra={}){
    const targetId=cardType==='server_connect'?serverConnectTargetId(platform+'-base',platform):cardType==='electrician_ids'?electricianTargetId(platform+'-base',platform):platform+'-base';
    const input={targetId,cardType,language:platform==='discord'?'en':'zh-CN',...(cardType==='electrician_ids'?{}:{wipeId:f.wipe.id}),...(cardType==='wipe_notice'?{signupTargetId:'discord-signup'}:{}),...extra};
    const args={actor:f.actor(),platform,input,config:owner.config(platform),assertCurrent:()=>f.actor()};
    const preview=await cards.preview(args);
    const {serverConnectOverride,...sendInput}=input;
    const delivery=await cards.publish({...args,input:{...sendInput,previewId:preview.preview.id,contentHash:preview.preview.contentHash},operationId:'publish-'+platform+'-'+cardType});
    await tick();await tick();
    assert.equal(f.system.service.repo.get('deliveries',delivery.reference).status,'sent');
    return {input,deliveryId:delivery.reference,baselineEdits:transport.getCalls().filter(call=>call.operation==='edit').length,messageId:transport.getMessages().find(message=>message.targetId===targetId).messageId};
  }
  t.after(async()=>{await f.system.worker.stop();await production.stop();f.close();});
  return {...f,owner,cards,transport,publish,change,tick,setDnsIp:ip=>{dnsIp=ip;}};
}

for(const platform of ['discord','kook'])test(`${platform} source changes automatically edit the original connect card and deduplicate idle ticks`,async t=>{
  const f=await setup(t),card=await f.publish(platform,'server_connect');
  await f.tick();assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,card.baselineEdits);
  f.change({serverScheduledWipeAt:'2030-09-09T12:00:00Z',serverSnapshot:{name:'Updated server',connectCommand:'client.connect updated.example:28020'}});
  await f.tick();
  const message=f.transport.getMessages().find(message=>message.messageId===card.messageId);
  assert.match(JSON.stringify(message.payload),/Updated server/);assert.match(JSON.stringify(message.payload),/updated.example:28020/);
  assert.match(JSON.stringify(message.payload),/203\.0\.113\.9:28020/);
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,card.baselineEdits+1);
  await f.tick();assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,card.baselineEdits+1);
});

test('both electrician cards follow the canonical KOOK roster without listing individual profiles',async t=>{
  const f=await setup(t);await f.publish('kook','electrician_ids');await f.publish('discord','electrician_ids');
  const config=f.owner.config('kook');config.commands.find(command=>command.id===ELECTRICIAN_COMMAND_ID).electriciansCn+='\nC | https://steamcommunity.com/id/electrician_c/';
  config.revision++;f.owner.repo.put('config','kook','kook','admin',f.clock.now,config);
  await f.tick();
  const messages=f.transport.getMessages();assert.ok(messages.some(message=>message.platform==='kook'&&message.payload.content.includes('CN电工 2 位')));
  assert.ok(messages.some(message=>message.platform==='discord'&&JSON.stringify(message.payload).includes('2 electricians')));
  assert.ok(messages.every(message=>!JSON.stringify(message.payload).includes('electrician_c')));
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,2);
});

test('wipe notice follows schedule, map and closure in its original Discord message',async t=>{
  const f=await setup(t),card=await f.publish('discord','wipe_notice');
  f.change({title:'FORCE WIPE Updated',signupClosesAt:'2030-09-10T13:00:00Z',signupWindow:'closed',serverScheduledWipeAt:'2030-09-10T12:00:00Z',serverSnapshot:{name:'Next server',connectCommand:'client.connect next.example:28010',mapLink:'https://rustmaps.com/map/second'}});
  await f.tick();
  const message=f.transport.getMessages().find(message=>message.messageId===card.messageId);
  assert.match(JSON.stringify(message.payload),/FORCE WIPE Updated/);assert.match(JSON.stringify(message.payload),/Registration Deadline/);assert.match(JSON.stringify(message.payload),/Sign-ups are closed/);assert.match(JSON.stringify(message.payload),/map\/second/);
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
});

test('wipe notice respects no-binding mode and omits unconfigured optional channel links',async t=>{
 const f=await setup(t),config=f.owner.config('discord'),target=config.targets[0];
 config.commands.find(c=>c.id==='wipe').signupMode='discord_only';
 delete target.welcomeGuideChannelId;delete target.serverConnectChannelId;
 const wipe=f.scheduling.repo.get('wipes',f.wipe.id),payload=discordWipeNoticePayload(wipe,target,config,'discord-signup');
 const body=JSON.stringify(payload);
 assert.match(body,/Steam linking is not required/);assert.doesNotMatch(body,/Register and link|undefined|<#>|null/);
 assert.deepEqual(payload.components[0].components.map(button=>button.label),['Wipe Sign-up','Server Map']);
 for(const button of payload.components[0].components)assert.equal(new URL(button.url).protocol,'https:');
 config.commands.find(c=>c.id==='wipe').signupMode='member_required';
 assert.match(JSON.stringify(discordWipeNoticePayload(wipe,target,config,'discord-signup')),/Register and link your Discord and Steam/);
 assert.equal(discordWipeNoticePayload(wipe,target,config,'missing-target'),null);
 config.targets[1].channelId='invalid';assert.equal(discordWipeNoticePayload(wipe,target,config,'discord-signup'),null);
});

test('changed target and revoked principal stop edits; permitted permission-version changes resume',async t=>{
  const f=await setup(t);await f.publish('discord','server_connect');f.change({serverSnapshot:{name:'Private',connectCommand:'client.connect private.example:28010'}});
  const config=f.owner.config('discord');config.targets[0].serverConnectChannelId='200000000000000009';config.revision++;f.owner.repo.put('config','discord','discord','admin',f.clock.now,config);
  await f.tick();assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,1);
  config.targets[0].serverConnectChannelId='200000000000000003';f.owner.repo.put('config','discord','discord','admin',f.clock.now,config);
  const account=f.identity.repo.get('accounts','admin');f.identity.repo.put('accounts',{...account,permissionVersion:2});
  await f.tick();assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,2);
  f.identity.repo.put('accounts',{...account,status:'disabled',permissionVersion:3});
  f.change({serverSnapshot:{name:'Forbidden',connectCommand:'client.connect forbidden.example:28010'}});
  await f.tick();assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,2);
});

test('unknown edits remain blocked while unrelated cards continue to sync',async t=>{
  const f=await setup(t);await f.publish('discord','server_connect');await f.publish('kook','server_connect');
  f.transport.enqueue({platform:'discord',operation:'edit',kind:'response_lost'});
  f.change({serverSnapshot:{name:'Changed',connectCommand:'client.connect changed.example:28011'}});await f.tick();
  assert.ok(f.system.service.repo.all('messageOperations').some(op=>op.status==='unknown'));
  f.change({serverSnapshot:{name:'Changed again',connectCommand:'client.connect changed.example:28012'}});await f.tick();
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit'&&call.platform==='discord').length,2);
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit'&&call.platform==='kook').length,3);
});

test('adoption refuses a message already registered under another slot',async t=>{
  const f=await setup(t),card=await f.publish('discord','server_connect');
  const ref=f.system.service.repo.all('messageRefs').find(ref=>ref.messageId===card.messageId);
  const record=f.owner.repo.db.prepare("SELECT id FROM platform_admin_records WHERE kind='durable-card'").get();
  f.owner.repo.db.prepare("DELETE FROM platform_admin_records WHERE kind='durable-card' AND id=?").run(record.id);
  // Existing registered reference must not be assigned to a different new slot.
  await assert.rejects(f.cards.adoptExisting({actor:f.actor(),platform:'discord',input:card.input,messageRef:ref}),error=>error.errorCode==='MESSAGE_ALREADY_REGISTERED');
  assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
});


test('adoption verifies and updates an unregistered original message without sending a duplicate',async t=>{
 const f=await setup(t),targetId=serverConnectTargetId('discord-base','discord'),target=f.system.service.target(targetId);
 const body={content:'Original card',embeds:[],components:[],allowed_mentions:{parse:[],roles:[],users:[],replied_user:false}};
 const {hashPayload}=await import('../server/v2/notification-platforms/canonical.js');
 const sent=await f.system.service.platforms.discord.send({target,payload:body,payloadHash:hashPayload(body),context:{attemptId:'fixture-original',operationKey:'fixture-original',executionEpoch:1,timeoutMs:1000,signal:new AbortController().signal}});
 assert.equal(sent.outcome,'sent');
 const adopted=await f.cards.adoptExisting({actor:f.actor(),platform:'discord',input:{targetId,cardType:'server_connect',wipeId:f.wipe.id,language:'en'},messageRef:sent.messageRef,followSource:true});
 await f.tick();
 assert.equal(adopted.messageId,sent.messageRef.messageId);
 assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
 assert.match(JSON.stringify(f.transport.getMessages()[0].payload),/Server Direct Connect/);
 f.change({serverSnapshot:{name:'After adoption',connectCommand:'client.connect adopted.example:28015'}});await f.tick();
 assert.match(JSON.stringify(f.transport.getMessages()[0].payload),/After adoption/);
 assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
});

test('adoption rechecks reconciliation permission after native lookup and cannot cross platforms',async t=>{
 const f=await setup(t),targetId=serverConnectTargetId('discord-base','discord'),target=f.system.service.target(targetId);
 const payload={content:'Original card',embeds:[],components:[],allowed_mentions:{parse:[]}};
 const {hashPayload}=await import('../server/v2/notification-platforms/canonical.js');
 const sent=await f.system.service.platforms.discord.send({target,payload,payloadHash:hashPayload(payload),context:{attemptId:'original',operationKey:'original',executionEpoch:1,timeoutMs:1000,signal:new AbortController().signal}});
 const args={actor:f.actor(),platform:'discord',input:{targetId,cardType:'server_connect',wipeId:f.wipe.id,language:'en'},messageRef:sent.messageRef};
 await assert.rejects(f.cards.adoptExisting({...args,platform:'kook'}),e=>e.errorCode==='PLATFORM_TARGET_SCOPE_MISMATCH');
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='lookup').length,0);
 const lookup=f.system.service.platforms.discord.lookup,original=f.identity.actorForAccount.bind(f.identity);
 f.system.service.platforms={...f.system.service.platforms,discord:{...f.system.service.platforms.discord,lookup:async input=>{const result=await lookup(input);f.identity.actorForAccount=id=>({...original(id),grants:original(id).grants.filter(g=>g.capability!=='notifications.reconcile')});return result;}}};
 await assert.rejects(f.cards.adoptExisting(args),e=>e.errorCode==='ACCESS_DENIED');
 assert.equal(f.owner.repo.db.prepare("SELECT COUNT(*) AS n FROM platform_admin_records WHERE kind='durable-card'").get().n,0);
 assert.equal(f.system.service.repo.all('messageRefs').length,0);
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,1);
});


test('DNS IP is periodically refreshed without a wipe edit',async t=>{
 const f=await setup(t),card=await f.publish('discord','server_connect');
 f.setDnsIp('203.0.113.20');f.clock.advance(300001);await f.tick();
 assert.match(JSON.stringify(f.transport.getMessages()[0].payload),/203\.0\.113\.20:28010/);
 assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,card.baselineEdits+1);
});

test('an intentional direct-connect override stays pinned unless source following is enabled',async t=>{
 const f=await setup(t);await f.publish('discord','server_connect',{serverConnectOverride:{name:'Custom server',serverScheduledWipeAt:'2030-10-01T12:00:00Z',command:'client.connect custom.example:28012'}});
 f.change({serverSnapshot:{name:'Canonical changed',connectCommand:'client.connect changed.example:28019'}});await f.tick();
 assert.match(JSON.stringify(f.transport.getMessages()[0].payload),/Custom server/);
 assert.doesNotMatch(JSON.stringify(f.transport.getMessages()[0].payload),/changed.example/);
});

for(const platform of ['discord','kook'])test(`${platform} manually updating an existing source-following card retains its override until explicitly returning to the wipe source`,async t=>{
 const f=await setup(t),card=await f.publish(platform,'server_connect');
 assert.equal(f.owner.config(platform).autoWipeCards,false);
 const update=async override=>{
  const input={...card.input,...(override?{serverConnectOverride:override}:{})};
  const args={actor:f.actor(),platform,input,config:f.owner.config(platform),assertCurrent:()=>f.actor()};
  const preview=await f.cards.preview(args),{serverConnectOverride,...sendInput}=input;
  const receipt=await f.cards.refresh({...args,input:{...sendInput,previewId:preview.preview.id,contentHash:preview.preview.contentHash},operationId:'manual-refresh-'+preview.preview.id});
  await f.tick();await f.tick();
  assert.equal(f.system.service.repo.get('messageOperations',receipt.reference).status,'succeeded');
 };
 const content=()=>JSON.stringify(f.transport.getMessages().find(message=>message.messageId===card.messageId).payload);
 await update({name:'Manually edited server',serverScheduledWipeAt:'2030-10-01T12:00:00Z',command:'client.connect manual.example:28012'});
 assert.match(content(),/Manually edited server/);assert.match(content(),/manual.example:28012/);
 f.change({serverSnapshot:{name:'Changed wipe source',connectCommand:'client.connect changed.example:28019'}});await f.tick();
 assert.match(content(),/Manually edited server/);assert.doesNotMatch(content(),/changed.example/);
 f.setDnsIp('203.0.113.30');f.clock.advance(300001);await f.tick();await f.tick();
 assert.match(content(),/manual.example:28012/);assert.match(content(),/203\.0\.113\.30:28012/);
 await update(null);
 assert.match(content(),/Changed wipe source/);assert.match(content(),/changed.example:28019/);
 f.change({serverSnapshot:{name:'Next wipe source',connectCommand:'client.connect next.example:28021'}});await f.tick();await f.tick();
 assert.match(content(),/Next wipe source/);assert.match(content(),/next.example:28021/);
 assert.equal(f.transport.getMessages().length,1);assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
});

test('joining an equivalent queued automatic update retains the manually approved override without adding another edit',async t=>{
 const f=await setup(t),card=await f.publish('discord','server_connect');
 const override={name:'Changed wipe source',serverScheduledWipeAt:'2030-10-01T12:00:00Z',command:'client.connect changed.example:28019'};
 f.change({serverScheduledWipeAt:override.serverScheduledWipeAt,serverSnapshot:{name:override.name,connectCommand:override.command}});
 f.clock.advance(15001);await f.system.service.businessDomains.platformCard.refresh();
 const queued=f.system.service.repo.all('messageOperations').filter(operation=>operation.status==='queued');assert.equal(queued.length,1);
 const before=f.system.service.repo.all('messageOperations').length;
 const input={...card.input,serverConnectOverride:override},args={actor:f.actor(),platform:'discord',input,config:f.owner.config('discord'),assertCurrent:()=>f.actor()};
 const preview=await f.cards.preview(args),{serverConnectOverride,...sendInput}=input;
 const joined=await f.cards.refresh({...args,input:{...sendInput,previewId:preview.preview.id,contentHash:preview.preview.contentHash},operationId:'pin-identical-update'});
 assert.equal(joined.reference,queued[0].id);assert.equal(f.system.service.repo.all('messageOperations').length,before);
 await f.tick();await f.tick();
 f.change({serverSnapshot:{name:'Must not replace manual',connectCommand:'client.connect later.example:28025'}});await f.tick();await f.tick();
 const content=JSON.stringify(f.transport.getMessages().find(message=>message.messageId===card.messageId).payload);
 assert.match(content,/Changed wipe source/);assert.match(content,/changed.example:28019/);assert.doesNotMatch(content,/later.example/);
 assert.equal(f.transport.getCalls().filter(call=>call.operation==='edit').length,card.baselineEdits+1);
 assert.equal(f.transport.getCalls().filter(call=>call.operation==='send').length,1);
});


test('shared specialty roster updates counts in both original cards after member edits and permission changes',async t=>{
 const f=await setup(t);f.identity.repo.put('members',{id:'cn-electrician',steamId:'76561198000000001',customName:'CN A',memberStatus:'active',specialty:['electricity']});
 f.owner.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[{kind:'specialty',group:'CN',specialty:'electricity'},{kind:'manual',group:'EU',name:'EU A',url:'https://steamcommunity.com/id/eu-electrician/'}]},{operationId:'shared-roster'});
 const cn=await f.publish('kook','electrician_ids'),eu=await f.publish('discord','electrician_ids');
 f.identity.repo.put('members',{id:'new-electrician',steamId:'76561198000000002',customName:'CN B',memberStatus:'active',specialty:['电工']});
 f.identity.repo.put('accounts',{...f.identity.repo.get('accounts','admin'),permissionVersion:2});await f.tick();
 const messages=f.transport.getMessages();assert.equal(messages.length,2);
 assert.ok(messages.find(m=>m.messageId===cn.messageId).payload.content.includes('CN电工 2 位'));
 assert.deepEqual(messages.find(m=>m.messageId===eu.messageId).payload.embeds[0].fields.map(x=>[x.name,x.value]),[['CN Electricians','2 electricians'],['EU Electricians','1 electricians']]);
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,2);
 assert.ok(messages.every(m=>!JSON.stringify(m.payload).includes('76561198000000002')));
});


test('automatic refresh cannot renew a publisher whose send permission was revoked',async t=>{
 const f=await setup(t),card=await f.publish('discord','server_connect'),original=f.identity.actorForAccount.bind(f.identity);
 f.identity.actorForAccount=id=>{const actor=original(id);return {...actor,permissionVersion:actor.permissionVersion+1,grants:actor.grants.filter(g=>g.capability!=='notifications.send')};};
 f.change({serverSnapshot:{name:'Must not send',connectCommand:'client.connect denied.example:28010'}});await f.tick();
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='edit').length,card.baselineEdits);
 assert.equal(f.owner.repo.db.prepare("SELECT json_extract(payload,'$.errorCode') error FROM platform_admin_records WHERE kind='card-auto-sync'").get().error,'ACCESS_DENIED');
});


test('permission changes renew authorized lookup for an unknown edit without replaying that edit',async t=>{
 const f=await setup(t);await f.publish('kook','server_connect');
 f.transport.enqueue({platform:'kook',operation:'edit',kind:'response_lost'});f.change({serverSnapshot:{name:'Unknown update',connectCommand:'client.connect unknown.example:28012'}});await f.tick();
 const unknown=f.system.service.repo.all('messageOperations').find(op=>op.status==='unknown');assert.ok(unknown);
 const edits=f.transport.getCalls().filter(c=>c.operation==='edit').length;
 f.identity.repo.put('accounts',{...f.identity.repo.get('accounts','admin'),permissionVersion:2});await f.tick();
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='edit').length,edits);assert.equal(f.system.service.repo.get('messageOperations',unknown.id).status,'unknown');
 const recovery=f.system.service.getDelivery(f.actor(),unknown.deliveryId);assert.equal(recovery.messageOperations.find(op=>op.id===unknown.id).canReconcile,true);
});


function enableAuto(f,patch={}){
 for(const platform of ['discord','kook']){
  const {id,revision,updatedAt,...config}=f.owner.config(platform);
  f.owner.save(f.actor(),platform,{expectedRevision:revision,config:{...config,autoWipeCards:true,
   targets:config.targets.map(t=>t.id===platform+'-base'?{...t,signupCardChannelId:'200000000000000002',enabledCommandIds:[...new Set([...t.enabledCommandIds,platform==='discord'?'wipe':'signup_card'])]}:t),
   commands:platform==='discord'?config.commands:[...config.commands,{id:'signup_card',name:'signup',type:'persistent_card',enabled:true}],...patch}},{operationId:'enable-auto-'+platform});
 }
 f.system.service.renderer=renderNotification;f.system.service.templates=listNotificationTemplates();
 f.system.service.options.resolveConnectIp=async()=> '203.0.113.9';
}
function newWipe(f,publishImmediately=false){
 const old=f.scheduling.repo.get('wipes',f.wipe.id);
 f.scheduling.repo.put('wipes',{...old,lifecycle:'ended'});
 return f.scheduling.createWipe(f.actor(),{title:'First automatic wipe',description:'Original description',serverProfileId:'server1',
  serverSnapshot:{name:'Auto server',connectCommand:'client.connect fixture.example:28010'},timeZone:'Asia/Shanghai',
  musterAt:old.musterAt,serverScheduledWipeAt:old.serverScheduledWipeAt,signupOpensAt:old.signupOpensAt,signupClosesAt:old.signupClosesAt,
  autoStart:true,audience:old.audience,publishImmediately},f.operation('new-auto-wipe')).current;
}

test('publishing a draft automatically sends both native cards to both platforms; edits retain all original messages',async t=>{
 const f=await setup(t);enableAuto(f);let wipe=newWipe(f);
 await f.tick();assert.equal(f.transport.getMessages().length,0);
 wipe=f.scheduling.transition(f.actor(),wipe.id,'publish',{expectedRevision:wipe.revision},f.operation()).current;
 await f.tick();await f.tick();
 const originals=f.transport.getMessages();assert.equal(originals.length,4);
 const ids=originals.map(m=>m.messageId).sort();
 assert.equal(f.system.service.repo.forWipe('deliveries',wipe.id).filter(d=>d.status==='sent').length,2);
 assert.match(JSON.stringify(originals.find(m=>m.platform==='discord'&&m.targetId.startsWith('signup_card_')).payload),/203\.0\.113\.9:28010/);
 wipe=f.scheduling.updateWipe(f.actor(),wipe.id,{expectedRevision:wipe.revision,title:'Updated automatic wipe',description:'Updated description',
  serverScheduledWipeAt:'2030-09-09T11:00:00Z',serverSnapshot:{name:'Updated auto server',connectCommand:'client.connect changed.example:28020'}},f.operation()).current;
 await f.tick();await f.tick();
 assert.deepEqual(f.transport.getMessages().map(m=>m.messageId).sort(),ids);
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,4);
 for(const message of f.transport.getMessages()){
  assert.match(JSON.stringify(message.payload),/Updated automatic wipe/);
  assert.match(JSON.stringify(message.payload),/changed.example:28020/);
 }
 f.system.service.options.resolveConnectIp=async()=> '203.0.113.20';f.clock.advance(300001);await f.tick();
 for(const op of f.system.service.repo.all('messageOperations')){
  if(!op.messageRefId)continue;
  assert.equal(f.system.service.repo.get('messageRefs',op.messageRefId).deliveryId,op.deliveryId);
  assert.notEqual(op.status,'failed');
 }
 const sends=f.transport.getCalls().filter(c=>c.operation==='send').length;
 const restartedSync=createWipeCardSync({identity:f.identity,scheduling:f.scheduling,notifications:f.system.service,platformService:f.owner,cards:f.cards,runStoreWriteTask:async fn=>fn(),now:()=>f.clock.now});
 await restartedSync();await f.tick();await f.tick();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,sends);
});

test('immediate wipe creation posts automatically and an uncertain first send never causes a duplicate',async t=>{
 const f=await setup(t);enableAuto(f);let wipe=newWipe(f,true);
 f.transport.enqueue({platform:'kook',operation:'send',kind:'response_lost'});
 await f.tick();await f.tick();
 assert.ok(f.system.service.repo.all('deliveries').some(d=>d.status==='delivery_unknown'));
 wipe=f.scheduling.updateWipe(f.actor(),wipe.id,{expectedRevision:wipe.revision,title:'Edited uncertain wipe'},f.operation()).current;
 await f.tick();await f.tick();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,4);
});

test('auto publication respects disabled configuration, disabled commands and current send authority',async t=>{
 const f=await setup(t);newWipe(f,true);await f.tick();assert.equal(f.transport.getMessages().length,0);
 enableAuto(f,{enabled:false});await f.tick();assert.equal(f.transport.getMessages().length,0);
 for(const platform of ['kook','discord']){
  const {id,revision,updatedAt,...config}=f.owner.config(platform);
  f.owner.save(f.actor(),platform,{expectedRevision:revision,config:{...config,enabled:true,
   commands:config.commands.map(c=>c.id===(platform==='discord'?'wipe':'signup_card')?{...c,enabled:false}:c)}},f.operation());
 }
 const original=f.identity.actorForAccount.bind(f.identity);
 f.identity.actorForAccount=id=>{const actor=original(id);return {...actor,permissionVersion:actor.permissionVersion+1,grants:actor.grants.filter(g=>g.capability!=='notifications.send')};};
 await f.tick();assert.equal(f.transport.getMessages().length,0);
 assert.ok(f.owner.repo.list('wipe-card-auto-publish','discord').some(r=>r.errorCode==='ACCESS_DENIED'));
 f.identity.actorForAccount=original;await f.tick();await f.tick();
 assert.equal(f.transport.getMessages().length,2);
 assert.ok(f.transport.getMessages().every(m=>!m.targetId.startsWith('signup_card_')));
});

test('with automatic wipe cards enabled, manual connect content follows the next schedule edit',async t=>{
 const f=await setup(t);await f.publish('discord','server_connect',{serverConnectOverride:{name:'Custom server',serverScheduledWipeAt:'2030-10-01T12:00:00Z',command:'client.connect custom.example:28012'}});
 enableAuto(f);await f.tick();
 assert.match(JSON.stringify(f.transport.getMessages().find(m=>m.targetId.startsWith('server_connect_')&&m.platform==='discord').payload),/Custom server/);
 const old=f.scheduling.repo.get('wipes',f.wipe.id);
 f.scheduling.updateWipe(f.actor(),old.id,{expectedRevision:old.revision,serverSnapshot:{name:'Canonical changed',connectCommand:'client.connect canonical.example:28019'}},f.operation());
 await f.tick();await f.tick();
 const message=f.transport.getMessages().find(m=>m.targetId.startsWith('server_connect_')&&m.platform==='discord');
 assert.match(JSON.stringify(message.payload),/canonical.example:28019/);
 assert.doesNotMatch(JSON.stringify(message.payload),/Custom server/);
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,4);
});

test('a schedule edit before first delivery replaces only definitely unsent stale admissions',async t=>{
 const f=await setup(t);enableAuto(f);let wipe=newWipe(f,true);
 const sync=createWipeCardSync({identity:f.identity,scheduling:f.scheduling,notifications:f.system.service,platformService:f.owner,cards:f.cards,runStoreWriteTask:async fn=>fn(),now:()=>f.clock.now});
 await sync();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,0);
 wipe=f.scheduling.updateWipe(f.actor(),wipe.id,{expectedRevision:wipe.revision,title:'Latest before delivery',serverSnapshot:{name:'Latest server',connectCommand:'client.connect latest.example:28022'}},f.operation()).current;
 await f.tick();await f.tick();await f.tick();
 assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,4);
 for(const message of f.transport.getMessages())assert.match(JSON.stringify(message.payload),/latest.example:28022/);
});

test('manual publishing during automatic DNS preparation cannot create a second connect message',async t=>{
 const f=await setup(t);enableAuto(f);newWipe(f,true);
 const preview=f.cards.preview;let intercepted=false;
 f.cards.preview=async args=>{
  const result=await preview(args);
  if(!intercepted){
   intercepted=true;
   await f.cards.publish({...args,input:{...args.input,previewId:result.preview.id,contentHash:result.preview.contentHash},operationId:'concurrent-manual-connect'});
  }
  return result;
 };
 await f.tick();await f.tick();assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,4);
 assert.equal(f.transport.getMessages().length,4);
});
