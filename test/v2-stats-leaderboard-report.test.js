import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLeaderboardReport } from '../server/v2/stats/leaderboard-report.js';
import { LEADERBOARD_STYLE } from '../server/v2/stats/leaderboard-style.js';
import { REPORT_COPY } from '../server/v2/stats/export-copy.js';
import { VITAL_LEADERBOARDS, rankLeaderboardRows } from '../shared/vital-leaderboards.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const metricLabels = {
  zh: { kills:'击杀', t3Kills:'T3 击杀', deaths:'死亡', kda:'KDA', rockets:'火箭', sulfur:'硫磺', metalOre:'金属矿', building:'建筑', onlineSeconds:'本服在线秒' },
  en: { kills:'Kills', t3Kills:'T3 kills', deaths:'Deaths', kda:'KDA', rockets:'Rockets', sulfur:'Sulfur', metalOre:'Metal ore', building:'Building', onlineSeconds:'Server online seconds' }
};
const observedValue = (row, key) => row.capabilities?.[key] === false || !Number.isFinite(row.values?.[key]) || row.values[key] < 0 ? null : row.values[key];
const player = (id, values, extra = {}) => ({ id, steamId:`7656119800000000${id}`, displayName:`Player ${id}`, squadName:'Alpha', status:'fresh', values, ...extra });
const data = () => ({
  wipe:{ title:'Vital Rust · EU Monthly', lifecycle:'ended', startedAt:'2026-07-30T15:59:17Z', closedAt:'2026-08-06T18:10:52Z' },
  items:[
    player('1',{kills:10,t3Kills:2,deaths:2,kda:null,rockets:1,sulfur:15000,metalOre:12000,building:100,onlineSeconds:3600}),
    player('2',{kills:10,t3Kills:1,deaths:0,kda:null,rockets:2,sulfur:5000,metalOre:0,building:50,onlineSeconds:0}),
    player('3',{kills:0,t3Kills:0,deaths:0,kda:null,rockets:0,sulfur:0,metalOre:null,building:0,onlineSeconds:null}),
    player('4',{kills:100,t3Kills:null,deaths:1,kda:null,rockets:null,sulfur:null,metalOre:null,building:null,onlineSeconds:null},{capabilities:{kills:false}})
  ]
});

function report(source = data(), { language = 'en', boards = VITAL_LEADERBOARDS, meta: overrides = {}, labeledMeta } = {}) {
  const names = metricLabels[language] || metricLabels.en;
  const t = key => REPORT_COPY[language]?.[key] || REPORT_COPY.en[key] || key;
  const meta = { generatedAt:'2026-10-06T09:15:00Z', title:source.wipe.title, ...overrides };
  return renderLeaderboardReport({
    data:source, meta, language, timeZone:'Asia/Shanghai', t,
    labeledMeta:labeledMeta || [[t('source'),'Vital Rust'],[t('generated'),'2026-10-06 17:15'],[t('zone'),'Asia/Shanghai']],
    rankings:boards.map(board => ({ ...board, title:board.label[language], rows:rankLeaderboardRows(source.items,board) })),
    status:value => ({stale:'Stale',partial:'Partial'})[value] || value,
    metricLabel:key => names[key] || key,
    number:value => value == null ? '-' : new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value),
    date:value => value, observedValue, display:row => row.displayName || row.steamId, escapeHtml
  });
}
const markup = html => html.slice(html.indexOf('<body>'));
const summaryCards = html => [...html.matchAll(/<div class="stat"><label>(.*?)<\/label><strong>(.*?)<\/strong><\/div>/g)].map(match => [match[1],match[2]]);
const firstTable = html => html.match(/<table class="leaderboard-table">([\s\S]*?)<\/table>/)[1];

test('approved layout uses RSG branding, eight summary cards and the complete nine metric table on every leaderboard', () => {
  const html = report();
  const body = markup(html);
  assert.equal((body.match(/data-ranking=/g) || []).length,7);
  assert.equal(summaryCards(body).length,8);
  assert.match(body,/<div class="cover-brand">Clan Portal<\/div>/);
  assert.equal(body.includes('NB Clan'),false);
  assert.match(LEADERBOARD_STYLE,/linear-gradient\(135deg, #5263d8, #5f8f86\)/);
  assert.match(LEADERBOARD_STYLE,/grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(LEADERBOARD_STYLE,/\.section\.result \{ background: #f4fbf8; border-color: #b7d8ca/);
  assert.match(LEADERBOARD_STYLE,/\.ranking-page \{ page-break-before: always; break-before: page/);
  assert.match(LEADERBOARD_STYLE,/\.leaderboard-table thead \{ display: table-header-group/);
  for (const [,table] of body.matchAll(/<table class="leaderboard-table">([\s\S]*?)<\/table>/g)) {
    const headers = table.match(/<thead>([\s\S]*?)<\/thead>/)[1];
    assert.equal((headers.match(/<th(?:>| )/g)||[]).length,12); // Rank, member, squad and nine metrics.
    for (const label of ['Kills','T3 kills','Deaths','KDA','Rockets','Sulfur','Metal ore','Building','Server playtime']) assert.ok(headers.includes(label),label);
    assert.equal((headers.match(/leaderboard-primary-stat/g)||[]).length,1);
    for (const [,row] of table.matchAll(/<tr(?: class="[^"]*")?>([\s\S]*?)<\/tr>/g)) {
      if (row.includes('<td')) assert.equal((row.match(/<td(?:>| )/g)||[]).length,12);
    }
  }
});

test('competition ranks and medals preserve tied first places, rank three, unobserved values and real zero', () => {
  const table = firstTable(report(data(),{boards:[VITAL_LEADERBOARDS[0]]}));
  assert.equal((table.match(/class="rank-gold"/g)||[]).length,2);
  assert.equal((table.match(/medal-gold/g)||[]).length,2);
  assert.equal(table.includes('rank-silver'),false);
  assert.equal((table.match(/class="rank-bronze"/g)||[]).length,1);
  assert.equal((table.match(/>#01<\/td>/g)||[]).length,2);
  assert.match(table,/>#03<\/td>/);
  const rows = [...table.matchAll(/<tr(?: class="[^"]*")?>([\s\S]*?)<\/tr>/g)].map(match => match[1]);
  const zero = rows.find(row => row.includes('Player 3'));
  const unsupported = rows.find(row => row.includes('Player 4'));
  assert.match(zero,/<td class="leaderboard-primary-stat">0<\/td>/);
  assert.match(unsupported,/<td class="leaderboard-rank">-<\/td>/);
  assert.match(unsupported,/<td class="leaderboard-primary-stat">-<\/td>/);
  assert.equal(unsupported.includes('medal'),false);
  assert.equal(unsupported.includes('>100</td>'),false);
  assert.equal((table.match(/<td>KDA<\/td>/g)||[]).length,0);
  assert.match(markup(report()),/Player 1 \/ Player 2<\/strong>/);
});

test('summary totals exclude unavailable values, keep zero and preserve missing totals', () => {
  const cards = summaryCards(report());
  assert.deepEqual(cards.slice(0,7),[['Members','4'],['Kills','20'],['T3 kills','3'],['Rockets','3'],['Sulfur','2w'],['Metal ore','1.2w'],['Building','150']]);
  const source = data();
  for (const row of source.items) { row.values.rockets = null; row.values.building = 0; }
  const changed = new Map(summaryCards(report(source)));
  assert.equal(changed.get('Rockets'),'-');
  assert.equal(changed.get('Building'),'0');
  assert.match(markup(report(source)),/No observed data<\/strong><div class="sub">-<\/div>/);
  assert.match(markup(report(source)),/1w = 10000\./);
});

test('online leaderboard converts seconds to hours exactly and contains the online metric only once', () => {
  const html = report(data(),{boards:[VITAL_LEADERBOARDS.at(-1)]});
  const table = firstTable(html);
  const headers = table.match(/<thead>([\s\S]*?)<\/thead>/)[1];
  assert.equal((headers.match(/Server playtime/g)||[]).length,1);
  assert.match(table,/<td class="leaderboard-primary-stat">1 h<\/td>/);
  assert.match(table,/<td class="leaderboard-primary-stat">0 h<\/td>/);
  assert.match(table,/<td class="leaderboard-primary-stat">-<\/td>/);
  assert.equal(markup(html).includes('Server online seconds'),false);
  assert.equal((markup(html).match(/class="cover"/g)||[]).length,1);
  assert.equal((markup(html).match(/data-ranking=/g)||[]).length,1);
});

test('duration uses actual archive boundaries or explicit range and never invents an archived end time', () => {
  const source = data();
  assert.equal(summaryCards(report(source)).at(-1)[1],'7.09');
  source.timeRange = {from:'2026-08-01T00:00:00Z',to:'2026-08-02T12:00:00Z'};
  assert.equal(summaryCards(report(source)).at(-1)[1],'1.5');
  delete source.timeRange;
  delete source.wipe.closedAt;
  assert.equal(summaryCards(report(source)).at(-1)[1],'-');
  source.wipe.lifecycle = 'active';
  source.wipe.startedAt = '2026-10-05T09:15:00Z';
  assert.equal(summaryCards(report(source)).at(-1)[1],'1');
  source.wipe.startedAt = '2026-10-07T09:15:00Z';
  assert.equal(summaryCards(report(source)).at(-1)[1],'-');
});

test('all supported languages have localized hour units, duration labels and missing-data notes', () => {
  const cases = [
    ['zh','档期天数','1 小时','助攻未被来源观测时'],
    ['en','Wipe duration (days)','1 h','source has not observed assists'],
    ['ru','Длительность вайпа (дни)','1 ч','Прочерк означает'],
    ['tr','Wipe süresi (gün)','1 sa.','Tire, gözlemlenmeyen'],
    ['th','ระยะเวลารอบ (วัน)','1 ชม.','ขีดหมายถึง'],
    ['ko','와이프 기간 (일)','1 시간','대시는 관측되지']
  ];
  for (const [language,days,hour,note] of cases) {
    const body = markup(report(data(),{language,boards:[VITAL_LEADERBOARDS.at(-1)]}));
    assert.ok(body.includes(days),language);
    assert.ok(body.includes(hour),language);
    assert.ok(body.includes(note),language);
    if (language !== 'zh') assert.equal(body.includes('档期天数'),false);
  }
});

test('names, squads, IDs and metadata remain complete and escaped, with static avatars and no external resources', () => {
  const source = data();
  const nickname = '<script>alert("x")</script>' + '超长中文玩家昵称'.repeat(30) + 'LongEnglishPlayerName'.repeat(30);
  const squad = '&<Alpha>' + 'Squad'.repeat(80);
  const steamId = '76561198000000001<script>';
  Object.assign(source.items[0],{displayName:nickname,squadName:squad,steamId,avatar:'https://example.test/avatar.png'});
  const body = markup(report(source,{labeledMeta:[['Source <script>','<img src=x onerror=alert(1)>'],['Long ID','uuid-'.repeat(100)]]}));
  assert.ok(body.includes(escapeHtml(nickname)));
  assert.ok(body.includes(escapeHtml(squad)));
  assert.ok(body.includes(escapeHtml(steamId)));
  assert.ok(body.includes('uuid-'.repeat(100)));
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(body.includes('<script>'),false);
  assert.equal(body.includes('<img'),false);
  assert.equal(body.includes('https://example.test'),false);
  assert.match(body,/class="avatar-fallback"/);
  assert.match(LEADERBOARD_STYLE,/\.leaderboard-identity > div \{ min-width: 0; flex: 1 1 0/);
  assert.equal(LEADERBOARD_STYLE.includes('text-overflow: ellipsis'),false);
});
