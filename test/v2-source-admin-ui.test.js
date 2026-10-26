import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSourceCommand } from '../src/v2/source-admin/command.js';
function setup() {
  const saved=new Map(),requests=[];let generation=1,handler=async()=>({data:{state:'succeeded',cacheState:'refreshed'}});
  const client={getGeneration:()=>generation,getIdentity:()=>({accountId:'fixture-root'}),request:async(path,input)=>{requests.push({path,input});return handler(path,input);}};
  const storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const results=[],states=[],command=createSourceCommand({client,storage,onChange:s=>states.push(s),onSaved:r=>results.push(r)});
  return{saved,requests,client,storage,results,states,command,handler:fn=>handler=fn,revoke:()=>generation++};
}
test('UI command keeps original observed revision, stable key and no secrets in session storage', async()=>{
  const f=setup(),secret='synthetic-ui-secret';f.handler(async()=>{throw{status:503,errorCode:'CACHE_REFRESH_REQUIRED'};});
  const input={expectedRevision:'observed-before-refresh',apiKey:secret};await f.command.run('steam.save',input);input.expectedRevision='later-revision';
  assert.equal(f.command.snapshot().phase,'unknown');assert.ok(!JSON.stringify([...f.saved]).includes(secret));assert.ok(!JSON.stringify([...f.saved]).includes('observed-before-refresh'));
  f.handler(async()=>({data:{state:'succeeded',cacheState:'refreshed'}}));await f.command.retry();
  assert.equal(f.requests[0].input.headers['Idempotency-Key'],f.requests[1].input.headers['Idempotency-Key']);assert.equal(f.requests[1].input.body.input.expectedRevision,'observed-before-refresh');assert.equal(f.saved.size,0);
});
test('reload recovers via POST without retaining plaintext or mistaking GET receipt for cache completion',async()=>{
  const f=setup();f.handler(async()=>{throw{status:503};});await f.command.run('steam.save',{expectedRevision:'old',apiKey:'synthetic-ui-secret'});f.command.dispose();
  const next=createSourceCommand({client:f.client,storage:f.storage});assert.equal(next.canRetry(),false);f.handler(async()=>({data:{state:'succeeded',cacheState:'refreshed'}}));await next.recover();
  const r=f.requests.at(-1);assert.equal(r.input.method,'POST');assert.ok(r.path.endsWith('/recover'));assert.equal(r.input.body,undefined);assert.equal(next.snapshot().phase,'saved');
});
test('unknown operation blocks a fresh command; 404 recovery releases it only after confirmation',async()=>{
  const f=setup();f.handler(async()=>{throw{status:0};});await f.command.run('steam.clear',{expectedRevision:'old'});await assert.rejects(f.command.run('steam.clear',{}),/OPERATION_PENDING/);
  f.handler(async()=>{throw{status:404};});await f.command.recover();assert.equal(f.command.snapshot().phase,'not-recorded');assert.equal(f.saved.size,0);
});
test('identity-generation change or unmount discards late UI results and in-memory credentials',async()=>{
  const f=setup();let release;f.handler(()=>new Promise(r=>release=r));const p=f.command.run('steam.save',{expectedRevision:'old',apiKey:'synthetic-ui-secret'});f.revoke();release({data:{state:'succeeded'}});await p;assert.equal(f.results.length,0);
  const count=f.requests.length;await f.command.retry();await f.command.recover();assert.equal(f.requests.length,count);f.command.dispose();assert.equal(f.command.canRetry(),false);
});
test('definite revision conflict clears pending command and never auto-rebases or resends',async()=>{
  const f=setup();f.handler(async()=>{throw{status:409,errorCode:'REVISION_CONFLICT'};});await f.command.run('steam.clear',{expectedRevision:'old'});assert.equal(f.command.snapshot().phase,'error');assert.equal(f.saved.size,0);assert.equal(f.requests.length,1);assert.equal(f.command.canRetry(),false);
});
