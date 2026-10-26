import { randomUUID } from 'node:crypto';
import { ACTIVE,need,supportedType,sync,finish,sourceDefaults } from './model.js';
/** One step owns one target. All authoritative commits run inside serializeWrite + the same SQLite transaction. */
export function createSyncCenterWorker(service,{providers={},leaseMs=30000,workerId=randomUUID()}={}) {
  need(leaseMs>=1000);let accepting=true;const controllers=new Set(),pending=new Set();
  const fence=(j,claim)=>{need(supportedType(j.type),'SYNC_CANCELLED',409);need(j.status==='running'&&j.owner===workerId&&j.generation===claim.generation&&j.leaseUntil>service.now(),'SYNC_LEASE_LOST',409);service.require({id:j.actorId},'run',j);need(!j.cancelRequested,'SYNC_CANCELLED',409);};
  async function claimOne(){if(!accepting)return null;return service.atomic(()=>{if(!accepting)return null;service.retireTypes();const n=service.now();const all=service.repo.activeJobs();
    for(const j of all){if(j.status==='running'&&j.leaseUntil>n)continue;if(j.recoveryRequired)continue;
      if(j.deadlineAt<=n||j.cancelRequested){j.generation++;finish(j,n,j.cancelRequested?'cancelled':'expired');service.touch(j,j.status);continue;}
      if(j.status==='running'){j.generation++;j.owner=null;j.leaseUntil=0;for(const i of j.items)if(i.status==='running')i.status='pending';j.status='queued';service.touch(j,'lease-recovered');}
    }
    // Recovery and claiming share one serialized transaction. Reuse these rows;
    // re-reading every queued job per candidate makes a saturated queue quadratic.
    const sources=new Map(),runningBySource=new Map();
    const source=id=>{if(!sources.has(id))sources.set(id,service.repo.get('source',id)||sourceDefaults(id));return sources.get(id);};
    for(const j of all)if(j.status==='running'&&j.leaseUntil>n){const count=runningBySource.get(j.source)||{total:0,automatic:0};count.total++;if(j.trigger!=='manual')count.automatic++;runningBySource.set(j.source,count);}
    const candidates=all.filter(j=>ACTIVE.includes(j.status)&&j.status!=='running'&&!j.recoveryRequired&&(!j.retryAt||j.retryAt<=n)).sort((a,b)=>(a.trigger==='manual'?0:1)-(b.trigger==='manual'?0:1)||source(b.source).priority-source(a.source).priority||a.createdAt-b.createdAt);
    for(const j of candidates){const s=source(j.source);if(s.paused||s.nextAllowedAt>n)continue;const running=runningBySource.get(j.source)||{total:0,automatic:0};if(running.total>=s.concurrency||j.trigger!=='manual'&&running.automatic>=s.concurrency-s.reservedManual)continue;
      try{service.require({id:j.actorId},'run',j);}catch{finish(j,n,'cancelled');j.reason='AUTHORIZATION_REVOKED';service.touch(j,'authorization-revoked');continue;}
      const item=j.items.find(i=>['pending','retry_wait'].includes(i.status));if(!item){finish(j,n);service.touch(j,'finished');continue;}
      j.status='running';j.generation++;j.owner=workerId;j.leaseUntil=n+Math.max(leaseMs,s.timeoutMs+2000);j.startedAt ||= n;j.retryAt=null;item.status='running';item.attempts++;item.revision++;service.touch(j,'claimed');s.nextAllowedAt=n+s.minIntervalMs;service.repo.put('source',s);return {job:j,item,source:s,generation:j.generation};
    }return null;});}
  async function heartbeat(claim){return service.atomic(()=>{const j=service.job(claim.job.id);fence(j,claim);j.leaseUntil=service.now()+Math.max(leaseMs,claim.source.timeoutMs+2000);service.touch(j,'heartbeat');return j.leaseUntil;});}
  async function execute(){const claim=await claimOne();if(!claim)return null;const controller=new AbortController();controllers.add(controller);let timer;
    try{if(!accepting)return await commit(claim,{outcome:'interrupted',reason:'WORKER_STOPPED'});const result=await Promise.race([(async()=>{need(typeof providers[claim.job.type]==='function','SYNC_SOURCE_SETUP_REQUIRED',503);return providers[claim.job.type]({type:claim.job.type,scope:claim.job.scope,memberId:claim.item.memberId,operationId:`sync-item:${claim.job.id}:${claim.item.memberId}`,signal:controller.signal,heartbeat:()=>heartbeat(claim)});})(),new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{errorCode:accepting?'SOURCE_TIMEOUT':'WORKER_STOPPED'})),{once:true});timer=setTimeout(()=>controller.abort(),claim.source.timeoutMs);})]);return await commit(claim,result);}
    catch(e){if(e.errorCode==='SYNC_LEASE_LOST')return {status:'fenced'};return await commit(claim,{outcome:accepting?'retry':'interrupted',reason: e.errorCode==='SYNC_SOURCE_SETUP_REQUIRED'?'SOURCE_NOT_CONFIGURED':e.errorCode==='SOURCE_TIMEOUT'?'SOURCE_TIMEOUT':'SOURCE_UNAVAILABLE'}).catch(error=>{if(['SYNC_LEASE_LOST','SYNC_CANCELLED','ACCESS_DENIED','RESOURCE_NOT_FOUND'].includes(error.errorCode))return {status:'fenced'};throw error;});}
    finally{clearTimeout(timer);controllers.delete(controller);}}
  async function commit(c,result){return service.atomic(()=>{const j=service.job(c.job.id);if(j.owner===workerId&&j.generation===c.generation&&j.leaseUntil>service.now()&&(j.cancelRequested||j.deadlineAt<=service.now())){finish(j,service.now(),j.cancelRequested?'cancelled':'expired');service.touch(j,j.status);return {status:j.status};}try { fence(j,c); } catch (error) {
      if (!['AUTH_REQUIRED','ACCOUNT_DISABLED','PERMISSIONS_CHANGED','ACCESS_RESTRICTED','MEMBERSHIP_INACTIVE','IDENTITY_CONFLICT','ACCESS_DENIED','RESOURCE_NOT_FOUND'].includes(error.errorCode)) throw error;
      // fence checked our live lease before authorization. Finalize only that claim.
      j.generation++; finish(j,service.now(),'cancelled'); j.reason='AUTHORIZATION_REVOKED'; service.touch(j,'authorization-revoked');
      return {status:'cancelled',reason:'AUTHORIZATION_REVOKED'};
    }const i=j.items.find(i=>i.memberId===c.item.memberId),n=service.now(),s=service.repo.get('source',j.source)||c.source;
    need(result&&['success','failed','skipped','retry','common_failure','conflict','interrupted'].includes(result.outcome),'SYNC_PROVIDER_RESULT_INVALID',503);
    // No external response, token, stack or arbitrary provider strings enter the DTO.
    const reasons=new Set(['SOURCE_TIMEOUT','SOURCE_UNAVAILABLE','SOURCE_NOT_CONFIGURED','ADMISSION_ROLE_CONFIG_INVALID','PROXY_UNAVAILABLE','CREDENTIALS_INVALID','RATE_LIMITED','MISSING_IDENTITY','NO_APPLICABLE_DATA','NO_CHANGE','IDENTITY_CONFLICT','INVALID_DATA','WORKER_STOPPED']);
    i.reason=reasons.has(result.reason)?result.reason:({success:null,failed:'SOURCE_UNAVAILABLE',skipped:'NO_APPLICABLE_DATA',retry:'RATE_LIMITED',common_failure:'SOURCE_UNAVAILABLE',conflict:'IDENTITY_CONFLICT',interrupted:'WORKER_STOPPED'})[result.outcome];
    if(result.outcome==='success'){
      need(typeof service.authority.applyResult==='function','SYNC_ADAPTER_ATOMICITY_REQUIRED',503);
      const actor=service.fresh({id:j.actorId});const applied=sync(service.authority.applyResult({actor,type:j.type,scope:j.scope,memberId:i.memberId,result:result.data,operationId:`sync-item:${j.id}:${i.memberId}`,generation:c.generation,assertCurrent:()=>fence(service.job(j.id),c)}));i.status=applied?.quality==='partial'?'partial':applied?.quality&&applied.quality!=='complete'?'failed':'succeeded';
      if(applied?.quality&&applied.quality!=='complete')i.reason='RISK_SCAN_INCOMPLETE';
      if(['complete','partial','unknown'].includes(applied?.quality)){
        i.quality=applied.quality;
        // Authority returns only source names/statuses, never the observed values.
        i.sourceResults=applied.sourceResults||[];
      }
      i.observedAt=result.observedAt||null;i.receivedAt=n;
    }else if(result.outcome==='interrupted'){i.status='pending';j.status='queued';}
    else if(['retry','common_failure'].includes(result.outcome)){
      if(i.attempts>=s.maxAttempts)i.status='failed';else{i.status='retry_wait';j.status='retry_wait';j.retryAt=n+Math.min(3600000,Math.max(1000,Number(result.retryAfterMs)||1000*2**(i.attempts-1)));}
      if(result.outcome==='common_failure'){s.paused=true;s.pauseReason=i.reason;s.revision++;s.updatedAt=n;service.repo.put('source',s);j.status='paused';}
    }else{i.status=result.outcome==='skipped'?'skipped':'failed';if(result.outcome==='conflict')i.candidates=(result.candidates||[]).slice(0,10).filter(x=>/^\d{1,30}$/.test(x.battlemetricsId)).map(x=>({battlemetricsId:x.battlemetricsId,displayName:String(x.displayName||'').slice(0,120),confidence:['direct','verified','alias'].includes(x.confidence)?x.confidence:'alias',memberRevision:Number.isInteger(x.memberRevision)?x.memberRevision:1}));}
    i.revision++;j.owner=null;j.leaseUntil=0;if(j.status==='running')j.status='queued';finish(j,n);service.touch(j,'checkpoint');return {status:j.status,jobId:j.id,memberId:i.memberId};});}
  function step(){if(!accepting)return Promise.resolve(null);const p=execute();pending.add(p);p.finally(()=>pending.delete(p)).catch(()=>{});return p;}
  return {step,heartbeat,async stop(){accepting=false;for(const c of controllers)c.abort();await Promise.allSettled([...pending]);await service.atomic(()=>{});},get accepting(){return accepting;}};
}
