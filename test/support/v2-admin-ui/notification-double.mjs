/** g06-parallel/1 protocol double. This is not G06-B/C and never invokes a platform.
 * Local SQLite records survive page reloads. Only protected fixture controls supply delivery outcomes.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../../../server/v2/identity/errors.js';
import { can, authorize } from '../../../server/v2/identity/permissions.js';
import { hash } from '../../../server/v2/scheduling/service.js';
const clone = value => structuredClone(value);
const need = (value, code, status = 422, options) => { if (!value) throw new IdentityError(code, status, options); };
const text = (value,max=500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const keys = (input, allowed) => input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(k=>allowed.includes(k));
const uniqueIds = value => Array.isArray(value) && value.length <= 100 && value.every(v=>text(v,160)) && new Set(value).size===value.length;
const iso = value => typeof value==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
export const languages = ['zh-CN','en','ru','tr','th','ko'];
export const purposes = ['signup_open','reminder','schedule_changed','signup_closed','cancelled','result'];
export const targetFixtures = ['discord','kook'].map(platform=>({
  id:`g06_${platform}`,platform,guildId:`g06_${platform}_guild`,channelId:`g06_${platform}_channel`,
  label:platform==='discord'?'Discord 一队公告（协议替身）':'KOOK 一队公告（协议替身）',guildLabel:'隔离构造战队',channelLabel:'开荒公告',
  enabled:true,configurationRevision:1,languages,roleOptions:[{id:`g06_${platform}_members`,label:'一队成员（构造角色）'}],
  capabilities:{preview:true,send:true,mentionRoles:true,mentionEveryone:true},runtimeMode:'isolated'
}));
export const templateFixtures = [{id:'wipe-notification',revision:1,label:'开荒通知（协议替身）',languages,purposes}];
const statusNames = ['queued','sending','sent','retry_wait','failed','delivery_unknown','cancelled'];
const countDeliveries = rows => ({total:rows.length,...Object.fromEntries(statusNames.map(status=>[status,rows.filter(row=>row.status===status).length]))});
function intentStatus(c) {
  if(c.delivery_unknown)return 'needs_attention'; if(c.sending)return 'running'; if(c.total&&c.sent===c.total)return 'completed';
  if(c.total&&c.cancelled===c.total)return 'cancelled'; if(c.failed===c.total&&c.total)return 'failed';
  if(c.failed)return 'partial_failure'; return 'queued';
}
const page = (rows,query={}) => { const limit=Math.max(1,Math.min(50,Number(query.limit)||20)); const start=query.cursor?rows.findIndex(row=>row.id===query.cursor)+1:0;
  const selected=rows.slice(start,start+limit);return {items:selected,nextCursor:start+limit<rows.length?selected.at(-1)?.id||null:null}; };
export function createNotificationDouble({ identity, scheduling, db = identity.repo.db, now = Date.now }) {
  need(db === scheduling.repo.db, 'NOTIFICATION_SETUP_REQUIRED',503);
  db.exec('CREATE TABLE IF NOT EXISTS g06AContractDouble (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
  let state = JSON.parse(db.prepare('SELECT payload FROM g06AContractDouble WHERE id=1').get()?.payload || '{"previews":{},"intents":{},"deliveries":{},"operations":{},"messageOperations":{}}');
  const persist=()=>db.prepare('INSERT INTO g06AContractDouble (id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(state));
  const actorFor=input=>{const actor=identity.actorForAccount(input?.id);need(actor.permissionVersion===input.permissionVersion,'PERMISSIONS_CHANGED',401);return actor;};
  const allowed=(actor,cap,id)=>can(actor,cap,{kind:'platformTarget',id},identity.relations());
  const permit=(actor,cap,id)=>authorize(actor,cap,{kind:'platformTarget',id},identity.relations());
  const visible=(actor,id)=>['preview','send','reconcile'].some(cap=>allowed(actor,`notifications.${cap}`,id));
  const getWipe=(actor,id)=>scheduling.getWipe(actor,id);
  const readIntent=(actor,id)=>{const intent=state.intents[id];need(intent,'RESOURCE_NOT_FOUND',404);getWipe(actor,intent.wipeId);
    const deliveries=Object.values(state.deliveries).filter(d=>d.intentId===id&&visible(actor,d.targetId));need(deliveries.length,'RESOURCE_NOT_FOUND',404);
    const counts=countDeliveries(deliveries);return {...clone(intent),counts,status:intentStatus(counts),countScope:'authorized_targets',deliveryIds:deliveries.map(d=>d.id)};};
  const deliveryDTO=(actor,d)=>({...clone(d),actions:{retry:['failed','retry_wait'].includes(d.status)&&allowed(actor,'notifications.send',d.targetId),
    cancel:['queued','retry_wait'].includes(d.status)&&allowed(actor,'notifications.send',d.targetId),lookup:d.status==='delivery_unknown'&&allowed(actor,'notifications.reconcile',d.targetId),
    reconcile:d.status==='delivery_unknown'&&allowed(actor,'notifications.reconcile',d.targetId),repeat:d.status==='delivery_unknown'&&allowed(actor,'notifications.send',d.targetId)}});
  const readDelivery=(actor,id)=>{const d=state.deliveries[id];need(d,'RESOURCE_NOT_FOUND',404);getWipe(actor,d.wipeId);need(visible(actor,d.targetId),'RESOURCE_NOT_FOUND',404);return deliveryDTO(actor,d);};
  const readPreview=(actor,id)=>{const record=state.previews[id];need(record,'RESOURCE_NOT_FOUND',404);getWipe(actor,record.dto.wipeId);for(const t of record.dto.targets)permit(actor,'notifications.preview',t.target.id);return clone(record.dto);};
  const readResource=(actor,op)=>op.type==='preview'?readPreview(actor,op.id):op.type==='intent'?readIntent(actor,op.id):op.type==='delivery'?readDelivery(actor,op.id):
    {intent:readIntent(actor,op.id),queuedIds:op.queuedIds.filter(id=>visible(actor,state.deliveries[id].targetId)),skippedIds:op.skippedIds.filter(id=>visible(actor,state.deliveries[id].targetId))};
  const replay=(actor,op)=>({operationReceipt:clone(op.receipt),current:readResource(actor,op),replayed:true});
  function mutate(actor,action,input,operationId,perform) {
    need(typeof operationId==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(operationId),'IDEMPOTENCY_KEY_REQUIRED');
    const key=hash([actor.id,operationId]), digest=hash({action,input}),existing=state.operations[key];
    if(existing){need(existing.digest===digest,'IDEMPOTENCY_CONFLICT',409);return replay(actor,existing);}
    const before=clone(state);
    try {const resource=perform(); const receipt={operationId,committedAt:new Date(now()).toISOString(),action,resourceType:resource.type,resourceId:resource.id};
      const op={...resource,receipt,digest,actorId:actor.id};state.operations[key]=op;persist();return {operationReceipt:receipt,current:readResource(actor,op),replayed:Boolean(resource.replayed)};
    }catch(error){state=before;throw error;}
  }
  function selection(actor,value,cap='notifications.preview') {
    need(keys(value,['targetId','language','mentionMode','roleIds']),'TARGET_INVALID');
    const target=targetFixtures.find(t=>t.id===value.targetId&&t.enabled);need(target,'TARGET_INVALID');permit(actor,cap,target.id);
    need(languages.includes(value.language)&&target.languages.includes(value.language),'LANGUAGE_UNSUPPORTED');
    need(['none','roles','everyone'].includes(value.mentionMode)&&uniqueIds(value.roleIds),'MENTION_INVALID');
    if(value.mentionMode==='roles'){permit(actor,'notifications.mention_role',target.id);need(value.roleIds.length&&value.roleIds.every(id=>target.roleOptions.some(r=>r.id===id)),'MENTION_INVALID');}
    else {need(!value.roleIds.length,'MENTION_INVALID');if(value.mentionMode==='everyone')permit(actor,'notifications.mention_everyone',target.id);}
    return target;
  }
  function validateInput(actor,w,input) {
    need(keys(input,['expectedContentRevision','templateId','templateRevision','purpose','purposeInstance','repeatOfIntentId','reason','duplicateRiskAcknowledged','targets','audience','schedule']),'NOTIFICATION_INPUT_INVALID');
    need(Number.isSafeInteger(input.expectedContentRevision)&&input.expectedContentRevision>0,'NOTIFICATION_INPUT_INVALID');
    need(input.templateId==='wipe-notification','TEMPLATE_UNSUPPORTED');need(input.templateRevision===1,'TEMPLATE_REVISION_UNSUPPORTED');
    need(purposes.includes(input.purpose)&&text(input.purposeInstance,160)&&typeof input.duplicateRiskAcknowledged==='boolean','NOTIFICATION_INPUT_INVALID');
    need(input.repeatOfIntentId===null||text(input.repeatOfIntentId,160),'NOTIFICATION_INPUT_INVALID');
    need(input.reason===null||text(input.reason),'REASON_REQUIRED');
    need(Array.isArray(input.targets)&&input.targets.length>0&&input.targets.length<=20&&new Set(input.targets.map(t=>t.targetId)).size===input.targets.length,'TARGET_INVALID');
    for(const s of input.targets)selection(actor,s);
    const a=input.audience;
    need(keys(a,['squadIds','memberIds','includeUnassigned'])&&uniqueIds(a.squadIds)&&uniqueIds(a.memberIds)&&typeof a.includeUnassigned==='boolean','NOTIFICATION_INPUT_INVALID');
    need(a.squadIds.every(id=>w.audience.squadIds.includes(id))&&a.memberIds.every(id=>scheduling.inAudience(w,id))&&(!a.includeUnassigned||w.audience.includeUnassigned),'NOTIFICATION_AUDIENCE_DENIED',403);
    const memberIds=identity.repo.all('members').filter(m=>a.memberIds.includes(m.id)||identity.relations().squadMembers.some(r=>r.memberId===m.id&&!r.validTo&&a.squadIds.includes(r.squadId))||a.includeUnassigned&&!identity.relations().squadMembers.some(r=>r.memberId===m.id&&!r.validTo)).map(m=>m.id);
    for(const memberId of memberIds)authorize(actor,'signups.read',{kind:'signup',wipeId:w.id,memberId},identity.relations());
    need(input.schedule===null||keys(input.schedule,['dueAt','expiresAt'])&&iso(input.schedule.dueAt)&&iso(input.schedule.expiresAt)&&Date.parse(input.schedule.dueAt)>now()&&Date.parse(input.schedule.expiresAt)>Date.parse(input.schedule.dueAt),'SCHEDULE_INVALID');
    if(input.repeatOfIntentId){const previous=readIntent(actor,input.repeatOfIntentId);need(previous.wipeId===w.id,'NOTIFICATION_INPUT_INVALID');need(text(input.reason),'REASON_REQUIRED');
      const unknown=Object.values(state.deliveries).filter(d=>d.intentId===previous.id&&d.status==='delivery_unknown').map(d=>d.targetId);
      need(input.duplicateRiskAcknowledged,'DUPLICATE_RISK_NOT_ACKNOWLEDGED',409);need(input.targets.every(t=>unknown.includes(t.targetId)),'DELIVERY_NOT_UNKNOWN',409);need(input.purposeInstance!=='primary','NOTIFICATION_INPUT_INVALID');
    } else need(input.purposeInstance==='primary'&&input.duplicateRiskAcknowledged===false,'NOTIFICATION_INPUT_INVALID');
  }
  function changedDelivery(d) {d.revision++;d.updatedAt=new Date(now()).toISOString();state.intents[d.intentId].revision++;}
  const service={
    listAdminWipes(input,query={}) {const actor=actorFor(input),order=['draft','scheduled','active','ended','cancelled','archived'];
      const rows=scheduling.repo.all('wipes').filter(w=>(!query.lifecycle||w.lifecycle===query.lifecycle)&&can(actor,'wipes.read',{kind:'wipe',id:w.id},identity.relations()))
        .sort((a,b)=>order.indexOf(a.lifecycle)-order.indexOf(b.lifecycle)||String(a.musterAt||'').localeCompare(String(b.musterAt||''))||a.id.localeCompare(b.id));
      const result=page(rows,query);return {items:result.items.map(w=>({wipe:getWipe(actor,w.id),notificationCounts:countDeliveries(Object.values(state.deliveries).filter(d=>d.wipeId===w.id&&visible(actor,d.targetId)))})),nextCursor:result.nextCursor,countScope:'authorized_wipes'};},
    listWipeOptions(input,query={}) {const actor=actorFor(input);need(['servers','squads','members'].includes(query.kind),'NOTIFICATION_INPUT_INVALID');let rows=[];
      if(query.kind==='servers')rows=[{id:'g06_local_server',label:'一队主服（本地构造）',serverSnapshot:{id:'g06_local_server',name:'一队主服 · 本地构造',address:'127.0.0.1',region:'EU'},serverScheduleSource:'manual'}];
      if(query.kind==='squads')rows=identity.repo.all('squads').filter(s=>can(actor,'squads.read',{kind:'squad',id:s.id},identity.relations())).map(s=>({id:s.id,label:s.name}));
      if(query.kind==='members')rows=identity.repo.all('members').filter(m=>can(actor,'members.read',{kind:'member',id:m.id},identity.relations())).map(m=>({id:m.id,label:m.displayName||m.customName,squadIds:identity.relations().squadMembers.filter(r=>r.memberId===m.id&&!r.validTo).map(r=>r.squadId)}));
      return page(rows.filter(r=>!query.q||r.label.toLowerCase().includes(String(query.q).toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id)),query);},
    getOptions(input,wipeId){const actor=actorFor(input);getWipe(actor,wipeId);return {targets:targetFixtures.filter(t=>allowed(actor,'notifications.preview',t.id)).map(t=>({...clone(t),capabilities:{preview:true,send:allowed(actor,'notifications.send',t.id),mentionRoles:allowed(actor,'notifications.mention_role',t.id),mentionEveryone:allowed(actor,'notifications.mention_everyone',t.id)}})),templates:clone(templateFixtures),allowedPurposes:purposes};},
    createPreview(inputActor,wipeId,input,{operationId}={}) {const actor=actorFor(inputActor),w=getWipe(actor,wipeId);validateInput(actor,w,input);
      return mutate(actor,'notification.preview',{wipeId,...input},operationId,()=>{
        need(w.contentRevision===input.expectedContentRevision,'REVISION_CONFLICT',409,{current:w});const summary=scheduling.summary(actor,wipeId),id=`g06_preview_${randomUUID()}`;
        const dto={id,wipeId,revision:1,contentRevision:w.contentRevision,wipeRevision:w.revision,rosterRevision:summary.rosterRevision,createdAt:new Date(now()).toISOString(),expiresAt:new Date(now()+600000).toISOString(),
          contentHash:hash({wipeId,contentRevision:w.contentRevision,wipeRevision:w.revision,rosterRevision:summary.rosterRevision,input}),templateId:input.templateId,templateRevision:input.templateRevision,
          purpose:input.purpose,purposeInstance:input.purposeInstance,repeatOfIntentId:input.repeatOfIntentId,audience:clone(input.audience),schedule:clone(input.schedule),
          targets:input.targets.map(s=>({target:clone(selection(actor,s)),selection:clone(s),rendered:{title:w.title,body:`[通知协议替身 / ${s.language}] ${w.description}`,fields:[{label:'集合',value:w.musterAt||'未设置'},{label:'语言',value:s.language}],actions:[{label:'查看开荒安排',url:null,action:'open_wipe',disabled:false}],footer:'G06-A 协议替身；未运行正式 C renderer',countScope:summary.countScope},payloadHash:hash({wipeId,input,s}),warnings:[{code:'CONTRACT_DOUBLE',message:'本预览为冻结协议替身，非正式平台卡片。'}]}))};
        state.previews[id]={dto,input:clone(input),createdByAccountId:actor.id};return {type:'preview',id};});},
    createIntent(inputActor,wipeId,input,{operationId}={}) {const actor=actorFor(inputActor),w=getWipe(actor,wipeId);
      need(keys(input,['previewId','contentHash','expectedContentRevision','purpose','purposeInstance'])&&text(input.previewId,160)&&text(input.contentHash,128)&&Number.isSafeInteger(input.expectedContentRevision)&&purposes.includes(input.purpose)&&text(input.purposeInstance,160),'NOTIFICATION_INPUT_INVALID');
      const preview=readPreview(actor,input.previewId);need(state.previews[input.previewId].createdByAccountId===actor.id,'RESOURCE_NOT_FOUND',404);need(preview.wipeId===wipeId,'NOTIFICATION_INPUT_INVALID');for(const t of preview.targets)selection(actor,t.selection,'notifications.send');
      return mutate(actor,'notification.publish-intent',{wipeId,...input},operationId,()=>{
        need(Date.parse(preview.expiresAt)>now(),'PREVIEW_EXPIRED',410);const summary=scheduling.summary(actor,wipeId);
        need(preview.contentHash===input.contentHash&&preview.contentRevision===input.expectedContentRevision&&w.contentRevision===preview.contentRevision&&w.revision===preview.wipeRevision&&summary.rosterRevision===preview.rosterRevision&&preview.purpose===input.purpose&&preview.purposeInstance===input.purposeInstance,'PREVIEW_STALE',409);
        const businessKey=hash({wipeId,contentRevision:preview.contentRevision,purpose:preview.purpose,purposeInstance:preview.purposeInstance,templateId:preview.templateId,templateRevision:preview.templateRevision,
          targets:preview.targets.map(t=>({...t.selection,roleIds:[...t.selection.roleIds].sort()})).sort((a,b)=>a.targetId.localeCompare(b.targetId)),audience:{...preview.audience,squadIds:[...preview.audience.squadIds].sort(),memberIds:[...preview.audience.memberIds].sort()},schedule:preview.schedule});
        const duplicateId=state.businessKeys?.[businessKey];
        if(duplicateId)return {type:'intent',id:duplicateId,replayed:true};
        const id=`g06_intent_${randomUUID()}`,stamp=new Date(now()).toISOString();
        (state.businessKeys||={})[businessKey]=id;
        state.intents[id]={id,wipeId,revision:1,contentRevision:w.contentRevision,purpose:preview.purpose,purposeInstance:preview.purposeInstance,repeatOfIntentId:preview.repeatOfIntentId,createdAt:stamp,createdByAccountId:actor.id,schedule:clone(preview.schedule)};
        for(const t of preview.targets){const deliveryId=`g06_delivery_${randomUUID()}`;state.deliveries[deliveryId]={id:deliveryId,intentId:id,wipeId,targetId:t.target.id,targetLabel:t.target.label,platform:t.target.platform,language:t.selection.language,revision:1,status:'queued',attemptCount:0,executionEpoch:0,nextAttemptAt:null,dueAt:preview.schedule?.dueAt||null,expiresAt:preview.schedule?.expiresAt||null,lastErrorCode:null,lastErrorMessage:null,createdAt:stamp,updatedAt:stamp,sentAt:null,messageRefs:[],cancelRequested:false};}
        return {type:'intent',id};});},
    listIntents(input,wipeId,query={}){const actor=actorFor(input);getWipe(actor,wipeId);return page(Object.values(state.intents).filter(i=>i.wipeId===wipeId).filter(i=>Object.values(state.deliveries).some(d=>d.intentId===i.id&&visible(actor,d.targetId))).map(i=>readIntent(actor,i.id)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),query);},
    getIntent(input,id,query={}){const actor=actorFor(input),intent=readIntent(actor,id),result=page(intent.deliveryIds.map(id=>readDelivery(actor,id)),query);return {intent,deliveries:result.items,nextCursor:result.nextCursor};},
    getDelivery(input,id){const actor=actorFor(input);return {delivery:readDelivery(actor,id),messageOperations:clone((state.messageOperations[id]||[]).slice(-20))};},
    retryFailed(inputActor,id,input,{operationId}={}){const actor=actorFor(inputActor),intent=readIntent(actor,id);need(keys(input,['expectedRevision','reason'])&&Number.isSafeInteger(input.expectedRevision),'NOTIFICATION_INPUT_INVALID');need(text(input.reason),'REASON_REQUIRED');
      const writableIds=intent.deliveryIds.filter(id=>allowed(actor,'notifications.send',state.deliveries[id].targetId));need(writableIds.length,'ACCESS_DENIED',403);
      return mutate(actor,'notification.retry-failed',{id,...input},operationId,()=>{need(intent.revision===input.expectedRevision,'REVISION_CONFLICT',409,{current:intent});const queuedIds=[],skippedIds=[];
        for(const id of intent.deliveryIds){const d=state.deliveries[id];if(writableIds.includes(id)&&['failed','retry_wait'].includes(d.status)){d.status='queued';d.nextAttemptAt=null;changedDelivery(d);queuedIds.push(id);}else skippedIds.push(id);}return {type:'batch',id,queuedIds,skippedIds};});},
    commandDelivery(inputActor,id,command,input,{operationId}={}){const actor=actorFor(inputActor),current=readDelivery(actor,id);need(['retry','cancel','reconcile'].includes(command),'NOTIFICATION_INPUT_INVALID');
      const fields=command==='reconcile'?['expectedRevision','decision','reason','evidence','messageRef']:['expectedRevision','reason'];need(keys(input,fields)&&Number.isSafeInteger(input.expectedRevision),'NOTIFICATION_INPUT_INVALID');need(text(input.reason),'REASON_REQUIRED');
      permit(actor,command==='reconcile'?'notifications.reconcile':'notifications.send',current.targetId);
      return mutate(actor,`notification.delivery.${command}`,{id,...input},operationId,()=>{const d=state.deliveries[id];need(d.revision===input.expectedRevision,'REVISION_CONFLICT',409,{current:readDelivery(actor,id)});
        if(command==='retry'){need(['failed','retry_wait'].includes(d.status),'DELIVERY_NOT_RETRYABLE',409);d.status='queued';d.nextAttemptAt=null;}
        else if(command==='cancel'){need(['queued','retry_wait'].includes(d.status),'DELIVERY_NOT_CANCELLABLE',409);d.status='cancelled';d.cancelRequested=true;}
        else {need(d.status==='delivery_unknown','DELIVERY_NOT_UNKNOWN',409);need(['request_lookup','confirmed_sent','confirmed_not_sent'].includes(input.decision)&&typeof input.evidence==='string','NOTIFICATION_INPUT_INVALID');
          if(input.decision==='confirmed_sent'){const ref=input.messageRef;need(ref&&keys(ref,['platform','guildId','channelId','messageId','messageUrl'])&&ref.platform===d.platform&&text(ref.messageId,160)&&ref.guildId===targetFixtures.find(t=>t.id===d.targetId).guildId&&ref.channelId===targetFixtures.find(t=>t.id===d.targetId).channelId&&ref.messageUrl===null&&text(input.evidence,2000),'DELIVERY_REFERENCE_REQUIRED',409);d.sentAt=new Date(now()).toISOString();d.messageRefs=[{...clone(ref),id:`g06_ref_${randomUUID()}`,contentRevision:state.intents[d.intentId].contentRevision,state:'active',updatedAt:d.sentAt}];d.status='sent';}
          if(input.decision==='confirmed_not_sent'){need(text(input.evidence,2000),'DELIVERY_REFERENCE_REQUIRED',409);need(input.messageRef===null,'NOTIFICATION_INPUT_INVALID');d.status='failed';d.lastErrorCode='CONFIRMED_NOT_SENT';d.lastErrorMessage='管理员根据构造证据确认未送达';}
          if(input.decision==='request_lookup'){need(input.messageRef===null,'NOTIFICATION_INPUT_INVALID');const stamp=new Date(now()).toISOString();(state.messageOperations[id]||=[]).push({id:`g06_lookup_${randomUUID()}`,kind:'lookup',status:'unknown',reasonCode:'CONTRACT_DOUBLE_NO_PLATFORM_LOOKUP',messageRefId:null,createdAt:stamp,updatedAt:stamp});}
        }changedDelivery(d);return {type:'delivery',id};});},
    getOperation(input,id){const actor=actorFor(input),op=state.operations[hash([actor.id,id])];need(op,'RESOURCE_NOT_FOUND',404);return replay(actor,op);},
    control(input){need(keys(input,['deliveryId','status','messageId']),'NOTIFICATION_INPUT_INVALID');const d=state.deliveries[input.deliveryId];need(d,'RESOURCE_NOT_FOUND',404);need(statusNames.includes(input.status),'NOTIFICATION_INPUT_INVALID');
      if(input.status==='sent')need(text(input.messageId,160),'DELIVERY_REFERENCE_REQUIRED',409);
      d.status=input.status;d.attemptCount++;d.executionEpoch++;d.lastErrorCode=input.status==='failed'?'ISOLATED_KNOWN_NOT_SENT':input.status==='delivery_unknown'?'ISOLATED_RESULT_UNKNOWN':null;
      d.lastErrorMessage=d.lastErrorCode?'构造结果，仅验证界面恢复流程':null;
      if(input.status==='sent'){const t=targetFixtures.find(t=>t.id===d.targetId);d.sentAt=new Date(now()).toISOString();d.messageRefs=[{id:`g06_ref_${randomUUID()}`,platform:t.platform,guildId:t.guildId,channelId:t.channelId,messageId:input.messageId,messageUrl:null,contentRevision:state.intents[d.intentId].contentRevision,state:'active',updatedAt:d.sentAt}];}
      changedDelivery(d);persist();return {deliveryId:d.id,status:d.status,revision:d.revision};},
    inspect(){return {implementation:'contract-double',intents:Object.keys(state.intents).length,deliveries:Object.values(state.deliveries).map(({id,intentId,wipeId,targetId,status,revision})=>({id,intentId,wipeId,targetId,status,revision})),operations:Object.values(state.operations).map(o=>o.receipt)};}
  };
  return service;
}
export function createNotificationDoubleRouter({service}) {
  const router=express.Router();
  const wrap=fn=>async(req,res)=>{res.set('X-G06-Notification-Implementation','contract-double; g06-parallel/1');try{
    const {actor}=await req.v2Identity.authenticate(req.method==='GET'?undefined:{mutation:true});const data=await fn(actor,req,res);
    res.json({data,meta:{schemaVersion:1,requestId:req.v2RequestId,serverTime:new Date().toISOString(),scopeVersion:actor.permissionVersion}});
  }catch(e){res.status(e.status||500).json({error:{errorCode:e.errorCode||'ISOLATED_DOUBLE_ERROR',messageKey:e.errorCode||'ISOLATED_DOUBLE_ERROR',fieldErrors:e.fieldErrors||{},requestId:req.v2RequestId,operationId:req.get('Idempotency-Key')||null,retryable:Boolean(e.retryable),current:e.current||null}});}};
  const opts=req=>({operationId:req.get('Idempotency-Key')});
  router.get('/admin/wipes',wrap((a,r)=>service.listAdminWipes(a,r.query)));
  router.get('/admin/wipe-options',wrap((a,r)=>service.listWipeOptions(a,r.query)));
  router.get('/wipes/:id/notification-options',wrap((a,r)=>service.getOptions(a,r.params.id)));
  router.post('/wipes/:id/notification-previews',wrap((a,r,res)=>{res.status(201);return service.createPreview(a,r.params.id,r.body,opts(r));}));
  router.post('/wipes/:id/publish-intents',wrap((a,r,res)=>{res.status(202);return service.createIntent(a,r.params.id,r.body,opts(r));}));
  router.get('/wipes/:id/publish-intents',wrap((a,r)=>service.listIntents(a,r.params.id,r.query)));
  router.get('/publish-intents/:id',wrap((a,r)=>service.getIntent(a,r.params.id,r.query)));
  router.get('/deliveries/:id',wrap((a,r)=>service.getDelivery(a,r.params.id)));
  router.post('/publish-intents/:id/retry-failed',wrap((a,r)=>service.retryFailed(a,r.params.id,r.body,opts(r))));
  router.post('/deliveries/:id/commands/:command',wrap((a,r)=>service.commandDelivery(a,r.params.id,r.params.command,r.body,opts(r))));
  router.get('/notifications/operations/:id',wrap((a,r)=>service.getOperation(a,r.params.id)));
  return router;
}
