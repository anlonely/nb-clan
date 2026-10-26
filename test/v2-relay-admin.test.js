import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture,tokenA,tokenB } from './support/v2-relay-admin/fixture.mjs';
import { createRelayAdmin,installRelayAdminSchema } from '../server/v2/relay-admin/index.js';
import { grant } from '../server/v2/identity/permissions.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';
import { runStoreWriteTask } from '../server/store.js';
import { validateRustplusRelayToken, RUSTPLUS_RELAY_TOKEN_MIN_LENGTH, RUSTPLUS_RELAY_TOKEN_MAX_LENGTH } from '../server/rustplus-relay.js';
const setup=async(t,options)=>{const f=await fixture({ ...options });for(const id of ['root','admin','api_edit','tools_edit','native_api'])f.repo.put('accounts',{...f.repo.get('accounts',id),roleId:'admin',adminAssignedByOwner:true});t.after(()=>f.close());return f;};
const call=(f,action='save',input={},id=randomUUID(),actor='root')=>Promise.resolve().then(()=>f.service.command(f.actor(actor),action,{expectedRevision:f.revision(actor),...(action==='save'?{token:tokenA}:{}),...input},id));
const err=errorCode=>({errorCode});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
test('explicit schema install, no copied credential and repeat GET performs no writes',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());assert.equal(installRelayAdminSchema(db).required,true);assert.equal(db.prepare('SELECT total_changes() n').get().n,0);assert.throws(()=>createRelayAdmin({identity:{repo:{db}}}),err('RELAY_ADMIN_MIGRATION_REQUIRED'));
 const f=await setup(t),before=f.db.prepare('SELECT total_changes() n').get().n;for(let i=0;i<3;i++)f.service.read(f.actor('root'));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.deepEqual(f.counters(),{patches:0,hashes:0,invalidations:0});const key=f.service.repo.signatureKey;installRelayAdminSchema(f.db,{apply:true});assert.equal(f.service.repo.signatureKey,key);
 installRelayAdminSchema(db,{apply:true});db.exec('DROP TABLE v2_relay_admin_operations');assert.equal(installRelayAdminSchema(db).required,true);assert.throws(()=>createRelayAdmin({identity:{repo:{db}}}),err('RELAY_ADMIN_MIGRATION_REQUIRED'));
});
test('current fixed administrator role admits explicit editor fixtures and rejects ordinary members despite legacy view grants',async t=>{
 const f=await setup(t);for(const id of ['root','admin','api_edit','tools_edit','native_api']){assert.equal(f.service.read(f.actor(id)).canWrite,true,id);await call(f,'save',{token:tokenA+'-'+id},randomUUID(),id);}
 for(const id of ['api_view','tools_view']){assert.throws(()=>f.service.read(f.actor(id)),err('ACCESS_DENIED'));await assert.rejects(call(f,'clear',{},randomUUID(),id),err('ACCESS_DENIED'));}
 for(const id of ['clan_only','deny_all','native_relay','native_scoped'])assert.throws(()=>f.service.read(f.actor(id)),err('ACCESS_DENIED'));
 assert.throws(()=>f.service.read(f.actor('api_view')),err('ACCESS_DENIED'));
});
test('current assigned role governs relay access; legacy scope fields cannot demote or promote accounts',async t=>{
 const f=await setup(t);
 for(const id of ['api_edit','tools_edit']) {
  const a=f.repo.get('accounts',id);
  f.repo.put('accounts',{...a,grants:[grant('system.api_keys',{type:'all'},{effect:'deny'}),grant('relay.read',{type:'self'})]});
  assert.equal(f.service.read(f.actor(id)).canWrite,true);
  f.repo.put('accounts',{...a,roleId:'member',adminAssignedByOwner:false});
  assert.throws(()=>f.service.read(f.actor(id)),err('ACCESS_DENIED'));
 }
 for(const id of ['deny_all','viewer']) {
  const account=f.repo.get('accounts',id);
  f.repo.put('accounts',{...account,grants:[grant('system.api_keys',{type:'all'}),grant('relay.read',{type:'all'})]});
  await assert.rejects(call(f,'clear',{},randomUUID(),id),err('ACCESS_DENIED'));
 }
});

test('missing or invalid synchronous invalidator forbids write; throwing hook rolls back canonical receipt and audit',async t=>{
 const f=await setup(t,{missingInvalidator:true});assert.equal(f.service.read(f.actor('root')).canWrite,false);await assert.rejects(call(f),err('RELAY_AUTH_INVALIDATOR_REQUIRED'));assert.equal(f.counters().hashes,0);
 const g=await setup(t),before=g.repo.scalar('settings');for(const hook of [()=>{throw Error(tokenA);},()=>Promise.resolve(),()=>true]){g.hooks.invalidate=hook;await assert.rejects(call(g),err('RELAY_AUTH_INVALIDATION_FAILED'));assert.deepEqual(g.repo.scalar('settings'),before);assert.equal(g.db.prepare('SELECT count(*) n FROM v2_relay_admin_operations').get().n,0);assert.equal(g.db.prepare('SELECT count(*) n FROM v2_relay_admin_audits').get().n,0);}
});
test('original hash and original relay validator accept saved token; rotation and clear immediately reject primed old cache',async t=>{
 const f=await setup(t);await call(f);await f.verify(tokenA);await validateRustplusRelayToken({headers:{'x-nb-relay-token':tokenA}},{settings:f.repo.scalar('settings')});const saved=f.repo.scalar('settings'),hash=saved.rustplusRelay.tokenHash;assert.match(hash,/^scrypt\$/);assert.equal(saved.rustplusRelay.lastError,'');
 await call(f,'save',{token:tokenB});await assert.rejects(f.verify(tokenA),{status:401});await f.verify(tokenB);await call(f,'clear');await assert.rejects(f.verify(tokenB),{status:403});const cleared=f.repo.scalar('settings');assert.equal(cleared.rustplusRelay.tokenHash,'');assert.equal(cleared.rustplusRelay.tokenUpdatedAt,'');assert.deepEqual(cleared.other,saved.other);assert.deepEqual(cleared.publicApi,saved.publicApi);assert.deepEqual(cleared.rustplusRelay.discordForwarding,saved.rustplusRelay.discordForwarding);
});
test('exact original trim and length boundaries preserve unicode, reject under/over without truncation',async t=>{
 const f=await setup(t);assert.equal(RUSTPLUS_RELAY_TOKEN_MIN_LENGTH,16);assert.equal(RUSTPLUS_RELAY_TOKEN_MAX_LENGTH,256);
 for(const token of ['x'.repeat(15),'x'.repeat(257),0,null])await assert.rejects(call(f,'save',{token}),err('INVALID_TOKEN_LENGTH'));
 for(const token of ['x'.repeat(16),'x'.repeat(256),'汉'.repeat(16)]){await call(f,'save',{token:' '+token+' '});await f.verify(token);}
});
test('scrypt runs outside original queue and transaction, then queued commit rechecks current settings',async t=>{
 const f=await setup(t),entered=deferred(),gate=deferred();f.hooks.beforeHash=()=>{entered.resolve();return gate.promise;};const p=call(f);await entered.promise;let concurrent=false;await runStoreWriteTask(()=>{const s=f.repo.scalar('settings');s.other.extra='parallel';f.repo.setScalar('settings',s);concurrent=true;});assert.equal(concurrent,true);gate.resolve();await p;assert.equal(f.repo.scalar('settings').other.extra,'parallel');
 const observer=new DatabaseSync(f.databaseFile);t.after(()=>observer.close());let checked=false;f.hooks.beforeHash=null;f.hooks.invalidate=()=>{if(!checked){const external=JSON.parse(observer.prepare("SELECT payload_json FROM json_scalars WHERE key='settings'").get().payload_json);assert.notEqual(external.rustplusRelay.tokenHash,f.repo.scalar('settings').rustplusRelay.tokenHash);checked=true;}};await call(f,'save',{token:tokenB});assert.equal(checked,true);
});
test('same operation does not rehash or rotate; body, actor and action collisions fail',async t=>{
 const f=await setup(t),id=randomUUID(),input={expectedRevision:f.revision(),token:tokenA};const command=()=>f.service.command(f.actor('root'),'save',input,id);await command();const hash=f.repo.scalar('settings').rustplusRelay.tokenHash,counts=f.counters();await command();assert.equal(f.counters().hashes,counts.hashes);assert.equal(f.repo.scalar('settings').rustplusRelay.tokenHash,hash);assert.equal(f.db.prepare('SELECT count(*) n FROM v2_relay_admin_audits').get().n,1);
 await assert.rejects(Promise.resolve().then(()=>f.service.command(f.actor('root'),'save',{...input,token:tokenB},id)),err('OPERATION_CONFLICT'));await assert.rejects(Promise.resolve().then(()=>f.service.command(f.actor('admin'),'save',input,id)),err('OPERATION_CONFLICT'));await assert.rejects(Promise.resolve().then(()=>f.service.command(f.actor('root'),'clear',{expectedRevision:input.expectedRevision},id)),err('OPERATION_CONFLICT'));
});
test('concurrent operations and legacy out-of-band token edits honor observed revision',async t=>{
 const f=await setup(t),input={expectedRevision:f.revision(),token:tokenA};const results=await Promise.allSettled([f.service.command(f.actor('root'),'save',input,randomUUID()),f.service.command(f.actor('root'),'save',{...input,token:tokenB},randomUUID())]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.errorCode,'REVISION_CONFLICT');
 const revision=f.revision();await runStoreWriteTask(()=>{const s=f.repo.scalar('settings');s.rustplusRelay.tokenUpdatedAt=new Date(Date.now()+1000).toISOString();f.repo.setScalar('settings',s);});await assert.rejects(call(f,'clear',{expectedRevision:revision}),err('REVISION_CONFLICT'));
});
test('hashing and queue waits fence revoke, permission version, current fixed role and stop',async t=>{
 for(const mode of ['pv','disabled','role','stop']){const f=await setup(t),entered=deferred(),gate=deferred();f.hooks.beforeHash=()=>{entered.resolve();return gate.promise;};const p=call(f),checked=assert.rejects(p,e=>['AUTH_CHANGED','ACCESS_DENIED','ACCOUNT_DISABLED','PERMISSIONS_CHANGED','RELAY_ADMIN_STOPPED'].includes(e.errorCode));await entered.promise;let stopping;const a=f.repo.get('accounts','root');if(mode==='pv')f.repo.put('accounts',{...a,permissionVersion:a.permissionVersion+1});if(mode==='disabled')f.repo.put('accounts',{...a,status:'disabled'});if(mode==='role')f.repo.put('accounts',{...a,roleId:'member',adminAssignedByOwner:false});if(mode==='stop')stopping=f.service.stop();gate.resolve();await checked;await stopping;assert.equal(f.repo.scalar('settings').rustplusRelay.tokenHash,'');}
});
test('post-commit cache failure keeps canonical and invalidates old token; receipt recovery uses latest settings without hashing',async t=>{
 const f=await setup(t);await call(f);await f.verify(tokenA);const id=randomUUID(),input={expectedRevision:f.revision(),token:tokenB};f.hooks.beforeCache=()=>{throw Error(tokenB);};await assert.rejects(f.service.command(f.actor('root'),'save',input,id),err('CACHE_REFRESH_REQUIRED'));await assert.rejects(f.verify(tokenA),{status:401});await f.verify(tokenB);const r=f.service.getOperation(f.actor('root'),id);assert.equal(r.state,'committed');assert.equal(r.cacheState,'not_checked');
 f.hooks.beforeCache=null;await call(f,'save',{token:tokenA+'-newer'});const latest=f.repo.scalar('settings').rustplusRelay.tokenHash,c=f.counters();await f.service.recover(f.actor('root'),id);assert.equal(f.counters().hashes,c.hashes);assert.equal(f.cache.settings.rustplusRelay.tokenHash,latest);await f.service.command(f.actor('root'),'save',input,id);assert.equal(f.repo.scalar('settings').rustplusRelay.tokenHash,latest);
});
test('new owner recovers durable receipt, and current revoked authority cannot read/replay/recover it',async t=>{
 const f=await setup(t),id=randomUUID();f.hooks.beforeCache=()=>{throw Error('fixture-cache-failure');};await assert.rejects(call(f,'save',{},id),err('CACHE_REFRESH_REQUIRED'));await f.service.stop();f.hooks.beforeCache=null;const next=createRelayAdmin({identity:f.identity,invalidateRelayAuthCache:f.invalidateRelayAuthCache,patchStoreCache:f.patchStoreCache});next.start();t.after(()=>next.stop());const r=await next.recover(f.actor('root'),id);assert.equal(r.cacheState,'refreshed');const a=f.repo.get('accounts','root');f.repo.put('accounts',{...a,permissionVersion:a.permissionVersion+1,roleId:'member',adminAssignedByOwner:false,grants:[]});for(const fn of [()=>next.getOperation(f.actor('root'),id),()=>next.recover(f.actor('root'),id)])assert.throws(fn,err('ACCESS_DENIED'));
});
test('transaction receipt/audit failure rolls back all data and queue errors never expose plaintext',async t=>{
 const f=await setup(t),before=f.repo.scalar('settings');f.db.exec("CREATE TEMP TRIGGER relay_fail BEFORE INSERT ON v2_relay_admin_audits BEGIN SELECT RAISE(ABORT,'constructed-relay-token-alpha'); END");await assert.rejects(call(f),err('RELAY_ADMIN_UNAVAILABLE'));assert.deepEqual(f.repo.scalar('settings'),before);assert.equal(f.counters().invalidations,0);f.db.exec('DROP TRIGGER relay_fail');const r=await call(f);const exposed=JSON.stringify([r,f.service.read(f.actor('root')),f.service.getOperation(f.actor('root'),r.operationId),f.db.prepare('SELECT * FROM v2_relay_admin_operations').all(),f.db.prepare('SELECT * FROM v2_relay_admin_audits').all()]);assert.ok(!exposed.includes(tokenA));assert.ok(!exposed.includes(f.repo.scalar('settings').rustplusRelay.tokenHash));assert.ok(!exposed.includes(f.service.repo.signatureKey));
});
test('unknown timeout during hashing cannot be misread as not-recorded or start another rotation with the same ID',async t=>{
 const f=await setup(t),entered=deferred(),gate=deferred(),id=randomUUID(),input={expectedRevision:f.revision(),token:tokenA};f.hooks.beforeHash=()=>{entered.resolve();return gate.promise;};const p=f.service.command(f.actor('root'),'save',input,id);await entered.promise;
 assert.throws(()=>f.service.getOperation(f.actor('root'),id),err('OPERATION_IN_PROGRESS'));await assert.rejects(f.service.recover(f.actor('root'),id),err('OPERATION_IN_PROGRESS'));assert.throws(()=>f.service.command(f.actor('root'),'save',input,id),err('OPERATION_IN_PROGRESS'));gate.resolve();await p;assert.equal(f.counters().hashes,1);assert.equal((await f.service.recover(f.actor('root'),id)).cacheState,'refreshed');
});
test('post-commit second invalidation failure retains receipt and canonical; recovery cannot replay old rotation',async t=>{
 const f=await setup(t);await call(f);await f.verify(tokenA);let calls=0;f.hooks.invalidate=()=>{if(++calls===2)throw Error(tokenB);};const id=randomUUID();await assert.rejects(call(f,'save',{token:tokenB},id),err('RELAY_AUTH_INVALIDATION_FAILED'));await assert.rejects(f.verify(tokenA),{status:401});await f.verify(tokenB);assert.equal(f.service.getOperation(f.actor('root'),id).state,'committed');f.hooks.invalidate=null;const hashes=f.counters().hashes;await f.service.recover(f.actor('root'),id);assert.equal(f.counters().hashes,hashes);
});
test('queued commit reauthenticates and stop drains committed cache work without closing shared SQLite',async t=>{
 const f=await setup(t),gate=deferred(),entered=deferred();f.hooks.beforeCache=()=>{entered.resolve();return gate.promise;};const p=call(f);await entered.promise;let stopped=false;const stop=f.service.stop().then(()=>stopped=true);await new Promise(r=>setImmediate(r));assert.equal(stopped,false);assert.throws(()=>f.service.start(),err('RELAY_ADMIN_ALREADY_STARTED'));gate.resolve();await p;await stop;assert.equal(f.service.diagnostics().pending,0);assert.equal(f.db.prepare('SELECT 1 n').get().n,1);
 const g=await setup(t),release=deferred(),inQueue=deferred();const blocker=runStoreWriteTask(()=>{inQueue.resolve();return release.promise;});await inQueue.promise;const actor=g.actor('root'),input={expectedRevision:g.revision(),token:tokenA},write=g.service.command(actor,'save',input,randomUUID(),{authenticate:async()=>{throw Object.assign(Error('expired'),{errorCode:'SESSION_EXPIRED',status:401});}}),rejected=assert.rejects(write,err('SESSION_EXPIRED'));release.resolve();await blocker;await rejected;assert.equal(g.repo.scalar('settings').rustplusRelay.tokenHash,'');
});
test('unrelated legacy grant fields cannot grant relay access to a view-only account',async t=>{
 const f=await setup(t),a=f.repo.get('accounts','admin');
 f.repo.put('accounts',{...a,grants:[grant('system.api_keys',{type:'platformTargets',ids:['unrelated-api-owner']},{effect:'deny'}),grant('relay.read',{type:'squads',ids:['unrelated-relay-target']},{effect:'deny'})]});
 assert.equal(f.service.read(f.actor('admin')).canWrite,true);await call(f,'save',{},randomUUID(),'admin');
 const v=f.repo.get('accounts','api_view');f.repo.put('accounts',{...v,grants:[grant('system.api_keys',{type:'all'})]});
 assert.throws(()=>f.service.read(f.actor('api_view')),err('ACCESS_DENIED'));
});

test('expired PV and current fixed administrator role revocation both reject saved authority',async t=>{
 const f=await setup(t),old=f.actor('api_edit'),a=f.repo.get('accounts','api_edit');f.repo.put('accounts',{...a,permissionVersion:a.permissionVersion+1});assert.throws(()=>f.service.read(old),err('AUTH_CHANGED'));
 const user={...f.repo.get('users','legacy_api_edit'),role:'deny_all'};f.repo.put('users',user);f.repo.put('accounts',{...a,permissionVersion:a.permissionVersion+2,roleId:'member',adminAssignedByOwner:false,legacyFingerprint:legacyFingerprint(user,f.repo.all('permissionRoles')),grants:[grant('system.api_keys',{type:'all'}),grant('relay.read',{type:'all'})]});await assert.rejects(call(f,'clear',{},randomUUID(),'api_edit'),err('ACCESS_DENIED'));
});
test('operation UUID case aliases one durable receipt and malformed UUID never hashes',async t=>{
 const f=await setup(t),id=randomUUID(),input={expectedRevision:f.revision(),token:tokenA};await f.service.command(f.actor('root'),'save',input,id);const hashes=f.counters().hashes;const replay=await f.service.command(f.actor('root'),'save',input,id.toUpperCase());assert.equal(replay.operationId,id);assert.equal(f.counters().hashes,hashes);assert.throws(()=>f.service.command(f.actor('root'),'save',input,'not-a-uuid'),err('OPERATION_ID_REQUIRED'));assert.equal(f.counters().hashes,hashes);
});
