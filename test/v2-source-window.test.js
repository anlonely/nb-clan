import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createSyncCenterRouter } from '../server/v2/sync-center/routes.js';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, scope } from './support/v2-source-window/fixture.mjs';
import { createSourceWindow } from '../server/v2/management-adapters/source-window/index.js';
import { IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { grant } from '../server/v2/identity/permissions.js';
const error = code => e => e.errorCode === code;
const request = (f, key = 'window-request', s = scope, actor = f.actor()) => f.service.request(actor, { type: 'battlemetrics_playtime', scope: s }, { operationId: key });
async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }
test('first real request captures one shared window and worker commits canonical BM seconds via loopback', async t => {
  const f = await setup(t), created = await request(f), row = f.rows()[0];
  assert.equal(row.from_at, f.start); assert.equal(row.to_at, new Date(f.now()).toISOString()); assert.equal(row.job_id, created.job.id);
  assert.equal(created.job.scope.sourceWindowId, row.job_id); assert.equal(created.job.scope.sourceWindowIntentId, row.job_id);
  f.advance(120000); await f.worker.step();
  const profile = f.sources.store.profile(f.repo.get('members','g05_alpha'));
  assert.equal(profile.battlemetricsServerPlayTimeSeconds, 3600); assert.equal(profile.battlemetricsRangeStopAt, row.to_at);
  assert.equal(profile.battlemetricsRangeStartAt, row.from_at); assert.equal(profile.battlemetricsWipeId, 'fixture-wipe');
  assert.equal(f.service.job(created.job.id).status, 'succeeded'); assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify(created).includes('fixture-bm-key-window-secret'), false);
});
test('same key replay and active dedup do not capture new clocks; after completion new intent advances', async t => {
  const f = await setup(t), first = await request(f); f.advance(30000);
  assert.deepEqual(await request(f), first);
  const same = await request(f, 'second-key'); assert.equal(same.deduplicated, true); assert.equal(same.job.id, first.job.id); assert.equal(f.rows().length, 1);
  await f.worker.step(); f.advance(30000);
  const next = await request(f, 'new-intent'); assert.notEqual(next.job.id, first.job.id);
  assert.equal(f.rows().length, 2); assert.equal(f.config(next.job.scope).to, new Date(f.now()).toISOString());
  assert.notEqual(f.config(first.job.scope).to, f.config(next.job.scope).to);
});
test('all targets in one current-wipe intent share exact from/to while worker time moves', async t => {
  const f = await setup(t), x = await request(f, 'multiple-members', { kind: 'current_wipe', id: 'fixture-wipe' });
  const contexts = Object.values(x.job.scope.sourceContexts); assert.equal(contexts.length, 4);
  assert.equal(new Set(contexts.map(c => c.to)).size, 1); const to = contexts[0].to;
  for (let n = 0; n < 4; n++) { f.advance(3000); await f.worker.step(); }
  assert.equal(f.rows().length, 1); assert.equal(f.service.job(x.job.id).status, 'succeeded');
  for (const m of ['g05_alpha','g05_beta','g05_leader','g05_admin']) assert.equal(f.sources.store.profile(f.repo.get('members',m)).battlemetricsRangeStopAt,to);
});
test('GET coverage, preview, config and rule validation never create windows', async t => {
  const f = await setup(t), before = f.db.prepare('SELECT total_changes() n').get().n;
  for (let i=0;i<3;i++) { f.advance(1000); f.service.coverage(f.actor(), { type:'battlemetrics_playtime', scope:'current_wipe', id:'fixture-wipe' });
    assert.equal(f.config(scope).to, ''); f.service.resolve(f.actor(),'battlemetrics_playtime',scope); }
  assert.equal(f.rows().length,0); assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  await f.service.saveRule(f.actor(),null,{expectedRevision:0,name:'BM interval',type:'battlemetrics_playtime',scope,enabled:true,intervalMinutes:5},{operationId:'rule-create'});
  assert.equal(f.rows().length,0);
});
test('real tick captures only new jobs and leaves a future tick free to advance cutoff', async t => {
  const f = await setup(t);
  await f.service.saveRule(f.actor(),null,{expectedRevision:0,name:'BM interval',type:'battlemetrics_playtime',scope,enabled:true,intervalMinutes:5},{operationId:'rule-create'});
  f.advance(300001); const [first] = await f.service.tick(); assert.equal(first.job.trigger,'auto'); const firstTo=f.rows()[0].to_at;
  f.advance(300001); const [same] = await f.service.tick(); assert.equal(same.job.id,first.job.id); assert.equal(f.rows().length,1);
  await f.worker.step(); f.advance(300001); const [next] = await f.service.tick(); assert.notEqual(next.job.id,first.job.id); assert.notEqual(f.config(next.job.scope).to,firstTo);
});
test('retry compensation binds new job to original intent/window; repeated retry deduplicates', async t => {
  const f = await setup(t); f.behavior.handler=(_q,r)=>{r.statusCode=500;r.end('{}');};
  const x = await request(f); await f.worker.step(); const failed=f.service.job(x.job.id); assert.equal(failed.status,'failed');
  f.advance(120000);
  const again=await f.service.action(f.actor(),failed.id,'retry',{expectedRevision:failed.revision},{operationId:'retry-window'});
  assert.notEqual(again.job.id,failed.id); assert.equal(again.job.scope.sourceWindowIntentId,failed.id);
  assert.equal(f.config(again.job.scope).to,f.config(failed.scope).to);
  assert.equal((await f.service.action(f.actor(),failed.id,'retry',{expectedRevision:failed.revision},{operationId:'retry-another-key'})).job.id,again.job.id);
  f.behavior.handler=null; await f.worker.step(); assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')).battlemetricsServerPlayTimeSeconds,3600);
  assert.equal(f.rows().length,2);
});
test('source and credential changes prevent old active de-dup and reject compensation rebinding', async t => {
  const f=await setup(t),first=await request(f);
  const settings=f.repo.scalar('settings');settings.battlemetrics.apiKey='rotated-credential';f.repo.setScalar('settings',settings);
  assert.throws(()=>f.config(first.job.scope),error('SOURCE_WINDOW_CONTEXT_CHANGED'));
  f.advance(1000);const next=await request(f,'after-rotation');assert.notEqual(next.job.id,first.job.id);assert.equal(f.rows().length,2);
  await f.worker.step();const failed=f.service.job(first.job.id);assert.equal(failed.status,'failed');
  await assert.rejects(f.service.action(f.actor(),first.job.id,'retry',{expectedRevision:failed.revision},{operationId:'bad-compensation'}),error('SOURCE_WINDOW_CONTEXT_CHANGED'));
  assert.equal(f.rows().length,2);
});
test('request capture/event failure rolls back job, window and command receipt', async t => {
  const f=await setup(t);f.db.exec("CREATE TEMP TRIGGER window_event_failure BEFORE INSERT ON sync_center_events WHEN NEW.kind='created' BEGIN SELECT RAISE(ABORT,'window event failure'); END");
  await assert.rejects(request(f),/window event failure/);assert.equal(f.rows().length,0);assert.equal(f.service.repo.activeJobs().length,0);
  assert.equal(f.service.repo.get('receipt',f.actor().id+':window-request'),null);
});
test('tick caught capture failure rolls back nested job/window but persists disabled rule error', async t => {
  const f=await setup(t);await f.service.saveRule(f.actor(),null,{expectedRevision:0,name:'Failing',type:'battlemetrics_playtime',scope,enabled:true,intervalMinutes:5},{operationId:'failing-rule'});
  f.db.exec("CREATE TEMP TRIGGER window_event_failure BEFORE INSERT ON sync_center_events WHEN NEW.kind='created' BEGIN SELECT RAISE(ABORT,'tick insertion failure'); END");
  f.advance(300001);assert.deepEqual(await f.service.tick(),[]);assert.equal(f.rows().length,0);assert.equal(f.service.repo.activeJobs().length,0);
  const rule=f.service.rules(f.actor()).items[0];assert.equal(rule.enabled,false);assert.ok(rule.errorCode);
});
test('forged contexts are discarded at HTTP-command boundary; window/job/member/server tampering fails read', async t => {
  const f=await setup(t),x=await request(f,'forged-scope',{...scope,sourceWindowId:'forged',sourceContexts:{g05_alpha:{from:'2000-01-01',to:'2099-01-01'}}});
  assert.equal(f.config(x.job.scope).from,f.start);
  for(const changed of [{sourceWindowId:'forged'}, {sourceWindowIntentId:'another'}, {sourceWindowBinding:'fake'}, {wipeId:'other'}, {memberIds:['g05_foreign']}])
    assert.throws(()=>f.config({...x.job.scope,...changed}));
  assert.throws(()=>f.host.readSourceConfig({type:'battlemetrics_playtime',scope:x.job.scope,member:f.repo.get('members','g05_foreign')}),error('SOURCE_WINDOW_MEMBER_MISMATCH'));
  f.db.prepare("UPDATE v2_source_windows SET to_at='2099-01-01T00:00:00.000Z' WHERE job_id=?").run(x.job.id);
  assert.throws(()=>f.config(x.job.scope),error('SOURCE_WINDOW_TAMPERED'));
});
test('cross-squad authorization is checked before dedup and capture', async t => {
  const f=await setup(t);await request(f);
  await assert.rejects(request(f,'foreign-key',scope,f.actor('foreign')),error('ACCESS_DENIED'));
  const a=f.repo.get('accounts','g05_account_leader');a.grants.push(grant('sync.run',{type:'all'},{effect:'deny'}));f.repo.put('accounts',a);
  await assert.rejects(request(f,'denied-leader',scope,f.actor('leader')),error('ACCESS_DENIED'));assert.equal(f.rows().length,1);
});
test('stop/recreate worker and expired lease recovery reuse the frozen window', async t => {
  const f=await setup(t),x=await request(f),j=f.service.job(x.job.id),to=f.config(j.scope).to;
  j.status='running';j.generation=7;j.owner='dead-worker';j.leaseUntil=f.now()-1;j.items[0].status='running';f.service.repo.put('job',j);
  await f.worker.stop();f.advance(120000);const reopened=f.create();
  await reopened.worker.step();assert.equal(reopened.service.job(j.id).status,'succeeded');assert.equal(f.rows().length,1);
  assert.equal(reopened.sources.store.profile(f.repo.get('members','g05_alpha')).battlemetricsRangeStopAt,to);
});
test('cancel while HTTP result is pending fences the old result and permits a new intent', async t => {
  const f=await setup(t);let release,entered;const reached=new Promise(r=>{entered=r;});
  f.behavior.handler=(_q,r)=>{release=()=>r.end(JSON.stringify({data:[]}));entered();};
  const x=await request(f),step=f.worker.step();await reached;const j=f.service.job(x.job.id);
  await f.service.action(f.actor(),j.id,'cancel',{expectedRevision:j.revision},{operationId:'cancel-window'});release();await step;
  assert.equal(f.service.job(j.id).status,'cancelled');assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')),null);
  assert.throws(()=>f.config(j.scope),error('SOURCE_WINDOW_CANCELLED'));f.advance(1000);assert.notEqual((await request(f,'after-cancel')).job.id,j.id);
});
test('configuration change during network I/O fences successful old result at canonical commit', async t => {
  const f=await setup(t);let release,entered;const reached=new Promise(r=>{entered=r;});
  f.behavior.handler=(_q,r)=>{release=()=>r.end(JSON.stringify({data:[]}));entered();};
  const x=await request(f),step=f.worker.step();await reached;
  const w=f.repo.get('schedulingWipes','fixture-wipe');f.repo.put('schedulingWipes',{...w,revision:w.revision+1,serverSnapshot:{battlemetricsId:'502'}});
  release();await step;assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')),null);assert.equal(f.service.job(x.job.id).items[0].status,'failed');
});
test('explicit migration missing and unsupported/future start reject without orphan metadata', async t => {
  const f=await setup(t);const w=f.repo.get('schedulingWipes','fixture-wipe');f.repo.put('schedulingWipes',{...w,serverActualWipeAt:new Date(f.now()+300000).toISOString()});
  await assert.rejects(request(f),error('SOURCE_WINDOW_NOT_STARTED'));assert.equal(f.rows().length,0);assert.equal(f.service.repo.activeJobs().length,0);
  f.db.exec('DROP TABLE v2_source_windows');assert.throws(()=>createSourceWindow({identity:f.identity,readSourceConfig:()=>({})}),error('SOURCE_WINDOW_MIGRATION_REQUIRED'));
});
test('same job transport retry keeps window stable; compensation continue inherits failed subset window', async t => {
  const f=await setup(t);await f.service.saveSource(f.actor(),'battlemetrics',{expectedRevision:2,maxAttempts:2},{operationId:'two-attempts'});
  let attempts=0;f.behavior.handler=(_q,r)=>{if(attempts++===0){r.statusCode=500;r.end('{}');}else r.end(JSON.stringify({data:[]}));};
  const x=await request(f);await f.worker.step();assert.equal(f.service.job(x.job.id).status,'retry_wait');
  const to=f.rows()[0].to_at;f.advance(5000);await f.worker.step();assert.equal(f.service.job(x.job.id).status,'succeeded');assert.equal(f.rows().length,1);
  assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')).battlemetricsRangeStopAt,to);
  f.behavior.handler=(_q,r)=>{r.statusCode=500;r.end('{}');};const second=await request(f,'another-failing-intent');await f.worker.step();f.advance(5000);await f.worker.step();
  const j=f.service.job(second.job.id);assert.equal(j.status,'failed');f.advance(20000);
  const next=await f.service.action(f.actor(),j.id,'continue',{expectedRevision:j.revision},{operationId:'continue-window'});
  assert.equal(next.job.scope.sourceWindowIntentId,j.id);assert.equal(f.config(next.job.scope).to,f.config(j.scope).to);
});
test('sourceWindow operation binding prevents transplanting a successful collection to another job', async t => {
  const f=await setup(t),x=await request(f);
  const outcome=await f.sources.providers.battlemetrics_playtime({type:'battlemetrics_playtime',scope:x.job.scope,memberId:'g05_alpha',operationId:`sync-item:${x.job.id}:g05_alpha`,signal:new AbortController().signal});
  assert.equal(outcome.outcome,'success');
  await assert.rejects(f.service.atomic(()=>f.sources.authority.applyResult({actor:f.actor(),type:'battlemetrics_playtime',scope:x.job.scope,memberId:'g05_alpha',result:outcome.data,
    operationId:'sync-item:other-job:g05_alpha',assertCurrent:()=>{}})),error('SOURCE_WINDOW_JOB_MISMATCH'));
  assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')),null);
});
test('closed wipe clips to authoritative end; missing credentials fails capture without a job', async t => {
  const f=await setup(t),w=f.repo.get('schedulingWipes','fixture-wipe'),end=new Date(f.now()-600000).toISOString();
  f.repo.put('schedulingWipes',{...w,lifecycle:'ended',endedAt:end});const x=await request(f);assert.equal(f.config(x.job.scope).to,end);await f.worker.step();
  assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')).battlemetricsServerPlayTimeSeconds,3000);
  f.repo.setScalar('settings',{battlemetrics:{},system:{proxy:{}}});
  await assert.rejects(request(f,'no-credentials'),error('SOURCE_NOT_CONFIGURED'));assert.equal(f.rows().length,1);assert.equal(f.service.repo.activeJobs().length,0);
});
test('file database reopens without migration/capture and queued intent keeps its original cutoff', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'source-window-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const filename=path.join(directory,'fixture.sqlite'),f=await fixture({filename});const x=await request(f),to=f.rows()[0].to_at;
  await f.worker.stop();await f.host.stop();f.db.close();
  const db=new DatabaseSync(filename),repo=new IdentityRepository(db),identity=new IdentityService(repo,{now:f.now});
  const reopened=f.create(identity);t.after(async()=>{await reopened.worker.stop();await reopened.host.stop();db.close();});
  // Keep the existing fixture upstream alive across the actual DB close/open, then close it through its owner.
  f.advance(120000);const before=db.prepare('SELECT count(*) n FROM v2_source_windows').get().n;
  await reopened.worker.step();assert.equal(reopened.service.job(x.job.id).status,'succeeded');
  assert.equal(reopened.sources.store.profile(repo.get('members','g05_alpha')).battlemetricsRangeStopAt,to);
  assert.equal(db.prepare('SELECT count(*) n FROM v2_source_windows').get().n,before);
  await reopened.worker.stop();await reopened.host.stop();await f.closeNetwork();
});
test('G03-authenticated loopback HTTP request/coverage/receipt/rejection exercises actual SyncCenter router', async t => {
  const f=await fixture(),app=express(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`,auth=createIdentityRouter({service:f.identity,origin,providers:{}});
  app.use('/api/v2',(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:opts=>auth.authenticate(opts)(req)};next();});
  app.use('/api/v2',createSyncCenterRouter({getSystem:()=>({service:f.service,worker:f.worker})}));
  t.after(async()=>{await auth.stopEvents();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();});
  const session=await authenticatedSession(f.identity,'g05_account_admin');
  const headers={Cookie:`nb_v2_session=${session.token}`,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':'http-window-intent'};
  const post=(body,h=headers)=>fetch(origin+'/api/v2/sync-center/jobs',{method:'POST',headers:h,body:JSON.stringify(body)});
  const body={type:'battlemetrics_playtime',scope:{...scope,sourceContexts:{g05_alpha:{from:'2000-01-01',to:'2099-01-01'}},sourceWindowId:'fake-http-window'}};
  assert.equal((await post(body,{...headers,'X-CSRF-Token':'bad'})).status,403);assert.equal(f.rows().length,0);
  const response=await post(body);assert.equal(response.status,202);const created=(await response.json()).data;
  assert.equal(f.rows().length,1);f.advance(2000);assert.equal((await (await post(body)).json()).data.job.id,created.job.id);
  const coverage=await fetch(origin+'/api/v2/sync-center/coverage?type=battlemetrics_playtime&scope=current_wipe&id=fixture-wipe',{headers});
  assert.equal(coverage.status,200);assert.equal(coverage.headers.get('cache-control'),'no-store');assert.equal(f.rows().length,1);
  await f.worker.step();const detail=await (await fetch(origin+'/api/v2/sync-center/jobs/'+created.job.id,{headers})).json();
  assert.equal(detail.data.status,'succeeded');assert.equal(f.sources.store.profile(f.repo.get('members','g05_alpha')).battlemetricsServerPlayTimeSeconds,3600);
  const leader=await authenticatedSession(f.identity,'g05_account_leader');
  const denied=await post({type:'battlemetrics_playtime',scope:{kind:'members',memberIds:['g05_foreign']}},{...headers,Cookie:`nb_v2_session=${leader.token}`,'X-CSRF-Token':leader.csrfToken,'Idempotency-Key':'http-window-denied'});
  assert.equal(denied.status,403);assert.equal(f.rows().length,1);
});
