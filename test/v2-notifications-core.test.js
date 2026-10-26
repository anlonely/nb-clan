// Frozen scope-engine unit contract; the explicit fake is separate from real fixed-role integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationSystem } from '../server/v2/notifications/index.js';
import { grant } from '../server/v2/identity/permissions.js';
import { createFixture, fixtureHash, fixtureRenderer } from './support/v2-notifications/fixture.js';

function fixture(t, options) { const f = createFixture({ ...options }); t.after(() => f.close()); return f; }
const hasCode = expected => error => error?.errorCode === expected;
const rejectsCode = (run, code) => assert.rejects(async () => run(), hasCode(code));
const selection = (targetId, extra = {}) => ({ targetId, language: 'zh-CN', mentionMode: 'none', roleIds: [], ...extra });
const intentInput = preview => ({ previewId: preview.id, contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
  purpose: preview.purpose, purposeInstance: preview.purposeInstance });
const rows = f => f.db.prepare("SELECT collection,id,payload_json FROM json_records WHERE collection LIKE 'v2Notification%' ORDER BY collection,id").all();
const previews = async (f, input = f.input(), operation = f.operation()) =>
  f.system.service.createPreview(f.actor(), f.wipe.id, input, operation);
const accept = async (f, preview, operation = f.operation()) =>
  f.system.service.createIntent(f.actor(), f.wipe.id, intentInput(preview), operation);
function factoryArgs(f) {
  return { identity: f.identity, scheduling: f.scheduling, catalog: f.catalog, renderer: f.renderer, templates: f.templates,
    platforms: f.platforms, publicOrigin: 'http://127.0.0.1:4319', now: () => f.clock.now,
    options: { runtimeMode: 'isolated', previewTtlMs: 600_000, leaseMs: 30_000, maxAttempts: 5 } };
}
function collectActionReferences(value, found = []) {
  if (value && typeof value === 'object') {
    if (['attending_on_time', 'attending_later', 'not_attending'].includes(value.action) && typeof value.token === 'string') found.push(value);
    for (const child of Object.values(value)) collectActionReferences(child, found);
  }
  return found;
}

test('notification factory and GET operations never migrate, dispatch or change stored notification state', async t => {
  const f = fixture(t), before = rows(f);
  const another = createNotificationSystem(factoryArgs(f));
  const options = await another.service.getOptions(f.actor(), f.wipe.id);
  assert.equal(options.targets.length, 2);
  assert.deepEqual(await another.service.listIntents(f.actor(), f.wipe.id, {}), { items: [], nextCursor: null });
  assert.deepEqual(rows(f), before); assert.equal(f.transport.calls.length, 0);
  f.db.prepare('DELETE FROM json_scalars WHERE key=?').run('v2NotificationSchemaVersion');
  assert.throws(() => createNotificationSystem(factoryArgs(f)), hasCode('NOTIFICATION_SETUP_REQUIRED'));
  assert.equal(f.db.prepare('SELECT payload_json FROM json_scalars WHERE key=?').get('v2NotificationSchemaVersion'), undefined);
});

test('factory requires the same G03/G04 SQLite and explicit completed migration markers', t => {
  const f = fixture(t), other = fixture(t);
  assert.throws(() => createNotificationSystem({ ...factoryArgs(f), scheduling: other.scheduling }), hasCode('NOTIFICATION_SETUP_REQUIRED'));
  f.db.prepare('DELETE FROM json_scalars WHERE key=?').run('v2IdentityMigration');
  assert.throws(() => createNotificationSystem(factoryArgs(f)), hasCode('NOTIFICATION_SETUP_REQUIRED'));
});

test('preview normalizes target order and duplicate roles before operation idempotency', async t => {
  const f = fixture(t), operation = f.operation('preview-normalized');
  const original = f.input({ targets: [selection('kook-1'), selection('discord-1', { mentionMode: 'roles', roleIds: ['role-2', 'role-1', 'role-2'] })] });
  const normalized = f.input({ targets: [selection('discord-1', { mentionMode: 'roles', roleIds: ['role-1', 'role-2'] }), selection('kook-1')] });
  const first = await previews(f, original, operation), replay = await previews(f, normalized, operation);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.operationReceipt, first.operationReceipt);
  assert.deepEqual(replay.current, first.current);
  assert.deepEqual(first.current.targets.find(t => t.selection.targetId === 'discord-1').selection.roleIds, ['role-1', 'role-2']);
  assert.equal(f.transport.calls.length, 0);
  await rejectsCode(() => previews(f, f.input({ purpose: 'reminder' }), operation), 'IDEMPOTENCY_CONFLICT');
});

test('preview stores a complete private payload but ordinary DTOs expose only authorized rendered content', async t => {
  const f = fixture(t), preview = (await previews(f)).current;
  const visible = JSON.stringify(preview);
  assert.equal(typeof preview.targets[0].rendered.countScope, 'string');
  assert.ok(preview.targets[0].rendered.countScope.length > 0);
  assert.ok(preview.targets[0].payloadHash.match(/^[a-f0-9]{64}$/));
  for (const secret of ['transportKey', 'fixture-steam-', 'Private member', 'fixtureProtocol', 'actionRefs', 'leaseOwner']) assert.equal(visible.includes(secret), false);
  const persisted = rows(f).map(row => JSON.parse(row.payload_json));
  assert.ok(JSON.stringify(persisted).includes('fixtureProtocol'));
  const refs = collectActionReferences(persisted);
  assert.ok(refs.length >= 3);
  for (const ref of refs) assert.equal(visible.includes(ref.token), false);
  assert.equal(preview.targets[0].rendered.actions.at(-1).url,
    `http://127.0.0.1:4319/app/wipes/${encodeURIComponent(f.wipe.id)}?tab=plan#signup`);
});

test('preview-only and accepted-but-unsent references cannot authorize signup callbacks', async t => {
  const f = fixture(t), preview = (await previews(f)).current;
  const reference = collectActionReferences(rows(f).map(row => JSON.parse(row.payload_json)))[0];
  assert.ok(reference?.token);
  const target = f.catalog.getTarget('discord-1');
  const scope = { platform: target.platform, guildId: target.guildId, channelId: target.channelId };
  await rejectsCode(() => f.system.references.resolve(reference.token, scope), 'RESOURCE_NOT_FOUND');
  await accept(f, preview);
  await rejectsCode(() => f.system.references.resolve(reference.token, scope), 'RESOURCE_NOT_FOUND');
  await f.system.worker.runOnce({ workerId: 'core-ref', limit: 20 });
  const resolved = await f.system.references.resolve(reference.token, scope);
  assert.equal(resolved.wipeId, f.wipe.id); assert.equal(resolved.contentRevision, f.wipe.contentRevision);
  assert.equal(resolved.targetId, target.id);
  await rejectsCode(() => f.system.references.resolve(reference.token, { ...scope, channelId: 'wrong-channel' }), 'RESOURCE_NOT_FOUND');
  await rejectsCode(() => f.system.references.resolve(reference.token, { ...scope, guildId: null }), 'RESOURCE_NOT_FOUND');
});

test('addendum-01 permits KOOK null guild only for the confirmed exact channel and unchanged bound target', async t => {
  const f = fixture(t), preview = (await previews(f, f.input({ targets: [selection('kook-1')] }))).current;
  const reference = collectActionReferences(rows(f).map(row => JSON.parse(row.payload_json)))[0];
  const target = f.catalog.getTarget('kook-1');
  const scope = { platform: 'kook', guildId: null, channelId: target.channelId };
  await rejectsCode(() => f.system.references.resolve(reference.token, scope), 'RESOURCE_NOT_FOUND');
  await accept(f, preview);
  await rejectsCode(() => f.system.references.resolve(reference.token, scope), 'RESOURCE_NOT_FOUND');
  await f.system.worker.runOnce({ workerId: 'core-kook-reference' });
  assert.equal((await f.system.references.resolve(reference.token, scope)).targetId, 'kook-1');
  for (const wrong of [
    { ...scope, channelId: 'different-channel' }, { ...scope, channelId: '' }, { ...scope, channelId: null },
    { ...scope, platform: 'discord' }, { ...scope, platform: 'unknown' },
    { ...scope, guildId: '' }, { ...scope, guildId: 'different-guild' }, { ...scope, guildId: undefined }
  ]) await rejectsCode(() => f.system.references.resolve(reference.token, wrong), 'RESOURCE_NOT_FOUND');
  f.catalog.setTarget('kook-1', { guildId: 'different-guild', configurationRevision: 2 });
  await rejectsCode(() => f.system.references.resolve(reference.token, scope), 'RESOURCE_NOT_FOUND');
  f.catalog.setTarget('kook-1', { guildId: target.guildId, channelId: 'different-channel', configurationRevision: 3 });
  await rejectsCode(() => f.system.references.resolve(reference.token, scope), 'RESOURCE_NOT_FOUND');
});

test('acceptance persists one intent, each target, the original payload and a stable receipt before dispatch', async t => {
  const f = fixture(t), preview = (await previews(f, f.input({ targets: [selection('discord-1'), selection('kook-1')] }))).current;
  const accepted = await accept(f, preview), detail = await f.system.service.getIntent(f.actor(), accepted.current.id, {});
  assert.equal(f.actor().memberId, null); assert.equal(accepted.current.status, 'queued');
  assert.equal(accepted.current.counts.total, 2); assert.equal(accepted.current.counts.queued, 2); assert.equal(accepted.current.counts.sent, 0);
  assert.equal(detail.deliveries.length, 2);
  assert.ok(detail.deliveries.every(delivery => delivery.status === 'queued' && delivery.attemptCount === 0 && delivery.messageRefs.length === 0));
  assert.equal(f.transport.calls.length, 0);
  const fresh = createNotificationSystem(factoryArgs(f));
  const recovered = await fresh.service.getOperation(f.actor(), accepted.operationReceipt.operationId);
  assert.deepEqual(recovered.operationReceipt, accepted.operationReceipt); assert.equal(recovered.current.id, accepted.current.id);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

test('SQLite failures roll preview references and multi-target acceptance back with receipts and changes', async t => {
  const f = fixture(t), initial = rows(f);
  f.db.exec("CREATE TRIGGER fixture_reject_preview_receipt BEFORE INSERT ON json_records WHEN NEW.collection='v2NotificationReceipts' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;");
  await assert.rejects(async () => previews(f), /fixture receipt failure/);
  assert.deepEqual(rows(f), initial);
  f.db.exec('DROP TRIGGER fixture_reject_preview_receipt');
  const preview = (await previews(f, f.input({ targets: [selection('discord-1'), selection('kook-1')] }))).current;
  const beforeAcceptance = rows(f);
  f.db.exec("CREATE TRIGGER fixture_reject_second_delivery BEFORE INSERT ON json_records WHEN NEW.collection='v2NotificationDeliveries' AND json_extract(NEW.payload_json,'$.targetId')='kook-1' BEGIN SELECT RAISE(ABORT,'fixture second-target failure'); END;");
  await assert.rejects(async () => accept(f, preview), /fixture second-target failure/);
  assert.deepEqual(rows(f), beforeAcceptance);
  assert.equal((await f.system.service.listIntents(f.actor(), f.wipe.id, {})).items.length, 0);
  assert.equal(f.transport.calls.length, 0);
});

test('same business snapshot under different previews and operation keys creates only one send intention', async t => {
  const f = fixture(t), firstPreview = (await previews(f)).current, secondPreview = (await previews(f)).current;
  const first = await accept(f, firstPreview), second = await accept(f, secondPreview);
  assert.equal(second.current.id, first.current.id); assert.equal(second.replayed, true);
  assert.notEqual(first.operationReceipt.operationId, second.operationReceipt.operationId);
  assert.equal((await f.system.service.listIntents(f.actor(), f.wipe.id, {})).items.length, 1);
  await f.system.worker.runOnce({ workerId: 'core-idempotency' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});

test('expired preview can be read via receipt but cannot create a new intent', async t => {
  const f = fixture(t), operation = f.operation(), first = await previews(f, f.input(), operation);
  f.clock.advance(600_001);
  const replay = await previews(f, f.input(), operation);
  assert.equal(replay.current.id, first.current.id); assert.equal(replay.replayed, true);
  await rejectsCode(() => accept(f, first.current), 'PREVIEW_EXPIRED');
  assert.equal(f.transport.calls.length, 0);
});

test('an accepted operation replays after preview expiry without creating another intent or dispatch', async t => {
  const f = fixture(t), preview = (await previews(f)).current, operation = f.operation();
  const first = await accept(f, preview, operation); f.clock.advance(600_001);
  const replay = await accept(f, preview, operation);
  assert.equal(replay.current.id, first.current.id); assert.deepEqual(replay.operationReceipt, first.operationReceipt);
  assert.equal(replay.replayed, true); assert.equal(f.transport.calls.length, 0);
});

test('changing displayed wipe fields, target revision or audience invalidates an unaccepted preview', async t => {
  for (const kind of ['title', 'target', 'audience']) {
    const f = fixture(t), preview = (await previews(f)).current;
    if (kind === 'target') f.catalog.setTarget('discord-1', { configurationRevision: 2 });
    else f.scheduling.updateWipe(f.actor(), f.wipe.id, { expectedRevision: f.wipe.revision,
      ...(kind === 'title' ? { title: '更改过的预览标题' } : { audience: { squadIds: [], memberIds: ['m1'], includeUnassigned: false } }) }, f.operation());
    await rejectsCode(() => accept(f, preview), 'PREVIEW_STALE'); assert.equal(f.transport.calls.length, 0);
  }
});

test('accepted payload remains its preview snapshot when only signup counts change before first send', async t => {
  const f = fixture(t), preview = (await previews(f)).current, accepted = await accept(f, preview);
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation('member-signup'));
  await f.system.worker.runOnce({ workerId: 'core-roster' });
  const send = f.transport.calls.find(call => call.operation === 'send');
  assert.ok(send); assert.equal(send.payloadHash, preview.targets[0].payloadHash);
  assert.equal(send.payload.rendered.fields.find(field => field.label === '统计快照').value,
    preview.targets[0].rendered.fields.find(field => field.label === '统计快照').value);
  const current = await f.system.service.getIntent(f.actor(), accepted.current.id, {});
  assert.equal(current.deliveries[0].status, 'sent');
});

test('[scope-engine] current send grant is rechecked before accepting or replaying an intent', async t => {
  const f = fixture(t, { scopeContract: true }), preview = (await previews(f)).current, operation = f.operation();
  await accept(f, preview, operation);
  const account = f.identity.repo.get('accounts', 'admin');
  f.identity.repo.put('accounts', { ...account, grants: [...account.grants,
    grant('notifications.send', { type: 'platformTargets', ids: ['discord-1'] }, { effect: 'deny' })] });
  await rejectsCode(() => accept(f, preview, operation), 'ACCESS_DENIED');
  await rejectsCode(() => accept(f, preview), 'ACCESS_DENIED');
  assert.equal(f.transport.calls.length, 0);
});

test('[scope-engine] explicit target deny defeats all grants and provider aliases', async t => {
  const f = fixture(t, { scopeContract: true }), account = f.identity.repo.get('accounts', 'admin');
  f.identity.repo.put('accounts', { ...account, grants: [...account.grants,
    grant('notifications.preview', { type: 'platformTargets', ids: ['discord'] }),
    grant('notifications.preview', { type: 'platformTargets', ids: ['discord-1'] }, { effect: 'deny' })] });
  await rejectsCode(() => previews(f), 'ACCESS_DENIED');
  const options = await f.system.service.getOptions(f.actor(), f.wipe.id);
  assert.deepEqual(options.targets.map(target => target.id), ['kook-1']);
});

test('[scope-engine] public intent and delivery listings recalculate the current authorized target subset', async t => {
  const f = fixture(t, { scopeContract: true }), preview = (await previews(f, f.input({ targets: [selection('discord-1'), selection('kook-1')] }))).current;
  const accepted = await accept(f, preview), detail = await f.system.service.getIntent(f.actor('limited'), accepted.current.id, {});
  assert.equal(detail.deliveries.length, 1); assert.equal(detail.deliveries[0].targetId, 'discord-1');
  assert.equal(detail.intent.countScope, 'authorized_targets'); assert.equal(detail.intent.counts.total, 1);
  assert.deepEqual(detail.intent.deliveryIds, detail.deliveries.map(delivery => delivery.id));
  const all = await f.system.service.getIntent(f.actor(), accepted.current.id, {});
  const hidden = all.deliveries.find(delivery => delivery.targetId === 'kook-1');
  await rejectsCode(() => f.system.service.getDelivery(f.actor('limited'), hidden.id), 'RESOURCE_NOT_FOUND');
});

test('[scope-engine] audience expansion and audience rows beyond the current signup read grant are rejected', async t => {
  const f = fixture(t, { scopeContract: true });
  await rejectsCode(() => previews(f, f.input({ audience: { squadIds: ['sq2'], memberIds: [], includeUnassigned: false } })), 'NOTIFICATION_AUDIENCE_DENIED');
  await rejectsCode(() => previews(f, f.input({ audience: { squadIds: ['sq1'], memberIds: ['m3'], includeUnassigned: false } })), 'NOTIFICATION_AUDIENCE_DENIED');
  await rejectsCode(() => previews(f, f.input({ audience: { squadIds: ['sq1'], memberIds: [], includeUnassigned: true } })), 'NOTIFICATION_AUDIENCE_DENIED');
  const account = f.identity.repo.get('accounts', 'admin');
  f.identity.repo.put('accounts', { ...account, grants: account.grants.filter(g => g.capability !== 'signups.read') });
  await rejectsCode(() => previews(f), 'NOTIFICATION_AUDIENCE_DENIED');
});

test('language, template revision, mention allowlist and schedule are validated before preview persistence', async t => {
  const f = fixture(t), before = rows(f);
  for (const [overrides, code] of [
    [{ targets: [selection('discord-1', { language: 'ja' })] }, 'LANGUAGE_UNSUPPORTED'],
    [{ templateId: 'unknown-template' }, 'TEMPLATE_UNSUPPORTED'],
    [{ templateRevision: 2 }, 'TEMPLATE_REVISION_UNSUPPORTED'],
    [{ targets: [selection('discord-1', { roleIds: ['role-1'] })] }, 'MENTION_INVALID'],
    [{ targets: [selection('discord-1', { mentionMode: 'roles', roleIds: ['unknown-role'] })] }, 'MENTION_INVALID'],
    [{ schedule: { dueAt: '2030-09-08T09:00:00Z', expiresAt: '2030-09-08T12:00:00Z' } }, 'SCHEDULE_INVALID'],
    [{ schedule: { dueAt: '2030-09-08T12:00:00Z', expiresAt: '2030-09-08T11:00:00Z' } }, 'SCHEDULE_INVALID']
  ]) await rejectsCode(() => previews(f, f.input(overrides)), code);
  assert.deepEqual(rows(f), before); assert.equal(f.transport.calls.length, 0);
});

test('[scope-engine] disabled targets and removed mention permission are rechecked after a preview exists', async t => {
  const f = fixture(t, { scopeContract: true }), roleInput = f.input({ targets: [selection('discord-1', { mentionMode: 'roles', roleIds: ['role-1'] })] });
  const preview = (await previews(f, roleInput)).current;
  const account = f.identity.repo.get('accounts', 'admin');
  f.identity.repo.put('accounts', { ...account, grants: account.grants.filter(g => g.capability !== 'notifications.mention_role') });
  await rejectsCode(() => accept(f, preview), 'ACCESS_DENIED');
  f.identity.repo.put('accounts', account); f.catalog.setTarget('discord-1', { enabled: false });
  await assert.rejects(async () => accept(f, preview), error => ['TARGET_INVALID', 'PREVIEW_STALE'].includes(error?.errorCode));
  assert.equal(f.transport.calls.length, 0);
});

test('notification creation and completion never invent a member signup; signup persistence never dispatches', async t => {
  const f = fixture(t), initial = f.scheduling.repo.all('signups');
  const preview = (await previews(f)).current; await accept(f, preview);
  assert.deepEqual(f.scheduling.repo.all('signups'), initial);
  await f.system.worker.runOnce({ workerId: 'core-separation' });
  assert.deepEqual(f.scheduling.repo.all('signups'), initial);
  const callCount = f.transport.calls.length;
  const signup = f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation());
  assert.equal(signup.current.response, 'attending_on_time'); assert.equal(f.transport.calls.length, callCount);
  assert.equal(f.scheduling.repo.all('signups').length, 1);
  assert.ok(f.scheduling.repo.all('outbox').some(event => event.type === 'signup.changed' || event.kind === 'signup.changed'));
});

test('deterministic renderer substitute hashes the exact stored payload and has no hidden dependencies', () => {
  const input = { schemaVersion: 1, templateId: 'wipe-notification', templateRevision: 1, purpose: 'signup_open',
    target: { platform: 'discord' }, selection: selection('discord-1'),
    snapshot: { title: 'fixture', description: 'text', serverLabel: 'local', musterAt: null, signupClosesAt: null,
      lifecycle: 'scheduled', effectiveSignupWindow: 'open', counts: { attending: 1 }, countScope: 'authorized_audience',
      evaluatedAt: '2030-09-08T10:00:00.000Z', memberUrl: 'http://127.0.0.1:4319/app/wipes/fixture?tab=plan#signup' },
    actionRefs: [{ action: 'attending_on_time', token: 'fixture-reference' }], mode: 'send' };
  const original = structuredClone(input), first = fixtureRenderer(input), second = fixtureRenderer(input);
  assert.deepEqual(first, second); assert.deepEqual(input, original); assert.equal(first.payloadHash, fixtureHash(first.payload));
  const edited = fixtureRenderer({ ...input, mode: 'edit', selection: selection('discord-1', { mentionMode: 'everyone' }) });
  assert.equal(edited.payload.selection.mentionMode, 'none'); assert.deepEqual(edited.payload.selection.roleIds, []);
});
