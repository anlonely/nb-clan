import {randomBytes} from 'node:crypto';
import {authorize} from '../../identity/permissions.js';
import {PlatformAdminRepository} from '../../platform-admin/repository.js';
import {need,hash} from '../../platform-admin/model.js';
import {vipInteraction} from '../../notification-platforms/native-interactions.js';
import {communityLanguage,nativeText} from '../../notification-platforms/native-language.js';
import {localizeResult} from '../../platform-admin/results.js';
const dto=(state,reference,label)=>({schema:'platform-result/1',state,reference,items:[{id:reference||'',label,status:state}]});
export function createRetainedInteractions({identity,notifications,cards,scheduling,updateVip,runStoreWriteTask,now}){
 const repo=new PlatformAdminRepository(identity.repo.db);
 const principal=a=>({id:a.id,version:a.permissionVersion,scope:identity.scopeDigest(a)});
 const wipeTargets=args=>args.source==='discord'&&args.target.signupCardChannelId?[`signup_card_${hash(`discord:${args.target.id}`).slice(0,24)}`,args.target.id]:[args.target.id];
 function intentResult(actor,id,targetIds,language){const targets=Array.isArray(targetIds)?targetIds:[targetIds];const intent=notifications.getIntent(actor,id).intent,rows=notifications.repo.forWipe('deliveries',intent.wipeId).filter(d=>d.intentId===id&&intent.deliveryIds.includes(d.id)&&targets.includes(d.targetId));need(rows.length,'RESOURCE_NOT_FOUND',404);const state=rows.some(d=>d.status==='delivery_unknown')?'unknown':rows.some(d=>d.status==='failed')?'failed':rows.every(d=>d.status==='sent')?'succeeded':'queued';return dto(state,id,nativeText(language,{succeeded:'wipeDelivered',unknown:'wipeUnknown',queued:'wipeQueued',failed:'wipeFailed'}[state]));}
 async function vip(args){
  args.assertCurrent();const a=identity.actorForAccount(args.actor.id),m=identity.repo.get('members',a.memberId);need(m,'MEMBERSHIP_INACTIVE',403);identity.assertMemberParticipation(a);
  const {input}=args,language=communityLanguage(args);
  if(['open','provider'].includes(input.nativeAction))return {...dto('succeeded',null,nativeText(language,'vipChoose')),interaction:vipInteraction(input,undefined,language)};
  if(input.nativeAction==='type'&&input.type!=='none'){
   const token=randomBytes(16).toString('hex');await runStoreWriteTask(()=>{args.assertCurrent();repo.put('vip-modal',token,'discord',a.id,now(),{principal:principal(a),memberId:a.memberId,revision:m.revision,provider:input.provider,type:input.type,year:new Date(now()).getUTCFullYear(),expiresAt:now()+600000});});
   return {...dto('succeeded',null,nativeText(language,'vipDate')),interaction:vipInteraction(input,token,language)};
  }
  let revision=m.revision,purchasedAt;
  if(input.nativeAction==='submit'){
   const context=repo.get('vip-modal',input.contextToken);need(context&&context.expiresAt>now()&&hash(context.principal)===hash(principal(a))&&context.memberId===a.memberId&&context.provider===input.provider&&context.type===input.type,'VIP_CONTEXT_INVALID',403);
   const date=new Date(Date.UTC(context.year,input.month-1,input.day));need(date.getUTCFullYear()===context.year&&date.getUTCMonth()===input.month-1&&date.getUTCDate()===input.day,'VIP_DATE_INVALID',422);purchasedAt=date.toISOString().slice(0,10);revision=context.revision;
  }else need(input.nativeAction==='type'&&input.type==='none','COMMAND_UNSUPPORTED',422);
  const updated=await updateVip({...args,input:{memberId:a.memberId,provider:input.provider,type:input.type,expectedRevision:revision,...(purchasedAt?{purchasedAt}:{})}});
  return dto('succeeded',updated.operationId,nativeText(language,'vipSaved'));
 }
 async function wipe(args){
  need(notifications,'PLATFORM_ADAPTER_UNAVAILABLE',503);
  return runStoreWriteTask(()=>{args.assertCurrent();
   const w=scheduling.getWipe(args.actor,args.input.wipeId),targetIds=wipeTargets(args),targetId=targetIds[0];
   const existing=notifications.repo.all('intents').find(i=>i.wipeId===w.id&&i.purpose==='signup_open'&&i.purposeInstance==='primary'&&targetIds.some(id=>i.targetIds.includes(id)));
   if(existing)return intentResult(args.actor,existing.id,targetIds,communityLanguage(args));
   const p=notifications.createPreview(args.actor,w.id,{expectedContentRevision:w.contentRevision,templateId:'wipe-notification',templateRevision:1,purpose:'signup_open',purposeInstance:'primary',repeatOfIntentId:null,reason:null,duplicateRiskAcknowledged:false,targets:[{targetId,language:args.source==='discord'?'en':'zh-CN',mentionMode:args.input.mentionEveryone?'everyone':'none',roleIds:[]}],audience:w.audience,schedule:null},{operationId:args.operationId+':preview'}).current;
   const intent=notifications.createIntent(args.actor,w.id,{previewId:p.id,contentHash:p.contentHash,expectedContentRevision:p.contentRevision,purpose:p.purpose,purposeInstance:p.purposeInstance},{operationId:args.operationId+':publish'}).current;
   return intentResult(args.actor,intent.id,targetId,communityLanguage(args));
  });
 }
 return {vip,wipe,ranking:args=>cards.switchMetric(args),receipt(args){
  const language=communityLanguage(args);
  if(args.input.command==='wipe_card'&&args.previous?.reference)return intentResult(args.actor,args.previous.reference,wipeTargets(args),language);
  if(args.input.command==='ranking_switch')return cards.interactionReceipt(args);
  // Direct VIP edits return the member-domain receipt; only native interactions
  // produce the card DTO whose labels can be localized on replay.
  if(args.input.command==='vip'&&args.input.nativeAction&&args.previous){
   const {input,previous}=args;
   if(['open','provider'].includes(input.nativeAction))return {...dto('succeeded',previous.reference,nativeText(language,'vipChoose')),interaction:vipInteraction(input,undefined,language)};
   if(previous.interaction?.type===9){const token=previous.interaction.data.custom_id.split(':').at(-1);return {...dto('succeeded',previous.reference,nativeText(language,'vipDate')),interaction:vipInteraction(input,token,language)};}
   return {...previous,items:previous.items.map(item=>({...item,label:nativeText(language,'vipSaved')}))};
  }
  return args.previous?localizeResult(args.previous,language):null;
 }};
}
