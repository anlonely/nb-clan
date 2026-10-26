import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig} from '../server/v2/platform-admin/model.js';
import {planPlatformMigration} from '../server/v2/platform-admin/migration.js';
import {retainedDiscordCommandSchemas, managedDiscordInteraction} from '../server/v2/notification-platforms/native-interactions.js';

const command = (id, extra = {}) => ({id, type: 'slash_command', slashCommand: id, ...extra});
const target = {id: 'personal', guildId: '1153571748147634236', channelId: '1153571748147634237',
  enabled: true, enabledCommandIds: ['setsteam', 'view'], steamListAllowedRoleIds: ['1153571748147634238'], steamListAllowedUserIds: ['1153571748147634239']};

test('Steam command configuration is disabled by default and preserves every existing target selection', () => {
  const input = {commands: [command('setsteam'), command('view')], targets: [target]};
  const before = structuredClone(input), config = normalizeConfig('discord', input);
  assert.deepEqual(input, before); assert.deepEqual(config.targets, [target]);
  assert.ok(config.commands.every(row => row.enabled === false));
  assert.deepEqual(retainedDiscordCommandSchemas(config), []);
  assert.deepEqual(normalizeConfig('discord', {commands: []}).commands, []);
});

test('Steam command names, owner IDs, platform and type cannot be overridden', () => {
  for (const platform of ['discord', 'kook']) for (const id of ['setsteam', 'view']) {
    const invalid = [command(id, {type: 'persistent_card'}), command(id, {type: 'event_command'}), command(id, {slashCommand: 'custom'}),
      command('custom', {slashCommand: id}), command('custom', {slashCommand: `/${id}`}), command('custom', {slashCommand: id.toUpperCase()})];
    if (platform === 'kook') invalid.push(command(id));
    for (const row of invalid) assert.throws(() => normalizeConfig(platform, {commands: [row]}), /STEAM_LINKS_CONFIG_INVALID/);
  }
});

test('Steam list grants are Discord-only bounded snowflakes and survive legacy migration', () => {
  assert.throws(() => normalizeConfig('kook', {targets: [target]}), /STEAM_LINKS_CONFIG_INVALID/);
  for (const key of ['steamListAllowedRoleIds', 'steamListAllowedUserIds']) for (const value of [['bad-id'], [123456789012345678], Array(31).fill('1153571748147634238'), '1153571748147634238'])
    assert.throws(() => normalizeConfig('discord', {targets: [{...target, [key]: value}]}), /PLATFORM_INPUT_INVALID/);
  const normalized = normalizeConfig('discord', {targets: [{...target, steamListAllowedRoleIds: [...target.steamListAllowedRoleIds, ...target.steamListAllowedRoleIds]}]});
  assert.deepEqual(normalized.targets, [target]);
  const plan = planPlatformMigration({settings: {discord: {targets: [target], commandDefinitions: [command('setsteam', {enabled: false}), command('view', {enabled: false})]}}});
  const discord = plan.configs.find(row => row.id === 'discord').config;
  assert.deepEqual(discord.targets, [target]); assert.ok(discord.commands.every(row => row.enabled === false));
  const unspecified = planPlatformMigration({settings: {discord: {commandDefinitions: [command('setsteam'), command('view')]}}});
  assert.ok(unspecified.configs.find(row => row.id === 'discord').config.commands.every(row => row.enabled === false));
});

test('native Steam schemas match handlers and localize every description within Discord limits', () => {
  const config = {commands: ['setsteam', 'view'].map(id => command(id, {enabled: true})), targets: [target]};
  const schemas = retainedDiscordCommandSchemas(config);
  assert.deepEqual(schemas.map(row => row.name), ['setsteam', 'view']); assert.deepEqual(schemas[0].options, []);
  assert.deepEqual(schemas[1].options.map(row => [row.name, row.type]), [['user', 1], ['all', 1], ['nosteam', 1]]);
  assert.deepEqual(schemas[1].options[0].options.map(row => [row.name, row.type, row.required]), [['user', 6, false], ['identifier', 3, false]]);
  assert.deepEqual(schemas[1].options.slice(1).map(row => row.options), [[], []]);
  const check = row => {
    assert.ok(row.description.length > 0 && row.description.length <= 100, row.description);
    assert.deepEqual(Object.keys(row.description_localizations).sort(), ['zh-CN', 'zh-TW', 'ru', 'tr', 'th', 'ko'].sort());
    for (const value of Object.values(row.description_localizations)) assert.ok(value.length > 0 && value.length <= 100, value);
    for (const option of row.options || []) check(option);
  };
  schemas.forEach(check);
  assert.deepEqual(retainedDiscordCommandSchemas({...config, targets: [{...target, enabled: false}]}), []);
  assert.deepEqual(retainedDiscordCommandSchemas({...config, targets: [{...target, enabledCommandIds: ['view']}]}).map(row => row.name), ['view']);
  for (const name of ['setsteam', 'view']) assert.equal(managedDiscordInteraction({type: 2, data: {name}}, {enabled: false}), true, 'owner must enforce disabled targets with a native reply');
});

test('automatic team matching is a strict opt-in setting owned only by Discord setsteam', () => {
  const legacy = normalizeConfig('discord', {commands: [command('setsteam'), command('view')]});
  assert.equal(legacy.commands[0].autoMatchTeamByRole, false);
  assert.equal(Object.hasOwn(legacy.commands[1], 'autoMatchTeamByRole'), false);
  for (const value of [false, true]) assert.equal(normalizeConfig('discord', {commands: [command('setsteam', {autoMatchTeamByRole: value})]}).commands[0].autoMatchTeamByRole, value);
  for (const value of ['true', 1, null, [], {}]) assert.throws(() => normalizeConfig('discord', {commands: [command('setsteam', {autoMatchTeamByRole: value})]}), /PLATFORM_INPUT_INVALID/);
  for (const id of ['view', 'other']) assert.throws(() => normalizeConfig('discord', {commands: [command(id, {autoMatchTeamByRole: false})]}), /STEAM_TEAM_CONFIG_INVALID/);
  assert.throws(() => normalizeConfig('kook', {commands: [command('setsteam', {autoMatchTeamByRole: true})]}), /STEAM_LINKS_CONFIG_INVALID|STEAM_TEAM_CONFIG_INVALID/);
});

test('CN and EU target rules allow empty groups but reject ambiguous or incomplete role to squad assignments', () => {
  const cn = '6153571748147634238', eu = '6153571748147634239';
  const mapping = {...target, steamTeamCnRoleIds: [cn], steamTeamEuRoleIds: [eu], steamTeamCnSquadId: 'squad-cn', steamTeamEuSquadId: 'squad-eu'};
  assert.deepEqual(normalizeConfig('discord', {targets: [mapping]}).targets, [mapping]);
  assert.deepEqual(normalizeConfig('discord', {targets: [{...mapping, steamTeamCnRoleIds: [cn, cn]}]}).targets, [mapping]);
  for (const empty of [{steamTeamCnRoleIds: [], steamTeamEuRoleIds: [], steamTeamCnSquadId: '', steamTeamEuSquadId: ''},
    {steamTeamCnRoleIds: [], steamTeamCnSquadId: 'squad-cn'}, {}]) assert.deepEqual(normalizeConfig('discord', {targets: [{...target, ...empty}]}).targets, [{...target, ...empty}]);
  for (const change of [{steamTeamCnSquadId: ''}, {steamTeamEuSquadId: ''}, {steamTeamEuRoleIds: [cn]}, {steamTeamEuSquadId: 'squad-cn'}])
    assert.throws(() => normalizeConfig('discord', {targets: [{...mapping, ...change}]}), /STEAM_TEAM_CONFIG_INVALID/);
  for (const key of ['steamTeamCnRoleIds', 'steamTeamEuRoleIds']) for (const value of ['6153571748147634238', ['bad'], [6153571748147634238], Array(31).fill(cn)])
    assert.throws(() => normalizeConfig('discord', {targets: [{...mapping, [key]: value}]}), /PLATFORM_INPUT_INVALID/);
  for (const key of ['steamTeamCnSquadId', 'steamTeamEuSquadId']) for (const value of [null, 12, 'two squads', ''])
    assert.throws(() => normalizeConfig('discord', {targets: [{...mapping, [key]: value}]}), /PLATFORM_INPUT_INVALID|STEAM_TEAM_CONFIG_INVALID/);
  assert.throws(() => normalizeConfig('kook', {targets: [mapping]}), /STEAM_LINKS_CONFIG_INVALID/);
});

test('legacy migration preserves explicit team configuration without enabling omitted settings or changing other target data', () => {
  const mappedTarget = {...target, steamTeamCnRoleIds: ['6153571748147634238'], steamTeamCnSquadId: 'configured-squad', steamTeamEuRoleIds: [], steamTeamEuSquadId: ''};
  for (const autoMatchTeamByRole of [false, true]) {
    const plan = planPlatformMigration({settings: {discord: {targets: [mappedTarget], commandDefinitions: [command('setsteam', {enabled: true, autoMatchTeamByRole})]}}});
    const config = plan.configs.find(row => row.id === 'discord').config;
    assert.deepEqual(config.targets, [mappedTarget]); assert.equal(config.commands[0].autoMatchTeamByRole, autoMatchTeamByRole);
  }
  const plan = planPlatformMigration({settings: {discord: {targets: [target], commandDefinitions: [command('setsteam', {enabled: true})]}}});
  const config = plan.configs.find(row => row.id === 'discord').config;
  assert.equal(config.commands[0].autoMatchTeamByRole, false); assert.deepEqual(config.targets, [target]);
});
