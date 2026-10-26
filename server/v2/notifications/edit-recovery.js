import {hash,need,reason,stamp} from './shared.js';
import {resourceFields} from './business.js';
const pick=(row,keys)=>Object.fromEntries(keys.map(k=>[k,row?.[k]??null]));
const revision=op=>Number.isSafeInteger(op.revision)?op.revision:null;
// The original worker records counters, lease, payload snapshot and an attempt in
// its claim transaction, before any platform I/O. Missing or inconsistent proof fails closed.
function neverDispatched(service,row,op){
 return ['deliveryId','intentId','targetId','messageRefId'].every(key=>row[key]===op[key])&&hash(resourceFields(row))===hash(resourceFields(op))&&
  !row.reconciliation&&!row.cancellation&&row.kind==='edit'&&row.status==='queued'&&row.attemptCount===0&&row.executionEpoch===0&&
  ['currentAttemptId','leaseOwner','leaseUntil','payload','payloadHash','snapshot'].every(key=>row[key]===null)&&
  !service.repo.all('attempts').some(attempt=>attempt.messageOperationId===row.id);
}
const queuedEdits=(service,op)=>service.repo.all('messageOperations').filter(row=>row.id!==op.id&&row.messageRefId===op.messageRefId&&row.kind==='edit'&&row.status==='queued').sort((a,b)=>a.id.localeCompare(b.id));
const queuePins=rows=>rows.map(row=>({id:row.id,stateFingerprint:hash(row)}));
const refFields=['id','platform','guildId','channelId','messageId','messageUrl','contentRevision','rosterRevision','payloadHash','state'];
export function editOperationDTO(service,actor,op){
 const ref=service.repo.get('messageRefs',op.messageRefId),delivery=service.repo.get('deliveries',op.deliveryId);
 return {...pick(op,['id','kind','status','reasonCode','messageRefId','createdAt','updatedAt','executionEpoch','payloadHash','lastErrorCode']),revision:revision(op),stateFingerprint:hash(op),
  snapshot:op.snapshot?pick(op.snapshot,['contentRevision','rosterRevision']):null,
  reference:ref?pick(ref,refFields):null,referenceFingerprint:ref?hash(ref):null,
  queuedEdits:op.kind==='edit'&&op.status==='unknown'?queuedEdits(service,op).map(row=>({...pick(row,['id','reasonCode']),stateFingerprint:hash(row),canCancelBeforeDispatch:neverDispatched(service,row,op)})):[],
  cancellation:op.cancellation?pick(op.cancellation,['reasonCode','actorAccountId','at','operationId','reconciledEditId']):null,
  canReconcile:op.kind==='edit'&&op.status==='unknown'&&service.deliveryPermitted(actor,'reconcile',delivery),
  reconciliation:op.reconciliation?pick(op.reconciliation,['decision','actorAccountId','at','reason','evidence','operationId','fromExecutionEpoch','fromRevision','cancelledQueuedEditIds']):null};
}
export function editRecoveryContext(service,actor,id){
 actor=service.actor(actor);const op=service.repo.get('messageOperations',id);need(op&&op.kind==='edit','RESOURCE_NOT_FOUND',404);
 const delivery=service.repo.get('deliveries',op.deliveryId);service.requireVisibleDelivery(actor,delivery);service.requireResource(actor,delivery);service.requireDeliveryCapability(actor,'reconcile',delivery);
 const {target}=service.executionContext(delivery,{mode:'lookup',actorAccountId:actor.id});
 const ref=service.repo.get('messageRefs',op.messageRefId);need(ref&&ref.deliveryId===delivery.id&&ref.targetId===delivery.targetId,'MESSAGE_REFERENCE_INVALID',409);
 service.validateMessageRef(ref,target);return {actor,op,delivery,ref};
}
export function reconcileEdit(service,actor,id,input,{operationId}={}){
 return service.repo.transaction(()=>{
  const context=editRecoveryContext(service,actor,id);({actor}=context);const {op,delivery,ref}=context;
  const fields=['expectedRevision','expectedExecutionEpoch','expectedStateFingerprint','messageRefId','expectedReferenceFingerprint','expectedPayloadHash','decision','reason','evidence','cancelQueuedEdits'];
  need(input&&typeof input==='object'&&Object.keys(input).every(k=>fields.includes(k)),'NOTIFICATION_INPUT_INVALID',422);reason(input.reason);
  need(['confirmed_updated','confirmed_not_updated'].includes(input.decision),'NOTIFICATION_INPUT_INVALID',422);
  need(typeof input.evidence==='string'&&input.evidence.trim().length>=10&&input.evidence.length<=4000,'EDIT_EVIDENCE_REQUIRED',422);
  const key=service.operationKey(actor,operationId,'notification.edit_reconcile',id,input);
  if(key.existing)return service.receiptResult(actor,key.existing);
  need(op.status==='unknown','EDIT_NOT_UNKNOWN',409);
  need(input.expectedRevision===revision(op)&&input.expectedExecutionEpoch===op.executionEpoch&&input.expectedStateFingerprint===hash(op),'REVISION_CONFLICT',409);
  need(input.messageRefId===ref.id&&input.expectedReferenceFingerprint===hash(ref),'MESSAGE_REFERENCE_CHANGED',409);
  need(/^[a-f0-9]{64}$/.test(op.payloadHash||'')&&input.expectedPayloadHash===op.payloadHash&&op.payload&&hash(op.payload)===op.payloadHash&&Number.isSafeInteger(op.snapshot?.contentRevision),'EDIT_EVIDENCE_UNAVAILABLE',409);
  // A later confirmed or uncertain edit owns the reference; never rewind it.
  need(ref.state==='update_unknown'&&ref.contentRevision<=op.snapshot.contentRevision&&(ref.rosterRevision||0)<=(op.snapshot.rosterRevision||0)&&(!ref.lastMessageOperationId||ref.lastMessageOperationId===op.id),'EDIT_REFERENCE_SUPERSEDED',409);
  const others=service.repo.all('messageOperations').filter(other=>other.id!==op.id&&other.messageRefId===ref.id);
  need(!others.some(other=>other.status==='running'||other.kind==='edit'&&other.status==='unknown'||other.kind!=='edit'&&other.status==='queued'),'EDIT_REFERENCE_BUSY',409);
  const queued=queuedEdits(service,op),confirmed=input.cancelQueuedEdits??[];
  need(Array.isArray(confirmed)&&confirmed.every(pin=>pin&&typeof pin==='object'&&Object.keys(pin).length===2&&typeof pin.id==='string'&&typeof pin.stateFingerprint==='string'),'NOTIFICATION_INPUT_INVALID',422);
  need(queued.every(row=>neverDispatched(service,row,op)),'EDIT_QUEUED_EXECUTION_UNCERTAIN',409);
  need(!queued.length||confirmed.length>0,'EDIT_QUEUED_CONFIRMATION_REQUIRED',409);
  need(hash([...confirmed].sort((a,b)=>a.id.localeCompare(b.id)))===hash(queuePins(queued)),'EDIT_QUEUE_CHANGED',409);
  const at=stamp(service.now),priorEpoch=op.executionEpoch,priorRevision=revision(op);
  op.status=input.decision==='confirmed_updated'?'succeeded':'failed';op.lastErrorCode=input.decision==='confirmed_updated'?null:'EDIT_NOT_UPDATED_CONFIRMED';op.knownNotUpdated=input.decision==='confirmed_not_updated';
  op.executionEpoch++;op.leaseOwner=null;op.leaseUntil=null;op.currentAttemptId=null;op.nextAttemptAt=null;op.updatedAt=at;
  op.reconciliation={decision:input.decision,actorAccountId:actor.id,actorPermissionVersion:actor.permissionVersion,at,reason:input.reason.trim(),evidence:input.evidence.trim(),operationId,fromRevision:priorRevision,fromExecutionEpoch:priorEpoch,messageRefId:ref.id,referenceFingerprint:input.expectedReferenceFingerprint,payloadHash:op.payloadHash,cancelledQueuedEditIds:queued.map(row=>row.id)};
  for(const row of queued){
   const cancellation={reasonCode:'NEVER_DISPATCHED_BEFORE_EDIT_RECONCILIATION',actorAccountId:actor.id,at,operationId,reconciledEditId:op.id,fromRevision:revision(row),fromStateFingerprint:hash(row)};
   service.repo.put('messageOperations',{...row,status:'cancelled',lastErrorCode:'EDIT_CANCELLED_BY_RECONCILIATION',nextAttemptAt:null,updatedAt:at,cancellation});
  }
  service.repo.put('messageOperations',op);
  let next=ref;
  if(input.decision==='confirmed_updated'){
   next=service.recordMessageRef({...delivery,actionReferenceIds:op.actionReferenceIds},ref,op.snapshot.contentRevision);
   next.rosterRevision=op.snapshot.rosterRevision;next.payloadHash=op.payloadHash;
   if(op.snapshot.signupConfigurationRevision)next.configurationRevision=op.snapshot.signupConfigurationRevision;
  }
  // confirmed_not_updated keeps the last known content revision/hash intact.
  service.repo.put('messageRefs',{...next,state:'active',lastMessageOperationId:op.id,updatedAt:at});
  service.changed(delivery,'message.edit_reconciled');
  const receipt=service.saveReceipt(actor,key,operationId,'notification.edit_reconcile','messageOperation',id,{wipeId:delivery.wipeId,...resourceFields(delivery),deliveryId:delivery.id,decision:input.decision,reason:input.reason.trim(),evidence:input.evidence.trim(),cancelledQueuedEditIds:queued.map(row=>row.id)});
  return service.result(receipt,editOperationDTO(service,actor,op));
 });
}
