// Frozen scope-engine performance comparison, explicitly using the scoped identity fake.
import './support/results.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {rosterReadScope} from '../server/v2/scheduling/read-snapshot.js';
import {createQueryClient} from '../src/v2/query-client.js';
test('synchronous roster reads coalesce repeated collections but never survive the next request',()=>{
 let calls=0,version=1;const repository={all:name=>{calls++;return [{id:'member',version,name}]},get:()=>({id:'member',version})};
 const identity={repo:repository,relations(){return {members:this.repo.all('members')}}};const service={identity,repo:repository};
 const first=rosterReadScope(service);for(let n=0;n<500;n++){assert.equal(first.identity.repo.all('members')[0].version,1);assert.equal(first.identity.relations().members[0].version,1);}assert.equal(calls,1);
 version=2;const second=rosterReadScope(service);assert.equal(second.identity.repo.all('members')[0].version,2);assert.equal(calls,2);assert.equal(service.identity,identity);
});
test('an incompatible API response is rejected before it can enter the resource cache',async()=>{
 let version=999;const client=createQueryClient({fetchImpl:async()=>new Response(JSON.stringify({data:{privateField:'new schema'},meta:{schemaVersion:version,scopeVersion:1}}))});client.setIdentity({accountId:'a',scopeVersion:1});
 try{await assert.rejects(client.fetchQuery(['me'],'/api/v2/me'),e=>e.errorCode==='CLIENT_VERSION_UNSUPPORTED'&&!e.retryable);assert.equal(client.getQueryState(['me']).data,undefined);version=1;assert.equal((await client.fetchQuery(['me'],'/api/v2/me',{force:true})).data.privateField,'new schema');}finally{client.dispose();}
});

import {DatabaseSync} from 'node:sqlite';
import {installIdentitySchema,IdentityRepository} from '../server/v2/identity/repository.js';
import {applyIdentityMigration,planIdentityMigration} from '../server/v2/identity/migration.js';
import {FakeScopedIdentityService} from './support/scoped-identity-fake.mjs';
import {installSchedulingSchema,SchedulingRepository} from '../server/v2/scheduling/repository.js';
import {applySchedulingMigration,planSchedulingMigration} from '../server/v2/scheduling/migration.js';
import {SchedulingService} from '../server/v2/scheduling/service.js';
import {installRealtimeSchema,RealtimeRepository} from '../server/v2/realtime/repository.js';
import {seed} from './support/v2-g08/seed.mjs';
import fs from 'node:fs/promises';
import {NotificationService} from '../server/v2/notifications/service.js';
import {can} from '../server/v2/identity/permissions.js';
import {need,hash,stamp} from '../server/v2/notifications/shared.js';
import {performance} from 'node:perf_hooks';
import {audienceSnapshot as originalAudience,sourceHash} from './support/v2-g08/reference-audience.mjs';
const records=[];
for(const scale of [1,5])test(`S${scale} roster keeps eligibility, deny and frozen archive semantics with bounded collection reads`,()=>{
 const db=new DatabaseSync(':memory:');try{
 installIdentitySchema(db);const ir=new IdentityRepository(db);applyIdentityMigration(ir,planIdentityMigration({}));installSchedulingSchema(db);const sr=new SchedulingRepository(db);applySchedulingMigration(sr,planSchedulingMigration({}));installRealtimeSchema(db);
 const identity=new FakeScopedIdentityService(ir),scheduling=new SchedulingService(sr,identity),system={scheduling,realtime:{repository:new RealtimeRepository(db)}};seed({identity,system,scale,cursorCount:2});
 const w=scheduling.wipe('fixture_wipe_0'),a=identity.actorForAccount('g08_account_0'),normalize=x=>({...x,evaluatedAt:null});let reads=0;const originalAll=ir.all.bind(ir);ir.all=name=>{reads++;return originalAll(name);};
 const previousRows=db.prepare("SELECT payload_json FROM json_records WHERE collection=? AND json_extract(payload_json,'$.wipeId')=? ORDER BY id").all('v2Signups',w.id).map(r=>JSON.parse(r.payload_json));
 assert.deepEqual(sr.forWipe('signups',w.id),previousRows);
 const signupPlan=db.prepare("EXPLAIN QUERY PLAN SELECT payload_json FROM json_records INDEXED BY v2_signup_wipe WHERE collection='v2Signups' AND json_extract(payload_json,'$.wipeId')=? ORDER BY id").all(w.id);
 assert.ok(signupPlan.some(r=>r.detail.includes('USING INDEX v2_signup_wipe')));
 const before=normalize(scheduling.evaluateRoster(a,w));const oldReads=reads;reads=0;const after=normalize(scheduling.roster(a,w));const newReads=reads;assert.deepEqual(after,before);assert.ok(newReads<30&&newReads<oldReads/10,`${oldReads} -> ${newReads}`);assert.equal(after.rows.length,95*scale);
 const notify=new NotificationService({identity,scheduling,now:Date.now});
 const b0=performance.now(),priorAudience=normalize(originalAudience.call(notify,a,w,w.audience)),b1=performance.now(),currentAudience=normalize(notify.audienceSnapshot(a,w,w.audience)),b2=performance.now();
 assert.deepEqual(currentAudience,priorAudience);const audienceTiming={previousMs:b1-b0,currentMs:b2-b1,sourceHash};
 assert.throws(()=>notify.audienceSnapshot(a,w,{squadIds:[],memberIds:['missing'],includeUnassigned:false}),e=>e.errorCode==='NOTIFICATION_AUDIENCE_DENIED');
 const account=ir.get('accounts',a.id);ir.put('accounts',{...account,permissionVersion:2,grants:[...account.grants,{capability:'signups.read',effect:'deny',scope:{type:'squads',ids:['fixture_squad_0']}}]});
 const changed=identity.actorForAccount(a.id);
 assert.throws(()=>notify.actor(a),e=>e.errorCode==='PERMISSIONS_CHANGED');
 for(const fn of [originalAudience,notify.audienceSnapshot])assert.throws(()=>fn.call(notify,changed,w,w.audience),e=>e.errorCode==='NOTIFICATION_AUDIENCE_DENIED');
 const denied=scheduling.roster(changed,w);assert.ok(!denied.rows.some(r=>r.memberId==='fixture_member_1'));assert.deepEqual(normalize(denied),normalize(scheduling.evaluateRoster(changed,w)));assert.throws(()=>scheduling.summary(a,w.id),e=>e.errorCode==='PERMISSIONS_CHANGED');
 const m=ir.get('members','fixture_member_12');ir.put('members',{...m,memberStatus:'departed'});assert.ok(!scheduling.roster(changed,w).rows.some(r=>r.memberId===m.id));
 const restrictedAudience={squadIds:[],memberIds:['fixture_member_12'],includeUnassigned:false};
 assert.deepEqual(normalize(notify.audienceSnapshot(changed,w,restrictedAudience)),normalize(originalAudience.call(notify,changed,w,restrictedAudience)));
 const archived={...w,lifecycle:'archived',archiveRevision:1};sr.put('archives',{id:w.id+':1',wipeId:w.id,archiveRevision:1,roster:before});assert.ok(scheduling.rosterForRead(changed,archived).rows.some(r=>r.memberId===m.id));assert.ok(!scheduling.rosterForRead(changed,archived).rows.some(r=>r.memberId==='fixture_member_1'));
 for(const fn of [originalAudience,notify.audienceSnapshot])assert.throws(()=>fn.call(notify,changed,archived,archived.audience),e=>e.errorCode==='NOTIFICATION_AUDIENCE_DENIED');
 records.push({audienceTiming,scale,oldCollectionReads:oldReads,newCollectionReads:newReads,eligible:after.rows.length,semanticsEqual:true,denyAndFreshRestrictionAndArchive:true,signupPlan});
 }finally{db.close();}
});
test.after(()=>fs.writeFile(new URL('../output/test-results/g08/roster-correctness.json',import.meta.url),JSON.stringify(records,null,2)+'\n'));
