import '../results.mjs';
import './offline.mjs';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'test/support/v2-source-main/.runtime');
if (process.argv[2] !== '--isolated-child') {
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(path.join(base, 'run-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
      cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai',
        SOURCE_MAIN_DEPENDENCY_ROOT: decodeURIComponent(new URL('../../../', import.meta.url).pathname), SOURCE_MAIN_RUN: run,
        NB_DATA_DIR: path.join(run, 'data'), NB_SQLITE_FILE: path.join(run, 'data/nb-clan.sqlite'),
        NB_OWNER_PASSWORD_LOGIN: '1', NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_DISABLE_BACKGROUND_JOBS: '1',
        NB_DISABLE_DATA_BACKUP: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
        NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_ROOT_PASSWORD: randomBytes(32).toString('hex'),
        // Adjust the one real API queue for this short fixture; never replace/reset it.
        NB_BATTLEMETRICS_MIN_INTERVAL_MS: '0', NB_BATTLEMETRICS_REQUESTS_PER_MINUTE: '1000' } });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); }); }
    finally { clearTimeout(timeout); process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); }
    assert.equal(code, 0, 'isolated child failed');
    const report = JSON.parse(await readFile(path.join(run, 'report.json')));
    await rm(run, { recursive: true });
    report.cleanup.ownedRunRemoved = true;
    const output = path.join(root, 'output/test-results/g07-source-main/runtime-report.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Source main: ${report.checks.length} checks passed; ${output}`);
  } finally { await rm(run, { recursive: true, force: true }); }
} else {
  const run = process.env.SOURCE_MAIN_RUN;
  assert.equal(path.dirname(run), base); assert.match(path.basename(run), /^run-[A-Za-z0-9]+$/);
  assert.equal(await realpath(run), run);
  assert.equal(process.env.NB_DATA_DIR, path.join(run, 'data'));
  assert.equal(process.env.NB_SQLITE_FILE, path.join(run, 'data/nb-clan.sqlite'));
  for (const flag of ['NB_V2_IDENTITY_ENABLED','NB_DISABLE_BACKGROUND_JOBS','NB_DISABLE_DATA_BACKUP','NB_DISABLE_EXTERNAL_VITAL','NB_DISABLE_EXTERNAL_ATLAS']) assert.equal(process.env[flag], '1');
  assert.equal(process.env.NB_STORAGE_MODE, 'sqlite-primary');
  assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.HTTPS_PROXY, undefined);
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
  applyIdentityMigration(repo, planIdentityMigration(legacy));
  repo.setScalar('v2InstallationOwner', { version: 1, accountId: 'user_root' }); seedIdentities(repo);
  installSchedulingSchema(db); applySchedulingMigration(new SchedulingRepository(db), planSchedulingMigration({}));
  for (const [module, install] of [
    ['member-admin/repository.js','installMemberAdminSchema'], ['stats/repository.js','installStatsSchema'],
    ['sync-center/repository.js','installSyncCenterSchema'], ['realtime/repository.js','installRealtimeSchema'],
    ['platform-admin/repository.js','installPlatformAdminSchema'], ['management-adapters/sources/index.js','installSourceAdapterSchema'],
    ['management-adapters/source-window/index.js','installSourceWindowSchema']
  ]) (await import(`../../../server/v2/${module}`))[install](db);
  (await import('../../../server/v2/system-admin/repository.js')).migrateSystemAdmin(db, { apply: true });
  const fakeKey = 'explicit-isolated-fake-battlemetrics-key';
  repo.setScalar('settings', { ...repo.scalar('settings'), battlemetrics: { apiKey: fakeKey }, steamWebApi: { apiKey: fakeKey }, system: { proxy: {} } });
  const t0 = Math.floor((Date.now() - 3600000) / 1000) * 1000;
  const iso = seconds => new Date(t0 + seconds * 1000).toISOString();
  const upstreamRequests = [], checks = [], report = { boundary: 'actual main HTTP, constructed loopback BM JSON; no external BM evidence', checks, upstreamRequests, cleanup: {} };
  let gate, sharedQueue, system, api, stopBackgroundJobs;
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const bounded = async (promise, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 10000); })]); } finally { clearTimeout(timer); } };
  const session = (id, start, stop, server = '731') => ({ id, type: 'session', attributes: { start: iso(start), stop: stop === null ? null : iso(stop) }, relationships: { server: { data: { type: 'server', id: server } } } });
  const upstream = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const entry = { method: req.method, path: u.pathname, query: Object.fromEntries([...u.searchParams].filter(([key]) => key !== 'key')), credentialMatched: u.pathname.startsWith('/players') ? req.headers.authorization === `Bearer ${fakeKey}` : u.searchParams.get('key') === fakeKey };
      upstreamRequests.push(entry); assert.equal(entry.credentialMatched, true);
      let payload;
      if (u.pathname === '/ISteamUser/GetPlayerSummaries/v0002/') {
        assert.equal(u.searchParams.get('steamids'), '76561198000000501');
        payload = { response: { players: [{ steamid: '76561198000000501', personaname: 'Isolated source member', communityvisibilitystate: 3 }] } };
      } else if (u.pathname === '/ISteamUserStats/GetUserStatsForGame/v0002/') {
        assert.equal(u.searchParams.get('steamid'), '76561198000000501');
        payload = { playerstats: { steamID: '76561198000000501', stats: [{ name: 'kill_player', value: 7 }] } };
      } else if (u.pathname === '/IPlayerService/GetOwnedGames/v0001/') {
        payload = { response: { games: [] } }; // Missing Rust is unknown, never zero.
      } else if (u.pathname === '/players/match') {
        assert.equal(req.method, 'POST'); let raw = ''; for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw); assert.equal(input.data[0].attributes.identifier, '76561198000000501');
        payload = { data: [{ type: 'identifier', attributes: { type: 'steamID', identifier: '76561198000000501' }, relationships: { player: { data: { type: 'player', id: '601' } } } }] };
      } else {
        assert.equal(u.pathname, '/players/601/relationships/sessions'); assert.equal(req.method, 'GET');
        assert.equal(u.searchParams.get('filter[servers]'), '731');
        if (gate) { const current = gate; gate = null; current.entered.resolve(); await current.release.promise; }
        const page2 = u.searchParams.get('page[key]') === 'second';
        payload = page2 ? { data: [session('overlap', 500, 900), session('open', 3000, null), session('wrong-server', -1000, 9000, '999')], links: { next: null } }
          : { data: [session('middle', 1200, 1800), session('clipped', -300, 600), session('future', 8000, 8100)],
              links: { next: 'https://api.battlemetrics.com/players/601/relationships/sessions?page[size]=100&filter[servers]=731&page[key]=second' } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload));
    } catch (error) { report.upstreamError = error.message; res.writeHead(500); res.end('{}'); }
  });
  const app = express(), server = createServer(app);
  const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const close = async s => { s.closeAllConnections(); await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve())); };
  await listen(upstream); await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.NB_V2_PUBLIC_ORIGIN = origin;
  try {
    const main = await import('../../../server/api.js'); stopBackgroundJobs = main.stopBackgroundJobs;
    api = main.createApiRouter({ managementRuntimeFactory: deps => {
      sharedQueue = deps.sharedBattlemetricsQueue;
      return createManagementRuntime({ ...deps, intervalMs: 60000,
        sourceHostOptions: () => ({ fetchImpl: fetch, capabilities: { battlemetrics: true, steam: true }, allowLoopbackForTests: true,
          origins: { battlemetrics: `http://127.0.0.1:${upstream.address().port}`, steam: `http://127.0.0.1:${upstream.address().port}` } }) });
    } });
    app.use('/api', api);
    const identity = await api.v2Runtime.getIdentity();
    await api.v2Runtime.start(); system = api.v2Runtime.management.getSystem(identity);
    assert.equal(system.sourceHost.battlemetricsQueue, sharedQueue);
    assert.equal(sharedQueue.snapshot().limits.minIntervalMs, 0);
    const login = await fetch(`${origin}/api/v2/auth/owner-password`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: process.env.NB_ROOT_PASSWORD }) });
    const logged = await login.json(); assert.equal(login.status, 200, JSON.stringify(logged));
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf = logged.data.csrfToken;
    assert.ok(cookie && csrf); checks.push({ name: 'real-G03-password-cookie-CSRF', passed: true });
    const request = async (route, body, { method = body === undefined ? 'GET' : 'POST', key = randomUUID(), status = 200, omitCsrf = false } = {}) => {
      const response = await fetch(`${origin}/api/v2${route}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(omitCsrf ? {} : { 'X-CSRF-Token': csrf }), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`); return value.data || value;
    };
    let wipe = (await request('/wipes', { title: '来源主入口隔离档', serverProfileId: 'isolated-bm-server', serverSnapshot: { battlemetricsId: '731' },
      audience: { memberIds: ['g05_alpha'], squadIds: [], includeUnassigned: false }, timeZone: 'Asia/Shanghai', musterAt: iso(-600), signupOpensAt: iso(-3600), signupClosesAt: iso(7200) }, { status: 201 })).current;
    for (const [command, fields] of [['publish', {}], ['start', { startMode: 'manual' }], ['confirm-server-start', { serverActualWipeAt: iso(0), serverStartEvidence: 'explicit local historical fixture' }]]) {
      wipe = (await request(`/wipes/${wipe.id}/commands/${command}`, { expectedRevision: wipe.revision, ...fields })).current;
    }
    assert.equal(wipe.lifecycle, 'active'); assert.equal(wipe.serverActualWipeAt, iso(0));
    checks.push({ name: 'real-HTTP-create-publish-start-confirm-past-server-start', passed: true, wipeId: wipe.id });
    await request('/sync-center/sources/battlemetrics', { expectedRevision: 1, minIntervalMs: 0, maxAttempts: 1, timeoutMs: 15000 });
    const windows = () => db.prepare('SELECT * FROM v2_source_windows ORDER BY created_at,job_id').all();
    const profile = () => db.prepare("SELECT payload_json FROM json_records WHERE collection='memberProfiles'").all().map(row => JSON.parse(row.payload_json)).find(p => p.memberId === 'g05_alpha' || p.steamId === '76561198000000501');
    const canonical = () => structuredClone({ member: repo.get('members', 'g05_alpha'), profile: profile() });
    const input = type => ({ type, scope: { kind: 'members', memberIds: ['g05_alpha'], wipeId: wipe.id } });
    const enqueue = (type, key) => request('/sync-center/jobs', input(type), { status: 202, ...(key ? { key } : {}) });
    const detail = job => request(`/sync-center/jobs/${job.id}`);
    const tick = () => bounded(api.v2Runtime.management.tick(), 'management worker');
    const before = canonical();
    const coverage = await request(`/sync-center/coverage?type=battlemetrics_playtime&scope=current_wipe&id=${wipe.id}`);
    assert.equal(coverage.quality, 'unknown'); assert.equal(coverage.coverage.matched, 0);
    await request('/sync-center/sources'); await request('/sync-center/jobs');
    assert.equal(windows().length, 0); assert.deepEqual(canonical(), before); assert.equal(upstreamRequests.length, 0);
    checks.push({ name: 'GET-coverage-unknown-no-window-or-canonical-write', passed: true });
    await request('/sync-center/jobs', input('battlemetrics_playtime'), { status: 403, omitCsrf: true });
    assert.equal(windows().length, 0);
    const mapping = (await enqueue('battlemetrics_identity')).job; await tick();
    const mappingDone = await detail(mapping); assert.equal(mappingDone.status, 'succeeded', JSON.stringify(mappingDone));
    assert.equal(repo.get('members', 'g05_alpha').battlemetricsId, '601'); assert.equal(windows().length, 0);
    checks.push({ name: 'main-HTTP-identity-real-match-parser-canonical-write', passed: true, jobId: mapping.id });
    const key = randomUUID(), first = await enqueue('battlemetrics_playtime', key);
    const window = windows()[0]; assert.ok(Date.parse(window.to_at) <= Date.now()); assert.ok(Date.parse(window.to_at) >= t0 + 3600000); assert.equal(window.job_id, first.job.id); assert.equal(window.from_at, iso(0));
    const replay = await enqueue('battlemetrics_playtime', key), dedup = await enqueue('battlemetrics_playtime');
    assert.equal(replay.job.id, first.job.id); assert.equal(dedup.job.id, first.job.id); assert.equal(dedup.deduplicated, true);
    assert.equal(windows().length, 1); assert.deepEqual(windows()[0], window);
    await request(`/sync-center/coverage?type=battlemetrics_playtime&scope=current_wipe&id=${wipe.id}`);
    assert.deepEqual(windows()[0], window);
    await tick(); const done = await detail(first.job); assert.equal(done.status, 'succeeded', JSON.stringify(done));
    const expectedSeconds = 1500 + Math.floor((Date.parse(window.to_at) - (t0 + 3000000)) / 1000);
    assert.equal(profile().battlemetricsServerPlayTimeSeconds, expectedSeconds);
    assert.equal(profile().battlemetricsRangeStartAt, window.from_at); assert.equal(profile().battlemetricsRangeStopAt, window.to_at);
    assert.equal(profile().battlemetricsWipeId, wipe.id); assert.equal(profile().battlemetricsServerId, '731');
    assert.equal(profile().sourceObservations.battlemetrics_playtime.context.to, window.to_at);
    checks.push({ name: 'POST-fixed-window-key-replay-active-dedup-pagination-overlap-clipping-open-session-canonical', passed: true,
      jobId: first.job.id, window: { from: window.from_at, to: window.to_at }, seconds: expectedSeconds, profileId: profile().id });
    const receipt = db.prepare('SELECT operation_id,result FROM v2_source_adapter_receipts WHERE operation_id=?').get(`sync-item:${first.job.id}:g05_alpha`);
    assert.ok(receipt); assert.equal(JSON.parse(receipt.result).memberId, 'g05_alpha');
    assert.equal(db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 0);
    const cached = await store.readStore();
    assert.deepEqual(cached.memberProfiles.find(row => row.id === profile().id), profile());
    report.successReceipt = { operationId: receipt.operation_id, memberId: JSON.parse(receipt.result).memberId };
    report.successProfile = structuredClone(profile());
    const canonicalBeforeQuery = canonical(), windowsBeforeQuery = windows();
    const query = await request('/stats/queries', { sourceId: 'official', steamInput: '76561198000000501' });
    await tick(); const queryDone = await request(`/stats/jobs/${query.jobId}`);
    assert.equal(queryDone.status, 'succeeded', JSON.stringify(queryDone));
    const queryRow = queryDone.result.rows[0];
    assert.equal(queryRow.values.kills, 7); assert.equal(queryRow.values.deaths, null); assert.equal(queryRow.values.steamTotalSeconds, null);
    assert.equal(queryRow.reasons.deaths, 'not_observed'); assert.equal(queryRow.reasons.steamTotalSeconds, 'not_observed');
    assert.equal(queryRow.capabilities.deaths, false); assert.equal(queryRow.values.kd, null);
    assert.deepEqual(canonical(), canonicalBeforeQuery); assert.deepEqual(windows(), windowsBeforeQuery);
    checks.push({ name: 'real-HTTP-stats-query-source-reader-missing-fields-unknown-read-only', passed: true,
      jobId: query.jobId, kills: queryRow.values.kills, deaths: queryRow.values.deaths, steamTotalSeconds: queryRow.values.steamTotalSeconds });
    async function inFlight(name, act) {
      const job = (await enqueue('battlemetrics_playtime')).job, prior = canonical();
      const receiptsBefore = db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n;
      const held = { entered: deferred(), release: deferred() }; gate = held;
      const work = tick();
      try { await bounded(held.entered.promise, `${name} upstream arrival`); await act(job); }
      finally { held.release.resolve(); }
      await work;
      assert.deepEqual(canonical(), prior, `${name} must not write canonical profile/member`);
      assert.equal(db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n, receiptsBefore);
      const end = await detail(job); assert.notEqual(end.status, 'succeeded');
      checks.push({ name, passed: true, jobId: job.id, finalStatus: end.status, reason: end.items[0]?.reason });
      return end;
    }
    const cancelled = await inFlight('in-flight-cancel-no-canonical-write', async job => {
      const active = await detail(job); assert.equal(active.status, 'running');
      await request(`/sync-center/jobs/${job.id}/commands/cancel`, { expectedRevision: active.revision });
    }); assert.equal(cancelled.status, 'cancelled');
    await inFlight('in-flight-real-HTTP-server-config-change-no-canonical-write', async () => {
      wipe = (await request(`/wipes/${wipe.id}`, { expectedRevision: wipe.revision, serverSnapshot: { battlemetricsId: '732' }, majorChange: true, reason: 'isolated configuration fence' }, { method: 'PATCH' })).current;
    });
    wipe = (await request(`/wipes/${wipe.id}`, { expectedRevision: wipe.revision, serverSnapshot: { battlemetricsId: '731' }, majorChange: true, reason: 'restore isolated fixture for stop' }, { method: 'PATCH' })).current;
    const stopJob = (await enqueue('battlemetrics_playtime')).job, beforeStop = canonical();
    const held = { entered: deferred(), release: deferred() }; gate = held;
    const work = tick();
    try {
      await bounded(held.entered.promise, 'stop upstream arrival');
      const stopping = api.v2Runtime.stop(); held.release.resolve(); await bounded(stopping, 'main runtime stop'); await work;
    } finally { held.release.resolve(); }
    assert.deepEqual(canonical(), beforeStop); assert.equal(system.sourceHost.activeIO, 0);
    assert.equal(api.v2Runtime.management.diagnostics().stopped, true);
    // Same queue sentinel proves all earlier queued network work has drained; no provider substitute.
    await bounded(sharedQueue.enqueue({ meta: { source: 'system', priority: -100, operation: 'source_main_drain', label: 'isolated drain sentinel' }, run: async () => null }), 'BM queue drain');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sharedQueue.snapshot().running, false); assert.equal(sharedQueue.snapshot().pendingCount, 0);
    assert.equal(sharedQueue.snapshot().lastCompleted.operation, 'source_main_drain');
    checks.push({ name: 'stop-in-flight-no-write-drained-real-shared-queue', passed: true, jobId: stopJob.id });
    assert.equal(sharedQueue.snapshot().totals.completed + sharedQueue.snapshot().totals.failed, upstreamRequests.filter(row => row.path.startsWith('/players')).length + 1);
    checks.push({ name: 'one-existing-global-BM-queue-one-task-per-page-plus-drain-sentinel', passed: true });
    report.queue = sharedQueue.snapshot(); report.windows = windows().map(w => ({ jobId: w.job_id, intentId: w.intent_id, from: w.from_at, to: w.to_at, serverId: w.battlemetrics_server_id }));
    assert.equal(report.upstreamError, undefined);
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    report.cleanup.integrity = 'ok';
  } finally {
    gate?.release.resolve(); await api?.v2Runtime.stop(); stopBackgroundJobs?.();
    await close(server); await close(upstream); await store.drainStoreWrites(); await storage.closeSqliteDatabases();
    report.cleanup = { ...report.cleanup, mainRuntimeStopped: api?.v2Runtime.management.diagnostics().stopped === true,
      mainHttpClosed: !server.listening, upstreamClosed: !upstream.listening, sourceActiveIO: system?.sourceHost.activeIO, sqliteClosed: true };
  }
  await writeFile(path.join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
