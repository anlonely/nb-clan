import '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,validateCandidateReady} from '../../../server/v2/candidate-host/index.js';
import {planCandidatePerformanceIndexes,applyCandidatePerformanceIndexes} from '../../../server/v2/candidate-host/performance-indexes.js';
import {candidateConfig,paths,digest} from '../../../server/v2/candidate-host/config.js';
const config=candidateConfig(JSON.parse(process.argv[2]));
await initializeCandidate(config,{rootPassword:'G08-Only-Index-Upgrade-2026'});
const plan=await planCandidateMigration(config);await applyCandidateMigration(config,plan,{expectedDigest:plan.digest,operatorId:'user_root'});
await (await import('../../../server/storage/sqlite.js')).closeSqliteDatabases();
await validateCandidateReady(config);
const {memberReadIndexCatalog,memberReadIndexesReady}=await import('../../../server/v2/member-admin/repository.js');
const fingerprint=db=>{
  const hash=createHash('sha256');
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
    for(const row of db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'" ORDER BY rowid').iterate()){
      if(name==='json_scalars'&&row.key==='v2CandidateMigration')continue;
      hash.update(JSON.stringify([name,row])+'\n');
    }
  }return hash.digest('hex');
};
let db=new DatabaseSync(paths(config).database);const fresh=memberReadIndexCatalog(db);
for(const {name}of fresh)db.exec('DROP INDEX '+name);
const old=memberReadIndexCatalog(db),beforeFacts=fingerprint(db);assert.equal(memberReadIndexesReady(db),false);db.close();
await assert.rejects(validateCandidateReady(config),e=>e.errorCode==='CANDIDATE_PERFORMANCE_INDEXES_REQUIRED');
await assert.rejects(applyCandidateMigration(config,plan,{expectedDigest:plan.digest,operatorId:'user_root'}),e=>e.errorCode==='CANDIDATE_PLAN_STALE');
await (await import('../../../server/storage/sqlite.js')).closeSqliteDatabases();
const upgrade=await planCandidatePerformanceIndexes(config);
await assert.rejects(applyCandidatePerformanceIndexes(config,upgrade,{expectedDigest:upgrade.digest,operatorId:'not-root'}),e=>e.errorCode==='CANDIDATE_TRUSTED_OPERATOR_REQUIRED');
const applied=await applyCandidatePerformanceIndexes(config,upgrade,{expectedDigest:upgrade.digest,operatorId:'user_root'});
assert.equal(applied.replayed,false);await validateCandidateReady(config);
const replay=await applyCandidatePerformanceIndexes(config,upgrade,{expectedDigest:upgrade.digest,operatorId:'user_root'});assert.equal(replay.replayed,true);
db=new DatabaseSync(paths(config).database,{readOnly:true});const afterFacts=fingerprint(db),after=memberReadIndexCatalog(db);db.close();
assert.equal(afterFacts,beforeFacts);assert.deepEqual(after,fresh);
// A previously applied four-index plan cannot satisfy the five-index catalog.
const {MEMBER_READ_INDEXES}=await import('../../../server/v2/member-admin/repository.js');
const {readSqliteScalar,upsertSqliteScalar}=await import('../../../server/storage/sqlite-migrate.js');
db=new DatabaseSync(paths(config).database);db.exec('DROP INDEX v2_identity_binding_account');
const oldFourBody={kind:upgrade.kind,ownerId:upgrade.ownerId,before:fresh.slice(0,4),required:MEMBER_READ_INDEXES.slice(0,4)},oldFour={...oldFourBody,digest:digest(oldFourBody)};
upsertSqliteScalar(db,'v2CandidateMigration',{...readSqliteScalar(db,'v2CandidateMigration'),performanceIndexPlanDigest:oldFour.digest});db.close();
await assert.rejects(applyCandidatePerformanceIndexes(config,oldFour,{expectedDigest:oldFour.digest,operatorId:'user_root'}),e=>e.errorCode==='CANDIDATE_INDEX_PLAN_STALE');
await assert.rejects(validateCandidateReady(config),e=>e.errorCode==='CANDIDATE_PERFORMANCE_INDEXES_REQUIRED');
const fifth=await planCandidatePerformanceIndexes(config);await applyCandidatePerformanceIndexes(config,fifth,{expectedDigest:fifth.digest,operatorId:'user_root'});await validateCandidateReady(config);

console.log(JSON.stringify({fresh,old,after,planDigest:upgrade.digest,beforeFacts,afterFacts,oldFourIndexPlanRejected:true,oldReadinessRejected:true,oldMainPlanReplayRejected:true,unauthorizedRejected:true,replayed:replay.replayed}));
