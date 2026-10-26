import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './support/v2-vip-notifications/fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';
import { IdentityError } from '../server/v2/identity/errors.js';
import { installVipNotificationsSchema } from '../server/v2/vip-notifications/index.js';
import { resourceKind } from '../server/v2/notifications/business.js';
const code = errorCode => e => e.errorCode === errorCode;
async function setup(t, options) { const f = await fixture(options); t.after(() => f.close()); await f.setVip(); return f; }
const queued = f => f.vip.tick({ limit: 1 });
const rows = (f, table) => f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const status = f => f.deliveries().map(d => ({ status: d.status, error: d.lastErrorCode }));

test('explicit VIP marker and domain registration do not reinterpret old wipe/review data', async t => {
  const f = await fixture({ migrate: false }); t.after(() => f.close());
  assert.throws(f.createDomain, code('NOTIFICATION_VIP_MIGRATION_REQUIRED'));
  installVipNotificationsSchema(f.db); f.vip = f.createDomain();
  assert.throws(f.createDomain, code('NOTIFICATION_BUSINESS_DOMAIN_CONFLICT'));
  assert.equal(resourceKind({ wipeId: 'w1' }), 'wipe');
  assert.equal(resourceKind({ resource: { kind: 'memberReview', id: 'a1' }, wipeId: null }), 'memberReview');
  assert.throws(() => resourceKind({ resource: { kind: 'vipExpiry', id: 'm001' }, wipeId: 'fake' }), code('NOTIFICATION_RESOURCE_INVALID'));
});

test('original member HTTP write → bounded scan → original worker native DM send/edit and original G03 read', async t => {
  const f = await setup(t), first = await queued(f); assert.equal(first.scanned, 1); assert.equal(first.queued, 1);
  assert.equal(first.cursor, 'm001'); assert.equal(first.completed, false);
  await f.drain(); const d = f.deliveries()[0], repo = f.notifications.service.repo;
  assert.equal(d.status, 'sent', JSON.stringify(status(f))); assert.equal(d.resource.kind, 'vipExpiry'); assert.equal(d.wipeId, null);
  assert.deepEqual(f.calls.map(c => c.method), ['POST', 'PATCH']); assert.equal(f.messages.size, 1);
  const ref = repo.all('messageRefs')[0]; assert.equal(ref.guildId, null); assert.equal(ref.channelId, f.channelId); assert.equal(ref.messageUrl, null);
  assert.ok(f.calls[1].path.endsWith('/' + ref.messageId)); assert.equal(d.attemptCount, 1);
  assert.equal((await f.request(`/deliveries/${d.id}`)).status, 200);
  assert.equal((await f.request(`/deliveries/${d.id}`, { headers: f.headers('viewer') })).status, 404);
  assert.deepEqual(d.actionReferenceIds, []); assert.deepEqual(f.calls[0].body.allowed_mentions.parse, []);
  assert.ok(f.calls[0].body.embeds[0].description.includes(`<t:${Date.parse('2030-09-08T16:00:00.000Z') / 1000}:F>`));
  assert.ok(!JSON.stringify(f.calls[0].body).includes('private-')); assert.ok(f.proofCalls.length >= 2);
  assert.equal(repo.forWipe('deliveries', null).length, 0);
  assert.equal(f.cache.members.find(m => m.id === 'm001').vitalVipExpiresAt, '2030-09-08');
});

test('hourly finite scan persists high water/cursor and coalesces queue admission', async t => {
  const f = await setup(t), n = f.queueCalls(), a = f.vip.tick({ limit: 2 }), b = f.vip.tick({ limit: 2 });
  assert.equal(a, b); await a; assert.equal(f.queueCalls() - n, 1);
  f.ir.put('members', { ...f.ir.get('members', 'm065'), id: 'm999', steamId: '76561198999999999' });
  await f.scan(7); const s = f.vip.scanState(); assert.equal(s.cursor, 'm065'); assert.equal(s.highWater, 'm065');
  assert.equal(f.observations().length, 65 * 3); assert.equal((await f.vip.tick()).waiting, true);
  f.advance(3600000); await f.refreshProofs(); await f.scan(9);
  assert.equal(f.vip.scanState().generation, 2); assert.equal(f.vip.scanState().cursor, 'm999');
  assert.equal(f.observations().length, 66 * 3); assert.equal(f.deliveries().length, 1);
  assert.throws(() => f.vip.tick({ limit: 101 }), code('VIP_SCAN_LIMIT_INVALID'));
  f.advance(-3600001); await assert.rejects(f.vip.tick(), code('VIP_CLOCK_REGRESSED'));
});

test('three actual models keep Vital-only default; Rustinity and Atlas require explicit opt-in', async t => {
  const f = await setup(t); await f.setVip('rustinity'); await f.setVip('atlas'); await f.scan();
  assert.equal(f.deliveries().length, 1);
  f.policy.sources = { rustinity: { enabled: true, revision: 'opt-in-1' }, atlas: { enabled: true, revision: 'opt-in-1' } };
  await f.scan(); assert.equal(f.deliveries().length, 3); await f.drain();
  assert.equal(f.calls.filter(c => c.operation === 'send').length, 2); // Policy change fences already-admitted Vital.
  assert.equal(new Set(f.deliveries().map(d => d.event.id)).size, 3);
});

for (const [name, mutate, reason] of [
  ['legacy sent marker', f => f.ir.put('members', { ...f.ir.get('members', 'm001'), vitalVipReminderExpiresAt: '2030-09-08' }), 'VIP_LEGACY_ALREADY_SENT'],
  ['legacy scheduler still owns reminders', f => { f.policy.legacySchedulerDisabled = false; }, 'VIP_LEGACY_OWNER_ACTIVE'],
  ['policy disabled', f => { f.policy.enabled = false; }, 'VIP_NOTIFICATIONS_DISABLED'],
  ['future renewal', f => f.setVip('vital', '2030-10-06'), 'VIP_OUTSIDE_WINDOW'],
  ['missing identity', f => f.ir.put('members', { ...f.ir.get('members', 'm001'), discordId: '' }), 'VIP_DISCORD_IDENTITY_REQUIRED'],
  ['DM group', f => { f.proof.channel.type = 3; }, 'VIP_DM_TARGET_UNVERIFIED'],
  ['DM guild', f => { f.proof.channel.guild_id = '100000000000000001'; }, 'VIP_DM_TARGET_UNVERIFIED'],
  ['DM wrong peer', f => { f.proof.channel.recipients = [{ id: '300000000000000002' }]; }, 'VIP_DM_TARGET_UNVERIFIED'],
  ['DM multiple peers', f => { f.proof.channel.recipients.push({ id: '300000000000000002' }); }, 'VIP_DM_TARGET_UNVERIFIED'],
  ['DM stale proof', f => { f.proof.expiresAt = new Date(f.now()).toISOString(); }, 'VIP_DM_PROOF_EXPIRED'],
  ['DM unverified', f => { f.proof.verified = false; }, 'VIP_DM_TARGET_UNVERIFIED'],
  ['DM different bot', f => { f.proof.botUserId = '400000000000000002'; }, 'VIP_DM_TARGET_UNVERIFIED'],
  ['disabled source config', f => { f.configs.vital.enabled = false; }, 'VIP_SOURCE_NOT_CONFIGURED'],
  ['unsupported template', f => { f.configs.vital.templateRevision = 2; }, 'VIP_TEMPLATE_UNSUPPORTED'],
  ['unsupported preferred language', f => { f.proof.languages = ['zh-CN']; }, 'LANGUAGE_UNSUPPORTED'],
  ['read-only maintainer', f => { f.pin.accountId = 'viewer'; }, 'ACCESS_DENIED']
]) test(`scan records explicit no-send outcome: ${name}`, async t => {
  const f = await setup(t); await mutate(f); await queued(f); await f.run();
  assert.equal(f.observations()[0].reason, reason); assert.equal(f.deliveries().length, 0); assert.equal(f.calls.length, 0);
  assert.equal(rows(f, 'v2_vip_notification_events'), 0);
});

for (const [name, mutate] of [
  ['VIP renewal', f => f.setVip('vital', '2030-10-06')],
  ['same-date type changed', f => f.setVip('vital', '2030-09-08', 'queue_skip')],
  ['maintenance PV', f => f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), permissionVersion: 2 })],
  ['recipient PV', f => f.ir.put('accounts', { ...f.ir.get('accounts', 'leader'), permissionVersion: 2 })],
  ['recipient account disabled', f => f.ir.put('accounts', { ...f.ir.get('accounts', 'leader'), status: 'disabled' })],
  ['recipient membership removed', f => f.ir.put('members', { ...f.ir.get('members', 'm001'), memberStatus: 'left', membershipStatus: 'left' })],
  ['policy revision', f => { f.policy.revision = 'changed'; }],
  ['source revision', f => { f.configs.vital.revision = 'changed'; }],
  ['DM channel replaced', f => { f.proof.channel.id = '200000000000000002'; }],
  ['DM expired', f => { f.proof.expiresAt = new Date(f.now()).toISOString(); }],
  ['Discord eligibility revoked', async f => { f.roles = []; await assert.rejects(f.refreshProofs(), code('ELIGIBILITY_DENIED')); }],
  ['administrator role revoked', f => f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId:'member', adminAssignedByOwner:false })]
]) test(`dispatch revalidates current ${name} before creating an attempt`, async t => {
  const f = await setup(t); await queued(f); await mutate(f); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.notifications.service.repo.all('attempts').length, 0);
  assert.equal(f.deliveries()[0].status, 'failed', JSON.stringify(status(f)));
});

test('renewal cancels known-unsent old reminder; re-entering its date/type never creates another period intent', async t => {
  const f = await setup(t); await f.scan(); await f.setVip('vital', '2030-10-06');
  f.advance(3600000); await f.refreshProofs(); await f.scan(); assert.equal(f.deliveries()[0].status, 'cancelled');
  await f.setVip('vital', '2030-09-08', 'queue_skip'); f.advance(3600000); await f.refreshProofs(); await f.scan();
  assert.equal(f.deliveries().length, 1); await f.run(); assert.equal(f.calls.length, 0);
});

test('ambiguous response survives rescans without retry; explicit original reconciliation is needed', async t => {
  const f = await setup(t); await f.scan(); f.fault = async ({ res }) => { res.status(503).json({ uncertain: true }); return true; };
  await f.run(); let d = f.deliveries()[0]; assert.equal(d.status, 'delivery_unknown');
  f.advance(3600000); await f.refreshProofs(); await f.scan(); await f.run(); assert.equal(f.calls.length, 1);
  const service = f.notifications.service, actor = f.actor('admin');
  assert.throws(() => service.commandDelivery(actor, d.id, 'retry', { expectedRevision: d.revision, reason: 'retry' }, { operationId: randomUUID() }), code('DELIVERY_NOT_RETRYABLE'));
  service.commandDelivery(actor, d.id, 'reconcile', { expectedRevision: d.revision, decision: 'confirmed_not_sent', reason: '隔离核实', evidence: 'owned loopback ledger has no message' }, { operationId: randomUUID() });
  d = f.deliveries()[0]; service.commandDelivery(actor, d.id, 'retry', { expectedRevision: d.revision, reason: '确定未发送' }, { operationId: randomUUID() });
  await f.drain(); assert.equal(f.deliveries()[0].status, 'sent'); assert.equal(f.deliveries()[0].attemptCount, 2);
});

test('known-unsent 429 retries only the original delivery', async t => {
  const f = await setup(t); await queued(f); f.fault = async ({ res }) => { res.status(429).json({ message: 'rate limited', retry_after: 1 }); return true; };
  await f.run(); assert.equal(f.deliveries()[0].status, 'retry_wait'); assert.equal(f.deliveries()[0].knownNotSent, true);
  f.advance(5000); await f.drain(); assert.equal(f.deliveries()[0].status, 'sent'); assert.equal(f.deliveries().length, 1);
  assert.equal(f.deliveries()[0].attemptCount, 2); assert.equal(f.messages.size, 1);
});

test('renewal during native I/O keeps late provider success unknown, never records false success or resends', async t => {
  const f = await setup(t); await queued(f); f.fault = async () => { await f.setVip('vital', '2030-10-06'); return false; };
  await f.run(); const repo = f.notifications.service.repo;
  assert.equal(f.deliveries()[0].status, 'delivery_unknown'); assert.equal(f.deliveries()[0].lastErrorCode, 'VIP_TERM_CHANGED');
  assert.equal(repo.all('messageRefs').length, 0); assert.equal(repo.all('attempts')[0].lateEvidence[0].outcome, 'sent');
  await f.run(); assert.equal(f.calls.length, 1);
});

test('current fixed roles protect private VIP intent pages and observe administrator revocation', async t => {
  const f = await setup(t); await queued(f); await f.drain();
  assert.throws(() => f.vip.listIntents(f.actor('viewer'), 'm001', { limit: 1 }), code('ACCESS_DENIED'));
  const viewer=f.ir.get('accounts','viewer'); f.ir.put('accounts',{...viewer,roleId:'admin',adminAssignedByOwner:true});
  const page=f.vip.listIntents(f.actor('viewer'),'m001',{limit:1}); assert.equal(page.items.length,1); assert.equal(page.nextCursor,null);
  f.ir.put('accounts',{...viewer,roleId:'member',adminAssignedByOwner:false,permissionVersion:viewer.permissionVersion+1});
  assert.throws(() => f.vip.listIntents(f.actor('viewer'),'m001'),code('ACCESS_DENIED'));
});

test('controlled failure after original admission rolls back the entire period savepoint', async t => {
  const f = await setup(t), original = f.notifications.service.createBusinessIntent.bind(f.notifications.service);
  f.notifications.service.createBusinessIntent = plan => { original(plan); throw new IdentityError('ISOLATED_AUTH_DRIFT', 409); };
  await queued(f); assert.equal(f.observations()[0].reason, 'ISOLATED_AUTH_DRIFT'); assert.equal(f.deliveries().length, 0);
  assert.equal(rows(f, 'v2_vip_notification_events'), 0); assert.equal(f.notifications.service.repo.all('consumedEvents').length, 0);
});

test('SQLite persistence failure rolls back page checkpoint, immutable event, receipt and core delivery together', async t => {
  const f = await setup(t);
  f.db.exec("CREATE TRIGGER fixture_scan_failure BEFORE INSERT ON v2_vip_notification_scan BEGIN SELECT RAISE(ABORT,'isolated scan failure'); END;");
  await assert.rejects(queued(f), /isolated scan failure/); assert.equal(f.vip.scanState(), null); assert.equal(f.deliveries().length, 0);
  assert.equal(f.observations().length, 0); assert.equal(rows(f, 'v2_vip_notification_events'), 0);
  f.db.exec('DROP TRIGGER fixture_scan_failure'); await queued(f); assert.equal(f.deliveries().length, 1);
  assert.throws(() => f.db.exec("UPDATE v2_vip_notification_events SET event_hash='bad'"), /immutable/);
});

test('expiry-window closure before execution cannot send a stale reminder', async t => {
  const f = await setup(t); await queued(f); f.advance(6 * 3600000); await f.refreshProofs(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.deliveries()[0].lastErrorCode, 'VIP_WINDOW_CLOSED');
});

test('stop aborts in-flight original worker and drains/rejects all additional scan admission', async t => {
  const f = await setup(t); await queued(f); let arrived;
  const reached = new Promise(r => { arrived = r; });
  f.fault = async ({ res }) => { arrived(); await new Promise(r => res.on('close', r)); return true; };
  const run = f.run(); await reached; await f.vip.stop(); await run;
  assert.equal(f.deliveries()[0].status, 'delivery_unknown'); assert.throws(() => f.vip.tick(), code('VIP_NOTIFICATION_STOPPED'));
  assert.equal((await f.run()).claimed, 0);
});

test('child process dies during real native HTTP; reopened original SQLite lease becomes unknown with no automatic send', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vip-notification-crash-')), filename = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = `import {fixture} from ${JSON.stringify(new URL('./support/v2-vip-notifications/fixture.mjs', import.meta.url).href)};
    const f=await fixture({filename:process.argv[1]});await f.setVip();await f.vip.tick({limit:1});f.fault=async()=>{process.exit(23);};await f.run();`;
  const child = spawnSync(process.execPath, ['--import', new URL('./support/v2-stats/resolve.mjs', import.meta.url).href,
    '--import', new URL('./support/v2-baseline/loopback-only.mjs', import.meta.url).href, '--input-type=module', '-e', script, filename],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' } });
  assert.equal(child.status, 23, child.stderr);
  const db = new DatabaseSync(filename);
  const attempt = JSON.parse(db.prepare("SELECT payload_json FROM json_records WHERE collection='v2NotificationAttempts'").get().payload_json);
  assert.equal(attempt.status, 'requesting'); db.close();
  const f = await fixture({ filename }); t.after(() => f.close()); await f.setVip(); f.advance(2000); await f.refreshProofs();
  assert.equal((await f.notifications.worker.recoverExpired({ workerId: 'reopened' })).unknown, 1);
  await f.scan(); await f.run(); assert.equal(f.deliveries().length, 1); assert.equal(f.deliveries()[0].status, 'delivery_unknown'); assert.equal(f.calls.length, 0);
});

test('unknown without an observed message id performs no native lookup and remains unknown', async t => {
  const f = await setup(t); await queued(f); f.fault = async ({ res }) => { res.status(503).json({ uncertain: true }); return true; };
  await f.run(); const d = f.deliveries()[0];
  f.notifications.service.commandDelivery(f.actor('admin'), d.id, 'reconcile', { expectedRevision: d.revision,
    decision: 'request_lookup', reason: '查明是否投递' }, { operationId: randomUUID() });
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.deliveries()[0].status, 'delivery_unknown');
  assert.ok(f.notifications.service.repo.all('messageOperations').some(o => o.lastErrorCode === 'LOOKUP_UNSUPPORTED'));
});

test('original worker native GET reconciles a constructed recovery row with a previously observed DM reference', async t => {
  const f = await setup(t); await queued(f); await f.drain();
  const service = f.notifications.service, repo = service.repo, sent = f.deliveries()[0], ref = repo.all('messageRefs')[0];
  // Construct the durable recovery case: known observed ref, delivery outcome unresolved.
  // This is not a public API for attaching arbitrary refs and does not create a second sender.
  repo.transaction(() => repo.put('deliveries', { ...sent, status: 'delivery_unknown', knownNotSent: false, revision: sent.revision + 1 }));
  f.ir.put('accounts', { ...f.ir.get('accounts', 'viewer'), roleId:'admin', adminAssignedByOwner:true });
  const d = f.deliveries()[0], actor = f.actor('viewer');
  service.commandDelivery(actor, d.id, 'reconcile', { expectedRevision: d.revision, decision: 'request_lookup', reason: '已观察主键的恢复核实' }, { operationId: randomUUID() });
  await f.drain(); assert.equal(f.deliveries()[0].status, 'sent');
  assert.equal(f.calls.filter(c => c.method === 'GET' && c.path.endsWith('/' + ref.messageId)).length, 1);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1); assert.equal(f.deliveries()[0].attemptCount, 1);
});

test('partially scanned SQLite reopens at committed cursor and only scans remaining members', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vip-scan-reopen-')), filename = join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = await fixture({ filename }); await first.setVip(); const initial = await first.vip.tick({ limit: 7 });
  assert.equal(initial.cursor, 'm007'); await first.close();
  const f = await fixture({ filename }); t.after(() => f.close()); await f.setVip();
  const next = await f.vip.tick({ limit: 7 }); assert.equal(next.cursor, 'm014'); assert.equal(next.generation, initial.generation);
  assert.equal(next.scanned, 7); assert.equal(f.deliveries().length, 1); await f.drain(); assert.equal(f.deliveries()[0].status, 'sent');
});

test('preferred language comes from original Discord application and remains within the six actual languages', async t => {
  const f = await setup(t); f.ir.put('applications', { id: 'constructed-language', discordUserId: f.externalId, discordLocale: 'zh-TW' });
  await queued(f); await f.drain(); assert.equal(f.deliveries()[0].language, 'zh-CN');
  assert.match(f.calls[0].body.embeds[0].description, /<t:1915113600:F>/);
});

test('legacy attempted period is fenced durably even after its bounded operation history is trimmed', async t => {
  const f = await setup(t); f.members.repo.put('operationRuns', { id: 'constructed-legacy-unknown', type: 'discord_vital_vip_reminder',
    status: 'failed', retryable: true, dedupeKey: 'discord:vital-vip-reminder:m001:2030-09-08',
    metadata: { externalActionSucceeded: true, trackingWriteFailed: true } });
  await f.scan(); assert.equal(f.observations()[0].reason, 'VIP_LEGACY_ATTEMPT_UNRESOLVED');
  f.db.prepare("DELETE FROM json_records WHERE collection='operationRuns' AND id=?").run('constructed-legacy-unknown');
  f.advance(3600000); await f.refreshProofs(); await f.scan();
  assert.equal(f.observations()[0].reason, 'VIP_LEGACY_ATTEMPT_UNRESOLVED'); assert.equal(f.deliveries().length, 0);
});
