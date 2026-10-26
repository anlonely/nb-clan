import {PlatformAdminRepository} from './repository.js';
import {hash,need} from './model.js';
import {serverConnectTargetId} from './server-connect-card.js';

// The notification worker owns delivery and reconciliation. This scanner only
// admits missing cards through the same authorized preview/publish services.
export function createWipeCardSync({identity,scheduling,notifications,platformService,cards,runStoreWriteTask,now=Date.now}){
 const repo=new PlatformAdminRepository(identity.repo.db);
 const sameDestination=(a,b)=>['platform','guildId','channelId'].every(key=>a?.[key]===b[key]);
 const blocksNewSend=delivery=>!(delivery.status==='cancelled'&&delivery.knownNotSent&&delivery.lastErrorCode==='PREVIEW_STALE');
 function existing(wipe,target,kind){
  if(kind==='signup')return notifications.repo.forWipe('deliveries',wipe.id).some(d=>d.resource===undefined&&sameDestination(d.target,target)&&
   notifications.repo.get('intents',d.intentId)?.purpose==='signup_open'&&blocksNewSend(d));
  return repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='durable-card'").all().some(row=>{
   const record=JSON.parse(row.payload);
   if(record.platform!==target.platform||record.input.cardType!=='server_connect'||record.input.wipeId!==wipe.id)return false;
   return notifications.repo.forResource('deliveries',{kind:'platformCard',id:record.id}).some(d=>sameDestination(d.target,target)&&blocksNewSend(d));
  });
 }
 return async function sync(){
  const wipes=scheduling.repo.all('wipes').filter(w=>['scheduled','active'].includes(w.lifecycle));
  for(const platform of ['kook','discord']){
   const config=platformService.config(platform);
   if(!config.enabled||!config.autoWipeCards)continue;
   const publisher=repo.db.prepare("SELECT actor FROM platform_admin_records WHERE kind='config' AND id=?").get(platform)?.actor;
   if(!publisher)continue;
   for(const wipe of wipes)for(const base of config.targets.filter(t=>t.enabled))for(const kind of ['connect','signup']){
    const command=kind==='connect'?'server_connect_card':platform==='discord'?'wipe':'signup_card';
    const commandType=kind==='signup'&&platform==='discord'?'event_command':'persistent_card';
    if(!base.enabledCommandIds?.includes(command)||!config.commands.some(c=>c.id===command&&c.enabled&&c.type===commandType))continue;
    const channelId=kind==='connect'?base.serverConnectChannelId:base.signupCardChannelId;
    if(!channelId)continue;
    const targetId=kind==='connect'?serverConnectTargetId(base.id,platform):`signup_card_${hash(`${platform}:${base.id}`).slice(0,24)}`;
    const target=notifications.catalog.getTarget(targetId);
    if(!target?.enabled||target.channelId!==channelId||existing(wipe,target,kind))continue;
    const id=hash({platform,wipeId:wipe.id,targetId,channelId,kind});
    let fingerprint;
    try{
     const actor=identity.actorForAccount(publisher);
     fingerprint=hash({wipeRevision:wipe.revision,configRevision:config.revision,actor:actor.id,permissionVersion:actor.permissionVersion,scope:identity.scopeDigest(actor)});
     if(repo.get('wipe-card-auto-publish',id)?.fingerprint===fingerprint)continue;
     platformService.actor(actor,platform,true);
     const assertCurrent=()=>{
      const current=identity.actorForAccount(publisher);
      platformService.actor(current,platform,true);
      need(current.permissionVersion===actor.permissionVersion&&identity.scopeDigest(current)===identity.scopeDigest(actor),'PERMISSIONS_CHANGED',401);
      need(platformService.config(platform).revision===config.revision&&scheduling.repo.get('wipes',wipe.id)?.revision===wipe.revision,'PREVIEW_STALE',409);
      if(kind==='connect')need(!existing(wipe,target,kind),'CARD_ALREADY_EXISTS',409);
     };
     const language=platform==='discord'?'en':'zh-CN',operationId='auto-wipe:'+fingerprint+':'+id.slice(0,24);
     let reference;
     if(kind==='connect'){
      const input={cardType:'server_connect',targetId,wipeId:wipe.id,language};
      const args={actor,platform,input,config,assertCurrent};
      const preview=await cards.preview(args);
      const result=await cards.publish({...args,input:{...input,previewId:preview.preview.id,contentHash:preview.preview.contentHash},operationId});
      reference=result.reference;
     }else{
      if(platform==='discord')await notifications.ensureSignupConnectIp(wipe);
      reference=await runStoreWriteTask(()=>{
       assertCurrent();
       // Recheck after DNS and before the durable transaction to close races
       // with manual publishing and another worker pass.
       if(existing(wipe,target,kind))return null;
       const preview=notifications.createPreview(actor,wipe.id,{expectedContentRevision:wipe.contentRevision,templateId:'wipe-notification',templateRevision:1,
        purpose:'signup_open',purposeInstance:'primary',repeatOfIntentId:null,reason:null,duplicateRiskAcknowledged:false,
        targets:[{targetId,language,mentionMode:'none',roleIds:[]}],audience:wipe.audience,schedule:null},{operationId:operationId+':preview'}).current;
       const intent=notifications.createIntent(actor,wipe.id,{previewId:preview.id,contentHash:preview.contentHash,expectedContentRevision:preview.contentRevision,
        purpose:preview.purpose,purposeInstance:preview.purposeInstance},{operationId:operationId+':publish'}).current;
       return intent.deliveryIds[0];
      });
     }
     await runStoreWriteTask(()=>repo.put('wipe-card-auto-publish',id,platform,publisher,now(),{id,wipeId:wipe.id,targetId,kind,fingerprint,state:'queued',reference}));
    }catch(error){
     if(!error.errorCode)throw error;
     await runStoreWriteTask(()=>repo.put('wipe-card-auto-publish',id,platform,publisher,now(),{id,wipeId:wipe.id,targetId,kind,fingerprint,state:'blocked',errorCode:error.errorCode}));
    }
   }
  }
 };
}
