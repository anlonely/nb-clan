import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { planPlatformMigration } from '../server/v2/platform-admin/migration.js';
import { resolveNewwipeTarget } from '../server/v2/platform-admin/newwipe-permissions.js';

const guildId = '1153571748147634236', channelId = '1153571748147634237';
const userId = '1153571748147634238', roleId = '1153571748147634239';
const alternate = '1153571748147634240';
const definition = { id: 'newwipe', name: 'Open sign-up', type: 'event_command', slashCommand: 'newwipe', enabled: true };
const fixture = (overrides = {}) => ({ enabled: true, commands: [{ ...definition }], targets: [{
  id: 'private-test', guildId, channelId, enabled: true, enabledCommandIds: ['newwipe'], ...overrides
}] });
const proof = overrides => ({ provider: 'discord', externalId: userId, guildId, channelId, discordRoleIds: [], discordPermissions: '0', ...overrides });
const denied = code => error => error.errorCode === code && error.status === 403;

test('open sign-up config preserves explicit administrator denial and validates guild-specific IDs', () => {
  const config = fixture({newwipeAllowAdministrators:false,newwipeAllowedRoleIds:[roleId,roleId],newwipeAllowedUserIds:[userId],newwipeChannelIds:[channelId]});
  const saved = normalizeConfig('discord', config);
  assert.equal(saved.targets[0].newwipeAllowAdministrators, false);
  assert.deepEqual(saved.targets[0].newwipeAllowedRoleIds, [roleId]);
  assert.deepEqual(saved.targets[0].newwipeAllowedUserIds, [userId]);
  assert.deepEqual(saved.targets[0].newwipeChannelIds, [channelId]);
  for (const key of ['newwipeAllowedRoleIds', 'newwipeAllowedUserIds', 'newwipeChannelIds']) {
    for (const value of [[123], ['not-an-id'], [userId + '1234'], Array(31).fill(userId), '']) {
      assert.throws(() => normalizeConfig('discord', fixture({[key]:value})), error => error.errorCode === 'PLATFORM_INPUT_INVALID');
    }
  }
  assert.throws(() => normalizeConfig('discord',fixture({newwipeAllowAdministrators:'false'})));
  assert.throws(() => normalizeConfig('kook', {targets:config.targets}), error => error.errorCode === 'NEWWIPE_CONFIG_INVALID');
});

test('newwipe is a fixed Discord command and remains separate from the existing wipe-react mode', () => {
  const config = fixture(); config.commands.push({id:'wipe',type:'event_command',slashCommand:'wipe-react',enabled:true,signupMode:'member_required'});
  assert.deepEqual(normalizeConfig('discord',config).commands.map(row=>[row.id,row.slashCommand]), [['newwipe','newwipe'],['wipe','wipe-react']]);
  for (const command of [{...definition,id:'other'},{...definition,slashCommand:'other'},{...definition,type:'persistent_card'}]) {
    assert.throws(() => normalizeConfig('discord',{commands:[command]}),error=>error.errorCode==='NEWWIPE_CONFIG_INVALID');
  }
  assert.throws(() => normalizeConfig('kook',{commands:[definition]}),error=>error.errorCode==='NEWWIPE_CONFIG_INVALID');
});

test('administrator and Manage Server permission work by default, with no website identity', () => {
  const config = fixture();
  for (const discordPermissions of ['8','32','40','1048584']) {
    assert.equal(resolveNewwipeTarget(config,proof({discordPermissions})),config.targets[0]);
  }
  for (const discordPermissions of ['0','16','not-a-number',8,undefined]) {
    assert.throws(()=>resolveNewwipeTarget(config,proof({discordPermissions})),denied('NEWWIPE_PUBLISHER_DENIED'));
  }
});

test('administrator exception can be disabled without silently reopening it', () => {
  const config=fixture({newwipeAllowAdministrators:false,newwipeAllowedRoleIds:[],newwipeAllowedUserIds:[]});
  assert.throws(()=>resolveNewwipeTarget(config,proof({discordPermissions:'8'})),denied('NEWWIPE_PUBLISHER_DENIED'));
  assert.equal(resolveNewwipeTarget(config,proof({discordPermissions:'0'}),{requirePublisher:false}),config.targets[0]);
});

test('allowed role or user can publish and edit independently of administrator permissions', () => {
  const byRole=fixture({newwipeAllowAdministrators:false,newwipeAllowedRoleIds:[roleId]});
  assert.equal(resolveNewwipeTarget(byRole,proof({discordRoleIds:[roleId]})),byRole.targets[0]);
  assert.throws(()=>resolveNewwipeTarget(byRole,proof({discordRoleIds:[alternate]})),denied('NEWWIPE_PUBLISHER_DENIED'));
  const byUser=fixture({newwipeAllowAdministrators:false,newwipeAllowedUserIds:[userId]});
  assert.equal(resolveNewwipeTarget(byUser,proof()),byUser.targets[0]);
  assert.throws(()=>resolveNewwipeTarget(byUser,proof({externalId:alternate})),denied('NEWWIPE_PUBLISHER_DENIED'));
});

test('an empty channel selection falls back only to the general notification channel', () => {
  for (const options of [{},{newwipeChannelIds:[]}]) {
    const config=fixture(options);
    assert.equal(resolveNewwipeTarget(config,proof(),{requirePublisher:false}),config.targets[0]);
    assert.throws(()=>resolveNewwipeTarget(config,proof({channelId:alternate}),{requirePublisher:false}),denied('PLATFORM_CHANNEL_DENIED'));
  }
});

test('explicit channels replace the fallback and remain confined to the configured guild', () => {
  const config=fixture({newwipeChannelIds:[alternate]});
  assert.equal(resolveNewwipeTarget(config,proof({channelId:alternate}),{requirePublisher:false}),config.targets[0]);
  assert.throws(()=>resolveNewwipeTarget(config,proof(),{requirePublisher:false}),denied('PLATFORM_CHANNEL_DENIED'));
  assert.throws(()=>resolveNewwipeTarget(config,proof({guildId:'1554983512321425488',channelId:alternate}),{requirePublisher:false}),denied('PLATFORM_CHANNEL_DENIED'));
});

test('ambiguous targets and disabled platform, target or command deny all interactions', () => {
  const configs=[fixture(),fixture(),fixture(),fixture(),fixture()];
  configs[0].enabled=false; configs[1].targets[0].enabled=false; configs[2].commands[0].enabled=false;
  configs[3].targets[0].enabledCommandIds=[]; configs[4].targets.push({...configs[4].targets[0],id:'duplicate'});
  for (const [i,config] of configs.entries()) {
    const code=i===0?'PLATFORM_DISABLED':i===2?'COMMAND_DISABLED':'PLATFORM_CHANNEL_DENIED';
    for (const requirePublisher of [true,false]) assert.throws(()=>resolveNewwipeTarget(config,proof({discordPermissions:'8'}),{requirePublisher}),denied(code));
  }
});

test('invalid or direct-message proofs cannot enter the open sign-up target', () => {
  for (const override of [{provider:'kook'},{guildId:null},{channelId:'x'},{externalId:null}]) {
    assert.throws(()=>resolveNewwipeTarget(fixture(),proof(override),{requirePublisher:false}),denied('PLATFORM_AUTH_INVALID'));
  }
});

test('legacy migration preserves explicit newwipe administrator denial and allowlists', () => {
  const config=fixture({newwipeAllowAdministrators:false,newwipeAllowedRoleIds:[roleId],newwipeAllowedUserIds:[userId],newwipeChannelIds:[alternate]});
  const plan=planPlatformMigration({discord:{...config,commandDefinitions:config.commands}});
  const target=plan.configs.find(item=>item.id==='discord').config.targets[0];
  assert.equal(target.newwipeAllowAdministrators,false);
  for (const key of ['newwipeAllowedRoleIds','newwipeAllowedUserIds','newwipeChannelIds']) assert.deepEqual(target[key],config.targets[0][key]);
});
