import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, steam, secrets, publicGrants } from './support/v2-public-query/fixture.mjs';
import { grant, can, migrateLegacyGrants } from '../server/v2/identity/permissions.js';
import { projectQuery, MEMBER_QUERY_PROJECTION_VERSION } from '../server/v2/stats/service.js';
const setup = (t, options = {}) => { const f = fixture(options);
  if (!options.scopeContract) f.ir.put('accounts',{...f.ir.get('accounts','query_only'),roleId:'admin',adminAssignedByOwner:true});
  t.after(() => f.db.close()); return f; };
const clean = value => { for (const secret of secrets) assert.equal(JSON.stringify(value).includes(secret), false, secret); };
const query = (f, actor = 'query_only', body = { sourceId: 'member', steamInput: steam }, op = 'member-query-operation') =>
  f.service.createJob(f.actor(actor), 'query', body, op);
async function complete(f, job, actor = 'query_only') { await f.service.runJob(job.jobId); const result = f.service.readJob(f.actor(actor), job.jobId); assert.equal(result.status, 'succeeded', JSON.stringify(result)); return result; }

test('administrator-backed member jobs still return a bounded public projection without private fields or fact writes', async t => {
  const f = setup(t), facts = JSON.stringify(f.ir.snapshot()), a = f.actor('query_only');
  assert.equal(can(a, 'members.read', { kind: 'member', id: 'g05_alpha' }, f.identity.relations()), true);
  const n = f.changes(), direct = f.service.memberQuery(steam, { actor: a });
  assert.equal(f.changes(), n); assert.equal(direct.displayName, '阿北');
  assert.equal(direct.publicMember.profileUrl, `https://steamcommunity.com/profiles/${steam}/`);
  assert.ok(Object.keys(direct.publicMember).every(key=>['steamId','displayName','avatar','profileUrl','squad','currentWipe','details'].includes(key)));
  assert.equal(direct.publicMember.details.membershipStatus,'active');
  assert.deepEqual(direct.rows, []); clean(direct);
  const job = query(f), result = await complete(f, job);
  clean(result); assert.equal(result.result.projectionVersion, MEMBER_QUERY_PROJECTION_VERSION);
  assert.deepEqual(f.calls, []); assert.equal(JSON.stringify(f.ir.snapshot()), facts);
});

test('scoped member details remain projected and public squad/signup fields require their own permissions', t => {
  const f = setup(t,{scopeContract:true}), a = f.actor('query_only');
  f.ir.put('accounts', { ...a, grants: [...a.grants, grant('members.read', { type: 'squads', ids: ['g05_squad'] })] });
  let out = f.service.memberQuery(steam, { actor: f.actor('query_only') });
  assert.equal(out.publicMember.details.membershipStatus, 'active'); assert.deepEqual(out.publicMember.details.specialty, ['建筑']);
  assert.equal(out.publicMember.squad, undefined); assert.equal(out.publicMember.currentWipe, undefined); clean(out);
  const updated = f.ir.get('accounts', a.id);
  f.ir.put('accounts', { ...updated, grants: [...updated.grants, grant('squads.read', { type: 'squads', ids: ['g05_squad'] }),
    grant('wipes.read', { type: 'all' }), grant('signups.read', { type: 'squads', ids: ['g05_squad'] })] });
  out = f.service.memberQuery(steam, { actor: f.actor('query_only') });
  assert.equal(out.publicMember.squad.name, '北境一队'); assert.equal(out.publicMember.currentWipe.id, 'g07_active'); clean(out);
  const denied = f.ir.get('accounts', a.id);
  f.ir.put('accounts', { ...denied, grants: [...denied.grants, grant('signups.read', { type: 'all' }, { effect: 'deny' }),
    grant('squads.read', { type: 'squads', ids: ['g05_squad'] }, { effect: 'deny' })] });
  out = f.service.memberQuery(steam, { actor: f.actor('query_only') });
  assert.equal(out.publicMember.squad, undefined); assert.equal(out.publicMember.currentWipe, undefined);
});

for (const scope of [{ type: 'all' }, { type: 'squads', ids: ['g05_squad'] }]) test(`member deny ${scope.type} is indistinguishable from not found`, t => {
  const f = setup(t,{scopeContract:true}), a = f.ir.get('accounts', 'query_only');
  f.ir.put('accounts', { ...a, grants: [...a.grants, grant('members.read', scope, { effect: 'deny' })] });
  const denied = f.service.memberQuery(steam, { actor: f.actor('query_only') });
  const missing = f.service.memberQuery('76561198000000999', { actor: f.actor('query_only') });
  for (const key of ['status', 'displayName', 'publicMember', 'fields', 'rows', 'errors']) assert.deepEqual(denied[key], missing[key]);
  clean(denied); assert.equal(denied.publicMember, null);
});

for (const capability of ['queries.read', 'queries.run']) test(`explicit ${capability} source deny prevents direct calls, enqueue and capability hint`, t => {
  const f = setup(t,{scopeContract:true}), a = f.ir.get('accounts', 'query_only');
  f.ir.put('accounts', { ...a, grants: [...a.grants, grant(capability, { type: 'querySources', ids: ['member'] }, { effect: 'deny' })] });
  assert.throws(() => f.service.memberQuery(steam, { actor: f.actor('query_only') }), /ACCESS_DENIED/);
  assert.throws(() => query(f), /ACCESS_DENIED/);
  const hint = f.service.queryCapabilities(f.actor('query_only'), { steamInput: steam }).sources.find(s => s.sourceId === 'member');
  assert.equal(hint[capability === 'queries.read' ? 'read' : 'run'], false);
  assert.deepEqual(f.calls, []);
});

test('untrusted member adapter fields, rows, nested details and mismatched Steam targets never reach jobs', async t => {
  let calls = 0;
  const f = setup(t, { providers: { member: async () => { calls++; return { steamId: steam,
    displayName: secrets[0], publicMember: { steamId: steam, displayName: secrets[1], details: { specialty: secrets } },
    fields: secrets.map(s => ({ name: s, value: s })), rows: secrets.map(s => ({ memberId: s, displayName: s })) }; } } });
  const out = await complete(f, query(f));
  assert.equal(calls, 1); assert.equal(out.result.steamId, steam); assert.equal(out.result.displayName, '阿北');
  clean(out); clean(f.service.repo.job(out.id).result); assert.deepEqual(out.result.rows, []);
  const projected = projectQuery({ steamId: steam, fields: [{ name: 'notes', value: secrets[1] }], rows: [{ memberId: secrets[0] }] }, 'member', Date.now());
  clean(projected); assert.deepEqual(projected.rows, []); assert.equal(projected.publicMember, null);
});

test('old polluted persisted member job is reprojected on every read and replay does not rerun its provider', async t => {
  const f = setup(t), job = query(f); await complete(f, job);
  f.db.prepare('UPDATE v2_stats_jobs SET result=? WHERE id=?').run(JSON.stringify({ sourceId: 'member', steamId: steam,
    displayName: secrets[0], fields: [{ name: 'notes', value: secrets[1] }], rows: [{ memberId: secrets[2] }] }), job.jobId);
  const out = f.service.readJob(f.actor('query_only'), job.jobId); clean(out); assert.equal(out.result.displayName, '阿北');
  const n = f.changes(), replay = query(f); assert.equal(replay.jobId, job.jobId); assert.equal(f.changes(), n);
  assert.equal(await f.service.runJob(job.jobId), false); assert.deepEqual(f.calls, []);
});

for (const format of ['json', 'html', 'csv']) test(`member ${format} export uses safe projection and stale unversioned files cannot download`, async t => {
  const f = setup(t), source = query(f); await complete(f, source);
  const job = f.service.createJob(f.actor('query_only'), 'export', { queryJobId: source.jobId, format, language: 'zh' }, 'member-export-' + format);
  await f.service.runJob(job.jobId);
  const out = f.service.readJob(f.actor('query_only'), job.jobId); assert.equal(out.status, 'succeeded', JSON.stringify(out.result));
  const bytes = Buffer.from(out.result.base64, 'base64').toString(); clean(bytes); clean(out);
  if (format !== 'csv') assert.match(bytes, /阿北/);
  assert.equal(out.result.queryProjectionVersion, MEMBER_QUERY_PROJECTION_VERSION);
  const bad = { ...out.result, base64: Buffer.from(secrets.join(' ')).toString('base64') }; delete bad.queryProjectionVersion;
  f.db.prepare('UPDATE v2_stats_jobs SET result=? WHERE id=?').run(JSON.stringify(bad), job.jobId);
  assert.throws(() => f.service.readJob(f.actor('query_only'), job.jobId), /QUERY_EXPORT_REGENERATE_REQUIRED/);
});

test('current roster changes reproject source and invalidate previously generated export bytes', async t => {
  const f = setup(t), a = f.ir.get('accounts', 'query_only');
  const source = query(f); await complete(f, source);
  const job = f.service.createJob(f.actor(a.id), 'export', { queryJobId: source.jobId, format: 'json' }, 'scope-export');
  await f.service.runJob(job.jobId); assert.equal(f.service.readJob(f.actor(a.id), job.jobId).status, 'succeeded');
  f.ir.put('squadMembers', { id: 'relation_alpha', memberId: 'g05_alpha', squadId: 'blocked' });
  assert.equal(f.service.readJob(f.actor(a.id), source.jobId).result.publicMember.squad, undefined);
  assert.throws(() => f.service.readJob(f.actor(a.id), job.jobId), /QUERY_EXPORT_REGENERATE_REQUIRED/);
});

test('identity revocation during adapter execution fences completion and all previous query/export access', async t => {
  let release, started;
  const gate = new Promise(r => { release = r; }), ready = new Promise(r => { started = r; });
  const f = setup(t, { providers: { member: async () => { started(); await gate; return { steamId: steam, fields: [{ name: 'notes', value: secrets[1] }] }; } } });
  const job = query(f), work = f.service.runJob(job.jobId); await ready;
  f.identity.revokeAccountScope('query_only', 'test-revocation'); release(); await work;
  const stored = f.service.repo.job(job.jobId); assert.equal(stored.status, 'failed'); clean(stored.result);
  assert.throws(() => f.service.readJob(f.actor('query_only'), job.jobId), /PERMISSIONS_CHANGED/);
});

test('capability hints are read-only, role independent, fixed-shape and do not resolve vanity or reveal member existence', t => {
  const f = setup(t,{scopeContract:true}), n = f.changes();
  const withSteam = f.service.queryCapabilities(f.actor('query_only'), { steamInput: steam });
  const missing = f.service.queryCapabilities(f.actor('query_only'), { steamInput: '76561198000000999' });
  assert.deepEqual(withSteam, missing); assert.deepEqual(Object.keys(withSteam), ['permissionVersion', 'sources', 'catalogs']);
  assert.equal(JSON.stringify(withSteam).includes('memberId'), false); clean(withSteam);
  f.service.queryCapabilities(f.actor('query_only'), { steamInput: 'https://steamcommunity.com/id/example' });
  assert.equal(f.changes(), n); assert.deepEqual(f.calls, []);
  f.addAccount('scoped', ['queries.read', 'queries.run'].map(cap => grant(cap, { type: 'squads', ids: ['g05_squad'] })));
  for (const input of [{}, { steamInput: 'https://steamcommunity.com/id/example' }]) {
    const hint = f.service.queryCapabilities(f.actor('scoped'), input).sources.find(s => s.sourceId === 'member');
    assert.equal(hint.requiresSubject, true); assert.equal(hint.run, false);
  }
  assert.equal(f.service.queryCapabilities(f.actor('scoped'), { steamInput: steam }).sources.find(s => s.sourceId === 'member').run, true);
  assert.equal(f.service.queryCapabilities(f.actor('scoped'), { steamInput: '76561198000000505' }).sources.find(s => s.sourceId === 'member').run, false);
});

for (const role of ['member', 'viewer', 'admin', 'custom']) test(`current fixed role ${role} governs provider and catalog job admission`, async t => {
  const f = setup(t), permissions = { officialKda: { view: true } };
  f.addAccount(role, migrateLegacyGrants({ id: role, role }, { permissionRoles: [{ code: role, permissions }], squads: [] }).grants,
    { roleId:role==='admin'?'admin':'member',adminAssignedByOwner:role==='admin' });
  for (const sourceId of ['official','inventory','member','vital','moose','catalog']) for (const known of [true,false]) {
    const body={sourceId,steamInput:known?steam:'76561198000000999',serverId:'s',providerWipeId:'p'};
    if(sourceId==='catalog') body.provider='moose';
    if(role==='admin') await complete(f,query(f,role,body,`${role}-${sourceId}-${known}`),role);
    else assert.throws(()=>query(f,role,body,`${role}-${sourceId}-${known}`),/ACCESS_DENIED/);
  }
  if(role==='admin') {
    await complete(f,query(f,role,{sourceId:'catalog',provider:'vital',steamInput:'not-an-input'},`${role}-catalog-nonsubject`),role);
    assert.throws(()=>query(f,role,{sourceId:'catalog',provider:'invalid'},`${role}-catalog-invalid`),/INVALID_SOURCE/);
  } else assert.deepEqual(f.calls,[]);
});

test('legacy custom source grants cannot authorize a member vanity request or invoke its provider', t => {
  let called=0;
  const f=setup(t,{providers:{official:async()=>{called++;return {steamId:steam,displayName:secrets[1],fields:[]};}}});
  f.addAccount('vanity',[grant('queries.read',{type:'all'}),grant('queries.run',{type:'all'}),
    grant('queries.read',{type:'squads',ids:['g05_squad']},{effect:'deny'})]);
  const before=f.changes(),hint=f.service.queryCapabilities(f.actor('vanity'),{steamInput:'https://steamcommunity.com/id/known'}).sources[0];
  assert.equal(hint.read,false);assert.equal(hint.run,false);
  assert.throws(()=>query(f,'vanity',{sourceId:'official',steamInput:'https://steamcommunity.com/id/known'}),/ACCESS_DENIED/);
  assert.equal(called,0);assert.equal(f.changes(),before);assert.deepEqual(f.calls,[]);
});

test('provider returning a different numeric subject fails without saving its data', async t => {
  const f = setup(t, { providers: { member: async () => ({ steamId: '76561198000000505', displayName: secrets[1], rows: [] }) } });
  const job = query(f); await f.service.runJob(job.jobId);
  const stored = f.service.repo.job(job.jobId); assert.equal(stored.status, 'failed'); assert.equal(stored.result.errorCode, 'QUERY_SUBJECT_MISMATCH'); clean(stored.result);
});

test('public projection changing during asynchronous rendering blocks stale export completion', async t => {
  const f = setup(t), source = query(f); await complete(f, source);
  const originalRenderer = f.service.renderExport;
  f.service.renderExport = async (...args) => {
    const result = await originalRenderer(...args);
    f.ir.put('members', { ...f.ir.get('members', 'g05_alpha'), displayName: '更新后的公开昵称' });
    return result;
  };
  const job = f.service.createJob(f.actor('query_only'), 'export', { queryJobId: source.jobId, format: 'json' }, 'changed-during-render');
  await f.service.runJob(job.jobId); const stored = f.service.repo.job(job.jobId);
  assert.equal(stored.status, 'failed'); assert.equal(stored.result.base64, undefined);
  assert.equal(stored.result.errorCode, 'QUERY_EXPORT_REGENERATE_REQUIRED');
});

test('default local member fallback gives a fixed safe instruction for unsupported vanity links', async t => {
  const f = setup(t), job = query(f, 'query_only', { sourceId: 'member', steamInput: 'https://steamcommunity.com/id/fixture' });
  await f.service.runJob(job.jobId);
  const read = f.service.readJob(f.actor('query_only'), job.jobId);
  assert.equal(read.status, 'failed');
  assert.deepEqual(read.result, { errorCode: 'VANITY_RESOLVER_REQUIRED', retryable: false });
  assert.deepEqual(f.calls, []);
});
