import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture } from './support/v2-notifications/fixture.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { NotificationRepository } from '../server/v2/notifications/repository.js';
import { createRetainedInteractions } from '../server/v2/management-adapters/platforms/retained.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';

async function fixture(t, signupMode = 'discord_only', filename = ':memory:', publishToBase = false) {
  const f = createFixture({ adminRole: true, filename }); t.after(() => f.close());
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config = { enabled: true, revision: 1, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), applicationId: 'app-one',
    commands: [{ id: 'wipe', type: 'event_command', slashCommand: 'wipe-react', enabled: true, signupMode }],
    targets: [{ id: 'discord-1', guildId: 'fixture-discord', channelId: 'general', signupCardChannelId: 'signup', name: 'Discord server', enabled: true, enabledCommandIds: ['wipe'] }] };
  const requests = [], acks = [], state = { editStatus: 200 };
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity, getPlatformService: () => ({ identity: f.identity,
    config: platform => platform === 'discord' ? config : { enabled: false, revision: 1, commands: [], targets: [] } }),
    publicOrigin: 'https://nb.example', now: () => f.clock.now, readCredentials: () => ({ botToken: 'constructed-secret' }),
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body); requests.push({ url, method: options.method, payload });
      const status = options.method === 'PATCH' && url.includes('/channels/') ? state.editStatus : 200;
      const channelId = url.includes('/channels/') ? new URL(url).pathname.split('/')[4] : 'signup';
      return new Response(JSON.stringify({ id: 'original-message', channel_id: channelId }), { status });
    } });
  t.after(() => owner.stop());
  const system = owner.getSystem(f.identity), service = system.service;
  const target = owner.catalog.listTargets().find(row => row.channelId === (publishToBase ? 'general' : 'signup'));
  const preview = service.createPreview(f.actor(), f.wipe.id, f.input({ targets: [{ targetId: target.id, language: 'en', mentionMode: 'none', roleIds: [] }] }), f.operation()).current;
  const savedPreview = service.repo.get('previews', preview.id);
  service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id, contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
    purpose: preview.purpose, purposeInstance: preview.purposeInstance }, f.operation());
  await system.worker.runOnce({ workerId: 'mode-fixture', limit: 1 });
  assert.equal(service.repo.all('deliveries')[0].status, 'sent');
  const actionToken = (payload, index = 0) => payload.components[0].components[index].custom_id;
  const envelope = (token, interactionId, overrides = {}) => {
    const event = { type: 3, id: interactionId, application_id: 'app-one', token: 'constructed-private-token', guild_id: 'fixture-discord', channel_id: 'signup',
      member: { nick: 'Signed Discord user', user: { id: '200000000000000099', username: 'signed-user' } }, data: { component_type: 2, custom_id: token }, ...overrides };
    const rawBody = Buffer.from(JSON.stringify(event)), timestamp = String(f.clock.now / 1000);
    return { rawBody, headers: { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex') } };
  };
  const click = (token, interactionId, overrides) => owner.handleCallback('discord', envelope(token, interactionId, overrides), { ack: payload => acks.push(payload) });
  return { f, config, owner, system, service, target, requests, acks, state, preview: savedPreview, click, actionToken, envelope };
}

test('one wipe-react command projects the dedicated signup channel while preserving the original general target', async t => {
  const x = await fixture(t);
  assert.equal(x.owner.catalog.getTarget('discord-1').channelId, 'general');
  assert.equal(x.target.signupMode, 'discord_only');
  assert.equal(x.target.channelId, 'signup');
  assert.equal(x.config.commands.length, 1);
  assert.ok(!x.preview.targets[0].payload.components.flatMap(row => row.components).some(button => button.url?.includes('/auth/discord/start')));
  assert.equal(x.preview.targets[0].snapshot.attendanceRows.length, 0);
});

test('signed unbound Discord attendance persists independently and refreshes the exact original card with clickable profiles', async t => {
  const x = await fixture(t), { f, service } = x;
  const before = Object.fromEntries(['members', 'accounts', 'bindings', 'identities'].map(name => [name, f.identity.repo.all(name)]));
  const token = x.actionToken(x.preview.targets[0].payload);
  await x.click(token, 'guest-attend');
  assert.deepEqual(x.acks[0], { type: 5, data: { flags: 64 } });
  const rows = service.repo.all('discordSignups');
  assert.equal(rows.length, 1); assert.equal(rows[0].discordId, '200000000000000099');
  assert.equal(rows[0].name, 'Signed Discord user'); assert.equal(rows[0].response, 'attending_on_time');
  for (const [name, records] of Object.entries(before)) assert.deepEqual(f.identity.repo.all(name), records);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
  assert.match(x.requests.at(-1).payload.content, /Response saved/);
  await x.click(token, 'guest-attend');
  assert.equal(service.repo.all('discordSignups')[0].signupRevision, 1);
  assert.equal(service.repo.all('discordSignupReceipts').length, 1);
  await x.system.worker.runOnce({ workerId: 'mode-edit-fixture', limit: 1 });
  const edit = x.requests.find(request => request.method === 'PATCH' && request.url.includes('/channels/signup/messages/original-message'));
  assert.ok(edit); assert.match(JSON.stringify(edit.payload), /https:\/\/discord.com\/users\/200000000000000099/);
  assert.match(JSON.stringify(edit.payload), /Signed Discord user/);
  assert.deepEqual(edit.payload.allowed_mentions.parse, []);
  assert.equal(x.requests.filter(request => request.method === 'POST' && request.url.includes('/channels/')).length, 1);
  assert.equal(service.repo.all('messageRefs')[0].messageId, 'original-message');
  assert.equal(service.repo.all('messageOperations')[0].status, 'succeeded');
  // Drained scheduling events cannot mask a missing attendance-triggered refresh.
  const editCount = x.requests.filter(request => request.method === 'PATCH' && request.url.includes('/channels/')).length;
  const freshToken = x.actionToken(edit.payload, 1);
  await x.click(freshToken, 'guest-late');
  assert.equal(service.repo.all('discordSignups')[0].expectedArrivalAt, '2030-09-08T19:00:00.000Z');
  assert.equal(service.repo.all('discordSignups')[0].signupRevision, 2);
  await x.system.worker.runOnce({ workerId: 'second-guest-change', limit: 1 });
  assert.equal(x.requests.filter(request => request.method === 'PATCH' && request.url.includes('/channels/')).length, editCount + 1);
});

test('member-required rejects the same unbound Discord user and shows Steam registration', async t => {
  const x = await fixture(t, 'member_required');
  assert.ok(x.preview.targets[0].payload.components.flatMap(row => row.components).some(button => button.url?.includes('/auth/discord/start')));
  await x.click(x.actionToken(x.preview.targets[0].payload), 'unbound-member-mode');
  assert.equal(x.service.repo.all('discordSignups').length, 0);
  assert.match(x.requests.at(-1).payload.content, /complete member registration/);
  assert.ok(x.requests.at(-1).payload.components[0].components[0].url.includes('/auth/discord/start'));
});

test('saving either mode automatically refreshes the original card, preserves attendance and invalidates earlier actions', async t => {
  const x = await fixture(t), token = x.actionToken(x.preview.targets[0].payload);
  await x.click(token, 'mode-before-switch');
  x.config.commands[0].signupMode = 'member_required'; x.config.revision++;
  await x.click(token, 'mode-after-switch');
  assert.equal(x.service.repo.all('discordSignups')[0].signupRevision, 1);
  assert.equal(x.service.repo.all('discordSignupReceipts').length, 1);
  await x.system.worker.runOnce({ workerId: 'mode-switch-edit', limit: 1 });
  const edit = x.requests.find(request => request.method === 'PATCH' && request.url.includes('/channels/'));
  assert.ok(edit.payload.components.flatMap(row => row.components).some(button => button.url?.includes('/auth/discord/start')));
  assert.ok(!JSON.stringify(edit.payload).includes('Signed Discord user'));
  await x.click(x.actionToken(edit.payload), 'mode-after-refresh');
  assert.match(x.requests.at(-1).payload.content, /complete member registration/);
  assert.equal(x.service.repo.all('discordSignups').length, 1);
  x.config.commands[0].signupMode = 'discord_only'; x.config.revision++;
  await x.system.worker.runOnce({ workerId: 'mode-switch-back', limit: 1 });
  assert.ok(x.service.repo.all('messageOperations').every(row => row.status === 'succeeded'), JSON.stringify(x.service.repo.all('messageOperations').map(row => ({ status: row.status, error: row.lastErrorCode }))));
  assert.equal(x.requests.filter(request => request.method === 'PATCH' && request.url.includes('/channels/')).length, 2);
  const guestEdit = x.requests.filter(request => request.method === 'PATCH' && request.url.includes('/channels/')).at(-1);
  assert.match(JSON.stringify(guestEdit.payload), /Signed Discord user/);
  assert.ok(!guestEdit.payload.components.flatMap(row => row.components).some(button => button.url?.includes('/auth/discord/start')));
  const beforeIdle = x.requests.length;
  await x.system.worker.runOnce({ workerId: 'mode-config-no-repeat', limit: 10 });
  assert.equal(x.requests.length, beforeIdle);
  await x.click(x.actionToken(guestEdit.payload), 'mode-after-switch-back');
  assert.match(x.requests.at(-1).payload.content, /Response saved/);
});

test('wrong channel, forged signature, closed wipe and reused interaction with changed action cannot save Discord attendance', async t => {
  const x = await fixture(t), token = x.actionToken(x.preview.targets[0].payload);
  await assert.rejects(x.click(token, 'foreign-channel', { channel_id: 'foreign' }), error => error.errorCode === 'PRIVATE_RESPONSE_UNKNOWN');
  assert.equal(x.service.repo.all('discordSignups').length, 0);
  const forged = x.envelope(token, 'forged'); forged.headers['x-signature-ed25519'] = '0'.repeat(128);
  await assert.rejects(x.owner.handleCallback('discord', forged, { ack() { assert.fail('forged ACK'); } }));
  await x.click(token, 'guest-first');
  // Service rechecks the persistent operation digest even after verifier restart.
  assert.throws(() => x.service.submitDiscordSignup({ externalId: '200000000000000099', interactionId: 'guest-first', guildId: 'fixture-discord', channelId: 'signup',
    actionReference: x.actionToken(x.preview.targets[0].payload, 3) }), error => error.errorCode === 'IDEMPOTENCY_CONFLICT');
  const wipe = x.f.scheduling.wipe(x.f.wipe.id);
  x.f.scheduling.transition(x.f.actor(), wipe.id, 'close-signup', { expectedRevision: wipe.revision, reason: 'Fixture closed' }, x.f.operation());
  await x.click(token, 'closed-wipe');
  assert.equal(x.service.repo.all('discordSignups')[0].signupRevision, 1);
  assert.match(x.requests.at(-1).payload.content, /SIGNUP_CLOSED/);
});

test('Discord-only signup and original interaction receipt survive closing and reopening SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-discord-signup-')), filename = join(directory, 'signup.sqlite');
  try {
    const x = await fixture(t, 'discord_only', filename);
    await x.click(x.actionToken(x.preview.targets[0].payload), 'persisted-discord-signup');
    await x.owner.stop(); x.f.close();
    const db = new DatabaseSync(filename);
    try {
      const repo = new NotificationRepository(db);
      assert.equal(repo.all('discordSignups')[0].discordId, '200000000000000099');
      assert.equal(repo.all('discordSignupReceipts')[0].operationReceipt.operationId, 'discord:persisted-discord-signup');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM json_records WHERE collection='v2Signups'").get().count, 0);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unknown mode-refresh outcome retains the original card and never creates repeated edits or replacement sends', async t => {
  const x = await fixture(t);
  await x.system.worker.runOnce({ workerId: 'drain-original-events', limit: 10 });
  x.config.commands[0].signupMode = 'member_required'; x.config.revision++; x.state.editStatus = 503;
  await x.system.worker.runOnce({ workerId: 'unknown-mode-edit', limit: 10 });
  assert.equal(x.service.repo.all('messageOperations').filter(row => row.status === 'unknown').length, 1);
  const before = x.requests.length;
  await x.system.worker.runOnce({ workerId: 'unknown-no-resend', limit: 10 });
  assert.equal(x.requests.length, before);
  assert.equal(x.requests.filter(request => request.method === 'POST' && request.url.includes('/channels/')).length, 1);
  assert.equal(x.service.repo.all('messageRefs')[0].messageId, 'original-message');
});

test('a schedule change rejects earlier signed guest choices until the original card has refreshed', async t => {
  const x = await fixture(t), token = x.actionToken(x.preview.targets[0].payload);
  const wipe = x.f.scheduling.wipe(x.f.wipe.id);
  x.f.scheduling.updateWipe(x.f.actor(), wipe.id, { expectedRevision: wipe.revision, musterAt: '2030-09-08T12:30:00Z' }, x.f.operation());
  await x.click(token, 'stale-schedule-choice');
  assert.equal(x.service.repo.all('discordSignups').length, 0);
  assert.match(x.requests.at(-1).payload.content, /CONTENT_RECONFIRM_REQUIRED/);
  await x.system.worker.runOnce({ workerId: 'schedule-refreshed', limit: 10 });
  const edit = x.requests.filter(request => request.method === 'PATCH' && request.url.includes('/channels/')).at(-1);
  await x.click(x.actionToken(edit.payload), 'fresh-schedule-choice');
  assert.equal(x.service.repo.all('discordSignups')[0].confirmedContentRevision, 2);
});

test('adding the dedicated signup projection retrieves an existing base-channel card instead of sending a duplicate', async t => {
  const x = await fixture(t, 'discord_only', ':memory:', true);
  installPlatformAdminSchema(x.f.db);
  const retained = createRetainedInteractions({ identity: x.f.identity, scheduling: x.f.scheduling, notifications: x.service,
    cards: {}, runStoreWriteTask: fn => fn(), now: () => x.f.clock.now });
  const args = { actor: x.f.actor(), input: { command: 'wipe_card', wipeId: x.f.wipe.id, mentionEveryone: false }, target: x.config.targets[0],
    source: 'discord', operationId: 'retained-dedup', assertCurrent() {} };
  const before = x.service.repo.all('intents').length;
  const result = await retained.wipe(args);
  assert.equal(result.state, 'succeeded');
  assert.equal(x.service.repo.all('intents').length, before);
  assert.equal(retained.receipt({ ...args, previous: result }).reference, result.reference);
  assert.equal(x.requests.filter(request => request.method === 'POST' && request.url.includes('/channels/')).length, 1);
});

test('a lost mode-switch edit can reconcile its exact payload without lowering the roster revision or repeating a refresh', async t => {
  const x = await fixture(t);
  await x.click(x.actionToken(x.preview.targets[0].payload), 'guest-before-unknown-switch');
  await x.system.worker.runOnce({ workerId: 'guest-before-mode-switch', limit: 10 });
  const original = x.service.repo.all('messageRefs')[0];
  x.config.commands[0].signupMode = 'member_required'; x.config.revision++; x.state.editStatus = 503;
  await x.system.worker.runOnce({ workerId: 'mode-switch-uncertain', limit: 10 });
  const delivery = x.service.repo.all('deliveries')[0];
  const op = x.service.getDelivery(x.f.actor(), delivery.id).messageOperations.find(row => row.status === 'unknown');
  assert.ok(op); assert.ok(op.snapshot.rosterRevision >= original.rosterRevision);
  x.service.reconcileEditOperation(x.f.actor(), op.id, { expectedRevision: op.revision, expectedExecutionEpoch: op.executionEpoch,
    expectedStateFingerprint: op.stateFingerprint, messageRefId: op.reference.id, expectedReferenceFingerprint: op.referenceFingerprint,
    expectedPayloadHash: op.payloadHash, decision: 'confirmed_updated', reason: 'Fixture exact message readback',
    evidence: 'Fixture provider readback matched original-message and the exact requested payload.' }, x.f.operation());
  assert.equal(x.service.repo.all('messageRefs')[0].configurationRevision, x.config.revision);
  const before = x.requests.length;
  await x.system.worker.runOnce({ workerId: 'reconciled-mode-no-repeat', limit: 10 });
  assert.equal(x.requests.length, before);
  assert.equal(x.service.repo.all('messageRefs')[0].messageId, original.messageId);
});

test('Discord-only mode respects a paused linked member while allowing a truly unregistered guild user', async t => {
  const x = await fixture(t), token = x.actionToken(x.preview.targets[0].payload);
  x.f.identity.repo.put('identities', { id: 'paused-discord-user', provider: 'discord', externalId: '200000000000000099', accountId: 'a-m1', revision: 1 });
  const member = x.f.identity.repo.get('members', 'm1');
  x.f.identity.repo.put('members', { ...member, memberStatus: 'paused' });
  await x.click(token, 'paused-discord-choice');
  assert.match(x.requests.at(-1).payload.content, /MEMBERSHIP_INACTIVE/);
  assert.equal(x.service.repo.all('discordSignups').length, 0);
  await x.click(token, 'unregistered-discord-choice', { member: { nick: 'Unregistered guild user', user: { id: '200000000000000088' } } });
  assert.equal(x.service.repo.all('discordSignups')[0].discordId, '200000000000000088');
  assert.equal(x.f.identity.repo.all('members').length, 4);
});
