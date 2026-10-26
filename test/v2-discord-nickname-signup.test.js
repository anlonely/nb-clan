import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './support/v2-notifications/fixture.js';
import { nativeEnvelopes } from './support/v2-notification-platforms/native-envelopes.mjs';
import { createNotificationSystem } from '../server/v2/notifications/index.js';
import { createNotificationCallbackHandler, createNotificationPlatforms, renderNotification, listNotificationTemplates } from '../server/v2/notification-platforms/index.js';
import { createIsolatedNotificationTransport } from '../server/v2/notification-platforms/isolated-transport.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { MemberAdminService } from '../server/v2/member-admin/service.js';
import { createNotificationRuntime } from '../server/v2/notification-runtime/index.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';

const guildId = '100000000000000001';
const channelId = '300000000000000001';
const discordId = '200000000000000099';
const identityKinds = ['accounts', 'members', 'identities', 'bindings', 'sessions'];
const identityRows = f => Object.fromEntries(identityKinds.map(kind => [kind, f.identity.repo.all(kind)]));
const registrations = f => f.system.service.repo.all('discordSignups');
const receipts = f => f.system.service.repo.all('discordSignupReceipts');
const privateReply = f => f.transport.getPrivateReplies().at(-1)?.payload;
const workerTick = f => { f.clock.advance(1); return f.runtime ? f.runtime.tick() : f.system.worker.runOnce({ workerId: 'discord-nickname-signup-test', limit: 20 }); };
const appliedSnapshot = f => {
  const ref = f.system.service.repo.all('messageRefs').find(row => row.messageId === f.messageId);
  return f.system.service.repo.get('messageOperations', ref.lastMessageOperationId).snapshot;
};

async function setup(t, { signupMode = 'discord_only', useRuntime = false } = {}) {
  const f = createFixture({ adminRole: true, renderer: renderNotification, templates: listNotificationTemplates() });
  f.catalog.setTarget('discord-1', { guildId, channelId, signupMode });
  f.transport = createIsolatedNotificationTransport({ now: () => f.clock.now });
  f.platforms = createNotificationPlatforms({ transport: f.transport, now: () => f.clock.now });
  f.system.service.platforms = f.platforms;
  f.native = nativeEnvelopes({ now: () => f.clock.now });
  if (useRuntime) {
    f.runtime = createNotificationRuntime({ getIdentity: async () => f.identity, catalog: f.catalog,
      transport: f.transport, verifiers: f.native.verifiers, publicOrigin: 'http://127.0.0.1:4319', now: () => f.clock.now });
    f.system = f.runtime.getSystem(f.identity);
  }
  f.acks = [];
  f.io = { ack: async value => { f.acks.push(value); } };
  f.makeHandler = () => createNotificationCallbackHandler({ platform: 'discord', identity: f.identity, scheduling: f.scheduling,
    verify: f.native.verifiers.discord, resolveActionReference: f.system.references.resolve, transport: f.transport,
    publicOrigin: 'http://127.0.0.1:4319', now: () => f.clock.now,
    submitDiscordSignup: verified => f.system.service.submitDiscordSignup(verified) });
  f.envelope = (action, { nickname = 'Guest Rust Player', externalId = discordId, ...extra } = {}) => f.native.discord(f.token(action), {
    externalId, locale: 'en-US', guild_id: guildId, channel_id: channelId,
    member: { nick: nickname, user: { id: externalId, username: 'guest_username', global_name: 'Guest Global Name' } },
    message: { id: f.messageId }, ...extra
  });
  f.token = action => {
    const message = f.transport.getMessages().find(item => item.messageId === f.messageId);
    for (const button of message?.payload.components?.flatMap(row => row.components) || []) {
      if (!button.custom_id) continue;
      const reference = f.system.references.resolve(button.custom_id, { platform: 'discord', guildId, channelId });
      if (reference.action === action) return button.custom_id;
    }
    assert.fail(`Published original card does not contain ${action}`);
  };
  const preview = f.system.service.createPreview(f.actor(), f.wipe.id, f.input({
    targets: [{ targetId: 'discord-1', language: 'en', mentionMode: 'none', roleIds: [] }]
  }), f.operation('nickname-preview')).current;
  const intent = f.system.service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id, contentHash: preview.contentHash,
    expectedContentRevision: preview.contentRevision, purpose: preview.purpose, purposeInstance: preview.purposeInstance
  }, f.operation('nickname-publish')).current;
  f.deliveryId = intent.deliveryIds[0];
  await workerTick(f); await workerTick(f);
  assert.equal(f.system.service.repo.get('deliveries', f.deliveryId).status, 'sent');
  f.messageId = f.transport.getMessages()[0].messageId;
  f.handler = f.makeHandler();
  t.after(async () => { await f.runtime?.stop(); await f.system.worker.stop(); f.close(); });
  return f;
}

function assertNoPublicResend(f) {
  const messages = f.transport.getMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, f.messageId);
  assert.equal(f.transport.getCalls().filter(call => call.operation === 'send').length, 1);
  return messages[0];
}

test('signed Discord nickname signup records an unbound user without creating a website or Steam identity', async t => {
  const f = await setup(t), before = identityRows(f);
  await f.handler(f.envelope('attending_on_time'), f.io);
  assert.deepEqual(f.acks.at(-1), { type: 5, data: { flags: 64 } });
  const rows = registrations(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].guildId, guildId);
  assert.equal(rows[0].discordId, discordId);
  assert.equal(rows[0].name, 'Guest Rust Player');
  assert.equal(rows[0].response, 'attending_on_time');
  assert.equal(f.scheduling.repo.all('signups').length, 0);
  assert.deepEqual(identityRows(f), before);
  assert.match(privateReply(f).content, /saved/i);
  assert.equal(privateReply(f).components.some(row => row.components.some(button => button.url?.includes('/api/v2/auth/discord/start'))), false);
});

test('authenticated retries retain one registration and durable receipt after notification owner reconstruction', async t => {
  const f = await setup(t), envelope = f.envelope('attending_on_time');
  await f.handler(envelope, f.io);
  const first = structuredClone(registrations(f));
  assert.equal(receipts(f).length, 1);
  await f.handler(envelope, f.io);
  assert.deepEqual(registrations(f), first);
  assert.equal(receipts(f).length, 1);
  await f.system.worker.stop();
  f.system = createNotificationSystem({ identity: f.identity, scheduling: f.scheduling, catalog: f.catalog,
    renderer: renderNotification, templates: listNotificationTemplates(), platforms: f.platforms,
    publicOrigin: 'http://127.0.0.1:4319', now: () => f.clock.now, options: { runtimeMode: 'isolated' } });
  f.handler = f.makeHandler();
  await f.handler(envelope, f.io);
  assert.deepEqual(registrations(f), first);
  assert.equal(receipts(f).length, 1);
  assert.match(privateReply(f).content, /receipt|retrieved|already/i);
  assertNoPublicResend(f);
});

test('each attendance button directly updates the same Discord registration and exact late arrival time', async t => {
  const f = await setup(t);
  const choices = [
    { action: 'attending_on_time', response: 'attending_on_time', arrival: null },
    { action: 'join_8h', response: 'attending_later', arrival: '2030-09-08T19:00:00.000Z' },
    { action: 'join_16h', response: 'attending_later', arrival: '2030-09-09T03:00:00.000Z' },
    { action: 'not_attending', response: 'not_attending', arrival: null },
  ];
  let registrationId;
  for (const [index, choice] of choices.entries()) {
    await f.handler(f.envelope(choice.action), f.io);
    const rows = registrations(f);
    assert.equal(rows.length, 1);
    registrationId ||= rows[0].id;
    assert.equal(rows[0].id, registrationId);
    assert.equal(rows[0].response, choice.response);
    assert.equal(rows[0].expectedArrivalAt, choice.arrival);
    assert.equal(receipts(f).length, index + 1);
    assert.equal(privateReply(f).components.flatMap(row => row.components).some(button => button.custom_id?.startsWith('nbconfirm:')), false);
  }
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

test('nickname changes and counts edit the original signup message without leaking private member rows or mentions', async t => {
  const f = await setup(t);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Unbound Rust Mate' }), f.io);
  await workerTick(f);
  let message = assertNoPublicResend(f);
  assert.match(JSON.stringify(message.payload), /Unbound Rust Mate/);
  assert.equal(JSON.stringify(message.payload).includes('Private member'), false);
  let snapshot = appliedSnapshot(f);
  assert.equal(snapshot.signupMode, 'discord_only');
  assert.equal(snapshot.counts.onTime, 1);
  assert.equal(snapshot.counts.responseTotal, 1);
  await f.handler(f.envelope('not_attending', { nickname: 'Updated Rust Mate' }), f.io);
  await workerTick(f);
  message = assertNoPublicResend(f);
  assert.match(JSON.stringify(message.payload), /Updated Rust Mate/);
  assert.equal(JSON.stringify(message.payload).includes('Unbound Rust Mate'), false);
  snapshot = appliedSnapshot(f);
  assert.equal(snapshot.counts.onTime, 0);
  assert.equal(snapshot.counts.notAttending, 1);
  assert.deepEqual(message.payload.allowed_mentions.parse, []);
});

test('changing to Steam mode uses the existing account-binding prompt and does not write nickname attendance', async t => {
  const f = await setup(t);
  f.catalog.setTarget('discord-1', { signupMode: 'member_required', configurationRevision: 2 });
  await workerTick(f);
  await f.handler(f.envelope('attending_on_time'), f.io);
  assert.equal(registrations(f).length, 0);
  assert.equal(receipts(f).length, 0);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
  const reply = privateReply(f);
  assert.ok(reply.components.flatMap(row => row.components).some(button => button.url?.includes('/api/v2/auth/discord/start')));
});

for (const denied of ['closed', 'stale', 'wrong guild', 'wrong channel', 'disabled target']) {
  test(`signed ${denied} interaction cannot write Discord attendance`, async t => {
    const f = await setup(t);
    let envelope = f.envelope('attending_on_time');
    const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
    if (denied === 'closed') f.scheduling.repo.put('wipes', { ...wipe, signupWindow: 'closed', revision: wipe.revision + 1 });
    if (denied === 'stale') f.scheduling.repo.put('wipes', { ...wipe, contentRevision: wipe.contentRevision + 1, revision: wipe.revision + 1 });
    if (denied === 'wrong guild') envelope = f.envelope('attending_on_time', { guild_id: '100000000000000002' });
    if (denied === 'wrong channel') envelope = f.envelope('attending_on_time', { channel_id: '300000000000000002' });
    if (denied === 'disabled target') f.catalog.setTarget('discord-1', { enabled: false });
    const before = identityRows(f);
    await f.handler(envelope, f.io);
    assert.equal(registrations(f).length, 0);
    assert.equal(receipts(f).length, 0);
    assert.deepEqual(identityRows(f), before);
    assert.equal(f.scheduling.repo.all('signups').length, 0);
    assert.match(privateReply(f).content, /not saved|not submit|reference|closed|unable|could not process/i);
  });
}

test('tampered native request is rejected before HTTP acknowledgement and cannot create nickname records', async t => {
  const f = await setup(t), envelope = f.envelope('attending_on_time');
  const tampered = { ...envelope, rawBody: Buffer.from(envelope.rawBody) };
  tampered.rawBody[tampered.rawBody.length - 1] ^= 1;
  await assert.rejects(f.handler(tampered, f.io), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  assert.equal(f.acks.length, 0);
  assert.equal(registrations(f).length, 0);
  assert.equal(receipts(f).length, 0);
});

for (const [description, user, expected] of [
  ['global display name', { id: discordId, username: 'Fallback Username', global_name: 'Fallback Global Name' }, 'Fallback Global Name'],
  ['username', { id: discordId, username: 'Fallback Username' }, 'Fallback Username'],
]) {
  test(`signed Discord signup falls back to the ${description} when the server nickname is absent`, async t => {
    const f = await setup(t);
    await f.handler(f.envelope('attending_on_time', { member: { user } }), f.io);
    assert.equal(registrations(f).length, 1);
    assert.equal(registrations(f)[0].name, expected);
  });
}

test('a new click for the same attendance keeps a single unchanged row and separate interaction receipts', async t => {
  const f = await setup(t);
  await f.handler(f.envelope('attending_on_time'), f.io);
  const first = structuredClone(registrations(f));
  await f.handler(f.envelope('attending_on_time'), f.io);
  assert.deepEqual(registrations(f), first);
  assert.equal(receipts(f).length, 2);
  await workerTick(f);
  assertNoPublicResend(f);
});

test('stored Discord nickname renders safely in the original public card without generating mentions', async t => {
  const f = await setup(t), nickname = '@everyone <@200000000000000008>';
  await f.handler(f.envelope('attending_on_time', { nickname }), f.io);
  assert.equal(registrations(f)[0].name, nickname);
  await workerTick(f);
  const message = assertNoPublicResend(f), content = JSON.stringify(message.payload);
  assert.equal(content.includes('@everyone'), false);
  assert.equal(content.includes('<@200000000000000008>'), false);
  assert.deepEqual(message.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
});

function linkDiscordMember(f, memberId = 'm1') {
  f.identity.repo.put('identities', { id: 'linked-member-discord', provider: 'discord', externalId: discordId,
    accountId: `a-${memberId}`, revision: 1 });
  f.identity.repo.put('policies', { id: 'test-discord-policy', provider: 'discord', enabled: true, guildId,
    allowedRoleIds: ['verified-role'], matchMode: 'any', policyRevision: 1 });
  f.identity.repo.put('eligibility', { id: 'test-discord-eligibility', provider: 'discord', externalId: discordId,
    policyId: 'test-discord-policy', policyRevision: 1, guildId, status: 'eligible',
    checkedAt: new Date(f.clock.now).toISOString(), expiresAt: new Date(f.clock.now + 300000).toISOString() });
  assert.equal(Object.hasOwn(f.identity.repo.get('members', memberId), 'discordId'), false);
}

test('Discord-only mode keeps linked website attendance separate even when the member row has no Discord ID', async t => {
  const f = await setup(t);
  linkDiscordMember(f);
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation('web-first'));
  f.clock.advance(1000);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Linked Discord Nickname' }), f.io);
  await workerTick(f);
  const snapshot = appliedSnapshot(f);
  assert.equal(snapshot.counts.responseTotal, 1);
  assert.equal(snapshot.counts.onTime, 1);
  assert.equal(snapshot.counts.eligibleTotal, 1);
  assert.equal(snapshot.attendanceRows.length, 1);
  assert.equal(snapshot.attendanceRows[0].name, 'Linked Discord Nickname');
  assert.equal(snapshot.attendanceRows[0].discordId, discordId);
  assertNoPublicResend(f);
});

test('suspending a previously registered linked member hides attendance on the original card and rejects new clicks', async t => {
  const f = await setup(t);
  linkDiscordMember(f);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Suspended Nickname' }), f.io);
  await workerTick(f);
  assert.equal(appliedSnapshot(f).counts.onTime, 1);
  const previousRevision=appliedSnapshot(f).rosterRevision;
  installMemberAdminSchema(f.db);
  const members = new MemberAdminService(f.identity), member = f.identity.repo.get('members', 'm1');
  members.status(f.actor(), member.id, { expectedRevision: member.revision || 1, status: 'suspended',
    reason: 'Isolated test member suspension' }, f.operation('suspend-linked-member').operationId);
  await workerTick(f);
  const snapshot = appliedSnapshot(f), message = assertNoPublicResend(f);
  assert.equal(snapshot.counts.onTime, 0);
  assert.equal(snapshot.counts.responseTotal, 0);
  assert.equal(snapshot.attendanceRows.length, 0);
  assert.ok(snapshot.rosterRevision>=previousRevision);
  assert.equal(JSON.stringify(message.payload).includes('Suspended Nickname'), false);
  assert.equal(registrations(f).length, 1);
  const before = structuredClone(registrations(f)), receiptCount = receipts(f).length;
  await f.handler(f.envelope('not_attending'), f.io);
  assert.deepEqual(registrations(f), before);
  assert.equal(receipts(f).length, receiptCount);
  assert.match(privateReply(f).content, /MEMBERSHIP_INACTIVE|ACCESS_RESTRICTED|ACCOUNT_DISABLED/);
});

test('a later website signup never replaces Discord-only attendance and both saved rosters remain independent', async t => {
  const f = await setup(t);
  linkDiscordMember(f);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Cross-platform Nickname' }), f.io);
  await workerTick(f);
  f.clock.advance(1000);
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup({ response: 'not_attending' }),
    { ...f.operation('web-newer'), source: 'web' });
  await workerTick(f);
  let snapshot = appliedSnapshot(f);
  assert.equal(snapshot.counts.responseTotal, 1);
  assert.equal(snapshot.counts.onTime, 1);
  assert.equal(snapshot.counts.notAttending, 0);
  assert.equal(snapshot.attendanceRows.length, 1);
  assert.equal(snapshot.attendanceRows[0].name, 'Cross-platform Nickname');
  assert.equal(snapshot.attendanceRows[0].response, 'attending_on_time');
  assert.equal(f.scheduling.repo.all('signups')[0].response, 'not_attending');
  assertNoPublicResend(f);
  f.clock.advance(1000);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Cross-platform Nickname' }), f.io);
  await workerTick(f);
  snapshot = appliedSnapshot(f);
  assert.equal(snapshot.counts.responseTotal, 1);
  assert.equal(snapshot.counts.onTime, 1);
  assert.equal(snapshot.counts.notAttending, 0);
});

test('real notification runtime injects nickname registration into its signed native callback without account linking', async t => {
  const f = await setup(t, { useRuntime: true }), before = identityRows(f);
  assert.equal(f.runtime.getSystem(f.identity), f.system);
  assert.equal(f.runtime.getScheduling(f.identity), f.system.service.scheduling);
  const delivery = f.system.service.repo.get('deliveries', f.deliveryId);
  assert.equal(f.system.service.repo.get('intents', delivery.intentId).purpose, 'signup_open');
  const token = f.token('attending_on_time');
  assert.equal(f.system.references.resolve(token, { platform: 'discord', guildId, channelId }).targetId, 'discord-1');
  await f.runtime.handleCallback('discord', f.envelope('attending_on_time', { nickname: 'Runtime Unbound Player' }), f.io);
  assert.deepEqual(f.acks.at(-1), { type: 5, data: { flags: 64 } });
  assert.equal(registrations(f).length, 1);
  assert.equal(registrations(f)[0].name, 'Runtime Unbound Player');
  assert.equal(registrations(f)[0].response, 'attending_on_time');
  assert.deepEqual(identityRows(f), before);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
  assert.equal(f.runtime.diagnostics().completedCallbacks, 1);
  assert.equal(f.runtime.diagnostics().failedCallbacks, 0);
  await workerTick(f);
  const message = assertNoPublicResend(f);
  assert.match(JSON.stringify(message.payload), /Runtime Unbound Player/);
  assert.equal(appliedSnapshot(f).counts.onTime, 1);
});

test('KOOK signup preview keeps website attendance and never includes Discord guest registrations', async t => {
  const f = await setup(t);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Discord Only Guest' }), f.io);
  const preview = f.system.service.createPreview(f.actor(), f.wipe.id,
    f.input({ targets: [{ targetId: 'kook-1', language: 'zh-CN', mentionMode: 'none', roleIds: [] }] }),
    f.operation('kook-guest-isolation')).current;
  const target = f.system.service.repo.get('previews', preview.id).targets[0];
  assert.equal(target.target.platform, 'kook');
  assert.equal(target.snapshot.counts.onTime, 0);
  assert.equal(target.snapshot.counts.responseTotal, 0);
  assert.equal(target.snapshot.counts.eligibleTotal, 2);
  assert.equal(JSON.stringify(target.payload).includes('Discord Only Guest'), false);
  assert.equal(registrations(f).length, 1);
});

test('switching the original card to Steam and back hides then restores nickname attendance without losing records', async t => {
  const f = await setup(t);
  await f.handler(f.envelope('attending_on_time', { nickname: 'Restored Guest Nickname' }), f.io);
  await workerTick(f);
  const saved = structuredClone(registrations(f));
  f.catalog.setTarget('discord-1', { signupMode: 'member_required', configurationRevision: 2 });
  await workerTick(f);
  let snapshot = appliedSnapshot(f), message = assertNoPublicResend(f);
  assert.equal(snapshot.signupMode, 'member_required');
  assert.equal(snapshot.counts.onTime, 0);
  assert.equal(snapshot.counts.responseTotal, 0);
  assert.equal(JSON.stringify(message.payload).includes('Restored Guest Nickname'), false);
  assert.deepEqual(registrations(f), saved);
  f.catalog.setTarget('discord-1', { signupMode: 'discord_only', configurationRevision: 3 });
  await workerTick(f);
  snapshot = appliedSnapshot(f); message = assertNoPublicResend(f);
  assert.equal(snapshot.signupMode, 'discord_only');
  assert.equal(snapshot.counts.onTime, 1);
  assert.equal(snapshot.counts.responseTotal, 1);
  assert.match(JSON.stringify(message.payload), /Restored Guest Nickname/);
  assert.deepEqual(registrations(f), saved);
});

test('Discord-only mode identifies profiles by signed Discord ID without merging distinct users through website aliases', async t => {
  const f = await setup(t), aliasId = '200000000000000088';
  linkDiscordMember(f);
  const member = f.identity.repo.get('members', 'm1'), account = f.identity.repo.get('accounts', 'a-m1');
  f.identity.repo.put('members', { ...member, discordId, discordUserId: aliasId });
  const legacy = { id: 'legacy-discord-user', boundSteamId: member.steamId,
    discordId, discordUserId: aliasId, loginProviders: { discord: { id: aliasId } } };
  f.identity.repo.put('users', legacy);
  f.identity.repo.put('accounts', { ...account, legacyUserId: legacy.id,
    legacyFingerprint: legacyFingerprint(legacy, f.identity.repo.all('permissionRoles')) });
  await f.handler(f.envelope('attending_on_time', { nickname: 'OAuth Nickname' }), f.io);
  f.clock.advance(1000);
  await f.handler(f.envelope('not_attending', { externalId: aliasId, nickname: 'Legacy Alias Nickname' }), f.io);
  await workerTick(f);
  const snapshot = appliedSnapshot(f), message = assertNoPublicResend(f);
  assert.equal(registrations(f).length, 2);
  assert.equal(snapshot.counts.eligibleTotal, 2);
  assert.equal(snapshot.counts.responseTotal, 2);
  assert.equal(snapshot.counts.onTime, 1);
  assert.equal(snapshot.counts.notAttending, 1);
  assert.equal(snapshot.attendanceRows.length, 2);
  assert.ok(snapshot.attendanceRows.some(row=>row.name==='Legacy Alias Nickname'&&row.discordId===aliasId));
  assert.ok(snapshot.attendanceRows.some(row=>row.name==='OAuth Nickname'&&row.discordId===discordId));
  assert.match(JSON.stringify(message.payload), /discord.com\/users\/200000000000000088/);
});

test('a same-status click updates the latest signed Discord nickname and only edits the original card', async t => {
  const f = await setup(t);
  await f.handler(f.envelope('attending_on_time', {nickname:'First nickname'}), f.io);
  await workerTick(f);
  await f.handler(f.envelope('attending_on_time', {nickname:'Current nickname'}), f.io);
  assert.equal(registrations(f).length,1);
  assert.equal(registrations(f)[0].name,'Current nickname');
  assert.equal(registrations(f)[0].signupRevision,2);
  await workerTick(f);
  const message=assertNoPublicResend(f);
  assert.match(JSON.stringify(message.payload),/Current nickname/);
  assert.doesNotMatch(JSON.stringify(message.payload),/First nickname/);
  assert.match(JSON.stringify(message.payload),/No Steam link required/);
  const names=f.db.prepare("SELECT DISTINCT collection FROM json_records WHERE collection LIKE 'v2Discord%'").all().map(row=>row.collection);
  assert.ok(names.includes('v2DiscordWipeSignups'));
  assert.ok(names.includes('v2DiscordWipeSignupReceipts'));
  assert.ok(!names.includes('v2DiscordSignups'));
  assert.ok(!names.includes('v2DiscordSignupReceipts'));
});

test('Discord-only saved responses use the signed invoking locale in all six supported languages', async t => {
 for(const [locale,saved] of [['en-US','Response saved.'],['zh-TW','回复已保存。'],['ru','Ответ сохранён.'],
  ['tr','Yanıt kaydedildi.'],['th','บันทึกคำตอบแล้ว'],['ko','응답이 저장되었습니다.']]){
  const f=await setup(t);
  await f.handler(f.envelope('attending_on_time',{locale,guild_locale:'en-US'}),f.io);
  assert.ok(privateReply(f).content.startsWith(saved));
  assert.equal(privateReply(f).components.length,0);
  assert.equal(registrations(f).length,1);
  assert.deepEqual(privateReply(f).allowed_mentions.parse,[]);
 }
});
