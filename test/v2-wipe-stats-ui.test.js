import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const avatarUrl = 'https://avatars.steamstatic.com/1234567890123456789012345678901234567890_full.jpg';
const own = { id: 'own-row', memberId: 'session-member', displayName: 'My Player', steamId: '76561198000000001',
  avatarUrl, status: 'fresh', capturedAt: '2026-10-15T18:00:00Z',
  values: { kills: 0, deaths: 2, kd: 0, assists: null, kda: null, sulfur: 1200, onlineSeconds: 5400 },
  capabilities: { kda: false } };
const foreign = { ...own, id: 'foreign-row', memberId: 'other-member', displayName: 'Other Player', steamId: '76561198000000002' };

test('the real member wipe stats tab scopes queries to the session member and renders safe bilingual states', async t => {
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'wipe-stats-ui-'));
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const outfile = join(temporary, 'render.mjs');
    await build({ stdin: { contents: `export {default as WipeStats, PersonalStatsResult} from './src/v2/wipe-stats.jsx';
      export {default as WipePage} from './src/v2/wipe.jsx';
      export {AppContext} from './src/v2/context.jsx'; export {setUiLocale} from './src/v2/i18n.js';
      export {setDisplayTimeZone} from './src/v2/display-preferences.js';`, resolveDir: resolve('.') },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' },
      // Observe declared URLs/options while retaining the actual React query hook.
      // SSR does not execute effects; browser transport is verified separately.
      plugins: [{ name: 'observe-personal-query', setup(build) {
        build.onResolve({ filter: /use-query\.jsx$/ }, args => args.importer.endsWith('/wipe-stats.jsx')
          ? { path: 'observed-personal-query', namespace: 'query-observer' } : null);
        build.onLoad({ filter: /.*/, namespace: 'query-observer' }, () => ({ contents: `
          import {useQuery as actual} from ${JSON.stringify(resolve('src/v2/use-query.jsx'))};
          export function useQuery(client,key,path,options) {
            client.recordDeclaredQuery(key,path,options); return actual(client,key,path,options);
          }`, loader: 'js', resolveDir: resolve('.') }));
      } }] });
    const ui = await import(pathToFileURL(outfile).href);
    ui.setDisplayTimeZone('Asia/Shanghai');
    const empty = {};
    const defaultSources = { data: { wipe: { id: 'test-wipe', lifecycle: 'active', supportsVitalStats: true }, archiveRevision: 0 } };
    const summary = { data: { wipe: { id: 'test-wipe', title: 'Test Wipe', lifecycle: 'active', revision: 1,
      contentRevision: 1, timeZone: 'Asia/Shanghai', serverScheduledWipeAt: '2026-10-15T16:00:00Z',
      signupClosesAt: '2026-10-15T15:00:00Z', effectiveSignupWindow: 'closed', serverSnapshot: { name: 'Vital Server' } },
      mySignup: null, counts: { confirmedAttending: 0, plannedAttending: 0, unanswered: 1, notAttending: 0 } } };
    const render = ({ component = ui.WipeStats, props = { id: 'test-wipe' }, sources = defaultSources,
      rows = { data: { items: [own, foreign] } }, session = { memberId: 'session-member', roleId: 'member' },
      path = '/app/wipes/test-wipe?tab=stats&memberId=other-member', wipeSummary = summary } = {}) => {
      const queries = [], stateReads = [];
      const client = { getGeneration: () => 1, subscribeQuery: () => () => {}, subscribeIdentity: () => () => {},
        fetchQuery: async () => empty,
        recordDeclaredQuery: (key, url, options = {}) => queries.push({ key, url, enabled: options.enabled !== false }),
        getQueryState: key => { stateReads.push(key); return key[0] === 'wipe' ? wipeSummary
          : key[1] === 'sources' ? sources : key[1] === 'personal' ? rows : empty; } };
      const html = renderToStaticMarkup(React.createElement(ui.AppContext.Provider,
        { value: { client, session, path, zone: 'Asia/Shanghai', go() {} } }, React.createElement(component, props)));
      return { html, text: plain(html), queries, stateReads };
    };
    for (const language of ['zh', 'en']) {
      ui.setUiLocale(language);
      const english = language === 'en';
      const assertLocale = html => { if (english) assert.doesNotMatch(html, /[\u4e00-\u9fff]/); };
      await t.test(`${language}: member and administrator views always request only the authenticated member`, () => {
        for (const roleId of ['member', 'admin', 'owner']) {
          const result = render({ props: { id: 'wipe /?&' }, session: { memberId: 'session-member', roleId } });
          const rows = result.queries.find(query => query.key[1] === 'personal');
          assert.ok(rows?.enabled);
          assert.deepEqual(Object.fromEntries(new URL(rows.url, 'https://example.test').searchParams), {
            wipeId: 'wipe /?&', memberId: 'session-member', sourceId: 'vital', metricVersion: 'nb-kda-1', revision: '0'
          });
          assert.equal(result.queries[0].url, '/api/v2/stats/wipes/wipe%20%2F%3F%26/sources');
          assert.deepEqual(rows.key, ['stats', 'personal', {
            wipeId: 'wipe /?&', memberId: 'session-member', sourceId: 'vital', metricVersion: 'nb-kda-1', revision: '0'
          }]);
          assert.match(result.text, /My Player/);
          assert.doesNotMatch(result.html, /Other Player|76561198000000002/);
          assert.equal([...result.html.matchAll(/<img\b/g)].length, 1);
          assert.ok(result.html.includes(`src="${avatarUrl}"`));
          assert.match(result.html, /referrerPolicy="no-referrer"/i);
          assertLocale(result.html);
        }
      });
      await t.test(`${language}: an unverified session never enables a stats query even with cached data`, () => {
        const result = render({ session: { memberId: null, roleId: 'admin' } });
        assert.match(result.text, english ? /Complete member verification first/ : /请先完成成员验证/);
        assert.match(result.html, /href="\/app\/me"/);
        assert.equal(result.queries.length, 1);
        assert.equal(result.queries[0].enabled, false);
        assert.equal(result.queries.some(query => query.key[1] === 'personal'), false);
        assert.doesNotMatch(result.html, /My Player|Other Player|<img\b/);
        assertLocale(result.html);
      });
      await t.test(`${language}: unsupported sources do not declare a player query`, () => {
        const result = render({ sources: { data: { ...defaultSources.data, wipe: { ...defaultSources.data.wipe, supportsVitalStats: false } } } });
        assert.match(result.text, english ? /does not provide Vital stats/ : /此档期不是 Vital 战绩来源/);
        assert.equal(result.queries.some(query => query.key[1] === 'personal'), false);
        assertLocale(result.html);
      });
      await t.test(`${language}: ended and archived wipes select the saved archive revision`, () => {
        for (const [lifecycle, archiveRevision, expected] of [['ended', 7, '7'], ['archived', 3, '3'], ['ended', 0, '0'], ['active', 7, '0']]) {
          const result = render({ sources: { data: { ...defaultSources.data, archiveRevision,
            wipe: { ...defaultSources.data.wipe, lifecycle } } } });
          assert.equal(new URL(result.queries.find(query => query.key[1] === 'personal').url, 'https://example.test').searchParams.get('revision'), expected);
          assertLocale(result.html);
        }
      });
      await t.test(`${language}: the real WipePage stats tab works without a signup or signup permission`, () => {
        const result = render({ component: ui.WipePage,
          session: { memberId: 'session-member', roleId: 'member', participation: { canSignup: false } } });
        assert.match(result.text, english ? /My stats for this wipe/ : /我的本场战绩/);
        assert.match(result.text, /My Player/);
        assert.doesNotMatch(result.text, /Other Player/);
        assert.equal(result.queries.filter(query => query.key[1] === 'personal').length, 1);
        assert.equal(result.stateReads.some(key => key[0] === 'signups'), false);
        assertLocale(result.html);
      });
      await t.test(`${language}: observed zero, unsupported values and durations remain distinct`, () => {
        const result = render();
        const fields = [...result.html.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)]
          .map(([, name, value]) => [plain(name), plain(value)]);
        const values = Object.fromEntries(fields);
        assert.equal(values[english ? 'Kills' : '击杀'], '0');
        assert.equal(values[english ? 'Assists' : '助攻'], '—');
        assert.equal(values.KDA, '—');
        assert.equal(values[english ? 'Server playtime' : '本服在线时间'], english ? '1.5 hours' : '1.5 小时');
        assertLocale(result.html);
      });
      await t.test(`${language}: empty, loading, initial failures and cached failures provide readable states`, () => {
        const none = render({ rows: { data: { items: [foreign] } } });
        assert.match(none.text, english ? /Your stats for this wipe are not available yet/ : /本档暂未取得你的战绩/);
        assert.match(none.html, /href="\/app\/me"/);
        assert.doesNotMatch(none.html, /Other Player|<dl\b|<img\b/);
        assertLocale(none.html);
        for (const target of ['sources', 'rows']) {
          const loading = render({ [target]: { status: 'loading', loading: true } });
          assert.match(loading.text, english ? /Loading/ : /正在加载/);
          assert.doesNotMatch(loading.html, /Other Player/);
          assertLocale(loading.html);
          const error = render({ [target]: { error: { errorCode: 'NETWORK_UNAVAILABLE' } } });
          assert.match(error.text, english ? /Retry/ : /重试/);
          assert.doesNotMatch(error.html, /Other Player|<img\b/);
          assertLocale(error.html);
        }
        const cached = render({ rows: { data: { items: [own, foreign] }, error: { errorCode: 'NETWORK_UNAVAILABLE' } } });
        assert.match(cached.text, english ? /Showing previously loaded data/ : /显示上次读取的数据/);
        assert.match(cached.text, /My Player/);
        assert.doesNotMatch(cached.html, /Other Player/);
        assertLocale(cached.html);
      });
    }
  } finally {
    globalThis.sessionStorage = previousStorage;
    await rm(temporary, { recursive: true, force: true });
  }
});
