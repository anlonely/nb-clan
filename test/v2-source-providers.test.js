import { chromiumExecutablePath } from '../server/chromium-runtime.js';
import './support/results.mjs';
import './support/v2-source-main/offline.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { upstream,sid,other } from './support/v2-source-providers/fixture.mjs';
import { createProviderTransport,createInventoryEnrichment,createMooseEngine } from '../server/v2/source-providers/index.js';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { createManagementSourceAdapters } from '../server/v2/management-adapters/sources/index.js';
import { fixture } from './support/v2-source-adapters/fixture.mjs';
import { SyncCenterService } from '../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';
import { randomUUID } from 'node:crypto';
import { StatsService } from '../server/v2/stats/service.js';
import { mkdir,writeFile,chmod } from 'node:fs/promises';
const evidence={boundary:'Constructed loopback upstream and isolated Chromium; real SourceHost, Stats query jobs and SyncCenter collector/SQLite. No external platform verification.',checks:[]};
after(async()=>{const directory=new URL('../output/test-results/g07-source-providers/',import.meta.url);await mkdir(directory,{recursive:true});const output=new URL('runtime-evidence.json',directory);await writeFile(output,JSON.stringify(evidence,null,2)+'\n');await chmod(output,0o644);});
const executablePath=chromiumExecutablePath();
const inventory={inventoryAvailable:true,skins:[{id:'1',name:'Fixture Skin',quantity:2},{id:'3',name:'Sunburn Inner Tube',quantity:1}],dlcs:[{appid:1409640,name:'Sunburn Pack'}]};
async function setup(t,changes={}){
 const u=await upstream(),configuration={enabled:true,revision:1,prices:true,rusthelp:true};
 const origins=Object.fromEntries(['moose','scmm','rusthelp'].map(k=>[k,u.origin]));
 const transport=createProviderTransport({readConfiguration:()=>configuration,fetchImpl:fetch,origins,allowLoopbackForTests:true,timeoutMs:15000,...changes});
 const enrichment=createInventoryEnrichment({transport,readConfiguration:()=>configuration});
 const engine=createMooseEngine({transport,executablePath});
 t.after(async()=>{await transport.stop();await u.close();assert.equal(transport.active,0);assert.equal(u.stats.activeSockets,0);});
 return {u,configuration,transport,enrichment,engine};
}
const opts=()=>({signal:new AbortController().signal});
const player={kind:'player',steamId:sid,serverId:'eu-main',period:'September 2026',categoryIds:['pvp','resources']};
test('controlled Chromium reads legacy DOM through real SignalR HTTP/WebSocket and closes every socket',async t=>{
 const f=await setup(t),result=await f.engine(player,{...opts(),origin:f.u.origin});
 assert.equal(result.identity.steamId,sid);assert.equal(result.categories.length,2);assert.equal(result.categories[0].selectedMatch.values.kills,'12');assert.equal(result.categories[1].selectedMatch.values.wood,'120');
 assert.equal(result.period.name,'September 2026');assert.equal(result.evidence.cached,false);assert.equal(result.evidence.steamId,sid);
 assert.equal(f.u.stats.wsConnections,1);assert.equal(f.u.stats.binaryFrames,1);assert.ok(f.u.stats.textFrames>=4);assert.equal(f.transport.active,0);assert.equal(f.u.stats.activeSockets,0);
 assert.ok(f.u.calls.some(c=>c.path==='/_blazor/negotiate'&&c.method==='POST'));
 assert.ok(f.u.calls.some(c=>c.path==='/_blazor'&&c.method==='POST'&&c.bodyHex==='00ff802a'));
 evidence.moose={identity:result.identity,categories:result.categories,period:result.period,evidence:result.evidence,protocol:{...f.u.stats,binaryHttp:'00ff802a request and response identical'}};
});
test('SCMM cents, actual quantities and explicit currencies; DLC inventory tokens do not prove ownership',async t=>{
 const f=await setup(t),result=await f.enrichment({steamId:sid,inventory},opts());
 assert.deepEqual(result.prices.map(x=>[x.id,x.price,x.currency]),[['1',2.5,'USD'],['3',1,'USD']]);assert.equal(result.summary.totalValue,6);assert.equal(result.entitlements.length,0);
 assert.equal(result.evidence.sources.entitlements.status,'not_configured');assert.ok(f.u.calls.filter(c=>c.path.startsWith('/api/inventory')&&!c.path.endsWith('/summary')).every(c=>c.query.currency==='USD'&&!c.headers.authorization&&!c.headers.cookie));
 assert.equal(result.prices[0].evidence.steamId,sid);assert.ok(Date.parse(result.prices[0].evidence.observedAt));
});
test('partial quotes keep missing unknown; rusthelp stays aggregate and sends only fixed USD header',async t=>{
 const f=await setup(t);f.u.mode='partial';const r=await f.enrichment({steamId:sid,inventory},opts());
 assert.equal(r.prices.length,1);assert.equal(r.summary.totalValue,8);assert.equal(r.summary.source,'rusthelp-summary');assert.equal(f.u.calls.find(c=>c.path.startsWith('/v1/')).headers.currencyCode,'USD');
 f.u.mode='currency';const unknown=await f.enrichment({steamId:sid,inventory},opts());assert.equal(unknown.prices.length,0);
 f.u.mode='zero';const zero=await f.enrichment({steamId:sid,inventory},opts());assert.equal(zero.prices[0].price,0);
});
test('SourceHost → new readers → actual Stats providers and risk reader consume real upstream formats',async t=>{
 const f=await setup(t),base=await fixture();await base.worker.stop();
 const host=createSourceHost({readSettings:()=>({steamWebApi:{apiKey:'constructed-provider-test-key'},accountRisk:{rules:[{type:'inventory_value',enabled:true,threshold:10},{type:'account_restricted',enabled:false},{type:'steam_ban_or_restriction',enabled:false}]}}),readWipe:()=>null,readCredentials:()=>({}),fetchImpl:fetch,sharedBattlemetricsQueue:base.queue,
  capabilities:{moose:true,inventory:true,inventoryEnrichment:true,dlcCatalog:true,steam:true,memberRisk:true},origins:Object.fromEntries(['moose','steam','community','store'].map(k=>[k,f.u.origin])),allowLoopbackForTests:true,
  mooseEngine:f.engine,inventoryEnrichment:f.enrichment});
 let worker;
 t.after(async()=>{await worker?.stop();await host.stop();await base.close();});
 const adapters=createManagementSourceAdapters({...base.options,...host});
 const result=await adapters.statsProviders.moose({steamInput:sid,serverId:'eu-main',providerWipeId:'September 2026',categoryIds:['pvp']},opts());assert.equal(result.fields[0].value,'12');
 const inv=await adapters.statsProviders.inventory({steamInput:sid},opts());assert.equal(inv.inventory.total,6);assert.equal(inv.inventory.items.find(i=>i.category==='dlc').quantity,null);
 const raw=await host.readers.stats.inventory(sid,{...opts(),riskRead:true,inventoryOnly:true});assert.equal(raw.totalSummary.totalValue,6);assert.equal(raw.totalSummary.currency,'USD');
 const stats=new StatsService(base.identity,{providers:adapters.statsProviders});
 for(const sourceId of ['inventory','moose']){
  const queued=stats.createJob(base.actor(),'query',{sourceId,steamInput:sid,...(sourceId==='moose'?{serverId:'eu-main',providerWipeId:'September 2026',categoryIds:['pvp']}:{})},randomUUID());
  await stats.runJob(queued.jobId);const queried=stats.readJob(base.actor(),queued.jobId);assert.equal(queried.status,'succeeded');
  if(sourceId==='inventory')assert.equal(queried.result.inventory.total,6);else assert.equal(queried.result.fields[0].value,'12');
  evidence.checks.push({kind:'persisted-stats-query',sourceId,status:queried.status,result:queried.result});
 }
 const service=new SyncCenterService({db:base.db,identity:base.identity,authority:adapters.authority});worker=createSyncCenterWorker(service,{providers:adapters.providers});
 const {job}=await service.request(base.actor(),{type:'member_profile',scope:{kind:'members',memberIds:['g05_alpha']}},{operationId:randomUUID()});await worker.step();assert.equal(service.detail(base.actor(),job.id).status,'succeeded');
 const saved=adapters.store.profile(base.repo.get('members','g05_alpha'));assert.equal(saved.inventoryValue,6);assert.equal(saved.inventoryCurrency,'USD');assert.equal(saved.riskScan.sources.inventory.status,'observed');
 evidence.checks.push({kind:'single-worker-risk-collector',inventoryValue:saved.inventoryValue,currency:saved.inventoryCurrency,scan:saved.riskScan.sources.inventory});
 const before=JSON.stringify(saved),receipts=base.db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n,seen=f.u.calls.length;
 f.u.mode='hold';const race=await service.request(base.actor(),{type:'member_profile',scope:{kind:'members',memberIds:['g05_alpha']}},{operationId:randomUUID()}),running=worker.step();
 const deadline=Date.now()+10000;while(!f.u.calls.slice(seen).some(c=>c.path===`/api/inventory/${sid}`)){assert.ok(Date.now()<deadline,'race collector did not read prices');await new Promise(r=>setTimeout(r,10));}
 const member=base.repo.get('members','g05_alpha');base.repo.put('members',{...member,steamId:other});f.u.release();await running;
 const raced=service.detail(base.actor(),race.job.id);assert.equal(raced.status,'retry_wait',JSON.stringify(raced));assert.equal(raced.items[0].reason,'SOURCE_UNAVAILABLE');assert.equal(base.db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n,receipts);assert.equal(JSON.stringify(adapters.store.profile(member)),before);
 const priorCalls=f.u.calls.length;await new Promise(r=>setTimeout(r,Math.max(0,Date.parse(raced.retryAt)-Date.now())+20));await worker.step();assert.equal(service.detail(base.actor(),race.job.id).status,'failed');assert.equal(f.u.calls.length,priorCalls);
 evidence.checks.push({kind:'canonical-Steam-identity-drift',status:'retry_wait then failed before next I/O; no stale profile write',receiptsUnchanged:true});
});
const entered=async(f,path)=>{const end=Date.now()+10000;while(!f.u.calls.some(c=>c.path===path)){assert.ok(Date.now()<end,'request did not enter');await new Promise(r=>setTimeout(r,10));}};
for(const [mode,code] of [['rate','RATE_LIMITED'],['redirect','SOURCE_REDIRECT_REJECTED'],['big','SOURCE_RESPONSE_TOO_LARGE']]){
 test(`browser ${mode} rejects, never follows redirects, and drains`,async t=>{const f=await setup(t);f.u.mode=mode;await assert.rejects(f.engine(player,{...opts(),origin:f.u.origin}),{errorCode:code});assert.equal(f.transport.active,0);assert.equal(f.u.stats.activeSockets,0);assert.equal(f.u.calls.length,1);});
}
test('browser explicit cancel and host stop close an in-flight page before returning',async t=>{
 const f=await setup(t);f.u.mode='hold';const c=new AbortController();const pending=f.engine(player,{signal:c.signal,origin:f.u.origin});const done=assert.rejects(pending,{errorCode:'SOURCE_TIMEOUT'});await entered(f,'/stats');c.abort();await done;assert.equal(f.transport.active,0);
 const host=createSourceHost({readSettings:()=>({}),readWipe:()=>null,fetchImpl:fetch,capabilities:{moose:true},mooseEngine:f.engine,origins:{moose:f.u.origin},allowLoopbackForTests:true});
 const second=host.readers.stats.moose(player,opts()), rejected=assert.rejects(second,{errorCode:'SOURCE_TIMEOUT'});const count=f.u.calls.length;while(f.u.calls.length===count)await new Promise(r=>setTimeout(r,10));await host.stop();await rejected;assert.equal(host.activeIO,0);assert.equal(f.transport.active,0);
});
test('browser configured owner stop, deadline, and configuration revision drift reject stale work',async t=>{
 const f=await setup(t);f.u.mode='hold';const p=f.engine(player,{...opts(),origin:f.u.origin}),check=assert.rejects(p,{errorCode:'SOURCE_TIMEOUT'});await entered(f,'/stats');await f.transport.stop();await check;assert.equal(f.transport.active,0);
 const g=await setup(t,{timeoutMs:100});g.u.mode='hold';await assert.rejects(g.engine(player,{...opts(),origin:g.u.origin}),{errorCode:'SOURCE_TIMEOUT'});
 const h=await setup(t);h.u.mode='hold';const pending=h.engine(player,{...opts(),origin:h.u.origin}),done=assert.rejects(pending,{errorCode:'CREDENTIALS_CHANGED'});await entered(h,'/stats');h.configuration.revision++;h.u.release();await done;
});
test('Moose exact identity, current input and trusted origin must match',async t=>{
 const f=await setup(t);f.u.mode='wrongPlayer';await assert.rejects(f.engine({...player,categoryIds:['pvp']},{...opts(),origin:f.u.origin}),{errorCode:'SOURCE_NO_MATCH'});
 await assert.rejects(f.engine(player,{...opts(),origin:'https://attacker.invalid'}),{errorCode:'SOURCE_URL_REJECTED'});
 f.configuration.enabled=false;const before=f.u.calls.length;await assert.rejects(f.engine(player,{...opts(),origin:f.u.origin}),{errorCode:'SOURCE_NOT_CONFIGURED'});assert.equal(f.u.calls.length,before);
});
test('browser foreign fetch is rejected before a second origin request',async t=>{
 const f=await setup(t);f.u.mode='foreign';await assert.rejects(f.engine(player,{...opts(),origin:f.u.origin}),{errorCode:'SOURCE_URL_REJECTED'});assert.ok(f.u.calls.every(c=>!c.path.includes('forbidden')));
});
test('Moose periods use actual dropdown values and retain explicit scope/time/revision',async t=>{
 const f=await setup(t),r=await f.engine({kind:'periods',serverId:'eu-medium'},{...opts(),origin:f.u.origin});assert.deepEqual(r.periods.map(p=>p.name),['All Time','September 2026']);assert.equal(r.server.id,'eu-medium');assert.equal(r.evidence.revision,1);assert.ok(Date.parse(r.evidence.observedAt));
});
test('inventory cancels, honors 429 and rejects redirects without a fallback request',async t=>{
 const f=await setup(t);for(const [mode,code] of [['rate','RATE_LIMITED'],['redirect','SOURCE_REDIRECT_REJECTED']]){f.u.mode=mode;const before=f.u.calls.length;await assert.rejects(f.enrichment({steamId:sid,inventory},opts()),e=>e.errorCode===code&&(code!=='RATE_LIMITED'||e.retryAfterMs===2000));assert.equal(f.u.calls.length,before+1);}
 f.u.mode='hold';const c=new AbortController(),p=f.enrichment({steamId:sid,inventory},{signal:c.signal}),done=assert.rejects(p,{errorCode:'SOURCE_TIMEOUT'});const before=f.u.calls.length;while(f.u.calls.length===before)await new Promise(r=>setTimeout(r,10));c.abort();await done;assert.equal(f.transport.active,0);
});
test('inventory config and Steam input drift cannot publish current-looking stale prices',async t=>{
 const f=await setup(t);f.u.mode='hold';const input={steamId:sid,inventory:structuredClone(inventory)},p=f.enrichment(input,opts()),done=assert.rejects(p,{errorCode:'CREDENTIALS_CHANGED'});await entered(f,`/api/inventory/${sid}`);f.configuration.revision++;f.u.release();await done;
 const g=await setup(t);g.u.mode='hold';const mutable={steamId:sid,inventory:structuredClone(inventory)},pending=g.enrichment(mutable,opts()),rejected=assert.rejects(pending,{errorCode:'CREDENTIALS_CHANGED'});await entered(g,`/api/inventory/${sid}`);mutable.steamId=other;g.u.release();await rejected;
});
test('DLC entitlements require exact identity, app scope, authority, revision, time and evidence; no product inference',async t=>{
 const f=await setup(t);f.configuration.entitlements=true;f.configuration.prices=false;
 let ledger={steamId:sid,revision:1,authority:'steam-license',observedAt:new Date().toISOString(),appids:[1409640],entitlements:[{appid:1409640,owned:true,evidenceId:'fixture-license:1'}]};
 const reader=createInventoryEnrichment({transport:f.transport,readConfiguration:()=>f.configuration,readEntitlements:()=>ledger});
 const good=await reader({steamId:sid,inventory},opts());assert.equal(good.entitlements[0].owned,true);assert.equal(good.entitlements[0].evidence.authority,'steam-license');assert.equal(f.u.calls.length,0);
 for(const patch of [{steamId:other},{revision:2},{authority:'inventory-keywords'},{observedAt:new Date(Date.now()-86400000).toISOString()},{appids:[42]},{entitlements:[{appid:1409640,owned:true}]}]){
  const original=ledger;ledger={...ledger,...patch};assert.equal((await reader({steamId:sid,inventory},opts())).entitlements.length,0);ledger=original;
 }
 ledger={...ledger,entitlements:[{appid:1409640,owned:false,evidenceId:'fixture-license:2'}]};assert.equal((await reader({steamId:sid,inventory},opts())).entitlements[0].owned,false);
});
test('transport gates methods/paths, does not forward arbitrary headers, and fails closed when proxy owner is absent',async t=>{
 const f=await setup(t),s=f.transport.open('scmm',opts());t.after(()=>s.close());
 for(const path of ['https://attacker.invalid/api/profile/'+sid+'/inventory/items','//attacker.invalid/x','/api/inventory/'+sid+'/../value','/api/inventory/'+sid+'/%76alue'])await assert.rejects(s.json(path),{errorCode:'SOURCE_URL_REJECTED'});
 await assert.rejects(s.json(`/api/inventory/${sid}`,{method:'POST'}),{errorCode:'SOURCE_METHOD_REJECTED'});
 await s.json(`/api/inventory/${sid}`,{query:{currency:'CNY'},headers:{Currency:'CNY',authorization:'must-not-leak',cookie:'must-not-leak'}});assert.equal(f.u.calls.at(-1).query.currency,'USD');assert.equal(f.u.calls.at(-1).headers.authorization,undefined);assert.equal(f.u.calls.at(-1).headers.cookie,undefined);
 await s.close();f.configuration.proxyUrl='http://constructed-proxy-user:constructed-proxy-password@127.0.0.1:9';const p=f.transport.open('scmm',opts());t.after(()=>p.close());await assert.rejects(p.json(`/api/inventory/${sid}`),e=>e.errorCode==='PROXY_UNAVAILABLE'&&!String(e).includes('constructed-proxy'));
});
test('transport proxy routing and credential/config fences use the owner callback on every request',async t=>{
 let proxyCalls=0,received;const f=await setup(t,{proxyFetch:async(url,options)=>{proxyCalls++;received=options.proxyUrl;return fetch(url,options);}});f.configuration.proxyUrl='http://127.0.0.1:9';
 const s=f.transport.open('scmm',opts());t.after(()=>s.close());await s.json(`/api/inventory/${sid}`);assert.equal(proxyCalls,1);assert.equal(received,'http://127.0.0.1:9');
 f.configuration.proxyUrl='http://127.0.0.1:10';await assert.rejects(s.json(`/api/inventory/${sid}`),{errorCode:'CREDENTIALS_CHANGED'});assert.equal(proxyCalls,1);
});
for(const [mode,code] of [['wsRate','RATE_LIMITED'],['wsRedirect','SOURCE_REDIRECT_REJECTED'],['bigWS','SOURCE_RESPONSE_TOO_LARGE']])test(`SignalR ${mode} closes browser and upstream without accepting a result`,async t=>{
 const f=await setup(t);f.u.mode=mode;await assert.rejects(f.engine(player,{...opts(),origin:f.u.origin}),{errorCode:code});assert.equal(f.transport.active,0);assert.equal(f.u.stats.activeSockets,0);
});
test('cancellation during a live SignalR query drains the existing WebSocket',async t=>{
 const f=await setup(t);f.u.mode='holdWS';const c=new AbortController(),p=f.engine(player,{signal:c.signal,origin:f.u.origin}),done=assert.rejects(p,{errorCode:'SOURCE_TIMEOUT'});
 const end=Date.now()+10000;while(f.u.stats.textFrames<2){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}assert.equal(f.u.stats.activeSockets,1);c.abort();await done;assert.equal(f.u.stats.activeSockets,0);assert.equal(f.transport.active,0);
});
test('legacy name-search fallback still requires an exact Steam profile link',async t=>{
 const f=await setup(t);f.u.mode='nameOnly';const r=await f.engine({...player,categoryIds:['pvp'],playerName:'Fixture Player'},{...opts(),origin:f.u.origin});assert.equal(r.identity.steamId,sid);assert.equal(r.matchedCategories,1);
});
test('configured proxy must also own WebSocket; no direct fallback when its factory is missing',async t=>{
 const f=await setup(t,{proxyFetch:(url,options)=>fetch(url,options)});f.configuration.proxyUrl='http://127.0.0.1:9';await assert.rejects(f.engine(player,{...opts(),origin:f.u.origin}),{errorCode:'PROXY_UNAVAILABLE'});assert.equal(f.u.stats.wsConnections,0);
});
test('unknown, conflicting currency, wrong profile scope and duplicate quotes never turn into zero or ownership',async()=>{
 const cfg={enabled:true,revision:1,prices:true,rusthelp:false};let payload={items:[{name:'Fixture Skin',marketPrice:0,quantity:2}],currency:'USD',currencyCode:'CNY'};
 const read=createInventoryEnrichment({readConfiguration:()=>cfg});const options={...opts(),request:async(_source,path)=>path.endsWith('/summary')?{steamId:sid,lastUpdatedInventoryOn:new Date().toISOString()}:path===`/api/inventory/${sid}`?{...payload,page:1,pageSize:500,total:payload.items.length,hasMore:false}:{}};
 assert.equal((await read({steamId:sid,inventory},options)).prices.length,0);
 payload={steamId:other,currency:'USD',items:[{name:'Fixture Skin',marketPrice:0,quantity:2}]};assert.equal((await read({steamId:sid,inventory},options)).prices.length,0);
 payload={currency:'USD',items:[{name:'Fixture Skin',marketPrice:0,quantity:1},{name:'Fixture Skin',marketPrice:10,quantity:1}]};assert.equal((await read({steamId:sid,inventory},options)).prices.length,0);
 await assert.rejects(read({steamId:sid,inventory:{...inventory,steamId:other}},options),{errorCode:'SOURCE_INVALID_DATA'});
 cfg.enabled=false;await assert.rejects(read({steamId:sid,inventory},options),{errorCode:'SOURCE_NOT_CONFIGURED'});
});
test('concurrent owner stops await a browser launched during cancellation',async t=>{
 const f=await setup(t);const p=f.engine(player,{...opts(),origin:f.u.origin}),done=assert.rejects(p,{errorCode:'SOURCE_TIMEOUT'});
 await Promise.all([f.transport.stop(),f.transport.stop()]);assert.equal(f.transport.active,0);await done;assert.equal(f.u.stats.activeSockets,0);
});
