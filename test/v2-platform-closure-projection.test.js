import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/v2-platform-host/fixture.mjs';
import {upsertSqliteCollectionRecord} from '../server/storage/sqlite-migrate.js';
import {createPublishedPlatformAdapters} from '../server/v2/platform-admin/published-services.js';

async function withFixture(fn){const f=fixture();try{await f.start();await fn(f);}finally{await f.close();}}
const execute=(f,action,input,id)=>f.platformService.execute(f.actor('admin'),'discord',action,{expectedRevision:1,...input},{operationId:id});
test('platform query exposes actual success data, zero, and definitive provider failure',()=>withFixture(async f=>{
 const steamId=f.ir.get('members','m001').steamId;
 f.stats.providers.official=async()=>({steamId,rows:[{kills:0,deaths:7,syncedAt:new Date(f.now()).toISOString()}]});
 const good=await execute(f,'query',{sourceId:'official',steamId},'closure-query-good');
 assert.equal(good.status,'succeeded');assert.match(JSON.stringify(good.result.items),/0 击杀/);
 f.stats.providers.official=async()=>{throw Object.assign(Error('private upstream detail'),{errorCode:'SOURCE_UNAVAILABLE'});};
 const bad=await execute(f,'query',{sourceId:'official',steamId},'closure-query-bad');
 assert.equal(bad.status,'failed');assert.equal(bad.result.state,'failed');assert.equal(bad.result.errorCode,'SOURCE_UNAVAILABLE');assert.ok(!JSON.stringify(bad).includes('private upstream'));
 assert.equal(f.platformService.receipt(f.actor('admin'),'closure-query-bad').status,'failed');
 const published=createPublishedPlatformAdapters({identity:f.identity,stats:f.stats,executeStatsJob:id=>f.stats.runJob(id)});
 const r=await published.platform.queries.query({actor:f.actor('admin'),input:{sourceId:'official',steamId},operationId:'closure-published-failed',assertCurrent:()=>f.actor('admin')});
 assert.equal(r.state,'failed');
}));
test('ranking preserves nested metrics and zero in both adapters and card preview',()=>withFixture(async f=>{
 upsertSqliteCollectionRecord(f.db,'kdaRows','closure-row',{id:'closure-row',memberId:'m001',wipeId:'host-wipe',source:'vital',kills:0,deaths:7,rockets:13,syncedAt:new Date(f.now()).toISOString()});
 const result=await execute(f,'ranking',{wipeId:'host-wipe',sourceId:'vital'},'closure-ranking');assert.match(result.result.items[0].label,/0 击杀.*7 死亡/);
 const card=await execute(f,'card_preview',{wipeId:'host-wipe',targetId:'discord-target',cardType:'ranking',metric:'rockets',language:'zh-CN'},'closure-ranking-card');assert.match(card.result.preview.body,/13 火箭/);
 const published=createPublishedPlatformAdapters({identity:f.identity,stats:f.stats});assert.match(published.platform.stats.ranking({actor:f.actor('admin'),input:{wipeId:'host-wipe'}}).items[0].label,/0 击杀/);
}));
test('map read and preview preserve canonical snapshot links and connect value',()=>withFixture(async f=>{
 f.sr.put('wipes',{...f.sr.get('wipes','host-wipe'),serverSnapshot:{name:'Fixture',directConnect:'127.0.0.1:28015',mapLink:'https://example.invalid/map',rustMapsLink:'https://example.invalid/rustmaps'}});
 const result=await execute(f,'map',{wipeId:'host-wipe'},'closure-map');assert.match(JSON.stringify(result.result),/28015/);assert.match(JSON.stringify(result.result),/example.invalid\/map/);
 const card=await execute(f,'card_preview',{wipeId:'host-wipe',targetId:'discord-target',cardType:'map'},'closure-map-card');assert.match(card.result.preview.body,/28015/);
 const published=createPublishedPlatformAdapters({identity:f.identity,scheduling:f.scheduling});assert.match(JSON.stringify(published.platform.scheduling.map({actor:f.actor('admin'),input:{wipeId:'host-wipe'}})),/28015/);
}));
test('query and card projections retain original domain authorization',()=>withFixture(async f=>{
 const before=f.db.prepare('SELECT count(*) n FROM v2_stats_jobs').get().n;
 await assert.rejects(()=>f.platformService.execute(f.actor('viewer'),'discord','query',{expectedRevision:1,steamId:'76561198000000001'},{operationId:'closure-denied'}),e=>['CAPABILITY_DENIED','ACCESS_DENIED'].includes(e.errorCode));
 assert.equal(f.db.prepare('SELECT count(*) n FROM v2_stats_jobs').get().n,before);
 const a=f.ir.get('accounts','admin');f.ir.put('accounts',{...a,roleId:'member',adminAssignedByOwner:false});
 assert.equal(f.identity.actorForAccount('admin').roleId,'member');
 await assert.rejects(()=>execute(f,'card_preview',{wipeId:'host-wipe',targetId:'discord-target',cardType:'ranking'},'closure-card-denied'),e=>['CAPABILITY_DENIED','ACCESS_DENIED'].includes(e.errorCode));
}));
