// Frozen scope-engine unit contract; real fixed-role behavior has separate domain integration coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { FakeScopedIdentityService } from './support/scoped-identity-fake.mjs';
import { CAPABILITIES, grant, can } from '../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { clearCurrentSignupsForDepartedMember } from '../server/v2/scheduling/departure.js';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); installIdentitySchema(db); installSchedulingSchema(db);
  const ir = new IdentityRepository(db), repo = new SchedulingRepository(db); repo.setScalar('v2SchedulingMigration',{sourceHash:'test'});
  let now = Date.parse('2030-09-08T10:00:00Z');
  const identity = new FakeScopedIdentityService(ir,{now:()=>now});
  ir.put('squads',{id:'sq1'}); ir.put('squads',{id:'sq2'});
  for (const [id,squadId] of [['m1','sq1'],['m2','sq1'],['m3','sq2']]) {
    ir.put('members',{id,memberStatus:'active',steamId:`steam-${id}`,displayName:id}); ir.put('squadMembers',{id,memberId:id,squadId});
    ir.put('accounts',{id:`a-${id}`,memberId:id,status:'active',revision:1,permissionVersion:1,grants:[]});
    ir.put('bindings',{id,memberId:id,accountId:`a-${id}`,steamId:`steam-${id}`,status:'verified'});
  }
  ir.put('accounts',{id:'admin',memberId:null,status:'active',revision:1,permissionVersion:1,roleId:'admin',adminAssignedByOwner:true,grants:CAPABILITIES.map(c=>grant(c,{type:'all'}))});
  ir.put('accounts',{id:'leader',memberId:null,status:'active',revision:1,permissionVersion:1,grants:['signups.delegate','signups.read','wipes.read','wipes.create','wipes.edit'].map(c=>grant(c,{type:'squads',ids:['sq1']}))});
  const service = new SchedulingService(repo,identity,{now:()=>now});
  const actor = id=>identity.actorForAccount(id), opts=source=>({operationId:randomUUID(),source:source||'web'});
  const input = {title:'local',serverProfileId:'server1',serverSnapshot:{name:'Local server'},timeZone:'Asia/Shanghai',musterAt:'2030-09-08T12:00:00Z',
    serverScheduledWipeAt:'2030-09-08T11:00:00Z',signupOpensAt:'2030-09-08T09:00:00Z',signupClosesAt:'2030-09-08T13:00:00Z',autoStart:true,
    audience:{squadIds:['sq1'],memberIds:[],includeUnassigned:false}};
  const draft=service.createWipe(actor('admin'),input,opts()).current;
  const wipe=service.transition(actor('admin'),draft.id,'publish',{expectedRevision:1},opts()).current;
  const signup = (revision=0,content=1,response='attending_on_time')=>({response,expectedArrivalAt:null,timeZone:'Asia/Shanghai',expectedSignupRevision:revision,confirmedContentRevision:content});
  return {db,ir,repo,identity,service,actor,opts,input,wipe,signup,setNow:n=>now=Date.parse(n)};
}
const error = code => e=>e.errorCode===code;
test('double click, stable receipt after deadline, current state, same key body conflict and revoke',t=>{
  const f=fixture(t), a=f.actor('a-m1'), o=f.opts(), input=f.signup();
  const first=f.service.saveSignup(a,f.wipe.id,'m1',input,o);
  const second=f.service.saveSignup(a,f.wipe.id,'m1',input,o);
  assert.deepEqual(first.operationReceipt,second.operationReceipt); assert.equal(second.replayed,true);
  f.service.saveSignup(a,f.wipe.id,'m1',f.signup(1,1,'not_attending'),f.opts('discord'));
  f.setNow('2030-09-08T13:00:00Z');
  const retry=f.service.saveSignup(a,f.wipe.id,'m1',input,o); assert.equal(retry.current.signupRevision,2); assert.equal(retry.operationReceipt.signupRevision,1);
  assert.throws(()=>f.service.saveSignup(a,f.wipe.id,'m1',f.signup(2),f.opts()),error('SIGNUP_CLOSED'));
  assert.throws(()=>f.service.saveSignup(a,f.wipe.id,'m1',{...input,response:'not_attending'},o),error('IDEMPOTENCY_CONFLICT'));
  f.ir.put('accounts',{...f.ir.get('accounts',a.id),permissionVersion:2});
  assert.throws(()=>f.service.saveSignup(a,f.wipe.id,'m1',input,o),error('PERMISSIONS_CHANGED'));
});
test('withdrawal keeps a slot and revision; stale clients cannot recreate version zero',t=>{
  const f=fixture(t),a=f.actor('a-m1');
  f.service.saveSignup(a,f.wipe.id,'m1',f.signup(),f.opts());
  f.service.saveSignup(a,f.wipe.id,'m1',f.signup(1,1,null),f.opts());
  assert.equal(f.service.getSignup(a,f.wipe.id).signupRevision,2);
  assert.throws(()=>f.service.saveSignup(a,f.wipe.id,'m1',f.signup(),f.opts()),error('REVISION_CONFLICT'));
  assert.equal(f.repo.all('signups').length,1); assert.equal(f.service.summary(f.actor('admin'),f.wipe.id).counts.unanswered,2);
});
test('confirmed departure clears only current signup and preserves completed history atomically',t=>{
  const f=fixture(t),admin=f.actor('admin');
  f.service.saveSignup(f.actor('a-m1'),f.wipe.id,'m1',f.signup(),f.opts());
  let completed=f.service.transition(admin,f.wipe.id,'start',{expectedRevision:2},f.opts()).current;
  completed=f.service.transition(admin,completed.id,'end',{expectedRevision:completed.revision,outcome:'completed'},f.opts()).current;
  completed=f.service.transition(admin,completed.id,'archive',{expectedRevision:completed.revision,completeness:'complete',reason:'完成'},f.opts()).current;
  const archived=f.service.getArchive(admin,completed.id,1);
  const draft=f.service.createWipe(admin,f.input,f.opts()).current;
  const current=f.service.transition(admin,draft.id,'publish',{expectedRevision:draft.revision},f.opts()).current;
  f.service.saveSignup(f.actor('a-m1'),current.id,'m1',f.signup(),f.opts());
  const original=f.repo.forWipe('signups',current.id)[0];
  const eventsBefore=f.repo.forWipe('events',current.id).length;
  const outboxBefore=f.repo.forWipe('outbox',current.id).length;
  assert.throws(()=>f.ir.transaction(()=>{
    assert.equal(clearCurrentSignupsForDepartedMember(f.identity,'m1'),1);
    throw new Error('roll back member lock');
  }),/roll back member lock/);
  assert.deepEqual(f.repo.forWipe('signups',current.id)[0],original);
  assert.equal(f.repo.forWipe('events',current.id).length,eventsBefore);
  assert.equal(f.repo.forWipe('outbox',current.id).length,outboxBefore);
  assert.equal(clearCurrentSignupsForDepartedMember(f.identity,'m1'),1);
  const cleared=f.repo.forWipe('signups',current.id)[0];
  assert.equal(cleared.response,null); assert.equal(cleared.signupRevision,original.signupRevision+1);
  const event=f.repo.forWipe('events',current.id).find(row=>row.action==='signup.role_removed');
  assert.equal(event.before.response,'attending_on_time'); assert.equal(event.after.response,null);
  assert.equal(f.repo.forWipe('outbox',current.id).length,outboxBefore+1);
  assert.equal(f.repo.forWipe('signups',completed.id)[0].response,'attending_on_time');
  assert.deepEqual(f.service.getArchive(admin,completed.id,1),archived);
  assert.equal(clearCurrentSignupsForDepartedMember(f.identity,'m1'),0);
  assert.equal(f.repo.forWipe('events',current.id).length,eventsBefore+1);
});
test('major time change preserves the saved reply and allows an ordinary edit',t=>{
  const f=fixture(t),a=f.actor('a-m1');
  f.service.saveSignup(a,f.wipe.id,'m1',{...f.signup(0,1,'attending_later'),expectedArrivalAt:'2030-09-08T14:00:00Z'},f.opts());
  const next=f.service.updateWipe(f.actor('admin'),f.wipe.id,{expectedRevision:2,musterAt:'2030-09-08T15:00:00Z'},f.opts()).current;
  assert.equal(next.contentRevision,2);
  const s=f.service.getSignup(a,f.wipe.id); assert.equal(s.confirmedMusterAt,'2030-09-08T12:00:00.000Z'); assert.equal(s.expectedArrivalAt,'2030-09-08T14:00:00.000Z'); assert.equal(s.needsReconfirmation,false);
  const summary=f.service.summary(f.actor('admin'),f.wipe.id); assert.equal(summary.counts.pendingReconfirmationAttending,0); assert.equal(summary.counts.confirmedAttending,1);
  const saved=f.service.saveSignup(a,f.wipe.id,'m1',f.signup(1),f.opts()).current;
  assert.equal(saved.response,'attending_on_time'); assert.equal(saved.confirmedContentRevision,2);
});
test('delegating admin needs no member identity; leader scope, target qualification and override are enforced',t=>{
  const f=fixture(t),leader=f.actor('leader'),admin=f.actor('admin');
  assert.equal(admin.memberId,null);
  f.service.saveSignup(leader,f.wipe.id,'m1',{...f.signup(),reason:'成员请队长代填'},{...f.opts(),delegate:true});
  assert.throws(()=>f.service.saveSignup(leader,f.wipe.id,'m3',{...f.signup(),reason:'越队'},{...f.opts(),delegate:true}),error('ACCESS_DENIED'));
  assert.throws(()=>f.service.saveSignup(admin,f.wipe.id,'m2',f.signup(),{...f.opts(),delegate:true}),error('REASON_REQUIRED'));
  f.setNow('2030-09-08T13:00:00Z');
  assert.throws(()=>f.service.saveSignup(leader,f.wipe.id,'m1',{...f.signup(1),reason:'超时'},{...f.opts(),delegate:true}),error('ACCESS_DENIED'));
  f.service.saveSignup(admin,f.wipe.id,'m1',{...f.signup(1),reason:'截止后确认'},{...f.opts(),delegate:true});
  f.ir.put('members',{...f.ir.get('members','m2'),memberStatus:'suspended'});
  assert.throws(()=>f.service.saveSignup(admin,f.wipe.id,'m2',{...f.signup(),reason:'暂停'},{...f.opts(),delegate:true}),error('MEMBERSHIP_INACTIVE'));
});
test('transaction rolls back slot, audit, receipt and outbox together under injected storage failure',t=>{
  const f=fixture(t),before=Object.fromEntries(['signups','events','receipts','outbox'].map(k=>[k,f.repo.all(k)]));
  f.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON json_records WHEN NEW.collection='v2SchedulingOutbox' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  assert.throws(()=>f.service.saveSignup(f.actor('a-m1'),f.wipe.id,'m1',f.signup(),f.opts()));
  for(const key of Object.keys(before)) assert.deepEqual(f.repo.all(key),before[key]);
});
test('schedule start never invents actual time; explicit evidence, aborted settlement and immutable archive revision',t=>{
  const f=fixture(t),a=f.actor('admin');f.setNow('2030-09-08T12:00:00Z');
  f.service.advanceScheduled(a); let w=f.repo.get('wipes',f.wipe.id);
  assert.equal(w.lifecycle,'active'); assert.equal(w.startMode,'scheduled'); assert.equal(w.actualStartedAt,null); assert.equal(w.serverActualWipeAt,null);
  w=f.service.transition(a,w.id,'confirm-server-start',{expectedRevision:w.revision,serverActualWipeAt:'2030-09-08T11:58:00Z',serverStartEvidence:'隔离人工确认'},f.opts()).current;
  assert.equal(w.serverActualWipeAt,'2030-09-08T11:58:00.000Z');
  w=f.service.transition(a,w.id,'end',{expectedRevision:w.revision,outcome:'aborted',reason:'服务器不可用'},f.opts()).current;
  assert.equal(w.settlementStatus,'pending_data');
  w=f.service.transition(a,w.id,'archive',{expectedRevision:w.revision,completeness:'missing',reason:'缺数归档'},f.opts()).current;
  const before=f.service.getArchive(a,w.id,1);
  f.ir.put('members',{...f.ir.get('members','m2'),memberStatus:'left'});
  assert.equal(f.service.summary(a,w.id).counts.eligibleTotal,2);
  w=f.service.transition(a,w.id,'revise-archive',{expectedRevision:w.revision,baseArchiveRevision:1,completeness:'complete',reason:'补数',data:{kills:10}},f.opts()).current;
  assert.equal(w.archiveRevision,2); assert.deepEqual(f.service.getArchive(a,w.id,1),before);
  assert.throws(()=>f.service.updateWipe(a,w.id,{expectedRevision:w.revision,title:'overwrite'},f.opts()),error('WIPE_IMMUTABLE'));
  assert.throws(()=>f.service.saveSignup(a,w.id,'m1',{...f.signup(),reason:'override'},{...f.opts(),delegate:true}),error('WIPE_IMMUTABLE'));
});
test('manual close survives time and patch; reopen requires new deadline; cancelled snapshot retained',t=>{
  const f=fixture(t),a=f.actor('admin');
  let w=f.service.transition(a,f.wipe.id,'close-signup',{expectedRevision:2,reason:'名单核实'},f.opts()).current;
  f.setNow('2030-09-08T12:00:00Z'); assert.equal(f.service.getWipe(a,w.id).effectiveSignupWindow,'closed');
  w=f.service.updateWipe(a,w.id,{expectedRevision:w.revision,title:'新标题'},f.opts()).current; assert.equal(f.service.window(w),'closed');
  w=f.service.transition(a,w.id,'reopen-signup',{expectedRevision:w.revision,closesAt:'2030-09-08T14:00:00Z',reason:'重新开放'},f.opts()).current;
  assert.equal(f.service.window(w),'open');
  w=f.service.transition(a,w.id,'cancel',{expectedRevision:w.revision,reason:'改日安排'},f.opts()).current;
  assert.equal(w.lifecycle,'cancelled'); assert.equal(f.repo.all('archives')[0].kind,'cancellation');
  assert.throws(()=>f.service.transition(a,w.id,'publish',{expectedRevision:w.revision},f.opts()),error('WIPE_IMMUTABLE'));
});
test('audience and scope share V2 records; excluded replies and roster revisions track identity edits',t=>{
  const f=fixture(t),a=f.actor('admin');
  f.ir.put('wipes',{id:f.wipe.id,audience:{squadIds:['sq2'],memberIds:[],includeUnassigned:false}});
  assert.equal(can(f.actor('a-m3'),'wipes.read',{kind:'wipe',id:f.wipe.id},f.identity.relations()),false);
  f.service.saveSignup(f.actor('a-m2'),f.wipe.id,'m2',f.signup(),f.opts());
  const before=f.service.summary(a,f.wipe.id);
  f.ir.put('squadMembers',{id:'m2',memberId:'m2',squadId:'sq2'});
  const after=f.service.summary(a,f.wipe.id); assert.ok(after.rosterRevision>before.rosterRevision); assert.equal(after.counts.eligibleTotal,1); assert.equal(after.excludedResponses,1);
  assert.equal(f.service.summary(f.actor('a-m1'),f.wipe.id).counts.eligibleTotal,1);
  assert.throws(()=>f.service.updateWipe(f.actor('leader'),f.wipe.id,{expectedRevision:2,audience:{squadIds:['sq1','sq2'],memberIds:[],includeUnassigned:false}},f.opts()),error('ACCESS_DENIED'));
});
test('SQLite constraints protect current slot and immutable content from accidental double writes',t=>{
  const f=fixture(t); f.service.saveSignup(f.actor('a-m1'),f.wipe.id,'m1',f.signup(),f.opts());
  const s=f.repo.all('signups')[0]; assert.throws(()=>f.repo.put('signups',{...s,id:'other'}));
  const c=f.repo.all('contents')[0]; assert.throws(()=>f.repo.put('contents',{...c,musterAt:'2030-01-01T00:00:00Z'}));
  assert.throws(()=>f.db.prepare("DELETE FROM json_records WHERE collection='v2Signups'").run());
});
test('deny on one squad defeats broad management permission for a mixed audience',t=>{
  const f=fixture(t); const original=f.ir.get('accounts','admin');
  f.ir.put('accounts',{...original,grants:[...original.grants,{capability:'wipes.edit',effect:'deny',scope:{type:'squads',ids:['sq2']}}]});
  assert.throws(()=>f.service.updateWipe(f.actor('admin'),f.wipe.id,{expectedRevision:2,audience:{squadIds:['sq1','sq2'],memberIds:[],includeUnassigned:false}},f.opts()),error('ACCESS_DENIED'));
});
test('legacy timestamps stay unknown and new delegated confirmation waits for complete schedule',t=>{
  const f=fixture(t),w=f.repo.get('wipes',f.wipe.id);
  f.repo.put('wipes',{...w,musterAt:null,migrationMode:'legacy_unknown',legacyRaw:{secret:'fixture hidden raw'}});
  assert.equal(f.service.getWipe(f.actor('admin'),w.id).legacyRaw,undefined);
  assert.throws(()=>f.service.saveSignup(f.actor('admin'),w.id,'m1',{...f.signup(),reason:'补旧报名'},{...f.opts(),delegate:true}),error('WIPE_INCOMPLETE'));
});
test('operation lookup does not disclose another actor receipt or bypass revoked override',t=>{
  const f=fixture(t),a=f.actor('admin'),o=f.opts(); f.setNow('2030-09-08T13:00:00Z');
  f.service.saveSignup(a,f.wipe.id,'m1',{...f.signup(),reason:'补报'},{...o,delegate:true});
  assert.throws(()=>f.service.getOperation(f.actor('a-m1'),o.operationId),error('RESOURCE_NOT_FOUND'));
  f.ir.put('accounts',{...f.ir.get('accounts','admin'),grants:a.grants.filter(g=>g.capability!=='signups.override_closed')});
  assert.throws(()=>f.service.getOperation(f.actor('admin'),o.operationId),error('ACCESS_DENIED'));
});
test('every signup mutation advances roster version and out-of-audience reads stay hidden',t=>{
  const f=fixture(t),a=f.actor('a-m1'),admin=f.actor('admin');
  const before=f.service.summary(admin,f.wipe.id).rosterRevision;
  f.service.saveSignup(a,f.wipe.id,'m1',f.signup(),f.opts());
  const after=f.service.summary(admin,f.wipe.id).rosterRevision; assert.ok(after>before);
  f.service.saveSignup(a,f.wipe.id,'m1',f.signup(1,1,null),f.opts());
  assert.ok(f.service.summary(admin,f.wipe.id).rosterRevision>after);
  assert.throws(()=>f.service.getSignup(f.actor('a-m3'),f.wipe.id,'m3'),error('RESOURCE_NOT_FOUND'));
});
test('raw archive cannot bypass signup read scope or settlement stats permission',t=>{
  const f=fixture(t),admin=f.actor('admin');
  let w=f.service.transition(admin,f.wipe.id,'start',{expectedRevision:2},f.opts()).current;
  w=f.service.transition(admin,w.id,'end',{expectedRevision:w.revision,outcome:'completed'},f.opts()).current;
  w=f.service.transition(admin,w.id,'archive',{expectedRevision:w.revision,completeness:'complete',reason:'archive'},f.opts()).current;
  f.ir.put('accounts',{id:'limited',status:'active',memberId:null,permissionVersion:1,revision:1,
    grants:['wipes.read','wipes.archive','stats.read'].map(cap=>grant(cap,{type:'all'}))});
  const limited=f.actor('limited');
  assert.equal(f.service.listSignups(limited,w.id).items.length,0);
  assert.throws(()=>f.service.getArchive(limited,w.id,1),error('RESOURCE_NOT_FOUND'));
});
test('role evidence blocks writes but only a confirmed account lock excludes the reply from current counts',t=>{
  const f=fixture(t),a=f.actor('admin');
  f.ir.put('policies',{id:'discord-policy',provider:'discord',enabled:true,guildId:'guild',allowedRoleIds:['member'],policyRevision:1});
  f.ir.put('identities',{id:'discord-m1',provider:'discord',externalId:'external-m1',accountId:'a-m1'});
  const evidence={id:'evidence-m1',provider:'discord',externalId:'external-m1',policyId:'discord-policy',policyRevision:1,guildId:'guild',status:'eligible',checkedAt:'2030-09-08T09:59:00Z',expiresAt:'2030-09-08T10:04:00Z'};
  f.ir.put('eligibility',evidence);
  f.service.saveSignup(a,f.wipe.id,'m1',{...f.signup(),reason:'本人委托'},{...f.opts(),delegate:true});
  const before=f.service.summary(a,f.wipe.id);
  f.ir.put('eligibility',{...evidence,status:'ineligible'});
  assert.throws(()=>f.service.saveSignup(a,f.wipe.id,'m1',{...f.signup(1),reason:'不应绕过平台撤权'},{...f.opts(),delegate:true}),error('ELIGIBILITY_DENIED'));
  const pending=f.service.summary(a,f.wipe.id);assert.equal(pending.counts.eligibleTotal,2);assert.equal(pending.excludedResponses,0);
  f.setNow('2030-09-08T10:05:00Z');
  const stale=f.service.summary(a,f.wipe.id);assert.equal(stale.counts.eligibleTotal,2);assert.equal(stale.excludedResponses,0);
  f.ir.put('accounts',{...f.ir.get('accounts','a-m1'),roleAccessLock:{reason:'community_role_missing',at:'2030-09-08T10:05:00Z',providers:['discord']}});
  const after=f.service.summary(a,f.wipe.id);assert.equal(after.counts.eligibleTotal,1);assert.equal(after.excludedResponses,1);assert.ok(after.rosterRevision>before.rosterRevision);
});
test('editing a migrated reply preserves raw history without exposing it in ordinary DTOs',t=>{
  const f=fixture(t),admin=f.actor('admin');
  f.service.saveSignup(f.actor('a-m1'),f.wipe.id,'m1',f.signup(),f.opts());
  const original=f.repo.all('signups')[0];
  f.repo.put('signups',{...original,legacyRaw:{status:'join_8h',privateNote:'fixture'},legacyRawStatus:'join_8h',legacySource:'discord'});
  const updated=f.service.saveSignup(admin,f.wipe.id,'m1',{...f.signup(1,1,'not_attending'),reason:'重新确认'},{...f.opts(),delegate:true});
  assert.equal(updated.current.legacyRaw,undefined);assert.equal(updated.current.legacyOrigin,undefined);
  assert.equal(f.repo.all('signups')[0].legacyOrigin.raw.status,'join_8h');
  assert.equal(f.repo.all('events').find(e=>e.operationId===updated.operationReceipt.operationId).before.legacyRaw.privateNote,'fixture');
});
