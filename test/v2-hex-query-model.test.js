import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, COMMAND_TEMPLATE, SERVER_KEYS, commandPayload, parseFreshCard } from '../server/v2/hex-query/model.js';
import { parseHexaytronMessageProfile } from '../server/v2/management-adapters/sources/hexaytron.js';
const steam = '76561198000000001', request = '900000000000000010', at = Date.parse('2030-09-08T10:00:00Z');
const config = { enabled: true, revision: 'test-1', targetId: 'target', guildId: '100000000000000001', channelId: '200000000000000001',
  senderBotId: '300000000000000001', replyBotId: '400000000000000001', replyApplicationId: '500000000000000001', transportKey: 'isolated', commandTemplate: COMMAND_TEMPLATE };
const card = () => ({ id: '900000000000000011', channel_id: config.channelId, guild_id: config.guildId, timestamp: new Date(at).toISOString(),
  author: { id: config.replyBotId, bot: true }, application_id: config.replyApplicationId, content: steam,
  embeds: [{ fields: [...SERVER_KEYS.map(name => ({ name, value: '0 hours' })), { name: 'Rust', value: '100 hours' }, { name: 'First Seen', value: '3 days ago' }] }] });
const parse = message => parseFreshCard(message, { config, steamId: steam, requestMessageId: request, notBefore: at, now: at });
test('default disabled and fixed trusted command cannot accept arbitrary text', () => {
  assert.deepEqual(configuration(), { enabled: false }); assert.deepEqual(configuration({ enabled: false }), { enabled: false });
  assert.throws(() => configuration({ ...config, commandTemplate: '/other @everyone {steamId}' }), { errorCode: 'SOURCE_NOT_CONFIGURED' });
  const c = configuration(config); assert.equal(c.timeoutMs, 10000); assert.equal(c.intervalMs, 750); assert.equal(c.messageLimit, 20);
  assert.equal(commandPayload(steam).payload.content, '/player identifier:' + steam);
  assert.deepEqual(commandPayload(steam).payload.allowed_mentions.parse, []);
});
test('complete original Hex parser retains six server fields, zero, Rust hours and first-seen', () => {
  const p = parse(card()); assert.equal(p.servers.length, 6); assert.equal(p.servers[0].hours, 0);
  assert.equal(p.rustHours, 100); assert.equal(p.rustMinutes, 6000); assert.equal(p.firstSeenDaysAgo, 3);
});
for (const [name, mutate] of [
  ['old message', m => { m.id = request; }], ['wrong channel', m => { m.channel_id = '200000000000000002'; }],
  ['wrong guild', m => { m.guild_id = '100000000000000002'; }], ['wrong bot', m => { m.author.id = config.senderBotId; }],
  ['unverified bot type', m => { m.author.bot = false; }], ['webhook impersonation', m => { m.webhook_id = config.replyBotId; }],
  ['wrong app', m => { m.application_id = '500000000000000002'; }], ['old timestamp', m => { m.timestamp = new Date(at - 1).toISOString(); }],
  ['missing Steam', m => { m.content = 'profile'; }], ['wrong Steam', m => { m.content = '76561198000000002'; }],
  ['multiple Steam IDs', m => { m.content += ' 76561198000000002'; }], ['partial card', m => { m.embeds[0].fields.pop(); }],
  ['wrong request reference', m => { m.message_reference = { message_id: '900000000000000001' }; }]
]) test(`independent provenance rejects ${name} before legacy parser result is trusted`, () => { const m = card(); mutate(m); assert.equal(parse(m), null); });
test('old parser labels requested Steam even when card belongs to someone else; strict gate prevents this', () => {
  const m = card(); m.content = '76561198000000002'; assert.equal(parseHexaytronMessageProfile(m, steam).steamId, steam); assert.equal(parse(m), null);
});
