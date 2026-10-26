import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createDiscordSteamLinksService } from '../server/v2/discord-steam-links/service.js';
import { DiscordSteamLinksRepository, steamLinkKey } from '../server/v2/discord-steam-links/repository.js';
import { markSteamLinksProof } from '../server/v2/discord-steam-links/proof.js';
import { buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';
import { matchSteamTeam } from '../server/v2/discord-steam-links/team-matching.js';
import { steamTeamSummary } from '../server/v2/discord-steam-links/renderer.js';

const guildId = '1153571748147634236', channelId = '1153572000000000000', userId = '1177000000000000000';
const otherId = '1177000000000000001', otherGuild = '1153571748147634237', messageId = '1188000000000000000';
const firstId = '76561198000000001', secondId = '76561198000000002', thirdId = '76561198000000003';
const tokenOf = payload => (payload.data?.custom_id || payload.components[0].components[0].custom_id).split(':')[2];
const errorCode = code => error => error.errorCode === code;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); installPlatformAdminSchema(db); t.after(() => db.close());
  const repo = new DiscordSteamLinksRepository(db);
  let clock = Date.parse('2026-10-15T12:00:00Z'), sequence = 0;
  const config = { enabled: true, commands: ['setsteam', 'view'].map(id => ({ id, enabled: true, type: 'slash_command', slashCommand: id })),
    targets: [{ id: 'personal', guildId, channelId, enabled: true, enabledCommandIds: ['setsteam', 'view'], steamListAllowedUserIds: [], steamListAllowedRoleIds: [] }] };
  const calls = [];
  const provider = {
    async resolveIdentifier(value) { calls.push(['resolve', value]); return { status: 'ok', steamId: /^\d+$/.test(value) ? value : firstId,
      profile: { status: 'ok', steamId: /^\d+$/.test(value) ? value : firstId, displayName: 'Steam player', fetchedAt: new Date(clock).toISOString() } }; },
    async readProfile(id) { calls.push(['profile', id]); return { status: 'ok', steamId: id, displayName: 'Steam player', fetchedAt: new Date(clock).toISOString() }; },
    async listGuildMembers(id) { calls.push(['members', id]); return { status: 'ok', complete: true, members: [{ discordId: userId, displayName: 'User', bot: false }], fetchedAt: new Date(clock).toISOString() }; },
    ...options.provider,
  };
  const service = createDiscordSteamLinksService({ db, readConfig: () => config, provider, now: () => clock,
    runStoreWriteTask: task => Promise.resolve().then(task), ...options.service });
  function proof(action, payload = {}, overrides = {}) {
    return markSteamLinksProof({ provider: 'discord', guildId, channelId, externalId: userId, locale: 'en-US',
      discordPermissions: '0', discordRoleIds: [], interactionId: String(1199000000000000000n + BigInt(++sequence)),
      originMessageId: ['confirm', 'cancel', 'page'].includes(action) ? messageId : null,
      originEphemeral: ['confirm', 'cancel', 'page'].includes(action), payload: { kind: 'steam_links', action, ...payload }, ...overrides });
  }
  const handle = (action, values, overrides) => service.handleVerified(proof(action, values, overrides));
  function seed(id = firstId, discordId = userId, guild = guildId) {
    const row = { guildId: guild, discordId, steamId: id, revision: 1, ownershipVerified: false, updatedAt: new Date(clock).toISOString() };
    repo.putRecord('link', steamLinkKey(guild, discordId), row, discordId, clock); return row;
  }
  function open(overrides) { return tokenOf(handle('open', {}, overrides)); }
  async function submit(id = firstId, token = open(), overrides) {
    const p = proof('submit', { token, values: { identifier: id } }, overrides), result = await service.handleVerified(p);
    const hasContext = result.components?.some(row => row.components?.some(component => component.custom_id?.startsWith('nbsteam:')));
    if (hasContext) service.bindPrivateMessage(p, result, messageId);
    return { result, proof: p, token: hasContext ? tokenOf(result) : token };
  }
  return { db, repo, config, calls, provider, service, proof, handle, open, submit, seed,
    now: () => clock, advance: ms => { clock += ms; }, link: (discordId = userId, guild = guildId) => repo.getLink(guild, discordId) };
}

test('native actor identity is mandatory and first linking is guild-scoped, idempotent and independent of website identity', async t => {
  const f = fixture(t), p = f.proof('open');
  assert.throws(() => f.service.handleVerified({ ...p }), errorCode('PLATFORM_AUTH_INVALID'));
  const opened = f.service.handleVerified(p);
  assert.equal(opened.type, 9); assert.deepEqual(f.service.handleVerified(p), opened);
  const { result, proof } = await f.submit(` ${firstId} `, tokenOf(opened));
  assert.equal(result.flags, 64); assert.match(result.content, /saved/); assert.ok(result.embeds.length > 0);
  assert.equal(f.link().steamId, firstId); assert.equal(f.link().ownershipVerified, false); assert.equal(f.link().revision, 1);
  assert.deepEqual(await f.service.handleVerified(proof), result); assert.equal(f.link().revision, 1);
  const same = await f.submit(firstId); assert.match(same.result.content, /already linked/); assert.equal(f.link().revision, 1);
  assert.equal(f.link(userId, otherGuild), null);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['platform_admin_records']);
  assert.deepEqual(f.calls.filter(row => row[0] === 'resolve').map(row => row[1]), [firstId, firstId]);
});

test('different Steam links require an actor-private bound-message confirmation; cancellation retains the original', async t => {
  const f = fixture(t); f.seed(); const { result, token } = await f.submit(secondId);
  assert.match(JSON.stringify(result), new RegExp(firstId)); assert.match(JSON.stringify(result), new RegExp(secondId));
  assert.equal(f.link().steamId, firstId);
  await assert.rejects(f.handle('confirm', { token }, { externalId: otherId }), errorCode('STEAM_LINK_CONTEXT_INVALID'));
  await assert.rejects(f.handle('confirm', { token }, { originEphemeral: false }), errorCode('MESSAGE_REFERENCE_REQUIRED'));
  await assert.rejects(f.handle('confirm', { token }, { originMessageId: '1188000000000000001' }), errorCode('MESSAGE_REFERENCE_REQUIRED'));
  const cancelled = await f.handle('cancel', { token }); assert.match(cancelled.content, /Cancelled/);
  await f.handle('confirm', { token }); assert.equal(f.link().steamId, firstId); assert.equal(f.link().revision, 1);
  const next = await f.submit(secondId), confirmed = await f.handle('confirm', { token: next.token });
  assert.match(confirmed.content, /saved/); assert.equal(f.link().steamId, secondId); assert.equal(f.link().revision, 2);
  await f.handle('cancel', { token: next.token }); assert.equal(f.link().steamId, secondId);
});

test('a private confirmation without a successful transport binding fails closed', async t => {
  const f = fixture(t); f.seed(); const token = f.open();
  const p = f.proof('submit', { token, values: { identifier: secondId } }), result = await f.service.handleVerified(p), confirmToken = tokenOf(result);
  await assert.rejects(f.handle('confirm', { token: confirmToken }), errorCode('MESSAGE_REFERENCE_REQUIRED'));
  assert.throws(() => f.service.bindPrivateMessage(f.proof('submit', {}, { externalId: otherId }), result, messageId), errorCode('STEAM_LINK_CONTEXT_INVALID'));
  f.service.bindPrivateMessage(p, result, messageId);
  await f.handle('confirm', { token: confirmToken }); assert.equal(f.link().steamId, secondId);
});

test('concurrent replacement drafts use revision checks and a stale confirmation cannot overwrite the winner', async t => {
  const f = fixture(t); f.seed();
  const left = await f.submit(secondId), right = await f.submit(thirdId);
  await f.handle('confirm', { token: right.token });
  await assert.rejects(f.handle('confirm', { token: left.token }), errorCode('STEAM_LINK_REVISION_CONFLICT'));
  assert.equal(f.link().steamId, thirdId); assert.equal(f.link().revision, 2);
});

test('concurrent initial submissions cannot overwrite one another and repeated exact operations share the same work', async t => {
  const waiting = deferred(), f = fixture(t, { provider: { resolveIdentifier: async value => { await waiting.promise; return { status: 'ok', steamId: value }; } } });
  const one = f.open(), two = f.open(), p = f.proof('submit', { token: one, values: { identifier: firstId } });
  const initial = f.service.handleVerified(p), replay = f.service.handleVerified(p), competing = f.handle('submit', { token: two, values: { identifier: secondId } });
  assert.equal(initial, replay);
  waiting.resolve(); await initial; await assert.rejects(competing, errorCode('STEAM_LINK_REVISION_CONFLICT'));
  assert.equal(f.link().steamId, firstId); assert.equal(f.link().revision, 1);
});

test('revocation and expiration during provider I/O are checked again before saving', async t => {
  for (const mode of ['revoked', 'expired']) {
    const waiting = deferred(), entered = deferred(), f = fixture(t, { provider: { resolveIdentifier: async () => { entered.resolve(); await waiting.promise; return { status: 'ok', steamId: firstId }; } } });
    const operation = f.handle('submit', { token: f.open(), values: { identifier: firstId } }); await entered.promise;
    if (mode === 'revoked') f.config.targets[0].enabled = false; else f.advance(16 * 60_000);
    waiting.resolve(); await assert.rejects(operation, errorCode(mode === 'revoked' ? 'PLATFORM_CHANNEL_DENIED' : 'STEAM_LINK_CONTEXT_EXPIRED'));
    assert.equal(f.link(), null);
  }
});

test('disabled commands, wrong channels, duplicate targets and non-manager list calls fail before provider access', async t => {
  const f = fixture(t);
  for (const override of [{ channelId: '1153572000000000001' }, { guildId: otherGuild }])
    assert.throws(() => f.handle('open', {}, override), errorCode('PLATFORM_CHANNEL_DENIED'));
  assert.throws(() => f.handle('view_all'), errorCode('STEAM_LINK_LIST_DENIED'));
  assert.throws(() => f.handle('view_nosteam'), errorCode('STEAM_LINK_LIST_DENIED'));
  f.config.targets.push({ ...f.config.targets[0], id: 'ambiguous' });
  assert.throws(() => f.handle('open'), errorCode('PLATFORM_CHANNEL_DENIED'));
  f.config.targets.pop(); f.config.commands[0].enabled = false;
  assert.throws(() => f.handle('open'), errorCode('COMMAND_DISABLED'));
  assert.equal(f.calls.length, 0);
});

test('invalid, nonexistent and provider-failed identifiers produce distinct replies and never change a link', async t => {
  const f = fixture(t); f.seed();
  const malformed = await f.submit('https://evil.test/id/username'); assert.match(malformed.result.content, /17-digit/); assert.equal(f.calls.length, 0);
  for (const [status, message] of [['not_found', /not found/], ['error', /could not be checked/], ['unavailable', /could not be checked/]]) {
    f.provider.resolveIdentifier = async () => ({ status });
    const response = await f.submit(secondId); assert.match(response.result.content, message); assert.equal(f.link().steamId, firstId);
  }
  f.provider.resolveIdentifier = async () => ({ status: 'ok', steamId: 76561198000000001 });
  assert.match((await f.submit(secondId)).result.content, /could not be checked/);
});

test('view user requires exactly one argument and reads only this guild link before the provider', async t => {
  const f = fixture(t); f.seed(firstId, userId, otherGuild);
  assert.match((await f.handle('view_user')).content, /Choose one/);
  assert.match((await f.handle('view_user', { values: { user: userId, identifier: firstId } })).content, /not both/);
  assert.match((await f.handle('view_user', { values: { user: userId } })).content, /no Steam link/);
  assert.equal(f.calls.length, 0);
  f.seed();
  const linked = await f.handle('view_user', { values: { user: userId } });
  assert.equal(linked.flags, 64); assert.match(JSON.stringify(linked), new RegExp(firstId));
  assert.deepEqual(f.calls, [['profile', firstId]]);
  const byInput = await f.handle('view_user', { values: { identifier: `https://steamcommunity.com/profiles/${secondId}` } });
  assert.match(JSON.stringify(byInput), /could not be checked/);
});

test('view all and nosteam exclude bots and departed users and paginate 0,1,20,21 stable human rows', async t => {
  for (const count of [0, 1, 20, 21]) {
    const f = fixture(t), members = Array.from({ length: count }, (_, index) => ({ discordId: String(BigInt(userId) + BigInt(index)), displayName: `Name ${index}`, bot: false }));
    const bot = { discordId: '1277000000000000000', displayName: 'Bot', bot: true };
    f.provider.listGuildMembers = async () => ({ status: 'ok', complete: true, members: [...members].reverse().concat(bot), fetchedAt: '2026-10-15T12:00:00Z' });
    for (const member of members) f.seed(firstId, member.discordId);
    f.seed(secondId, bot.discordId); f.seed(thirdId, '1277000000000000001');
    const p = f.proof('view_all', {}, { discordPermissions: '32' }), result = await f.service.handleVerified(p);
    assert.equal(result.flags, 64); assert.doesNotMatch(JSON.stringify(result), /127700000000000000[01]/);
    assert.match(result.embeds[0].footer.text, new RegExp(`${count} members`));
    assert.equal(count ? result.embeds[0].description.split('\n').length : 0, Math.min(count, 20));
    if (count === 21) {
      f.service.bindPrivateMessage(p, result, messageId);
      const next = await f.handle('page', { token: tokenOf(result), page: 1 }, { discordPermissions: '32' });
      assert.equal(next.embeds[0].description.split('\n').length, 1); assert.match(next.embeds[0].description, /^21\. /);
      await assert.rejects(f.handle('page', { token: tokenOf(result), page: 1 }, { discordPermissions: '32', externalId: otherId }), errorCode('STEAM_LINK_CONTEXT_INVALID'));
    }
    const missing = await f.handle('view_nosteam', {}, { discordPermissions: '8' });
    assert.match(missing.embeds[0].footer.text, /0 members/);
  }
});

test('configured role/user list permission is rechecked for every private page and failure never looks like an empty list', async t => {
  const f = fixture(t); f.config.targets[0].steamListAllowedRoleIds = ['1188000000000000001'];
  const members = Array.from({ length: 21 }, (_, index) => ({ discordId: String(BigInt(userId) + BigInt(index)), displayName: `Name ${index}`, bot: false }));
  f.provider.listGuildMembers = async () => ({ status: 'ok', complete: true, members });
  const role = { discordRoleIds: ['1188000000000000001'] }, p = f.proof('view_nosteam', {}, role), result = await f.service.handleVerified(p);
  f.service.bindPrivateMessage(p, result, messageId);
  f.config.targets[0].steamListAllowedRoleIds = [];
  assert.throws(() => f.handle('page', { token: tokenOf(result), page: 1 }, role), errorCode('STEAM_LINK_LIST_DENIED'));
  f.config.targets[0].steamListAllowedUserIds = [userId];
  for (const broken of [{ status: 'error' }, { status: 'ok', complete: false, members: [] }, { status: 'ok', complete: true, members: [members[0], members[0]] }]) {
    f.provider.listGuildMembers = async () => broken;
    const response = await f.handle('view_nosteam'); assert.match(response.content, /could not be loaded/); assert.deepEqual(response.embeds, []);
  }
});

test('a failed SQLite write rolls back the link and receipt and reports definitely not saved', async t => {
  const f = fixture(t), token = f.open();
  f.db.exec("CREATE TRIGGER fail_steam_link BEFORE INSERT ON platform_admin_records WHEN NEW.kind='discord-steam-link' BEGIN SELECT RAISE(ABORT,'test write failure'); END");
  const response = await f.handle('submit', { token, values: { identifier: firstId } });
  assert.match(response.content, /not saved/); assert.equal(f.link(), null);
  f.db.exec('DROP TRIGGER fail_steam_link');
  assert.match((await f.handle('submit', { token, values: { identifier: firstId } })).content, /saved/); assert.equal(f.link().revision, 1);
});

test('lost COMMIT acknowledgement retrieves the persisted receipt; unreadable acknowledgement remains unknown', async t => {
  for (const readable of [true, false]) {
    const db = new DatabaseSync(':memory:'); installPlatformAdminSchema(db); t.after(() => db.close());
    let fault = false, lost = false;
    const wrapped = { prepare(sql) { if (lost && !readable) throw new Error('database unavailable'); return db.prepare(sql); },
      exec(sql) { if (fault && sql === 'COMMIT') { db.exec(sql); lost = true; throw new Error('lost acknowledgement'); } return db.exec(sql); } };
    const config = { enabled: true, commands: [{ id: 'setsteam', type: 'slash_command', slashCommand: 'setsteam', enabled: true }],
      targets: [{ id: 'one', enabled: true, guildId, channelId, enabledCommandIds: ['setsteam'] }] };
    const service = createDiscordSteamLinksService({ db: wrapped, readConfig: () => config, now: () => Date.parse('2026-10-15T12:00:00Z'),
      provider: { resolveIdentifier: async () => ({ status: 'ok', steamId: firstId }) }, runStoreWriteTask: task => Promise.resolve().then(task) });
    const p = action => markSteamLinksProof({ provider: 'discord', guildId, channelId, externalId: userId, interactionId: action === 'open' ? '1199000000000000001' : '1199000000000000002', locale: 'en', payload: { kind: 'steam_links', action } });
    const token = tokenOf(service.handleVerified(p('open'))), submit = p('submit'); submit.payload.token = token; submit.payload.values = { identifier: firstId };
    fault = true;
    const response = await service.handleVerified(submit);
    assert.match(response.content, readable ? /link saved/ : /result is unknown/);
    assert.equal(new DiscordSteamLinksRepository(db).getLink(guildId, userId).steamId, firstId);
  }
});

const fullProfile = id => ({ status: 'ok', steamId: id, displayName: 'Complete Steam profile', fetchedAt: '2026-10-15T12:00:00Z',
  enrichment: {
    steam: { status: 'ok', profilePublic: true, rustStatus: 'ok', rustMinutes: 120, fetchedAt: '2026-10-15T12:00:00Z' },
    bans: { status: 'ok', numberOfVacBans: 0, numberOfGameBans: 1, communityBanned: false, fetchedAt: '2026-10-15T12:00:00Z' },
    battlemetrics: { status: 'ok', trackedSeconds: 18000, serverId: '1234567', from: '2026-10-01T00:00:00Z',
      to: '2026-10-15T12:00:00Z', fetchedAt: '2026-10-15T12:00:00Z' },
  } });

test('first link, same-ID submission and confirmed replacement read full Steam/BM data only after the receipt commits', async t => {
  const f = fixture(t), reads = [];
  f.provider.readProfile = async id => {
    // A new transaction can start only after the saving transaction committed.
    f.db.exec('BEGIN'); f.db.exec('ROLLBACK');
    assert.equal(f.link().steamId, id);
    assert.ok(f.repo.count('receipt') >= 2);
    reads.push(id); return fullProfile(id);
  };
  const initial = await f.submit(firstId), same = await f.submit(firstId), change = await f.submit(secondId);
  assert.deepEqual(reads, [firstId, firstId], 'a replacement preview must not query data for an unconfirmed link');
  const confirmation = f.proof('confirm', { token: change.token }), confirmed = await f.service.handleVerified(confirmation);
  assert.deepEqual(reads, [firstId, firstId, secondId]);
  for (const result of [initial.result, same.result, confirmed]) {
    assert.match(result.content, /saved|already linked/);
    assert.equal(result.embeds[0].title, 'Complete Steam profile');
    assert.match(result.embeds[0].fields.find(field => field.name === 'Steam ban records').value, /VAC bans: 0\nGame bans: 1/);
    assert.match(result.embeds[0].fields.find(field => field.name === 'BM tracked server playtime').value, /^5 hours\nServer: 1234567/);
  }
  assert.equal(f.link().revision, 2);
  const snapshot = f.db.prepare('SELECT * FROM platform_admin_records ORDER BY kind,id').all();
  for (const p of [initial.proof, same.proof, confirmation]) {
    const replay = await f.service.handleVerified(p);
    assert.match(replay.content, /saved|already linked/);
    assert.equal(replay.embeds[0].title, 'Steam player', 'replay retains its original durable receipt');
  }
  assert.deepEqual(reads, [firstId, firstId, secondId]);
  assert.deepEqual(f.db.prepare('SELECT * FROM platform_admin_records ORDER BY kind,id').all(), snapshot, 'profile rendering and replay must never write again');
});

test('failed, rejected and mismatched full profile reads retain a saved link and its basic profile', async t => {
  for (const outcome of ['failed', 'thrown', 'mismatched']) {
    const f = fixture(t);
    f.provider.readProfile = async () => {
      assert.equal(f.link().steamId, firstId, 'the link must already be saved before enrichment');
      if (outcome === 'thrown') throw new Error('private upstream failure');
      return outcome === 'mismatched' ? fullProfile(secondId) : { status: 'unavailable' };
    };
    const { result } = await f.submit(firstId);
    assert.match(result.content, /link saved/); assert.doesNotMatch(result.content, /not saved|result is unknown|private upstream/);
    assert.equal(result.embeds[0].title, 'Steam player'); assert.equal(f.link().steamId, firstId); assert.equal(f.link().revision, 1);
    assert.equal(f.repo.count('receipt'), 2);
  }
});

test('a timed-out full profile read aborts within its budget and preserves the original save receipt', async t => {
  const f = fixture(t, { service: { providerTimeoutMs: 20 } }); let signal;
  f.provider.readProfile = async (_id, options) => { signal = options.signal; return new Promise(() => {}); };
  const { result, proof } = await f.submit(firstId);
  assert.equal(signal.aborted, true); assert.match(result.content, /link saved/);
  assert.equal(result.embeds[0].title, 'Steam player'); assert.equal(f.link().revision, 1);
  assert.deepEqual(await f.service.handleVerified(proof), result); assert.equal(f.repo.count('receipt'), 2);
});

test('revocation or a newer link during post-save enrichment keeps the committed acknowledgement without exposing stale full data', async t => {
  for (const changed of ['revoked', 'replaced']) {
    const waiting = deferred(), entered = deferred(), f = fixture(t);
    f.provider.readProfile = async id => { entered.resolve(); await waiting.promise; return fullProfile(id); };
    const pending = f.submit(firstId); await entered.promise;
    assert.equal(f.link().steamId, firstId); assert.equal(f.link().revision, 1);
    if (changed === 'revoked') f.config.targets[0].enabled = false;
    else f.repo.putRecord('link', steamLinkKey(guildId, userId), { ...f.link(), steamId: secondId, revision: 2 }, userId, f.now());
    waiting.resolve();
    const { result } = await pending;
    assert.match(result.content, /link saved/); assert.deepEqual(result.embeds, []); assert.deepEqual(result.components, []);
    assert.equal(f.link().steamId, changed === 'revoked' ? firstId : secondId);
    assert.equal(f.repo.count('receipt'), 2);
  }
});

const cnRole = '1188000000000000001', euRole = '1188000000000000002', cnOtherRole = '1188000000000000003';
function enableTeams(f) {
  f.config.commands.find(row => row.id === 'setsteam').autoMatchTeamByRole = true;
  Object.assign(f.config.targets[0], { steamTeamCnRoleIds: [cnRole, cnOtherRole], steamTeamEuRoleIds: [euRole],
    steamTeamCnSquadId: 'squad-cn', steamTeamEuSquadId: 'squad-eu' });
}

test('team selection uses only exact role IDs, requires a configured squad and never chooses between CN and EU', () => {
  const target = { id: 'target', steamTeamCnRoleIds: [cnRole], steamTeamEuRoleIds: [euRole], steamTeamCnSquadId: 'cn', steamTeamEuSquadId: 'eu' };
  assert.equal(matchSteamTeam({ target, discordRoleIds: [cnRole] }).status, 'disabled');
  assert.equal(matchSteamTeam({ enabled: true, target, discordRoleIds: ['CN', 'EU', 'Administrator'] }).status, 'no_match');
  assert.equal(matchSteamTeam({ enabled: true, target, discordRoleIds: [cnRole, euRole] }).status, 'role_conflict');
  assert.equal(matchSteamTeam({ enabled: true, target: { ...target, steamTeamCnSquadId: '' }, discordRoleIds: [cnRole] }).status, 'squad_unavailable');
  assert.equal(matchSteamTeam({ enabled: true, target: { ...target, steamTeamEuRoleIds: [cnRole] }, discordRoleIds: [cnRole] }).status, 'role_conflict');
  assert.equal(matchSteamTeam({ enabled: true, target: { ...target, steamTeamCnRoleIds: 'CN' }, discordRoleIds: [cnRole] }).status, 'no_match');
});

test('unique current roles sync the team, same-ID submissions refresh roles, and exact replays have no team side effects', async t => {
  const syncs = [];
  const f = fixture(t, { service: { syncMemberTeam: input => {
    syncs.push(structuredClone(input));
    return { status: syncs.length === 1 ? 'synced' : 'unchanged', memberId: 'private-member', squadId: input.team.squadId };
  } } }); enableTeams(f);
  const first = await f.submit(firstId, f.open({ discordRoleIds: [euRole] }), { discordRoleIds: [cnOtherRole, cnRole, cnRole] });
  assert.equal(syncs.length, 1); assert.equal(syncs[0].team.code, 'CN'); assert.equal(syncs[0].proof.externalId, userId);
  assert.deepEqual(syncs[0].team.roleIds, [cnRole, cnOtherRole]); assert.equal(f.link().revision, 1);
  assert.equal(f.link().teamSync.memberId, 'private-member'); assert.equal(f.link().ownershipVerified, false);
  const again = await f.submit(firstId, undefined, { discordRoleIds: [cnRole, cnOtherRole] });
  assert.equal(syncs.length, 2); assert.equal(f.link().revision, 1, 'successful no-op sync keeps the link revision');
  const switched = await f.submit(firstId, undefined, { discordRoleIds: [euRole] });
  assert.equal(f.link().teamAssignment.code, 'EU'); assert.equal(f.link().revision, 2);
  assert.equal(syncs.at(-1).link.teamSync.memberId, 'private-member', 'the helper receives the durable deletion anchor');
  const snapshot = f.db.prepare('SELECT * FROM platform_admin_records ORDER BY kind,id').all();
  for (const saved of [first, again, switched]) await f.service.handleVerified(saved.proof);
  assert.equal(syncs.length, 3); assert.deepEqual(f.db.prepare('SELECT * FROM platform_admin_records ORDER BY kind,id').all(), snapshot);
  assert.match(JSON.stringify(switched.result), /Recorded Discord team: EU/);
  assert.doesNotMatch(JSON.stringify(switched.result), /private-member|squad-cn|squad-eu/);
  const viewed = await f.handle('view_user', { values: { user: userId } });
  assert.match(JSON.stringify(viewed), /Recorded Discord team: EU/); assert.doesNotMatch(JSON.stringify(viewed), /private-member/);
});

test('unmatched or conflicting roles preserve recorded teams and never call website sync', async t => {
  let syncs = 0;
  const f = fixture(t, { service: { syncMemberTeam: () => { syncs++; return { status: 'synced', memberId: 'anchor' }; } } }); enableTeams(f);
  await f.submit(firstId, undefined, { discordRoleIds: [cnRole] }); const original = f.link().teamAssignment;
  for (const [roles, status, message] of [[[], 'no_match', /No matching role/], [[cnRole, euRole], 'role_conflict', /Both CN and EU/]]) {
    const saved = await f.submit(firstId, undefined, { discordRoleIds: roles });
    assert.equal(f.link().teamSync.status, status); assert.deepEqual(f.link().teamAssignment, original);
    assert.equal(f.link().teamSync.memberId, 'anchor'); assert.match(JSON.stringify(saved.result), message);
    assert.doesNotMatch(JSON.stringify(saved.result), /Website team sync: Synced/);
    const revision = f.link().revision; await f.submit(firstId, undefined, { discordRoleIds: roles }); assert.equal(f.link().revision, revision);
  }
  assert.equal(syncs, 1);
});

test('replacement confirmation uses its fresh roles and configuration; preview and cancel never sync', async t => {
  const syncs = [], f = fixture(t, { service: { syncMemberTeam: input => { syncs.push(input.team); return { status: 'synced' }; } } }); enableTeams(f);
  await f.submit(firstId, undefined, { discordRoleIds: [cnRole] });
  const cancelled = await f.submit(secondId, undefined, { discordRoleIds: [euRole] });
  await f.handle('cancel', { token: cancelled.token }, { discordRoleIds: [euRole] });
  assert.equal(syncs.length, 1); assert.equal(f.link().steamId, firstId); assert.equal(f.link().teamAssignment.code, 'CN');
  const candidate = await f.submit(secondId, undefined, { discordRoleIds: [cnRole] });
  f.config.targets[0].steamTeamEuSquadId = 'new-eu-squad';
  await f.handle('confirm', { token: candidate.token }, { discordRoleIds: [euRole] });
  assert.equal(syncs.length, 2); assert.equal(syncs[1].code, 'EU'); assert.equal(syncs[1].squadId, 'new-eu-squad');
  assert.equal(f.link().steamId, secondId); assert.equal(f.link().revision, 2);
});

test('turning automatic sync off during resolution preserves existing assignments and never calls the website hook', async t => {
  let syncs = 0;
  const f = fixture(t, { service: { syncMemberTeam: () => { syncs++; return { status: 'synced', memberId: 'anchor' }; } } }); enableTeams(f);
  await f.submit(firstId, undefined, { discordRoleIds: [cnRole] });
  const entered = deferred(), waiting = deferred();
  f.provider.resolveIdentifier = async () => { entered.resolve(); await waiting.promise; return { status: 'ok', steamId: firstId }; };
  const pending = f.submit(firstId, undefined, { discordRoleIds: [euRole] }); await entered.promise;
  f.config.commands[0].autoMatchTeamByRole = false; waiting.resolve(); const { result } = await pending;
  assert.equal(syncs, 1); assert.equal(f.link().teamAssignment.code, 'CN'); assert.equal(f.link().teamSync.status, 'disabled');
  assert.equal(f.link().teamSync.memberId, 'anchor'); assert.match(JSON.stringify(result), /sync is off/);
  const revision = f.link().revision; await f.submit(firstId); assert.equal(f.link().revision, revision);
});

test('failed website hooks roll back only website writes and keep an explicit saved Steam link', async t => {
  for (const status of ['throw', 'identity_conflict', 'member_unavailable', 'squad_unavailable', 'invalid']) {
    let f;
    f = fixture(t, { service: { syncMemberTeam: () => {
      f.db.prepare('INSERT INTO website_team_probe VALUES(?)').run('partial write');
      if (status === 'throw') throw new Error('sensitive adapter details');
      return { status };
    } } }); enableTeams(f); f.db.exec('CREATE TABLE website_team_probe (value TEXT)');
    const { result, proof } = await f.submit(firstId, undefined, { discordRoleIds: [cnRole] });
    assert.equal(f.link().steamId, firstId); assert.equal(f.link().teamAssignment.code, 'CN');
    assert.equal(f.link().teamSync.status, ['throw', 'invalid'].includes(status) ? 'failed' : status);
    assert.equal(f.db.prepare('SELECT count(*) n FROM website_team_probe').get().n, 0);
    assert.match(result.content, /link saved/); assert.doesNotMatch(JSON.stringify(result), /sensitive adapter|Website team sync: Synced/);
    await f.service.handleVerified(proof); assert.equal(f.link().revision, 1);
  }
});

test('a missing website adapter and an unavailable source profile still acknowledge the saved link and team sync failure', async t => {
  const f = fixture(t); enableTeams(f);
  f.provider.resolveIdentifier = async () => ({ status: 'ok', steamId: firstId });
  f.provider.readProfile = async () => ({ status: 'unavailable' });
  const { result } = await f.submit(firstId, undefined, { discordRoleIds: [cnRole] });
  assert.equal(f.link().teamSync.status, 'failed'); assert.match(result.content, /Steam link saved/);
  assert.match(result.content, /Recorded Discord team: CN/); assert.match(result.content, /Website sync failed/);
  assert.deepEqual(result.embeds, []);
});

test('website sync is rolled back with a failed outer Steam link write', async t => {
  let f;
  f = fixture(t, { service: { syncMemberTeam: () => {
    f.db.prepare('INSERT INTO website_team_probe VALUES(?)').run('successful website change'); return { status: 'synced' };
  } } }); enableTeams(f); f.db.exec('CREATE TABLE website_team_probe (value TEXT)');
  const token = f.open();
  f.db.exec("CREATE TRIGGER fail_steam_link BEFORE INSERT ON platform_admin_records WHEN NEW.kind='discord-steam-link' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  const { result } = await f.submit(firstId, token, { discordRoleIds: [cnRole] });
  assert.match(result.content, /not saved/); assert.equal(f.link(), null); assert.equal(f.db.prepare('SELECT count(*) n FROM website_team_probe').get().n, 0);
});

test('manual website teams remain explicit and failed retries preserve the existing member anchor', async t => {
  let syncStatus = 'manual_preserved';
  const f = fixture(t, { service: { syncMemberTeam: () => {
    if (syncStatus === 'throw') throw new Error('failed');
    return { status: syncStatus, memberId: 'original-member', squadId: 'manual-squad' };
  } } }); enableTeams(f);
  const first = await f.submit(firstId, undefined, { discordRoleIds: [cnRole] });
  assert.match(JSON.stringify(first.result), /Manual website team kept/); assert.doesNotMatch(JSON.stringify(first.result), /original-member|manual-squad/);
  syncStatus = 'throw'; const retried = await f.submit(firstId, undefined, { discordRoleIds: [euRole] });
  assert.equal(f.link().teamSync.memberId, 'original-member'); assert.equal(f.link().teamSync.status, 'failed');
  assert.equal(f.link().teamAssignment.code, 'EU'); assert.match(JSON.stringify(retried.result), /Website sync failed/);
});

test('six locales show team status privately in profiles and 20-row lists without leaking member IDs or exceeding Discord limits', async t => {
  const expected = { 'zh-CN': '已同步', 'en-US': 'Synced', ru: 'Синхронизировано', tr: 'Eşitlendi', th: 'ซิงค์แล้ว', ko: '동기화됨' };
  for (const [locale, marker] of Object.entries(expected)) {
    const f = fixture(t, { service: { syncMemberTeam: () => ({ status: 'synced', memberId: 'hidden-member', squadId: 'hidden-squad' }) } }); enableTeams(f);
    const saved = await f.submit(firstId, undefined, { discordRoleIds: [cnRole], locale });
    assert.ok(JSON.stringify(saved.result).includes(marker));
    const members = Array.from({ length: 21 }, (_, index) => ({ discordId: String(BigInt(userId) + BigInt(index)), displayName: '\\_*[]`@everyone<@123>'.repeat(20), bot: false }));
    for (const member of members) f.repo.putRecord('link', steamLinkKey(guildId, member.discordId), { ...f.link(), discordId: member.discordId }, userId, f.now());
    f.provider.listGuildMembers = async () => ({ status: 'ok', complete: true, members });
    const p = f.proof('view_all', {}, { discordPermissions: '32', locale }), list = await f.service.handleVerified(p);
    assert.equal(list.embeds[0].description.split('\n').length, 20); assert.ok(list.embeds[0].description.includes(`CN · ${marker}`));
    for (const payload of [saved.result, list]) {
      assert.ok((payload.embeds[0].description || '').length <= 4096);
      assert.doesNotMatch(JSON.stringify(payload), /hidden-member|hidden-squad|<@|@everyone/);
      const { flags, ...body } = payload; assert.equal(flags, 64);
      assert.doesNotThrow(() => buildNativePrivateResponseRequest({ platform: 'discord', verifiedInteraction: {
        externalId: userId, interactionId: '1199000000000000999', channelId,
        privateReplyContext: { applicationId: '1199000000000000998', interactionToken: 'constructed-test-token' },
      }, payload: body }));
    }
    f.service.bindPrivateMessage(p, list, messageId);
    const page = await f.handle('page', { token: tokenOf(list), page: 1 }, { discordPermissions: '32', locale });
    assert.equal(page.embeds[0].description.split('\n').length, 1); assert.match(page.embeds[0].description, /^21\. /);
  }
});

test('every team outcome is localized in all six languages and unsupported languages fall back to English', () => {
  const statuses = ['synced', 'unchanged', 'manual_preserved', 'identity_conflict', 'member_unavailable', 'squad_unavailable', 'no_match', 'role_conflict', 'disabled', 'failed'];
  for (const status of statuses) {
    const link = { teamAssignment: { code: 'CN' }, teamSync: { status, memberId: 'hidden-member' } };
    for (const locale of ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko']) {
      for (const compact of [true, false]) {
        const rendered = steamTeamSummary(link, locale, { compact });
        assert.match(rendered, /CN/); assert.doesNotMatch(rendered, /team[A-Z]|undefined|hidden-member/);
      }
    }
    assert.equal(steamTeamSummary(link, 'not-supported'), steamTeamSummary(link, 'en'));
  }
});
