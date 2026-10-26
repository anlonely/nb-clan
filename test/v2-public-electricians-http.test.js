import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { PlatformAdminRepository, installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { createManagementRuntime } from '../server/v2/management-runtime/index.js';
import { upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';
import { electricianTarget } from '../public/guides/electricians.js';
import { discordWelcomeGuideDetails } from '../server/v2/platform-admin/welcome-guide-card.js';

const guildId = '100000000000000001', channelId = '300000000000000002';
const query = `guildId=${guildId}&channelId=${channelId}`;
const expected = { china: [{ name: '当前中国电工', url: 'https://steamcommunity.com/profiles/76561198000000001/', avatar: '' }],
  foreign: [{ name: 'Current foreign electrician', url: 'https://steamcommunity.com/id/current-electrician/', avatar: '' }] };
const manualRoster = (revision = 1) => ({ revision, updatedAt: '2030-09-10T00:00:00.000Z', entries: [
  { kind: 'manual', group: 'CN', name: 'Shared electrician', url: 'https://steamcommunity.com/profiles/76561198000000004/' },
  { kind: 'manual', group: 'EU', name: 'Shared overseas electrician', url: 'https://steamcommunity.com/id/shared-electrician/' },
] });
const sharedExpected = { china: [{ name: 'Shared electrician', url: 'https://steamcommunity.com/profiles/76561198000000004/', avatar: '' }],
  foreign: [{ name: 'Shared overseas electrician', url: 'https://steamcommunity.com/id/shared-electrician/', avatar: '' }] };
const configuration = (platform = 'kook') => ({ id: platform, revision: 8, ...normalizeConfig(platform, {
  enabled: true,
  targets: [{ id: 'current-target', name: 'Private target label', guildId, channelId: '300000000000000009',
    electricianChannelId: channelId, enabled: true, enabledCommandIds: ['electrician_ids_card'] }],
  commands: [{ id: 'electrician_ids_card', name: '电工卡片', type: 'persistent_card', enabled: true,
    electriciansCn: platform === 'discord' ? 'Discord electrician | https://steamcommunity.com/profiles/76561198000000003' : '当前中国电工 | https://steamcommunity.com/profiles/76561198000000001',
    electriciansForeign: platform === 'discord' ? 'Discord overseas electrician | https://steamcommunity.com/id/discord-electrician' : 'Current foreign electrician | https://steamcommunity.com/id/current-electrician' }]
}) });

async function setup(t, { saved = true, electricianAvatarOptions } = {}) {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db); installPlatformAdminSchema(db);
  const identity = new IdentityService(new IdentityRepository(db)), repo = new PlatformAdminRepository(db);
  identity.repo.setScalar('settings', { kook: { botToken: 'private-bot-token', electriciansCn: 'legacy-list-not-public' } });
  const save = config => repo.put('config', config.id, config.id, 'fixture-admin', Date.now(), config);
  const saveRoster = roster => repo.put('electrician-roster', 'shared', 'shared', 'fixture-admin', Date.now(), roster);
  if (saved) save(configuration());
  let identityReads = 0;
  const runtime = createManagementRuntime({ getIdentity: () => { identityReads++; return identity; },
    runStoreWriteTask: () => { throw new Error('Public GET must not write'); },
    patchStoreCache: () => { throw new Error('Public GET must not patch cache'); },
    systemOptions: () => ({}), electricianAvatarOptions });
  const app = express();
  // Use the production runtime's exact pre-identity face; everything after it
  // requires authentication, so anonymous success proves the public mounting.
  app.use('/api/v2', runtime.beforeIdentityRouter);
  app.use('/api/v2', (_req, res) => res.status(401).json({ error: { errorCode: 'AUTH_REQUIRED' } }));
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await runtime.stop(); db.close(); });
  const get = async (search = query, options) => {
    const response = await fetch(`${origin}/api/v2/public/electricians?${search}`, options);
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control'),
      cookie: response.headers.get('set-cookie') };
  };
  return { db, repo, identity, runtime, origin, save, saveRoster, get, identityReads: () => identityReads,
    changes: () => db.prepare('SELECT total_changes() n').get().n };
}

test('anonymous HTTP reads only the current enabled card projection without writes, session or defaults', async t => {
  const f = await setup(t), before = f.changes();
  const result = await f.get();
  assert.equal(result.status, 200); assert.equal(result.cache, 'no-store'); assert.equal(result.cookie, null);
  assert.deepEqual(result.body, expected); assert.equal(f.changes(), before);
  assert.equal(f.runtime.diagnostics().instances, 0); assert.equal(f.runtime.diagnostics().timerActive, false);
  const changed = configuration(); changed.commands[0].electriciansCn = '新电工 | https://steamcommunity.com/id/new-electrician/';
  f.save(changed);
  const updated = await f.get();
  assert.deepEqual(updated.body.china, [{ name: '新电工', url: 'https://steamcommunity.com/id/new-electrician/', avatar: '' }]);
  assert.equal(updated.cache, 'no-store');
});

test('missing canonical configuration never exposes default or legacy electrician lists', async t => {
  const f = await setup(t, { saved: false }), before = f.changes(), result = await f.get();
  assert.equal(result.status, 404); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
  assert.equal(result.cache, 'no-store'); assert.equal(f.changes(), before);
});

test('KOOK guild-only compatibility admits exactly one enabled destination and never substitutes for Discord', async t => {
  const f=await setup(t);f.save(configuration('discord'));const before=f.changes();
  for(const search of [`guildId=${guildId}`,`platform=kook&guildId=${guildId}`])assert.deepEqual((await f.get(search)).body,expected);
  assert.equal((await f.get(`platform=discord&guildId=${guildId}`)).status,422);
  assert.equal((await f.get(`target=${guildId}`)).status,422);
  assert.equal(f.changes(),before);
  const config=configuration();config.targets.push({...config.targets[0],id:'second-target',electricianChannelId:'300000000000000003'});f.save(config);
  assert.equal((await f.get(`guildId=${guildId}`)).status,404);
  assert.deepEqual((await f.get(query)).body,expected);
  config.targets[1].enabled=false;f.save(config);assert.deepEqual((await f.get(`guildId=${guildId}`)).body,expected);
  config.targets[0].enabled=false;f.save(config);assert.equal((await f.get(`guildId=${guildId}`)).status,404);
  assert.deepEqual((await f.get(`platform=discord&${query}`)).body,expected);
});

test('KOOK guild-only resolution rechecks its selected destination after avatar lookup', async t => {
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await setup(t,{electricianAvatarOptions:{fetchImpl:async()=>{enter();await gate;return new Response('');}}});
  const request=f.get(`guildId=${guildId}`);await entered;
  const changed=configuration();changed.targets[0].electricianChannelId='300000000000000003';f.save(changed);release();
  assert.equal((await request).status,404);
});

test('shared rows serve both authorized platforms even when commands have no legacy inline list', async t => {
  const f = await setup(t);
  for (const platform of ['kook', 'discord']) {
    const config = configuration(platform);
    delete config.commands[0].electriciansCn; delete config.commands[0].electriciansForeign;
    f.save(config);
  }
  f.saveRoster(manualRoster());
  const before = f.changes();
  for (const search of [query, `platform=kook&${query}`, `platform=discord&${query}`, `target=${guildId}-${channelId}`]) {
    const result = await f.get(search);
    assert.equal(result.status, 200); assert.deepEqual(result.body, sharedExpected);
    assert.equal(result.cache, 'no-store'); assert.equal(result.cookie, null);
  }
  assert.equal(f.changes(), before);
  assert.equal(f.runtime.diagnostics().instances, 0);
});

test('a shared roster never authorizes an unconfigured or mismatched platform target', async t => {
  const f = await setup(t); f.saveRoster(manualRoster());
  assert.equal((await f.get(`platform=discord&${query}`)).status, 404);
  for (const mutate of [c => { c.enabled = false; }, c => { c.targets[0].enabled = false; },
    c => { c.targets[0].guildId = '100000000000000002'; }, c => { c.targets[0].electricianChannelId = '300000000000000003'; },
    c => { c.targets[0].enabledCommandIds = []; }, c => { c.commands[0].enabled = false; },
    c => { c.commands[0].type = 'event_card'; }, c => { c.commands = []; }]) {
    const config = configuration('discord'); mutate(config); f.save(config);
    assert.equal((await f.get(`platform=discord&${query}`)).status, 404);
    assert.deepEqual((await f.get()).body, sharedExpected);
  }
});

test('Discord inline data never substitutes for missing shared data and missing KOOK baseline', async t => {
  const f = await setup(t, { saved: false }); f.save(configuration('discord'));
  assert.equal((await f.get(`platform=discord&${query}`)).status, 404);
  f.saveRoster(manualRoster());
  assert.deepEqual((await f.get(`platform=discord&${query}`)).body, sharedExpected);
  assert.equal((await f.get()).status, 404, 'shared data does not replace missing KOOK link authorization');
});

test('an explicitly empty shared roster stays empty rather than repopulating from legacy or defaults', async t => {
  const f = await setup(t); f.save(configuration('discord'));
  f.saveRoster({ ...manualRoster(), entries: [] });
  for (const search of [query, `platform=discord&${query}`]) {
    const result = await f.get(search);
    assert.equal(result.status, 200); assert.deepEqual(result.body, { china: [], foreign: [] });
  }
});

test('shared member and specialty selections resolve current public rows without exposing internal member fields', async t => {
  const f = await setup(t); f.save(configuration('discord'));
  const member = { id: 'selected-member', displayName: 'Selected member', steamId: '76561198000000005', membershipStatus: 'active',
    privateNotes: 'not public', discordId: '100000000000000008' };
  f.identity.repo.put('members', member);
  f.identity.repo.put('members', { id: 'specialty-member', customName: 'Squad electrician', steamId: '76561198000000006',
    membershipStatus: 'active', specialty: ['electricity'], privateNotes: 'not public' });
  f.identity.repo.put('members', { id: 'wrong-squad-member', displayName: 'Other squad', steamId: '76561198000000007', specialty: ['electricity'], membershipStatus: 'active' });
  f.identity.repo.put('squadMembers', { id: 'membership-one', squadId: 'selected-squad', memberId: 'specialty-member', validTo: null });
  f.saveRoster({ ...manualRoster(), entries: [{ kind: 'member', group: 'CN', memberId: member.id },
    { kind: 'specialty', group: 'EU', specialty: 'electricity', squadId: 'selected-squad' }] });
  const before = f.changes();
  const rows = { china: [{ name: 'Selected member', url: 'https://steamcommunity.com/profiles/76561198000000005/', avatar: '' }],
    foreign: [{ name: 'Squad electrician', url: 'https://steamcommunity.com/profiles/76561198000000006/', avatar: '' }] };
  for (const search of [query, `platform=discord&${query}`]) {
    const result = await f.get(search); assert.equal(result.status, 200); assert.deepEqual(result.body, rows);
    assert.doesNotMatch(JSON.stringify(result.body), /privateNotes|discordId|memberId|specialty|squadId|revision|updatedAt/);
  }
  assert.equal(f.changes(), before);
});

test('Discord welcome and already delivered links authorize Discord and share the legacy KOOK roster baseline', async t => {
  const f = await setup(t), config = configuration('discord');
  f.save(config);
  const details = discordWelcomeGuideDetails({ ...config.targets[0], serverConnectChannelId: '300000000000000010' });
  const current = new URL(details.electricianProfilesUrl);
  assert.equal(current.searchParams.get('platform'), 'discord');
  assert.equal(current.searchParams.get('guildId'), guildId);
  assert.equal(current.searchParams.get('channelId'), channelId);
  assert.equal(new URL(details.electricianTutorialUrl).search, current.search);
  assert.equal(new URL(details.electricianTutorialUrl).hash, '#tutorial');
  const searches = [electricianTarget(current.search), `platform=discord&${query}`, `target=${guildId}-${channelId}`];
  for (const page of ['electricians.html', 'electricians-en.html']) {
    for (const hash of ['', '#tutorial']) searches.push(electricianTarget(new URL(`https://clan.example.com/guides/${page}?target=${guildId}-${channelId}${hash}`).search));
  }
  const before = f.changes();
  for (const search of searches) {
    const result = await f.get(search);
    assert.equal(result.status, 200); assert.deepEqual(result.body, expected);
    assert.equal(result.cache, 'no-store'); assert.equal(result.cookie, null);
  }
  assert.deepEqual((await f.get()).body, expected, 'both platforms use the same roster while retaining exact link authorization');
  assert.deepEqual((await f.get(`platform=kook&${query}`)).body, expected);
  assert.equal(f.changes(), before, 'public reads must not mutate either platform configuration');
});

test('a Discord request never substitutes KOOK target authorization or disabled Discord configuration', async t => {
  const f = await setup(t);
  const discordQuery = `platform=discord&${query}`;
  assert.equal((await f.get(discordQuery)).status, 404, 'a matching KOOK target is not a Discord roster');
  for (const mutate of [c => { c.enabled = false; }, c => { c.targets[0].enabled = false; },
    c => { c.targets[0].enabledCommandIds = []; }, c => { c.commands[0].enabled = false; },
    c => { c.commands[0].type = 'event_card'; }, c => { c.targets[0].electricianChannelId = '300000000000000004'; },
    c => { c.commands = []; }]) {
    const config = configuration('discord'); mutate(config); f.save(config);
    const before = f.changes(), result = await f.get(discordQuery);
    assert.equal(result.status, 404); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
    assert.equal(f.changes(), before);
    assert.deepEqual((await f.get()).body, expected, 'rejecting Discord must not disable the matching KOOK roster');
  }
});

test('disabled or unmatched targets and commands never expose the configured roster', async t => {
  const f = await setup(t);
  for (const mutate of [
    c => { c.enabled = false; },
    c => { c.targets[0].enabled = false; },
    c => { c.targets[0].guildId = '100000000000000002'; },
    c => { c.targets[0].electricianChannelId = '300000000000000003'; },
    c => { c.targets[0].enabledCommandIds = []; },
    c => { c.commands[0].enabled = false; },
    c => { c.commands[0].type = 'event_card'; },
    c => { c.commands = []; },
    c => { c.commands[0].electriciansCn = 'Unsafe | https://elsewhere.example/'; },
    c => { c.commands[0].electriciansForeign = c.commands[0].electriciansCn; },
    c => { c.commands[0].electriciansCn = ''; c.commands[0].electriciansForeign = ''; }
  ]) {
    const config = configuration(); mutate(config); f.save(config);
    const before = f.changes(), result = await f.get();
    assert.equal(result.status, 404); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
    assert.equal(result.cache, 'no-store'); assert.equal(f.changes(), before);
  }
  f.save(configuration());
  assert.equal((await f.get(`guildId=${guildId}&channelId=300000000000000009`)).status, 404);
});

test('query IDs must be scalar digit strings and Discord requires an exact channel before configuration reads', async t => {
  const f = await setup(t), before = f.changes();
  for (const search of ['', `platform=discord&guildId=${guildId}`, `guildId=${guildId}&channelId=`, `channelId=${channelId}`,
    `guildId=123456789&channelId=${channelId}`, `guildId=${guildId}&channelId=123456789012345678901`,
    `guildId=not-a-guild&channelId=${channelId}`, `${query}&guildId=${guildId}`, `${query}&extra=value`,
    `guildId%5Bvalue%5D=${guildId}&channelId=${channelId}`]) {
    const result = await f.get(search);
    assert.equal(result.status, 422); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIAN_INPUT_INVALID' } });
    assert.equal(result.cache, 'no-store');
  }
  assert.equal(f.identityReads(), 0); assert.equal(f.changes(), before);
});

test('ambiguous platform and legacy-target inputs are rejected before any configuration read', async t => {
  const f = await setup(t), before = f.changes(), target = `${guildId}-${channelId}`;
  for (const search of [`platform=discord&platform=kook&${query}`, `platform=&${query}`, `platform=bridge&${query}`,
    `platform%5Bvalue%5D=discord&${query}`, 'target=', 'target=abc-def', `target=123-${channelId}`,
    `target=${target}-extra`, `target=${target}&target=${target}`, `target=${target}&platform=discord`,
    `target=${target}&guildId=${guildId}`, `target=${target}&channelId=${channelId}`,
    `target%5Bvalue%5D=${target}`, `target=${target}&extra=value`]) {
    const result = await f.get(search);
    assert.equal(result.status, 422); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIAN_INPUT_INVALID' } });
    assert.equal(result.cache, 'no-store');
  }
  assert.equal(f.identityReads(), 0); assert.equal(f.changes(), before);
});

test('public mounting leaves authenticated routes and the existing identity write guard intact', async t => {
  const f = await setup(t), before = f.changes();
  assert.equal((await f.get(query, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${f.origin}/api/v2/platform-admin/kook`)).status, 401);
  const retired = await fetch(`${f.origin}/api/v2/identity/accounts/owner`, { method: 'POST' });
  assert.equal(retired.status, 410); assert.equal((await retired.json()).error.errorCode, 'SYSTEM_ADMIN_COMMAND_REQUIRED');
  assert.equal(f.changes(), before);
});

test('repository failures produce only a generic non-cacheable error', async t => {
  const f = await setup(t); f.db.exec('DROP TABLE platform_admin_records');
  const result = await f.get();
  assert.equal(result.status, 503); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_UNAVAILABLE' } });
  assert.equal(result.cache, 'no-store');
});

test('anonymous roster reuses exact Steam cache and fetches vanity avatars once without exposing member fields', async t => {
  const avatar = `https://avatars.steamstatic.com/${'a'.repeat(40)}_full.jpg`; let fetches = 0;
  const f = await setup(t, { electricianAvatarOptions: { fetchImpl: async url => {
    fetches++; assert.equal(url, `${expected.foreign[0].url}?xml=1`);
    return new Response(`<profile><steamID64>76561198000000002</steamID64><avatarFull><![CDATA[${avatar}]]></avatarFull></profile>`);
  } } });
  f.identity.repo.put('members', { id: 'private-member-id', steamId: '76561198000000001', steamAvatar: avatar,
    displayName: 'private member name', privateNotes: 'never expose this' });
  const before = f.changes();
  for (let n = 0; n < 2; n++) {
    const result = await f.get(); assert.equal(result.status, 200);
    assert.deepEqual(result.body, { china: [{ ...expected.china[0], avatar }], foreign: [{ ...expected.foreign[0], avatar }] });
  }
  assert.equal(fetches, 1); assert.equal(f.changes(), before);
});

test('disabling a list while avatars are in flight returns no stale roster', async t => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { electricianAvatarOptions: { fetchImpl: async () => { enter(); await gate; return new Response(''); } } });
  const request = f.get(); await entered;
  const config = configuration(); config.enabled = false; f.save(config); release();
  const result = await request;
  assert.equal(result.status, 404); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
});

test('avatar completion rechecks the selected Discord platform and rejects a changed roster', async t => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { electricianAvatarOptions: { fetchImpl: async url => {
    assert.equal(url, `${expected.foreign[0].url}?xml=1`); enter(); await gate; return new Response('');
  } } });
  f.save(configuration('discord'));
  const request = f.get(`platform=discord&${query}`); await entered;
  const config = configuration('discord'); config.enabled = false; f.save(config); release();
  const result = await request;
  assert.equal(result.status, 404); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
  assert.deepEqual((await f.get()).body, expected, 'the valid KOOK roster must never substitute for the disabled Discord roster');
});

for (const change of ['configuration revision', 'shared revision', 'resolved member', 'shared source']) test(`avatars in flight fence a changed ${change} even if the other platform remains enabled`, async t => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { electricianAvatarOptions: { fetchImpl: async () => { enter(); await gate; return new Response(''); } } });
  f.save(configuration('discord'));
  if (change === 'resolved member') {
    f.identity.repo.put('members', { id: 'dynamic-member', displayName: 'Old member name', steamId: '76561198000000005', membershipStatus: 'active' });
    f.saveRoster({ ...manualRoster(), entries: [{ kind: 'member', group: 'CN', memberId: 'dynamic-member' }, manualRoster().entries[1]] });
  } else if (change !== 'shared source') f.saveRoster(manualRoster());
  const request = f.get(`platform=discord&${query}`); await entered;
  if (change === 'configuration revision') {
    const config = configuration('discord'); config.revision++; f.save(config);
  } else if (change === 'shared revision') f.saveRoster(manualRoster(2));
  else if (change === 'resolved member') f.identity.repo.put('members', { ...f.identity.repo.get('members', 'dynamic-member'), customName: 'Updated member name' });
  else f.saveRoster({ ...manualRoster(0), entries: [...expected.china.map(row => ({ kind: 'manual', group: 'CN', name: row.name, url: row.url })),
    ...expected.foreign.map(row => ({ kind: 'manual', group: 'EU', name: row.name, url: row.url }))] });
  release();
  const result = await request;
  assert.equal(result.status, 404); assert.deepEqual(result.body, { error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
  assert.equal((await f.get()).status, 200);
});

test('Steam-keyed memberProfiles supplies a valid avatar only for its matching member', async t => {
  const f = await setup(t), avatar = `https://avatars.fastly.steamstatic.com/${'b'.repeat(40)}_full.jpg`;
  f.identity.repo.put('members', { id: 'matching-member', steamId: '76561198000000001', avatar: 'https://untrusted.example/private.png' });
  upsertSqliteCollectionRecord(f.db, 'memberProfiles', 'cached-profile', { id: 'cached-profile',
    memberId: 'matching-member', steamId: '76561198000000001', avatar, privateMetadata: 'not-public' });
  const before = f.changes(), result = await f.get();
  assert.equal(result.status, 200); assert.deepEqual(result.body.china, [{ ...expected.china[0], avatar }]);
  assert.equal(f.changes(), before);
});
