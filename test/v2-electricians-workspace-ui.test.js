import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

let ui, directory;
before(async () => {
  const root = resolve('.'), cache = join(root, 'node_modules/.cache');
  await mkdir(cache, {recursive: true});
  directory = await mkdtemp(join(cache, 'electricians-workspace-ui-'));
  // Render the actual page and UI. Control only its local hooks and query
  // boundary to exercise real callbacks through draft, save and retry states.
  const hooks = `
    import React from 'react';
    export * from 'react';
    const cells = []; let cursor = 0, changed = false, effects = [];
    export let elements = [];
    export function begin(clear = false) {
      cursor = 0; changed = false; elements = [];
      if (clear) { cells.length = 0; effects = []; }
    }
    export function useState(initial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial;
      return [cells[i], next => {
        const value = typeof next === 'function' ? next(cells[i]) : next;
        if (!Object.is(value, cells[i])) { cells[i] = value; changed = true; }
      }];
    }
    export function useRef(initial) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = {current: initial};
      return cells[i];
    }
    export function useEffect(callback, deps) {
      const i = cursor++, old = cells[i];
      if (!old || !deps || deps.some((value, j) => !Object.is(value, old[j]))) effects.push(callback);
      cells[i] = deps;
    }
    export function flush() { effects.splice(0).forEach(callback => callback()); return changed; }
    export default {...React, createElement(type, props, ...children) {
      if (props && (props.onClick || props.onChange || props.onSubmit || type === 'fieldset'))
        elements.push({type, props: {...props, children: props.children ?? children}});
      return React.createElement(type, props, ...children);
    }};
  `;
  const query = `
    export let state;
    export const setQuery = value => { state = value; };
    export const useQuery = (client, key, path) => path === '/api/v2/source-admin' ? {data: {}} : state;
  `;
  const toast = `export let toasts = []; export const clearToasts = () => {toasts = []}; export const notifySuccess = (...args) => toasts.push(args);`;
  await build({stdin: {contents: `
    export {default as Electricians} from './src/v2/platform-admin/electricians.jsx';
    export {default as PlatformAdmin} from './src/v2/platform-admin/index.jsx';
    export {UnlinkDialog, OperationNotice} from './src/v2/member-admin/index.jsx';
    export {AppContext} from './src/v2/context.jsx';
    export {t, setUiLocale} from './src/v2/i18n.js';
    export {begin, flush, elements} from 'workspace:hooks';
    export {setQuery} from 'workspace:query';
    export {toasts, clearToasts} from 'workspace:toast';
  `, resolveDir: root}, outfile: join(directory, 'ui.mjs'), bundle: true, platform: 'node', format: 'esm',
  packages: 'external', loader: {'.css': 'empty'}, plugins: [{name: 'electricians-workspace-harness', setup(plugin) {
    plugin.onResolve({filter: /^workspace:/}, args => ({path: args.path, namespace: 'workspace-test'}));
    plugin.onResolve({filter: /^(react|\.\.\/use-query\.jsx|\.\.\/toast\.jsx)$/}, args => {
      if (!/\/(?:platform-admin\/(?:electricians|index)|member-admin\/index)\.jsx$/.test(args.importer)) return;
      const name = args.path === 'react' ? 'hooks' : args.path.includes('use-query') ? 'query' : 'toast';
      return {path: `workspace:${name}`, namespace: 'workspace-test'};
    });
    plugin.onLoad({filter: /.*/, namespace: 'workspace-test'}, args => ({
      contents: args.path.endsWith('hooks') ? hooks : args.path.endsWith('query') ? query : toast,
      loader: 'js', resolveDir: root
    }));
    plugin.onLoad({filter: /\/member-admin\/index\.jsx$/}, async args => ({
      contents: await readFile(args.path, 'utf8') + '\nexport {UnlinkDialog, OperationNotice};',
      loader: 'jsx', resolveDir: dirname(args.path)
    }));
  }}]});
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => {await rm(directory, {recursive: true, force: true});});

const alpha = '76561198000000501', beta = '76561198000000502';
const profile = id => `https://steamcommunity.com/profiles/${id}/`;
const childrenText = value => React.Children.toArray(value).filter(child => typeof child === 'string' || typeof child === 'number').join('');
function fixture(overrides = {}, {online = true, request, retryFails = false} = {}) {
  ui.begin(true); ui.clearToasts();
  const data = {revision: 7, canConfigure: true, canSelectSpecialty: true, entries: [], resolved: {CN: [], EU: []},
    members: [
      {id: 'alpha', name: 'Alpha', steamId: alpha, specialties: ['electricity'], squadIds: ['squad-a']},
      {id: 'beta', name: 'Beta', steamId: beta, specialties: ['electricity'], squadIds: ['squad-b']},
      {id: 'gamma', name: 'Gamma', steamId: '76561198000000503', specialties: ['farming'], squadIds: ['squad-a']}
    ], squads: [{id: 'squad-a', name: 'Squad A'}, {id: 'squad-b', name: 'Squad B'}],
    specialties: {electricity: '电力', farming: '种植'}, ...overrides};
  const calls = [], reads = [], state = {data}; let committed = data;
  state.retry = async () => {reads.push(true); if (retryFails) throw {errorCode: 'NETWORK_ERROR'}; state.data = committed;};
  const app = {online, path: '/admin/platforms/electricians', go() {}, client: {async request(path, options) {
    calls.push({path, ...structuredClone(options)});
    const response = request ? await request(calls.at(-1), calls.length) : {data: {status: 'succeeded', current: {...state.data, revision: state.data.revision + 1, entries: options.body.entries}}};
    if (response.data?.current) committed = response.data.current;
    return response;
  }}};
  const render = (Component = ui.Electricians) => {
    let html;
    for (let i = 0; i < 5; i++) {
      ui.begin(); ui.setQuery(state);
      html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: app}, React.createElement(Component)));
      if (!ui.flush()) return html;
    }
    throw new Error('The page did not settle after its effects');
  };
  const button = (label, predicate = () => true) => {
    const found = ui.elements.find(({props}) => props.onClick && childrenText(props.children) === ui.t(label) && predicate(props));
    assert.ok(found, `Missing button: ${label}`); return found.props;
  };
  const field = label => {
    const found = ui.elements.find(({props}) => props.onChange && props['aria-label'] === ui.t(label));
    assert.ok(found, `Missing field: ${label}`); return found.props;
  };
  const change = (label, value) => {field(label).onChange({target: {value}}); render();};
  const click = label => {const item = button(label); assert.ok(!item.disabled, `Disabled button: ${label}`); item.onClick(); render();};
  const submit = () => {ui.elements.find(({props}) => props.onSubmit).props.onSubmit({preventDefault() {}}); return render();};
  const manual = (name, steamId) => {change('昵称', name); change('Steam 主页链接或 SteamID', steamId); return submit();};
  return {data, state, app, calls, reads, render, button, field, change, click, submit, manual};
}

test('the rich shared roster stays translated and its former platform tab is removed', () => {
  for (const language of ['zh', 'en']) {
    ui.setUiLocale(language); const f = fixture(), html = f.render();
    for (const label of ['统一管理电工好友，两端卡片共用同一份名单。', '手动添加', '选择成员', '按专长', '最终名单预览']) assert.ok(html.includes(ui.t(label)));
    assert.equal(/原卡将自动同步|sync automatically/.test(html), false);
    if (language === 'en') assert.equal(/[\u3400-\u9fff]/.test(html), false, 'the restored page must not leak untranslated UI');
    ui.begin(true); f.app.path = '/admin/platforms/not-a-platform'; const navigation = f.render(ui.PlatformAdmin);
    assert.ok(navigation.includes('href="/admin/platforms/sources"'));
    assert.equal(navigation.includes('href="/admin/platforms/electricians"'), false);
  }
});

test('manual entries validate, normalize SteamID, prevent duplicate sources, and stay drafts until saved', async () => {
  ui.setUiLocale('en'); const f = fixture(); f.render();
  let html = f.manual('Invalid', 'https://elsewhere.example/profile');
  assert.ok(html.includes(ui.t('请填写昵称和有效的 Steam 主页链接或 17 位 SteamID。')));
  html = f.manual('Alpha', alpha); assert.ok(html.includes(ui.t('有未保存的改动'))); assert.equal(f.calls.length, 0);
  html = f.manual('Duplicate', profile(alpha)); assert.ok(html.includes(ui.t('这些来源已在名单中，无需重复添加。')));
  await f.button('保存电工ID').onClick(); f.render();
  assert.deepEqual(f.calls[0].body, {expectedRevision: 7, entries: [{kind: 'manual', group: 'CN', name: 'Alpha', url: profile(alpha)}]});
  assert.equal(f.calls[0].path, '/api/v2/platform-admin/electricians'); assert.equal(f.calls[0].method, 'POST');
  assert.equal(ui.toasts[0][0], '电工 ID 已保存'); assert.ok(f.render().includes(ui.t('所有更改已保存')));
});

test('member search, select-all results and CN/EU groups submit member references rather than duplicated profile text', async () => {
  ui.setUiLocale('zh'); const f = fixture(); f.render(); f.click('选择成员'); f.change('搜索成员', 'Alpha');
  f.click('全选搜索结果'); f.submit();
  f.change('搜索成员', beta); f.click('EU电工'); f.click('全选搜索结果'); f.submit();
  assert.equal(f.calls.length, 0); await f.button('保存电工ID').onClick();
  assert.deepEqual(f.calls[0].body.entries, [{kind: 'member', group: 'CN', memberId: 'alpha'}, {kind: 'member', group: 'EU', memberId: 'beta'}]);
});

test('specialty/squad rules match real members and the preview deduplicates a Steam profile across all source types and groups', async () => {
  ui.setUiLocale('en'); const f = fixture(); f.render(); f.manual('Manual Alpha', alpha);
  f.click('选择成员'); f.change('搜索成员', 'Alpha'); f.click('EU电工'); f.click('全选搜索结果'); f.submit();
  f.click('按专长'); f.change('队伍范围', 'squad-a');
  assert.ok(f.render().includes(ui.t('当前匹配 {count} 位成员', {count: 1}))); f.submit();
  const html = f.render(), preview = html.split('class="electrician-preview-groups"')[1].split('</details>')[0];
  assert.equal((preview.match(/https:\/\/steamcommunity\.com\/profiles\/76561198000000501\//g) || []).length, 1);
  assert.ok(preview.includes('CN Electricians<span>1</span>')); assert.ok(preview.includes('EU Electricians<span>0</span>'));
  assert.ok(f.submit().includes(ui.t('这些来源已在名单中，无需重复添加。')));
  await f.button('保存电工ID').onClick();
  assert.equal(f.calls[0].body.entries.length, 3);
  assert.deepEqual(f.calls[0].body.entries[2], {kind: 'specialty', group: 'EU', specialty: 'electricity', squadId: 'squad-a'});
});

test('remove, undo and discard affect only the draft, and background reads do not silently replace it', async () => {
  ui.setUiLocale('en'); const original = {kind: 'manual', group: 'CN', name: 'Alpha', url: profile(alpha)};
  const f = fixture({entries: [original]}); f.render();
  ui.elements.find(({props}) => props['aria-label'] === ui.t('移除 {name}', {name: 'Alpha'})).props.onClick(); f.render(); f.click('撤销上一步');
  assert.ok(f.render().includes(ui.t('所有更改已保存')));
  f.manual('Beta', beta); f.state.data = {...f.data, revision: 8, entries: []}; f.render();
  assert.ok(f.render().includes('Beta'), 'a newer read must preserve the local draft');
  await f.button('保存电工ID').onClick(); assert.equal(f.calls[0].body.expectedRevision, 7, 'save must conflict rather than overwrite a concurrent edit');
  const g = fixture({entries: [original]}); g.render(); g.manual('Beta', beta); g.click('放弃更改');
  await g.button('放弃更改', props => props.kind === 'primary').onClick(); g.render();
  assert.equal(g.calls.length, 0); assert.equal(g.reads.length, 1); assert.ok(g.render().includes(ui.t('所有更改已保存')));
});

test('unknown saves lock editing and retry the exact original body/key despite a newer read; reload failure cannot undo confirmed success', async () => {
  ui.setUiLocale('en'); const f = fixture({}, {retryFails: true, request: async (call, count) => {
    if (count === 1) throw {status: 0, errorCode: 'NETWORK_ERROR'};
    return {data: {status: 'succeeded', current: {...f.data, revision: 8, entries: call.body.entries}}};
  }});
  f.render(); f.manual('Alpha', alpha); await f.button('保存电工ID').onClick(); f.render();
  assert.equal(ui.elements.find(({type}) => type === 'fieldset').props.disabled, true);
  assert.equal(f.button('放弃更改').disabled, true);
  f.state.data = {...f.data, revision: 8, entries: [{kind: 'member', group: 'EU', memberId: 'beta'}]}; f.render();
  await f.button('重试同次保存').onClick(); f.render();
  assert.deepEqual(f.calls[0], f.calls[1], 'retry must reuse the original operation and frozen request');
  assert.equal(f.button('保存电工ID').disabled, true); assert.equal(ui.toasts.length, 1);
  assert.equal(ui.elements.find(({type}) => type === 'fieldset').props.disabled, false);
});

test('read-only/offline access and specialty permissions prevent mutation, and the 200-source limit preserves the draft', () => {
  ui.setUiLocale('en');
  for (const mode of ['readonly', 'offline']) {
    const f = fixture({canConfigure: mode !== 'readonly'}, {online: mode !== 'offline'}); f.render(); f.manual('Alpha', alpha);
    assert.equal(ui.elements.find(({type}) => type === 'fieldset').props.disabled, true);
    assert.equal(f.button('保存电工ID').disabled, true); assert.equal(f.calls.length, 0);
  }
  const limited = fixture({canSelectSpecialty: false}); limited.render();
  assert.equal(ui.elements.some(({props}) => props.onClick && childrenText(props.children) === ui.t('按专长')), false);
  const entries = Array.from({length: 200}, (_, i) => ({kind: 'manual', group: 'CN', name: `Member ${i}`, url: profile(String(76561198000000000n + BigInt(i)))}));
  const full = fixture({entries}); full.render(); const html = full.manual('Overflow', alpha);
  assert.ok(html.includes(ui.t('最多保存 200 个手动条目、成员或专长规则。'))); assert.equal(full.calls.length, 0);
  assert.ok(html.includes(ui.t('所有更改已保存')));
});

function unlinkFixture({state = {status: 'idle'}, observation, recover, retry} = {}) {
  ui.begin(true); const calls = [], writes = [], recoveries = [], retries = [];
  let current = state, generation = 1, closed = 0;
  const ops = {snapshot: () => current, async recover() {recoveries.push(current.operationId); if (recover) current = await recover(current);},
    async retry() {retries.push(current.operationId); current = retry ? await retry(current) : {...current, status: 'success'};}};
  const app = {client: {getGeneration: () => generation, async request(path, options) {
    calls.push({path, options}); return observation ? observation(() => {generation++;}) : {data: {memberId: 'alpha', provider: 'discord', expectedRevision: 2, expectedIdentityFingerprint: 'verified-fingerprint'}};
  }}};
  const props = {id: 'alpha', provider: 'discord', busy: ['unknown', 'submitting'].includes(current.status), operationState: current, operations: ops,
    close() {closed++;}, async act(path, body) {writes.push({path, body}); current = {status: 'success'}; return {revoked: true};}};
  const render = (notice = false) => {
    props.operationState = current; props.busy = ['unknown', 'submitting'].includes(current.status);
    ui.begin();
    const html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider, {value: app}, React.createElement(notice ? ui.OperationNotice : ui.UnlinkDialog, notice ? {ops, state: current} : props)));
    ui.flush(); return html;
  };
  const submit = () => ui.elements.find(({props}) => props.onSubmit).props.onSubmit({preventDefault() {}});
  return {render, submit, props, calls, writes, recoveries, retries, get closed() {return closed;}};
}

test('simplified unlink confirms once, validates fresh evidence, and prevents concurrent clicks or closing during the request', async () => {
  for (const language of ['zh', 'en']) {
    ui.setUiLocale(language); let release;
    const f = unlinkFixture({observation: () => new Promise(resolve => {release = resolve;})});
    const html = f.render(); assert.ok(html.includes(ui.t('请确认操作')));
    assert.ok(html.includes(ui.t('解除 {provider} 的关联并撤销相关登录会话。Steam 归属保留。', {provider: 'Discord'})));
    const first = f.submit(); await f.submit(); f.render();
    ui.elements.find(({props}) => props.onClick && childrenText(props.children) === ui.t('取消')).props.onClick();
    assert.equal(f.closed, 0); assert.equal(f.calls.length, 1);
    release({data: {memberId: 'alpha', provider: 'discord', expectedRevision: 2, expectedIdentityFingerprint: 'verified-fingerprint'}});
    await first;
    assert.deepEqual(f.writes, [{path: '/members/alpha/unlink', body: {provider: 'discord', expectedRevision: 2, expectedIdentityFingerprint: 'verified-fingerprint'}}]);
    assert.equal(f.closed, 1);
  }
  for (const kind of ['member', 'provider', 'fingerprint', 'generation']) {
    const f = unlinkFixture({observation: changeIdentity => {
      if (kind === 'generation') changeIdentity();
      return {data: {memberId: kind === 'member' ? 'beta' : 'alpha', provider: kind === 'provider' ? 'kook' : 'discord', expectedRevision: 2,
        expectedIdentityFingerprint: kind === 'fingerprint' ? '' : 'verified-fingerprint'}};
    }});
    f.render(); await f.submit(); assert.equal(f.writes.length, 0, kind); assert.equal(f.closed, 0, kind);
  }
});

test('only the same member/provider unlink can recover and retry; closing its modal retains the global receipt controls', async () => {
  ui.setUiLocale('en');
  const pending = {status: 'unknown', operationId: 'same-operation', provider: 'discord', path: '/api/v2/member-admin/members/alpha/unlink'};
  const f = unlinkFixture({state: pending}); f.render(); await f.submit();
  assert.deepEqual(f.recoveries, ['same-operation']); assert.deepEqual(f.retries, ['same-operation']);
  assert.equal(f.calls.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.closed, 1);
  for (const state of [{...pending, provider: 'kook'}, {...pending, path: '/api/v2/member-admin/members/beta/unlink'}]) {
    const other = unlinkFixture({state}); other.render(); await other.submit();
    assert.equal(other.calls.length + other.writes.length + other.retries.length + other.recoveries.length, 0);
  }
  const notice = unlinkFixture({state: pending}).render(true);
  assert.ok(notice.includes(ui.t('查询提交结果'))); assert.ok(notice.includes(ui.t('使用原编号重试')));
});
