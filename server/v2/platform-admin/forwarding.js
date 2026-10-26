import { hash,identifier,need,UNAVAILABLE } from './model.js';
import { PlatformAdminRepository } from './repository.js';
// Resolve only from saved source/destination facts; request target/route hints never establish authority.
export function resolveForwardRoute(config,record,recordId) {
 need(config?.enabled,'FORWARDING_DISABLED',409);
 need(record&&['discord','kook'].includes(record.from)&&record.to===(record.from==='discord'?'kook':'discord')&&
   record.channel&&record.destination&&record.sourceId,'FORWARD_RECORD_SCOPE_REQUIRED',409);
 need(hash({from:record.from,channel:record.channel,id:record.sourceId,to:record.to,destination:record.destination})===recordId,'FORWARD_RECORD_SCOPE_REQUIRED',409);
 need(record.revision===config.revision,'FORWARD_CONFIG_CHANGED',409);
 const direction=`${record.from}_to_${record.to}`;
 const routes=config.routes.filter(route=>route.enabled&&(!record.routeId||route.id===record.routeId)&&
   (route.direction==='both'||route.direction===direction)&&route[`${record.from}ChannelId`]===record.channel&&route[`${record.to}ChannelId`]===record.destination&&
   (!record.sourceGuildId||route[`${record.from}GuildId`]===record.sourceGuildId)&&(!record.destinationGuildId||route[`${record.to}GuildId`]===record.destinationGuildId));
 need(routes.length===1,'FORWARD_ROUTE_CHANGED',409);
 if(record.routeHash)need(record.routeHash===hash(routes[0]),'FORWARD_ROUTE_CHANGED',409);
 return routes[0];
}
// This is an execution adapter, not a queue or scheduler. A root-owned owner may
// call run explicitly and must drain stop() before closing the shared database.
export function createForwardingAdapter({db,source,messages,translate,now=Date.now,maxMessages=50,timeoutMs=10000}){
 need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000);need(Number.isSafeInteger(maxMessages)&&maxMessages>0&&maxMessages<=50);const repo=new PlatformAdminRepository(db);let stopped=false;const pending=new Set(),controllers=new Set(),ioPending=new Set();
 const bounded=async(fn,args)=>{
  const controller=new AbortController();controllers.add(controller);let timer;
  const cancelled=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('FORWARD_IO_ABORTED')),{once:true});timer=setTimeout(()=>controller.abort(),timeoutMs);});
  const work=Promise.resolve().then(()=>{need(!stopped&&!controller.signal.aborted,'FORWARDING_STOPPED',503);return fn({...args,signal:controller.signal,assertCurrent:()=>{need(!stopped&&!controller.signal.aborted,'FORWARDING_STOPPED',503);return args.assertCurrent?.();}});});
  ioPending.add(work);work.finally(()=>ioPending.delete(work)).catch(()=>{});
  try{return await Promise.race([work,cancelled]);}finally{clearTimeout(timer);controllers.delete(controller);}
 };
 const track=fn=>{need(!stopped,'FORWARDING_STOPPED',503);const promise=Promise.resolve().then(()=>{need(!stopped,'FORWARDING_STOPPED',503);return fn();});pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
 const run=args=>track(()=>execute(args));
 async function execute({actor,config,input,operationId,assertCurrent}){
  need(source?.read&&messages?.publish,UNAVAILABLE,503);assertCurrent();need(config.enabled,'FORWARDING_DISABLED',409);
  const routes=config.routes.filter(r=>r.enabled&&(!input.routeId||r.id===input.routeId));need(routes.length,'FORWARDING_ROUTE_REQUIRED');
  const counts={total:0,succeeded:0,failed:0,skipped:0,unknown:0};const items=[];
  for(const route of routes){
   for(const direction of ['discord_to_kook','kook_to_discord'].filter(d=>route.direction==='both'||route.direction===d)){
    if(stopped)break;assertCurrent();const from=direction==='discord_to_kook'?'discord':'kook',to=from==='discord'?'kook':'discord';
    const channel=route[`${from}ChannelId`],destination=route[`${to}ChannelId`];need(channel&&destination,'FORWARDING_TARGET_REQUIRED');
    const cursorKey=`${route.id}:${hash({channel,destination,direction})}`,cursor=repo.get('forward-cursor',cursorKey)?.cursor||null;
    const page=await bounded(a=>source.read(a),{platform:from,channelId:channel,cursor,limit:Math.min(50,maxMessages),assertCurrent});assertCurrent();
    need(page?.verified===true&&Array.isArray(page.items)&&page.items.length<=Math.min(50,maxMessages),'FORWARD_SOURCE_INVALID',503);
    let complete=true;
    for(const message of page.items){
     if(stopped){complete=false;break;}assertCurrent();identifier(message.id);need(message.channelId===channel,'FORWARD_SOURCE_SCOPE',403);counts.total++;
     const key=hash({from,channel,id:message.id,to,destination});const old=repo.get('forward',key);
     if(old&&old.status!=='retry_ready'){const status=old.status==='succeeded'?'skipped':old.status==='skipped'?'skipped':old.status==='failed'?'failed':'unknown';counts[status]++;if(status!=='skipped')complete=false;continue;}
     const echo=repo.get('forward-echo',hash({platform:from,channel,messageId:message.id}));
     if(message.bot||message.webhook||message.forwarded===true||echo||(!message.content&&!(message.attachments?.length&&route.includeAttachments))){counts.skipped++;repo.put('forward',key,'bridge',actor.id,now(),{status:'skipped',reason:echo?'ECHO':'UNSUPPORTED_OR_BOT',sourceId:message.id});continue;}
     // Persistent claim comes before any external I/O. A process death remains
     // unknown until explicit reconcile, never blind automatic resend.
     repo.put('forward',key,'bridge',actor.id,now(),{version:2,status:'running',phase:'preparing',attempt:(old?.attempt||0)+1,attemptId:`forward:${key}:${(old?.attempt||0)+1}`,sourceId:message.id,operationId,revision:config.revision,from,channel,to,destination,routeId:route.id,routeHash:hash(route),sourceGuildId:route[`${from}GuildId`],destinationGuildId:route[`${to}GuildId`],previousReconciliation:old?.reconciliation||null});
     let sending=false;
     try{
      const raw=String(message.content||'').slice(0,8000);let translations=[];
      if(route.translate){need(typeof translate==='function',UNAVAILABLE,503);translations=await bounded(translate,{text:raw,languages:route.languages||['zh'],model:config.translationModel,assertCurrent});need(Array.isArray(translations)&&translations.length<=6,'TRANSLATION_INVALID',503);}
      assertCurrent();need(!stopped,'FORWARDING_STOPPED',503);
      const clean=s=>String(s).slice(0,8000).replace(/@/g,'＠').replace(/<([@#][^>]+)>/g,'［$1］');
      const attachments=route.includeAttachments?(message.attachments||[]).slice(0,8).flatMap(x=>{try{const u=new URL(x.url);return u.protocol==='https:'&&!u.username&&!u.password?[{name:clean(x.name||'附件'),url:u.href}]:[];}catch{return [];}}):[];
      const claim=repo.get('forward',key);repo.put('forward',key,'bridge',actor.id,now(),{...claim,phase:'dispatching'});
      const persist=(field,value)=>{if(stopped)return;const current=repo.get('forward',key);need(current?.attemptId===claim.attemptId,'FORWARD_ATTEMPT_CHANGED',409);repo.put('forward',key,'bridge',actor.id,now(),{...current,[field]:value});};
      sending=true;const result=await bounded(a=>messages.publish(a),{platform:to,channelId:destination,guildId:route[`${to}GuildId`],attemptId:claim.attemptId,onPrepared:value=>persist('dispatch',value),onEvidence:value=>persist('delivery',value),content:clean(raw),translations:translations.map(x=>({language:clean(x.language),text:clean(x.text)})),attachments,author:clean(message.author||'成员'),allowedMentions:[],origin:{from,channelId:channel,messageId:message.id},operationId:`forward:${key}`,assertCurrent});assertCurrent();
      need(result?.messageId&&result.state==='succeeded','FORWARD_DELIVERY_UNKNOWN',503);
      repo.transaction(()=>{repo.put('forward',key,'bridge',actor.id,now(),{...repo.get('forward',key),status:'succeeded',phase:'complete',messageId:result.messageId});repo.put('forward-echo',hash({platform:to,channel:destination,messageId:result.messageId}),'bridge',actor.id,now(),{key});});counts.succeeded++;
     }catch(e){
      const current=repo.get('forward',key),notSent=current.delivery?.kind==='g06-native'&&current.delivery.outcome==='not_sent';
      const status=!sending||notSent?'failed':'unknown';
      repo.put('forward',key,'bridge',actor.id,now(),{...current,status,...(!sending?{phase:'preparation_failed',delivery:{kind:'local-not-dispatched',attemptId:current.attemptId}}:{}),errorCode:status==='unknown'?'FORWARD_DELIVERY_UNKNOWN':'FORWARD_PREPARATION_FAILED'});
      counts[status]++;complete=false;
     }
    }
    if(complete&&page.nextCursor!==undefined)repo.put('forward-cursor',cursorKey,'bridge',actor.id,now(),{cursor:page.nextCursor});
    items.push({id:route.id,label:route.name||route.id,status:complete?'succeeded':'partial'});
   }
  }
  return {schema:'platform-result/1',state:counts.failed||counts.unknown?'partial':'succeeded',counts,items};
 }
 async function reset({actor,input,operationId,assertCurrent}) {
  assertCurrent();need(typeof input.reason==='string'&&input.reason.trim(),'REASON_REQUIRED');need(source?.reset,UNAVAILABLE,503);
  const r=await bounded(a=>source.reset(a),{routeId:input.routeId,operationId,assertCurrent});assertCurrent();need(!stopped,'FORWARDING_STOPPED',503);
  const rows=repo.db.prepare("SELECT id FROM platform_admin_records WHERE kind='forward-cursor'").all();
  for(const row of rows)if(!input.routeId||row.id.startsWith(`${input.routeId}:`))repo.db.prepare("DELETE FROM platform_admin_records WHERE kind='forward-cursor' AND id=?").run(row.id);
  return {schema:'platform-result/1',state:'succeeded',reference:r?.reference||null};
 }
 async function reconcile({actor,config,input,operationId,assertCurrent}) {
  assertCurrent();identifier(input.recordId);identifier(operationId);
  need(Object.keys(input).every(k=>['recordId','expectedRevision'].includes(k)),'FORWARD_RECONCILE_INPUT_INVALID');
  const key=input.recordId,r=repo.get('forward',key);need(r,'RESOURCE_NOT_FOUND',404);resolveForwardRoute(config,r,key);
  const opKey=hash([actor.id,operationId]),fingerprint=hash(input),old=repo.get('forward-reconcile',opKey);
  if(old){need(old.fingerprint===fingerprint&&old.recordId===key,'IDEMPOTENCY_CONFLICT',409);return old.result||dto(key,'unknown','RECONCILIATION_IN_PROGRESS');}
  need(['unknown','running','failed','retry_ready','succeeded'].includes(r.status),'FORWARD_NOT_RECONCILABLE',409);
  need(messages?.reconcile,UNAVAILABLE,503);
  const observation=row=>hash([row.status,row.phase,row.dispatch,row.delivery,row.messageId]);
  const observed=observation(r),generation=(r.reconcileGeneration||0)+1,attemptId=r.attemptId||null;
  repo.transaction(()=>{
   repo.put('forward',key,'bridge',actor.id,now(),{...r,reconcileGeneration:generation,reconciliation:{operationId,state:'running',evidence:'LOOKUP_PENDING',observedAt:now()}});
   repo.put('forward-reconcile',opKey,'bridge',actor.id,now(),{fingerprint,recordId:key,attemptId,generation,status:'running'});
  });
  const unchanged=()=>{assertCurrent();need(!stopped,'FORWARDING_STOPPED',503);const current=repo.get('forward',key);
   need(current&&current.attemptId===r.attemptId&&current.reconcileGeneration===generation&&observation(current)===observed,'FORWARD_ATTEMPT_CHANGED',409);return current;};
  try {
   const result=r.status==='retry_ready'?{state:'not_delivered',proof:'ALREADY_RECONCILED',evidence:'RETRY_ALREADY_AUTHORIZED'}:
     r.status==='succeeded'?{state:'delivered',messageId:r.messageId,evidence:'ALREADY_DELIVERED'}:
     await bounded(a=>messages.reconcile(a),{record:r,operationId:`forward:${key}`,assertCurrent:unchanged});
   const current=unchanged();need(['delivered','not_delivered','unknown'].includes(result?.state),'FORWARD_RECONCILIATION_INVALID',503);
   let state=result.state,evidence=result.evidence||'LOOKUP_UNCONFIRMED';
   // A custom/lookup result cannot manufacture non-delivery. Verify original durable proof again here.
   const safeRetry=r.status==='retry_ready'||result.proof==='G06_NOT_SENT'&&r.version===2&&r.dispatch&&r.delivery?.kind==='g06-native'&&r.delivery.outcome==='not_sent'&&r.delivery.attemptId===r.attemptId||
     result.proof==='LOCAL_NOT_DISPATCHED'&&r.version===2&&r.phase==='preparation_failed'&&!r.dispatch&&r.delivery?.kind==='local-not-dispatched';
   if(state==='not_delivered'&&!safeRetry){state='unknown';evidence='ABSENCE_DOES_NOT_PROVE_NOT_SENT';}
   if(state==='delivered')identifier(result.messageId);
   const resultDTO=dto(key,state,evidence);
   repo.transaction(()=>{
    repo.put('forward',key,'bridge',actor.id,now(),{...current,status:state==='delivered'?'succeeded':state==='not_delivered'?'retry_ready':'unknown',
      ...(state==='delivered'?{messageId:result.messageId}:{}),reconciliation:{operationId,state,evidence,observedAt:now()}});
    if(state==='delivered')repo.put('forward-echo',hash({platform:r.to,channel:r.destination,messageId:result.messageId}),'bridge',actor.id,now(),{key});
    repo.put('forward-reconcile',opKey,'bridge',actor.id,now(),{fingerprint,recordId:key,attemptId,generation,status:'complete',result:resultDTO});
   });return resultDTO;
  }catch(error){
   const result=dto(key,'unknown','RECONCILIATION_INTERRUPTED');
   repo.transaction(()=>{
    const current=repo.get('forward',key);
    if(current?.attemptId===r.attemptId&&current.reconcileGeneration===generation)repo.put('forward',key,'bridge',actor.id,now(),{...current,
      status:observation(current)!==observed||current.status==='succeeded'?current.status:'unknown',reconciliation:{operationId,state:'unknown',evidence:'RECONCILIATION_INTERRUPTED',observedAt:now()}});
    repo.put('forward-reconcile',opKey,'bridge',actor.id,now(),{fingerprint,recordId:key,attemptId,generation,status:'unknown',result});
   });throw error;
  }
 }
 function dto(key,state,evidence){return {schema:'platform-result/1',state:state==='unknown'?'unknown':'succeeded',reference:key,
  items:[{id:key,label:evidence,status:state==='not_delivered'?'retry_ready':state}],counts:{total:1,succeeded:state==='delivered'?1:0,failed:0,skipped:state==='not_delivered'?1:0,unknown:state==='unknown'?1:0}};}
 return {run,reset:args=>track(()=>reset(args)),reconcile:args=>track(()=>reconcile(args)),async stop(){stopped=true;for(const c of controllers)c.abort();await Promise.allSettled([...pending,...ioPending]);}};
}
