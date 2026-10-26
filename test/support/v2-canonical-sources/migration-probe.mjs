import {observations} from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost,validateCandidateReady} from '../../../server/v2/candidate-host/index.js';
const config=JSON.parse(process.argv[2]);
await initializeCandidate(config,{rootPassword:'Synthetic-Canonical-Migration-Password'});
const p=await planCandidateMigration(config),result=await applyCandidateMigration(config,p,{expectedDigest:p.digest,operatorId:'user_root'});
const storage=await import('../../../server/storage/sqlite.js'),db=await storage.openSqliteDatabase();
try{
  assert.equal(result.version,'g07-candidate-host/5');
  for(const name of ['v2_member_followup_schema','v2_member_followup_events','v2_member_followup_jobs'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name));
  await validateCandidateReady(config);db.exec('DROP TABLE v2_member_followup_jobs');const changes=db.prepare('SELECT total_changes() n').get().n;
  const host=createCandidateHost(config);await assert.rejects(host.start(),e=>e.errorCode==='CANDIDATE_SCHEMA_REQUIRED');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_member_followup_jobs'").get(),undefined);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
  console.log(JSON.stringify({mode:'migration',checks:['explicit-version-2-installs-original-followup-tables','missing-followup-table-blocks-candidate-start','constructor-and-start-never-repair-schema'],observations,realPlatformAcceptance:false},null,2));
}finally{await storage.closeSqliteDatabases();}
