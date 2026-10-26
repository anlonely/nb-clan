import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderBindings,createProviderTransport,createInventoryEnrichment } from '../server/v2/source-providers/index.js';
import { createManagementSourceAdapters } from '../server/v2/management-adapters/sources/index.js';
import { SyncCenterService } from '../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';
import { fixture } from './support/v2-source-adapters/fixture.mjs';
import { upstream,sid } from './support/v2-source-providers/fixture.mjs';
import { rootSeam } from './support/v2-source-providers/root-seam.mjs';
test('stable provider bindings cover proxy, valuation, entitlement revision and disabled state without secrets',()=>{
 let c={enabled:true,revision:1,proxyUrl:'http://constructed-user:constructed-password@127.0.0.1:9',prices:true,ledgerVersion:1};
 const read=createProviderBindings({readConfiguration:()=>c}),first=read();assert.ok(!JSON.stringify(first).includes('constructed-'));
 c=Object.fromEntries(Object.entries(c).reverse());assert.deepEqual(read(),first);
 for(const change of [{proxyUrl:'http://127.0.0.1:10'},{prices:false},{ledgerVersion:2},{enabled:false}]){const before=c;c={...c,...change};assert.notDeepEqual(read(),first);c=before;}
 const invalid=createProviderBindings({readConfiguration:async()=>c});assert.throws(invalid,{errorCode:'SOURCE_CONFIG_SYNC_REQUIRED'});
});
test('installed readProviderBindings seam prevents provider rotation between return and commit',async t=>{
 const b=await fixture();await b.worker.stop();const u=await upstream(),seam=await rootSeam();let worker,host;
 const config={enabled:true,revision:1,prices:true},transport=createProviderTransport({readConfiguration:()=>config,fetchImpl:fetch,origins:{scmm:u.origin,rusthelp:u.origin},allowLoopbackForTests:true});
 t.after(async()=>{await worker?.stop();await host?.stop();await transport.stop();await u.close();await b.close();await seam.close();});
 const enrich=createInventoryEnrichment({transport,readConfiguration:()=>config}),readBindings=createProviderBindings({readConfiguration:()=>config});
 let returned=false,enter,release;const entered=new Promise(r=>enter=r),released=new Promise(r=>release=r);
 host=seam.createSourceHost({readSettings:()=>({steamWebApi:{apiKey:'constructed-key'},accountRisk:{rules:[{type:'inventory_value',enabled:true,threshold:10},{type:'account_restricted',enabled:false},{type:'steam_ban_or_restriction',enabled:false}]}}),readWipe:()=>null,fetchImpl:fetch,
  readProviderBindings:readBindings,sharedBattlemetricsQueue:b.queue,capabilities:{inventory:true,inventoryEnrichment:true,steam:true,memberRisk:true},origins:{steam:u.origin,community:u.origin},allowLoopbackForTests:true,
  inventoryEnrichment:async(...args)=>{const result=await enrich(...args);assert.equal(result.prices[0].price,2.5);returned=true;return result;}});
 const sources=createManagementSourceAdapters({...b.options,...host,runWrite:async fn=>{if(returned){enter();await released;}return b.options.runWrite(fn);}});
 const service=new SyncCenterService({db:b.db,identity:b.identity,authority:sources.authority});worker=createSyncCenterWorker(service,{providers:sources.providers});
 const prior=b.db.prepare("SELECT count(*) n FROM json_records WHERE collection='memberProfiles'").get().n;
 const {job}=await service.request(b.actor(),{type:'member_profile',scope:{kind:'members',memberIds:['g05_alpha']}},{operationId:randomUUID()}),work=worker.step();
 let timer;try{await Promise.race([entered,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('did not enter commit gate')),10000))]);}finally{clearTimeout(timer);}
 config.revision++;release();await work;const detail=service.detail(b.actor(),job.id);assert.equal(detail.status,'retry_wait');
 assert.equal(b.db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n,0);assert.equal(b.db.prepare("SELECT count(*) n FROM json_records WHERE collection='memberProfiles'").get().n,prior);
 assert.equal(b.repo.get('members','g05_alpha').steamId,sid);assert.equal(transport.active,0);
});
test('explicit proxy WebSocket factory uses a real isolated CONNECT proxy and drains it',async t=>{
 const {createServer}=await import('node:http'),{connect}=await import('node:net');
 const {openProxyWebSocket}=await import('../server/v2/source-providers/index.js');
 const u=await upstream(),proxy=createServer(),peers=new Set();let connects=0,transport;
 proxy.on('connect',(req,socket,head)=>{
  assert.equal(req.url,new URL(u.origin).host);connects++;peers.add(socket);socket.on('close',()=>peers.delete(socket));
  const target=connect({host:'127.0.0.1',port:Number(new URL(u.origin).port)},()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)target.write(head);socket.pipe(target);target.pipe(socket);});
  peers.add(target);target.on('close',()=>peers.delete(target));socket.on('error',()=>target.destroy());target.on('error',()=>socket.destroy());
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(async()=>{await transport?.stop();for(const p of peers)p.destroy();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await u.close();});
 transport=createProviderTransport({readConfiguration:()=>({enabled:true,revision:1,proxyUrl:`http://127.0.0.1:${proxy.address().port}`}),fetchImpl:fetch,proxyWebSocket:openProxyWebSocket,origins:{moose:u.origin},allowLoopbackForTests:true});
 const s=transport.open('moose');let resolve,reject;const message=new Promise((a,b)=>{resolve=a;reject=b;});
 const socket=s.socket(u.origin.replace('http','ws')+'/_blazor?id=proxy-fixture',[],event=>{if(event.type==='open')socket.send(Buffer.from([0,255,128,42]).toString('base64'),true);if(event.type==='message')resolve(event);});
 const timer=setTimeout(()=>reject(new Error('proxy socket timeout')),5000);let event;try{event=await message;}finally{clearTimeout(timer);}
 assert.equal(connects,1);assert.equal(event.binary,true);assert.equal(Buffer.from(event.data,'base64').toString('hex'),'00ff802a');await s.close();assert.equal(transport.active,0);
 const until=Date.now()+2000;while(u.stats.activeSockets){assert.ok(Date.now()<until,'proxy did not close upstream');await new Promise(r=>setTimeout(r,5));}assert.equal(u.stats.activeSockets,0);
});
