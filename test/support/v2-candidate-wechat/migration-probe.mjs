import {observations} from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost,validateCandidateReady} from '../../../server/v2/candidate-host/index.js';
const config=JSON.parse(process.argv[2]),mode=process.argv[3];
await initializeCandidate(config,{rootPassword:'Synthetic-Wechat-Migration-Password'});
const plan=await planCandidateMigration(config),result=await applyCandidateMigration(config,plan,{expectedDigest:plan.digest,operatorId:'user_root'});
const storage=await import('../../../server/storage/sqlite.js'),db=await storage.openSqliteDatabase();
const {IdentityRepository}=await import('../../../server/v2/identity/repository.js'),repo=new IdentityRepository(db);
try{
 assert.equal(result.version,'g07-candidate-host/5');
 assert.equal(repo.scalar('v2NotificationBusinessSchemaVersion'),1);assert.ok(repo.scalar('v2NotificationBusinessMigration'));
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='v2_notification_resource'").get());
 await validateCandidateReady(config);
 if(mode==='migration-index')db.exec('DROP INDEX v2_notification_resource');
 else repo.setScalar(mode==='migration-marker'?'v2NotificationBusinessMigration':'v2NotificationBusinessSchemaVersion',null);
 const before=db.prepare('SELECT total_changes() n').get().n,objects=db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
 const host=createCandidateHost(config);assert.equal(host.status().state,'created');
 await assert.rejects(host.start(),e=>e.errorCode==='NOTIFICATION_BUSINESS_MIGRATION_REQUIRED');
 assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),objects);
 console.log(JSON.stringify({mode,checks:['explicit-version-3-installs-shared-notification-business-schema','missing-business-index-marker-or-version-fails-candidate-start','construction-and-start-do-not-repair-schema'],observations,realWechatCodeExchange:false,externalWechatSubscription:'unsupported'},null,2));
}finally{await storage.closeSqliteDatabases();}
