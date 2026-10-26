import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

let ui, directory;
before(async () => {
  const root = resolve('.'), cache = join(root, 'node_modules/.cache');
  await mkdir(cache, {recursive: true});
  directory = await mkdtemp(join(cache, 'bot-open-signups-ui-'));
  await build({stdin: {contents: `
    export * from './src/v2/bot-admin/open-signups.jsx';
    export {default as OpenSignups} from './src/v2/bot-admin/open-signups.jsx';
    export {AppContext} from './src/v2/context.jsx';
    export {setUiLocale, t} from './src/v2/i18n.js';
    export {events, clearEvents} from 'test:open-signups-react';
  `, resolveDir: root}, outfile: join(directory, 'ui.mjs'), bundle: true,
  platform: 'node', format: 'esm', packages: 'external', loader: {'.css': 'empty'},
  plugins: [{name: 'open-signups-events', setup(plugin) {
    plugin.onResolve({filter: /^test:open-signups-react$/}, () => ({path: 'test:open-signups-react', namespace: 'open-signups-test'}));
    plugin.onResolve({filter: /^react$/}, args => /\/bot-admin\/open-signups\.jsx$/.test(args.importer)
      ? {path: 'test:open-signups-react', namespace: 'open-signups-test'} : undefined);
    plugin.onLoad({filter: /.*/, namespace: 'open-signups-test'}, () => ({loader: 'js', resolveDir: root, contents: `
      import React from 'react';
      export * from 'react';
      export const events = [];
      export function clearEvents() { events.length = 0; }
      export default {...React, createElement(type, props, ...children) {
        if (props?.onClick || props?.onChange || props?.onSubmit) events.push({type, props, children});
        return React.createElement(type, props, ...children);
      }};
    `}));
  }}]});
  ui = await import(pathToFileURL(join(directory, 'ui.mjs')).href);
});
after(async () => {await rm(directory, {recursive: true, force: true});});

const cardId = '123abc-card', discordId = '977082574801350667';
const readAt = '2026-10-15T04:00:00.000Z';
const card = {
  id: cardId, server: {id: '19', name: 'Vital Rust 2X EU Monthly'}, guild: {id: '1153571748147634236', name: 'Personal Test Server'},
  channel: {id: '1482399564274204774', name: 'sync-test'}, creator: {discordId, name: null},
  wipeAt: '2026-10-29T17:00:00.000Z', timeZone: 'Europe/London',
  createdAt: '2026-10-14T06:00:00.000Z', updatedAt: '2026-10-15T03:00:00.000Z',
  counts: {accepted: 1, declined: 0, late: 2, total: 3},
  publication: {status: 'published', messageId: '1559929737403568278', messageUrl: 'https://discord.com/channels/1153571748147634236/1482399564274204774/1559929737403568278', updatedAt: '2026-10-14T06:01:00.000Z'},
  update: {status: 'failed', updatedAt: '2026-10-15T03:01:00.000Z', errorCode: 'DISCORD_UNAVAILABLE'},
  settings: {directConnect: 'client.connect eu-monthly.vitalrust.com:28014', notes: 'Personal server only <script>no()</script>'},
  resolvedIp: {command: 'client.connect 168.100.161.198:28014'}, readAt
};
const listData = {items: [card], page: 2, pageSize: 25, total: 52, pages: 3,
  filters: {servers: [{id: '19', name: card.server.name}], guilds: [card.guild]}, readAt};
const rosterData = {items: [{discordId, name: 'AN', response: 'late', originalResponse: 'late_8h', updatedAt: '2026-10-15T03:02:00.000Z'}],
  counts: card.counts, page: 1, pageSize: 25, total: 1, pages: 1, readAt};

function fixture(path, {data = listData, detail = card, roster = rosterData, error = null, refreshError = false, locale = 'zh'} = {}) {
  ui.setUiLocale(locale); ui.clearEvents();
  const calls = [], routes = [], keys = [];
  const client = {getGeneration: () => 1, subscribeQuery: () => () => {},
    getQueryState: key => {
      keys.push(key);
      if (key[0] === 'bot-open-signup-roster') return {data: roster, error};
      if (key[0] === 'bot-open-signup') return {data: detail, error};
      return {data, error};
    },
    fetchQuery: async (key, request, options) => {
      calls.push({key, request, options});
      if (refreshError) throw {errorCode: 'NETWORK_ERROR'};
      return key[0] === 'bot-open-signup-roster' ? roster : key[0] === 'bot-open-signup' ? detail : data;
    }};
  const html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider,
    {value: {path, zone: 'Asia/Shanghai', client, go: value => routes.push(value), online: true}}, React.createElement(ui.OpenSignups)));
  return {html, calls, routes, keys, events: [...ui.events]};
}

test('list filters resolve calendar boundaries in the website zone, including DST days', () => {
  const params = new URL(ui.openSignupListRequest({from: '2026-10-30', to: '2026-10-30'}, 'Asia/Shanghai'), 'https://local.invalid').searchParams;
  assert.equal(params.get('from'), '2026-10-29T16:00:00.000Z');
  assert.equal(params.get('to'), '2026-10-30T16:00:00.000Z');
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const dst = new URL(ui.openSignupListRequest({from: date, to: date}, 'Europe/London'), 'https://local.invalid').searchParams;
    assert.equal((Date.parse(dst.get('to')) - Date.parse(dst.get('from'))) / 3_600_000, hours);
  }
  assert.throws(() => ui.openSignupListRequest({from: '2026-11-01', to: '2026-10-01'}, 'Asia/Shanghai'));
  assert.throws(() => ui.openSignupListRequest({from: '2026-02-30'}, 'Asia/Shanghai'));
});

test('list navigation preserves filters and paging while unsafe return paths are rejected', () => {
  const input = '/admin/bot/open-signups?serverId=19&guildId=1153571748147634236&from=2026-10-01&to=2026-10-31&status=published&q=Vital&sort=createdAt&order=asc&page=3';
  assert.equal(ui.openSignupReturnTo(input), input);
  for (const unsafe of ['https://elsewhere.example', '//elsewhere.example', '/admin/bot/open-signups/other', '/admin/bot/open-signups#bad'])
    assert.equal(ui.openSignupReturnTo(unsafe), '/admin/bot/open-signups');
  const parsed = ui.openSignupLocation('/admin/bot/open-signups?sort=unknown&order=invalid&page=-5&status=deleted');
  assert.equal(parsed.filters.sort, 'wipeAt'); assert.equal(parsed.filters.order, 'desc'); assert.equal(parsed.filters.page, 1); assert.equal(parsed.filters.status, '');
});

test('records show real publication state, accessible pagination and stable original-card navigation', () => {
  const {html, keys, events, routes} = fixture('/admin/bot/open-signups?serverId=19&q=Vital&page=2');
  assert.match(html, /Vital Rust 2X EU Monthly/);
  assert.match(html, /2026\/10\/30 01:00/);
  assert.match(html, /Asia\/Shanghai/);
  assert.match(html, /已发布/);
  assert.match(html, /returnTo=%2Fadmin%2Fbot%2Fopen-signups%3FserverId%3D19%26q%3DVital%26page%3D2/);
  assert.match(html, /href="\/admin\/bot\/open-signups\?serverId=19&amp;q=Vital&amp;page=3"/);
  assert.ok(keys.every(key => key[0] === 'bot-open-signups'));
  const sort = events.find(item => item.props['aria-label'] === ui.t('报名记录排序'));
  sort.props.onChange({target: {value: 'createdAt:asc'}});
  assert.equal(routes[0], '/admin/bot/open-signups?serverId=19&q=Vital&sort=createdAt&order=asc');
  assert.doesNotMatch(html, /<option[^>]*>Discord<\/option>/, 'a single supported platform must not become a useless filter');
});

test('detail uses the three normalized responses, safe profile links and original update evidence', () => {
  const returnTo = '/admin/bot/open-signups?serverId=19&page=2';
  const {html, keys} = fixture(`/admin/bot/open-signups/${cardId}?returnTo=${encodeURIComponent(returnTo)}&response=late`);
  assert.match(html, /href="\/admin\/bot\/open-signups\?serverId=19&amp;page=2"/);
  assert.match(html, /https:\/\/discord.com\/users\/977082574801350667/);
  assert.match(html, /https:\/\/discord.com\/channels\/1153571748147634236\/1482399564274204774\/1559929737403568278/);
  assert.match(html, /复制 Discord ID/);
  assert.match(html, /参加/); assert.match(html, /不参加/); assert.match(html, /迟到/);
  assert.equal((html.match(/class="open-signup-response-tabs"/g) || []).length, 1);
  assert.doesNotMatch(html, /late_8h|\+8h|Steam|首次报名/);
  assert.match(html, /更新失败/); assert.match(html, /已发布/);
  assert.match(html, /DISCORD_UNAVAILABLE/);
  assert.match(html, /client.connect eu-monthly.vitalrust.com:28014/);
  assert.match(html, /client.connect 168.100.161.198:28014/);
  assert.match(html, /Personal server only &lt;script&gt;no\(\)&lt;\/script&gt;/);
  assert.ok(keys.some(key => key[0] === 'bot-open-signup-roster' && key[2].includes('response=late')));
});

test('empty, unknown and failed states retain factual feedback and never claim expired signup closure', () => {
  let f = fixture('/admin/bot/open-signups', {data: {...listData, items: [], total: 0, pages: 0, page: 1}});
  assert.match(f.html, /还没有开放报名记录/);
  f = fixture('/admin/bot/open-signups?q=missing', {data: {...listData, items: [], total: 0, pages: 0, page: 1}});
  assert.match(f.html, /没有匹配的报名记录/);
  f = fixture('/admin/bot/open-signups', {data: {...listData, items: [{...card, wipeAt: '2026-10-01T00:00:00Z', publication: {status: 'unknown'}}]}});
  assert.match(f.html, /发布结果待核实/); assert.match(f.html, /Wipe 已过去/);
  assert.doesNotMatch(f.html, />已关闭报名<|>已过期</);
  f = fixture(`/admin/bot/open-signups/${cardId}`, {detail: {...card, creator: null, publication: {status: 'failed', messageUrl: 'javascript:alert(1)'}}});
  assert.doesNotMatch(f.html, /href="javascript:|打开 Discord 原消息<\/a>/);
  assert.match(f.html, /发布失败/); assert.match(f.html, /未记录/);
  f = fixture('/admin/bot/open-signups', {data: null, error: {errorCode: 'ACCESS_DENIED'}});
  assert.match(f.html, /当前账号没有访问权限/); assert.doesNotMatch(f.html, /Vital Rust/);
});

test('refresh rereads both card and attendee endpoints, without invoking a mutation', async () => {
  for (const refreshError of [false, true]) {
    const f = fixture(`/admin/bot/open-signups/${cardId}?response=late`, {refreshError});
    const refresh = f.events.find(({props, children}) => props.onClick && children.includes(ui.t('刷新')));
    assert.ok(refresh); await refresh.props.onClick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].request, `/api/v2/bot-admin/open-signups/${cardId}`);
    assert.ok(f.calls[1].request.startsWith(`/api/v2/bot-admin/open-signups/${cardId}/signups?response=late`));
    assert.ok(f.calls.every(call => call.options.force === true && !call.options.method && !call.options.body));
  }
});

test('record and attendee pages render all control copy in English', () => {
  for (const path of ['/admin/bot/open-signups', `/admin/bot/open-signups/${cardId}?response=late`]) {
    const {html} = fixture(path, {locale: 'en'});
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
    assert.match(html, /Accepted/); assert.match(html, /Declined/); assert.match(html, /Late/);
  }
});
