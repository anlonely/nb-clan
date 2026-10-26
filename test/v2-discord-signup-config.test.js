import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';

const command = overrides => ({ id: 'wipe', name: 'wipe-react', type: 'event_command', enabled: true, slashCommand: 'wipe-react', ...overrides });
const invalid = error => ['PLATFORM_INPUT_INVALID','WIPE_SIGNUP_MODE_INVALID'].includes(error.errorCode);

test('Discord Wipe signup defaults to member registration for saved legacy configuration', () => {
  assert.equal(normalizeConfig('discord', { commands: [command()] }).commands[0].signupMode, 'member_required');
});

test('Discord Wipe signup accepts both configured versions without changing other command fields', () => {
  for (const signupMode of ['discord_only', 'member_required']) {
    assert.deepEqual(normalizeConfig('discord', { commands: [command({ signupMode })] }).commands[0], command({ signupMode }));
  }
});

test('signup version is constrained to the Discord Wipe command and supported values', () => {
  for (const signupMode of ['unverified', '', 'steam', true]) {
    assert.throws(() => normalizeConfig('discord', { commands: [command({ signupMode })] }), invalid);
  }
  assert.equal(normalizeConfig('discord', {commands:[command({signupMode:null})]}).commands[0].signupMode,'member_required');
  for (const id of ['ranking', 'unrelated']) {
    assert.throws(() => normalizeConfig('discord', { commands: [command({ id, signupMode: 'discord_only' })] }), invalid);
  }
  const legacyCard = normalizeConfig('discord', { commands: [command({id:'signup_card', signupMode:'discord_only'})] }).commands[0];
  assert.equal(legacyCard.id,'wipe');
  assert.equal(legacyCard.signupMode,'discord_only');
  assert.throws(() => normalizeConfig('kook', { commands: [command({ signupMode: 'discord_only' })] }), invalid);
  assert.equal(Object.hasOwn(normalizeConfig('kook', { commands: [command({type:'slash_command',slashCommand:'wipe'})] }).commands[0], 'signupMode'), false);
});

function catalogSetup(t, signupMode) {
  const commands = [command(signupMode ? { signupMode } : {}), ...['signup_card', 'server_connect_card', 'electrician_ids_card', 'welcome_guide_card'].map(id => ({ id, type: 'persistent_card', enabled: true }))];
  const config = platform => ({ enabled: true, revision: 1, commands: platform === 'discord' ? commands : commands.filter(row=>row.id!=='wipe').map(({ signupMode: _signupMode, ...row }) => row),
    targets: [{ id: `${platform}-server`, name: 'RSG', guildId: `${platform}-guild`, channelId: 'general', enabled: true,
      enabledCommandIds: commands.map(row => row.id), signupCardChannelId: 'signup', serverConnectChannelId: 'connect',
      electricianChannelId: 'electricians', welcomeGuideChannelId: 'announcement' }] });
  const configs = { discord: config('discord'), kook: config('kook') }, identity = {};
  const owner = createProductionNotificationOwner({ getIdentity: async () => identity,
    getPlatformService: () => ({ identity, config: platform => configs[platform] }),
    publicOrigin: 'https://nb.example', readCredentials: () => ({ botToken: 'constructed-test-token' }) });
  t.after(() => owner.stop());
  return { catalog: owner.catalog, configs };
}

test('production Discord catalog applies the default version to every derived card without altering KOOK', t => {
  const { catalog } = catalogSetup(t);
  const targets = catalog.listTargets();
  assert.equal(targets.filter(target => target.platform === 'discord').length, 5);
  assert.ok(targets.filter(target => target.platform === 'discord').every(target => target.signupMode === 'member_required'));
  assert.ok(targets.filter(target => target.platform === 'kook').every(target => !Object.hasOwn(target, 'signupMode')));
});

test('production catalog reads changed signup configuration for existing targets and original cards', t => {
  const { catalog, configs } = catalogSetup(t, 'member_required');
  const first = catalog.listTargets().filter(target => target.platform === 'discord');
  assert.ok(first.every(target => target.signupMode === 'member_required'));
  configs.discord.commands[0].signupMode = 'discord_only';
  configs.discord.revision++;
  const current = catalog.listTargets().filter(target => target.platform === 'discord');
  assert.deepEqual(current.map(target => target.id), first.map(target => target.id));
  assert.ok(current.every(target => target.signupMode === 'discord_only' && target.configurationRevision === 2));
});
