import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { createPlatformCards } from '../server/v2/platform-admin/cards.js';
import { createProductionNetwork } from '../server/v2/production/network.js';
import { acquireProductionLease } from '../server/v2/production/migrations.js';
import { ELECTRICIAN_COMMAND_ID } from '../server/v2/platform-admin/electrician-card.js';

// Explicit maintenance only: verified exact message IDs and current owner
// authority, a recent stop/copy receipt and the main production maintenance
// lease. This command never starts timers or posts replacement messages.
const planFile=process.argv[2];
if(!planFile)throw Error('Usage: node scripts/adopt-platform-card.mjs /absolute/path/plan.json');
const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
const dataDir=path.resolve(process.env.NB_DATA_DIR||'data');
const lease=await acquireProductionLease({dataDirectory:dataDir,databaseFile:path.join(dataDir,'nb-clan.sqlite')},{mode:'maintenance',stopReceipt:plan.stopReceipt});
let db,network,owner;
try{
db=new DatabaseSync(path.join(dataDir,'nb-clan.sqlite'));
db.exec('PRAGMA busy_timeout=10000');
const identity=new IdentityService(new IdentityRepository(db),{origin:'https://nb.anlonely.me'});
const actor=identity.actorForAccount(plan.actorAccountId);
if(actor.roleId!=='owner')throw Error('Verified owner required');
const platformService=new PlatformAdminService({identity});
network=createProductionNetwork({readSettings:()=>identity.repo.scalar('settings')||{}});
owner=createProductionNotificationOwner({getIdentity:async()=>identity,getPlatformService:()=>platformService,
 publicOrigin:'https://nb.anlonely.me',readCredentials:platform=>({botToken:identity.repo.scalar('settings')?.[platform]?.botToken||process.env[`NB_${platform.toUpperCase()}_BOT_TOKEN`]}),
 fetchImpl:(url,options)=>network.serviceFetch('global',url,options)});
 if(plan.enableDiscordElectricianTargetId){
  const old=platformService.config('discord'),target=old.targets.find(t=>t.id===plan.enableDiscordElectricianTargetId);
  if(!target?.enabled)throw Error('Target not enabled');
  if(!target.enabledCommandIds.includes(ELECTRICIAN_COMMAND_ID)||!old.commands.some(c=>c.id===ELECTRICIAN_COMMAND_ID&&c.enabled)||plan.discordSignupChannelId&&(target.signupCardChannelId!==plan.discordSignupChannelId||!target.enabledCommandIds.includes('wipe')||!old.commands.some(c=>c.id==='wipe'&&c.type==='event_command'&&c.enabled))){
   const {id,revision,updatedAt,migrationDigest,...config}=old;
   config.targets=config.targets.map(t=>t.id===target.id?{...t,...(plan.discordSignupChannelId?{signupCardChannelId:plan.discordSignupChannelId}:{}),enabledCommandIds:[...new Set([...t.enabledCommandIds,ELECTRICIAN_COMMAND_ID,...(plan.discordSignupChannelId?['wipe']:[])])]}:t);
   config.commands=config.commands.filter(c=>c.id!==ELECTRICIAN_COMMAND_ID).concat({id:ELECTRICIAN_COMMAND_ID,name:'Electricians’ Steam IDs',type:'persistent_card',enabled:true});
   if(plan.discordSignupChannelId){config.commands=config.commands.filter(c=>c.id!=='signup_card');const wipe=config.commands.find(c=>c.id==='wipe');if(wipe){wipe.enabled=true;wipe.type='event_command';}else config.commands.push({id:'wipe',name:'wipe-react',type:'event_command',slashCommand:'wipe-react',signupMode:'member_required',enabled:true});}
   platformService.save(actor,'discord',{expectedRevision:revision,config},{operationId:`enable-discord-electricians-${revision}`});
  }
 }
 const service=owner.getSystem(identity).service;
 for(const rebind of plan.notificationRebindings||[]){
  const target=service.target(rebind.targetId),delivery=service.repo.get('deliveries',rebind.deliveryId);
  if(!delivery||delivery.resource!==undefined||delivery.status!=='sent'||['platform','guildId','channelId'].some(key=>target[key]!==delivery.target[key]))throw Error('Notification rebind scope mismatch');
  const ref=service.resourceRows('messageRefs',delivery).find(r=>r.messageId===rebind.messageId&&r.state!=='deleted');
  if(!ref)throw Error('Notification reference missing');
  const key='rebind:'+ref.messageId;
  const proof=await service.platforms[target.platform].lookup({target,messageRefs:[ref],attemptId:key,operationKey:key,context:{attemptId:key,operationKey:key,executionEpoch:1,timeoutMs:20000,signal:AbortSignal.timeout(20000)}});
  if(proof.outcome!=='found')throw Error('Notification original message not verified');
  service.repo.transaction(()=>{
   const intent=service.repo.get('intents',delivery.intentId),oldId=delivery.targetId;
   delivery.targetId=target.id;delivery.target=target;delivery.selection={...delivery.selection,targetId:target.id};service.repo.put('deliveries',delivery);
   intent.targetIds=intent.targetIds.map(id=>id===oldId?target.id:id);service.repo.put('intents',intent);
   service.repo.put('messageRefs',{...ref,targetId:target.id});
  });
  console.log(JSON.stringify({platform:target.platform,reboundMessageId:ref.messageId,targetId:target.id}));
 }
 const scheduling=new SchedulingService(new SchedulingRepository(db),identity);
 const cards=createPlatformCards({identity,scheduling,notifications:service,platformService,runStoreWriteTask:async fn=>fn()});
 for(const item of plan.cards){
  const adopted=await cards.adoptExisting({actor,platform:item.platform,input:item.input,messageRef:item.messageRef,followSource:item.followSource===true});
  console.log(JSON.stringify({platform:item.platform,cardType:item.input.cardType,...adopted}));
 }
 // Config changes regenerate existing signup action references on the original
 // messages as well. Unknown edits are deliberately left for reconciliation.
 for(const delivery of service.repo.all('deliveries')){
  if(delivery.resource!==undefined||delivery.status!=='sent'||!plan.refreshWipeIds?.includes(delivery.wipeId))continue;
  const target=service.target(delivery.targetId);
  if(!target.enabled||['platform','guildId','channelId'].some(key=>target[key]!==delivery.target[key]))continue;
  if(service.resourceRows('messageOperations',delivery).some(op=>['queued','running','unknown'].includes(op.status)))continue;
  for(const ref of service.resourceRows('messageRefs',delivery).filter(ref=>ref.state==='active'))service.repo.transaction(()=>service.queueMessageOperation(delivery,'edit',{messageRefId:ref.id,actorAccountId:actor.id,reasonCode:'AUTO_SYNC_ENABLED'}));
 }
}finally{await owner?.stop();network?.stop();db?.close();await lease.release();}
