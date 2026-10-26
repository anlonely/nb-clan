import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationService } from '../server/v2/notifications/service.js';

function fixture(){
  let clock=0,ip='216.39.240.89',lookups=0;
  const command='client.connect 2xmonthly.atlasrust.us:28010';
  const wipe={id:'wipe',lifecycle:'scheduled',serverSnapshot:{connectCommand:command}};
  const target={id:'target',guildId:'guild',channelId:'channel',enabled:true,signupMode:'discord_only',configurationRevision:1};
  const modeSnapshot={discordLocaleVersion:1,signupMode:'discord_only',signupConfigurationRevision:1};
  const delivery={id:'delivery',wipeId:'wipe',platform:'discord',intentId:'intent',targetId:target.id,target,status:'sent',snapshot:{directConnect:command,...modeSnapshot},
    payload:{components:[{components:[{label:'Copy Direct Connect'}]}]}};
  const operations=[],queued=[];
  const service={now:()=>clock,options:{resolveConnectIp:async()=>{lookups++;return ip;}},
    catalog:{getTarget:()=>target},
    repo:{all:()=>[delivery],get:()=>({purpose:'signup_open'}),transaction:fn=>fn()},
    scheduling:{repo:{get:()=>wipe}},resourceRows:kind=>kind==='messageOperations'?operations.map(op=>({deliveryId:'delivery',...op})):[{id:'ref',state:'active',deliveryId:'delivery'}],
    queueMessageOperation:(d,kind,extra)=>queued.push({deliveryId:d.id,kind,...extra})};
  service.ensureSignupConnectIp=wipe=>NotificationService.prototype.ensureSignupConnectIp.call(service,wipe);
  return {service,delivery,operations,queued,command,wipe,setClock:value=>clock=value,setIp:value=>ip=value,lookups:()=>lookups,
    refresh:()=>NotificationService.prototype.refreshSignupConnectIps.call(service),
    applied:()=>{operations.push({kind:'edit',status:'succeeded',updatedAt:new Date(clock).toISOString(),
      snapshot:{directConnect:wipe.serverSnapshot.connectCommand,directConnectIp:service.signupConnectIps.get(wipe.serverSnapshot.connectCommand).ip,...modeSnapshot},payload:{components:[]}});queued.length=0;}};
}

test('signup IP refresh edits the original reference only on changes, with five-minute DNS cache',async()=>{
  const f=fixture();await f.refresh();
  assert.deepEqual(f.queued,[{deliveryId:'delivery',kind:'edit',messageRefId:'ref',reasonCode:'SIGNUP_CONNECT_CHANGED'}]);
  f.applied();await f.refresh();assert.equal(f.queued.length,0);assert.equal(f.lookups(),1);
  f.setIp('216.39.240.90');f.setClock(300001);await f.refresh();
  assert.equal(f.lookups(),2);assert.equal(f.queued.length,1);f.applied();await f.refresh();assert.equal(f.queued.length,0);
  f.setIp(null);f.setClock(600002);await f.refresh();assert.equal(f.queued.length,1);
  assert.equal(f.service.signupConnectIps.get(f.command).ip,null);
});

test('signup IP refresh preserves unknown edits and does not retry final failed edits endlessly',async()=>{
  const f=fixture();f.operations.push({kind:'edit',status:'unknown'});await f.refresh();assert.equal(f.queued.length,0);
  f.operations.length=0;f.operations.push({kind:'edit',status:'failed',reasonCode:'SIGNUP_CONNECT_CHANGED',
    snapshot:{discordLocaleVersion:1,directConnect:f.command,directConnectIp:'216.39.240.89',signupMode:'discord_only',signupConfigurationRevision:1}});
  await f.refresh();assert.equal(f.queued.length,0);
  f.setIp('216.39.240.90');f.setClock(300001);await f.refresh();assert.equal(f.queued.length,1);
});

test('signup IP follows a changed canonical server command and stays off KOOK',async()=>{
  const f=fixture();await f.refresh();f.applied();
  f.wipe.serverSnapshot.connectCommand='client.connect other.example:28015';await f.refresh();
  assert.equal(f.lookups(),2);assert.equal(f.queued.length,1);
  const kook=fixture();kook.delivery.platform='kook';await kook.refresh();assert.equal(kook.lookups(),0);assert.equal(kook.queued.length,0);
});


test('signup IP refresh cannot use another platform delivery reference or pending edit from the same wipe',async()=>{
 const f=fixture();
 f.service.resourceRows=kind=>kind==='messageOperations'?[{deliveryId:'other-delivery',kind:'edit',status:'unknown'}]:
  [{id:'ref',state:'active',deliveryId:'delivery'},{id:'other-ref',state:'active',deliveryId:'other-delivery'}];
 await f.refresh();
 assert.deepEqual(f.queued,[{deliveryId:'delivery',kind:'edit',messageRefId:'ref',reasonCode:'SIGNUP_CONNECT_CHANGED'}]);
});

test('equal-time successful edits use the original reference pin instead of an older payload', async()=>{
 const f=fixture();await f.refresh();f.applied();
 const old=f.operations[0];old.id='old-edit';old.messageRefId='ref';old.snapshot.signupMode='member_required';
 const applied={...old,id:'current-edit',snapshot:{...old.snapshot,signupMode:'discord_only'}};
 f.operations.push(applied);
 f.service.resourceRows=kind=>kind==='messageOperations'?f.operations.map(op=>({deliveryId:'delivery',...op})):
  [{id:'ref',state:'active',deliveryId:'delivery',lastMessageOperationId:'current-edit'}];
 await f.refresh();assert.equal(f.queued.length,0);
});


test('a pre-localization signup queues one edit on the original message and remains current after it is applied', async()=>{
 const f=fixture();await f.refresh();f.applied();
 delete f.operations[0].snapshot.discordLocaleVersion;
 await f.refresh();assert.equal(f.queued.length,1);assert.equal(f.queued[0].messageRefId,'ref');
 f.setClock(1);f.applied();await f.refresh();assert.equal(f.queued.length,0);
});

test('retained closed signup receives the language entry once, then stops following DNS changes',async()=>{
 const f=fixture();f.wipe.lifecycle='archived';delete f.delivery.snapshot.discordLocaleVersion;
 await f.refresh();assert.equal(f.queued.length,1);f.applied();
 f.setIp('216.39.240.90');f.setClock(300001);await f.refresh();assert.equal(f.queued.length,0);
});
