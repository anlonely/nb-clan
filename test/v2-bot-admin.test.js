// Frozen scope-engine unit contract: this file explicitly opts into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-platform-admin/fixture.mjs';
import { seedOpenSignup } from './support/v2-platform-admin/bot-fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';
import { managementSections } from '../server/v2/member-space/management-sections.js';
import { MemberSpaceService } from '../server/v2/member-space/service.js';

const setup = t => { const f = fixture({scopeContract:true}); t.after(() => f.close()); return f; };
const op = () => ({ operationId: randomUUID() });
const save = (f, section, config, options = op(), expectedRevision = f.service.config('discord').revision) =>
  f.service.save(f.actor(), 'discord', { configSection: section, expectedRevision, config }, options);

test('section saves isolate connection, identities, commands, server bindings and automation with revision fencing', t => {
  const f = setup(t), before = structuredClone(f.service.config('discord'));
  save(f, 'automation', { autoWipeCards: true });
  save(f, 'connection', { enabled: false });
  assert.deepEqual(f.service.config('discord').targets, before.targets);
  assert.deepEqual(f.service.config('discord').commands, before.commands);
  assert.equal(f.service.config('discord').autoWipeCards, true);
  assert.throws(() => save(f, 'servers', { targets: before.targets }, op(), before.revision), /REVISION_CONFLICT/);
  for (const [section, config] of [['connection', { commands: [] }], ['features', { autoWipeCards: false }],
    ['automation', { targets: [] }], ['unknown', { enabled: true }], ['identity', {}]])
    assert.throws(() => save(f, section, config), /PLATFORM_CONFIG_SECTION_INVALID/);
  assert.equal(f.transport.getCalls().length, 0);
});

test('feature removal cleans only the removed binding and replay never overwrites a later server edit', t => {
  const f = setup(t), current = f.service.config('discord'), originalTarget = { ...current.targets[0],
    signupCardChannelId: '1482399564274204774', newwipeAllowedRoleIds: ['1167000000000000000'], enabledCommandIds: ['map', 'ranking'] };
  save(f, 'servers', { targets: [originalTarget] });
  const expectedRevision = f.service.config('discord').revision, options = op(), config = { commands: current.commands.filter(row => row.id !== 'map') };
  const result = save(f, 'features', config, options, expectedRevision);
  assert.deepEqual(result.current.targets[0], { ...originalTarget, enabledCommandIds: ['ranking'] });
  save(f, 'servers', { targets: [{ ...result.current.targets[0], channelId: '1482399564274204775' }] });
  const replay = save(f, 'features', config, options, expectedRevision);
  assert.equal(replay.current.targets[0].channelId, '1482399564274204775');
  assert.equal(replay.revision, result.revision);
});

test('section config cannot bypass identity mapping, platform or KOOK feature restrictions', t => {
  const f = setup(t);
  assert.throws(() => save(f, 'identity', { roleSystemMappings: [{ id: 'root-map', guildId: '100000000000000001',
    roleId: '1167000000000000000', roleName: 'admin', systemRole: 'admin' }] }), /ROOT_REQUIRED/);
  assert.throws(() => f.service.save(f.actor('alpha'), 'discord', { configSection: 'automation', expectedRevision: 1,
    config: { autoWipeCards: true } }, op()), /ACCESS_DENIED/);
  assert.throws(() => f.service.save(f.actor(), 'kook', { configSection: 'features', expectedRevision: 1,
    config: { commands: [{ id: 'newwipe', type: 'event_command', slashCommand: 'newwipe', enabled: true }] } }, op()), /NEWWIPE_CONFIG_INVALID/);
});

test('open signup reads retain complete Discord-only attendees and three states without writes or sensitive fields', t => {
  const f = setup(t), { card } = seedOpenSignup(f), before = f.db.prepare('SELECT total_changes() AS n').get().n;
  f.db.exec('PRAGMA query_only=ON');
  const listed = f.service.openSignups(f.actor(), {}), detail = f.service.openSignup(f.actor(), card.id), roster = f.service.openSignupRoster(f.actor(), card.id, {});
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items[0].counts, { accepted: 1, declined: 1, late: 1, total: 3 });
  assert.equal(detail.publication.status, 'published');
  assert.equal(detail.publication.messageUrl, `https://discord.com/channels/${card.guildId}/${card.channelId}/1559929737403568278`);
  assert.equal(detail.creator.discordId, card.creator.externalId);
  assert.equal(detail.resolvedIp.command, 'client.connect 168.100.161.200:28014');
  assert.equal(roster.items.find(row => row.response === 'late').originalResponse, 'late_8h');
  assert.equal(f.repo.all('identities').some(row => row.externalId === roster.items[0].discordId), false);
  for (const value of ['DO_NOT_EXPOSE', 'publicToken', 'discordPermissions', 'secret-role', 'publisher', 'binding', 'payload'])
    assert.equal(JSON.stringify({ listed, detail, roster }).includes(value), false);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(f.transport.getCalls().length, 0);
  f.db.exec('PRAGMA query_only=OFF');
});

test('platform read and all explicit target/guild denies constrain lists, counts, filters, details and rosters', t => {
  const f = setup(t), { card } = seedOpenSignup(f);
  // Production currently resolves fixed role grants. Exercise the read-model
  // boundary with a controlled scoped authority, without changing that resolver
  // or treating dormant legacy account grants as production permissions.
  const resolve = f.identity.actorForAccount.bind(f.identity);
  f.identity.actorForAccount = id => {
    const actor = resolve(id);
    return id === 'g05_account_leader' ? { ...actor, grants: f.repo.get('accounts', id).grants } : actor;
  };
  seedOpenSignup(f, { id: 'foreign', guildId: '1153571748147634237', baseTargetId: 'foreign-target', serverId: '20', serverName: 'Hidden game server' });
  assert.throws(() => f.service.openSignups(f.actor('alpha'), {}), /ACCESS_DENIED/);
  const a = f.repo.get('accounts', 'g05_account_leader');
  a.grants.push(grant('platforms.read', { type: 'platformTargets', ids: ['discord'] }));
  f.repo.put('accounts', a);
  assert.equal(f.service.openSignups(f.actor('leader'), {}).total, 2);
  a.grants.push({ ...grant('platforms.read', { type: 'platformTargets', ids: ['foreign-target'] }), effect: 'deny' });
  f.repo.put('accounts', a);
  const scoped = f.service.openSignups(f.actor('leader'), {});
  assert.equal(scoped.total, 1); assert.equal(scoped.filters.guilds.length, 1); assert.equal(scoped.filters.servers.length, 1);
  assert.equal(JSON.stringify(scoped).includes('Hidden game server'), false);
  assert.equal(f.service.openSignups(f.actor('leader'), { q: 'Hidden' }).total, 0);
  assert.throws(() => f.service.openSignup(f.actor('leader'), 'foreign'), /RESOURCE_NOT_FOUND/);
  assert.throws(() => f.service.openSignupRoster(f.actor('leader'), 'foreign', { q: 'Discord' }), /RESOURCE_NOT_FOUND/);
  for (const id of [card.baseTargetId, card.targetId, card.guildId]) {
    const updated = { ...a, grants: [...a.grants, { ...grant('platforms.read', { type: 'platformTargets', ids: [id] }), effect: 'deny' }] };
    f.repo.put('accounts', updated);
    assert.equal(f.service.openSignups(f.actor('leader'), {}).total, 0);
    assert.throws(() => f.service.openSignup(f.actor('leader'), card.id), /RESOURCE_NOT_FOUND/);
  }
  f.repo.put('accounts', { ...a, grants: [...a.grants, { ...grant('platforms.read', { type: 'platformTargets', ids: ['discord'] }), effect: 'deny' }] });
  assert.throws(() => f.service.openSignup(f.actor('leader'), card.id), /ACCESS_DENIED/);
});

test('publication and latest edit outcomes are separate and mismatched message references never claim success', t => {
  const f = setup(t), seeded = seedOpenSignup(f), { card, put, resource } = seeded;
  put('v2NotificationMessageOperations', { id: 'edit-failed', resource, deliveryId: card.deliveryId, targetId: card.targetId,
    messageRefId: `ref-${card.id}`, kind: 'edit', status: 'failed', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:01:00.000Z', lastErrorCode: 'MESSAGE_EDIT_DENIED', payload: 'private-edit-body' });
  const result = f.service.openSignup(f.actor(), card.id);
  assert.equal(result.publication.status, 'published'); assert.equal(result.update.status, 'failed'); assert.equal(result.update.errorCode, 'MESSAGE_EDIT_DENIED');
  for (const [status, expected] of [['queued', 'queued'], ['retry_wait', 'queued'], ['sending', 'running'], ['failed', 'failed'], ['delivery_unknown', 'unknown'], ['cancelled', 'cancelled']]) {
    seedOpenSignup(f, { id: status, status, reference: false });
    assert.equal(f.service.openSignup(f.actor(), status).publication.status, expected);
  }
  seedOpenSignup(f, { id: 'sent-no-ref', status: 'sent', reference: false, creator: false });
  assert.equal(f.service.openSignup(f.actor(), 'sent-no-ref').publication.status, 'unknown');
  assert.equal(f.service.openSignup(f.actor(), 'sent-no-ref').creator.discordId, null);
  put('v2NotificationMessageRefs', { id: `ref-${card.id}`, resource, deliveryId: card.deliveryId, targetId: card.targetId,
    platform: 'discord', guildId: '1153571748147634237', channelId: card.channelId, messageId: '1559929737403568278' });
  assert.equal(f.service.openSignup(f.actor(), card.id).publication.status, 'unknown');
  assert.equal(f.service.openSignup(f.actor(), card.id).publication.messageUrl, null);
});

test('date boundaries, pagination, roster searching and all counts use matching projections', t => {
  const f = setup(t), { card } = seedOpenSignup(f);
  seedOpenSignup(f, { id: 'next-month', serverId: 'monthly', serverName: 'Monthly', wipeAt: '2026-10-29T17:00:00.000Z' });
  assert.equal(f.service.openSignups(f.actor(), { from: card.settings.wipeAt, to: '2026-10-15T16:00:00.001Z' }).total, 1);
  assert.equal(f.service.openSignups(f.actor(), { to: card.settings.wipeAt }).total, 0);
  const result = f.service.openSignups(f.actor(), { page: '2', pageSize: '1' });
  assert.equal(result.total, 2); assert.equal(result.items[0].id, card.id); assert.equal(result.pages, 2);
  const roster = f.service.openSignupRoster(f.actor(), card.id, { response: 'late', q: 'user 2', pageSize: '1' });
  assert.equal(roster.total, 1); assert.equal(roster.items[0].originalResponse, 'late_8h'); assert.equal(roster.counts.total, 3);
  for (const query of [{ page: '-1' }, { pageSize: '1000' }, { status: 'sent' }, { from: 'today' }, { token: 'hidden' }, { q: ['a'] }])
    assert.throws(() => f.service.openSignups(f.actor(), query), /BOT_INPUT_INVALID/);
});

test('bot navigation is limited to readable Discord or KOOK and never API-key, Steam, WeChat or relay authority', () => {
  const sections = grants => managementSections({ status: 'active', restricted: false, roleId: 'admin', grants }, {}, grants);
  for (const id of ['discord', 'kook']) assert.ok(sections([grant('platforms.read', { type: 'platformTargets', ids: [id] })]).some(row => row.id === 'bot'));
  for (const id of ['steam', 'wechat', 'discord_kook_bridge']) assert.equal(sections([grant('platforms.read', { type: 'platformTargets', ids: [id] })]).some(row => row.id === 'bot'), false);
  assert.equal(sections([grant('system.api_keys', { type: 'all' })]).some(row => row.id === 'bot'), false);
  assert.equal(sections([grant('platforms.read', { type: 'platformTargets', ids: ['discord'] }),
    { ...grant('platforms.read', { type: 'platformTargets', ids: ['discord'] }), effect: 'deny' }]).some(row => row.id === 'bot'), false);
});

test('real role-based bootstrap exposes Bot to current administrators and hides it after role revocation', t => {
  const f = fixture(), memberSpace = new MemberSpaceService(f.identity);
  t.after(() => f.close());
  assert.ok(memberSpace.bootstrap(f.actor(), 'csrf').managementSections.some(row => row.id === 'bot'));
  assert.equal(memberSpace.bootstrap(f.actor('alpha'), 'csrf').managementSections.some(row => row.id === 'bot'), false);
  const oldActor = f.actor(), account = f.repo.get('accounts', oldActor.id);
  f.repo.put('accounts', { ...account, roleId: 'member', adminAssignedByOwner: false });
  assert.equal(memberSpace.bootstrap(oldActor, 'csrf').managementSections.some(row => row.id === 'bot'), false);
  assert.throws(() => f.service.openSignups(oldActor, {}), /ACCESS_DENIED/);
});

test('audit filters precede cursor pagination and preserve exact recorded actor and inclusive/exclusive dates', t => {
  const f = setup(t), from = '2026-10-15T00:00:00.000Z', end = '2026-10-16T00:00:00.000Z';
  for (let index = 0; index < 36; index++) {
    const at = new Date(Date.parse(from) + index * 1000).toISOString(), id = `audit-filter-${index}`;
    f.service.repo.put('audit', id, 'discord', 'recorded-actor', Date.parse(at), { id, platform: 'discord', actorId: 'recorded-actor',
      operationId: `operation-${index}`, action: index % 4 ? 'verify' : 'register_commands', status: index % 8 ? 'failed' : 'succeeded', at });
  }
  const query = { limit: '2', action: 'register_commands', status: 'succeeded', from, to: end };
  const first = f.service.history(f.actor(), 'discord', query), second = f.service.history(f.actor(), 'discord', { ...query, cursor: first.nextCursor });
  assert.deepEqual(first.items.map(row => row.id), ['audit-filter-32', 'audit-filter-24']);
  assert.deepEqual(second.items.map(row => row.id), ['audit-filter-16', 'audit-filter-8']);
  const third = f.service.history(f.actor(), 'discord', { ...query, cursor: second.nextCursor });
  assert.deepEqual(third.items.map(row => row.id), ['audit-filter-0']); assert.equal(third.nextCursor, null);
  assert.equal(third.items[0].actorId, 'recorded-actor'); assert.equal(Object.hasOwn(third.items[0], 'targetId'), false);
  assert.equal(f.service.history(f.actor(), 'discord', { ...query, to: '2026-10-15T00:00:08.000Z' }).items.length, 1);
  assert.equal(f.service.history(f.actor(), 'kook', query).items.length, 0);
  assert.throws(() => f.service.history(f.actor('alpha'), 'discord', query), /ACCESS_DENIED/);
  for (const invalid of [{ action: ['verify'] }, { status: "' OR 1=1" }, { cursor: 'NaN' }, { from: 'yesterday' }, { from: end, to: from }])
    assert.throws(() => f.service.history(f.actor(), 'discord', invalid), /PLATFORM_INPUT_INVALID/);
});
