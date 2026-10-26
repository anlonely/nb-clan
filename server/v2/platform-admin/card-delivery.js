import {rankingMetrics,RANKING_PREFIX} from '../notification-platforms/native-interactions.js';
import {authorize} from '../identity/permissions.js';
import {hash as payloadHash} from '../notifications/shared.js';
import {PlatformAdminRepository} from './repository.js';
import {need,hash} from './model.js';
import { assertCardViewProof, withCardLanguageButton } from '../notification-platforms/card-language-view.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';
import { serverConnectPayload, discordServerConnectPayload } from './server-connect-card.js';
import { electricianPayload, discordElectricianPayload } from './electrician-card.js';
import { welcomeGuidePayload, discordWelcomeGuidePayload } from './welcome-guide-card.js';

const clean=v=>String(v).replace(/@/g,'＠').replace(/\((met|rol)\)/gi,'（$1）');
function nativePayload(platform,target,rendered){
 if(platform==='kook'&&rendered.cardType==='server_connect'){
  return serverConnectPayload(target.channelId,rendered.details);
 }
 if(platform==='discord'&&rendered.cardType==='server_connect')return discordServerConnectPayload(rendered.details,rendered.language);
 if(platform==='discord'&&rendered.cardType==='electrician_ids')return discordElectricianPayload(rendered.details,rendered.language);
 if(platform==='discord'&&rendered.cardType==='wipe_notice')return rendered.details;
 if(platform==='kook'&&rendered.cardType==='electrician_ids')return electricianPayload(target.channelId,rendered.details);
 if(platform==='kook'&&rendered.cardType==='welcome_guide')return welcomeGuidePayload(target.channelId,rendered.details);
 if(platform==='discord'&&rendered.cardType==='welcome_guide')return discordWelcomeGuidePayload(rendered.details,rendered.language);
 const content=clean(`${rendered.title}\n${rendered.body}`).slice(0,3800);
 return platform==='discord'?{content:'',embeds:[{title:clean(rendered.title).slice(0,200),description:clean(rendered.body).slice(0,3500)}],components:[],allowed_mentions:{parse:[],roles:[],users:[],replied_user:false}}:
  {type:10,target_id:target.channelId,content:JSON.stringify([{type:'card',theme:'secondary',size:'lg',modules:[{type:'section',text:{type:'plain-text',content}},...(rendered.cardType==='ranking'?Array.from({length:Math.ceil(Object.keys(rankingMetrics).length/4)},(_,i)=>({type:'action-group',elements:Object.keys(rankingMetrics).slice(i*4,i*4+4).map(metric=>({type:'button',theme:'secondary',click:'return-val',value:RANKING_PREFIX+':metric:'+metric,text:{type:'plain-text',content:metric}}))})):[])]}])};
}
function payload(platform,target,rendered){
 const body=nativePayload(platform,target,rendered);
 return platform==='discord'?withCardLanguageButton(body,rendered.cardId,rendered.language):body;
}
export function createDurableCards({identity,notifications,platformService,render,runStoreWriteTask,prepareAutoInput=async record=>record.input,refreshWipeCards=async()=>{},now=Date.now}){
 const repo=new PlatformAdminRepository(identity.repo.db),service=notifications;
 const available=()=>{need(service?.identity===identity&&service.repo.db===identity.repo.db&&typeof runStoreWriteTask==='function','PLATFORM_CARD_OWNER_REQUIRED',503);service.repo.requireBusinessSchema('platformCard');};
 const pin=actor=>({accountId:actor.id,permissionVersion:actor.permissionVersion,scopeDigest:identity.scopeDigest(actor)});
 function current(saved){const actor=identity.actorForAccount(saved.accountId);need(actor.permissionVersion===saved.permissionVersion&&identity.scopeDigest(actor)===saved.scopeDigest,'PERMISSIONS_CHANGED',401);return actor;}
 function configured(record,mode='send'){
  const actor=current(record.principal),config=platformService.config(record.platform);
  platformService.actor(actor,record.platform,true);
  need(config.enabled&&config.revision===record.configurationRevision,'PREVIEW_STALE',409);
  const target=service.target(record.input.targetId);
  need(target.enabled&&hash(target)===record.targetHash,'PREVIEW_STALE',409);
  authorize(actor,mode==='lookup'?'notifications.reconcile':'notifications.send',{kind:'platformTarget',id:target.id},identity.relations());
  const rendered=render({actor,platform:record.platform,input:record.input,config});
  need(rendered.target.guildId===target.guildId&&rendered.target.channelId===target.channelId&&target.platform===record.platform,'PLATFORM_TARGET_SCOPE_MISMATCH',403);
  if(record.editPrincipal){const editor=current(record.editPrincipal);need(identity.identity('kook',record.editPrincipal.externalId)?.accountId===editor.id,'IDENTITY_CONFLICT',409);render({actor:editor,platform:record.platform,input:record.input,config,community:true});}
  return {actor,target,rendered};
 }
 function recordFor(delivery){const record=repo.get('durable-card',delivery.resource.id);need(record&&delivery.resource.kind==='platformCard','RESOURCE_NOT_FOUND',404);return record;}
 const domain={
  visible(actor,delivery){try{const r=recordFor(delivery);need(actor.id===r.principal.accountId,'RESOURCE_NOT_FOUND',404);configured(r);return true;}catch{return false;}},
  executionContext(delivery,{mode,actorAccountId}={}){
   const record=recordFor(delivery);need(!actorAccountId||actorAccountId===record.principal.accountId,'ACCESS_DENIED',403);
   const context=configured(record,mode?.startsWith('lookup')?'lookup':'send');
   if(mode==='send')need(record.sendHash===delivery.binding?.renderHash&&context.rendered.contentHash===record.sendHash,'PREVIEW_STALE',409);
   return context;
  },
  renderEdit(delivery){const record=recordFor(delivery),context=configured(record),target=context.target,rendered=record.editPrincipal?render({actor:current(record.editPrincipal),platform:record.platform,input:record.input,config:platformService.config(record.platform),community:true}):context.rendered;need(record.editHash&&rendered.contentHash===record.editHash,'PREVIEW_STALE',409);const body=payload(record.platform,target,rendered);return {payload:body,payloadHash:payloadHash(body),snapshot:{contentRevision:record.editRevision,rosterRevision:0},actionReferenceIds:[]};},
  refresh:()=>refreshChangedCards(),
  validateInboxReference(){need(false,'DELIVERY_REFERENCE_REQUIRED',422);}
 };
 if(service?.repo.scalar('v2NotificationPlatformCardSchemaVersion')===1){available();service.registerBusinessDomain('platformCard',domain);}
 function result(reference,kind='delivery'){
  const row=service.repo.get(kind==='delivery'?'deliveries':'messageOperations',reference);need(row,'RESOURCE_NOT_FOUND',404);
  const status=row.status,state=status==='sent'||status==='succeeded'?'succeeded':['delivery_unknown','unknown','result_unknown'].includes(status)?'unknown':status==='sending'||status==='running'?'running':status==='retry_wait'?'queued':status;
  return {schema:'platform-result/1',state,reference,errorCode:row.lastErrorCode||null,items:[{id:reference,label:state==='succeeded'?(kind==='delivery'?'卡片已送达':'原卡已更新'):state==='queued'?'卡片已排队，尚未送达':state==='unknown'?'投递结果未知，不会自动重发':'卡片状态：'+state,status:state}]};
 }
 async function submit(args,edit=false){
  let committed=false;try{available();need(service.businessDomains?.platformCard===domain,'PLATFORM_CARD_OWNER_REQUIRED',503);
  return await runStoreWriteTask(()=>{args.assertCurrent();const value=service.repo.transaction(()=>{
   const commandKey=hash([args.actor.id,args.operationId]),old=repo.get('card-command',commandKey);
   if(old)return result(old.reference,old.kind);
   const preview=repo.get('card-preview',args.input.previewId);need(preview&&preview.actorId===args.actor.id&&preview.platform===args.platform,'RESOURCE_NOT_FOUND',404);
   need(!Object.hasOwn(args.input,'serverConnectOverride'),'SERVER_CONNECT_INPUT_INVALID',422);
   if(preview.input.cardType==='server_connect'||args.input.cardType==='server_connect')need(args.input.cardType===preview.input.cardType&&args.input.targetId===preview.input.targetId&&args.input.wipeId===preview.input.wipeId,'PREVIEW_STALE',409);
   need(preview.expiresAt>now(),'PREVIEW_EXPIRED',409);
   const rendered=render({...args,input:preview.input});need(rendered.contentHash===preview.contentHash&&args.input.contentHash===preview.contentHash,'PREVIEW_STALE',409);
   const actor=identity.actorForAccount(args.actor.id),target=service.target(preview.input.targetId);
   const slot=hash({platform:args.platform,target:target.id,cardType:preview.input.cardType,commandId:preview.input.commandId||'',wipeId:preview.input.wipeId||'',actor:actor.id});
   const resource={kind:'platformCard',id:slot},previous=repo.get('durable-card',slot);
   const deliveries=service.repo.forResource('deliveries',resource);
   need(!deliveries.some(d=>['queued','retry_wait','sending','delivery_unknown'].includes(d.status)),'CARD_DELIVERY_PENDING',409);
   const operations=service.repo.forResource('messageOperations',resource);
   const pending=operations.filter(o=>['queued','running','unknown','result_unknown'].includes(o.status));
   // A manual refresh can observe the same update already admitted by auto-sync.
   // Return its receipt only when the exact original and approved payload match.
   const existing=pending.length===1?pending[0]:null;
   if(edit&&preview.input.cardType==='server_connect'&&existing?.kind==='edit'&&
     ['queued','running'].includes(existing.status)&&existing.deliveryId===previous?.deliveryId){
    const delivery=deliveries.find(d=>d.id===existing.deliveryId&&d.status==='sent');
    if(delivery){
     const existingHash=existing.payloadHash||(existing.status==='queued'?domain.renderEdit(delivery).payloadHash:null);
     if(existingHash===payloadHash(payload(args.platform,target,rendered))){
      configured(previous);
      // An equivalent native payload can still change whether later scans
      // follow the wipe or retain a manually approved connection override.
      const approved={...previous,input:preview.input,principal:pin(actor),targetHash:hash(target),configurationRevision:args.config.revision,
       sourceRevision:service.scheduling.repo.get('wipes',preview.input.wipeId)?.revision,followSource:!preview.input.serverConnectOverride,editHash:rendered.contentHash};
      configured(approved);repo.put('durable-card',slot,args.platform,actor.id,now(),approved);
      repo.put('card-command',commandKey,args.platform,actor.id,now(),{reference:existing.id,kind:'messageOperation',resource});
      return result(existing.id,'messageOperation');
     }
    }
   }
   need(!pending.length,'CARD_UPDATE_PENDING',409);
   const record={id:slot,platform:args.platform,input:preview.input,principal:pin(actor),targetHash:hash(target),configurationRevision:args.config.revision,
    sourceRevision:service.scheduling.repo.get('wipes',preview.input.wipeId)?.revision,followSource:!preview.input.serverConnectOverride,sendHash:previous?.sendHash,editHash:rendered.contentHash,editRevision:(previous?.editRevision||0)+1};
   if(!edit)record.sendHash=rendered.contentHash;
   configured(record);repo.put('durable-card',slot,args.platform,actor.id,now(),record);
   let reference,kind;
   if(edit){
    const delivery=deliveries.find(d=>d.id===previous?.deliveryId&&d.status==='sent');need(delivery,'MESSAGE_REFERENCE_REQUIRED',409);
    const refs=service.resourceRows('messageRefs',delivery).filter(r=>r.deliveryId===delivery.id&&r.state==='active');need(refs.length===1,'MESSAGE_REFERENCE_REQUIRED',409);
    const op=service.queueMessageOperation(delivery,'edit',{messageRefId:refs[0].id,actorAccountId:actor.id});reference=op.id;kind='messageOperation';record.deliveryId=delivery.id;
   }else{
    const body=payload(args.platform,target,preview.input.serverConnectOverride?preview:rendered),admitted=service.createBusinessIntent({resource,purpose:'card.publish',unitKey:commandKey,language:preview.input.language||'zh-CN',createdByAccountId:actor.id,target,payload:body,payloadHash:payloadHash(body),snapshot:{contentRevision:record.editRevision,rosterRevision:0},binding:{renderHash:record.sendHash},event:{id:commandKey,type:'platform.card.publish'}});
    reference=admitted.deliveryId||service.repo.forResource('deliveries',resource).find(d=>d.intentId===admitted.intentId)?.id;kind='delivery';record.deliveryId=reference;
   }
   repo.put('durable-card',slot,args.platform,actor.id,now(),record);repo.put('card-command',commandKey,args.platform,actor.id,now(),{reference,kind,resource});return result(reference,kind);
  });committed=true;return value;});}catch(error){if(!committed)error.definitelyNotApplied=true;throw error;}
 }
 const syncTypes=new Set(['server_connect','electrician_ids','welcome_guide','wipe_notice']);
 let nextScan=0;
 async function refreshChangedCards(){
  if(now()<nextScan)return;
  nextScan=now()+15000;
  await refreshWipeCards();
  const records=repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='durable-card' ORDER BY rowid DESC LIMIT 1000").all().map(row=>JSON.parse(row.payload));
  for(const saved of records){
   if(!syncTypes.has(saved.input.cardType))continue;
   const delivery=service.repo.get('deliveries',saved.deliveryId);
   if(delivery?.status!=='sent')continue;
   try{
    platformService.actor(identity.actorForAccount(saved.principal.accountId),saved.platform,true);
    const target=service.target(saved.input.targetId);
    need(target.enabled&&['platform','guildId','channelId'].every(key=>target[key]===delivery.target[key]),'PLATFORM_TARGET_SCOPE_MISMATCH',403);
    const pending=service.repo.forResource('messageOperations',delivery.resource).filter(op=>['queued','running','unknown','result_unknown'].includes(op.status));
    if(pending.length){
     // An uncertain edit still needs explicit reconciliation. Renew only the
     // lookup authorization of the same publisher; never queue or retry it.
     if(pending.every(op=>['unknown','result_unknown'].includes(op.status)))await runStoreWriteTask(()=>service.repo.transaction(()=>{
      const record=repo.get('durable-card',saved.id);need(hash(record)===hash(saved),'CARD_UPDATE_PENDING',409);
      const actor=identity.actorForAccount(record.principal.accountId),next={...record,principal:pin(actor),configurationRevision:platformService.config(record.platform).revision,targetHash:hash(target)};
      configured(next,'lookup');
      if(hash(next)!==hash(record))repo.put('durable-card',record.id,record.platform,actor.id,now(),next);
      repo.put('card-auto-sync',record.id,record.platform,actor.id,now(),{id:record.id,checkedAt:new Date(now()).toISOString(),state:'blocked',errorCode:'CARD_EDIT_RECONCILIATION_REQUIRED'});
     }));
     continue;
    }
    const input=await prepareAutoInput(saved);
    await runStoreWriteTask(()=>service.repo.transaction(()=>{
     const record=repo.get('durable-card',saved.id);need(hash(record)===hash(saved),'CARD_UPDATE_PENDING',409);
     const actor=identity.actorForAccount(record.principal.accountId),config=platformService.config(record.platform),currentTarget=service.target(input.targetId);
     need(currentTarget.enabled&&['platform','guildId','channelId'].every(key=>currentTarget[key]===delivery.target[key]),'PLATFORM_TARGET_SCOPE_MISMATCH',403);
     if(service.repo.forResource('messageOperations',delivery.resource).some(op=>['queued','running','unknown','result_unknown'].includes(op.status)))return;
     const refs=service.resourceRows('messageRefs',delivery).filter(ref=>ref.deliveryId===delivery.id&&['active','update_failed'].includes(ref.state));
     need(refs.length===1,'MESSAGE_REFERENCE_REQUIRED',409);
     // Refresh the same active publisher, then reauthorize every capability and target before persisting its new permission pin.
     const next={...record,input,principal:pin(actor),configurationRevision:config.revision,targetHash:hash(currentTarget)};
     const rendered=configured(next).rendered,body=payload(record.platform,currentTarget,rendered);
     next.editHash=rendered.contentHash;
     const changed=payloadHash(body)!==(refs[0].payloadHash||delivery.payloadHash);
     const failed=service.repo.get('messageOperations',refs[0].lastMessageOperationId);
     if(failed?.status==='failed'&&failed.payloadHash===payloadHash(body))return;
     if(changed)next.editRevision=(record.editRevision||0)+1;
     if(hash(next)!==hash(record))repo.put('durable-card',record.id,record.platform,actor.id,now(),next);
     const op=changed?service.queueMessageOperation(delivery,'edit',{messageRefId:refs[0].id,actorAccountId:actor.id,reasonCode:'CARD_SOURCE_CHANGED'}):null;
     repo.put('card-auto-sync',record.id,record.platform,actor.id,now(),{id:record.id,checkedAt:new Date(now()).toISOString(),state:changed?'queued':'current',operationId:op?.id||null});
    }));
   }catch(error){
    if(!error.errorCode)throw error;
    await runStoreWriteTask(()=>repo.put('card-auto-sync',saved.id,saved.platform,saved.principal.accountId,now(),{id:saved.id,checkedAt:new Date(now()).toISOString(),state:'blocked',errorCode:error.errorCode}));
   }
  }
 }
 // Trusted maintenance admission: an exact native lookup must prove that the
 // original message exists. Register it as sent; never submit another POST.
 async function adoptExisting({actor,platform,input,messageRef,followSource=false}){
  available();actor=identity.actorForAccount(actor.id);platformService.actor(actor,platform,true);
  const config=platformService.config(platform),target=service.target(input.targetId);
  need(target.platform===platform,'PLATFORM_TARGET_SCOPE_MISMATCH',403);
  const exact=service.validateMessageRef(messageRef,target);
  authorize(actor,'notifications.reconcile',{kind:'platformTarget',id:target.id},identity.relations());
  const lookup=await service.platforms[platform].lookup({target,attemptId:'adopt:'+exact.messageId,operationKey:'adopt:'+exact.messageId,messageRefs:[exact],context:{attemptId:'adopt:'+exact.messageId,operationKey:'adopt:'+exact.messageId,executionEpoch:1,timeoutMs:20000,signal:AbortSignal.timeout(20000)}});
  need(lookup?.outcome==='found'&&lookup.messageRef.messageId===exact.messageId,'MESSAGE_REFERENCE_REQUIRED',409);
  return runStoreWriteTask(()=>service.repo.transaction(()=>{
   actor=identity.actorForAccount(actor.id);
   platformService.actor(actor,platform,true);
   authorize(actor,'notifications.reconcile',{kind:'platformTarget',id:target.id},identity.relations());
   const rendered=render({actor,platform,input,config:platformService.config(platform)});
   need(['platform','guildId','channelId'].every(key=>service.target(input.targetId)[key]===target[key]),'PLATFORM_TARGET_SCOPE_MISMATCH',403);
   const slot=hash({platform,target:target.id,cardType:input.cardType,commandId:input.commandId||'',wipeId:input.wipeId||'',actor:actor.id}),resource={kind:'platformCard',id:slot};
   const previous=repo.get('durable-card',slot),body=payload(platform,target,rendered);
   need(!service.repo.forResource('messageOperations',resource).some(op=>['queued','running','unknown','result_unknown'].includes(op.status)),'CARD_UPDATE_PENDING',409);
   const record={...previous,id:slot,platform,input,principal:pin(actor),targetHash:hash(target),configurationRevision:platformService.config(platform).revision,
    sendHash:previous?.sendHash||rendered.contentHash,editHash:rendered.contentHash,editRevision:previous?.editRevision||1,followSource};
   repo.put('durable-card',slot,platform,actor.id,now(),record);configured(record);
   let delivery=previous?.deliveryId&&service.repo.get('deliveries',previous.deliveryId);
   if(delivery){need(delivery.status==='sent','CARD_DELIVERY_PENDING',409);const refs=service.resourceRows('messageRefs',delivery);need(refs.some(ref=>ref.messageId===exact.messageId&&ref.channelId===exact.channelId),'MESSAGE_REFERENCE_REQUIRED',409);}
   else{
    need(!service.repo.all('messageRefs').some(ref=>ref.platform===exact.platform&&ref.guildId===exact.guildId&&ref.channelId===exact.channelId&&ref.messageId===exact.messageId),'MESSAGE_ALREADY_REGISTERED',409);
    const admitted=service.createBusinessIntent({resource,purpose:'card.publish',unitKey:hash(['adopt',exact]),language:input.language||'zh-CN',createdByAccountId:actor.id,target,payload:body,payloadHash:payloadHash(body),snapshot:{contentRevision:record.editRevision,rosterRevision:0},binding:{renderHash:record.sendHash},event:{id:'adopt:'+exact.messageId,type:'platform.card.adopted'}});
    delivery=service.repo.get('deliveries',admitted.deliveryId);delivery.status='sent';delivery.knownNotSent=false;delivery.sentAt=new Date(now()).toISOString();service.repo.put('deliveries',delivery);
    service.recordMessageRef(delivery,exact,record.editRevision);
   }
   record.deliveryId=delivery.id;repo.put('durable-card',slot,platform,actor.id,now(),record);
   // Force one canonical edit after adoption, then compare confirmed hashes.
   service.queueMessageOperation(delivery,'edit',{messageRefId:service.resourceRows('messageRefs',delivery).find(ref=>ref.messageId===exact.messageId).id,actorAccountId:actor.id,reasonCode:'AUTO_SYNC_ENABLED'});
   return {id:slot,deliveryId:delivery.id,messageId:exact.messageId};
  }));
 }
 function interactionReceipt({actor,operationId}){
  const op=repo.get('ranking-interaction',hash([actor.id,operationId]));if(!op)return null;
  const r=repo.get('durable-card',op.resourceId);need(r,'RESOURCE_NOT_FOUND',404);const currentActor=identity.actorForAccount(actor.id);authorize(currentActor,'stats.read',{kind:'wipe',id:r.input.wipeId},identity.relations());configured(r);return result(op.reference,'messageOperation');
 }
 async function switchMetric(args){
  available();return runStoreWriteTask(()=>{args.assertCurrent();return service.repo.transaction(()=>{
   const old=interactionReceipt(args);if(old)return old;
   const refs=service.repo.all('messageRefs').filter(r=>r.platform==='kook'&&r.channelId===args.proof.channelId&&r.messageId===args.input.messageId&&r.state==='active');need(refs.length===1,'MESSAGE_REFERENCE_REQUIRED',409);
   const ref=refs[0],delivery=service.repo.get('deliveries',ref.deliveryId),record=recordFor(delivery);need(record.platform==='kook'&&record.input.cardType==='ranking'&&record.input.targetId===args.target.id&&ref.guildId===args.target.guildId&&delivery.status==='sent','MESSAGE_REFERENCE_REQUIRED',409);
   configured(record);need(!service.repo.forResource('messageOperations',delivery.resource).some(o=>['queued','running','unknown','result_unknown'].includes(o.status)),'CARD_UPDATE_PENDING',409);
   const actor=identity.actorForAccount(args.actor.id),input={...record.input,metric:args.input.metric};
   const rendered=render({actor,platform:'kook',input,config:args.config,community:true});
   const updated={...record,input,editHash:rendered.contentHash,editRevision:record.editRevision+1,editPrincipal:{...pin(actor),externalId:args.proof.externalId}};
   repo.put('durable-card',record.id,'kook',record.principal.accountId,now(),updated);
   const operation=service.queueMessageOperation(delivery,'edit',{messageRefId:ref.id,actorAccountId:record.principal.accountId,reasonCode:'RANKING_METRIC_SWITCH'});
   repo.put('ranking-interaction',hash([actor.id,args.operationId]),'kook',actor.id,now(),{reference:operation.id,resourceId:record.id});return result(operation.id,'messageOperation');
  });});
 }
 function localizedView(proof){
  assertCardViewProof(proof);available();
  need(proof.payload.cardKind==='card','RESOURCE_NOT_FOUND',404);
  const record=repo.get('durable-card',proof.payload.reference);
  need(record?.platform==='discord','RESOURCE_NOT_FOUND',404);
  const delivery=service.repo.get('deliveries',record.deliveryId);
  need(delivery?.status==='sent'&&delivery.resource?.kind==='platformCard'&&delivery.resource.id===record.id,'RESOURCE_NOT_FOUND',404);
  const refs=service.resourceRows('messageRefs',delivery).filter(ref=>ref.deliveryId===delivery.id&&ref.state==='active'&&ref.platform==='discord'&&ref.guildId===proof.guildId&&ref.channelId===proof.channelId&&ref.messageId===proof.originMessageId);
  need(refs.length===1,'RESOURCE_NOT_FOUND',404);
  const {actor,target}=configured(record);
  need(target.guildId===proof.guildId&&target.channelId===proof.channelId,'RESOURCE_NOT_FOUND',404);
  const rendered=render({actor,platform:'discord',input:{...record.input,language:discordInteractionLanguage(proof.locale)},config:platformService.config('discord')});
  return nativePayload('discord',target,rendered);
 }
 return {localizedView,adoptExisting,switchMetric,interactionReceipt,publish:a=>submit(a),refresh:a=>submit(a,true),receipt({actor,operation}){available();const command=repo.get('card-command',hash([actor.id,operation.operationId]));if(!command)return null;const r=repo.get('durable-card',command.resource.id);need(r.principal.accountId===actor.id,'RESOURCE_NOT_FOUND',404);configured(r);return result(command.reference,command.kind);}};
}
