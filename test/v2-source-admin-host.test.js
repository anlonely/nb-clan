import './support/owner-environment.mjs';
import { OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';
import './support/v2-baseline/loopback-only.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, scope } from './support/v2-source-window/fixture.mjs';
import { createSourceAdmin, installSourceAdminSchema } from '../server/v2/source-admin/index.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { fixture as adminFixture } from './support/v2-source-admin/fixture.mjs';
test('real source-host reads rotated canonical BM key; old saved source-window fails before any I/O', async t => {
  const f=await fixture();t.after(()=>f.close());
  const old=await f.service.request(f.actor(),{type:'battlemetrics_playtime',scope},{operationId:'source-admin-before-rotation'});
  const user={id:'user_root',username:'root',role:'admin'};f.repo.put('users',user);const a=f.repo.get('accounts','g05_account_admin');
  f.repo.put('accounts',{...a,legacyUserId:user.id,legacyFingerprint:legacyFingerprint(user,[])});
  const member = f.repo.get('members', a.memberId); f.repo.put('members', { ...member, steamId: OWNER_STEAM_ID });
  const binding = f.repo.all('bindings').find(row => row.accountId === a.id); f.repo.put('bindings', { ...binding, steamId: OWNER_STEAM_ID, status: 'verified' });
  installSourceAdminSchema(f.db,{apply:true});const cache={};const admin=createSourceAdmin({identity:f.identity,patchStoreCache:fn=>fn(cache)});admin.start();t.after(()=>admin.stop());
  const dto=admin.read(f.actor(),'battlemetrics'),rotated='synthetic-rotated-bm-key-20260908';
  await admin.command(f.actor(),'battlemetrics.save',{expectedRevision:dto.revision,id:dto.keys[0].id,apiKey:rotated},randomUUID());
  assert.equal(f.repo.scalar('settings').battlemetrics.apiKey,rotated);assert.equal(cache.settings.battlemetrics.apiKey,rotated);
  assert.throws(()=>f.config(old.job.scope),e=>e.errorCode==='SOURCE_WINDOW_CONTEXT_CHANGED');
  await f.worker.step();assert.equal(f.service.job(old.job.id).status,'failed');assert.equal(f.calls.length,0);
  let nativeKeyObserved=false;f.behavior.handler=(req,res)=>{assert.equal(req.headers.authorization,'Bearer '+rotated);nativeKeyObserved=true;res.end(JSON.stringify({data:[]}));};
  f.advance(1000);const fresh=await f.service.request(f.actor(),{type:'battlemetrics_playtime',scope},{operationId:'source-admin-after-rotation'});
  assert.notEqual(fresh.job.id,old.job.id);await f.worker.step();assert.equal(nativeKeyObserved,true);assert.equal(f.calls.length,1);assert.equal(f.service.job(fresh.job.id).status,'succeeded');
});
test('real Steam host reads saved key then injected fallback after clear; no external network is used', async t => {
  const f=await adminFixture();t.after(()=>f.close());const observed=[];
  const host=createSourceHost({readSettings:()=>f.repo.scalar('settings'),readWipe:()=>null,capabilities:{steam:true},readCredentials:()=>({steamApiKey:'synthetic-injected-steam-key'}),
    origins:{steam:'http://127.0.0.1:49199'},allowLoopbackForTests:true,fetchImpl:async url=>{const u=new URL(url);assert.equal(u.origin,'http://127.0.0.1:49199');observed.push(u.searchParams.get('key'));return new Response(JSON.stringify({response:{players:[{steamid:'76561198000000001',personaname:'构造玩家'}]}}),{status:200,headers:{'content-type':'application/json'}});}});t.after(()=>host.stop());
  const read=()=>host.readers.steamProfile({member:{steamId:'76561198000000001'}});
  await read();await f.service.command(f.actor('root'),'steam.save',{expectedRevision:f.revision('steam'),apiKey:'synthetic-saved-steam-key'},randomUUID());await read();
  await f.service.command(f.actor('root'),'steam.clear',{expectedRevision:f.revision('steam')},randomUUID());await read();
  assert.deepEqual(observed,['synthetic-injected-steam-key','synthetic-injected-steam-key','synthetic-saved-steam-key','synthetic-saved-steam-key','synthetic-injected-steam-key','synthetic-injected-steam-key']);
});
