import { randomUUID } from 'node:crypto';
import { can, authorize } from '../identity/permissions.js';
import { SyncCenterRepository } from './repository.js';
import { TYPES,LABELS,ACTIVE,INCOMPLETE_JOBS,RETIRED_TYPES,supportedType,need,hash,sync,scopeInput,counts,finish,sourceDefaults,projection } from './model.js';
export class SyncCenterService {
  constructor({db,identity,authority,now=Date.now}) {this.repo=new SyncCenterRepository(db);this.identity=identity;this.authority=authority;this.now=now;}
  fresh(actor){const a=this.identity.actorForAccount(actor?.id);need(a&&a.status==='active'&&!a.restricted,'ACCESS_DENIED',403);return a;}
  allowed(actor,cap,resource){return can(actor,`sync.${cap}`,resource,this.identity.relations());}
  resource(i,j){return {kind:'member',id:i.memberId,wipeId:j?.scope?.wipeId||j?.scope?.id};}
  require(actor,cap,j){actor=this.fresh(actor);const rel=this.identity.relations();if(j?.items?.length&&!j.legacy)for(const i of j.items)authorize(actor,`sync.${cap}`,this.resource(i,j),rel,true);else authorize(actor,`sync.${cap}`,{kind:'sync',id:'global'},rel);return actor;}
  visible(actor,j){return j.items.length&&!j.legacy?j.items.every(i=>this.allowed(actor,'read',this.resource(i,j))):this.allowed(actor,'read',{kind:'sync',id:'global'});}
  touch(j,kind){j.revision++;j.updatedAt=this.now();this.repo.put('job',j);this.repo.event(j.id,kind,this.now());return j;}
  atomic(fn){need(typeof this.authority?.serializeWrite==='function','SYNC_ADAPTER_ATOMICITY_REQUIRED',503);return this.authority.serializeWrite(()=>this.repo.transaction(fn));}
  receipt(actor,operationId){need(typeof operationId==='string'&&operationId.length>=8&&operationId.length<=180,'OPERATION_ID_REQUIRED');return `${actor.id}:${operationId}`;}
  command(actor,operationId,input,fn){const id=this.receipt(actor,operationId);return this.atomic(()=>{actor=this.fresh(actor);const old=this.repo.get('receipt',id);if(old){need(old.hash===hash(input),'IDEMPOTENCY_CONFLICT',409);if(old.jobId)this.require(actor,'read',this.repo.get('job',old.jobId));else this.require(actor,'manage');return old.result;}const result=sync(fn(actor));this.repo.put('receipt',{id,hash:hash(input),result,jobId:result.job?.id||null,updatedAt:this.now()});return result;});}
  job(id){const j=this.repo.get('job',id);need(j&&!j.deleted,'RESOURCE_NOT_FOUND',404);return j;}
  resolve(actor,type,scope,cap='run'){need(!RETIRED_TYPES.includes(type),'SYNC_TYPE_RETIRED',410);need(supportedType(type));if(cap==='run')need(!this.repo.get('source',TYPES[type])?.deleted,'SYNC_SOURCE_REMOVED',409);scope=scopeInput(scope);if(cap==='run'&&['all_members','missing_only'].includes(scope.kind))this.require(actor,'manage');need(typeof this.authority?.resolveScope==='function','SYNC_SOURCE_SETUP_REQUIRED',503);const r=sync(this.authority.resolveScope({actor,type,scope,limit:501}));need(r&&Array.isArray(r.targets)&&r.targets.length<=500&&!r.hasMore,'SYNC_SCOPE_TOO_LARGE',422);if(!r.targets.length)this.require(actor,cap);const seen=new Set();for(const i of r.targets){need(typeof i.memberId==='string'&&!seen.has(i.memberId));seen.add(i.memberId);need(this.allowed(actor,cap,this.resource(i,{scope:r.scope||scope})),'ACCESS_DENIED',403);}return {scope:{...scope,...r.scope},targets:r.targets.map(i=>({memberId:i.memberId,label:String(i.label||i.memberId).slice(0,120)}))};}
  insert(actor,input,{trigger='manual',parentJobId=null,operationId}={}) {
    // Nested savepoint is essential: tick catches per-rule failures inside its outer transaction.
    // Window capture, job insertion and the created event must still roll back together.
    return this.repo.transaction(()=>{
      const {scope,targets}=this.resolve(actor,input.type,input.scope);
      const parent=parentJobId?this.job(parentJobId):null;
      const key=typeof this.authority.scopeKey==='function'
        ? sync(this.authority.scopeKey({type:input.type,scope,targets,parent}))
        : hash([input.type,scope,targets.map(i=>i.memberId)]);
      const active=this.repo.activeJobs().filter(j=>!j.deleted),same=active.find(j=>j.scopeKey===key);
      if(same){this.require(actor,'run',same);return {job:projection(same),deduplicated:true};}
      need(active.length<500,'SYNC_QUEUE_FULL',429);
      const n=this.now();need(input.deadlineMs===undefined||Number.isInteger(input.deadlineMs)&&input.deadlineMs>=1000&&input.deadlineMs<=7*86400000);
      const j={id:randomUUID(),type:input.type,source:TYPES[input.type],scope,scopeKey:key,trigger,parentJobId,operationId,actorId:actor.id,revision:1,createdAt:n,updatedAt:n,deadlineAt:n+(input.deadlineMs??3600000),status:'queued',generation:0,items:targets.map(i=>({...i,status:'pending',attempts:0,revision:1,reason:null,candidates:[]}))};
      if(targets.length&&typeof this.authority.captureScope==='function') {
        this.repo.put('job',j); // Same uncommitted transaction; enables independent persisted-job binding.
        j.scope=sync(this.authority.captureScope({actor,job:j,parent}));
      }
      if(!targets.length)finish(j,n);
      this.repo.put('job',j);this.repo.event(j.id,'created',n);
      return {job:projection(j),deduplicated:false};
    });
  }
  request(actor,input,{operationId}={}) {return this.command(actor,operationId,['request',input],a=>this.insert(a,input,{operationId}));}
  list(actor,query={}) {actor=this.fresh(actor);const limit=Math.max(1,Math.min(50,Number(query.limit)||20));let token=null;try{need(!query.cursor||typeof query.cursor==='string'&&query.cursor.length<=2048,'CURSOR_EXPIRED',410);token=query.cursor?JSON.parse(Buffer.from(query.cursor,'base64url').toString()):null;}catch{need(false,'CURSOR_EXPIRED',410);}need(!token||token.account===actor.id&&token.version===actor.permissionVersion&&token.filter===hash([query.type||'',query.status||'',query.scope||'']),'CURSOR_EXPIRED',410);const rows=this.repo.pageJobs(token?.after),result=[];let last=token?.after||null,scanned=0;for(const j of rows){last={id:j.id,createdAt:j.createdAt};scanned++;if(!j.deleted&&this.visible(actor,j)&&(!query.type||j.type===query.type)&&(!query.status||(query.status==='incomplete'?INCOMPLETE_JOBS.includes(j.status):j.status===query.status))&&(!query.scope||j.scope.kind===query.scope))result.push(projection(j));if(result.length>=limit)break;}const more=scanned<rows.length||rows.length===501;return {items:result,nextCursor:more?Buffer.from(JSON.stringify({account:actor.id,version:actor.permissionVersion,after:last,filter:hash([query.type||'',query.status||'',query.scope||''])})).toString('base64url'):null,countScope:'authorized_jobs'};}
  detail(actor,id,query={}) {actor=this.fresh(actor);const j=this.job(id);this.require(actor,'read',j);const offset=Math.max(0,Number(query.offset)||0),limit=Math.min(50,Math.max(1,Number(query.limit)||20));const visibleItems=j.items.filter(i=>!query.failure||['failed','partial'].includes(i.status)||i.reason==='IDENTITY_CONFLICT');const items=visibleItems.slice(offset,offset+limit).map(i=>({...i,candidates:(i.candidates||[]).map(c=>({...c,memberRevision:c.memberRevision??this.identity.repo.get('members',i.memberId)?.revision??1}))}));const logs=this.allowed(actor,'manage',{kind:'sync',id:'global'})||can(actor,'system.logs',{kind:'sync',id:'global'},this.identity.relations());return {...projection(j),items:items.map(i=>logs?i:{memberId:i.memberId,label:i.label,status:i.status,reason:i.reason,revision:i.revision,candidates:i.candidates,...(i.quality?{quality:i.quality,sourceResults:i.sourceResults||[]}:{})}),nextOffset:offset+limit<visibleItems.length?offset+limit:null,canRun:supportedType(j.type)&&j.items.every(i=>this.allowed(actor,'run',this.resource(i,j))),canManage:j.items.length&&!j.legacy?j.items.every(i=>this.allowed(actor,'manage',this.resource(i,j))):this.allowed(actor,'manage',{kind:'sync',id:'global'}),canConfirmCandidates:j.type==='battlemetrics_identity'&&j.items.every(i=>this.allowed(actor,'run',this.resource(i,j))&&can(actor,'members.basic_edit',{kind:'member',id:i.memberId},this.identity.relations())),diagnostics:logs?{generation:j.generation,leaseUntil:j.leaseUntil||null,owner:j.owner||null,legacyCounts:j.legacyCounts||null,legacyRawCounts:j.legacyRawCounts||null}:undefined};}
  action(actor,id,action,input,{operationId}={}) {return this.command(actor,operationId,['action',id,action,input],a=>{const j=this.job(id);if(['recover','retry','continue'].includes(action))need(supportedType(j.type),'SYNC_TYPE_RETIRED',410);this.require(a,['retry','continue'].includes(action)?'run':'manage',j);need(input.expectedRevision===j.revision,'REVISION_CONFLICT',409,{revision:j.revision,status:j.status});if(j.legacy&&['recover','retry','continue'].includes(action)){need(j.legacyTargetIds?.length,'SYNC_LEGACY_SCOPE_REVIEW_REQUIRED',409);return this.insert(a,{type:j.type,scope:{kind:'members',memberIds:j.legacyTargetIds}},{trigger:'compensation',parentJobId:j.id,operationId});}if(action==='cancel'){need(ACTIVE.includes(j.status),'SYNC_STATE_CONFLICT',409);j.cancelRequested=true;if(j.legacyCounts){j.legacyCounts.skipped+=j.legacyCounts.pendingOrRunning;j.legacyCounts.pendingOrRunning=0;}if(j.status!=='running')finish(j,this.now(),'cancelled');}
    else if(action==='delete'){need(!ACTIVE.includes(j.status),'SYNC_ACTIVE_DELETE',409);j.deleted=true;}
    else if(action==='recover'){need(j.recoveryRequired||j.status==='running'&&j.leaseUntil<=this.now(),'SYNC_RECOVERY_NOT_DUE',409);j.generation++;j.leaseUntil=0;j.owner=null;j.recoveryRequired=false;j.status='queued';for(const i of j.items)if(i.status==='running')i.status='pending';}
    else if(['retry','continue'].includes(action)){need(!ACTIVE.includes(j.status),'SYNC_STATE_CONFLICT',409);const ids=j.items.filter(i=>action==='retry'?['failed','partial'].includes(i.status):i.status!=='succeeded').map(i=>i.memberId);need(ids.length,'SYNC_NO_RETRY_TARGETS',409);return this.insert(a,{type:j.type,scope:{kind:'members',memberIds:ids,wipeId:j.scope.wipeId|| (j.scope.kind==='current_wipe'?j.scope.id:undefined)}},{trigger:'compensation',parentJobId:j.id,operationId});}
    else need(false);this.touch(j,action);return {job:projection(j),...(action==='delete'?{deleted:true}:{})};});}
  operation(actor,id){actor=this.fresh(actor);const r=this.repo.get('receipt',this.receipt(actor,id));need(r,'OPERATION_NOT_FOUND',404);if(r.jobId)this.require(actor,'read',this.repo.get('job',r.jobId));else this.require(actor,'manage');return r.result;}
  sources(actor){
    actor=this.fresh(actor);need((actor.grants||[]).some(g=>g.capability==='sync.read'&&g.effect==='allow'),'ACCESS_DENIED',403);
    const global=this.allowed(actor,'read',{kind:'sync',id:'global'}),canManage=this.allowed(actor,'manage',{kind:'sync',id:'global'});
    const all=[...new Set(Object.keys(TYPES).filter(supportedType).map(type=>TYPES[type]))].map(id=>this.sourceStatus(id));
    return {items:all.filter(s=>!s.deleted).map(s=>global?s:{id:s.id,source:s.id}),removedItems:canManage?all.filter(s=>s.deleted).map(s=>({id:s.id,revision:s.revision})):[],types:Object.entries(LABELS).filter(([id])=>supportedType(id)).map(([id,label])=>({id,label,source:TYPES[id]})),canManage};
  }
  sourceStatus(id){const s=this.repo.get('source',id)||sourceDefaults(id),jobs=this.repo.activeJobs().filter(j=>j.source===id&&!j.deleted);return {...s,queue:{queued:jobs.filter(j=>j.status==='queued').length,running:jobs.filter(j=>j.status==='running').length,retryWait:jobs.filter(j=>j.status==='retry_wait').length,paused:jobs.filter(j=>j.status==='paused').length,manual:jobs.filter(j=>j.trigger==='manual').length,automatic:jobs.filter(j=>j.trigger==='auto').length,oldestCreatedAt:jobs.length?new Date(Math.min(...jobs.map(j=>j.createdAt))).toISOString():null}};}
  saveSource(actor,id,input,{operationId}={}){return this.command(actor,operationId,['source',id,input],a=>{
    this.require(a,'manage');need(Object.values(TYPES).includes(id));need(Object.keys(TYPES).some(type=>supportedType(type)&&TYPES[type]===id),'SYNC_TYPE_RETIRED',410);
    const s=this.repo.get('source',id)||sourceDefaults(id);need(input.expectedRevision===s.revision,'REVISION_CONFLICT',409,{revision:s.revision});
    if(input.delete===true){
      need(!s.deleted,'RESOURCE_NOT_FOUND',404);s.deleted=true;s.paused=true;s.pauseReason='SOURCE_REMOVED';
      for(const r of this.repo.activeRules(101).filter(r=>TYPES[r.type]===id&&r.enabled))this.repo.put('rule',{...r,enabled:false,revision:r.revision+1,updatedAt:this.now()});
      for(const j of this.repo.activeJobs().filter(j=>j.source===id&&!j.deleted)){
        j.cancelRequested=true;if(j.status!=='running')finish(j,this.now(),'cancelled');this.touch(j,'source-removed');
      }
    }else if(input.restore===true){
      need(s.deleted,'SYNC_STATE_CONFLICT',409);s.deleted=false;s.paused=true;s.pauseReason='MANUAL_PAUSE';
    }else{
      need(!s.deleted,'SYNC_SOURCE_REMOVED',409);
      for(const [k,min,max] of [['concurrency',1,10],['reservedManual',0,9],['minIntervalMs',0,3600000],['timeoutMs',100,120000],['maxAttempts',1,10],['priority',0,100]])if(input[k]!==undefined){need(Number.isInteger(input[k])&&input[k]>=min&&input[k]<=max);s[k]=input[k];}
      need(s.reservedManual<s.concurrency);if(input.paused!==undefined){need(typeof input.paused==='boolean');s.paused=input.paused;s.pauseReason=s.paused?'MANUAL_PAUSE':null;}
    }
    s.revision++;s.updatedAt=this.now();this.repo.put('source',s);return {source:s};
  });}

  coverage(actor,query={}){actor=this.fresh(actor);const type=query.type||'battlemetrics_identity';const r=this.resolve(actor,type,{kind:query.scope||'all_members',...(query.id?{id:query.id}:{}),...(query.memberIds?{memberIds:String(query.memberIds).split(',').filter(Boolean)}:{})},'read');for(const i of r.targets)this.require(actor,'read',{items:[i],scope:r.scope});need(typeof this.authority.readCoverage==='function','SYNC_SOURCE_SETUP_REQUIRED',503);const data=sync(this.authority.readCoverage({actor,type,scope:r.scope,targets:r.targets,limit:500}));return {type,scope:r.scope,...data};}
  rules(actor){actor=this.fresh(actor);this.require(actor,'manage');return {items:this.repo.activeRules(101),limit:100};}
  deleteRules(actor,input,{operationId}={}) {
    return this.command(actor,operationId,['delete-rules',input],a=>{
      this.require(a,'manage');
      need(Array.isArray(input.rules)&&input.rules.length>0&&input.rules.length<=100);
      const seen=new Set();
      const rows=input.rules.map(item=>{
        need(item&&typeof item.id==='string'&&!seen.has(item.id)&&Number.isInteger(item.expectedRevision));
        seen.add(item.id);
        const rule=this.repo.get('rule',item.id);
        need(rule&&!rule.deleted,'RESOURCE_NOT_FOUND',404);
        need(item.expectedRevision===rule.revision,'REVISION_CONFLICT',409,{id:rule.id,revision:rule.revision});
        return rule;
      });
      for(const rule of rows)this.repo.put('rule',{...rule,deleted:true,enabled:false,revision:rule.revision+1,updatedAt:this.now()});
      return {deletedRuleIds:rows.map(rule=>rule.id)};
    });
  }
  saveRule(actor,id,input,{operationId}={}){return this.command(actor,operationId,['rule',id,input],a=>{this.require(a,'manage');let r=id?this.repo.get('rule',id):null;need(!id||r&&!r.deleted,'RESOURCE_NOT_FOUND',404);need(input.expectedRevision===(r?.revision||0),'REVISION_CONFLICT',409,{revision:r?.revision||0});if(input.delete){r.deleted=true;r.enabled=false;}else{need(typeof input.name==='string'&&input.name.trim()&&input.name.length<=120);need(Number.isInteger(input.intervalMinutes)&&input.intervalMinutes>=5&&input.intervalMinutes<=10080);need(typeof input.enabled==='boolean');const resolved=this.resolve(a,input.type,input.scope);r={...r,id:r?.id||randomUUID(),name:input.name,type:input.type,scope:scopeInput(input.scope),scopePreview:resolved.scope,intervalMinutes:input.intervalMinutes,enabled:input.enabled,errorCode:null,notes:String(input.notes||'').slice(0,500),actorId:a.id,nextRunAt:this.now()+input.intervalMinutes*60000,createdAt:r?.createdAt||this.now(),lastRunAt:r?.lastRunAt||null};}need(id||this.repo.activeRules(101).length<100,'SYNC_RULE_LIMIT',409);r.revision=(r.revision||0)+1;r.updatedAt=this.now();this.repo.put('rule',r);return {rule:r};});}
  retireTypes() {
    // Called only inside the existing serialized write transaction. Preserve facts/history.
    const n=this.now();
    for(const type of RETIRED_TYPES) {
      const rows=this.repo.db.prepare("SELECT kind,payload FROM sync_center_records WHERE json_extract(payload,'$.type')=? AND ((kind='rule' AND (COALESCE(json_extract(payload,'$.deleted'),0)=0 OR json_extract(payload,'$.enabled')=1)) OR (kind='job' AND status IN ('queued','running','retry_wait','paused')))").all(type);
      for(const row of rows) {
        const r=JSON.parse(row.payload);
        if(row.kind==='rule'&&(!r.deleted||r.enabled))this.repo.put('rule',{...r,enabled:false,deleted:true,errorCode:'SYNC_TYPE_RETIRED',revision:(r.revision||0)+1,updatedAt:n});
        if(row.kind==='job'&&ACTIVE.includes(r.status)) {
          r.generation=(r.generation||0)+1;r.cancelRequested=true;r.recoveryRequired=false;r.reason='SYNC_TYPE_RETIRED';
          if(r.legacyCounts){r.legacyCounts.skipped+=r.legacyCounts.pendingOrRunning;r.legacyCounts.pendingOrRunning=0;}
          finish(r,n,'cancelled');this.touch(r,'type-retired');
        }
      }
    }
  }
  async tick(){return this.atomic(()=>{this.retireTypes();const n=this.now(),result=[];for(const r of this.repo.activeRules(100)){if(!r.enabled||r.deleted||r.nextRunAt>n)continue;try{const actor=this.fresh({id:r.actorId});this.require(actor,'manage');const x=this.insert(actor,{type:r.type,scope:r.scope},{trigger:'auto',operationId:`rule:${r.id}:${r.nextRunAt}`});r.lastJobId=x.job.id;r.lastRunAt=n;r.errorCode=null;result.push(x);}catch(e){r.errorCode=e.errorCode||'SYNC_SETUP_REQUIRED';r.enabled=false;}r.nextRunAt=n+r.intervalMinutes*60000;r.revision++;r.updatedAt=n;this.repo.put('rule',r);}return result;});}
  events(actor,query={}){actor=this.fresh(actor);const after=Number(query.after)||0;need(Number.isSafeInteger(after)&&after>=0);const rows=this.repo.db.prepare('SELECT seq,job_id,at,kind FROM sync_center_events WHERE seq>? ORDER BY seq LIMIT 100').all(after);return {items:rows.flatMap(e=>{const j=this.repo.get('job',e.job_id);return j&&!j.deleted&&this.visible(actor,j)?[{id:e.seq,jobId:j.id,type:'sync.job.changed',revision:j.revision,at:new Date(e.at).toISOString()}]:[];}),nextCursor:rows.at(-1)?.seq||after,hasMore:rows.length===100};}
  runs(actor,query={}){actor=this.fresh(actor);this.require(actor,'manage');return {items:this.repo.rows('run',{after:String(query.cursor||''),limit:50}),countScope:'global_admin',note:'legacy operation run evidence; new executions use job checkpoints'};}
  confirmCandidate(actor,id,input,{operationId}={}) {return this.command(actor,operationId,['candidate',id,input],a=>{const j=this.job(id);this.require(a,'run',j);need(j.type==='battlemetrics_identity'&&!ACTIVE.includes(j.status),'SYNC_STATE_CONFLICT',409);need(j.revision===input.expectedRevision,'REVISION_CONFLICT',409,{revision:j.revision});const i=j.items.find(x=>x.memberId===input.memberId),candidate=i?.candidates?.find(x=>x.battlemetricsId===input.battlemetricsId);need(candidate,'SYNC_CANDIDATE_NOT_FOUND',404);authorize(a,'members.basic_edit',{kind:'member',id:i.memberId},this.identity.relations());need(typeof this.authority.confirmBattlemetricsCandidate==='function','SYNC_ADAPTER_ATOMICITY_REQUIRED',503);sync(this.authority.confirmBattlemetricsCandidate({actor:a,memberId:i.memberId,candidate,expectedMemberRevision:input.expectedMemberRevision,operationId:`sync-candidate:${a.id}:${operationId}`,assertCurrent:()=>{this.require(a,'run',this.job(id));need(this.job(id).revision===input.expectedRevision,'REVISION_CONFLICT',409);}}));i.reason='CANDIDATE_CONFIRMED';i.candidates=[];i.revision++;this.touch(j,'candidate-confirmed');return {job:projection(j)};});}
}
