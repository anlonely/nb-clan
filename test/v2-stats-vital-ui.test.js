import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { EXPORT_RANKINGS } from '../src/i18n/languages.js';
import { VITAL_LEADERBOARDS, leaderboardById, rankLeaderboardRows } from '../shared/vital-leaderboards.js';
import { statsTimeRange } from '../src/v2/stats/time-range.js';
import { statsWorkspaceParams } from '../src/v2/stats/route.js';

const textContent = html => html.replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();
const tableCells = html => [...(html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1] || '')
  .matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell => textContent(cell[1]));

test('the seven legacy Vital leaderboards retain their fields, tied ranks and observed zeros', () => {
  assert.deepEqual(VITAL_LEADERBOARDS.map(spec => spec.id), EXPORT_RANKINGS.filter(spec => spec.id !== 'all').map(spec => spec.id));
  assert.equal(leaderboardById('online_minutes').metric, 'onlineSeconds');
  assert.equal(leaderboardById('onlineSeconds').id, 'online_minutes');
  const items = [
    { id: 'missing', values: { kills: null } }, { id: 'zero', values: { kills: 0 } },
    { id: 'b', values: { kills: 4 } }, { id: 'a', values: { kills: 4 } },
    { id: 'unsupported', values: { kills: 99 }, capabilities: { kills: false } }
  ];
  assert.deepEqual(rankLeaderboardRows(items, 'kills').map(({ row, value, rank }) => [row.id, value, rank]),
    [['a', 4, 1], ['b', 4, 1], ['zero', 0, 3], ['missing', null, null], ['unsupported', null, null]]);
  assert.equal(items[0].id, 'missing', 'ranking must not reorder the caller’s data');
});

test('changing the selected wipe clears that wipe’s revision and older-history cursor', () => {
  const current = new URLSearchParams('wipe=old&revision=7&hb=5&cursor=page2&ranking=kills&hidden=1&wc=older');
  const changed = statsWorkspaceParams(current, { wipe: 'new' });
  assert.equal(changed.get('wipe'), 'new');
  assert.equal(changed.has('revision'), false);
  assert.equal(changed.has('hb'), false);
  assert.equal(changed.has('cursor'), false);
  assert.equal(changed.get('ranking'), 'kills');
  assert.equal(statsWorkspaceParams(current, { revision: '3' }).get('hb'), '5');
  assert.equal(statsWorkspaceParams(current, { hidden: '', wipe: '' }).has('wc'), false);
});

test('export and interval dates resolve in the selected zone and reject incomplete or ambiguous periods', () => {
  assert.deepEqual(statsTimeRange({ from: '2026-10-06T20:00', to: '2026-10-06T21:00', timeZone: 'Asia/Shanghai' }),
    { from: '2026-10-06T12:00:00.000Z', to: '2026-10-06T13:00:00.000Z' });
  assert.deepEqual(statsTimeRange({ timeZone: 'Asia/Shanghai' }), {});
  for (const input of [{ from: '2026-10-06T20:00' }, { to: '2026-10-06T20:00' },
    { from: '2026-10-06T21:00', to: '2026-10-06T20:00' }, { required: true }]) {
    assert.throws(() => statsTimeRange({ timeZone: 'Asia/Shanghai', ...input }), { errorCode: 'INVALID_TIME_RANGE' });
  }
  assert.throws(() => statsTimeRange({ timeZone: 'Wrong/Zone' }), { errorCode: 'TIME_ZONE_INVALID' });
  const fold = { from: '2026-11-01T01:30', to: '2026-11-01T02:30', timeZone: 'America/New_York' };
  assert.throws(() => statsTimeRange(fold), { errorCode: 'TIME_AMBIGUOUS' });
  assert.deepEqual(statsTimeRange({ ...fold, fromOffset: '-04:00', toOffset: '-05:00' }),
    { from: '2026-11-01T05:30:00.000Z', to: '2026-11-01T07:30:00.000Z' });
  assert.throws(() => statsTimeRange({ from: '2026-03-08T02:30', to: '2026-03-08T03:30', timeZone: 'America/New_York' }),
    { errorCode: 'TIME_NONEXISTENT' });
});

test('the real stats UI exposes only the requested Vital source, history context, scope ranks and bilingual categories', async t => {
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(cache, 'vital-ui-'));
  const previousStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  try {
    const outfile = join(temporary, 'render.mjs');
    await build({ stdin: { contents: `export {default as StatsWorkspace, StatsTable, StatsSyncNotice, ExportDialog} from './src/v2/stats/index.jsx';
      export {VitalQueryCategories, vitalResultCategories, vitalWipeLabel} from './src/v2/stats/vital-result.jsx';
      export {AppContext} from './src/v2/context.jsx'; export {setUiLocale} from './src/v2/i18n.js';
      export {setDisplayTimeZone} from './src/v2/display-preferences.js';`, resolveDir: resolve('.') },
      outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' } });
    const ui = await import(pathToFileURL(outfile).href);
    const empty = {}, capability = { data: { sources: ['official', 'inventory', 'vital', 'moose', 'member'].map(sourceId => ({ sourceId, read: true, run: true })), catalogs: [{ provider: 'vital', read: true }] } };
    const snapshot = { data: { items: [{ id: 'member', memberId: 'm', displayName: 'AN', rank: 3, values: { kills: 0 },
      sourceId: 'vital', status: 'fresh', capturedAt: '2026-08-06T18:10:52.000Z' }], revision: 7,
      wipe: { id: 'history', title: 'EU Monthly' }, rankingScope: 'authorized_filtered_rows' } };
    const catalog = { data: { items: [{ id: 'history', title: 'EU Monthly' }] } };
    const sources = { data: { wipe: { id: 'history', title: 'EU Monthly', supportsVitalStats: true }, actions: {} } };
    const history = { data: { items: [{ revision: 7, provenance: 'legacy_capture', createdAt: '2026-08-06T18:10:52.000Z', reason: 'Archived' }] } };
    const client = { getGeneration: () => 1, getIdentity: () => ({ accountId: 'fixture-owner' }),
      getQueryState: key => ({ 'query-capabilities': capability, rows: snapshot, wipes: catalog, sources, history }[key[1]] || empty),
      subscribeQuery: () => () => {}, fetchQuery: async () => empty };
    const render = (component, props = {}, path = '/admin/stats', states = {}, observed = {}) => renderToStaticMarkup(React.createElement(ui.AppContext.Provider,
      { value: { client: { ...client, getQueryState: key => {
        observed.queries?.push(key);
        return Object.hasOwn(states, key[1]) ? states[key[1]] : client.getQueryState(key);
      } }, path, go: (...args) => observed.navigations?.push(args) } }, React.createElement(component, props)));
    ui.setDisplayTimeZone('Asia/Shanghai');
    for (const language of ['zh', 'en']) {
      ui.setUiLocale(language);
      await t.test(`${language}: both stats table layouts render projected avatars and keep initials for missing images`, () => {
        const avatarUrl = 'https://avatars.steamstatic.com/1234567890123456789012345678901234567890_full.jpg';
        for (const workspace of [false, true]) {
          const avatar = render(ui.StatsTable, { workspace, metricKeys: ['kills'], items: [
            { id: 'pictured', displayName: 'AN', memberId: 'member-a', avatarUrl, values: { kills: 1 } },
            { id: 'missing', displayName: 'BN', memberId: 'member-b', avatarUrl: '', values: { kills: 0 } }
          ] });
          assert.equal([...avatar.matchAll(/<img\b/g)].length, 1);
          assert.ok(avatar.includes(`src="${avatarUrl}"`));
          assert.match(avatar, /referrerPolicy="no-referrer"/i);
          assert.match(avatar, /class="avatar [^"]*"[^>]*>B<\/span>/);
        }
      });
      await t.test(`${language}: collection status uses real job counts, completion states and readable context errors`, () => {
        const counts = { total: 22, succeeded: 18, partial: 1, failed: 2, skipped: 1, pendingOrRunning: 0 };
        const partial = render(ui.StatsSyncNotice, { job: { id: 'real-job-id', status: 'partial', counts } });
        assert.match(textContent(partial), language === 'en' ? /Stats collection partially completed/ : /战绩采集部分完成/);
        assert.match(textContent(partial), /22\/22/);
        assert.match(partial, /href="\/admin\/sync\/jobs\/real-job-id"/);
        assert.doesNotMatch(textContent(partial), language === 'en' ? /Current stats update automatically/ : /采集期间会自动更新/);
        const running = render(ui.StatsSyncNotice, { job: { id: 'real-job-id', status: 'running', counts: { ...counts, pendingOrRunning: 3 } } });
        assert.match(textContent(running), /19\/22/);
        assert.match(textContent(running), language === 'en' ? /Current stats update automatically/ : /采集期间会自动更新/);
        for (const status of ['running', 'paused', 'retry_wait']) {
          const job = { id: 'real-job-id', status, counts: { ...counts, pendingOrRunning: 3 } };
          const workspace = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history', { 'sync-job': { data: job } });
          const refresh = workspace.match(/<button\b[^>]*title="(?:刷新已保存数据|Refresh saved data)"[^>]*>/)?.[0];
          assert.ok(refresh, 'the ordinary refresh action identifies the saved-data read');
          assert.doesNotMatch(refresh, /\bdisabled\b/, 'an active or paused collection must not lock ordinary reads');
          if (status !== 'running') {
            const waiting = render(ui.StatsSyncNotice, { job });
            assert.doesNotMatch(textContent(waiting), language === 'en' ? /Current stats update automatically/ : /采集期间会自动更新/);
          }
        }
        for (const status of ['succeeded', 'failed', 'cancelled', 'expired', 'no_work']) {
          const notice = render(ui.StatsSyncNotice, { job: { id: 'real-job-id', status, counts } });
          assert.doesNotMatch(notice, /undefined|NaN/);
          if (language === 'en') assert.doesNotMatch(notice, /[\u4e00-\u9fff]/);
        }
        for (const errorCode of ['SOURCE_CONTEXT_CHANGED', 'VITAL_WIPE_CONTEXT_CHANGED', 'VITAL_WIPE_START_REQUIRED', 'VITAL_WIPE_NOT_STARTED', 'VITAL_WIPE_NOT_FOUND', 'VITAL_WIPE_AMBIGUOUS', 'VITAL_WIPE_INVALID_DATA']) {
          const failure = render(ui.StatsSyncNotice, { error: { errorCode }, onRetry() {} });
          assert.doesNotMatch(textContent(failure), /读取失败|Load failed/);
          if (language === 'en') assert.doesNotMatch(failure, /[\u4e00-\u9fff]/);
        }
        if (language === 'en') for (const html of [partial, running]) assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
      });
      const historyEntry = language === 'en' ? /View archived participants and action history/ : /查看档案参与名单与操作记录/;
      const query = render(ui.StatsWorkspace, {}, '/admin/stats/query?source=vital&steam=76561198999999001&server=16&providerWipe=archived-wipe');
      assert.match(query, /Vital/);
      assert.match(query, /value="16"/);
      assert.match(query, /value="archived-wipe"/);
      assert.doesNotMatch(query, />Moose</);
      assert.doesNotMatch(query, /value="member"/);
      const ranked = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history&revision=7&ranking=kills');
      assert.match(ranked, language === 'en' ? /Rank within this scope/ : /范围内名次/);
      const rankedCells = tableCells(ranked);
      assert.equal(rankedCells[0], '3', 'the server-provided rank must remain visible, including ranks beyond this page');
      assert.match(rankedCells[1], /\bAN\b/, 'the rank must belong to the expected member');
      assert.equal(rankedCells[2], '0', 'an observed zero must remain visible instead of a missing-value dash');
      assert.match(textContent(ranked), historyEntry, 'historical snapshots retain access to their archived participant list');
      const categories = render(ui.VitalQueryCategories, { result: { categories: [{ id: 'combat', fields: [
        { id: 'combat.deathsT3', name: 'combat.deathsT3', value: 0, status: 'observed' },
        { id: 'combat.heals', name: 'combat.heals', value: null, status: 'not_observed' },
        { id: 'combat.revives', name: 'combat.revives', value: 1, status: 'observed' }
      ] }] } });
      assert.match(categories, language === 'en' ? /T3 deaths/ : /T3 死亡/);
      assert.match(categories, language === 'en' ? /Heals/ : /治疗次数/);
      assert.match(categories, language === 'en' ? /Revives/ : /救起队友次数/);
      const categoryValues = [...categories.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/g)].map(value => textContent(value[1]));
      assert.ok(categoryValues.includes('0'), 'categorized results must retain observed zeros');
      assert.ok(categoryValues.includes('—'), 'categorized results must retain missing values');
      const exportDialog = render(ui.ExportDialog, { query: { wipeId: 'history' }, onClose() {} });
      assert.match(exportDialog, /value="Asia\/Shanghai"/);
      assert.match(exportDialog, language === 'en' ? /All leaderboards/ : /全部榜单/);
      const queryExport = render(ui.ExportDialog, { query: { queryJobId: 'private-query' }, onClose() {} });
      assert.match(queryExport, language === 'en' ? /Export categorized query report/ : /导出分类查询报告/);
      assert.doesNotMatch(queryExport, /All leaderboards|全部榜单/);
      if (language === 'en') for (const html of [query, ranked, categories, exportDialog, queryExport]) assert.doesNotMatch(html, /[\u4e00-\u9fff]/);

      const currentRows = { data: { ...snapshot.data, revision: 0, archive: null } };
      await t.test(`${language}: current stats hide empty history actions without archive or audit permission`, () => {
        const current = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history', { rows: currentRows });
        assert.doesNotMatch(textContent(current), historyEntry);
        assert.match(textContent(current), language === 'en' ? /Current stats/ : /当前战绩/);
        assert.match(textContent(current), language === 'en' ? /Apply filters/ : /应用筛选/);
        const observed = { queries: [] };
        const legacyCategory = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history&category=farming&sort=kills', { rows: currentRows }, observed);
        const tableHeaders = html => textContent(html.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/)[1]);
        assert.equal(tableHeaders(legacyCategory), tableHeaders(current), 'old category links must show the complete overview');
        assert.ok(observed.queries.some(key => key[1] === 'rows' && key[2].sort === 'kills'), 'removed categories must not silently change the sort');
        assert.doesNotMatch(legacyCategory, /aria-label="(?:Stats category|数据分类)"/);
        const auditable = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history', {
          rows: currentRows, sources: { data: { ...sources.data, actions: { visibility: true } } }
        });
        assert.match(textContent(auditable), historyEntry, 'an actor with audit access must retain the history entry');
        if (language === 'en') for (const html of [current, auditable]) assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
      });

      await t.test(`${language}: current, filtered and historical empty states do not render an empty table`, () => {
        const emptyRows = { data: { ...currentRows.data, items: [] } };
        const cases = [
          ['/admin/stats?wipe=history', language === 'en' ? /No stats collected for this wipe yet/ : /此档期尚无战绩/],
          ['/admin/stats?wipe=history&q=no-match', language === 'en' ? /No matching members/ : /没有匹配的成员/],
          ['/admin/stats?wipe=history&revision=7', language === 'en' ? /No visible stats in this snapshot/ : /此快照暂无可见战绩/]
        ];
        for (const [path, expected] of cases) {
          const emptyState = render(ui.StatsWorkspace, {}, path, {
            rows: { data: { ...emptyRows.data, revision: path.includes('revision=7') ? 7 : 0 } }
          });
          assert.match(textContent(emptyState), expected);
          assert.doesNotMatch(emptyState, /<(?:table|thead|tbody)\b/, 'empty states must not leave misleading metric headers');
          if (path.includes('q=')) assert.match(textContent(emptyState), language === 'en' ? /Clear filters/ : /清除筛选/);
          if (path.includes('revision=')) assert.match(textContent(emptyState), language === 'en' ? /Historical snapshots show the data saved at the time/ : /历史快照只展示当时保存的数据/);
          if (language === 'en') assert.doesNotMatch(emptyState, /[\u4e00-\u9fff]/);
        }
      });

      await t.test(`${language}: loading retains view controls and source/history failures have readable recovery`, () => {
        const loading = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history', { rows: { status: 'loading', loading: true } });
        assert.match(textContent(loading), language === 'en' ? /Loading stats…/ : /正在读取战绩…/);
        assert.match(textContent(loading), language === 'en' ? /Stats overview/ : /数据总览/);
        assert.match(textContent(loading), language === 'en' ? /T3 kills/ : /T3 击杀/);
        assert.doesNotMatch(loading, /aria-label="(?:Stats category|数据分类)"/);
        const viewButtons = loading.match(/<nav\b[^>]*aria-label="(?:Vital leaderboard views|Vital 榜单视图)"[^>]*>([\s\S]*?)<\/nav>/);
        assert.ok(viewButtons, 'the overview and leaderboard controls must remain available');
        assert.equal([...viewButtons[1].matchAll(/<button\b/g)].length, 8, 'retain the overview and seven leaderboards');
        assert.doesNotMatch(loading, /<(?:table|thead)\b/);
        const error = { errorCode: 'SOURCE_TIMEOUT' };
        const sourceFailure = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history', {
          sources: { error }, rows: {}, history: {}
        });
        assert.match(textContent(sourceFailure), language === 'en' ? /Could not load this wipe’s source/ : /档期来源读取失败/);
        assert.match(textContent(sourceFailure), language === 'en' ? /Retry/ : /重试/);
        assert.doesNotMatch(textContent(sourceFailure), /Loading stats…|正在读取战绩…|Loading events…|正在加载安排…/);
        const historyFailure = render(ui.StatsWorkspace, {}, '/admin/stats?wipe=history', { history: { ...history, error } });
        assert.match(textContent(historyFailure), language === 'en' ? /Could not load snapshots/ : /快照列表暂不可用/);
        if (language === 'en') for (const html of [loading, sourceFailure, historyFailure]) assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
      });

      await t.test(`${language}: an expired cursor without cached rows offers an enabled first-page recovery`, () => {
        const path = '/admin/stats?wipe=history&cursor=expired';
        const observed = { queries: [], navigations: [] };
        const expired = render(ui.StatsWorkspace, {}, path, {
          rows: { status: 'error', error: { errorCode: 'CURSOR_EXPIRED' } }
        }, observed);
        const recoveryLabel = language === 'en' ? 'Go to first page' : '返回第一页';
        const recoveryButton = [...expired.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
          .find(button => textContent(button[2]) === recoveryLabel);
        assert.ok(recoveryButton, 'the recovery action must be visible even when no rows are cached');
        assert.doesNotMatch(recoveryButton[1], /\bdisabled(?:=|\s|$)/, 'the recovery action must be usable');
        assert.doesNotMatch(expired, /<(?:table|thead|tbody)\b/, 'an expired page must not fabricate a result table');
        assert.doesNotMatch(textContent(expired), /Loading stats…|正在读取战绩…/);
        assert.ok(observed.queries.some(key => key[1] === 'rows' && key[2].cursor === 'expired'),
          'the current URL cursor must remain in the query until the user chooses recovery');
        assert.deepEqual(observed.navigations, [], 'rendering the error must not silently rewrite the URL');
        if (language === 'en') assert.doesNotMatch(expired, /[\u4e00-\u9fff]/);
      });
    }
    const old = ui.vitalResultCategories({ fields: [{ name: 'combat.kills', value: 0 }, { name: 'future.stat', value: 3 }] });
    assert.equal(old.flatMap(category => category.fields).length, 2, 'older flat query results must retain unfamiliar fields');
    const wipe = { id: 'historical-id', providerWipeId: 'historical-id', name: '2026-07-30T15:59:17.000Z',
      startTime: '2026-07-30T15:59:17.000Z', endTime: '2026-08-06T18:10:52.000Z', state: 'archived' };
    const wipeLabel = ui.vitalWipeLabel(wipe, 'en', 'Asia/Shanghai');
    assert.equal(wipeLabel, '30/07/2026, 23:59 — 07/08/2026, 02:10');
    assert.doesNotMatch(wipeLabel, /historical-id|T15:59/);
    assert.match(ui.vitalWipeLabel({ ...wipe, endTime: null, state: 'current' }, 'en', 'Asia/Shanghai'), /Active/);
  } finally {
    if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage;
    await rm(temporary, { recursive: true, force: true });
  }
});
