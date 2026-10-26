import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

let ui, directory;
const original = { location: globalThis.location, history: globalThis.history, sessionStorage: globalThis.sessionStorage };
before(async () => {
  const root = resolve('.'), cache = join(root, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(join(cache, 'electrician-admin-ui-'));
  const actualUi = join(root, 'src/v2/ui.jsx');
  // Keep real React SSR and the real UI components. Only this component's
  // useState scheduler is controlled so its actual event handlers can be
  // exercised and re-rendered in Node, without launching a browser.
  const hookSource = `
    import React from 'react';
    const slots = []; let cursor = 0; export let fields = [];
    export let toggles = [], selects = [];
    export function begin(clear = false) { cursor = 0; fields = []; toggles = []; selects = []; if (clear) slots.length = 0; }
    export function useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    }
    export default { ...React, createElement(type, props, ...children) {
      if (type === 'textarea') fields.push(props);
      if (props?.onChange && typeof props.checked === 'boolean' && (props.label || props['aria-label'])) toggles.push({...props,label:props.label||props['aria-label']});
      if (props?.onChange && props['aria-label'] && props.value !== undefined) selects.push({...props, children: props.children ?? children});
      return React.createElement(type, props, ...children);
    } };
  `;
  const buttonSource = `
    import React from 'react';
    import { Button as ActualButton } from ${JSON.stringify(actualUi)};
    export * from ${JSON.stringify(actualUi)};
    export let buttons = [];
    export function clearButtons() { buttons = []; }
    export function Button(props) { buttons.push(props); return React.createElement(ActualButton, props); }
  `;
  await build({ stdin: { contents: `
    export { default as CommunityServer } from './src/v2/platform-admin/community-server.jsx';
    export { default as Automation } from './src/v2/bot-admin/automation.jsx';
    export { t, setUiLocale } from './src/v2/i18n.js';
    export { AppContext } from './src/v2/context.jsx';
    export { begin, fields, toggles, selects } from 'test:community-hooks';
    export { buttons, clearButtons } from 'test:community-buttons';
  `, resolveDir: root }, outfile: join(directory, 'ui.mjs'), bundle: true, platform: 'node', format: 'esm',
    packages: 'external', loader: { '.css': 'empty' }, plugins: [{ name: 'community-event-harness', setup(plugin) {
      plugin.onResolve({ filter: /^test:community-(hooks|buttons)$/ }, args => ({ path: args.path, namespace: 'community-test' }));
      plugin.onResolve({ filter: /^(react|\.\.\/ui\.jsx)$/ }, args => {
        if (!args.importer.endsWith('/platform-admin/community-server.jsx') && !args.importer.endsWith('/bot-admin/automation.jsx')) return;
        return { path: args.path === 'react' ? 'test:community-hooks' : 'test:community-buttons', namespace: 'community-test' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'community-test' }, args => ({
        contents: args.path.endsWith('hooks') ? hookSource : buttonSource, loader: 'js', resolveDir: root
      }));
    } }] });
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.history = { replaceState() {} };
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
});

const text = children => React.Children.toArray(children).filter(child => typeof child === 'string').join('');
function fixture(platform, { empty = false } = {}) {
  ui.begin(true);
  globalThis.location = { hash: '#server-commands', pathname: '/admin/platforms/' + platform, search: '' };
  const command = { id: 'electrician_ids_card', name: '电工 ID 卡片', type: 'persistent_card', enabled: true,
    electriciansCn: 'CN | https://steamcommunity.com/profiles/76561198000000501/',
    electriciansForeign: 'EN | https://steamcommunity.com/profiles/76561198000000502/' };
  const target = { id: 'selected-server', guildId: '1554983512321425488', channelId: '1554985839665348688',
    electricianChannelId: '1554985841263251538', enabled: true, enabledCommandIds: empty ? [] : [command.id] };
  const configuration = { revision: 7, canConfigure: true, enabled: true, secretStatus: {}, validation: {state: 'unverified'}, actions: [], targets: [target,
    { ...target, id: 'other-server', enabledCommandIds: [] }], commands: empty ? [] : [command] };
  const calls = [], changes = [];
  const props = { id: platform, data: configuration, draft: configuration, online: true, busy: false, dirty: false, pending: false,
    onSave() {}, onReset() {}, change(key, value) { changes.push({ key, value }); props.draft = { ...props.draft, [key]: value }; props.dirty = true; },
    async perform(path, body) {
      calls.push({ path, body });
      return { status: 'succeeded', result: path.endsWith('card_preview') ? {
        preview: { id: `preview-${calls.length}`, contentHash: `hash-${calls.length}`, body: 'Electricians preview' }
      } : {} };
    } };
  const render = () => { ui.begin(); ui.clearButtons(); return renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: {go() {}}}, React.createElement(ui.CommunityServer, props))); };
  const button = label => {
    const found = ui.buttons.find(button => text(button.children) === ui.t(label));
    assert.ok(found, `Missing button: ${label}`); return found;
  };
  return { props, calls, changes, render, button, target };
}

test('Discord and KOOK both add an electrician card and assign it only to the selected server without sending', async () => {
  for (const platform of ['discord', 'kook']) {
    ui.setUiLocale('en');
    const f = fixture(platform, { empty: true }); f.render();
    const add = f.button('添加电工 ID 卡片'); assert.equal(add.disabled, false); add.onClick();
    const command = f.props.draft.commands[0];
    assert.equal(command.id, 'electrician_ids_card'); assert.equal(command.enabled, true);
    assert.equal(Object.hasOwn(command, 'electriciansCn'), false, 'card setup must not create a second roster');
    assert.equal(Object.hasOwn(command, 'electriciansForeign'), false);
    assert.deepEqual(f.props.draft.targets.map(target => target.enabledCommandIds), [['electrician_ids_card'], []]);
    f.render(); assert.equal(f.button('预览电工卡片').disabled, true, 'unsaved configuration must not publish');
    assert.equal(f.calls.length, 0);
  }
});

test('both platforms link to the shared roster and preview using their own route, language and stable target identity', async () => {
  for (const platform of ['discord', 'kook']) for (const language of ['zh', 'en']) {
    ui.setUiLocale(language);
    const f = fixture(platform), html = f.render();
    assert.ok(html.includes('href="/admin/bot/electricians"'));
    assert.ok(html.includes(ui.t('管理电工ID')));
    assert.equal(ui.fields.length, 0, 'the platform card must not duplicate the shared roster editor');
    const notice = '保存后，Discord 与 KOOK 卡片中的电工名单链接会显示最新名单。';
    assert.ok(html.includes(ui.t(notice)), 'the visible notice describes the current roster links');
    assert.equal(/代码块|code block|copy its URL/.test(html), false, 'the notice must not promise a nonexistent copy button');
    if (language === 'en') {
      assert.notEqual(ui.t(notice), notice, 'English must translate the new notice');
      assert.ok(html.includes('will show the latest roster'));
      assert.equal(html.includes(notice), false);
    }
    assert.equal(html.includes(ui.t('填写卡片正文')), false, 'electricians use list editing, not a blank generic template');
    assert.equal(f.props.draft.commands[0].electriciansCn, 'CN | https://steamcommunity.com/profiles/76561198000000501/', 'legacy configuration is preserved without a second editor');
    assert.equal(f.changes.length, 0);
    f.props.data = { ...f.props.draft, revision: 8 }; f.props.dirty = false;
    f.render(); await f.button('预览电工卡片').onClick();
    const targetId = 'electrician_' + createHash('sha256').update(`${platform}:${f.target.id}`).digest('hex').slice(0,24);
    assert.deepEqual(f.calls, [{ path: `/api/v2/platform-admin/${platform}/actions/card_preview`, body: {
      expectedRevision: 8, targetId, cardType: 'electrician_ids', language: platform === 'discord' ? 'en' : 'zh-CN'
    } }]);
    f.render(); assert.equal(f.button('更新原卡').disabled, false);
  }
});

test('publish and refresh carry the selected preview receipt to the current platform and clear it on success', async () => {
  for (const platform of ['discord', 'kook']) for (const refresh of [false, true]) {
    ui.setUiLocale('zh');
    const f = fixture(platform); f.render(); await f.button('预览电工卡片').onClick(); f.render();
    await f.button(refresh ? '更新原卡' : '发布到电工频道').onClick();
    assert.deepEqual(f.calls[1], { path: `/api/v2/platform-admin/${platform}/actions/${refresh ? 'card_refresh' : 'card_publish'}`, body: {
      expectedRevision: 7, targetId: f.calls[0].body.targetId, cardType: 'electrician_ids', previewId: 'preview-1', contentHash: 'hash-1', mentionMode: 'none'
    } });
    f.render(); assert.equal(ui.buttons.some(button => text(button.children) === ui.t('更新原卡')), false);
  }
});

test('electrician previews remain disabled for unsaved, unauthorized, unavailable or unassigned configurations', () => {
  for (const platform of ['discord', 'kook']) for (const kind of ['dirty', 'permission', 'busy', 'pending', 'offline', 'channel', 'assignment', 'command']) {
    const f = fixture(platform);
    if (kind === 'permission') f.props.data = { ...f.props.data, canConfigure: false };
    else if (kind === 'offline') f.props.online = false;
    else if (['dirty', 'busy', 'pending'].includes(kind)) f.props[kind] = true;
    else if (kind === 'command') f.props.draft = { ...f.props.draft, commands: [{ ...f.props.draft.commands[0], enabled: false }] };
    else f.props.draft = { ...f.props.draft, targets: f.props.draft.targets.map((target,index) => index ? target : {
      ...target, ...(kind === 'channel' ? { electricianChannelId: '' } : { enabledCommandIds: [] })
    }) };
    f.render(); assert.equal(f.button('预览电工卡片').disabled, true, `${platform}/${kind}`);
    assert.equal(f.calls.length, 0);
  }
});

test('platform-wide automatic sync lives in Bot servers, remains an unsent draft and respects permissions', () => {
  for (const platform of ['discord', 'kook']) for (const language of ['zh', 'en']) {
    ui.setUiLocale(language);
    const f = fixture(platform); globalThis.location.hash = '#server-connection';
    const connection = f.render();
    assert.equal(ui.toggles.some(item => item.label === ui.t('档期卡片自动同步')), false, 'platform connection must not duplicate the Bot automation editor');
    assert.ok(connection.includes(`/admin/bot/servers?platform=${platform}`));
    const state = {data: {items: []}};
    const client = {getGeneration: () => 0, subscribeQuery: () => () => {}, getQueryState: () => state, fetchQuery: async () => state.data};
    const renderAutomation = () => {
      ui.begin(); ui.clearButtons();
      return renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: {client, zone: 'Asia/Shanghai', go() {}}}, React.createElement(ui.Automation, {
        platform, data: f.props.data, draft: f.props.draft, change: f.props.change, dirty: f.props.dirty,
        disabled: !f.props.data.canConfigure || f.props.online === false || f.props.busy || f.props.pending,
        onSave: f.props.onSave, onReset: f.props.onReset
      })));
    };
    const html = renderAutomation(), label = ui.t('档期卡片自动同步');
    assert.ok(html.includes(label));
    assert.ok(html.includes(ui.t('这是平台级总开关，影响此平台所有符合条件的目标。')));
    assert.ok(html.includes('selected-server')); assert.ok(html.includes('other-server'), 'both enabled bindings must be included in platform scope');
    const toggle = ui.toggles.find(item => item.label === label);
    assert.ok(toggle); assert.equal(toggle.checked, false); toggle.onChange({target: {checked: true}});
    assert.equal(f.props.draft.autoWipeCards, true); assert.equal(f.props.dirty, true); assert.equal(f.calls.length, 0);
    f.props.data = {...f.props.data, canConfigure: false}; renderAutomation();
    assert.equal(ui.toggles.find(item => item.label === label).disabled, true);
    f.props.data = {...f.props.data, canConfigure: true}; f.props.online = false; renderAutomation();
    assert.equal(ui.toggles.find(item => item.label === label).disabled, true);
  }
});

test('Discord adds one canonical wipe-react event command with the two supported signup modes', () => {
  ui.setUiLocale('en'); const f = fixture('discord', {empty: true}); f.render();
  assert.equal(ui.buttons.some(button => text(button.children) === ui.t('添加报名卡片')), false);
  f.button('添加 wipe-react 指令').onClick();
  const command = f.props.draft.commands[0];
  assert.deepEqual([command.id, command.type, command.slashCommand, command.signupMode], ['wipe', 'event_command', 'wipe-react', 'member_required']);
  const html = f.render();
  const modes = ui.selects.find(item => item['aria-label'] === ui.t('报名要求'));
  assert.ok(modes);
  assert.deepEqual(React.Children.toArray(modes.children).map(option => option.props.value), ['member_required', 'discord_only']);
  modes.onChange({target: {value: 'discord_only'}});
  assert.equal(f.props.draft.commands[0].signupMode, 'discord_only');
  assert.equal(f.props.draft.commands.length, 1); assert.equal(f.calls.length, 0);
});

test('Discord open sign-up is added disabled and is not silently assigned to a guild', () => {
  for (const locale of ['zh-CN','en']) {
    ui.setUiLocale(locale); const f=fixture('discord',{empty:true});f.render();
    f.button('添加开放报名指令').onClick();
    assert.deepEqual(f.props.draft.commands[0],{id:'newwipe',name:'开放报名',enabled:false,type:'event_command',slashCommand:'newwipe',titleTemplate:'',bodyTemplate:''});
    assert.deepEqual(f.props.draft.targets.map(target=>target.enabledCommandIds),[[],[]]);
    const html=f.render();
    assert.ok(html.includes(ui.t('/newwipe 开放报名')));
    assert.ok(html.includes(ui.t('此功能默认停用。启用后，在“服务器与权限”分配功能并配置使用权限、可用频道；保存后到“运行工具”注册 /newwipe。').replaceAll('&','&amp;')));
    assert.equal(ui.fields.length,0,'newwipe owns a Discord settings flow instead of an empty card template');
    assert.equal(f.calls.length,0);
  }
  const kook=fixture('kook',{empty:true});kook.render();
  assert.equal(ui.buttons.some(button=>text(button.children)===ui.t('添加开放报名指令')),false);
});

test('newwipe administrator default, explicit denial and guild-specific allowlists survive UI edits', () => {
  for (const locale of ['zh-CN','en']) {
    ui.setUiLocale(locale);const f=fixture('discord',{empty:true});globalThis.location.hash='#server-servers';
    f.props.draft={...f.props.draft,commands:[{id:'newwipe',name:'开放报名',type:'event_command',slashCommand:'newwipe',enabled:true}],
      targets:f.props.draft.targets.map((target,index)=>index===0?{...target,enabledCommandIds:['newwipe']}:target)};
    let html=f.render();
    assert.ok(html.includes(ui.t('开放报名指令权限')));
    let toggle=ui.toggles.find(item=>item.label===ui.t('允许服务器管理员使用'));
    assert.equal(toggle.checked,true);toggle.onChange(false);f.render();
    toggle=ui.toggles.find(item=>item.label===ui.t('允许服务器管理员使用'));
    assert.equal(toggle.checked,false);
    const ids=['1153571748147634238','1153571748147634239'];
    ui.fields.find(field=>field['aria-label']===ui.t('允许的 Discord 用户 ID')).onChange({target:{value:ids.join(', ')}});
    f.render();
    ui.fields.find(field=>field['aria-label']===ui.t('允许的角色 ID')).onChange({target:{value:'1153571748147634240'}});
    f.render();
    ui.fields.find(field=>field['aria-label']===ui.t('开放报名频道 ID')).onChange({target:{value:'1153571748147634241\n1153571748147634242'}});
    html=f.render();
    const selected=f.props.draft.targets[0];
    assert.equal(selected.newwipeAllowAdministrators,false);
    assert.deepEqual(selected.newwipeAllowedUserIds,ids);
    assert.deepEqual(selected.newwipeAllowedRoleIds,['1153571748147634240']);
    assert.deepEqual(selected.newwipeChannelIds,['1153571748147634241','1153571748147634242']);
    assert.equal(Object.hasOwn(f.props.draft.targets[1],'newwipeAllowedUserIds'),false);
    assert.equal(f.calls.length,0,'editing allowlists never registers commands or sends a card');
    f.props.data={...f.props.data,canConfigure:false};f.render();
    assert.ok(ui.fields.every(field=>field.disabled));
  }
});
