import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createFixture } from './support/v2-notifications/fixture.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { installNotificationBusinessSchema } from '../server/v2/notifications/index.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';

test('production owner wires native Steam callbacks, actual private message binding and rechecked permissions without public sends', async t => {
  const f = createFixture({ adminRole: true });
  installPlatformAdminSchema(f.db); installNotificationBusinessSchema(f.db);
  const keys = generateKeyPairSync('ed25519'), applicationId = '100000000000000001', guildId = '100000000000000002',
    channelId = '100000000000000003', userId = '100000000000000004', messageId = '100000000000000005';
  const config = { enabled: true, revision: 1, applicationId,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    commands: ['setsteam', 'view'].map(id => ({ id, type: 'slash_command', slashCommand: id, enabled: true })),
    targets: [{ id: 'personal', guildId, channelId, enabled: true, enabledCommandIds: ['setsteam', 'view'] }] };
  const now = Date.parse('2026-10-15T10:00:00Z'), calls = [];
  let ready = false, sequence = 100000000000000100n, memberReads = 0;
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity,
    getPlatformService: () => { assert.ok(ready, 'must not re-enter management during construction');
      return { identity: f.identity, config: platform => platform === 'discord' ? config : { enabled: false, commands: [], targets: [] } }; },
    publicOrigin: 'https://nb.example', readCredentials: () => ({ botToken: 'fixture-only-token' }), now: () => now,
    steamLinksProvider: { async listGuildMembers() { memberReads++; return { status: 'ok', complete: true,
      members: Array.from({ length: 21 }, (_, index) => ({ discordId: String(100000000000001000n + BigInt(index)), displayName: `Member ${index}`, bot: false })) }; } },
    fetchImpl: async (url, options) => {
      assert.match(url, /^https:\/\/discord\.com\/api\/v10\/webhooks\/100000000000000001\/[^/]+\/messages\/@original$/);
      assert.equal(options.method, 'PATCH');
      const body = JSON.parse(options.body); calls.push(body);
      assert.deepEqual(body.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
      return new Response(JSON.stringify({ id: messageId, channel_id: channelId }), { status: 200 });
    } });
  t.after(async () => { await owner.stop(); await f.system.worker.stop(); f.close(); });
  owner.getSystem(f.identity); ready = true;
  const run = async (data, type = 2, patch = {}) => {
    const event = { id: String(sequence++), application_id: applicationId, type, guild_id: guildId, channel_id: channelId,
      token: 'fixture-private-token', locale: 'en-US', member: { user: { id: userId }, roles: [], permissions: '32' }, data, ...patch };
    const rawBody = Buffer.from(JSON.stringify(event)), timestamp = String(now / 1000), acks = [];
    await owner.handleCallback('discord', { rawBody, headers: { 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.privateKey).toString('hex') } },
    { ack(payload) { acks.push(payload); } });
    return acks;
  };
  assert.deepEqual(await run({ name: 'view', options: [{ type: 1, name: 'nosteam' }] }), [{ type: 5, data: { flags: 64 } }]);
  assert.equal(memberReads, 1);
  const context = JSON.parse(f.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='discord-steam-context'").get().payload);
  assert.equal(context.originMessageId, messageId);
  const page = calls[0].components[0].components.find(component => component.custom_id?.endsWith(':1')).custom_id;
  assert.deepEqual(await run({ component_type: 2, custom_id: page }, 3, { message: { id: messageId, flags: 64 } }), [{ type: 6 }]);
  assert.match(calls[1].embeds[0].footer.text, /2\/2/); assert.equal(memberReads, 2);
  config.targets[0].enabledCommandIds = [];
  await run({ component_type: 2, custom_id: page }, 3, { message: { id: messageId, flags: 64 } });
  assert.equal(memberReads, 2); assert.equal(calls[2].components.length, 0);
  assert.match(calls[2].content, /unavailable|access/i);
});
