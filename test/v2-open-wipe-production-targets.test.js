import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createFixture } from './support/v2-notifications/fixture.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { openWipeTargetId } from '../server/v2/discord-open-wipe/service.js';
import { installNotificationBusinessSchema, installNotificationOpenWipeSchema } from '../server/v2/notifications/index.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';

const personalGuild = '1153571748147634236', rsgGuild = '1554983512321425488';
const channel = '1482399564274204774', otherChannel = '1482399564274204775';
const command = { id: 'newwipe', type: 'event_command', slashCommand: 'newwipe', enabled: true };
const personal = () => ({ id: 'personal', name: 'Personal test', guildId: personalGuild,
  channelId: channel, enabled: true, enabledCommandIds: ['newwipe'] });
const openTargets = owner => owner.catalog.listTargets().filter(target => target.id.startsWith('open_wipe_'));

function setup(t, { migrated = false, beforePlatformRead = () => {} } = {}) {
  const f = createFixture({ adminRole: true });
  installPlatformAdminSchema(f.db); installNotificationBusinessSchema(f.db);
  if (migrated) installNotificationOpenWipeSchema(f.db);
  const configs = {
    discord: { enabled: true, revision: 31, commands: [{ id: 'wipe', type: 'event_command',
      slashCommand: 'wipe-react', signupMode: 'discord_only', enabled: true }],
    targets: [{ id: 'rsg', name: 'Clan Portal', guildId: rsgGuild, channelId: '1554983512321425489',
      signupCardChannelId: '1554983512321425490', enabled: true, enabledCommandIds: ['wipe'] }] },
    kook: { enabled: false, revision: 1, commands: [], targets: [] },
  };
  const { publicKey } = generateKeyPairSync('ed25519');
  configs.discord.publicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const platformService = { identity: f.identity, config: platform => configs[platform],
    channelCatalogs: platform => platform === 'discord' ? [{ guildId: personalGuild,
      items: [{ id: channel, label: 'sync-test' }, { id: otherChannel, label: 'second-test' }] }] : [] };
  let identityReads = 0, platformReads = 0, sends = 0;
  const owner = createProductionNotificationOwner({ getIdentity: async () => { identityReads++; await Promise.resolve(); return f.identity; },
    getPlatformService: () => { platformReads++; beforePlatformRead(); return platformService; }, publicOrigin: 'https://nb.example', intervalMs: 60000,
    readCredentials: () => ({ botToken: 'constructed-fixture-token' }),
    fetchImpl: async () => { sends++; assert.fail('catalog and empty startup must not send any native request'); } });
  t.after(async () => { await owner.stop(); await f.system.worker.stop(); f.close(); });
  return { ...f, owner, configs, identityReads: () => identityReads, platformReads: () => platformReads, sends: () => sends };
}

test('open-wipe production targets require an enabled command and explicit target assignment', t => {
  const f = setup(t), { owner, configs } = f;
  configs.discord.targets.push(personal());
  assert.deepEqual(openTargets(owner), []);
  configs.discord.commands.push({ ...command, enabled: false });
  assert.deepEqual(openTargets(owner), []);
  configs.discord.commands.at(-1).enabled = true;
  const expectedId = openWipeTargetId('personal', channel);
  assert.deepEqual(openTargets(owner).map(target => target.id), [expectedId]);
  assert.equal(owner.catalog.getTarget(expectedId).enabled, true);
  configs.discord.targets.at(-1).enabledCommandIds = [];
  assert.deepEqual(openTargets(owner), []);
  configs.discord.targets.at(-1).enabledCommandIds = ['newwipe'];
  configs.discord.targets.at(-1).enabled = false;
  assert.equal(owner.catalog.getTarget(expectedId).enabled, false);
  configs.discord.targets.at(-1).enabled = true; configs.discord.enabled = false;
  assert.equal(owner.catalog.getTarget(expectedId).enabled, false);
  configs.kook = { enabled: true, commands: [command], targets: [{ ...personal(), id: 'kook-test' }] };
  assert.equal(openTargets(owner).some(target => target.platform === 'kook'), false);
  assert.equal(f.sends(), 0);
});

test('personal-guild configuration preserves every existing RSG target and uses English-first six-language targets', t => {
  const { owner, configs, sends } = setup(t), originalConfig = structuredClone(configs.discord.targets[0]);
  const rsgBefore = owner.catalog.listTargets().filter(target => target.guildId === rsgGuild);
  configs.discord.commands.push(command); configs.discord.targets.push(personal());
  const selected = openTargets(owner);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].guildId, personalGuild);
  assert.equal(selected[0].channelId, channel);
  assert.equal(selected[0].channelLabel, 'sync-test');
  assert.equal(selected[0].transportKey, `production:discord:${selected[0].id}`);
  assert.deepEqual(selected[0].languages, ['en', 'zh-CN', 'ru', 'tr', 'th', 'ko']);
  assert.deepEqual(owner.catalog.listTargets().filter(target => target.guildId === rsgGuild), rsgBefore);
  assert.deepEqual(configs.discord.targets[0], originalConfig);
  assert.equal(selected.some(target => target.guildId === rsgGuild), false);
  assert.equal(sends(), 0);
});

test('explicit open-wipe channels override the general channel and removed channels disappear immediately', t => {
  const { owner, configs } = setup(t);
  configs.discord.commands.push(command); configs.discord.targets.push(personal());
  const target = configs.discord.targets.at(-1);
  target.newwipeChannelIds = [];
  assert.deepEqual(openTargets(owner).map(item => item.channelId), [channel]);
  target.newwipeChannelIds = [otherChannel, otherChannel];
  assert.deepEqual(openTargets(owner).map(item => item.channelId), [otherChannel]);
  assert.equal(owner.catalog.getTarget(openWipeTargetId('personal', channel)), null);
  assert.equal(owner.catalog.getTarget('personal').channelId, channel);
  const before = openTargets(owner)[0];
  target.newwipeAllowedRoleIds = ['1482399564274204776']; target.newwipeAllowAdministrators = false;
  assert.equal(openTargets(owner)[0].id, before.id);
  target.newwipeChannelIds = [channel, otherChannel];
  assert.equal(openTargets(owner).length, 2);
  target.newwipeChannelIds = [channel];
  assert.equal(owner.catalog.getTarget(before.id), null);
});

test('an old database without the optional marker starts through the async production identity provider without mutation or sends', async t => {
  const f = setup(t), { owner } = f;
  assert.equal(f.system.service.repo.scalar('v2NotificationOpenWipeSchemaVersion'), null);
  const before = f.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
  owner.catalog.listTargets();
  await owner.start();
  assert.equal(f.identityReads(), 1);
  assert.equal(owner.getSystem(f.identity).service.identity, f.identity);
  assert.equal(owner.diagnostics().started, true);
  assert.equal(owner.diagnostics().timerActive, true);
  assert.equal(f.system.service.repo.scalar('v2NotificationOpenWipeSchemaVersion'), null);
  assert.deepEqual(f.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before);
  assert.equal(f.sends(), 0);
});

test('the migrated production owner registers the open-wipe domain with the resolved identity and does not publish on startup', async t => {
  const f = setup(t, { migrated: true });
  f.configs.discord.commands.push(command); f.configs.discord.targets.push(personal());
  await f.owner.start();
  assert.equal(f.owner.diagnostics().started, true);
  assert.equal(f.owner.getSystem(f.identity).service.identity, f.identity);
  assert.equal(f.system.service.repo.scalar('v2NotificationOpenWipeSchemaVersion'), 1);
  assert.equal(openTargets(f.owner).length, 1);
  assert.equal(f.sends(), 0);
});

test('initializing the migrated notification system does not reenter the management owner before it is ready', async t => {
  let managementReady = false;
  const f = setup(t, { migrated: true, beforePlatformRead() {
    if (!managementReady) throw new Error('Management owner initialization was reentered');
  } });
  f.configs.discord.commands.push(command); f.configs.discord.targets.push(personal());
  // Production management creates HexQuery with notifications.getSystem() while
  // management.getSystem() is still constructing its own canonical instance.
  let system;
  assert.doesNotThrow(() => { system = f.owner.getSystem(f.identity); });
  assert.equal(system.service.identity, f.identity);
  assert.equal(f.platformReads(), 0);
  managementReady = true;
  assert.equal(openTargets(f.owner).length, 1);
  assert.ok(f.platformReads() > 0);
  await f.owner.start();
  assert.equal(f.owner.getSystem(f.identity), system);
  assert.equal(f.owner.diagnostics().started, true);
  assert.equal(f.sends(), 0);
});
