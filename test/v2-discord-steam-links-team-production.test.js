import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createFixture } from './support/v2-notifications/fixture.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { installNotificationBusinessSchema } from '../server/v2/notifications/index.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { DiscordSteamLinksRepository } from '../server/v2/discord-steam-links/repository.js';

test('production signed setsteam callbacks update canonical website rows and queued cache only when role matching is explicitly enabled', async t => {
  for (const enabled of [false, true]) {
    const f = createFixture({ adminRole: true });
    installPlatformAdminSchema(f.db); installMemberAdminSchema(f.db); installNotificationBusinessSchema(f.db);
    const keys = generateKeyPairSync('ed25519'), applicationId = '300000000000000001', guildId = '300000000000000002',
      channelId = '300000000000000003', userId = '300000000000000004', messageId = '300000000000000005',
      cnRole = '300000000000000006', euRole = '300000000000000007', steamId = '76561198000000001';
    const config = { enabled: true, revision: 1, applicationId,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
      commands: ['setsteam', 'view'].map(id => ({ id, type: 'slash_command', slashCommand: id, enabled: true,
        ...(enabled && id === 'setsteam' ? { autoMatchTeamByRole: true } : {}) })),
      targets: [{ id: 'personal', guildId, channelId, enabled: true, enabledCommandIds: ['setsteam', 'view'],
        steamTeamCnRoleIds: [cnRole], steamTeamEuRoleIds: [euRole], steamTeamCnSquadId: 'sq1', steamTeamEuSquadId: 'sq2' }] };
    const now = Date.parse('2026-10-15T12:00:00Z'), calls = [], links = new DiscordSteamLinksRepository(f.db);
    const cache = { members: structuredClone(f.identity.repo.all('members')), squadMembers: structuredClone(f.identity.repo.all('squadMembers')) };
    const beforeCache = structuredClone(cache), accounts = f.identity.repo.all('accounts'), bindings = f.identity.repo.all('bindings');
    let ready = false, queued = false, patches = 0, sequence = 300000000000000100n;
    const profile = { status: 'ok', steamId, displayName: 'Fixture Steam player', fetchedAt: new Date(now).toISOString() };
    const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity,
      getPlatformService: () => { assert.ok(ready, 'configuration is read lazily after system construction');
        return { identity: f.identity, config: platform => platform === 'discord' ? config : { enabled: false, commands: [], targets: [] } }; },
      publicOrigin: 'https://nb.example', readCredentials: () => ({ botToken: 'fixture-only-token' }), now: () => now,
      steamLinksProvider: { async resolveIdentifier(value) { assert.equal(value, steamId); return { status: 'ok', steamId, profile }; },
        async readProfile(value) { assert.equal(value, steamId); return profile; } },
      runStoreWriteTask: async work => {
        assert.equal(queued, false); queued = true;
        try { return await work(); } finally { queued = false; }
      },
      patchStoreCache: async updater => {
        assert.equal(queued, true, 'cache projection remains inside the shared store write queue');
        assert.equal(f.db.isTransaction, false, 'cache only reads committed website changes');
        assert.equal(links.getLink(guildId, userId)?.steamId, steamId, 'Steam receipt/link commits before cache projection');
        patches++; updater(cache);
      },
      fetchImpl: async (url, options) => {
        assert.match(url, /^https:\/\/discord\.com\/api\/v10\/webhooks\/300000000000000001\/[^/]+\/messages\/@original$/);
        assert.equal(options.method, 'PATCH', 'only the original private interaction response is updated');
        const body = JSON.parse(options.body); calls.push(body);
        assert.equal(Object.hasOwn(body, 'flags'), false, 'private visibility belongs to the initial ACK');
        assert.deepEqual(body.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
        return new Response(JSON.stringify({ id: messageId, channel_id: channelId }), { status: 200 });
      } });
    t.after(async () => { await owner.stop(); await f.system.worker.stop(); f.close(); });
    owner.getSystem(f.identity); ready = true;
    async function run(data, type = 2, roles = [cnRole]) {
      const event = { id: String(sequence++), application_id: applicationId, type, guild_id: guildId, channel_id: channelId,
        token: 'fixture-private-token', locale: 'en-US', member: { user: { id: userId, username: 'Signed test member' }, roles, permissions: '0' }, data };
      const rawBody = Buffer.from(JSON.stringify(event)), timestamp = String(now / 1000), acks = [];
      await owner.handleCallback('discord', { rawBody, headers: { 'x-signature-timestamp': timestamp,
        'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.privateKey).toString('hex') } },
      { ack(payload) { acks.push(payload); } });
      return acks;
    }
    async function setsteam(roles) {
      const priorReplies = calls.length, opened = await run({ name: 'setsteam', type: 1 }, 2, roles);
      assert.equal(opened.length, 1); assert.equal(opened[0].type, 9); assert.equal(calls.length, priorReplies);
      const acks = await run({ custom_id: opened[0].data.custom_id, components: [
        { type: 1, components: [{ type: 4, custom_id: 'identifier', value: steamId }] },
      ] }, 5, roles);
      assert.deepEqual(acks, [{ type: 5, data: { flags: 64 } }]); assert.equal(calls.length, priorReplies + 1);
      return calls.at(-1);
    }
    const saved = await setsteam([cnRole]); assert.match(saved.content, /Steam link saved/);
    assert.equal(links.getLink(guildId, userId).steamId, steamId);
    if (!enabled) {
      assert.equal(config.commands[0].autoMatchTeamByRole, undefined, 'omitted configuration remains off');
      assert.equal(f.identity.repo.all('members').some(row => row.discordId === userId), false);
      assert.deepEqual(cache, beforeCache); assert.equal(patches, 0);
      assert.equal(links.getLink(guildId, userId).teamAssignment, undefined);
      assert.deepEqual(f.identity.repo.all('squadMembers'), beforeCache.squadMembers);
    } else {
      const member = f.identity.repo.all('members').find(row => row.discordId === userId);
      assert.ok(member); assert.equal(member.steamId, ''); assert.equal(member.discordSteamDeclaration.ownershipVerified, false);
      assert.equal(links.getLink(guildId, userId).teamSync.status, 'synced'); assert.equal(patches, 1);
      assert.deepEqual(cache.members.find(row => row.id === member.id), member);
      const initialRelation = f.identity.repo.all('squadMembers').find(row => row.memberId === member.id);
      assert.equal(initialRelation.squadId, 'sq1'); assert.deepEqual(cache.squadMembers.find(row => row.id === initialRelation.id), initialRelation);
      assert.match(JSON.stringify(saved), /Recorded Discord team: CN/); assert.ok(!JSON.stringify(saved).includes(member.id));
      const changed = await setsteam([euRole]); assert.match(changed.content, /already linked/);
      assert.equal(links.getLink(guildId, userId).teamAssignment.code, 'EU'); assert.equal(patches, 2);
      const currentMember = f.identity.repo.get('members', member.id), currentRelations = f.identity.repo.all('squadMembers').filter(row => row.memberId === member.id);
      assert.equal(currentRelations.length, 1); assert.equal(currentRelations[0].squadId, 'sq2');
      assert.deepEqual(cache.members.find(row => row.id === member.id), currentMember);
      assert.deepEqual(cache.squadMembers.filter(row => row.memberId === member.id), currentRelations);
      assert.equal(cache.squadMembers.some(row => row.id === initialRelation.id), false, 'old automatic relation is removed from cache');
      for (const row of beforeCache.members) assert.deepEqual(cache.members.find(current => current.id === row.id), row);
    }
    assert.deepEqual(f.identity.repo.all('accounts'), accounts); assert.deepEqual(f.identity.repo.all('bindings'), bindings);
    assert.equal(f.identity.repo.all('identities').length, 0, 'manual declarations never create website login identities');
  }
});
