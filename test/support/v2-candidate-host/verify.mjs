// Synthetic verification data only. Product launcher and factory never import this file.
import {observations} from './test-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {candidateConfig,paths,digest,checkDirectory,checkDatabase} from '../../../server/v2/candidate-host/config.js';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,validateCandidateReady,createCandidateHost} from '../../../server/v2/candidate-host/index.js';
const [mode,raw]=process.argv.slice(2),config=candidateConfig(JSON.parse(raw));
const password='test-Synthetic-Local-Candidate-Password-2026',checks=[];
const code=c=>e=>e.errorCode===c;
const pass=name=>checks.push(name);
const plan=()=>planCandidateMigration(config);
const apply=p=>applyCandidateMigration(config,p,{expectedDigest:p.digest,operatorId:'user_root'});
const storage=()=>import('../../../server/storage/sqlite.js');
const close=async()=>{await(await storage()).closeSqliteDatabases({checkpointMode:'TRUNCATE'});};
const db=async()=>await(await storage()).openSqliteDatabase();
const fingerprint=async()=>createHash('sha256').update(await fs.readFile(paths(config).database)).digest('hex');
async function migrated(){await initializeCandidate(config,{rootPassword:password});const p=await plan();await apply(p);await close();return p;}
async function http(mode){
  await migrated();let bindings={};
  if(mode==='bound'){
    const {createDiscordVerifier,createKookVerifier}=await import('../../../server/v2/notification-platforms/verifiers.js');
    const {generateKeyPairSync}=await import('node:crypto');const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
    bindings.notifications={transport:{runtimeMode:'isolated',request(){throw Error('No external request authorized in verification');},respondPrivate(){throw Error('No external response authorized in verification');}},
      verifiers:{discord:createDiscordVerifier({publicKey:key,applicationId:'111111111111111111'}),kook:createKookVerifier({verifyToken:'synthetic-kook-verify-token',encryptKey:'synthetic-kook-encrypt-key'})},transportKey:(p,t)=>`${p}:${t.id}`};
  }
  const host=createCandidateHost(config,{bindings});let conn;
  try{
    const status=await host.start();const origin=status.origin;assert.equal(status.g07FullAcceptance,false);assert.equal(status.localCandidateOnly,true);
    const owners=host.owners(),identity=await owners.api.v2Runtime.getIdentity(),managed=owners.management.getSystem(identity),notify=owners.notifications.getSystem(identity);conn=identity.repo.db;
    assert.equal(managed.identity,identity);assert.equal(managed.scheduling,notify.service.scheduling);assert.equal(managed.scheduling,owners.api.v2Runtime.getMemberSpace(identity).scheduling);
    assert.equal(managed.sourceHost.battlemetricsQueue,owners.sharedBattlemetricsQueue);
    for(const owner of [managed.members,managed.stats,managed.service,managed.platforms.service,managed.sourceAdmin,managed.administration.service])assert.equal(owner.identity,identity);
    assert.equal(identity.repo.db,await db());pass('original API shares G03/SQLite/G04/BM queue and all composed owners');
    identity.repo.put('members',{id:'synthetic-catalog-member',displayName:'候选目录成员',memberStatus:'active'});
    const catalog=notify.service.catalog;assert.deepEqual(catalog.listOptions('members',{q:'目录'}).items,[{id:'synthetic-catalog-member',label:'候选目录成员',squadIds:[]}]);
    assert.deepEqual(catalog.listOptions('members',{q:'absent'}).items,[]);identity.repo.remove('members','synthetic-catalog-member');pass('canonical catalog uses original DTO label and search contract');
    let cookie='',csrf='';
    const request=async(route,{body,auth=true,originHeader=origin,csrfHeader=true,key=randomUUID()}={})=>{
      const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{...(auth&&cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:originHeader,'Content-Type':'application/json','Idempotency-Key':key,...(csrfHeader&&csrf?{'X-CSRF-Token':csrf}:{})})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      assert.match(r.headers.get('content-type')||'',/json/,route+' HTTP '+r.status);return {status:r.status,body:await r.json(),headers:r.headers};
    };
    assert.equal((await request('/api/v2/source-admin',{auth:false})).status,401);pass('real G03 requires login');
    const signed=await request('/api/v2/auth/owner-password',{body:{username:'root',password}});assert.equal(signed.status,200,JSON.stringify(signed.body));
    cookie=signed.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=signed.body.data.csrfToken;
    const me=await request('/api/v2/auth/me');assert.equal(me.body.data.accountId,'user_root');pass('original management password proof and G03 cookie session');
    for(const route of ['/api/v2/member-admin/members','/api/v2/wipes','/api/v2/stats/wipes','/api/v2/sync-center/jobs','/api/v2/realtime/scopes','/api/v2/platform-admin','/api/v2/source-admin','/api/v2/system-admin/access']){
      const r=await request(route);assert.equal(r.status,200,route+' '+JSON.stringify(r.body));pass('HTTP '+route);
    }
    const source=await request('/api/v2/source-admin/sources/steam');const input={expectedRevision:source.body.data.revision,apiKey:'synthetic-candidate-api-key'};
    assert.equal((await request('/api/v2/source-admin/commands/steam.save',{body:{input},csrfHeader:false})).status,403);
    assert.equal((await request('/api/v2/source-admin/commands/steam.save',{body:{input},originHeader:'http://localhost.evil'})).status,403);pass('original CSRF and exact origin protect mutations');
    const saved=await request('/api/v2/source-admin/commands/steam.save',{body:{input}});assert.equal(saved.status,200,JSON.stringify(saved.body));
    const {section}=await import('../../../server/v2/source-admin/model.js');assert.equal(saved.body.data.cacheState,'refreshed');assert.equal(identity.repo.scalar('settings')[section('steam')].apiKey,input.apiKey);const store=await import('../../../server/store.js');assert.equal((await store.readStore()).settings[section('steam')].apiKey,input.apiKey);pass('source-admin HTTP write reaches original queue, DB and original cache');
    const wipeInput={title:'隔离候选验收档期',serverProfileId:'candidate-local',serverSnapshot:{name:'隔离本地服务器'},timeZone:'Asia/Shanghai',musterAt:'2030-09-08T12:00:00Z',serverScheduledWipeAt:'2030-09-08T11:00:00Z',signupOpensAt:'2030-09-08T09:00:00Z',signupClosesAt:'2030-09-08T13:00:00Z',autoStart:true,audience:{squadIds:[],memberIds:[],includeUnassigned:true}};
    const wipe=await request('/api/v2/wipes',{body:wipeInput});assert.equal(wipe.status,201,JSON.stringify(wipe.body));const wipeId=wipe.body.data.current.id;
    assert.equal(notify.service.scheduling.getWipe(identity.actorForAccount('user_root'),wipeId).id,wipeId);pass('G04 HTTP creation visible in the exact notification scheduling owner');
    if(mode==='bound'){
      assert.equal(owners.notifications.catalog,notify.service.catalog);assert.equal(typeof notify.worker.runOnce,'function');
      const cb=await request('/api/integrations/v2/notifications/discord',{body:{type:1}});assert.equal(cb.status,401);pass('existing notification runtime accepts native interface; real signature verifier rejects unsigned callback');
    }else{
      const before=conn.prepare("SELECT count(*) n FROM json_records WHERE collection LIKE 'v2Notification%'").get().n;
      for(const route of [`/api/v2/wipes/${wipeId}/notification-previews`,`/api/v2/wipes/${wipeId}/publish-intents`,'/api/v2/publish-intents/missing/retry-failed',...['retry','cancel','reconcile'].map(c=>'/api/v2/deliveries/missing/commands/'+c)]){
        const r=await request(route,{body:{}});assert.equal(r.status,503,JSON.stringify(r.body));assert.equal(r.body.error.errorCode,'NOTIFICATION_ADAPTER_UNAVAILABLE');pass('unsupported before persistence '+route);
      }
      for(const method of ['createPreview','createIntent','retryFailed','commandDelivery','requeue','queueMessageOperation','executionContext','renderEdit','makeReferences','resolveReference'])assert.throws(()=>notify.service[method](),code('NOTIFICATION_ADAPTER_UNAVAILABLE'));
      for(const method of ['runOnce','recoverExpired'])assert.throws(()=>notify.worker[method](),code('NOTIFICATION_ADAPTER_UNAVAILABLE'));
      assert.throws(()=>owners.notifications.tick(),code('NOTIFICATION_ADAPTER_UNAVAILABLE'));assert.throws(()=>notify.references.resolve(),code('NOTIFICATION_ADAPTER_UNAVAILABLE'));
      assert.equal(conn.prepare("SELECT count(*) n FROM json_records WHERE collection LIKE 'v2Notification%'").get().n,before);pass('all direct mutators/worker/reference entries reject without executable intent or attempt');
      const options=await request(`/api/v2/wipes/${wipeId}/notification-options`);assert.equal(options.status,200,JSON.stringify(options.body));assert.equal(options.body.data.supported,false);
      for(const p of ['discord','kook'])assert.equal((await request('/api/integrations/v2/notifications/'+p,{body:{}})).status,503);pass('unbound callback and catalog explicitly unavailable');
    }
    for(const route of ['/api/v2/auth/steam/start','/api/v2/auth/kook/start','/api/v2/auth/discord/start','/api/v2/mini-program/test'])assert.equal((await request(route)).status,503);
    assert.equal((await request('/api/settings')).status,410);pass('legacy, external OAuth and unbound mini surfaces cannot activate');
    const second=createCandidateHost(config);assert.throws(()=>second.start(),code('CANDIDATE_FRESH_PROCESS_REQUIRED'));await second.stop();assert.equal((await request('/api/v2/auth/me')).status,200);pass('second host cannot stop or replace first identity/DB');
    if(mode==='http-drain'){
      let release,entered;const acquired=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
      const blocked=store.runStoreWriteTask(async()=>{entered();await gate;});await acquired;
      const current=(await request('/api/v2/source-admin/sources/steam')).body.data;
      const pending=request('/api/v2/source-admin/commands/steam.clear',{body:{input:{expectedRevision:current.revision}}});
      const until=Date.now()+1000;while(!host.status().pendingRequests){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,2));}
      const stopping=host.stop();await new Promise(r=>setTimeout(r,20));assert.equal(host.status().state,'stopping');assert.equal(conn.prepare('SELECT 1 n').get().n,1);
      release();await blocked;assert.equal((await pending).status,503);await stopping;assert.throws(()=>conn.prepare('SELECT 1'));pass('in-flight original HTTP write settles before shared DB close and cannot succeed after admission stop');
    }else if(mode==='stop-failure'){
      managed.sourceHost.stop=async()=>{throw Error('synthetic owner drain failure');};await assert.rejects(host.stop());assert.equal(host.status().state,'drain_failed');assert.equal(conn.prepare('SELECT 1 n').get().n,1);pass('owner stop failure leaves shared DB open');await close();
    }else{
      let release,entered;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
      const task=owners.sharedBattlemetricsQueue.enqueue({meta:{source:'candidate-verification'},run:async()=>{entered();await gate;assert.equal(conn.prepare('SELECT 1 n').get().n,1);}});await started;
      const stopping=host.stop();await new Promise(r=>setTimeout(r,30));assert.equal(host.status().state,'stopping');assert.equal(conn.prepare('SELECT 1 n').get().n,1);release();await task;
      const stopped=await stopping;assert.equal(stopped.state,'stopped');assert.equal(stopped.events.at(-1),'shared-sqlite-closed');assert.throws(()=>conn.prepare('SELECT 1'));pass('stop waits for original BM queue, owners, original writes and HTTP before DB close');
    }
  }finally{if(host.status().state!=='drain_failed')await host.stop();}
}
async function migration(){
  await initializeCandidate(config,{rootPassword:password});await assert.rejects(initializeCandidate(config,{rootPassword:password}),e=>e.code==='EEXIST');pass('init refuses existing directory');
  await assert.rejects(validateCandidateReady(config),code('CANDIDATE_MIGRATION_REQUIRED'));pass('no migration marker cannot start');
  const before=await fingerprint(),p=await plan();assert.equal(await fingerprint(),before);const rd=new DatabaseSync(paths(config).database,{readOnly:true});assert.equal(rd.prepare("SELECT count(*) n FROM sqlite_master WHERE name='v2_notification_clock'").get().n,0);rd.close();pass('plan is read-only and installs no schemas');
  await assert.rejects(apply({...p,ownerId:randomUUID()}),code('CANDIDATE_PLAN_TAMPERED'));pass('tampered reviewed plan rejects');
  const foreign={...p,ownerId:randomUUID()};delete foreign.digest;foreign.digest=digest(foreign);await assert.rejects(apply(foreign),code('CANDIDATE_PLAN_STALE'));pass('foreign candidate plan rejects');
  await assert.rejects(applyCandidateMigration(config,p,{expectedDigest:p.digest,operatorId:'not-root'}),code('CANDIDATE_TRUSTED_OPERATOR_REQUIRED'));pass('maintenance requires explicit local root operator');
  const base=await import('../../../server/storage/sqlite-migrate.js');base.upsertSqliteScalar(await db(),'candidateSyntheticDrift',{changed:true});await close();
  await assert.rejects(apply(p),code('CANDIDATE_PLAN_STALE'));pass('changed observations invalidate approval');await close();
  const fresh=await plan(),result=await apply(fresh);assert.equal(result.g07FullAcceptance,false);assert.equal((await apply(fresh)).replayed,true);pass('reviewed original migrations apply and identical receipt replays');
  await close();await validateCandidateReady(config);pass('explicit migrated candidate meets local startup gate');
  const ready=await plan();const privateDb=await db();base.upsertSqliteScalar(privateDb,'candidateSyntheticDrift',{changed:'again'});await close();await assert.rejects(apply(fresh),code('CANDIDATE_PLAN_STALE'));pass('completed receipt cannot hide subsequent state drift');await close();
  const marker=JSON.parse(await fs.readFile(paths(config).marker,'utf8'));await fs.writeFile(paths(config).marker,JSON.stringify({...marker,id:randomUUID()}));await assert.rejects(validateCandidateReady(config),code('CANDIDATE_MIGRATION_REQUIRED'));pass('migration marker belongs to marked candidate directory');
}
async function grant(){
  await migrated();const {IdentityRepository}=await import('../../../server/v2/identity/repository.js'),repo=new IdentityRepository(await db()),account=repo.get('accounts','user_root');
  repo.put('accounts',{...account,grants:account.grants.slice(1)});await close();
  await assert.rejects(validateCandidateReady(config),code('CANDIDATE_GRANT_REVIEW_REQUIRED'));pass('startup rechecks actual grant observations after marker');
  const p=await plan();assert.equal(p.review.grantNeedsReview,1);assert.equal(p.grantPlan.accounts[0].status,'needs_review');await apply(p);await close();await assert.rejects(validateCandidateReady(config),code('CANDIDATE_GRANT_REVIEW_REQUIRED'));pass('unknown account differences remain pending review, never silently widened');
  const evidence=path.join(paths(config).control,`identity-plan-${p.identityPlan?digest(p.identityPlan):''}.json`);await fs.rename(evidence,evidence+'.test-withheld');const missing=await plan();assert.equal(missing.grantPlan.accounts[0].reasons[0],'ORIGINAL_IDENTITY_PLAN_REQUIRED');pass('missing original G03 plan retains native needs_review');
  await fs.rename(evidence+'.test-withheld',evidence);await fs.writeFile(evidence,'{}');await assert.rejects(plan(),code('CANDIDATE_IDENTITY_EVIDENCE_INVALID'));pass('forged historical evidence rejects');
}
async function pending(){
  await migrated();const {NotificationRepository}=await import('../../../server/v2/notifications/repository.js');const repo=new NotificationRepository(await db());repo.put('deliveries',{id:'synthetic-pending',intentId:'synthetic-intent',targetId:'synthetic-target',language:'zh-CN',status:'queued'});await close();
  const host=createCandidateHost(config);await assert.rejects(host.start(),code('NOTIFICATION_PENDING_ADAPTER_REQUIRED'));assert.equal(host.status().state,'stopped');pass('unbound runtime refuses existing executable queue');
}
async function filesystem(){
  await initializeCandidate(config,{rootPassword:password});await checkDirectory(config);
  await fs.chmod(paths(config).managed,0o755);await assert.rejects(checkDirectory(config),code('CANDIDATE_DIRECTORY_NOT_PRIVATE'));await fs.chmod(paths(config).managed,0o700);pass('managed directory must be private');
  const real=paths(config).database;await fs.rename(real,real+'.test-owned');await fs.symlink(real+'.test-owned',real);await assert.rejects(checkDatabase(config),code('CANDIDATE_SYMLINK_FORBIDDEN'));await fs.unlink(real);await fs.rename(real+'.test-owned',real);pass('database symlink rejected before SQLite access');
  await fs.symlink(real,real+'-wal');await assert.rejects(checkDatabase(config),code('CANDIDATE_SYMLINK_FORBIDDEN'));await fs.unlink(real+'-wal');pass('SQLite sidecar symlink rejected before access');
  await fs.link(real,real+'.test-hardlink');await assert.rejects(checkDatabase(config),code('CANDIDATE_DATABASE_INVALID'));await fs.unlink(real+'.test-hardlink');pass('hardlinked database cannot alias another data store');
}
async function partial(){
  await initializeCandidate(config,{rootPassword:password});const conn=await db();
  conn.exec("CREATE TRIGGER synthetic_candidate_interrupt BEFORE INSERT ON json_scalars WHEN NEW.key='v2SchedulingSchemaVersion' BEGIN SELECT RAISE(ABORT,'synthetic maintenance interruption'); END");await close();
  const p=await plan();await assert.rejects(apply(p),/synthetic maintenance interruption/);await close();await assert.rejects(validateCandidateReady(config),code('CANDIDATE_MIGRATION_REQUIRED'));pass('partial original migration has no candidate-ready receipt');
  (await db()).exec('DROP TRIGGER synthetic_candidate_interrupt');await close();const next=await plan();assert.equal(next.identityAlreadyApplied,true);assert.ok(next.identityPlan);assert.notEqual(next.digest,p.digest);
  await apply(next);await close();await validateCandidateReady(config);pass('explicit new observation plan resumes with original persisted G03 evidence');
}
try{
  if(['http','bound','stop-failure','http-drain'].includes(mode))await http(mode);
  else if(mode==='migration')await migration();else if(mode==='grant')await grant();else if(mode==='pending')await pending();else if(mode==='filesystem')await filesystem();else if(mode==='partial')await partial();
  else if(mode==='environment'){process.env.NB_DISCORD_TOKEN='synthetic-unwanted';await assert.rejects(initializeCandidate(config,{rootPassword:password}),code('CANDIDATE_FRESH_PROCESS_REQUIRED'));await assert.rejects(fs.stat(config.dataDirectory),e=>e.code==='ENOENT');pass('contaminated process rejects before directory or business imports');}
  else throw Error('Unknown verification mode');
  assert.equal(observations.forbiddenAttempts,0);assert.equal(observations.externalNetworkAttempts,0);console.log(JSON.stringify({mode,checks,observations,externalAcceptance:false,g07FullAcceptance:false}));
}catch(error){console.error(error);process.exitCode=1;}
