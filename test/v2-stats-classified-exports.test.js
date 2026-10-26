import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { vitalFieldLabel } from '../shared/vital-field-labels.js';
import { exportDocument, createExportRenderer } from '../server/v2/stats/exports.js';

const player = (id, values, extra = {}) => ({ id, memberId:id, steamId:'7656119800000000' + id, displayName:'Player ' + id, squadName:'Alpha', capturedAt:'2026-09-12T13:00:00Z', status:'fresh', values, ...extra });
const data = () => ({ wipe:{ id:'period-test', title:'Vital Rust - EU 2x', serverName:'Vital Rust EU', serverId:'12', providerWipeId:'2026-09-12', lifecycle:'ended', startedAt:'2026-09-12T12:00:00Z', closedAt:'2026-09-19T12:00:00Z' }, sourceId:'vital', metricVersion:'nb-kda-1', revision:3, dataRevision:'version-test', countScope:'authorized_stats_rows', items:[
  player('1',{kills:10,deaths:2,kd:5,onlineSeconds:0}),
  player('2',{kills:10,deaths:0,kd:10,onlineSeconds:3600}),
  player('3',{kills:0,deaths:0,kd:0,onlineSeconds:null}),
  player('4',{kills:null,deaths:1,kd:null,onlineSeconds:7200}),
  player('5',{kills:100,deaths:1,kd:100},{capabilities:{kills:false}})
] });

test('all seven categories preserve observed totals, tied leaders, missing ranks and observed zero', () => {
  const doc = exportDocument(data(), { language:'en', ranking:'all', timeZone:'Asia/Shanghai' });
  const json = JSON.parse(doc.json);
  assert.deepEqual(json.rankings.map(r => r.id), ['kills','t3Kills','rockets','metalOre','sulfur','building','online_minutes']);
  const kills = json.rankings[0];
  assert.equal(kills.total,20); assert.equal(kills.observed,3); assert.equal(kills.missing,2);
  assert.deepEqual(kills.leaders,['Player 1','Player 2']);
  assert.deepEqual(kills.rows.map(r => [r.memberId,r.value,r.rank]), [['1',10,1],['2',10,1],['3',0,3],['4',null,null],['5',null,null]]);
  assert.equal(json.rankings[1].total,null);
  assert.ok(doc.html.includes('<label>T3 kills</label><strong>-</strong>'));
  assert.equal((doc.html.match(/data-ranking=/g) || []).length,7);
  assert.ok(doc.html.includes('76561198000000001')); assert.ok(doc.html.includes('Alpha'));
  assert.equal(doc.meta.serverId,'12'); assert.equal(doc.meta.providerWipeId,'2026-09-12');
  assert.equal(doc.meta.capturedFrom,'2026-09-12T13:00:00Z');
  assert.ok(doc.html.includes('09/12/2026, 21:00')); // Selected time zone is visible, not only metadata.
});

test('single category CSV is ordered by that category with units and no unrelated columns', async () => {
  const doc = exportDocument(data(), {language:'zh', ranking:'onlineSeconds'});
  assert.equal(doc.meta.ranking,'online_minutes');
  assert.ok(doc.csv.includes('"排名","成员","Steam ID","队伍","本服在线秒","数据状态"'));
  assert.ok(doc.csv.includes('"3","Player 1","76561198000000001","Alpha","0","fresh"'));
  assert.ok(doc.csv.indexOf('"1","Player 4"') < doc.csv.indexOf('"3","Player 1"'));
  assert.equal((doc.html.match(/data-ranking=/g) || []).length,1);
  let captured;
  const render = createExportRenderer({renderBinary:async(html,format,options)=>{captured={html,format,options};return Buffer.from('%PDF-local');}});
  const result = await render(data(),{format:'pdf',ranking:'sulfur',language:'en'});
  assert.equal(captured.format,'pdf'); assert.equal((captured.html.match(/data-ranking=/g)||[]).length,1);
  assert.deepEqual(captured.options,{layout:'leaderboard'});
  assert.match(result.fileName,/-sulfur\.pdf$/);
  assert.equal(result.meta.ranking,'sulfur');
  assert.equal(result.mime,'application/pdf');
});

test('query report renders categorized fields and history context as tables, with missing distinct from zero', () => {
  const source = data();
  source.wipe = {id:'query-1',title:'独立查询结果'};
  source.items = [];
  source.queryResult = {steamId:'76561198000000001',displayName:'<img src=x>',serverId:'12',providerWipeId:'past-wipe',fetchedAt:'2026-09-12T13:00:00Z',status:'fresh',
    categories:[{id:'combat',fields:[{name:'combat.kills',value:0,status:'observed'},{name:'combat.assists',value:null,status:'unsupported'}]}, {id:'pve',fields:[{name:'pve.animalsKilled',value:12,status:'observed'}]}], fields:[{name:'combat.kills',value:0,status:'observed'}]};
  const doc = exportDocument(source,{language:'en'});
  assert.equal(doc.meta.serverId,'12'); assert.equal(doc.meta.providerWipeId,'past-wipe');
  assert.ok(doc.html.includes('<h2>Combat</h2>')); assert.ok(doc.html.includes('<h2>PvE</h2>'));
  assert.ok(doc.html.includes('<td>0</td><td>Observed</td>'));
  assert.ok(doc.html.includes('<td>-</td><td>Unsupported</td>'));
  assert.ok(doc.html.includes('pve.animalsKilled')); assert.ok(doc.html.includes('&lt;img src=x&gt;'));
  assert.equal(doc.html.includes('<pre>'),false); assert.equal(doc.html.includes('<img src=x>'),false);
  assert.equal(doc.html.includes('独立查询结果'),false);
  assert.ok(doc.html.includes('Clan Portal'));
  assert.equal(doc.html.includes('NB Clan'),false);
});

test('all PDF rankings render sequentially into exactly seven safe, branded PDF entries', async () => {
  const source = data();
  source.wipe.id = '../../private/<script>period';
  source.wipe.title = '<script>alert("x")</script> Vital';
  // Export data has already been filtered by StatsService.collect. Other data
  // on the input must not be included in any of the seven rendered reports.
  source.items = source.items.slice(0,3);
  source.excludedRows = [player('excluded',{kills:999},{displayName:'Excluded private member'})];
  let active=0, maximumActive=0;
  const calls=[];
  const render = createExportRenderer({renderBinary:async(html,format,options)=>{
    active++; maximumActive=Math.max(maximumActive,active);
    await new Promise(resolve=>setImmediate(resolve));
    calls.push({html,format,options});
    active--;
    return Buffer.from('%PDF-test\n'+html);
  }});
  const result = await render(source,{format:'pdf',ranking:'all',language:'en',timeZone:'UTC'});
  assert.equal(maximumActive,1); assert.equal(calls.length,7);
  assert.equal(result.mime,'application/zip');
  assert.match(result.fileName,/-all-rankings\.zip$/);
  assert.equal(/[\\/]/.test(result.fileName),false);
  assert.equal(result.meta.ranking,'all'); assert.equal(result.meta.rowCount,3);
  assert.equal(result.meta.countScope,'authorized_stats_rows'); assert.equal(result.meta.dataRevision,'version-test');
  assert.equal(result.meta.format,'zip'); assert.equal(result.meta.documentFormat,'pdf'); assert.equal(result.meta.fileCount,7);
  const bytes=Buffer.from(result.base64,'base64');
  assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
  const zip=await JSZip.loadAsync(bytes);
  const entries=Object.values(zip.files);
  assert.equal(entries.length,7); assert.equal(entries.some(entry=>entry.dir),false);
  assert.deepEqual(result.meta.documents.map(file=>file.ranking),['kills','t3Kills','rockets','metalOre','sulfur','building','online_minutes']);
  assert.deepEqual(entries.map(entry=>entry.name),result.meta.documents.map(file=>file.fileName));
  for (let index=0;index<entries.length;index++) {
    const entry=entries[index], expected=result.meta.documents[index];
    assert.match(entry.name,/^[A-Za-z0-9_-]+\.pdf$/);
    const pdf=await entry.async('nodebuffer');
    assert.equal(pdf.subarray(0,9).toString(),'%PDF-test');
    assert.equal(expected.sizeBytes,pdf.length);
    assert.equal(expected.sha256,createHash('sha256').update(pdf).digest('hex'));
    const html=calls[index].html;
    assert.equal(calls[index].format,'pdf'); assert.deepEqual(calls[index].options,{layout:'leaderboard'});
    assert.equal((html.match(/data-ranking=/g)||[]).length,1);
    assert.ok(html.includes(`data-ranking="${expected.ranking}"`));
    assert.ok(html.includes('Clan Portal')); assert.equal(html.includes('NB Clan'),false);
    assert.ok(html.includes('Player 1')); assert.ok(html.includes('Player 2')); assert.ok(html.includes('Player 3'));
    assert.equal(html.includes('Excluded private member'),false); assert.equal(html.includes('Player 4'),false);
    assert.equal(html.includes('<script>alert'),false); assert.ok(html.includes('&lt;script&gt;'));
  }
});

test('all PDF archive stops on a failed render and never publishes a partial ZIP', async () => {
  let calls=0;
  const failure=Object.assign(new Error('render failed'),{errorCode:'EXPORT_RENDER_FAILED'});
  const render=createExportRenderer({renderBinary:async()=>{
    if (++calls===3) throw failure;
    return Buffer.from('%PDF-test');
  }});
  await assert.rejects(render(data(),{format:'pdf',ranking:'all'}),failure);
  assert.equal(calls,3);
});

test('single PDF keeps the authorized rows and size limit without changing its output type', async () => {
  const source=data();
  source.items=[source.items[0]];
  source.wipe.id='../escape/period'; source.revision='../revision';
  let html;
  const render=createExportRenderer({renderBinary:async(report)=>{html=report;return Buffer.from('%PDF-single');}});
  const result=await render(source,{format:'pdf',ranking:'kills',language:'en'});
  assert.equal(result.mime,'application/pdf'); assert.match(result.fileName,/-r0-kills\.pdf$/);
  assert.equal(/[\\/]/.test(result.fileName),false);
  assert.equal(result.meta.rowCount,1); assert.equal(result.meta.dataRevision,'version-test');
  assert.ok(html.includes('Player 1')); assert.equal(html.includes('Player 2'),false);
  const oversized=createExportRenderer({renderBinary:async()=>Buffer.alloc(8*1024*1024+1)});
  await assert.rejects(oversized(source,{format:'pdf',ranking:'kills'}),{errorCode:'EXPORT_TOO_LARGE'});
});

test('all PDF archive enforces the raw combined PDF limit before rendering later entries', async () => {
  const limit=8*1024*1024;
  let calls=0;
  const render=createExportRenderer({renderBinary:async()=>{calls++;return Buffer.alloc(Math.ceil(limit/3));}});
  await assert.rejects(render(data(),{format:'pdf',ranking:'all'}),{errorCode:'EXPORT_TOO_LARGE'});
  assert.equal(calls,3);
});

test('all PDF archive also enforces the final ZIP byte limit including directory overhead', async () => {
  const limit=8*1024*1024, size=Math.floor(limit/7), remainder=limit-size*7;
  let calls=0;
  const render=createExportRenderer({renderBinary:async()=>Buffer.alloc(size+(++calls===7?remainder:0))});
  await assert.rejects(render(data(),{format:'pdf',ranking:'all'}),{errorCode:'EXPORT_TOO_LARGE'});
  assert.equal(calls,7);
});

test('query PDF retains one structured report with the default renderer layout', async () => {
  const source=data(); source.items=[];
  source.queryResult={steamId:'76561198000000001',status:'fresh',categories:[{id:'combat',fields:[{name:'combat.kills',value:0,status:'observed'}]}]};
  const calls=[];
  const render=createExportRenderer({renderBinary:async(html,format,options)=>{calls.push({html,format,options});return Buffer.from('%PDF-query');}});
  const result=await render(source,{format:'pdf',ranking:'all',language:'en'});
  assert.equal(calls.length,1); assert.equal(calls[0].options,undefined);
  assert.equal(result.mime,'application/pdf'); assert.match(result.fileName,/-query\.pdf$/);
  assert.ok(calls[0].html.includes('<h2>Combat</h2>')); assert.ok(calls[0].html.includes('Clan Portal'));
});

test('invalid export category or format is rejected before any binary render', async () => {
  assert.throws(()=>exportDocument(data(),{ranking:'unknown'}),{errorCode:'INVALID_RANKING'});
  let calls=0;
  const render = createExportRenderer({renderBinary:async()=>{calls++;return Buffer.from('x');}});
  await assert.rejects(render(data(),{format:'unknown'}),{errorCode:'INVALID_EXPORT_FORMAT'});
  await assert.rejects(render(data(),{format:'pdf',ranking:'unknown'}),{errorCode:'INVALID_RANKING'});
  assert.equal(calls,0);
  await assert.rejects(createExportRenderer()(data(),{format:'pdf',ranking:'all'}),{errorCode:'BINARY_RENDERER_REQUIRED'});
});

test('detailed Vital fields use legacy labels and preserve unknown source paths', () => {
  assert.equal(vitalFieldLabel('combat.headshots', 'zh'), '爆头');
  assert.equal(vitalFieldLabel('combat.shots', 'zh'), '开枪次数');
  assert.equal(vitalFieldLabel('combat.wounds', 'en'), 'Times wounded');
  assert.equal(vitalFieldLabel('combat.deathsT3', 'zh'), 'T3 死亡');
  assert.equal(vitalFieldLabel('combat.heals', 'zh'), '治疗次数');
  assert.equal(vitalFieldLabel('combat.revives', 'en'), 'Revives');
  assert.equal(vitalFieldLabel('building.buildings.wall.half', 'zh'), '半墙');
  assert.equal(vitalFieldLabel('pve.killsNPC.scientistnpc_oilrig', 'zh'), '油井科学家');
  assert.equal(vitalFieldLabel('new.unknown.source.metric', 'zh'), 'new.unknown.source.metric');
});

test('production export modules import without the unshipped src directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nb-export-package-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    await cp(path.join(root, 'server'), path.join(directory, 'server'), { recursive: true });
    await cp(path.join(root, 'shared'), path.join(directory, 'shared'), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { exportDocument } from './server/v2/stats/exports.js';
      import { createManagedExportRenderer } from './server/v2/management-adapters/exports/index.js';
      import { vitalFieldLabel } from './shared/vital-field-labels.js';
      assert.equal(vitalFieldLabel('combat.shots', 'zh'), '开枪次数');
      assert.equal(createManagedExportRenderer().diagnostics().active, 0);
      assert.match(exportDocument({wipe:{id:'package',title:'Package test'},items:[]},{language:'en'}).html, /Kills leaderboard/);
      console.log('production-package-import-ok');
    `], { cwd: directory, encoding: 'utf8' });
    assert.equal(output.trim(), 'production-package-import-ok');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
