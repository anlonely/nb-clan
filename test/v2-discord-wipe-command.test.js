import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, stripRetiredRegistrationConfig } from '../server/v2/platform-admin/model.js';
import { normalizeDiscordWipeConfig } from '../server/v2/platform-admin/wipe-command.js';
import { retainedDiscordCommandSchemas } from '../server/v2/notification-platforms/native-interactions.js';
import { planPlatformMigration } from '../server/v2/platform-admin/migration.js';

const legacy = () => ({ enabled: true, commands: [
  { id: 'wipe', name: 'Wipe 登记', type: 'slash_command', slashCommand: '/wipe', enabled: false, titleTemplate: 'original', bodyTemplate: 'original body', signupMode: 'discord' },
  { id: 'ranking', name: '排行', type: 'persistent_card', enabled: false },
  { id: 'signup_card', name: 'Wipe Sign-up', type: 'persistent_card', enabled: true }
], targets: [{ id: 'server', guildId: 'guild', channelId: 'notices', signupCardChannelId: 'signup', enabled: true, enabledCommandIds: ['wipe', 'signup_card', 'ranking'] }] });

test('old Discord split merges into one enabled slash and preserves templates, mode and destinations', () => {
  const input = legacy(), before = structuredClone(input);
  const output = normalizeConfig('discord', input);
  assert.deepEqual(input, before);
  assert.deepEqual(output.commands.map(row => row.id), ['wipe', 'ranking']);
  assert.deepEqual(output.commands[0], { id: 'wipe', name: 'wipe-react', type: 'event_command', slashCommand: 'wipe-react', enabled: true, titleTemplate: 'original', bodyTemplate: 'original body', signupMode: 'discord_only' });
  assert.deepEqual(output.targets[0], { ...before.targets[0], enabledCommandIds: ['wipe', 'ranking'] });
  assert.deepEqual(retainedDiscordCommandSchemas(output).map(row => row.name), ['ranking', 'wipe-react']);
  assert.deepEqual(normalizeDiscordWipeConfig(output), output);
});

test('saved config projection and legacy migration use the same single Discord command', () => {
  const input = legacy();
  assert.deepEqual(stripRetiredRegistrationConfig('discord', input), normalizeConfig('discord', input));
  const migrated = planPlatformMigration({ settings: { discord: { ...input, commandDefinitions: input.commands } } }).configs.find(row => row.id === 'discord').config;
  assert.equal(migrated.commands.filter(row => row.id === 'wipe').length, 1);
  assert.equal(migrated.commands[0].signupMode, 'discord_only');
});

test('new command switches between the two validated modes and missing old mode requires membership', () => {
  const input = legacy(); delete input.commands[0].signupMode;
  const config = normalizeConfig('discord', input);
  assert.equal(config.commands[0].signupMode, 'member_required');
  config.commands[0].signupMode = 'discord_only';
  assert.equal(normalizeConfig('discord', config).commands[0].signupMode, 'discord_only');
  config.commands[0].signupMode = 'invalid';
  assert.throws(() => normalizeConfig('discord', config), error => error.errorCode === 'WIPE_SIGNUP_MODE_INVALID');
});

test('signup-only Discord configuration becomes wipe while KOOK retains its separate card', () => {
  const input = legacy(); input.commands = [input.commands[2]];
  assert.equal(normalizeConfig('discord', input).commands[0].slashCommand, 'wipe-react');
  assert.equal(normalizeConfig('kook', input).commands[0].id, 'signup_card');
  const empty = { enabled: false, commands: [], targets: [] };
  assert.deepEqual(normalizeConfig('discord', empty).commands, []);
});

test('legacy merge does not silently accept duplicate command IDs', () => {
  const input = legacy(); input.commands[0].signupMode = 'discord_only'; input.commands.push({ ...input.commands[0] });
  assert.throws(() => normalizeConfig('discord', input), error => error.errorCode === 'PLATFORM_INPUT_INVALID');
});
