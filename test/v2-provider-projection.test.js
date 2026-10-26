import { chromiumExecutablePath } from '../server/chromium-runtime.js';
import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { upstream,sid,other } from './support/v2-provider-projection/upstream.mjs';
import { createProviderTransport,createInventoryEnrichment,createMooseEngine } from '../server/v2/source-providers/index.js';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { projectInventoryEnrichment,projectInventoryQuery,projectMooseQuery } from '../server/v2/source-providers/projection.js';
import { projectQuery } from '../server/v2/stats/service.js';
const signal=()=>({signal:new AbortController().signal});
const inventory=()=>({steamId:sid,appId:252490,contextId:2,inventoryObservedAt:new Date().toISOString(),inventoryAvailable:true,inventoryComplete:true,skins:[{id:'1',name:'Fixture Skin',quantity:2},{id:'3',name:'Sunburn Inner Tube',quantity:1}],dlcs:[{appid:1409640,name:'Sunburn Pack'}]});
async function setup(t,options={}){
 const u=await upstream(),config={enabled:true,revision:1,prices:true,rusthelp:true,...options};
 const transport=createProviderTransport({readConfiguration:()=>config,origins:Object.fromEntries(['moose','scmm','rusthelp'].map(k=>[k,u.origin])),fetchImpl:fetch,allowLoopbackForTests:true,timeoutMs:15000});
 const reader=createInventoryEnrichment({transport,readConfiguration:()=>config});
 const host=(enrichment=reader)=>createSourceHost({readSettings:()=>({}),readWipe:()=>null,fetchImpl:fetch,capabilities:{inventory:true,inventoryEnrichment:true,dlcCatalog:true},origins:Object.fromEntries(['community','store'].map(k=>[k,u.origin])),allowLoopbackForTests:true,inventoryEnrichment:enrichment});
 const hosts=[];t.after(async()=>{for(const h of hosts)await h.stop();await transport.stop();await u.close();assert.equal(transport.active,0);assert.equal(u.stats.activeSockets,0);});
 return {u,config,transport,reader,host:e=>{const h=host(e);hosts.push(h);return h;}};
}
test('aggregate zero and missing per-item coverage survive both original projections',async t=>{
 const f=await setup(t);f.u.mode='aggregateZero';const raw=await f.host().readers.stats.inventory(sid,signal()),q=projectInventoryQuery(raw,sid),saved=projectQuery(q,'inventory',Date.now());
 assert.equal(saved.inventory.total,0);assert.equal(saved.status,'partial');assert.equal(saved.providerEvidence.valuation.kind,'aggregate');assert.equal(saved.providerEvidence.pricedItems,0);assert.ok(saved.inventory.items.filter(x=>x.category==='skins').every(x=>x.price===null));assert.equal(saved.inventory.items.find(x=>x.category==='dlc').quantity,null);assert.ok(!JSON.stringify(saved).includes('SHOULD_NOT_REACH_DTO'));
});
test('legacy trusted numeric injection remains compatible but arbitrary summary/evidence never receives observed trust',async t=>{
 const f=await setup(t);const legacy=async()=>({prices:[{id:'1',price:2.5,currency:'USD'},{id:'3',price:1,currency:'USD'}],summary:{totalValue:999},evidence:{trust:'observed'}});
 const raw=await f.host(legacy).readers.stats.inventory(sid,signal());assert.equal(raw.totalSummary.totalValue,6);const saved=projectQuery(projectInventoryQuery(raw,sid),'inventory',Date.now());assert.equal(saved.inventory.total,6);assert.deepEqual(saved.providerEvidence,{version:1,trust:'legacy_unverified'});
});
for(const [label,change] of [['Steam',x=>x.steamId=other],['app',x=>x.appId=1],['context',x=>x.contextId=1],['scope',x=>x.scopeHash='0'.repeat(64)],['revision',x=>x.revision=2],['binding',x=>x.binding='0'.repeat(64)],['source',x=>x.source='foreign'],['currency',x=>x.currency='EUR'],['count',x=>x.totalItems=2]])test('changed '+label+' summary is rejected without legacy fallback',async t=>{
 const f=await setup(t);f.u.mode='aggregate';const wrapped=async(input,o)=>{const r=await f.reader(input,o);change(r.summary);return r;};await assert.rejects(f.host(wrapped).readers.stats.inventory(sid,signal()),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});
});
test('cloned new reader result and mutated per-unit price are rejected',async t=>{
 const f=await setup(t);for(const transform of [structuredClone,r=>{r.prices[0].price=900;return r;}])await assert.rejects(f.host(async(i,o)=>transform(await f.reader(i,o))).readers.stats.inventory(sid,signal()),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});
});
test('full scope binds asset IDs, names, quantities and completeness, not only aggregate count',async t=>{
 const f=await setup(t);f.u.mode='aggregate';const i=inventory(),raw=await f.reader({steamId:sid,inventory:i},signal());
 for(const edit of [x=>x.skins[0].id='2',x=>x.skins[0].name='Other Skin',x=>{x.skins[0].quantity=1;x.skins[1].quantity=2;},x=>x.inventoryComplete=false,x=>x.inventoryAvailable=false]){const current=structuredClone(i);edit(current);assert.throws(()=>projectInventoryEnrichment(raw,{steamId:sid,inventory:current}),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});}
 const reordered=structuredClone(i);reordered.skins.reverse();assert.equal(projectInventoryEnrichment(raw,{steamId:sid,inventory:reordered}).totalSummary.totalValue,8);
 const malformed=structuredClone(i);malformed.skins[0].id=1;await assert.rejects(f.reader({steamId:sid,inventory:malformed},signal()),{errorCode:'SOURCE_INVALID_DATA'});
});
test('expired and future observations cannot persist and observation age is checked again at Stats commit',async t=>{
 const f=await setup(t,{observationMaxAgeMs:1000});f.u.mode='aggregate';const raw=await f.host().readers.stats.inventory(sid,signal()),q=projectInventoryQuery(raw,sid);
 assert.throws(()=>projectQuery(q,'inventory',Date.now()+2000),{errorCode:'SOURCE_EVIDENCE_EXPIRED'});
 const future=createInventoryEnrichment({transport:f.transport,readConfiguration:()=>f.config,now:()=>Date.now()+500});const i=inventory(),r=await future({steamId:sid,inventory:i},signal());assert.throws(()=>projectInventoryEnrichment(r,{steamId:sid,inventory:i}),{errorCode:'SOURCE_EVIDENCE_EXPIRED'});
 f.u.mode='aggregateExpired';await assert.rejects(f.host().readers.stats.inventory(sid,signal()),{errorCode:'SOURCE_EVIDENCE_EXPIRED'});
});
test('configuration and transport proxy bindings are checked after reader return and again at final persistence',async t=>{
 const f=await setup(t);f.u.mode='aggregate';const raw=await f.host().readers.stats.inventory(sid,signal()),q=projectInventoryQuery(raw,sid);f.config.revision++;assert.throws(()=>projectQuery(q,'inventory',Date.now()),{errorCode:'CREDENTIALS_CHANGED'});f.config.revision--;f.config.proxyUrl='http://127.0.0.1:9';assert.throws(()=>projectInventoryQuery(raw,sid),{errorCode:'CREDENTIALS_CHANGED'});
});
test('cloning or tampering projected host/query objects cannot turn persisted evidence into a trusted observation',async t=>{
 const f=await setup(t);const raw=await f.host().readers.stats.inventory(sid,signal());assert.throws(()=>projectInventoryQuery(structuredClone(raw),sid),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});const q=projectInventoryQuery(raw,sid);assert.throws(()=>projectQuery(structuredClone(q),'inventory',Date.now()),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});q.providerEvidence.valuation.kind='aggregate';assert.throws(()=>projectQuery(q,'inventory',Date.now()),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});
});
test('Moose exact Steam/server/period/category context, TTL and current revision survive its closed persistence seam',async t=>{
 const f=await setup(t),engine=createMooseEngine({transport:f.transport,executablePath:chromiumExecutablePath()}),input={kind:'player',steamId:sid,serverId:'eu-main',period:'September 2026',categoryIds:['pvp','resources']};
 const raw=await engine(input,{...signal(),origin:f.u.origin}),context={steamId:sid,serverId:'eu-main',providerWipeId:input.period,categoryIds:input.categoryIds};
 for(const patch of [{steamId:other},{serverId:'eu-medium'},{providerWipeId:'All Time'},{categoryIds:['pvp']}])assert.throws(()=>projectMooseQuery(raw,{...context,...patch}),e=>['SOURCE_IDENTITY_MISMATCH','SOURCE_EVIDENCE_UNVERIFIED'].includes(e.errorCode));
 assert.throws(()=>projectMooseQuery(structuredClone(raw),context),{errorCode:'SOURCE_EVIDENCE_UNVERIFIED'});const q=projectMooseQuery(raw,context),saved=projectQuery(q,'moose',Date.now());assert.equal(saved.fields[0].value,'12');assert.equal(saved.providerEvidence.periodName,input.period);assert.equal(saved.providerEvidence.quality,'complete');
 assert.throws(()=>projectQuery(q,'moose',Date.now()+300001),{errorCode:'SOURCE_EVIDENCE_EXPIRED'});f.config.revision++;assert.throws(()=>projectQuery(q,'moose',Date.now()),{errorCode:'CREDENTIALS_CHANGED'});
});
test('partial item quotes coexist with independent aggregate, without apportioning the missing item',async t=>{
 const f=await setup(t);f.u.mode='partial';const raw=await f.host().readers.stats.inventory(sid,signal()),saved=projectQuery(projectInventoryQuery(raw,sid),'inventory',Date.now());assert.equal(saved.inventory.total,8);assert.equal(saved.providerEvidence.valuation.kind,'aggregate');assert.equal(saved.providerEvidence.pricedItems,1);assert.equal(saved.inventory.items.find(i=>i.id==='1').price,null);assert.equal(saved.inventory.items.find(i=>i.id==='3').price,1);assert.equal(saved.status,'partial');
});
test('explicit license false stays zero ownership; stale license cannot acquire a current timestamp at persistence',async t=>{
 const f=await setup(t,{prices:false,entitlements:true,entitlementMaxAgeMs:1000});
 const reader=createInventoryEnrichment({transport:f.transport,readConfiguration:()=>f.config,readEntitlements:()=>({steamId:sid,revision:1,authority:'steam-license',observedAt:new Date().toISOString(),appids:[1409640],entitlements:[{appid:1409640,owned:false,evidenceId:'fixture-license:zero'}]})});
 const raw=await f.host(reader).readers.stats.inventory(sid,signal()),q=projectInventoryQuery(raw,sid),saved=projectQuery(q,'inventory',Date.now());const dlc=saved.inventory.items.find(i=>i.category==='dlc');assert.equal(dlc.quantity,0);assert.equal(dlc.ownershipEvidence.sourceId,'steam-license');assert.throws(()=>projectQuery(q,'inventory',Date.now()+2000),{errorCode:'SOURCE_EVIDENCE_EXPIRED'});
});
test('2000 real inventory assets plus DLC are explicitly partial when the existing Stats cap truncates a row',async t=>{
 const f=await setup(t);f.u.mode='maxInventory';const raw=await f.host().readers.stats.inventory(sid,signal());assert.equal(raw.skins.length,2000);const saved=projectQuery(projectInventoryQuery(raw,sid),'inventory',Date.now());assert.equal(saved.inventory.total,2000);assert.equal(saved.inventory.items.length,2000);assert.equal(saved.inventory.truncated,true);assert.equal(saved.providerEvidence.truncatedItems,true);assert.equal(saved.providerEvidence.status,'partial');assert.equal(saved.inventory.status,'partial');assert.equal(saved.status,'partial');
});
