import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './support/v2-member-followups/fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';
const setup = async (t, options) => { const f = await fixture(options); t.after(() => f.close()); return f; };
const member = (f, id) => f.ir.get('members', id);

test('real creation -> original durable outbox -> canonical SyncCenter/source worker -> same member/profile', async t => {
  const f = await setup(t), receipt = await f.create(), mid = receipt.data.id;
  assert.equal(f.jobs().length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.consumer.drain()).processed, 1);
  assert.equal(f.consumer.position(), f.latestSeq()); assert.equal(f.jobs().length, 2);
  assert.ok(f.jobs().every(j => j.trigger === 'auto' && j.actorId === 'admin' && j.items[0].memberId === mid));
  await f.drain(); assert.ok(f.jobs().every(j => ['succeeded', 'no_work'].includes(j.status))); assert.ok(f.jobs().some(j => j.status === 'succeeded'));
  assert.equal(member(f, mid).steamNickname, 'Loopback 已采集昵称');
  const profiles = f.members.repo.find('memberProfiles', 'memberId', mid, 3); assert.equal(profiles.length, 1);
  assert.equal(profiles[0].steamId, member(f, mid).steamId); assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.memberTransaction === false));
  const count = f.jobs().length; await f.followups.consume(f.latestSeq()); assert.equal(f.jobs().length, count);
  assert.equal((await f.consumer.drain()).processed, 0);
});

test('must install guarded existing worker and reject asynchronous readers/forged event argument', async t => {
  const f = await setup(t, { startWorker: false }); await f.create();
  assert.throws(() => f.followups.consume(f.latestSeq()), /FOLLOWUP_GUARDS_REQUIRED/);
  f.worker = f.followups.startWorker({ providers: f.adapters.providers });
  assert.throws(() => f.followups.consume({ seq: f.latestSeq(), actor: { id: 'root' } }), /FOLLOWUP_EVENT_INVALID/);
  f.setPolicy({ ...f.policy(), enabled: false });
  await f.consumer.drain(); assert.equal(f.jobs().length, 0);
  assert.ok(f.followups.progress(f.latestSeq()).results.every(r => r.reason === 'BACKGROUND_DISABLED'));
});

test('submission failure is not ACKed; transaction rollback and replay reuse accepted canonical jobs', async t => {
  const f = await setup(t); await f.create();
  const original = f.sync.insert.bind(f.sync); let count = 0;
  f.sync.insert = (...args) => { const out = original(...args); if (++count === 2) throw new Error('crash after insert'); return out; };
  await assert.rejects(f.consumer.drain(), /crash after insert/);
  assert.equal(f.consumer.position(), 0); assert.equal(f.jobs().length, 1);
  assert.equal(f.followups.progress(f.latestSeq()).completed, false);
  const firstId = f.jobs()[0].id; f.sync.insert = original;
  await f.consumer.drain(); assert.equal(f.jobs().length, 2); assert.ok(f.jobs().some(j => j.id === firstId));
  assert.equal(f.followups.progress(f.latestSeq()).completed, true);
});

test('restart after accepted job but before original outbox checkpoint does not duplicate and restores guards', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nb-followup-')), filename = path.join(dir, 'db.sqlite');
  let f;
  try {
    f = await fixture({ filename }); await f.create(); await f.followups.consume(f.latestSeq());
    assert.equal(f.consumer.position(), 0); const ids = f.jobs().map(j => j.id).sort(); await f.close(); f = null;
    f = await fixture({ filename }); await f.consumer.drain(); assert.deepEqual(f.jobs().map(j => j.id).sort(), ids);
    f.setPolicy({ ...f.policy(), revision: 'rotated-credentials' }); await f.drain();
    assert.equal(f.calls.length, 0); assert.ok(f.jobs().every(j => j.items[0].status === 'skipped'));
  } finally { if (f) await f.close(); await rm(dir, { recursive: true }); }
});

for (const scenario of ['steam', 'principal', 'permission', 'source', 'config', 'status']) test(`queued ${scenario} drift cannot collect under an old event`, async t => {
  const f = await setup(t), created = await f.create(); await f.consumer.drain();
  if (scenario === 'steam') f.ir.put('members', { ...member(f, created.data.id), steamId: '76561198999999112' });
  if (scenario === 'principal') f.ir.setScalar('fixtureFollowupPrincipal', { accountId: 'root', permissionVersion: 1 });
  if (scenario === 'permission') f.identity.revokeAccountScope('admin', 'isolated revoke');
  if (scenario === 'source') f.readSourceConfig = () => ({ enabled: false, sourceId: 'steam' });
  if (scenario === 'config') f.setPolicy({ ...f.policy(), revision: 'config-2' });
  if (scenario === 'status') f.ir.put('members', { ...member(f, created.data.id), memberStatus: 'blocked' });
  await f.drain(); assert.equal(f.calls.length, 0);
  assert.ok(f.jobs().every(j => j.items[0].status === 'skipped' || j.status === 'cancelled'));
});

test('explicit admin demotion is checked on current principal; event author is not its authority', async t => {
  const f = await setup(t), created = await f.create(), account = f.ir.get('accounts', 'admin');
  f.ir.put('accounts', { ...account, roleId: 'member', adminAssignedByOwner: false, grants: [...account.grants, grant('sync.run', { type: 'all' }, { effect: 'deny' })] });
  await f.consumer.drain(); assert.equal(f.jobs().length, 0);
  assert.ok(f.followups.progress(f.latestSeq()).results.filter(r => r.reason !== 'SOURCE_DISABLED').every(r => r.reason === 'ACCESS_DENIED'));
  assert.equal(member(f, created.data.id).steamNickname, '');
});

test('disabled/unconfigured sources persist terminal skipped outcomes and do not spin/requeue on enable', async t => {
  const f = await setup(t); await f.create(); const policy = f.policy();
  for (const task of Object.values(policy.tasks)) { task.enabled = true; task.ready = false; }
  f.setPolicy(policy); await f.consumer.drain(); assert.equal(f.jobs().length, 0);
  assert.ok(f.followups.progress(f.latestSeq()).results.every(r => r.reason === 'SOURCE_NOT_CONFIGURED'));
  for (const task of Object.values(policy.tasks)) task.ready = true;
  f.setPolicy(policy); await f.followups.consume(f.latestSeq()); assert.equal(f.jobs().length, 0);
});

test('manual canonical jobs and other-owner jobs are not guarded by the maintenance policy', async t => {
  const f = await setup(t); const job = await f.sync.request(f.actor(), { type: 'member_profile', scope: { kind: 'members', memberIds: ['m001'] } }, { operationId: 'member-followups:manual-is-still-manual' });
  f.setPolicy({ ...f.policy(), enabled: false }); await f.drain();
  assert.equal(f.sync.job(job.job.id).status, 'succeeded'); assert.equal(f.calls.length, 1);
});

for (const drift of ['policy', 'steam', 'deny']) test(`in-flight ${drift} change is fenced before canonical source apply`, async t => {
  const f = await setup(t), created = await f.create(); await f.consumer.drain();
  f.responses.set('steam', (req, res) => {
    if (drift === 'policy') f.setPolicy({ ...f.policy(), revision: 'changed-during-http' });
    if (drift === 'steam') f.ir.put('members', { ...member(f, created.data.id), steamId: '76561198999999115' });
    if (drift === 'deny') { const a = f.ir.get('accounts', 'admin'); f.ir.put('accounts', { ...a, roleId: 'member', adminAssignedByOwner: false,
      grants: [...a.grants, grant('sync.run', { type: 'all' }, { effect: 'deny' })] }); }
    res.json({ steamId: req.query.steamId, nickname: 'MUST_NOT_APPLY' });
  });
  await f.drain();
  assert.equal(f.members.repo.find('memberProfiles', 'memberId', created.data.id, 3).length, 0);
  assert.notEqual(member(f, created.data.id).steamNickname, 'MUST_NOT_APPLY');
});

test('canonical write queue gap after provider is guarded again by applyResult', async t => {
  const f = await setup(t), created = await f.create(); await f.consumer.drain();
  const serialize = f.sync.authority.serializeWrite;
  f.responses.set('steam', (req, res) => {
    f.sync.authority.serializeWrite = fn => serialize(() => {
      f.setPolicy({ ...f.policy(), revision: 'changed-in-commit-queue' }); return fn();
    });
    res.json({ steamId: req.query.steamId, nickname: 'MUST_NOT_APPLY' });
  });
  await f.worker.step();
  assert.equal(f.members.repo.find('memberProfiles', 'memberId', created.data.id, 3).length, 0);
  assert.notEqual(member(f, created.data.id).steamNickname, 'MUST_NOT_APPLY');
});

test('source failure remains a canonical failed task; outbox replay does not create replacement and explicit SyncCenter retry works', async t => {
  const f = await setup(t); await f.create(); await f.consumer.drain();
  const source = f.sync.repo.get('source', 'steam') || { id: 'steam', source: 'steam', revision: 1, concurrency: 1, reservedManual: 0,
    minIntervalMs: 0, timeoutMs: 500, priority: 50, paused: false, nextAllowedAt: 0 };
  f.sync.repo.put('source', { ...source, maxAttempts: 1 });
  f.responses.set('steam', (_req, res) => res.status(503).end()); await f.drain();
  assert.ok(f.jobs().every(j => j.status === 'failed')); const count = f.jobs().length;
  await f.followups.consume(f.latestSeq()); assert.equal(f.jobs().length, count);
  f.responses.delete('steam'); const old = f.jobs()[0];
  const input = { expectedRevision: old.revision }, operationId = 'explicit-canonical-retry';
  const retry = await f.sync.action(f.actor(), old.id, 'retry', input, { operationId });
  const replay = await f.sync.action(f.actor(), old.id, 'retry', input, { operationId });
  assert.equal(retry.job.id, replay.job.id); assert.equal(f.jobs().length, count + 1);
  await f.drain(); assert.equal(f.sync.job(retry.job.id).status, 'succeeded');
});

test('stop drains the in-flight real worker and rejects new consumption', async t => {
  const f = await setup(t); await f.create(); await f.consumer.drain();
  let release, entered; const ready = new Promise(r => { entered = r; });
  // The real loopback fetch is aborted and drained by the existing worker.
  const file = f.jobs().find(j => j.type === 'member_profile');
  const binding = f.db.prepare('SELECT binding FROM v2_member_followup_jobs WHERE job_id=?').get(file.id); assert.ok(binding);
  f.responses.set('steam', (req, res) => { entered(); release = () => res.json({ steamId: req.query.steamId, nickname: 'drained' }); });
  const running = f.worker.step(); await ready;
  const stopping = f.followups.stop();
  assert.throws(() => f.followups.consume(f.latestSeq()), /FOLLOWUP_STOPPED/);
  release(); await stopping; await running;
  assert.equal(f.worker.accepting, false);
});

test('committed submission with an after-commit failure survives replay without duplicate job', async t => {
  const f = await setup(t); await f.create(); const original = f.sync.authority.serializeWrite; let fail = true;
  f.sync.authority.serializeWrite = async fn => { const result = await original(fn);
    if (fail && f.jobs().length === 1) { fail = false; throw new Error('post-commit cache unavailable'); } return result;
  };
  await assert.rejects(f.consumer.drain(), /post-commit cache unavailable/);
  assert.equal(f.consumer.position(), 0); const first = f.jobs()[0].id;
  await f.consumer.drain(); assert.equal(f.jobs().length, 2); assert.ok(f.jobs().some(j => j.id === first));
});

test('missing canonical receipt prevents ACK; unrelated member edits are consumed without jobs', async t => {
  const f = await setup(t); await f.runtime.writeDomain(() => f.members.edit(f.actor(), 'm001', { expectedRevision: 1, fields: { customName: 'new name' } }, 'unrelated-edit'));
  await f.consumer.drain(); assert.equal(f.jobs().length, 0);
  await f.create(); f.db.prepare('DELETE FROM v2_member_admin_operations WHERE operation_id=(SELECT operation_id FROM v2_member_admin_outbox WHERE seq=?)').run(f.latestSeq());
  await assert.rejects(f.consumer.drain(), /MEMBER_OUTBOX_RECEIPT_MISSING/);
  assert.equal(f.consumer.position(), 1); assert.equal(f.jobs().length, 0);
});

test('source identity/type and wipe/participant admission cannot be replaced by policy ready flags', async t => {
  const f = await setup(t); await f.create(); const policy = f.policy();
  for (const config of Object.values(policy.tasks)) { config.enabled = true; config.ready = true; }
  policy.tasks.kda.wipeId = 'missing-wipe'; policy.tasks.battlemetrics_playtime.wipeId = 'missing-wipe'; f.setPolicy(policy);
  f.readSourceConfig = () => ({ enabled: true, sourceId: 'other-source' });
  await f.consumer.drain(); assert.equal(f.jobs().length, 0);
  assert.ok(f.followups.progress(f.latestSeq()).results.every(r => r.outcome === 'skipped'));
});

test('canonical queue full prevents ACK and can retry the same event after capacity recovers', async t => {
  const f = await setup(t); await f.create();
  for (let i = 0; i < 500; i++) f.sync.repo.put('job', { id: 'occupied-' + i, type: 'member_profile', source: 'steam', status: 'queued',
    scopeKey: 'occupied-' + i, scope: { kind: 'members', memberIds: ['m001'] }, items: [{ memberId: 'm001', status: 'pending' }],
    actorId: 'admin', createdAt: i, updatedAt: i, revision: 1 });
  await assert.rejects(f.consumer.drain(), /SYNC_QUEUE_FULL/); assert.equal(f.consumer.position(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM v2_member_followup_jobs').get().n, 0);
  f.db.prepare("DELETE FROM sync_center_records WHERE kind='job' AND id LIKE 'occupied-%'").run();
  await f.consumer.drain(); assert.equal(f.jobs().length, 2);
});

test('Steam changes before consumption never schedule a different current identity', async t => {
  const f = await setup(t);
  const created = await f.create(); f.ir.put('members', { ...member(f, created.data.id), steamId: '76561198999999119' });
  await f.consumer.drain(); assert.equal(f.jobs().length, 0);
});

test('current started wipe plus real KDA participant and canonical scope gates are required', async t => {
  const f = await setup(t), created = await f.create();
  f.members.repo.put('v2Wipes', { id: 'followup-wipe', lifecycle: 'active', revision: 1, actualStartedAt: '2030-09-08T09:00:00Z',
    audience: { includeUnassigned: true, squadIds: [], memberIds: [] } });
  const policy = f.policy(); for (const [type, task] of Object.entries(policy.tasks)) {
    task.enabled = true; if (['kda', 'battlemetrics_playtime'].includes(type)) task.wipeId = 'followup-wipe';
  } f.setPolicy(policy);
  await f.consumer.drain();
  assert.equal(f.jobs().length, 4);
  const result = f.followups.progress(f.latestSeq());
  assert.equal(result.results.find(r => r.type === 'kda').reason, 'FOLLOWUP_NOT_KDA_PARTICIPANT');
  assert.equal(f.jobs().find(j => j.type === 'battlemetrics_playtime').scope.wipeId, 'followup-wipe');
  const next = await f.create('76561198999999121');
  f.members.repo.put('v2Signups', { id: 'followup-signup', memberId: next.data.id, wipeId: 'followup-wipe', response: 'attending_on_time' });
  await f.consumer.drain(); assert.equal(f.jobs().filter(j => j.items[0].memberId === next.data.id).length, 5);
});

test('synchronous policy/principal readers are mandatory and absent authority never creates a root', async t => {
  const { createMemberFollowups } = await import('../server/v2/member-followups/index.js');
  const f = await setup(t, { startWorker: false }); await f.create();
  f.followups = createMemberFollowups({ identity: f.identity, syncService: f.sync, readPolicy: () => Promise.resolve(f.policy()),
    readPrincipal: () => f.ir.scalar('fixtureFollowupPrincipal'), readSourceConfig: f.readSourceConfig });
  f.worker = f.followups.startWorker({ providers: f.adapters.providers });
  await assert.rejects(f.consumer.drain(), /FOLLOWUP_SYNCHRONOUS_READER_REQUIRED/);
  assert.equal(f.consumer.position(), 0); assert.equal(f.jobs().length, 0);
});

test('missing trusted maintenance principal is a visible retryable integration failure', async t => {
  const f = await setup(t); await f.create(); const accounts = f.ir.all('accounts');
  f.ir.setScalar('fixtureFollowupPrincipal', null);
  await assert.rejects(f.consumer.drain(), /FOLLOWUP_PRINCIPAL_REQUIRED/);
  assert.equal(f.consumer.position(), 0); assert.equal(f.jobs().length, 0); assert.deepEqual(f.ir.all('accounts'), accounts);
});

test('legacy blacklist status also blocks collection despite an active membership label', async t => {
  const f = await setup(t), created = await f.create();
  f.ir.put('members', { ...member(f, created.data.id), blacklisted: true });
  await f.consumer.drain(); assert.equal(f.jobs().length, 0);
  assert.ok(f.followups.progress(f.latestSeq()).results.filter(r => r.reason !== 'SOURCE_DISABLED').every(r => r.reason === 'FOLLOWUP_MEMBER_INACTIVE'));
});

test('execution guards preserve the canonical captured scope instead of reconstructing an unbound window', async t => {
  const f = await setup(t); await f.create();
  f.sync.authority.captureScope = ({ job }) => ({ ...job.scope, sourceWindowId: job.id });
  await f.consumer.drain();
  const source = f.readSourceConfig;
  f.readSourceConfig = input => { assert.ok(input.scope.sourceWindowId, 'captured canonical scope required'); return source(input); };
  await f.drain(); assert.ok(f.jobs().some(j => j.status === 'succeeded')); assert.equal(f.calls.length, 2);
});
