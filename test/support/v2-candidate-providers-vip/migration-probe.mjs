import {observations} from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost,validateCandidateReady} from '../../../server/v2/candidate-host/index.js';
const config=JSON.parse(process.argv[2]),mode=process.argv[3];await initializeCandidate(config,{rootPassword:'Controlled-VIP-Migration-Password'});const plan=await planCandidateMigration(config),result=await applyCandidateMigration(config,plan,{expectedDigest:plan.digest,operatorId:'user_root'});assert.equal(result.version,'g07-candidate-host/5');
const storage=await import('../../../server/storage/sqlite.js'),db=await storage.openSqliteDatabase();const {IdentityRepository}=await import('../../../server/v2/identity/repository.js'),repo=new IdentityRepository(db);
try{await validateCandidateReady(config);
 if(mode==='migration-table')db.exec('DROP TABLE v2_vip_notification_scan');else if(mode==='migration-trigger')db.exec('DROP TRIGGER v2_vip_notification_events_preserved');else repo.setScalar('v2NotificationVipSchemaVersion',null);
 const changes=db.prepare('SELECT total_changes() n').get().n,objects=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),host=createCandidateHost(config);await assert.rejects(host.start(),e=>['VIP_NOTIFICATION_MIGRATION_REQUIRED','NOTIFICATION_VIP_MIGRATION_REQUIRED'].includes(e.errorCode));assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),objects);
 console.log(JSON.stringify({mode,checks:['explicit-candidate-version-4-installs-original-VIP-schema','missing-VIP-schema-fails-candidate-start','constructor-and-start-never-repair-schema'],observations,realExternalProvidersVerified:false,realExternalDmVerified:false}));
}finally{await storage.closeSqliteDatabases();}
