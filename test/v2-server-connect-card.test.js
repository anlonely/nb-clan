import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { SERVER_CONNECT_COMMAND_ID, serverConnectDetails, serverConnectPayload, serverConnectTargetId, discordServerConnectPayload, resolveServerConnectIp } from '../server/v2/platform-admin/server-connect-card.js';

test('server connect card uses saved KOOK channel and native copyable code block', () => {
  const config = normalizeConfig('kook', { enabled: true, targets: [{ id: 'guild-target', name: 'RSG', guildId: 'guild', channelId: 'general', serverConnectChannelId: 'connect-channel', enabled: true, enabledCommandIds: [SERVER_CONNECT_COMMAND_ID] }], commands: [{ id: SERVER_CONNECT_COMMAND_ID, name: '服务器直连卡片', type: 'persistent_card', enabled: true }] });
  assert.equal(config.targets[0].serverConnectChannelId, 'connect-channel');
  assert.match(serverConnectTargetId(config.targets[0].id), /^server_connect_[0-9a-f]{24}$/);
  const details = serverConnectDetails({ serverSnapshot: { name: 'Atlas - US 2X Monthly Large', connectCommand: 'client.connect 2xmonthly.atlasrust.us:28010' }, serverScheduledWipeAt: '2026-09-24T21:00:00.000Z' });
  assert.equal(details.wipeTime, '2026-09-25 05:00（UTC+8）');
  const payload = serverConnectPayload('connect-channel', details);
  assert.equal(payload.target_id, 'connect-channel');
  const card = JSON.parse(payload.content)[0];
  assert.equal(card.modules[1].text.content, 'Atlas - US 2X Monthly Large');
  assert.match(card.modules.at(-1).text.content, /```\nclient\.connect 2xmonthly\.atlasrust\.us:28010\n```/);
  assert.doesNotMatch(payload.content, /\(met\)all\(met\)/);
  assert.equal(serverConnectDetails({ serverSnapshot: { name: 'Atlas', connectCommand: 'connect host:28010\n(met)all(met)' }, serverScheduledWipeAt: '2026-09-24T21:00:00Z' }), null);
});

test('Discord direct connect card uses an English embed and a separate target', () => {
  assert.notEqual(serverConnectTargetId('guild-target', 'discord'), serverConnectTargetId('guild-target'));
  const details = serverConnectDetails({ serverSnapshot: { name: 'Atlas - US 2X', connectCommand: 'client.connect 2xmonthly.atlasrust.us:28010' }, serverScheduledWipeAt: '2026-09-24T21:00:00.000Z' });
  const payload = discordServerConnectPayload(details);
  assert.equal(payload.embeds[0].title, '⚡ Server Direct Connect');
  assert.equal(payload.embeds[0].fields[0].value, `<t:${Date.parse('2026-09-24T21:00:00Z') / 1000}:F>`);
  assert.doesNotMatch(JSON.stringify(payload), /UTC\+8|Asia\/Shanghai/);
  assert.match(payload.embeds[0].fields[1].value, /```\nclient\.connect 2xmonthly\.atlasrust\.us:28010\n```/);
  assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
});

test('KOOK card places the wipe title and resolved IP command in separate copy blocks', async () => {
  const command = 'client.connect 2xmonthly.atlasrust.us:28010';
  const ip = await resolveServerConnectIp(command, async host => {
    assert.equal(host, '2xmonthly.atlasrust.us');
    return ['216.39.240.89'];
  });
  const details = serverConnectDetails({ title: 'Atlas US 2x 月服  大官',
    serverSnapshot: { name: 'Atlas - US 2X Monthly Large', connectCommand: command },
    serverScheduledWipeAt: '2026-10-01T18:00:00.000Z' }, ip);
  const modules = JSON.parse(serverConnectPayload('connect-channel', details).content)[0].modules;
  assert.equal(modules[1].text.content, 'Atlas US 2x 月服 大官');
  assert.equal(modules[2].text.content, 'Atlas - US 2X Monthly Large');
  assert.equal(modules[4].text.content, '**WIPE 时间**\n2026-10-02 02:00（UTC+8）');
  assert.match(modules[5].text.content, /```\nclient\.connect 2xmonthly\.atlasrust\.us:28010\n```/);
  assert.equal(modules[6].text.content, '**IP 直连 · 点击代码块复制**\n```\nclient.connect 216.39.240.89:28010\n```');
  assert.equal(await resolveServerConnectIp('client.connect 216.39.240.89:28010', async () => { throw Error('unexpected lookup'); }), null);
});
