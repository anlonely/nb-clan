import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSchedulingMigration, applySchedulingMigration } from '../server/v2/scheduling/migration.js';
import { SchedulingRepository, installSchedulingSchema } from '../server/v2/scheduling/repository.js';
import { migrateSchedulingCopy } from './support/v2-scheduling/migrate.mjs';

const now = '2026-09-08T00:00:00.000Z';
const fixture = () => ({ wipes: [
  { id: 'future', status: 'active', wipeMode: 'next', name: '计划档', startedAt: '2026-09-10T12:00:00Z',
    nextWipeAt: '2026-09-17T12:00:00Z', startedAtTimeZone: 'Asia/Shanghai', customLegacy: { retained: true } },
  { id: 'past', status: 'active', startedAt: '2026-09-01T12:00:00Z' },
  { id: 'closed', status: 'closed', startedAt: '2026-08-01T12:00:00Z', closedAt: '2026-08-08T12:00:00Z' }
], wipeParticipants: [
  { id: 'p1', wipeId: 'future', memberId: 'm1', status: 'join', source: 'web' },
  { id: 'p2', wipeId: 'future', memberId: 'm2', status: 'join_8h', source: 'wechat', originalText: '早上来', attendanceModel: 'v2' },
  { id: 'p3', wipeId: 'future', memberId: 'm3', status: 'join_16h', source: 'discord', label: 'Join in 16h' },
  { id: 'p4', wipeId: 'closed', memberId: 'm4', status: 'late', source: 'wechat', note: '旧备注' },
  { id: 'p5', wipeId: 'closed', memberId: 'm5', status: 'skip', source: 'wechat' },
  { id: 'p6', wipeId: 'closed', memberId: 'm6', status: 'skip', source: 'discord' }
], wipeSettlements: [{ id: 'settled1', wipeId: 'closed', generatedAt: '2026-08-08T12:05:00Z',
  participantsSnapshot: [{ memberId: 'm4', name: '当时姓名' }], summary: { total: 2 }, custom: 'raw' }] });
function repository(t) { const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installSchedulingSchema(db); return new SchedulingRepository(db); }

test('migration preserves the complete legacy source while keeping unproven times unknown', () => {
  const input = fixture(), unchanged = structuredClone(input);
  const plan = planSchedulingMigration(input, { now });
  assert.deepEqual(input, unchanged);
  assert.equal(plan.wipes.find(w => w.id === 'future').title, '计划档');
  assert.equal(plan.wipes.find(w => w.id === 'future').description, '');
  assert.equal(plan.wipes.find(w => w.id === 'future').autoOpenSignup, false);
  assert.equal(plan.wipes.find(w => w.id === 'future').lifecycle, 'scheduled');
  assert.equal(plan.wipes.find(w => w.id === 'future').serverScheduledWipeAt, '2026-09-10T12:00:00.000Z');
  assert.equal(plan.wipes.find(w => w.id === 'past').lifecycle, 'active');
  assert.equal(plan.wipes.find(w => w.id === 'past').serverScheduledWipeAt, null);
  for (const wipe of plan.wipes) {
    assert.deepEqual(wipe.legacyRaw, input.wipes.find(raw => raw.id === wipe.id));
    for (const key of ['musterAt', 'serverActualWipeAt', 'actualStartedAt', 'phaseEnteredAt', 'signupOpensAt', 'signupClosesAt']) assert.equal(wipe[key], null);
    assert.equal(wipe.autoStart, false); assert.equal(wipe.signupWindow, 'closed');
    assert.deepEqual(wipe.audience, { squadIds: [], memberIds: [], includeUnassigned: false });
  }
  for (const signup of plan.signups) {
    assert.equal(signup.expectedArrivalAt, null); assert.equal(signup.confirmedContentRevision, null); assert.equal(signup.signupRevision, 1);
    assert.deepEqual(signup.legacyRaw, input.wipeParticipants.find(raw => raw.memberId === signup.memberId));
    const expectedId = 'signup_' + createHash('sha256').update(JSON.stringify([signup.wipeId, signup.memberId])).digest('hex');
    assert.equal(signup.id, expectedId);
  }
  assert.equal(plan.signups.find(s => s.memberId === 'm2').legacyTimeStatus, 'legacy_time_unknown');
  assert.equal(plan.signups.find(s => s.memberId === 'm2').legacyOriginalText, '早上来');
  assert.equal(plan.signups.find(s => s.memberId === 'm2').legacyModelVersion, 'v2');
});

test('closed remains ended and old settlement is labelled legacy, without claiming a V2 frozen roster', () => {
  const input = fixture(), plan = planSchedulingMigration(input, { now });
  const closed = plan.wipes.find(w => w.id === 'closed');
  assert.equal(closed.lifecycle, 'ended'); assert.equal(closed.outcome, null);
  assert.equal(closed.endedAt, '2026-08-08T12:00:00.000Z'); assert.equal(closed.settlementStatus, 'legacy_review_required');
  assert.equal(plan.archives[0].id, 'closed:0'); assert.equal(plan.archives[0].archiveRevision, 0);
  assert.equal(plan.archives[0].sourceWasMutable, true); assert.equal(plan.archives[0].format, 'legacy');
  assert.equal(plan.archives[0].frozenRoster, null); assert.deepEqual(plan.archives[0].legacyRaw, input.wipeSettlements);
});

test('future timestamp alone or contradictory start evidence does not prove a scheduled lifecycle', () => {
  const input = fixture();
  input.wipes = [
    { id: 'a', status: 'active', startedAt: '2026-10-01T00:00:00Z' },
    { id: 'b', status: 'active', startedAt: '2026-10-01T00:00:00Z', wipeLabel: 'Planned', startEvidence: { source: 'legacy' } },
    { id: 'c', status: 'active', startedAt: '2026-02-30T00:00:00Z', wipeMode: 'next' }
  ];
  const plan = planSchedulingMigration(input, { now });
  for (const wipe of plan.wipes) { assert.equal(wipe.lifecycle, 'active'); assert.equal(wipe.migrationMode, 'legacy_unknown'); }
});

test('unknown enums, unknown skip sources, duplicate slots and unresolved references are quarantined', () => {
  const input = fixture();
  input.wipeParticipants.push(
    { id: 'u1', wipeId: 'future', memberId: 'u1', status: 'skip' },
    { id: 'u2', wipeId: 'future', memberId: 'u2', status: 'unsure' },
    { id: 'u3', wipeId: 'future', memberId: 'u3', status: 'bench' },
    { id: 'u4', wipeId: 'missing', memberId: 'u4', status: 'join' },
    { id: 'u5', wipeId: 'future', memberId: 'm1', status: 'not_attending' }
  );
  input.wipes.push({ id: 'invalid', status: 'archived' }, { id: 'duplicate', status: 'active' }, { id: 'duplicate', status: 'closed' });
  input.wipeSettlements.push({ id: 'orphan', wipeId: 'missing', raw: { retain: true } });
  const plan = planSchedulingMigration(input, { now });
  assert.equal(plan.signups.length, 5); assert.equal(plan.signups.some(s => s.memberId === 'm1'), false);
  for (const kind of ['WIPE_STATUS_UNKNOWN', 'WIPE_ID_CONFLICT', 'SIGNUP_SKIP_SEMANTICS_UNKNOWN', 'SIGNUP_STATUS_UNKNOWN',
    'SIGNUP_WIPE_UNRESOLVED', 'SIGNUP_SLOT_CONFLICT', 'SETTLEMENT_WIPE_UNRESOLVED']) assert.ok(plan.quarantine.some(q => q.kind === kind));
  assert.equal(plan.signups.filter(s => s.response === 'not_attending').length, 2);
  assert.ok(plan.signups.filter(s => s.response === 'not_attending').every(s => s.semanticEvidence));
});

test('only explicit audience survives migration; original scope is never inferred from replies', () => {
  const input = fixture();
  input.wipes[0].audience = { squadIds: ['s1'], memberIds: ['m2'], includeUnassigned: false };
  const plan = planSchedulingMigration(input, { now });
  assert.deepEqual(plan.wipes[0].audience, input.wipes[0].audience);
  assert.equal(plan.wipes[0].legacyIssues.includes('AUDIENCE_REVIEW_REQUIRED'), false);
  assert.equal(plan.wipes[1].legacyIssues.includes('AUDIENCE_REVIEW_REQUIRED'), true);
});

test('migration commits once, preserves later V2 state on replay and rejects a different source', t => {
  const repo = repository(t), input = fixture(), plan = planSchedulingMigration(input, { now });
  const first = applySchedulingMigration(repo, plan);
  assert.equal(first.replayed, false); assert.equal(first.status, 'completed');
  assert.equal(repo.all('outbox').length, 0); assert.equal(repo.all('events').length, 0);
  const current = repo.get('wipes', 'future'); repo.put('wipes', { ...current, revision: 2, description: 'later V2 change' });
  assert.equal(applySchedulingMigration(repo, plan).replayed, true);
  assert.equal(repo.get('wipes', 'future').description, 'later V2 change');
  assert.equal(applySchedulingMigration(repo, planSchedulingMigration(input, { now: '2026-09-09T00:00:00Z' })).replayed, true);
  input.wipes[0].name = 'different source';
  assert.throws(() => applySchedulingMigration(repo, planSchedulingMigration(input, { now })), { errorCode: 'MIGRATION_SOURCE_CONFLICT' });
  assert.equal(repo.scalar('v2SchedulingMigration').sourceHash, first.sourceHash);
});

test('preflight refuses unknown existing target rows before writing any import', t => {
  const repo = repository(t), plan = planSchedulingMigration(fixture(), { now });
  repo.put('signups', { ...plan.signups[0], signupRevision: 8 });
  assert.throws(() => applySchedulingMigration(repo, plan), { errorCode: 'MIGRATION_TARGET_CONFLICT' });
  assert.equal(repo.all('wipes').length, 0); assert.equal(repo.scalar('v2SchedulingMigration'), null);
});

test('matching partial targets resume safely and a mid-import failure rolls everything back', t => {
  const repo = repository(t), plan = planSchedulingMigration(fixture(), { now });
  repo.put('wipes', plan.wipes[0]);
  const originalPut = repo.put.bind(repo);
  repo.put = (collection, row) => { if (collection === 'signups') throw new Error('injected interruption'); return originalPut(collection, row); };
  assert.throws(() => applySchedulingMigration(repo, plan), /injected interruption/);
  assert.equal(repo.all('wipes').length, 1); assert.equal(repo.all('contents').length, 0);
  assert.equal(repo.scalar('v2SchedulingMigration'), null);
  repo.put = originalPut; assert.equal(applySchedulingMigration(repo, plan).replayed, false);
  assert.equal(repo.all('wipes').length, 3); assert.equal(repo.all('contents').length, 3);
});

test('source hash is stable across object key order and changes when a raw value changes', () => {
  const first = planSchedulingMigration({ wipes: [], wipeParticipants: [] }, { now });
  const second = planSchedulingMigration({ wipeParticipants: [], wipes: [] }, { now });
  assert.equal(first.sourceHash, second.sourceHash);
  assert.notEqual(first.sourceHash, planSchedulingMigration({ wipes: [], wipeParticipants: [], legacyValue: true }, { now }).sourceHash);
});

test('offline migration command creates a separate complete candidate and refuses output reuse or escape', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = await mkdtemp(path.join(root, '.v2-scheduling-migration-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'legacy.json'), output = path.join(dir, 'candidate');
  const bytes = JSON.stringify(fixture()); await writeFile(source, bytes, { flag: 'wx', mode: 0o600 });
  const report = await migrateSchedulingCopy({ source, output, mode: 'apply', now });
  assert.equal(report.sourceUnchanged, true); assert.equal(report.integrity, 'ok'); assert.equal(report.replay.replayed, true);
  assert.equal(await readFile(source, 'utf8'), bytes);
  const db = new DatabaseSync(report.candidate, { readOnly: true });
  try {
    const getScalar = key => new SchedulingRepository(db).scalar(key);
    assert.equal(getScalar('v2IdentitySchemaVersion'), 1); assert.equal(getScalar('v2SchedulingSchemaVersion'), 1);
    assert.ok(getScalar('v2IdentityMigration')); assert.equal(getScalar('v2SchedulingMigration').status, 'completed');
  } finally { db.close(); }
  await assert.rejects(migrateSchedulingCopy({ source, output, mode: 'apply', now }), { code: 'EEXIST' });
  await assert.rejects(migrateSchedulingCopy({ source, output: path.resolve(root, '../escape-migration'), now }), /inside this independent worktree/);
});
