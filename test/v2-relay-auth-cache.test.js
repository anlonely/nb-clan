import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayAuthCache } from '../server/relay-auth-cache.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('rotation prevents old asynchronous load refilling relay cache',async()=>{
 const pending=deferred();let reads=0;const seen=[];
 const cache=createRelayAuthCache({ttlMs:5000,readHash:()=>++reads===1?pending.promise:'new',verify:async(req,hash)=>seen.push(hash)});
 const work=cache.authenticate({});cache.invalidate();pending.resolve('old');
 await assert.rejects(work,{errorCode:'RELAY_CREDENTIALS_CHANGED'});await cache.authenticate({});await cache.authenticate({});
 assert.deepEqual(seen,['new','new']);assert.equal(reads,2);
});
test('rotation fences verification and the final ingress continuation',async()=>{
 const entered=deferred(),release=deferred();let wait=true;
 const cache=createRelayAuthCache({ttlMs:5000,readHash:async()=>'hash',verify:async()=>{if(wait){entered.resolve();await release.promise;}}});
 const work=cache.authenticate({});await entered.promise;cache.invalidate();release.resolve();
 await assert.rejects(work,{status:401});wait=false;
 const assertCurrent=await cache.authenticate({});cache.invalidate();assert.throws(assertCurrent,{status:401});
});
