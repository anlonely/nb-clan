import './support/v2-baseline/loopback-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import express from 'express';
import {pngFixture} from './support/v2-system-admin/image-fixture.mjs';
import {fixture} from './support/v2-system-admin/fixtures.mjs';
import {createIdentityRouter} from '../server/v2/identity/routes.js';
import {createSystemAdminRouter,systemIdentityWriteCompatibilityGuard,createPublicQueryTokenGuard} from '../server/v2/system-admin/routes.js';
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g07-system-http-')),f=await fixture(dir),app=express(),server=createServer(app);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const ir=createIdentityRouter({service:f.identity,contexts:f.contexts,origin,providers:{}});
 app.use('/api/v2',systemIdentityWriteCompatibilityGuard);
 app.use('/api/v2',(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:options=>ir.authenticate(options)(req)};ir(req,res,next);});
 app.use('/api/v2',createSystemAdminRouter({service:f.service}));
 app.post('/api/integrations/public-query',express.json(),createPublicQueryTokenGuard(f.service),(req,res)=>res.json({data:{accepted:true}}));
 app.use((e,req,res,next)=>res.status(e.status||503).json({error:{errorCode:e.errorCode||'UNAVAILABLE'}}));
 t.after(async()=>{await f.owner.stop();await ir.stopEvents();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();fs.rmSync(dir,{recursive:true,force:true});});
 const policy={id:'http-discord-policy',provider:'discord',enabled:true,guildId:'http-guild',allowedRoleIds:['http-member'],matchMode:'any',policyRevision:1};
 f.repo.put('policies',policy);
 let memberSequence=0;
 const session=id=>{
  let account=f.repo.get('accounts',id);
  if(!account.memberId){
   const memberId=`http-member-${id}`,steamId=String(76561198000000000n+BigInt(++memberSequence));
   f.repo.put('members',{id:memberId,steamId,membershipStatus:'active',revision:1});
   f.repo.put('bindings',{id:`http-binding-${id}`,accountId:id,memberId,steamId,status:'verified',revision:1});
   account={...account,memberId};f.repo.put('accounts',account);
  }
  const externalId=`http-discord-${id}`;
  f.repo.put('identities',{id:externalId,provider:'discord',externalId,accountId:id});
  const evidence={id:`http-eligibility-${id}`,provider:'discord',externalId,guildId:policy.guildId,
   status:'eligible',policyRevision:1,checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
  f.repo.put('eligibility',evidence);
  return f.identity.issueSession(account,evidence);
 };
 async function request(s,url,{input,target='',action,key=randomUUID(),originHeader=origin,csrf=true,raw}={}){
  const r=await fetch(origin+'/api/v2/system-admin/'+(action?'commands/'+action:url),{method:action?'POST':'GET',headers:{...(s?{cookie:`nb_v2_session=${s.token}`} : {}),
   ...(action?{'Content-Type':'application/json','Idempotency-Key':key,Origin:originHeader,...(csrf?{'X-CSRF-Token':s.csrfToken}:{})}: {})},
   ...(action?{body:raw??JSON.stringify({target,input})}:{})});
  const body=await r.json();return{status:r.status,headers:r.headers,body};
 }
 return{f,session,request,origin};
}
test('G03 HTTP session/CSRF and exact origin protect every system mutation',async t=>{
 const {session,request}=await setup(t),s=session('root');
 assert.equal((await request(null,'brand')).status,401);
 assert.equal((await request(s,'',{action:'brand.reset',input:{expectedRevision:0},csrf:false})).status,403);
 assert.equal((await request(s,'',{action:'brand.reset',input:{expectedRevision:0},originHeader:'http://localhost.evil'})).status,403);
 const ok=await request(s,'',{action:'brand.reset',input:{expectedRevision:0}});assert.equal(ok.status,200);assert.equal(ok.body.data.current.revision,1);assert.equal(ok.headers.get('cache-control'),'no-store');
});
test('HTTP proxy toggle requires CSRF and preserves its versioned idempotency receipt',async t=>{
 const {session,request}=await setup(t),s=session('root'),input={expectedRevision:0,enabled:false},key=randomUUID();
 assert.equal((await request(s,'',{action:'proxy.toggle',input,csrf:false})).status,403);
 const first=await request(s,'',{action:'proxy.toggle',input,key});
 assert.equal(first.status,200);assert.equal(first.body.data.current.enabled,false);
 const replay=await request(s,'',{action:'proxy.toggle',input,key});assert.equal(replay.body.data.replayed,true);
 assert.equal((await request(s,'',{action:'proxy.toggle',input:{expectedRevision:0,enabled:true}})).status,409);
 const read=await request(s,'proxy');assert.equal(read.body.data.enabled,false);
 assert.ok(Object.values(read.body.data.effective).every(row=>row.enabled===false&&row.source==='disabled'));
});
test('HTTP refuses root spoofing, unknown fields, invalid operations and leaked settings',async t=>{
 const {session,request}=await setup(t),s=session('impostor'),r=session('root');
 assert.equal((await request(s,'proxy')).status,403);assert.equal((await request(s,'permissions')).status,403);
 assert.equal((await request(r,'',{action:'brand.reset',input:{expectedRevision:0,actor:{id:'root'}}})).status,422);
 assert.equal((await request(r,'',{action:'brand.reset',input:{expectedRevision:0},key:'unstable'})).status,422);
 const result=await request(r,'public-api');assert.equal(result.status,200);assert.ok(!JSON.stringify(result.body).includes('fixture-source-key'));assert.ok(!JSON.stringify(result.body).includes('tokenHash'));
});
test('HTTP read pagination, logs export and receipt enforce actor boundary',async t=>{
 const {session,request}=await setup(t),s=session('root'),viewer=session('viewer');
 const page=await request(s,'logs?limit=5');assert.equal(page.body.data.items.length,5);
 const exportId=randomUUID(),saved=await request(s,'',{action:'logs.export',input:{expectedRevision:0,query:{limit:5}},key:exportId});
 assert.equal(saved.body.data.rows,5);assert.ok(saved.body.data.content.includes('登录管理工作台')||saved.body.data.content.includes('更新战队徽标'));
 assert.equal((await request(viewer,'operations/'+exportId)).status,404);
 assert.equal((await request(viewer,'permissions')).status,403);assert.equal((await request(viewer,'accounts')).status,403);
});
test('HTTP account role mutation expires target session and resets contexts via G03',async t=>{
 const {f,session,request}=await setup(t),s=session('root'),target=session('viewer');
 f.contexts.issue({browser:'local',purpose:'onboarding',provider:'kook',accountId:'viewer'});
 const saved=await request(s,'',{action:'account.role',target:'viewer',input:{expectedRevision:1,roleId:'member'}});assert.equal(saved.status,200);
 assert.equal((await request(target,'logs')).status,401);assert.equal(f.contexts.entries.size,0);
});
test('HTTP two-phase backup cleanup and restart-style recovery return no filesystem paths or raw backup',async t=>{
 const {f,session,request,origin}=await setup(t),s=session('root');
 const backup=await request(s,'',{action:'storage.backup',input:{expectedRevision:0}});assert.equal(backup.status,200);const artifact=backup.body.data.current;
 const preview=await request(s,'storage/'+artifact.id+'/preview'),input={expectedRevision:1,artifactRevision:1,preview:preview.body.data.preview};
 const original=f.storage.quarantine;let first=true;f.storage.quarantine=a=>{const r=original(a);if(first){first=false;throw Error('crash after rename');}return r;};
 const key=randomUUID(),unknown=await request(s,'',{action:'storage.quarantine',target:artifact.id,input,key});assert.equal(unknown.status,503);assert.equal(f.service.repo.operation(key).state,'pending');
 const recovery=await fetch(origin+'/api/v2/system-admin/operations/'+key+'/recover',{method:'POST',headers:{cookie:`nb_v2_session=${s.token}`,Origin:origin,'X-CSRF-Token':s.csrfToken,'Idempotency-Key':key}});
 const recovered=await recovery.json();assert.equal(recovery.status,200);assert.equal(recovered.data.current.state,'quarantined');
 assert.ok(!JSON.stringify(recovered).includes(f.artifactDir));assert.ok(!JSON.stringify(recovered).includes('fileName'));
});
test('HTTP chunked logo upload preserves full 2 MB capacity below G03 parser limit',async t=>{
 const {f,session,request}=await setup(t),s=session('root');
 const png=pngFixture(700,700);assert.ok(png.length>1900000 && png.length<=2*1024*1024);
 const start=await request(s,'',{action:'brand.upload.start',input:{expectedRevision:0,mimeType:'image/png',totalBytes:png.length}});
 assert.equal(start.status,200);let rev=1;const id=start.body.data.current.id;
 for(let offset=0,part=0;offset<png.length;offset+=18000,part++){
  const chunk=await request(s,'',{action:'brand.upload.part',target:id,input:{expectedRevision:rev,part,data:png.subarray(offset,offset+18000).toString('base64')}});
  assert.equal(chunk.status,200);rev=chunk.body.data.current.revision;
 }
 const done=await request(s,'',{action:'brand.upload.finish',target:id,input:{expectedRevision:rev}});assert.equal(done.status,200);assert.equal(done.body.data.current.revision,1);
 assert.equal(f.storage.readLogo(f.service.repo.artifact(done.body.data.current.logoArtifactId)).length,png.length);
 const stale=await request(s,'',{action:'brand.upload.start',input:{expectedRevision:0,mimeType:'image/png',totalBytes:100}});assert.equal(stale.status,409);
});

test('legacy G03 admin mutation bypass is closed and public token HTTP guard retains header compatibility',async t=>{
 const {f,session,request,origin}=await setup(t),s=session('root');
 const retired=await fetch(origin+'/api/v2/identity/accounts/member',{method:'PATCH',headers:{cookie:`nb_v2_session=${s.token}`,Origin:origin,'X-CSRF-Token':s.csrfToken,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:1,status:'disabled'})});
 assert.equal(retired.status,410);assert.equal(f.repo.get('accounts','member').status,'active');
 await request(s,'',{action:'public.save',input:{expectedRevision:0,token:'Local-HTTP-token-only'}});
 const query=async headers=>fetch(origin+'/api/integrations/public-query',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({steamInput:'76561198000000001'})});
 assert.equal((await query({'Authorization':'Bearer Local-HTTP-token-only'})).status,200);
 assert.equal((await query({'X-NB-API-Token':'Local-HTTP-token-only'})).status,200);
 assert.equal((await query({'X-NB-API-Token':'fixture-source-key-not-for-browser'})).status,401);
 await request(s,'',{action:'public.clear',input:{expectedRevision:1}});assert.equal((await query({'X-NB-API-Token':'Local-HTTP-token-only'})).status,401);
});
