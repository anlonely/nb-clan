// Frozen scope-engine unit contract; the explicit fake is separate from real fixed-role integration tests.
import './support/owner-environment.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-admin/fixtures.mjs';import { migrateMemberAdmin } from '../server/v2/member-admin/migration.js';import { MemberAdminService } from '../server/v2/member-admin/service.js';import { grant } from '../server/v2/identity/permissions.js';import { riskEvidence,defaultRules } from '../server/v2/member-admin/risk.js';
import { IdentityMemberLifecycle } from '../server/v2/management-adapters/members/lifecycle.js';
import { installStatsSchema, StatsRepository } from '../server/v2/stats/repository.js';
import { MemberSpaceService } from '../server/v2/member-space/service.js';
const op=()=>randomUUID(),f=t=>{const x=fixture({scopeContract:true});t.after(()=>x.db.close());return x;};const code=(fn,c)=>assert.throws(fn,e=>e.errorCode===c);const adminActor=x=>{x.ir.put('accounts',{...x.ir.get('accounts','admin'),roleId:'admin',adminAssignedByOwner:true});return x.actor('admin');};
test('member list and detail recover cached Steam avatar with matching ownership only', t => {
  const x=f(t), s=x.service, a=adminActor(x), m=x.ir.get('members','m001');
  x.ir.put('members',{...m,avatar:'',steamAvatar:'',avatarUrl:''});
  const p=s.repo.get('memberProfiles','profile-m001'), avatar='https://avatars.steamstatic.com/cached.jpg';
  s.repo.put('memberProfiles',{...p,steamId:m.steamId,memberId:m.id,avatar});
  assert.equal(s.detail(a,m.id).avatar,avatar);
  assert.equal(s.members(a,{q:m.steamId}).items.find(row=>row.id===m.id).avatar,avatar);
  s.repo.put('memberProfiles',{...p,steamId:m.steamId,memberId:'other-member',avatar});
  assert.equal(s.detail(a,m.id).avatar,'');
  s.repo.put('memberProfiles',{...p,steamId:'76561198999999999',memberId:m.id,avatar});
  assert.equal(s.detail(a,m.id).avatar,'');
  s.repo.put('memberProfiles',{...p,steamId:m.steamId,memberId:m.id,avatar});
  x.ir.put('members',{...m,avatar:'https://example.com/custom.jpg'});
  assert.equal(s.detail(a,m.id).avatar,'https://example.com/custom.jpg');
});
test('bounded scope pagination and private projection; cursor bound to filter and account',t=>{const x=f(t),s=x.service;const member=x.ir.get('accounts','member');x.ir.put('accounts',{...member,grants:[...member.grants,grant('members.read',{type:'squads',ids:['s1']})]});const a=x.actor('member');const p=s.members(a,{limit:10});assert.equal(p.total,35);assert.equal(p.items.length,10);assert.ok(p.nextCursor);assert.equal(s.detail(a,'m001').phone,undefined);assert.equal(s.detail(a,'m001').risks,undefined);code(()=>s.detail(a,'m036'),'ACCESS_DENIED');code(()=>s.members(x.actor('other'),{limit:10,cursor:p.nextCursor}),'CURSOR_EXPIRED');code(()=>s.members(a,{limit:10,q:'x',cursor:p.nextCursor}),'CURSOR_EXPIRED');assert.equal(s.members(a,{limit:10,cursor:p.nextCursor}).items[0].id,'m011');});
test('edit is durable, idempotent, versioned and target-bound; rollback protects roster clock',t=>{const x=f(t),a=x.actor('admin'),s=x.service,k=op(),body={expectedRevision:1,fields:{customName:'修改后的名字'}};const before=x.sr.rosterRevision?.()??x.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;const r=s.edit(a,'m001',body,k);const clock=x.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;assert.ok(clock>before);assert.equal(s.edit(a,'m001',body,k).replayed,true);assert.equal(x.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision,clock);code(()=>s.edit(a,'m002',body,k),'IDEMPOTENCY_CONFLICT');code(()=>s.edit(a,'m001',body,op()),'REVISION_CONFLICT');assert.equal(s.operation(a,k).committed,true);assert.equal(r.changes[0].collection,'members');code(()=>s.edit(x.actor('viewer'),'m001',body,op()),'ACCESS_DENIED');});
test('mutation fresh actor blocks queued permission version changes and explicit deny scope',t=>{const x=f(t),actor=x.actor('leader');x.ir.put('accounts',{...x.ir.get('accounts','leader'),permissionVersion:2});code(()=>x.service.edit(actor,'m001',{expectedRevision:1,fields:{}},op()),'PERMISSIONS_CHANGED');const a=x.ir.get('accounts','admin');x.ir.put('accounts',{...a,grants:[...a.grants,{...grant('members.read',{type:'squads',ids:['s2']}),effect:'deny'}]});assert.equal(x.service.members(x.actor('admin')).total,35);});
test('full member fields, specialty aliases, VIP date and immutable verified identity',t=>{const x=f(t),s=x.service,a=x.actor('admin');const r=s.create(a,{steamInput:'https://steamcommunity.com/profiles/76561198999999999',fields:{customName:'新人',specialty:['电工','gunner'],phone:'1000',notes:'备注',vitalVipType:'priority',vitalVipPurchasedAt:'2030-09-08'}},op());assert.deepEqual(s.detail(a,r.data.id).specialty,['electricity','pvp']);code(()=>s.edit(a,'m001',{expectedRevision:1,steamInput:'76561198999999998',fields:{}},op()),'VERIFIED_IDENTITY_IMMUTABLE');code(()=>s.create(a,{steamInput:'76561198999999998',fields:{vitalVipType:'priority'}},op()),'VIP_PURCHASE_DATE_REQUIRED');code(()=>s.edit(a,'m001',{expectedRevision:1,fields:{role:'admin'}},op()),'FIELD_NOT_WRITABLE');});
test('bulk import counts, duplicate/no-loss semantics and CSV formula/privacy guards',t=>{const x=f(t),s=x.service,a=x.actor('admin'),k=op(),input={text:'76561198999999003\n76561198999999003\nbad\n76561198999999004',fields:{customName:'=unsafe'}};const r=s.importMembers(a,input,k);assert.equal(r.data.requested,4);assert.equal(r.data.imported,2);assert.equal(r.data.skipped,1);assert.equal(r.data.failed,1);assert.equal(s.importMembers(a,input,k).replayed,true);const csv=s.export(a,{q:'=unsafe',fields:'displayName,phone'}).csv;assert.match(csv,/'=unsafe/);code(()=>s.export(x.actor('member'),{fields:'phone'}),'ACCESS_DENIED');});
test('move preserves history, canonical one-current squad and invalidates old sessions',t=>{const x=f(t),s=x.service,a=x.actor('admin'),session=x.identity.issueSession(x.ir.get('accounts','member'));s.move(a,'m002',{expectedRevision:1,squadId:'s2'},op());assert.equal(s.detail(a,'m002').squadId,'s2');assert.equal(x.ir.all('squadMembers').filter(r=>r.memberId==='m002').length,1);assert.ok(s.audit(a,'member','m002').items.some(r=>r.payload.fromSquadId==='s1'&&r.payload.toSquadId==='s2'));code(()=>x.identity.session(session.token),'PERMISSIONS_CHANGED');code(()=>s.move(x.actor('leader'),'m003',{expectedRevision:1,squadId:'s2'},op()),'ACCESS_DENIED');});
test('status independent of risk; confirmation-only action is audited and never clears access restrictions',t=>{const x=f(t),s=x.service,a=adminActor(x);x.ir.put('restrictions',{id:'restriction1',memberId:'m003',kind:'deny_access',startsAt:'2020-01-01'});let rev=1;for(const status of ['suspended','left','blocked','active']) {s.status(a,'m003',{expectedRevision:rev++,status},op());assert.equal(x.ir.get('members','m003').memberStatus,status);}assert.ok(s.audit(a,'member','m003').items.some(row=>row.payload.reason==='管理员确认调整成员状态'));assert.ok(x.ir.get('restrictions','restriction1'));});
test('delete clears only target profile and bindings, revokes access, retains history and replays safely', t => {
  const x=f(t), a=adminActor(x);
  const lifecycle=new IdentityMemberLifecycle({identity:x.identity,contexts:{assertReady:()=>true,invalidate(){}}});
  const s=new MemberAdminService(x.identity,{...x.adapters,deleteIdentity:args=>lifecycle.deleteInTransaction(args)});
  x.sr.put('signups',{id:'signup1',memberId:'m001',wipeId:'w1',response:'attending_on_time'});
  installStatsSchema(x.db);
  const stats=new StatsRepository(x.db), archive={wipeId:'w1',revision:1,rankings:[{memberId:'m001',playTimeMinutes:60}]};
  stats.saveArchive(archive,[{id:'play1',memberId:'m001',sourceId:'battlemetrics',playTimeMinutes:60}]);
  x.ir.put('identities',{id:'discord-leader',accountId:'leader',provider:'discord',externalId:'external-leader'});
  const token=x.identity.issueSession(x.ir.get('accounts','leader')).token;
  const other=x.ir.get('members','m002'), binding=x.ir.get('bindings','binding-member');
  x.db.exec('CREATE TABLE members(id TEXT PRIMARY KEY,steam_id TEXT,payload_json TEXT); CREATE TABLE member_profiles(id TEXT PRIMARY KEY,member_id TEXT,steam_id TEXT,payload_json TEXT); CREATE TABLE users(id TEXT PRIMARY KEY,payload_json TEXT); CREATE TABLE wechat_users(id TEXT PRIMARY KEY,payload_json TEXT)');
  for (const mid of ['m001','m002']) {
    const row=x.ir.get('members',mid);
    x.db.prepare('INSERT INTO members VALUES(?,?,?)').run(mid,row.steamId,JSON.stringify(row));
    x.db.prepare('INSERT INTO member_profiles VALUES(?,?,?,?)').run('p-'+mid,mid,row.steamId,JSON.stringify({phone:'mirror-private-'+mid}));
  }
  x.ir.put('users',{id:'legacy-target',boundSteamId:x.ir.get('members','m001').steamId});
  x.ir.put('wechatUsers',{id:'wx-target',memberId:'m001',status:'approved'});
  for(const table of ['users','wechat_users']) for(const id of [table==='users'?'legacy-target':'wx-target','unrelated']) x.db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(id,'{"oldBinding":true}');
  s.edit(a,'m001',{expectedRevision:1,fields:{phone:'delete-private-marker'}},op());
  const clock=x.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;
  code(()=>s.deleteMembers(a,{targets:[{id:'m001',expectedRevision:2},{id:'m002',expectedRevision:99}],reason:'清理'},op()),'REVISION_CONFLICT');
  assert.equal(x.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision,clock);
  assert.ok(x.ir.get('members','m001'));
  const key=op(), input={targets:[{id:'m001',expectedRevision:2}]};
  const result=s.deleteMembers(a,input,key);
  assert.equal(result.data.deleted,1);
  assert.ok(s.audit(a,'member','m001').items.some(row=>row.payload.reason==='管理员确认删除成员'));
  for (const [collection,id] of [['members','m001'],['memberProfiles','profile-m001'],['v2SteamBindings','binding-leader'],['v2Identities','discord-leader']]) assert.equal(s.repo.get(collection,id),null);
  assert.equal(x.ir.get('accounts','leader').memberId,null);
  assert.equal(x.ir.get('accounts','leader').status,'disabled');
  assert.throws(()=>x.identity.session(token));
  assert.ok(x.sr.get('signups','signup1'));
  assert.deepEqual(stats.archive('w1',1),archive);
  assert.equal(JSON.parse(x.db.prepare("SELECT payload_json FROM v2_stats_archive_rows WHERE id='play1'").get().payload_json).playTimeMinutes,60);
  assert.deepEqual(x.ir.get('members','m002'),other);
  assert.deepEqual(x.ir.get('bindings','binding-member'),binding);
  assert.equal(s.deleteMembers(a,input,key).replayed,true);
  assert.equal(s.members(a,{deleted:'all'}).total,64);
  assert.deepEqual(x.db.prepare('SELECT id FROM members').all().map(r=>r.id),['m002']);
  assert.deepEqual(x.db.prepare('SELECT member_id FROM member_profiles').all().map(r=>r.member_id),['m002']);
  for(const table of ['users','wechat_users']) assert.deepEqual(x.db.prepare(`SELECT id FROM ${table}`).all().map(r=>r.id),['unrelated']);
  for(const table of ['v2_member_admin_history','v2_member_admin_operations']) {
    const payloads=x.db.prepare(`SELECT payload FROM ${table}`).all().map(r=>r.payload).join('');
    assert.equal(payloads.includes('delete-private-marker'),false);
    assert.equal(payloads.includes('private-phone'),false);
  }
  code(()=>s.detail(a,'m001'),'RESOURCE_NOT_FOUND');
});
test('member preferences share canonical specialties, avatar and timezone across own/admin saves', t => {
  const x=f(t), space=new MemberSpaceService(x.identity), a=x.actor('admin'), me=x.actor('member');
  const member=x.ir.get('members','m002');
  x.ir.put('members',{...member,avatar:'https://avatars.steamstatic.com/real.jpg'});
  assert.equal(space.me(me).profile.timeZone,null);
  assert.equal(space.me(me).profile.timeZoneExplicit,false);
  assert.equal(space.me(me).profile.avatar,'https://avatars.steamstatic.com/real.jpg');
  space.patchMe(me,{expectedRevision:1,displayName:'新称呼',specialty:['指挥','翻译','养马','矿工'],timeZone:'Europe/Paris'},{operationId:op()});
  assert.deepEqual(x.service.detail(a,'m002').specialty,['commander','translator','breeding','miner']);
  assert.equal(x.service.detail(a,'m002').timezone,'Europe/Paris');
  x.service.edit(a,'m002',{expectedRevision:2,fields:{customName:'管理改名',timezone:'America/New_York',specialty:['PVP','商人']}},op());
  assert.equal(space.me(me).profile.displayName,'管理改名');
  assert.equal(space.me(me).profile.timeZone,'America/New_York');
  assert.deepEqual(space.me(me).profile.specialty,['pvp','merchant']);
  code(()=>space.patchMe(me,{expectedRevision:3,specialty:['自造标签']},{operationId:op()}),'INVALID_PROFILE');
});
test('squad create/edit ordered leaders/archive and member detach',t=>{const x=f(t),s=x.service,a=adminActor(x);const r=s.saveSquad(a,null,{name:'三队',notes:'备注',leaderUserIds:['other','leader']},op());assert.deepEqual(s.squads(a).items.find(v=>v.id===r.data.id).leaderUserIds,['other','leader']);s.move(a,'m003',{expectedRevision:1,squadId:r.data.id},op());s.archiveSquad(a,r.data.id,{expectedRevision:1},op());assert.equal(s.detail(a,'m003').squadId,null);assert.ok(s.audit(a,'squad',r.data.id).items.some(row=>row.payload.reason==='管理员确认解散队伍'));assert.equal(s.squads(a,{archived:'all'}).total,3);code(()=>s.saveSquad(x.actor('leader'),'s1',{expectedRevision:1,name:'一队',leaderUserIds:['other']},op()),'ACCESS_DENIED');});
test('risk evidence, status, changed evidence conflict, private flags, root-only rules',t=>{const x=f(t),s=x.service,a=x.actor('admin');const e=s.risksFor(a,x.ir.get('members','m001'))[0];s.riskState(a,'m001',{alertId:e.id,evidenceHash:e.evidenceHash,expectedRevision:0,status:'done'},op());assert.equal(s.risksFor(a,x.ir.get('members','m001'))[0].state,'done');assert.equal(s.repo.get('accountAlertDismissals',`m001:${e.id}`).note,'管理员确认风险已人工复核');code(()=>s.saveRules(a,{expectedRevision:1,rules:defaultRules()},op()),'TRUSTED_ROOT_REQUIRED');s.saveRules(x.actor('root'),{expectedRevision:1,rules:defaultRules()},op());assert.equal(s.rules(a).revision,2);code(()=>s.riskState(a,'m001',{alertId:e.id,evidenceHash:'stale',expectedRevision:1,status:'read'},op()),'RISK_EVIDENCE_CHANGED');assert.equal(riskEvidence({accountSignals:{playTimeKnown:true,playTimeMinutes:0,inventoryPublic:true,inventoryValue:0}},defaultRules()).some(e=>e.id==='private-playtime'),false);assert.equal(riskEvidence({accountSignals:{}},defaultRules()).some(e=>e.id==='no-online-14d'),false);});
test('missing adapters fail closed without side effects; no real sync callback for unauthorized targets',async t=>{const x=f(t),s=new MemberAdminService(x.identity),a=x.actor('admin');code(()=>s.unlink(a,'m001',{expectedRevision:1,provider:'discord',reason:'解绑'},op()),'IDENTITY_ADAPTER_REQUIRED');await assert.rejects(s.sync(a,{kind:'steam',memberIds:['m001']},op()),e=>e.errorCode==='SYNC_ADAPTER_REQUIRED');let called=0;const injected=new MemberAdminService(x.identity,{sync:{request:()=>{called++;return {jobId:'fake'};}}});await assert.rejects(injected.sync(x.actor('leader'),{kind:'steam',memberIds:['m036']},op()),e=>e.errorCode==='ACCESS_DENIED');assert.equal(called,0);});
test('explicit migration replay preserves baseline records and GET has no write side effects',t=>{const x=f(t),before=x.db.prepare('SELECT collection,id,hash FROM json_records ORDER BY collection,id').all();assert.equal(migrateMemberAdmin(x.db,{apply:true}).replayed,true);assert.deepEqual(before,x.db.prepare('SELECT collection,id,hash FROM json_records ORDER BY collection,id').all());const n=x.db.prepare('SELECT total_changes() n').get().n;const a=x.actor('admin');x.service.members(a);x.service.detail(a,'m001');x.service.squads(a);x.service.risks(a);x.service.rules(a);assert.equal(x.db.prepare('SELECT total_changes() n').get().n,n);assert.equal(x.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');});
test('durable outbox survives service recreation and replays without duplicate events',t=>{const x=f(t),s=x.service,a=x.actor('admin'),k=op(),body={expectedRevision:1,fields:{customName:'持久'}};s.edit(a,'m001',body,k);const before=s.changes();assert.equal(before.length,1);const next=new MemberAdminService(x.identity,x.adapters);next.edit(a,'m001',body,k);assert.deepEqual(next.changes(),before);assert.equal(before[0].payload.events[0].changeType,'member.profile');assert.equal(JSON.stringify(before).includes('private-phone'),false);});
test('supported VIP writes preserve 28-day expiry and reject retired Rustinity fields',t=>{const x=f(t),s=x.service,a=x.actor('admin');s.edit(a,'m003',{expectedRevision:1,fields:{vitalVipType:'priority',vitalVipPurchasedAt:'2030-09-08',atlasVipType:'priority',atlasVipPurchasedAt:'2030-09-08'}},op());const dto=s.detail(a,'m003');for(const p of ['vital','atlas'])assert.equal(dto[p+'VipExpiresAt'],'2030-10-06');s.edit(a,'m003',{expectedRevision:2,fields:{atlasVipType:'queue_skip'}},op());assert.equal(s.detail(a,'m003').atlasVipPurchasedAt,'2030-09-08');code(()=>s.edit(a,'m003',{expectedRevision:3,fields:{rustinityVipType:'priority'}},op()),'FIELD_NOT_WRITABLE');code(()=>s.edit(a,'m003',{expectedRevision:3,fields:{atlasVipPurchasedAt:'2030-02-30'}},op()),'INVALID_VIP_DATE');});
test('atomic squad batch checks every source/target/version, audits default reason and supplies affected event scope',t=>{const x=f(t),s=x.service,a=adminActor(x),clock=()=>x.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;const before=clock();code(()=>s.moveMany(a,{targets:[{id:'m001',expectedRevision:1},{id:'m002',expectedRevision:9}],squadId:'s2'},op()),'REVISION_CONFLICT');assert.equal(clock(),before);const r=s.moveMany(a,{targets:[{id:'m001',expectedRevision:1},{id:'m002',expectedRevision:1}],squadId:'s2'},op());assert.equal(r.data.moved,2);assert.ok(r.events.every(e=>e.squadIds.includes('s1')&&e.squadIds.includes('s2')));assert.ok(s.audit(a,'member','m001').items.some(row=>row.payload.reason==='管理员确认批量调整队伍'));assert.equal(s.detail(a,'m001').squadId,'s2');});
test('Steam vanity resolver is allowlisted and cannot be called by reader or with arbitrary URL',async t=>{const x=f(t),s=new MemberAdminService(x.identity,{resolveSteam:async()=>({steamId:'76561198999999998'})});assert.equal((await s.resolveSteam(x.actor('admin'),{steamInput:'https://steamcommunity.com/id/test'},op())).steamId,'76561198999999998');await assert.rejects(s.resolveSteam(x.actor('member'),{steamInput:'https://steamcommunity.com/id/test'},op()),e=>e.errorCode==='ACCESS_DENIED');await assert.rejects(s.resolveSteam(x.actor('admin'),{steamInput:'http://127.0.0.1/admin'},op()),e=>e.errorCode==='INVALID_STEAM_URL');});
test('risk custom thresholds across all numeric types retain unknown, KD compatibility and actual zero separately',()=>{const rules=['kd','kills','deaths','rockets','playtime_hours','inventory_value','no_online_days'].map((type,i)=>({id:String(i),type,name:type,operator:'eq',threshold:0,enabled:true}));for(const officialKda of [{kd:0,kills:0,deaths:0,rockets:0},{kda:0,kills:0,deaths:0,rockets:0}]){const known=riskEvidence({accountSignals:{officialKda,playTimeKnown:true,playTimeMinutes:0,inventoryPublic:true,inventoryValue:0,lastOnlineAt:'2030-01-01T00:00:00Z'}},rules,'',Date.parse('2030-01-01T00:00:00Z'));assert.equal(known.length,7);}const unknown=riskEvidence({accountSignals:{}},rules);assert.equal(unknown.filter(e=>/^\d$/.test(e.id)).length,0);});
test('member risk ignores a stored Steam zero that may represent hidden playtime', t => {
  const x=f(t), s=x.service, m=x.ir.get('members','m001'), p=s.repo.get('memberProfiles','profile-m001');
  s.repo.put('memberProfiles',{...p,steamId:m.steamId,memberId:m.id,playTimeMinutes:0,playTimeKnown:true,playTimeVisibility:'public',
    accountSignals:{...p.accountSignals,playTimeMinutes:0,playTimeKnown:true,playTimeVisibility:'public'}});
  assert.equal(s.risksFor(x.actor('admin'),m).some(e=>e.type==='playtime_hours'),false);
  s.repo.put('memberProfiles',{...p,steamId:m.steamId,memberId:m.id,playTimeMinutes:60,playTimeKnown:true,playTimeVisibility:'public',
    accountSignals:{...p.accountSignals,playTimeMinutes:60,playTimeKnown:true,playTimeVisibility:'public'}});
  assert.equal(s.risksFor(x.actor('admin'),m).some(e=>e.type==='playtime_hours'),true);
});
test('legacy privacy confirmations apply only to enabled privacy rules and global reset is audited',t=>{
  const x=f(t),s=x.service,a=adminActor(x),member=x.ir.get('members','m002');
  assert.equal(s.risksFor(a,member).length,0);
  const steamId='76561198999999001';
  x.ir.put('members',{...x.ir.get('members','m003'),steamId});
  x.ir.put('accounts',{...x.ir.get('accounts','root'),memberId:'m003'});
  x.ir.put('bindings',{id:'binding-root',accountId:'root',memberId:'m003',steamId,status:'verified'});
  s.saveRules(x.actor('root'),{expectedRevision:1,rules:[{id:'privacy-check',name:'库存不可见',type:'private_inventory',operator:'unavailable',threshold:0,enabled:true,squadFilter:''}],squadFilter:''},op());
  s.repo.put('accountAlertDismissals',{id:'m002:private-account',memberId:'m002',type:'private-account'});
  assert.equal(s.risksFor(a,member).length,1);
  assert.equal(s.risksFor(a,member)[0].state,'done');
  s.clearLegacyRiskConfirmations(a,{},op());
  assert.equal(s.repo.get('accountAlertDismissals','m002:private-account'),null);
  assert.equal(JSON.parse(x.db.prepare("SELECT payload FROM v2_member_admin_history WHERE kind='risk' AND resource_id='confirmations' ORDER BY seq DESC LIMIT 1").get().payload).reason,'管理员确认清除全局历史确认');
  assert.equal(s.risksFor(a,member)[0].state,'unread');
});
test('import preview has zero writes and stale duplicate preview cannot create unexpected members',t=>{const x=f(t),s=x.service,a=x.actor('admin'),input={text:'76561198999999088\ninvalid',fields:{}};const before=x.db.prepare('SELECT total_changes() n').get().n,p=s.previewImport(a,input);assert.equal(p.added,1);assert.equal(p.failed,1);assert.equal(x.db.prepare('SELECT total_changes() n').get().n,before);s.create(a,{steamInput:'76561198999999088',fields:{}},op());code(()=>s.importMembers(a,{...input,previewHash:p.previewHash},op()),'IMPORT_PREVIEW_CHANGED');});
test('departure view excludes lifecycle and legacy Discord observations without current admission evidence',t=>{const x=f(t),s=x.service,a=adminActor(x);for(const[mid,status]of[['m003','not_in_guild'],['m004','missing_role'],['m005','check_failed']])x.ir.put('members',{...x.ir.get('members',mid),discordMembershipStatus:status,discordMembershipCheckedAt:'2030-09-08T09:00:00Z'});x.ir.put('members',{...x.ir.get('members','m006'),memberStatus:'left'});assert.equal(s.members(a,{departure:'1'}).total,0);assert.equal(s.members(x.actor('member'),{departure:'1'}).total,0);assert.equal(s.detail(a,'m004').platformAudit.status,'missing_role');});
test('sync integration passes stable operation and exact fresh scope; disabled actor cannot reach adapter',async t=>{const x=f(t),calls=[],adapter={request:async p=>{calls.push(p);return{jobId:'controlled-job',status:'queued',requested:p.scope.memberIds.length};},cancel:async p=>({jobId:p.jobId,status:'cancelled'}),status:async p=>({jobId:p.jobId,status:'succeeded',succeeded:p.scope.memberIds.length})};const s=new MemberAdminService(x.identity,{sync:adapter}),key=op(),a=x.actor('admin');await s.sync(a,{kind:'memberProfiles',memberIds:['m001','m001','m002']},key);assert.equal(calls[0].operationId,key);assert.deepEqual(calls[0].scope,{accountId:a.id,permissionVersion:1,memberIds:['m001','m002']});assert.equal((await s.sync(a,{kind:'memberProfiles',memberIds:['m001'],jobId:'controlled-job'},op(),'cancel')).status,'cancelled');x.ir.put('accounts',{...x.ir.get('accounts','admin'),status:'disabled'});await assert.rejects(s.sync(a,{kind:'memberProfiles',memberIds:['m001']},key));assert.equal(calls.length,1);});
test('identity adapter requires both capabilities, receives target/default reason and synchronous transaction; rejection rolls back',t=>{const x=f(t),calls=[],a=adminActor(x);const s=new MemberAdminService(x.identity,{unlinkIdentity:p=>{calls.push(p);p.tx.put('members',{...p.member,discordId:'',revision:p.member.revision+1});return{revoked:true};}});code(()=>s.unlink(x.actor('leader'),'m001',{expectedRevision:1,provider:'discord'},op()),'ACCESS_DENIED');s.unlink(a,'m001',{expectedRevision:1,provider:'discord'},op());assert.equal(calls[0].member.id,'m001');assert.equal(calls[0].provider,'discord');assert.equal(calls[0].reason,'管理员确认解绑平台关联');assert.equal(calls[0].db,x.db);const bad=new MemberAdminService(x.identity,{unlinkIdentity:p=>{p.tx.put('members',{...p.member,customName:'should rollback'});return Promise.resolve({revoked:true});}});code(()=>bad.unlink(x.identity.actorForAccount('admin'),'m001',{expectedRevision:2,provider:'discord'},op()),'INVALID_IDENTITY_ADAPTER');assert.equal(x.ir.get('members','m001').customName,'林舟');});
test('legacy specialty strings and aliases filter without GET repair; private search does not reveal secret matches',t=>{const x=f(t),s=x.service,a=x.actor('admin');x.ir.put('members',{...x.ir.get('members','m003'),specialty:'电工',notes:'unique-private-marker'});assert.equal(s.members(a,{specialty:'electricity'}).total,1);assert.equal(s.members(a,{q:'unique-private-marker'}).total,1);assert.equal(s.members(x.actor('member'),{q:'unique-private-marker'}).total,0);assert.equal(s.members(a,{q:'先锋一队'}).total,35);assert.equal(x.ir.get('members','m003').specialty,'电工');});
test('manual risk confirmation is shared, prevents concurrent overwrite and reopens on new source evidence',t=>{const x=f(t),s=x.service,a=x.actor('admin'),m=x.ir.get('members','m001');const e=s.risksFor(a,m)[0];s.riskState(a,m.id,{alertId:e.id,evidenceHash:e.evidenceHash,expectedRevision:e.stateRevision,status:'done',note:'共同复核结果'},op());assert.equal(s.risksFor(x.actor('root'),m)[0].state,'done');assert.equal(s.risksFor(x.actor('root'),m)[0].reviewedBy,'admin');code(()=>s.riskState(x.actor('root'),m.id,{alertId:e.id,evidenceHash:e.evidenceHash,expectedRevision:e.stateRevision,status:'done',note:'过期覆盖'},op()),'REVISION_CONFLICT');const p=s.repo.get('memberProfiles','profile-m001');s.repo.put('memberProfiles',{...p,fetchedAt:'2030-09-08T09:30:00Z'});assert.equal(s.risksFor(a,m)[0].state,'unread');});

test('deleted risk rules stay removed after save and service recreation', t => {
  const x=f(t), member=x.ir.get('members','m001');
  x.ir.put('members',{...x.ir.get('members','m003'),steamId:'76561198999999001'});
  x.ir.put('accounts',{...x.ir.get('accounts','root'),memberId:'m003'});
  x.ir.put('bindings',{id:'binding-root',accountId:'root',memberId:'m003',steamId:'76561198999999001',status:'verified'});
  const actor=x.actor('root');
  const profile=x.service.repo.get('memberProfiles','profile-m001');
  x.service.repo.put('memberProfiles',{...profile,accountSignals:{...profile.accountSignals,accountRestricted:true,vacBanned:true}});
  const original=x.service.rules(actor);
  const kept=original.rules.filter(r=>!['account_restricted','steam_ban_or_restriction'].includes(r.type));
  x.service.saveRules(actor,{expectedRevision:original.revision,rules:kept,squadFilter:''},op());
  const reopened=new MemberAdminService(x.identity,x.adapters);
  assert.deepEqual(reopened.rules(actor).rules,kept);
  assert.equal(reopened.risksFor(actor,member).some(r=>['account_restricted','steam_ban_or_restriction'].includes(r.type)),false);
  reopened.saveRules(actor,{expectedRevision:original.revision+1,rules:[],squadFilter:''},op());
  assert.deepEqual(new MemberAdminService(x.identity,x.adapters).rules(actor).rules,[]);
  assert.equal(reopened.risksFor(actor,member).some(r=>original.rules.some(rule=>rule.id===r.id)),false);
});
test('retired review modules have no service handlers and member Hex sync is rejected', async t => {
  const x=f(t);
  for (const name of ['review','reviews','reviewTarget']) assert.equal(x.service[name],undefined);
  const service=new MemberAdminService(x.identity,{sync:{request(){throw new Error('retired action reached adapter');}}});
  await assert.rejects(service.sync(x.actor('admin'),{kind:'hexaytron',memberIds:['m001']},op()),e=>e.errorCode==='INVALID_SYNC_KIND');
});

test('retired review HTTP routes return 410 for old URLs and mutations', async t => {
  const {default:express}=await import('express');
  const {createMemberAdminRouter}=await import('../server/v2/member-admin/routes.js');
  const app=express();app.use('/api/v2',createMemberAdminRouter());
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  for(const path of ['reviews','archive','reviews/old-id','archive/old-id']) for(const method of ['GET','POST']) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/member-admin/${path}`,{method});
    assert.equal(response.status,410);
    assert.equal((await response.json()).error.errorCode,'MEMBER_APPLICATION_MODULE_REMOVED');
  }
});

test('member lifecycle writes protect owner and admin targets before any mutation', t => {
  const x=f(t);
  x.ir.put('accounts',{...x.ir.get('accounts','admin'),roleId:'admin',adminAssignedByOwner:true});
  x.ir.put('accounts',{...x.ir.get('accounts','other'),roleId:'admin',adminAssignedByOwner:true});
  x.ir.put('members',{...x.ir.get('members','m003'),steamId:'76561198999999001'});
  x.ir.put('accounts',{...x.ir.get('accounts','root'),memberId:'m003'});
  x.ir.put('bindings',{id:'binding-root',accountId:'root',memberId:'m003',steamId:'76561198999999001',status:'verified'});
  let calls=0;
  const service=new MemberAdminService(x.identity,{...x.adapters,deleteIdentity(){calls++;return{revoked:true};},unlinkIdentity(){calls++;return{revoked:true};}});
  const mutations=[
    (a,id)=>service.status(a,id,{expectedRevision:1,status:'blocked',reason:'测试保护'},op()),
    (a,id)=>service.unlink(a,id,{expectedRevision:1,provider:'discord',reason:'测试保护'},op()),
    (a,id)=>service.deleteMembers(a,{targets:[{id:'m004',expectedRevision:1},{id,expectedRevision:1}],reason:'测试批量保护'},op())
  ];
  for(const target of ['m003','m036']) for(const mutate of mutations) code(()=>mutate(x.actor('admin'),target),'PROTECTED_ACCOUNT');
  for(const mutate of [mutations[0],mutations[2]]) code(()=>mutate(x.actor('root'),'m003'),'PROTECTED_ACCOUNT');
  assert.equal(calls,0);
  service.unlink(x.actor('root'),'m003',{expectedRevision:1,provider:'discord',reason:'本人解绑'},op());
  assert.equal(calls,1);
  assert.ok(x.ir.get('members','m004'));
  assert.equal(x.ir.get('members','m036').memberStatus,'active');
  service.status(x.actor('admin'),'m004',{expectedRevision:1,status:'suspended',reason:'普通成员管理'},op());
  service.status(x.actor('root'),'m036',{expectedRevision:1,status:'suspended',reason:'超管管理管理员'},op());
  assert.equal(x.ir.get('members','m004').memberStatus,'suspended');
  assert.equal(x.ir.get('members','m036').memberStatus,'suspended');
});
