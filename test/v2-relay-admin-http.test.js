import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { httpFixture, password, tokenA, tokenB } from './support/v2-relay-admin/fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';
async function setup(t){const f=await httpFixture();t.after(()=>f.close());const request=async(s,path='',{action,input,id=randomUUID(),csrf=true,origin=f.origin,raw,recover=false}={})=>{
 const mutation=Boolean(action||recover),r=await fetch(f.origin+'/api/v2/relay-admin'+(action?'/commands/'+action:path),{method:mutation?'POST':'GET',headers:{...(s?{Cookie:s.cookie||`nb_v2_session=${s.token}`} :{}),...(mutation?{Origin:origin,'Content-Type':'application/json','Idempotency-Key':id,...(csrf?{'X-CSRF-Token':s?.csrfToken||''}:{})}:{})},...(mutation?{body:raw??JSON.stringify({input})}:{})});return {status:r.status,headers:r.headers,body:await r.json()};};return {...f,request};}
test('retired password login is rejected; real community session and CSRF protect relay writes and recovery',async t=>{
 const f=await setup(t);assert.equal((await f.request(null)).status,401);const response=await fetch(f.origin+'/api/v2/auth/password',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'api_edit',password})});assert.equal(response.status,403);const s=f.session('api_edit');
 const read=await f.request(s);assert.equal(read.status,200);assert.equal(read.body.data.canWrite,true);assert.equal(read.headers.get('cache-control'),'no-store');const before=f.db.prepare('SELECT total_changes() n').get().n;await f.request(s);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 const input={expectedRevision:read.body.data.revision,token:tokenA};for(const opts of [{csrf:false},{origin:'http://localhost.evil'}])assert.equal((await f.request(s,'',{action:'save',input,...opts})).status,403);
 const first=await f.request(s,'',{action:'save',input});assert.equal(first.status,200);const verify=token=>fetch(f.origin+'/fixture/relay-auth',{method:'POST',headers:{Authorization:'Bearer '+token}});assert.equal((await verify(tokenA)).status,204);
 f.hooks.beforeCache=()=>{throw Error(tokenB);};const id=randomUUID(),rotated=await f.request(s,'',{action:'save',input:{expectedRevision:(await f.request(s)).body.data.revision,token:tokenB},id});assert.equal(rotated.status,503);assert.equal(rotated.body.error.errorCode,'CACHE_REFRESH_REQUIRED');assert.equal((await verify(tokenA)).status,401);assert.equal((await verify(tokenB)).status,204);
 const receipt=await f.request(s,'/operations/'+id);assert.equal(receipt.body.data.state,'committed');assert.equal(receipt.body.data.cacheState,'not_checked');f.hooks.beforeCache=null;assert.equal((await f.request(s,'/operations/'+id+'/recover',{recover:true,id,csrf:false})).status,403);assert.equal((await f.request(s,'/operations/'+id+'/recover',{recover:true,id})).body.data.cacheState,'refreshed');
 assert.equal((await f.request(s,'',{action:'clear',input:{expectedRevision:(await f.request(s)).body.data.revision}})).status,200);assert.equal((await verify(tokenB)).status,403);
 const exposed=JSON.stringify([first,rotated,receipt]);assert.ok(!exposed.includes(tokenA));assert.ok(!exposed.includes(tokenB));
});
test('current admin demotion and session revocation protect relay command, replay, receipt and recovery',async t=>{
 const f=await setup(t);for(const actor of ['api_view','tools_view','viewer']){const r=await f.request(f.session(actor),'',{action:'clear',input:{expectedRevision:f.revision()}});assert.equal(r.status,403);}
 const s=f.session('tools_edit'),id=randomUUID(),input={expectedRevision:f.revision(),token:tokenA};const saved=await f.request(s,'',{action:'save',input,id});assert.equal(saved.status,200);const a=f.repo.get('accounts','tools_edit');f.repo.put('accounts',{...a,permissionVersion:a.permissionVersion+1,roleId:'member',adminAssignedByOwner:false,grants:[...a.grants,grant('relay.read',{type:'all'},{effect:'deny'})]});
 for(const r of [await f.request(s,'',{action:'save',input,id}),await f.request(s,'/operations/'+id),await f.request(s,'/operations/'+id+'/recover',{recover:true,id})])assert.equal(r.status,401);
 const current=f.session('tools_edit');assert.equal((await f.request(current,'/operations/'+id)).status,403);assert.equal((await f.request(current,'/operations/'+id+'/recover',{recover:true,id})).status,403);
 assert.equal((await f.request(f.session('api_edit'),'/operations/'+id)).status,404);
});
test('malformed body, oversized parent-parsed body and unknown fields never echo plaintext or create receipts',async t=>{
 const f=await setup(t),s=f.session('root');for(const raw of [`{"input":{"token":"${tokenA}",`,JSON.stringify({input:{expectedRevision:f.revision(),token:tokenA,role:'root'}}),JSON.stringify({input:{expectedRevision:f.revision(),token:' '.repeat(5000)+tokenA}})]){const r=await f.request(s,'',{action:'save',raw});assert.ok(r.status>=400);assert.ok(!JSON.stringify(r.body).includes(tokenA));}assert.equal(f.db.prepare('SELECT count(*) n FROM v2_relay_admin_operations').get().n,0);
});
test('two concurrent requests with one operation ID commit at most once and recover without token resubmission',async t=>{
 const f=await setup(t),s=f.session('root'),id=randomUUID(),input={expectedRevision:f.revision(),token:tokenA};const r=await Promise.all([f.request(s,'',{action:'save',input,id}),f.request(s,'',{action:'save',input,id})]);assert.ok(r.some(x=>x.status===200));assert.ok(r.every(x=>x.status===200||x.status===503&&x.body.error.errorCode==='OPERATION_IN_PROGRESS'));assert.equal(f.db.prepare('SELECT count(*) n FROM v2_relay_admin_operations').get().n,1);const hash=f.repo.scalar('settings').rustplusRelay.tokenHash;assert.equal((await f.request(s,'/operations/'+id+'/recover',{recover:true,id})).status,200);assert.equal(f.repo.scalar('settings').rustplusRelay.tokenHash,hash);assert.equal(f.counters().hashes,1);
});
