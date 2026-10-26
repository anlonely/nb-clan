import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import '../results.mjs';
import '../v2-source-main/offline.mjs';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'test/support/v2-provider-projection/.runtime');
if (process.argv[2] !== '--isolated-child') {
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(path.join(base, 'run-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
      cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai',
        SOURCE_MAIN_DEPENDENCY_ROOT: decodeURIComponent(new URL('../../../', import.meta.url).pathname), PROVIDER_PROJECTION_RUN: run,
        NB_DATA_DIR: path.join(run, 'data'), NB_SQLITE_FILE: path.join(run, 'data/nb-clan.sqlite'),
        NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_DISABLE_BACKGROUND_JOBS: '1',
        NB_DISABLE_DATA_BACKUP: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
        NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_ROOT_PASSWORD: randomBytes(32).toString('hex'),
        // Adjust the one real API queue for this short fixture; never replace/reset it.
        NB_BATTLEMETRICS_MIN_INTERVAL_MS: '0', NB_BATTLEMETRICS_REQUESTS_PER_MINUTE: '1000' } });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
    finally { clearTimeout(timeout); process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); }
    assert.equal(code, 0, 'isolated child failed');
    const report = JSON.parse(await readFile(path.join(run, 'report.json')));
    await rm(run, { recursive: true });
    report.cleanup.ownedRunRemoved = true;
    const output = path.join(root, 'output/test-results/g07-provider-projection/runtime-report.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Provider projection: ${report.checks.length} checks passed; ${output}`);
  } finally { await rm(run, { recursive: true, force: true }); }
} else {
  const run = process.env.PROVIDER_PROJECTION_RUN;
  assert.equal(path.dirname(run), base); assert.match(path.basename(run), /^run-[A-Za-z0-9]+$/);
  assert.equal(await realpath(run), run);
  assert.equal(process.env.NB_DATA_DIR, path.join(run, 'data'));
  assert.equal(process.env.NB_SQLITE_FILE, path.join(run, 'data/nb-clan.sqlite'));
  for (const flag of ['NB_V2_IDENTITY_ENABLED','NB_DISABLE_BACKGROUND_JOBS','NB_DISABLE_DATA_BACKUP','NB_DISABLE_EXTERNAL_VITAL','NB_DISABLE_EXTERNAL_ATLAS']) assert.equal(process.env[flag], '1');
  assert.equal(process.env.NB_STORAGE_MODE, 'sqlite-primary');
  assert.equal(process.env.NB_DISCORD_BOT_TOKEN, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.HTTPS_PROXY, undefined);
  await assert.rejects(access(process.env.NB_SQLITE_FILE), { code: 'ENOENT' });
  const { createServer } = await import('node:http');
  const { default: express } = await import('express');
  const store = await import('../../../server/store.js'), storage = await import('../../../server/storage/sqlite.js');
  const { installIdentitySchema, IdentityRepository } = await import('../../../server/v2/identity/repository.js');
  const { applyIdentityMigration, planIdentityMigration } = await import('../../../server/v2/identity/migration.js');
  const { installSchedulingSchema, SchedulingRepository } = await import('../../../server/v2/scheduling/repository.js');
  const { applySchedulingMigration, planSchedulingMigration } = await import('../../../server/v2/scheduling/migration.js');
  const { seedIdentities } = await import('../v2-member-space/fixtures.mjs');
  const { createManagementRuntime } = await import('../../../server/v2/management-runtime/index.js');
  await store.ensureStore();
  const db = await storage.openSqliteDatabase(), legacy = await store.readStore();
  assert.equal(legacy.members.length, 0);
  installIdentitySchema(db); const repo = new IdentityRepository(db);
  applyIdentityMigration(repo, planIdentityMigration(legacy)); seedIdentities(repo);
  installSchedulingSchema(db); applySchedulingMigration(new SchedulingRepository(db), planSchedulingMigration({}));
  for (const [module, install] of [
    ['member-admin/repository.js','installMemberAdminSchema'], ['stats/repository.js','installStatsSchema'],
    ['sync-center/repository.js','installSyncCenterSchema'], ['realtime/repository.js','installRealtimeSchema'],
    ['platform-admin/repository.js','installPlatformAdminSchema'], ['management-adapters/sources/index.js','installSourceAdapterSchema'],
    ['management-adapters/source-window/index.js','installSourceWindowSchema']
  ]) (await import(`../../../server/v2/${module}`))[install](db);
  (await import('../../../server/v2/system-admin/repository.js')).migrateSystemAdmin(db, { apply: true });
  const { upstream, sid:steamId, other } = await import('./upstream.mjs');
  const { createProviderTransport, createInventoryEnrichment, createMooseEngine, createProviderBindings } = await import('../../../server/v2/source-providers/index.js');
  const memberId='g05_alpha', fakeKey='explicit-isolated-provider-projection-key';
  repo.setScalar('settings',{...repo.scalar('settings'),steamWebApi:{apiKey:fakeKey},accountRisk:{revision:1,rules:[{id:'inventory',type:'inventory_value',enabled:true,threshold:10,operator:'gt'},{id:'restriction',type:'account_restricted',enabled:false},{id:'ban',type:'steam_ban_or_restriction',enabled:false}]},system:{proxy:{}}});
  const u=await upstream(), configuration={enabled:true,revision:1,prices:true,rusthelp:true};
  const transport=createProviderTransport({readConfiguration:()=>configuration,fetchImpl:fetch,origins:Object.fromEntries(['moose','scmm','rusthelp'].map(k=>[k,u.origin])),allowLoopbackForTests:true,timeoutMs:15000});
  const enrichment=createInventoryEnrichment({transport,readConfiguration:()=>configuration});
  let mutateResult=null, gate=null;
  const inventoryEnrichment=async(input,options)=>{const result=await enrichment(input,options);if(gate){const held=gate;gate=null;held.entered();await held.wait;}return mutateResult?mutateResult(result):result;};
  Object.defineProperty(inventoryEnrichment,'requiresProviderProjection',{value:true});
  const mooseEngine=createMooseEngine({transport,executablePath:chromiumExecutablePath()});
  const readProviderBindings=createProviderBindings({readConfiguration:()=>configuration});
  const checks=[],report={boundary:'Real main HTTP, G03 auth/CSRF, original Stats query/export and MemberAdmin single worker; constructed loopback HTTP/SignalR upstream, isolated SQLite/Chromium only',checks,cleanup:{}};
  const check=(name,data={})=>checks.push({name,passed:true,...data});
  const app=express(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;process.env.NB_V2_PUBLIC_ORIGIN=origin;
  let api,system,stopBackgroundJobs,globalWrite,sharedQueue;
  const bounded=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout: '+label)),25000);})]);}finally{clearTimeout(timer);}};
  try{
    const main=await import('../../../server/api.js');stopBackgroundJobs=main.stopBackgroundJobs;
    api=main.createApiRouter({managementRuntimeFactory:deps=>{globalWrite=deps.runStoreWriteTask;sharedQueue=deps.sharedBattlemetricsQueue;assert.equal(globalWrite,store.runStoreWriteTask);return createManagementRuntime({...deps,intervalMs:60000,
      memberOptions:()=>({invalidatePlatformSessions:()=>{throw new Error('isolated fixture has no platform sessions');}}),
      sourceHostOptions:()=>({fetchImpl:fetch,timeoutMs:15000,maxBytes:2097152,allowLoopbackForTests:true,capabilities:{memberRisk:true,steam:true,inventory:true,inventoryEnrichment:true,dlcCatalog:true,moose:true},origins:Object.fromEntries(['moose','steam','community','store'].map(k=>[k,u.origin])),inventoryEnrichment,mooseEngine,readProviderBindings})});}});
    app.use('/api',api);const identity=await api.v2Runtime.getIdentity();await api.v2Runtime.start();system=api.v2Runtime.management.getSystem(identity);assert.equal(system.sourceHost.battlemetricsQueue,sharedQueue);
    const login=await fetch(`${origin}/api/v2/auth/password`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'root',password:process.env.NB_ROOT_PASSWORD})});const logged=await login.json();assert.equal(login.status,200,JSON.stringify(logged));
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),csrf=logged.data.csrfToken;
    const request=async(route,body,{status=200,omitCsrf=false,key=randomUUID()}={})=>{const response=await fetch(`${origin}/api/v2${route}`,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,...(!omitCsrf?{'X-CSRF-Token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.equal(response.status,status,`${route}: ${JSON.stringify(result)}`);return result.data||result;};
    const tick=()=>bounded(api.v2Runtime.management.tick(),'single worker');
    async function query(mode,sourceId='inventory'){u.mode=mode;const queued=await request('/stats/queries',{sourceId,steamInput:steamId,...(sourceId==='moose'?{serverId:'eu-main',providerWipeId:'September 2026',categoryIds:['pvp','resources']}:{})});await tick();const result=await request(`/stats/jobs/${queued.jobId}`);return {...result,jobId:queued.jobId};}
    const profile=()=>{const row=db.prepare("SELECT payload_json FROM json_records WHERE collection='memberProfiles' AND json_extract(payload_json,'$.memberId')=?").get(memberId);return row?JSON.parse(row.payload_json):null;};
    const canonical=()=>JSON.stringify(profile()),receipts=()=>db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n;
    const enqueue=()=>request('/member-admin/sync/request',{kind:'memberProfiles',memberIds:[memberId]});
    const detail=j=>request(`/sync-center/jobs/${j.id}`);
    async function risk(mode){u.mode=mode;const queued=(await enqueue()).job;await tick();const end=await detail(queued);assert.equal(end.status,'succeeded',JSON.stringify(end));return profile();}
    await request('/stats/queries',{sourceId:'inventory',steamInput:steamId},{status:403,omitCsrf:true});assert.equal(u.calls.length,0);
    const aggregated=await query('aggregate');assert.equal(aggregated.status,'succeeded',JSON.stringify(aggregated));
    const a=aggregated.result;assert.equal(a.inventory.total,8);assert.equal(a.inventory.currency,'USD');assert.equal(a.status,'partial');assert.equal(a.inventory.status,'partial');assert.ok(a.inventory.items.filter(i=>i.category==='skins').every(i=>i.price===null));assert.equal(a.providerEvidence.valuation.sourceId,'rusthelp-summary');assert.equal(a.providerEvidence.steamId,steamId);assert.match(a.providerEvidence.scopeHash,/^[a-f0-9]{64}$/);assert.equal(a.providerEvidence.totalItems,3);assert.equal(a.providerEvidence.pricedItems,0);assert.equal(a.providerEvidence.status,'partial');assert.ok(!JSON.stringify(a).includes('SHOULD_NOT_REACH_DTO'));
    report.aggregate=a;check('actual-HTTP-persisted-aggregate-keeps-item-prices-unknown-and-partial',{jobId:aggregated.jobId});
    const exported=await request('/stats/exports',{queryJobId:aggregated.jobId,format:'json'});await tick();assert.equal((await request(`/stats/jobs/${exported.jobId}`)).status,'succeeded');
    const fileRoute=`/stats/jobs/${exported.jobId}/file`,file=await fetch(`${origin}/api/v2${fileRoute}`,{headers:{Cookie:cookie,Origin:origin}});assert.equal(file.status,200);const json=await file.json();assert.deepEqual(json.queryResult,a);
    for(const route of [`/stats/jobs/${aggregated.jobId}`,fileRoute])assert.equal((await fetch(`${origin}/api/v2${route}`)).status,401);
    await request('/stats/exports',{queryJobId:aggregated.jobId,format:'json'},{status:403,omitCsrf:true});check('original-query-and-export-auth-CSRF-JSON-file-retains-closed-evidence');
    const zero=await query('aggregateZero');assert.equal(zero.status,'succeeded');assert.equal(zero.result.inventory.total,0);assert.equal(zero.result.providerEvidence.valuation.kind,'aggregate');check('zero-aggregate-persists-without-fake-per-item-zero');
    const full=await query('ok');assert.equal(full.status,'succeeded',JSON.stringify(full));assert.equal(full.result.inventory.total,6);assert.equal(full.result.providerEvidence.valuation.kind,'item_prices');assert.equal(full.result.inventory.items[0].price,2.5);assert.equal(full.result.inventory.items[0].priceEvidence.sourceId,'scmm-profile-items');assert.equal(full.result.inventory.items.find(i=>i.category==='dlc').quantity,null);report.itemPrices=full.result;check('per-item-price-proof-and-existing-DLC-unknown-survive-second-projection');
    for(const mode of ['aggregateWrongId','aggregateWrongCount','aggregateCurrency','aggregateFuture']){const r=await query(mode);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.result.inventory.total,null);assert.equal(r.result.status,'partial');assert.equal(r.result.providerEvidence.valuation.kind,'unknown');check(mode+'-cannot-become-an-amount');}
    const expired=await query('aggregateExpired');assert.equal(expired.status,'failed',JSON.stringify(expired));check('expired-aggregate-fails-original-query-job');
    const privateQuery=await query('private');assert.equal(privateQuery.result.status,'private');assert.equal(privateQuery.result.inventory.total,null);assert.equal(privateQuery.result.providerEvidence.status,'private');check('private-inventory-never-claims-aggregate-or-full-coverage');
    const moose=await query('ok','moose');assert.equal(moose.status,'succeeded',JSON.stringify(moose));assert.equal(moose.result.fields[0].value,'12');const m=moose.result.providerEvidence;assert.equal(m.sourceId,'moose');assert.equal(m.steamId,steamId);assert.equal(m.serverId,'eu-main');assert.equal(m.periodName,'September 2026');assert.deepEqual(m.categoryIds,['pvp','resources']);assert.equal(m.quality,'complete');assert.ok(Date.parse(m.observedAt));assert.ok(!JSON.stringify(m).includes('127.0.0.1'));report.moose=moose.result;check('real-Chromium-SignalR-Moose-scope-evidence-through-original-Stats-persistence');
    for(const [name,mutate] of [['clone',r=>structuredClone(r)],['tamper-scope',r=>{r.evidence.scopeHash='0'.repeat(64);return r;}]]){mutateResult=mutate;const r=await query('aggregate');assert.equal(r.status,'failed',JSON.stringify(r));check(name+'-cannot-fall-back-to-legacy');}mutateResult=null;
    await request('/sync-center/sources/steam',{expectedRevision:1,minIntervalMs:0,maxAttempts:1,timeoutMs:15000});
    const p8=await risk('aggregate');assert.equal(p8.inventoryValue,8);assert.equal(p8.inventoryCurrency,'USD');assert.equal(p8.riskScan.sources.inventory.status,'observed');report.riskAggregate=p8;check('original-MemberAdmin-worker-canonical-risk-aggregate-writeback');
    const p0=await risk('aggregateZero');assert.equal(p0.inventoryValue,0);const observed=p0.riskScan.fields.inventoryValue.observedAt;assert.ok(observed);check('risk-zero-aggregate-persists');
    for(const mode of ['aggregateWrongId','aggregateWrongCount','aggregateCurrency','aggregateExpired','aggregateFuture']){const p=await risk(mode);assert.equal(p.inventoryValue,0);assert.equal(p.riskScan.fields.inventoryValue.observedAt,observed);assert.equal(p.riskScan.sources.inventory.status,'partial');check('risk-'+mode+'-preserves-old-value-and-observation');}
    // Pause only the already produced new reader result; original commit fences must re-read configuration/identity.
    async function race(name,act,restore){u.mode='aggregate';const before=canonical(),count=receipts();let entered,release;const arrived=new Promise(r=>entered=r),wait=new Promise(r=>release=r);gate={entered,wait};const queued=(await enqueue()).job,work=tick();try{await bounded(arrived,name+' arrival');await act();}finally{release();}await work;assert.equal(canonical(),before);assert.equal(receipts(),count);const end=await detail(queued);assert.notEqual(end.status,'succeeded',JSON.stringify(end));await restore();check(name,{status:end.status});}
    await race('provider-config-changed-after-reader-return-before-risk-commit',async()=>{configuration.revision++;},async()=>{configuration.revision--;});
    const memberBefore=repo.get('members',memberId);
    await race('canonical-Steam-drift-after-reader-return-before-risk-commit',()=>globalWrite(async()=>repo.put('members',{...memberBefore,steamId:other,revision:memberBefore.revision+1})),()=>globalWrite(async()=>repo.put('members',memberBefore)));
    const last=await risk('price429');assert.equal(last.inventoryValue,0);assert.equal(last.riskScan.fields.inventoryValue.observedAt,observed);assert.equal(last.riskScan.sources.inventory.error,'RATE_LIMITED');const source=system.service.repo.get('source','steam');assert.ok(source.nextAllowedAt>Date.now(),JSON.stringify(source));report.rateLimit={inventory:last.riskScan.sources.inventory,steamSource:source};check('price-429-preserves-public-fact-old-value-and-durable-steam-cooldown');
    assert.equal(u.stats.activeSockets,0);assert.equal(transport.active,0);assert.equal(system.sourceHost.battlemetricsQueue,sharedQueue);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');report.requests=u.calls;report.protocol=u.stats;report.cleanup.integrity='ok';
  }finally{
    await api?.v2Runtime.stop();stopBackgroundJobs?.();await transport.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await u.close();await store.drainStoreWrites();await storage.closeSqliteDatabases();
    report.cleanup={...report.cleanup,mainRuntimeStopped:api?.v2Runtime.management.diagnostics().stopped===true,sourceActiveIO:system?.sourceHost.activeIO,providerSessions:transport.active,upstreamSockets:u.stats.activeSockets,mainHttpClosed:!server.listening,sqliteClosed:true};
  }
  await writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');
}
