import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {sectionSaveBody, legacyBotDestination, deliveryTargetId} from '../src/v2/bot-admin/config-sections.js';
import {serverConnectTargetId} from '../server/v2/platform-admin/server-connect-card.js';
import {electricianTargetId} from '../server/v2/platform-admin/electrician-card.js';
import {welcomeGuideTargetId} from '../server/v2/platform-admin/welcome-guide-card.js';
let ui, directory, originalLocation;
before(async () => {
  originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {configurable: true, value: {hash: '', search: ''}});
  const root = resolve('.'), cache = join(root, 'node_modules/.cache');
  await mkdir(cache, {recursive: true}); directory = await mkdtemp(join(cache, 'bot-management-ui-'));
  await build({stdin: {contents: `
    export {default as BotAdmin} from './src/v2/bot-admin/index.jsx';
    export {default as CommunityServer} from './src/v2/platform-admin/community-server.jsx';
    export {default as RuntimeTools} from './src/v2/bot-admin/runtime-tools.jsx';
    export {steamLinkCommand, SteamLinksAccess, SteamTeamMapping} from './src/v2/platform-admin/steam-links.jsx';
    export {AppContext} from './src/v2/context.jsx';
    export {setUiLocale, t} from './src/v2/i18n.js';
  `, resolveDir: root}, outfile: join(directory, 'ui.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: {'.css': 'empty'}});
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => {await rm(directory, {recursive: true, force: true}); if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation); else delete globalThis.location;});
const data = {
 revision: 4, enabled: true, autoWipeCards: false, canConfigure: true, secretStatus: {},
 actions: ['metadata', 'register_commands', 'query', 'ranking', 'map', 'card_preview', 'card_publish', 'card_refresh'].map(id => ({id, available: true})),
 commands: [
  {id: 'wipe', name: 'wipe-react', type: 'event_command', slashCommand: 'wipe-react', signupMode: 'discord_only', enabled: true},
  {id: 'newwipe', name: '开放报名', type: 'event_command', slashCommand: 'newwipe', enabled: true},
  {id: 'custom', name: 'Untranslated owner title', type: 'persistent_card', titleTemplate: '用户自定义标题', bodyTemplate: '原始模板 {member}', enabled: true}
 ],
 targets: [
  {id: 'binding-one', name: 'Same guild / first binding', guildId: '123456789012345678', channelId: '223456789012345678', enabled: true, enabledCommandIds: ['wipe', 'newwipe'], signupCardChannelId: '323456789012345678'},
  {id: 'binding-two', name: 'Same guild / second binding', guildId: '123456789012345678', channelId: '423456789012345678', enabled: true, enabledCommandIds: ['newwipe'], newwipeAllowAdministrators: false}
 ], channelCatalogs: [], guildCatalog: {items: []}
};
function render(Component, props = {}, path = '/admin/bot/features') {
  const calls = [], states = new Map();
  const client = {getGeneration: () => 0, subscribeQuery: () => () => {}, getQueryState(key) {
    const id = JSON.stringify(key); if (!states.has(id)) states.set(id, {data: key[0] === 'platform-admin' ? {...data, id: key[1]} : {items: []}}); return states.get(id);
  }, fetchQuery: async () => {}, request: async (...args) => {calls.push(args); throw new Error('No writes during render');}};
  ui.setUiLocale('zh');
  const html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: {client, path, zone: 'Asia/Shanghai', online: true, go() {}}}, React.createElement(Component, props)));
  return {html, calls};
}
test('section saves send only owned fields and retain original revision', () => {
 const draft = {...data, applicationId: 'app', publicKey: 'key', roleSystemMappings: [{systemRole: 'member'}]};
 for (const [section, keys] of Object.entries({connection: ['enabled', 'applicationId', 'publicKey'], identity: ['roleSystemMappings'], features: ['commands'], servers: ['targets'], automation: ['autoWipeCards']})) {
  const body = sectionSaveBody(draft, section);
  assert.equal(body.expectedRevision, 4); assert.equal(body.configSection, section); assert.deepEqual(Object.keys(body.config).sort(), keys.sort());
 }
 assert.throws(() => sectionSaveBody(draft, 'all'), /Unknown/);
});
test('legacy editors redirect to their canonical Bot route and retain context', () => {
 assert.equal(legacyBotDestination('electricians'), '/admin/bot/electricians');
 assert.equal(legacyBotDestination('discord', '#server-commands', '?targetId=binding-two'), '/admin/bot/features?targetId=binding-two&platform=discord');
 assert.equal(legacyBotDestination('kook', '#server-tools'), '/admin/bot/tools?platform=kook');
 for (const hash of ['#server-connection', '#server-specialties', '#login']) assert.equal(legacyBotDestination('discord', hash), null);
});
test('runtime derived card identities exactly match server generators for both platforms', async () => {
 for (const platform of ['discord', 'kook']) for (const [type, generate] of [['server_connect', serverConnectTargetId], ['electrician_ids', electricianTargetId], ['welcome_guide', welcomeGuideTargetId]]) assert.equal(await deliveryTargetId(platform, 'binding-one', type), generate('binding-one', platform));
 assert.equal(await deliveryTargetId('discord', 'binding-one', 'ranking'), 'binding-one');
});
test('six Bot tabs render with separate platform bindings and no actions during reads', () => {
 const {html, calls} = render(ui.BotAdmin, {}, '/admin/bot/servers?platform=discord');
 for (const section of ['features', 'servers', 'open-signups', 'electricians', 'tools', 'activity']) assert.ok(html.includes(`href="/admin/bot/${section}?platform=discord"`));
 assert.ok(html.includes('binding-one')); assert.ok(html.includes('binding-two'));
 assert.ok(html.includes('targetId=binding-two')); assert.equal(calls.length, 0);
});
test('feature details have one canonical wipe-react with two modes and no nested navigation', () => {
 const {html, calls} = render(ui.CommunityServer, {id: 'discord', data, draft: data, change() {}, perform() {}, section: 'commands', commandId: 'wipe', standalone: true});
 assert.match(html, /aria-selected="true"[^>]*><span>版本 2/); assert.ok(html.includes('版本 1')); assert.ok(html.includes('版本 2'));
 assert.equal(html.includes('class="cs-nav"'), false); assert.equal(html.includes('aria-label="功能列表"'), false);
 assert.equal(html.includes('<textarea'), false, 'generated wipe cards must not expose unused empty template fields');
 assert.equal(calls.length, 0);
});
test('custom template content stays user data even when the website is English', () => {
 ui.setUiLocale('en');
 const app = {go() {}, client: {}, online: true};
 const html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: app}, React.createElement(ui.CommunityServer, {id: 'discord', data, draft: data, change() {}, section: 'commands', commandId: 'custom', standalone: true})));
 assert.ok(html.includes('用户自定义标题')); assert.ok(html.includes('原始模板 {member}'));
});
test('server detail selects exact binding instead of merging guild channels or permissions', () => {
 const {html} = render(ui.CommunityServer, {id: 'discord', data, draft: data, change() {}, perform() {}, section: 'servers', targetId: 'binding-two', standalone: true});
 assert.ok(html.includes('423456789012345678')); assert.equal(html.includes('323456789012345678'), false);
 assert.ok(html.includes('管理员例外已关闭')); assert.equal(html.includes('aria-label="服务器列表"'), false);
});
test('tools do not select a production target or permit publish before an explicit preview', () => {
 const {html, calls} = render(ui.RuntimeTools, {platform: 'discord', data, action: 'card_publish', setAction() {}, input: {cardType: 'electrician_ids'}, setInput() {}, perform() {}, displayStatus: value => value});
 assert.ok(html.includes('尚未选择目标')); assert.match(html, /disabled=""[^>]*>发布新卡/); assert.equal(calls.length, 0);
});

test('runtime requests carry actual signup and provider context rather than unsupported member fields', async () => {
 const {runtimeActionBody} = await import('../src/v2/bot-admin/config-sections.js');
 const notice = await runtimeActionBody({action: 'card_preview', platform: 'discord', target: data.targets[0], revision: 4, input: {cardType: 'wipe_notice', wipeId: 'wipe-a'}});
 assert.equal(notice.signupTargetId, 'binding-one'); assert.equal(notice.targetId, 'binding-one'); assert.equal(notice.wipeId, 'wipe-a'); assert.equal(notice.language, 'en');
 const query = await runtimeActionBody({action: 'query', platform: 'discord', revision: 4, input: {memberId: 'unsupported', steamId: '76561198000000501', sourceId: 'vital', serverId: '16', providerWipeId: 'actual-wipe'}});
 assert.deepEqual(query, {expectedRevision: 4, steamId: '76561198000000501', sourceId: 'vital', serverId: '16', providerWipeId: 'actual-wipe'});
 const ranking = await runtimeActionBody({action: 'ranking', platform: 'kook', revision: 4, input: {wipeId: 'wipe-a'}});assert.equal(ranking.sourceId, 'vital');
 const publish = await runtimeActionBody({action: 'card_refresh', platform: 'kook', target: data.targets[1], revision: 4, input: {cardType: 'electrician_ids', previewId: 'preview-a', contentHash: 'hash-a'}});
 assert.equal(publish.targetId, electricianTargetId('binding-two', 'kook')); assert.equal(publish.previewId, 'preview-a'); assert.equal(publish.contentHash, 'hash-a');
});
test('audit date filters use the website zone, inclusive end dates and actual DST day lengths', async () => {
 const {auditFilterParams} = await import('../src/v2/bot-admin/audit-filters.js');
 const filters = auditFilterParams('action=card_refresh&status=failed&from=2026-10-15&to=2026-10-15', 'Asia/Shanghai');
 assert.equal(filters.get('from'), '2026-10-14T16:00:00.000Z'); assert.equal(filters.get('to'), '2026-10-15T16:00:00.000Z'); assert.equal(filters.get('action'), 'card_refresh');
 const fold = auditFilterParams('from=2026-11-01&to=2026-11-01', 'America/New_York');
 assert.equal(Date.parse(fold.get('to')) - Date.parse(fold.get('from')), 25 * 3600000);
 assert.throws(() => auditFilterParams('from=2026-10-16&to=2026-10-15', 'Asia/Shanghai'));
 assert.throws(() => auditFilterParams('to=2026-02-30', 'Asia/Shanghai'));
});
test('built-in data query cards explain generated content instead of editing unused blank templates', () => {
 const queryCommand = {id: 'kda', name: '战绩查询', type: 'slash_command', slashCommand: 'kda', enabled: true};
 const dataset = {...data, commands: [queryCommand]};
 const {html} = render(ui.CommunityServer, {id: 'discord', data: dataset, draft: dataset, change() {}, section: 'commands', commandId: 'kda', standalone: true});
 assert.ok(html.includes('内容自动生成')); assert.ok(html.includes('注册状态未核实')); assert.equal(html.includes('<textarea'), false);
});

test('Steam native feature editors explain independent linking and each lookup without unused template fields', () => {
 for (const id of ['setsteam', 'view']) {
  const command = ui.steamLinkCommand(id), dataset = {...data, commands: [command]};
  assert.equal(command.enabled, false); assert.equal(command.type, 'slash_command'); assert.equal(command.slashCommand, id);
  const {html, calls} = render(ui.CommunityServer, {id: 'discord', data: dataset, draft: dataset, change() {}, section: 'commands', commandId: id, standalone: true});
  assert.ok(html.includes('功能说明与交互预览')); assert.ok(html.includes('注册状态未核实')); assert.ok(html.includes('前往指令注册'));
  assert.equal(html.includes('<textarea'), false); assert.equal(html.includes('aria-label="功能类型"'), false); assert.equal(calls.length, 0);
  if (id === 'setsteam') {assert.ok(html.includes('独立于网站登录绑定')); assert.ok(html.includes('不证明账号归属')); assert.ok(html.includes('取消保留原关联'));}
  else for (const text of ['/view user', '/view all', '/view nosteam', '只能填写一项', '最多 20 人', 'Server Members Intent']) assert.ok(html.includes(text), text);
 }
});

test('Steam list permissions are scoped to the selected target with administrator default and explicit IDs', () => {
 const commands = ['setsteam', 'view'].map(id => ({...ui.steamLinkCommand(id), enabled: true}));
 const dataset = {...data, commands, targets: data.targets.map((target, index) => ({...target, enabledCommandIds: ['setsteam', 'view'],
  steamListAllowedRoleIds: [String(611111111111111110n + BigInt(index))], steamListAllowedUserIds: [String(711111111111111110n + BigInt(index))]}))};
 const {html} = render(ui.CommunityServer, {id: 'discord', data: dataset, draft: dataset, change() {}, section: 'servers', targetId: 'binding-two', standalone: true});
 assert.ok(html.includes('611111111111111111')); assert.ok(html.includes('711111111111111111'));
 assert.equal(html.includes('611111111111111110'), false); assert.equal(html.includes('711111111111111110'), false);
 for (const text of ['Steam 关联与名单权限', '管理服务器', '普通成员开放', '通用通知频道', 'Server Members Intent', '不会显示空名单']) assert.ok(html.includes(text), text);
 assert.equal(html.includes('允许服务器管理员使用'), false, 'Steam list administrators are always permitted');
});

test('Steam feature and permission explanations render completely in English while preserving edited names', () => {
 ui.setUiLocale('en');
 const app = {go() {}, client: {}, online: true};
 for (const id of ['setsteam', 'view']) {
  const command = {...ui.steamLinkCommand(id), name: `My ${id}`}, dataset = {...data, commands: [command]};
  const html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: app}, React.createElement(ui.CommunityServer,
   {id: 'discord', data: dataset, draft: dataset, change() {}, section: 'commands', commandId: id, standalone: true})));
  assert.equal(/[\u3400-\u9fff]/.test(html), false, html); assert.ok(html.includes(`My ${id}`));
 }
 const html = renderToStaticMarkup(React.createElement(ui.SteamLinksAccess, {target: {}, roles: null, disabled: false, canLoad: false, onLoad() {}, onChange() {}}));
 assert.equal(/[\u3400-\u9fff]/.test(html), false, html); assert.ok(html.includes('Manage Server')); assert.ok(html.includes('Server Members Intent'));
});

test('Steam feature tool routes open native registration with the exact command and no card preview or writes', async () => {
 try {
  for (const id of ['setsteam', 'view']) {
   globalThis.location.search = `?platform=discord&feature=${id}`;
   const {html, calls} = render(ui.BotAdmin, {}, `/admin/bot/tools?platform=discord&feature=${id}`);
   assert.ok(html.includes(`value="${id}"`)); assert.ok(html.includes('Steam 原生指令验证'));
   assert.match(html, /aria-selected="true"[^>]*><span>注册指令/);
   assert.equal(html.includes('aria-label="卡片类型"'), false); assert.equal(calls.length, 0);
   const {runtimeActionBody} = await import('../src/v2/bot-admin/config-sections.js');
   assert.deepEqual(await runtimeActionBody({action: 'register_commands', platform: 'discord', target: data.targets[0], revision: 4, input: {commandIds: id}}),
    {expectedRevision: 4, targetId: 'binding-one', commandIds: [id]});
  }
 } finally {globalThis.location.search = '';}
});

test('automatic Steam team matching switch respects dedicated authority without locking ordinary command settings', () => {
 for (const canConfigureSteamTeams of [true, false, undefined]) {
  const commands = ['setsteam', 'view'].map(id => ui.steamLinkCommand(id));
  assert.equal(commands[0].autoMatchTeamByRole, false); assert.equal(Object.hasOwn(commands[1], 'autoMatchTeamByRole'), false);
  const dataset = {...data, commands, canConfigureSteamTeams};
  const {html} = render(ui.CommunityServer, {id: 'discord', data: dataset, draft: dataset, change() {}, section: 'commands', commandId: 'setsteam', standalone: true});
  const matchingSwitch = html.match(/<input[^>]*aria-label="根据 Discord 角色自动匹配队伍"[^>]*>/)?.[0];
  assert.ok(matchingSwitch); assert.equal(matchingSwitch.includes('disabled=""'), canConfigureSteamTeams !== true); assert.equal(matchingSwitch.includes('checked=""'), false);
  assert.equal(html.match(/<input[^>]*aria-label="启用此功能"[^>]*>/)?.[0].includes('disabled=""'), false);
  assert.ok(html.includes('不更改现有队伍')); assert.ok(html.includes('手动分队优先')); assert.ok(html.includes('不视为已验证身份'));
  const {html: viewHtml} = render(ui.CommunityServer, {id: 'discord', data: dataset, draft: dataset, change() {}, section: 'commands', commandId: 'view', standalone: true});
  assert.equal(viewHtml.includes('自动匹配队伍设置'), false);
 }
});

test('server team mapping can be prepared while off, only offers manageable squads, and warns about ambiguity', () => {
 const squads = [{id: 'cn-squad', name: 'Administratively selected one', canManage: true}, {id: 'eu-squad', name: 'Administratively selected two', canManage: true}, {id: 'hidden-squad', name: 'Cannot manage this squad', canManage: false}];
 const roles = {items: [{id: '611111111111111110', label: 'Current guild role', status: 'role'}]};
 const target = {steamTeamCnRoleIds: ['611111111111111110'], steamTeamEuRoleIds: [], steamTeamCnSquadId: 'cn-squad', steamTeamEuSquadId: 'eu-squad'};
 const props = {target, command: {autoMatchTeamByRole: false}, squads, roles, disabled: false, canConfigure: true, canLoad: true, onLoad() {}, onChange() {}};
 const {html} = render(ui.SteamTeamMapping, props);
 assert.ok(html.includes('自动分队当前未生效')); assert.ok(html.includes('Administratively selected one')); assert.ok(html.includes('Administratively selected two'));
 assert.equal(html.includes('Cannot manage this squad'), false); assert.ok(html.includes('当前账号可管理的现有队伍'));
 assert.equal(html.match(/<textarea[^>]*aria-label="CN Discord 角色 ID"[^>]*>/)?.[0].includes('disabled=""'), false);
 const {html: locked} = render(ui.SteamTeamMapping, {...props, canConfigure: false});
 assert.ok(locked.match(/<textarea[^>]*aria-label="CN Discord 角色 ID"[^>]*>/)?.[0].includes('disabled=""'));
 assert.ok(locked.match(/<button[^>]*aria-label="CN 对应的网站队伍"[^>]*>/)?.[0].includes('disabled=""'));
 for (const [change, warning] of [[{steamTeamCnSquadId: ''}, '已选择 CN 角色'], [{steamTeamEuRoleIds: target.steamTeamCnRoleIds}, '同一 Discord 角色不能'], [{steamTeamEuSquadId: 'cn-squad'}, '必须选择不同的网站队伍']]) {
  const {html: invalid} = render(ui.SteamTeamMapping, {...props, target: {...target, ...change}}); assert.ok(invalid.includes(warning));
 }
 ui.setUiLocale('en');
 const english = renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: {go() {}}}, React.createElement(ui.SteamTeamMapping, props)));
 assert.equal(/[\u3400-\u9fff]/.test(english), false, english); assert.ok(english.includes('Manual squad assignments take priority'));
});
