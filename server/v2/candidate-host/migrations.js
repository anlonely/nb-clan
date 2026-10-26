import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { candidateConfig,assertEnvironment,createDirectory,checkDatabase,checkDirectory,paths,need,digest,noSymlinks,acquireCandidateLease } from './config.js';
const VERSION='g07-candidate-host/5';
// Imports of business modules occur only after the explicit candidate environment gate.
async function modules() {
  const [storage,base,identity,scheduling,idPlan,schedulePlan,grant,platform,member,stats,sync,relay]=await Promise.all([
    import('../../storage/sqlite.js'),import('../../storage/sqlite-migrate.js'),import('../identity/repository.js'),import('../scheduling/repository.js'),
    import('../identity/migration.js'),import('../scheduling/migration.js'),import('../identity/grant-migration.js'),import('../platform-admin/migration.js'),
    import('../member-admin/migration.js'),import('../stats/migration.js'),import('../sync-center/migration.js'),import('../realtime/migration.js')]);
  return {storage,base,identity,scheduling,idPlan,schedulePlan,grant,platform,member,stats,sync,relay};
}
function observation(db,{omitCandidateMarker=false,omitScalars=[],maxRows=100000,maxBytes=50*1024*1024}={}) {
  const hash=createHash('sha256');let count=0,bytes=0;
  const add=value=>{const text=JSON.stringify(value);bytes+=Buffer.byteLength(text);need(++count<=maxRows&&bytes<=maxBytes,'CANDIDATE_MIGRATION_TOO_LARGE',422);hash.update(text+'\n');};
  const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();add(objects);
  for(const table of objects.filter(o=>o.type==='table')){
    add(table.name);
    for(const row of db.prepare(`SELECT * FROM "${table.name.replaceAll('"','""')}" ORDER BY rowid`).iterate()){
      if(table.name==='json_scalars'&&((omitCandidateMarker&&row.key==='v2CandidateMigration')||omitScalars.includes(row.key)))continue;
      add(row);
    }
  }
  return hash.digest('hex');
}
function legacyStore(db,m) {
  const value=m.base.readSqliteScalar(db,'store_full')||{};
  for(const {collection} of db.prepare('SELECT collection FROM json_collections ORDER BY collection').all())value[collection]=[];
  for(const row of db.prepare('SELECT collection,payload_json FROM json_records ORDER BY collection,position,id').iterate()){
    (value[row.collection] ||= []).push(JSON.parse(row.payload_json));
  }
  for(const key of ['settings','syncState','rustplusRelay']){const s=m.base.readSqliteScalar(db,key);if(s!==null)value[key]=s;}
  return value;
}
async function originalPlan(c,marker) {
  if(!marker?.planHash)return undefined;need(/^[0-9a-f]{64}$/.test(marker.planHash),'CANDIDATE_IDENTITY_EVIDENCE_INVALID',409);
  const file=path.join(paths(c).control,`identity-plan-${marker.planHash}.json`);
  try{await noSymlinks(file);const s=await fs.stat(file);need(s.size<=20*1024*1024,'CANDIDATE_IDENTITY_EVIDENCE_INVALID',409);const p=JSON.parse(await fs.readFile(file,'utf8'));need(digest(p)===marker.planHash,'CANDIDATE_IDENTITY_EVIDENCE_INVALID',409);return p;}
  catch(e){if(e.code==='ENOENT')return undefined;throw e;}
}
async function makePlan(c,db,m,plannedAt,adminExtrasCatalog) {
  const owner=await checkDirectory(c),legacy=legacyStore(db,m);
  const marker=m.base.readSqliteScalar(db,'v2IdentityMigration'),repo=marker?new m.identity.IdentityRepository(db):null,identityPlan=marker?await originalPlan(c,marker):m.idPlan.planIdentityMigration(legacy,plannedAt);
  const schedulingPlan=m.base.readSqliteScalar(db,'v2SchedulingMigration')?null:m.schedulePlan.planSchedulingMigration(legacy,{now:plannedAt});
  const hasPlatform=db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_admin_records'").get();
  const platformExists=hasPlatform&&db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='config'").get().n;
  need(!platformExists||platformExists===4,'CANDIDATE_PLATFORM_MIGRATION_INCOMPLETE',409);
  const platformPlan=platformExists?null:m.platform.planPlatformMigration(legacy);
  const statsPlans=[];let after='';do{const p=m.stats.migrateStats(db,{dryRun:true,after,limit:100,now:Date.parse(plannedAt)});statsPlans.push(p);after=p.nextCursor;}while(after);
  const syncPlan=m.sync.planSyncCenterMigration(legacy);
  const hasRealtime=db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_realtime_scopes'").get();
  const relayRepo=hasRealtime?new (await import('../realtime/repository.js')).RealtimeRepository(db):{db,scopes:()=>[]};
  const relayPlan=m.relay.migrateLegacyRelay(relayRepo,legacy);
  const grantPlan=marker?m.grant.planGrantMigration(repo,identityPlan?{identityPlan}:{}):null;
  const plan={version:VERSION,adminExtrasCatalog:adminExtrasCatalog?(await import('../platform-admin-extras/model.js')).catalogEntries(adminExtrasCatalog):null,ownerId:owner.id,plannedAt,observation:observation(db),identityPlan,identityAlreadyApplied:Boolean(marker),schedulingPlan,platformPlan,statsPlans,syncPlan,relayPlan,grantPlan,
    review:{identityConflicts:identityPlan?.conflicts?.length||0,grantNeedsReview:grantPlan?.counts.needs_review||0,relayUnmapped:relayPlan.unmapped.length,platformConflicts:platformPlan?.conflicts?.length||0,statsConflicts:statsPlans.reduce((n,p)=>n+p.conflicts.length,0)}};
  return {...plan,digest:digest(plan)};
}
export async function initializeCandidate(input,{rootPassword}={}) {
  const c=candidateConfig(input);assertEnvironment(c);need(typeof rootPassword==='string'&&rootPassword.length>=16&&rootPassword.length<=128,'CANDIDATE_ROOT_PASSWORD_REQUIRED',422);
  await createDirectory(c);const release=await acquireCandidateLease(c);let storage;
  try{process.env.NB_ROOT_PASSWORD=rootPassword;const store=await import('../../store.js');storage=await import('../../storage/sqlite.js');
    need(store.DATA_DIR===c.dataDirectory,'CANDIDATE_FRESH_PROCESS_REQUIRED');await store.ensureStore();await store.readStore();await store.drainStoreWrites();
    // createDirectory is exclusive: only this newly created candidate receives a local owner.
    const { upsertSqliteScalar } = await import('../../storage/sqlite-migrate.js');
    upsertSqliteScalar(await storage.openSqliteDatabase(), 'v2InstallationOwner', { version: 1, accountId: 'user_root' });}
  finally{delete process.env.NB_ROOT_PASSWORD;try{await storage?.closeSqliteDatabases();}finally{await release();}}
  return {initialized:true,version:VERSION,migrationsApplied:false};
}
async function planMigrationUnlocked(input,{plannedAt=new Date().toISOString(),adminExtrasCatalog}={}) {
  const c=candidateConfig(input);assertEnvironment(c);need(new Date(plannedAt).toISOString()===plannedAt,'CANDIDATE_TIME_INVALID',422);
  const file=await checkDatabase(c),m=await modules(),db=new DatabaseSync(file,{readOnly:true});
  try {db.exec('BEGIN');return await makePlan(c,db,m,plannedAt,adminExtrasCatalog);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
async function installDomains(db,adminExtrasCatalog) {
  const entries=[['../member-admin/repository.js','installMemberAdminSchema'],['../stats/repository.js','installStatsSchema'],['../sync-center/repository.js','installSyncCenterSchema'],['../realtime/repository.js','installRealtimeSchema'],['../platform-admin/repository.js','installPlatformAdminSchema'],['../management-adapters/sources/index.js','installSourceAdapterSchema'],['../management-adapters/source-window/index.js','installSourceWindowSchema'],['../member-inbox/index.js','installMemberInboxSchema'],['../platform-media/index.js','installPlatformMediaSchema'],['../notifications/index.js','installNotificationSchema']];
  for(const [file,name]of entries)(await import(file))[name](db);
  (await import('../system-admin/repository.js')).migrateSystemAdmin(db,{apply:true});
  (await import('../source-admin/index.js')).installSourceAdminSchema(db,{apply:true});
  (await import('../member-followups/index.js')).installMemberFollowupsSchema(db);
  (await import('../notifications/repository.js')).installNotificationBusinessSchema(db);
  (await import('../vip-notifications/index.js')).installVipNotificationsSchema(db);
  (await import('../hex-query/index.js')).installHexQuerySchema(db);
  (await import('../notifications/index.js')).installNotificationPlatformCardSchema(db);
  (await import('../notifications/index.js')).installNotificationOpenWipeSchema(db);
  (await import('../relay-admin/index.js')).installRelayAdminSchema(db,{apply:true});
  if(adminExtrasCatalog)(await import('../platform-admin-extras/index.js')).installPlatformAdminExtrasSchema(db,{catalog:adminExtrasCatalog});
}
async function applyMigrationUnlocked(input,plan,{expectedDigest,operatorId}={}) {
  const c=candidateConfig(input);assertEnvironment(c);await checkDatabase(c);const m=await modules();
  need(plan?.version===VERSION&&expectedDigest===plan.digest,'CANDIDATE_PLAN_REQUIRED',422);const {digest:provided,...body}=plan;
  need(digest(body)===provided,'CANDIDATE_PLAN_TAMPERED',409);
  const store=await import('../../store.js');need(store.DATA_DIR===c.dataDirectory,'CANDIDATE_FRESH_PROCESS_REQUIRED');
  const db=await m.storage.openSqliteDatabase();
  return store.runStoreWriteTask(async()=>{
    const owner=await checkDirectory(c);need(plan.ownerId===owner.id,'CANDIDATE_PLAN_STALE',409);
    const legacy=legacyStore(db,m),operator=legacy.users?.find(u=>u.id===operatorId);
    need(operator&&(operator.id==='user_root'||operator.username==='root')&&!operator.disabled&&operator.status!=='disabled','CANDIDATE_TRUSTED_OPERATOR_REQUIRED',403);
    const completed=m.base.readSqliteScalar(db,'v2CandidateMigration');
    if(completed?.planDigest===provided){need(completed.ownerId===owner.id&&completed.appliedObservation===observation(db,{omitCandidateMarker:true}),'CANDIDATE_PLAN_STALE',409);return {...completed,replayed:true};}
    const fresh=await makePlan(c,db,m,plan.plannedAt,plan.adminExtrasCatalog);need(fresh.digest===provided,'CANDIDATE_PLAN_STALE',409);
    need(!plan.review.platformConflicts&&!plan.review.statsConflicts&&!plan.review.relayUnmapped,'CANDIDATE_MIGRATION_REVIEW_REQUIRED',409);
    m.identity.installIdentitySchema(db);const repo=new m.identity.IdentityRepository(db);
    if(!plan.identityAlreadyApplied){const name=path.join(paths(c).control,`identity-plan-${digest(plan.identityPlan)}.json`);
      try{await fs.writeFile(name,JSON.stringify(plan.identityPlan),{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;await noSymlinks(name);need(digest(JSON.parse(await fs.readFile(name,'utf8')))===digest(plan.identityPlan),'CANDIDATE_IDENTITY_EVIDENCE_INVALID',409);}
      m.idPlan.applyIdentityMigration(repo,plan.identityPlan);}
    m.scheduling.installSchedulingSchema(db);if(plan.schedulingPlan)m.schedulePlan.applySchedulingMigration(new m.scheduling.SchedulingRepository(db),plan.schedulingPlan);
    await installDomains(db,plan.adminExtrasCatalog);
    if(plan.platformPlan)m.platform.applyPlatformMigration({db,plan:plan.platformPlan,actorId:operatorId});
    const member=m.member.migrateMemberAdmin(db,{apply:true,now:plan.plannedAt});
    for(const p of plan.statsPlans){const previous=plan.statsPlans.indexOf(p);m.stats.migrateStats(db,{dryRun:false,after:previous?plan.statsPlans[previous-1].nextCursor:'',limit:100,now:Date.parse(plan.plannedAt)});}
    const {IdentityService}=await import('../identity/service.js'),identity=new IdentityService(repo),actor=identity.actorForAccount(operatorId);
    const {SyncCenterService}=await import('../sync-center/service.js');const {createSqliteSyncAuthority}=await import('../sync-center/authority.js');
    const sync=await m.sync.applySyncCenterMigration(new SyncCenterService({db,identity,authority:createSqliteSyncAuthority({identity,serializeWrite:fn=>fn()})}),plan.syncPlan,{actor,legacyExecutorStopped:true});
    const {RealtimeRepository}=await import('../realtime/repository.js');let after=0,sourceHash;
    do{const r=m.relay.migrateLegacyRelay(new RealtimeRepository(db),legacy,{dryRun:false,after,limit:500,sourceHash});after=r.next;sourceHash=r.sourceHash;}while(after!==null);
    const grantPlan=plan.grantPlan||m.grant.planGrantMigration(repo,plan.identityPlan?{identityPlan:plan.identityPlan}:{});
    // Existing grant plans must retain their original observed digest; initial G03 creates current grants.
    if(plan.grantPlan)need(grantPlan.digest===plan.grantPlan.digest,'GRANT_MIGRATION_PLAN_STALE',409);
    const grants=m.grant.applyGrantMigration(repo,grantPlan,{identityPlan:plan.identityPlan,expectedDigest:grantPlan.digest,operatorId});
    const result={version:VERSION,ownerId:plan.ownerId,planDigest:provided,identityPlanHash:repo.scalar('v2IdentityMigration').planHash,
      grantPlanDigest:grantPlan.digest,grantNeedsReview:grantPlan.counts.needs_review,identityConflicts:plan.review.identityConflicts,
      adminExtrasInstalled:Boolean(plan.adminExtrasCatalog),schemaInstalled:true,localCandidateOnly:true,g07FullAcceptance:false,externalAcceptance:false,appliedAt:new Date().toISOString(),
      counts:{members:member.counts,syncJobs:sync.jobs,syncRules:sync.rules,grantChanged:grants.changedAccounts?.length||0}};
    result.appliedObservation=observation(db,{omitCandidateMarker:true});
    repo.setScalar('v2CandidateMigration',result);await store.patchStoreCache(cache=>{cache.settings=repo.scalar('settings')||{};});return result;
  });
}
export async function validateCandidateReady(input) {
  const c=candidateConfig(input);assertEnvironment(c);const file=await checkDatabase(c),m=await modules(),db=new DatabaseSync(file,{readOnly:true});
  try{db.exec('BEGIN');const owner=await checkDirectory(c),marker=m.base.readSqliteScalar(db,'v2CandidateMigration');need(marker?.version===VERSION&&marker.schemaInstalled&&marker.ownerId===owner.id&&marker.localCandidateOnly===true&&marker.g07FullAcceptance===false,'CANDIDATE_MIGRATION_REQUIRED');
    need(!marker.grantNeedsReview,'CANDIDATE_GRANT_REVIEW_REQUIRED');need(!marker.identityConflicts,'CANDIDATE_IDENTITY_REVIEW_REQUIRED');
    const identity=new m.identity.IdentityRepository(db);need(identity.scalar('v2IdentityMigration')?.planHash===marker.identityPlanHash,'CANDIDATE_IDENTITY_EVIDENCE_INVALID');
    const evidence=await originalPlan(c,identity.scalar('v2IdentityMigration'));
    const current=m.grant.planGrantMigration(identity,evidence?{identityPlan:evidence}:{});
    need(!current.counts.needs_review&&!current.counts.update,'CANDIDATE_GRANT_REVIEW_REQUIRED');
    for(const name of ['v2_scheduling_clock','v2_notification_clock','v2_member_admin_meta','v2_stats_meta','sync_center_schema','v2_realtime_meta','platform_admin_records','v2_source_adapter_receipts','v2_source_windows','v2_system_meta','v2_source_admin_meta','v2_member_followup_schema','v2_member_followup_events','v2_member_followup_jobs'])need(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),'CANDIDATE_SCHEMA_REQUIRED');
    need((await import('../member-admin/repository.js')).memberReadIndexesReady(db),'CANDIDATE_PERFORMANCE_INDEXES_REQUIRED');
    const notificationRepo=new (await import('../notifications/repository.js')).NotificationRepository(db);
    notificationRepo.requireBusinessSchema();
    notificationRepo.requireBusinessSchema('platformCard');
    new (await import('../hex-query/repository.js')).HexQueryRepository(notificationRepo);
    new (await import('../relay-admin/repository.js')).RelayAdminRepository(db);
    if(marker.adminExtrasInstalled)new (await import('../platform-admin-extras/repository.js')).ExtrasRepository(db);
    new (await import('../vip-notifications/repository.js')).VipNotificationRepository(notificationRepo);
    need(identity.scalar('v2SchedulingMigration')&&identity.scalar('v2IdentitySchemaVersion')===1,'CANDIDATE_MIGRATION_REQUIRED');return marker;
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
export async function planCandidateMigration(input,options){
  const c=candidateConfig(input);assertEnvironment(c);const release=await acquireCandidateLease(c);
  try{return await planMigrationUnlocked(c,options);}finally{await release();}
}
export async function applyCandidateMigration(input,plan,options){
  const c=candidateConfig(input);assertEnvironment(c);const release=await acquireCandidateLease(c);
  try{return await applyMigrationUnlocked(c,plan,options);}finally{await release();}
}
// Shared explicit migration primitives. Production owns its separate environment,
// maintenance lease, plan provenance and ready marker; candidate gates above stay unchanged.
export { modules as loadMigrationModules, observation as migrationObservation,
  legacyStore as readMigrationLegacyStore, installDomains as installMigrationDomains };
