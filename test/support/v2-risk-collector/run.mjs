import '../results.mjs';
import '../v2-source-main/offline.mjs';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'test/support/v2-risk-collector/.runtime');
if (process.argv[2] !== '--isolated-child') {
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(path.join(base, 'run-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
      cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai',
        SOURCE_MAIN_DEPENDENCY_ROOT: decodeURIComponent(new URL('../../../', import.meta.url).pathname), RISK_COLLECTOR_RUN: run,
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
    const output = path.join(root, 'output/test-results/g07-risk-collector/runtime-report.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Risk collector: ${report.checks.length} checks passed; ${output}`);
  } finally { await rm(run, { recursive: true, force: true }); }
} else {
  const run = process.env.RISK_COLLECTOR_RUN;
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
  const fakeKey = 'explicit-isolated-fake-risk-source-key';
  const memberId = 'g05_alpha', steamId = '76561198000000501', playerId = '601', bmServer = '731';
  const { defaultRules } = await import('../../../server/v2/member-admin/risk.js');
  const { upsertSqliteCollectionRecord } = await import('../../../server/storage/sqlite-migrate.js');
  const extraRules = ['kills','deaths','kd','rockets'].map(type => ({ id: `risk-${type}`, name: type, type, operator: 'gt', threshold: 5, enabled: true, squadFilter: '' }));
  repo.put('members', { ...repo.get('members', memberId), battlemetricsId: playerId });
  repo.setScalar('settings', { ...repo.scalar('settings'), steamWebApi: { apiKey: fakeKey }, battlemetrics: { apiKey: fakeKey },
    accountRisk: { revision: 1, rules: [...defaultRules(), ...extraRules] }, system: { proxy: {} } });
  const readSettings = () => repo.scalar('settings');
  const initialProfiles = db.prepare("SELECT count(*) n FROM json_records WHERE collection='memberProfiles'").get().n; assert.equal(initialProfiles, 0);
  const checks = [], requests = [], report = { boundary: 'Only constructed loopback sources, actual main HTTP/G03/MemberAdmin/single worker/canonical risk projection', checks, requests, cleanup: {} };
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const bounded = async (promise, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 10000); })]); } finally { clearTimeout(timer); } };
  const t0 = Date.now() - 30 * 86400000, iso = days => new Date(t0 + days * 86400000).toISOString();
  let mode = 'complete', gate, api, system, stopBackgroundJobs, globalWrite, sharedQueue;
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1'); const heldMode = mode;
    const source = u.pathname.startsWith('/players') ? 'battlemetrics' : /^\/(?:ISteam|IPlayer)/.test(u.pathname) ? 'steam' : 'community';
    requests.push({ path: u.pathname, method: req.method, source, credentialMatched: source === 'steam' ? u.searchParams.get('key') === fakeKey : source === 'battlemetrics' ? req.headers.authorization === `Bearer ${fakeKey}` : !req.headers.authorization && !u.searchParams.has('key') });
    if (gate && u.pathname.includes('GetPlayerBans')) { const held = gate; gate = null; held.entered.resolve(); await held.release.promise; }
    let status = 200, payload;
    if (heldMode === 'allFail') { status = 503; payload = { error: fakeKey }; }
    else if (u.pathname.includes('GetPlayerSummaries')) payload = { response: { players: [{ steamid: steamId, personaname: '风险隔离成员', avatarfull: 'https://avatars.steamstatic.com/fixture.jpg', communityvisibilitystate: 3 }] } };
    else if (u.pathname.includes('GetOwnedGames')) payload = { response: { games: heldMode === 'missingFields' ? [] : [{ appid: 252490, playtime_forever: heldMode === 'zero' ? 0 : 120 }] } };
    else if (u.pathname.includes('GetPlayerBans')) {
      if (heldMode === 'partial' || heldMode === 'private') { status = 503; payload = { error: fakeKey }; }
      else if (heldMode === 'ban429') { status = 429; payload = {}; }
      else if (heldMode === 'timeout') { res.on('close', () => {}); return; }
      else payload = { players: [{ SteamId: heldMode === 'wrongIdentity' ? '76561198000000509' : steamId, VACBanned: heldMode !== 'zero', CommunityBanned: heldMode !== 'zero', NumberOfVACBans: heldMode === 'zero' ? 0 : 2, NumberOfGameBans: 0, DaysSinceLastBan: 10, EconomyBan: heldMode === 'zero' ? 'none' : 'banned' }] };
      if (heldMode === 'missingFields') delete payload.players[0].CommunityBanned;
    } else if (u.pathname === '/broadcast/getbroadcastmpd/') payload = { success: heldMode === 'partial' || heldMode === 'private' ? 'unavailable' : heldMode === 'zero' ? 'ready' : 'user_restricted', retry: 0, eresult: 1 };
    else if (u.pathname.startsWith('/inventory/')) {
      payload = { success: 1, assets: [{ assetid: '11', classid: '12', instanceid: '0', amount: '1' }], descriptions: [{ classid: '12', instanceid: '0', market_hash_name: 'Observed skin', tradable: 1, marketable: 1 }] };
      if (heldMode === 'private') payload = { success: 0, error: 'This profile is private.' };
      if (heldMode === 'inventory403') { status = 403; payload = { error: fakeKey }; }
    } else if (u.pathname.startsWith('/api/inventory/')) { payload = { steamId, prices: [{ id: '11', price: heldMode === 'zero' ? 0 : 5, currency: 'USD' }] }; if (heldMode === 'priceFail') { status = 503; payload = {}; } if (heldMode === 'price429') { status = 429; payload = {}; } }
    else if (u.pathname.includes('GetUserStatsForGame')) {
      payload = { playerstats: { steamID: steamId, stats: [{ name: 'kill_player', value: heldMode === 'zero' ? 0 : 20 }, { name: 'deaths', value: heldMode === 'zero' ? 0 : 2 }, { name: 'rocket_fired', value: heldMode === 'zero' ? 0 : 9 }] } };
      if (heldMode === 'partial' || heldMode === 'missingFields') payload.playerstats.stats = [{ name: 'kill_player', value: 30 }];
    } else if (u.pathname === `/players/${playerId}/relationships/sessions`) {
      assert.equal(u.searchParams.get('filter[servers]'), bmServer);
      payload = { data: [
        { type: 'session', id: 'a', attributes: { start: iso(10), stop: iso(11) }, relationships: { server: { data: { id: bmServer } } } },
        { type: 'session', id: 'other', attributes: { start: iso(28), stop: iso(29) }, relationships: { server: { data: { id: '999' } } } }
      ], links: { next: heldMode === 'bmTruncated' ? `https://api.battlemetrics.com/players/${playerId}/relationships/sessions?filter[servers]=${bmServer}&page[key]=${requests.length}` : null } };
      if (heldMode === 'bmEmpty') payload.data = [];
    } else { status = 500; payload = {}; report.unexpectedPath = u.pathname; }
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '1' } : {}) }); res.end(JSON.stringify(payload)); }
  });
  const app = express(), server = createServer(app);
  const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const close = async s => { s.closeAllConnections(); await new Promise((resolve, reject) => s.close(e => e ? reject(e) : resolve())); };
  await listen(upstream); await listen(server); const origin = `http://127.0.0.1:${server.address().port}`, upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  process.env.NB_V2_PUBLIC_ORIGIN = origin;
  try {
    const main = await import('../../../server/api.js'); stopBackgroundJobs = main.stopBackgroundJobs;
    api = main.createApiRouter({ managementRuntimeFactory: deps => {
      globalWrite = deps.runStoreWriteTask; sharedQueue = deps.sharedBattlemetricsQueue; assert.equal(globalWrite, store.runStoreWriteTask);
      return createManagementRuntime({ ...deps, intervalMs: 60000,
        memberOptions: () => ({ invalidatePlatformSessions: () => { throw new Error('risk fixture has no platform sessions'); } }),
        sourceHostOptions: () => ({ fetchImpl: fetch, timeoutMs: 500, maxBytes: 32768, allowLoopbackForTests: true,
          capabilities: { memberRisk: true, steam: true, steamRisk: true, inventory: true, inventoryEnrichment: true, battlemetrics: true },
          origins: Object.fromEntries(['steam','community','battlemetrics','scmm'].map(source => [source, upstreamOrigin])),
          inventoryEnrichment: async ({ steamId: id }, { request, signal }) => { assert.equal(id, steamId); assert.equal(signal.aborted, false); const raw = await request('scmm', `/api/inventory/${id}/value`); assert.equal(raw.steamId, id); return { prices: raw.prices }; } }) });
    } });
    app.use('/api', api); const identity = await api.v2Runtime.getIdentity(); await api.v2Runtime.start(); system = api.v2Runtime.management.getSystem(identity);
    assert.equal(system.sourceHost.battlemetricsQueue, sharedQueue);
    const login = await fetch(`${origin}/api/v2/auth/owner-password`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: process.env.NB_ROOT_PASSWORD }) });
    const logged = await login.json(); assert.equal(login.status, 200, JSON.stringify(logged));
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; '), csrf = logged.data.csrfToken;
    const request = async (route, body, { method = body === undefined ? 'GET' : 'POST', key = randomUUID(), status = 200, omitCsrf = false } = {}) => {
      const response = await fetch(`${origin}/api/v2${route}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(omitCsrf ? {} : { 'X-CSRF-Token': csrf }), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`); return value.data || value;
    };
    let wipe = (await request('/wipes', { title: '风险采集隔离档', serverProfileId: 'isolated-risk-server', serverSnapshot: { battlemetricsId: bmServer },
      audience: { memberIds: [memberId], squadIds: [], includeUnassigned: false }, timeZone: 'Asia/Shanghai', musterAt: iso(29), signupOpensAt: iso(28), signupClosesAt: iso(31) }, { status: 201 })).current;
    for (const [command, fields] of [['publish', {}], ['start', { startMode: 'manual' }], ['confirm-server-start', { serverActualWipeAt: iso(0), serverStartEvidence: 'explicit isolated historical fixture' }]]) wipe = (await request(`/wipes/${wipe.id}/commands/${command}`, { expectedRevision: wipe.revision, ...fields })).current;
    await request('/sync-center/sources/steam', { expectedRevision: 1, minIntervalMs: 0, maxAttempts: 1, timeoutMs: 15000 });
    const input = { kind: 'memberProfiles', memberIds: [memberId] }, enqueue = key => request('/member-admin/sync/request', input, key ? { key } : {});
    const detail = job => request(`/sync-center/jobs/${job.id}`), tick = () => bounded(api.v2Runtime.management.tick(), 'single management worker');
    const profile = () => { const rows = db.prepare("SELECT payload_json FROM json_records WHERE collection='memberProfiles' AND json_extract(payload_json,'$.memberId')=?").all(memberId); assert.ok(rows.length <= 1); return rows[0] ? JSON.parse(rows[0].payload_json) : null; };
    const canonical = () => structuredClone({ member: repo.get('members', memberId), profile: profile() });
    const receipts = () => db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n;
    const risks = () => request('/member-admin/risks');
    const checkTypes = async expected => { const data = await risks(), found = data.items.find(x => x.member.id === memberId); assert.ok(found); for (const type of expected) assert.ok(found.alerts.some(r => r.type === type), type); return found; };
    const beforeGet = canonical(); await risks(); await request(`/sync-center/coverage?type=member_profile&scope=members&memberIds=${memberId}`); assert.deepEqual(canonical(), beforeGet); assert.equal(requests.length, 0);
    await request('/member-admin/sync/request', input, { omitCsrf: true, status: 403 });
    const key = randomUUID(), first = (await enqueue(key)).job; assert.equal((await enqueue(key)).job.id, first.id); assert.equal((await enqueue()).job.id, first.id);
    await tick(); assert.equal((await detail(first)).status, 'succeeded', JSON.stringify(await detail(first)));
    let p = profile(); assert.equal(p.riskScan.quality, 'complete', JSON.stringify(p.riskScan)); assert.ok(p.riskScan.lastCompleteAt);
    assert.equal(p.playTimeMinutes, 120); assert.equal(p.inventoryValue, 5); assert.equal(p.vacBanned, true); assert.equal(p.accountRestricted, true);
    assert.equal(p.officialKda.kills, 20); assert.equal(p.officialKda.kd, 10); assert.equal(p.officialKda.rockets, 9); assert.equal(p.battlemetricsLastOnlineAt, iso(10));
    assert.equal(receipts(), 1); assert.equal(requests.length, 8);
    assert.equal((await request(`/sync-center/coverage?type=member_profile&scope=members&memberIds=${memberId}`)).quality, 'complete');
    const initialRisk = await checkTypes(['account_restricted','steam_ban_or_restriction','inventory_value','playtime_hours','no_online_days','kills','kd','rockets']);
    report.firstCanonical = p; report.firstRiskDto = initialRisk;
    const cachedProfile = (await store.readStore()).memberProfiles.find(x => x.id === p.id); for (const k of Object.keys(p)) assert.deepEqual(cachedProfile[k], p[k]);
    checks.push({ name: 'real-HTTP-G03-CSRF-MemberAdmin-single-worker-canonical-risk-DTO-cache-queue', passed: true, jobId: first.id });
    const writeFixture = fn => globalWrite(async () => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } });
    const putProfile = next => upsertSqliteCollectionRecord(db, 'memberProfiles', next.id, next);
    await writeFixture(() => putProfile({ ...profile(), accountSignals: { ...profile(), retainedPrivateExtension: 'owned fixture only' } }));
    const full = profile();
    async function runMode(next) { mode = next; const job = (await enqueue()).job; await tick(); const result=await detail(job); assert.equal(result.status, next==='allFail'?'failed':'partial', JSON.stringify(result)); assert.equal(result.items[0].reason,'RISK_SCAN_INCOMPLETE'); return profile(); }
    p = await runMode('partial'); assert.equal(p.riskScan.quality, 'partial'); assert.equal(p.riskScan.lastCompleteAt, full.riskScan.lastCompleteAt); assert.equal(p.fetchedAt, full.fetchedAt);
    assert.equal(p.vacBanned, true); assert.equal(p.accountRestricted, true); assert.equal(p.steamBanCheckedAt, full.steamBanCheckedAt);
    assert.equal(p.officialKda.kills, 30); assert.equal(p.accountSignals.officialKda.kills, 30); assert.equal(p.officialKda.deaths, 2); assert.equal(p.officialKda.kd, 10);
    assert.equal(p.riskScan.fields['officialKda.deaths'].retained, true); assert.equal(p.riskScan.fields.vacBanned.observedAt, full.riskScan.fields.vacBanned.observedAt);
    await checkTypes(['account_restricted','steam_ban_or_restriction','inventory_value','kd','rockets']);
    checks.push({ name: 'partial-failure-keeps-old-risk-values-times-and-accountSignals-sync', passed: true });
    const partialCoverage = await request(`/sync-center/coverage?type=member_profile&scope=members&memberIds=${memberId}`); assert.equal(partialCoverage.quality, 'partial'); assert.equal(partialCoverage.lastSuccessAt, full.riskScan.lastCompleteAt);
    p = await runMode('private'); assert.equal(p.riskScan.sources.inventory.status, 'private'); assert.equal(p.inventoryValue, 5); assert.equal(p.riskScan.fields.inventoryValue.retained, true);
    const privateDto = await checkTypes(['inventory_value']);
    const privateDetail = await request(`/member-admin/members/${memberId}`);
    assert.equal(privateDetail.riskScan.sources.inventory.status, 'private');
    assert.equal(privateDetail.riskScan.quality, p.riskScan.quality);
    const retainedAlert = privateDto.alerts.find(alert => alert.type === 'inventory_value');
    assert.equal(retainedAlert.retained, true);
    assert.equal(retainedAlert.observedAt, p.riskScan.fields.inventoryValue.observedAt);
    assert.equal(retainedAlert.currentStatus, 'private');
    report.privateEvidence = { currentVisibility: p.riskScan.fields.inventoryVisibility.status, storedPreviousVisibility: p.inventoryVisibility, previousValue: p.inventoryValue, currentRiskDto: await checkTypes(['inventory_value','steam_ban_or_restriction']) }; checks.push({ name: 'explicit-private-preserves-risk-never-zero', passed: true });
    p = await runMode('priceFail'); assert.equal(p.riskScan.sources.inventory.status, 'partial'); assert.equal(p.riskScan.sources.inventory.error, 'SOURCE_PRICE_UNAVAILABLE'); assert.equal(p.riskScan.fields.inventoryVisibility.status, 'observed'); assert.equal(p.inventoryVisibility, 'public'); assert.equal(p.inventoryValue, 5); checks.push({ name: 'pricing-failure-retains-value-and-saves-public-inventory-fact', passed: true });
    p = await runMode('inventory403'); assert.equal(p.riskScan.sources.inventory.status, 'unavailable'); assert.equal(p.inventoryValue, 5); checks.push({ name: 'HTTP403-is-unavailable-not-private-or-empty', passed: true });
    p = await runMode('missingFields'); assert.equal(p.playTimeMinutes, 120); assert.equal(p.communityBanned, true); assert.equal(p.riskScan.fields.communityBanned.retained, true); checks.push({ name: 'missing-fields-preserve-values-not-false-zero', passed: true });
    p = await runMode('wrongIdentity'); assert.equal(p.vacBanned, true); assert.equal(p.riskScan.sources.bans.status, 'unavailable'); checks.push({ name: 'wrong-upstream-Steam-identity-no-risk-overwrite', passed: true });
    p = await runMode('timeout'); assert.equal(p.vacBanned, true); assert.equal(p.riskScan.sources.bans.error, 'SOURCE_TIMEOUT'); checks.push({ name: 'bounded-timeout-preserves-ban-evidence', passed: true });
    p = await runMode('bmEmpty'); assert.equal(p.battlemetricsLastOnlineAt, iso(10)); assert.equal(p.riskScan.sources.battlemetrics.status, 'unavailable'); checks.push({ name: 'empty-BM-not-never-online-preserves-last-evidence', passed: true });
    p = await runMode('bmTruncated'); assert.equal(p.riskScan.sources.battlemetrics.error, 'SOURCE_PAGE_LIMIT'); assert.equal(p.battlemetricsLastOnlineAt, iso(10)); checks.push({ name: 'BM-twenty-page-limit-preserves-evidence', passed: true });
    p = await runMode('allFail'); assert.equal(p.riskScan.quality, 'unknown'); assert.equal(p.riskScan.lastCompleteAt, full.riskScan.lastCompleteAt); assert.equal(p.inventoryValue, 5); assert.equal(p.vacBanned, true);
    checks.push({ name: 'all-required-sources-failed-is-unknown-not-complete', passed: true });
    p = await runMode('zero'); assert.equal(p.riskScan.quality, 'partial'); assert.equal(p.vacBanned, false); assert.equal(p.accountRestricted, false); assert.equal(p.playTimeMinutes, 120); assert.equal(p.inventoryValue, 0); assert.equal(p.officialKda.kd, 0);
    assert.equal(p.playTimeKnown, false); assert.equal(p.playTimeVisibility, 'unknown'); assert.equal(p.riskScan.fields.playTimeMinutes.retained, true);
    assert.equal(p.riskScan.lastCompleteAt, full.riskScan.lastCompleteAt); checks.push({ name: 'explicit-known-false-and-zero-replace-old-risk', passed: true });
    p = await runMode('price429');
    assert.equal(p.riskScan.sources.inventory.error, 'RATE_LIMITED');
    assert.equal(p.riskScan.fields.inventoryVisibility.status, 'observed');
    assert.equal(p.inventoryValue, 0);
    const priceCooldown = system.service.repo.get('source', 'steam').nextAllowedAt;
    assert.ok(priceCooldown > Date.now());
    await new Promise(resolve => setTimeout(resolve, Math.max(0, priceCooldown - Date.now() + 10)));
    p = await runMode('ban429'); assert.equal(p.riskScan.sources.bans.error, 'RATE_LIMITED');
    const cooldown = system.service.repo.get('source', 'steam').nextAllowedAt; assert.ok(cooldown > Date.now());
    const waiting = (await enqueue()).job, waitingCalls = requests.length; await tick(); assert.equal((await detail(waiting)).status, 'queued'); assert.equal(requests.length, waitingCalls);
    await request('/member-admin/sync/cancel', { ...input, jobId: waiting.id, expectedRevision: (await detail(waiting)).revision });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 10)));
    checks.push({ name: 'Steam-429-persists-existing-source-cooldown', passed: true });
    mode = 'complete';
    const allRules = structuredClone(readSettings().accountRisk);
    await writeFixture(() => repo.setScalar('settings', { ...readSettings(), accountRisk: { ...allRules, revision: allRules.revision + 1, rules: allRules.rules.map(r => ({ ...r, enabled: false })) } }));
    const limitedCalls = requests.length, limited = (await enqueue()).job; await tick(); assert.equal((await detail(limited)).status, 'succeeded');
    assert.equal(profile().riskScan.quality, 'complete'); assert.equal(profile().riskScan.sources.bans.status, 'not_required'); assert.equal(profile().riskScan.sources.battlemetrics.status, 'not_required');
    assert.equal(requests.length - limitedCalls, 3); await writeFixture(() => repo.setScalar('settings', { ...readSettings(), accountRisk: allRules }));
    checks.push({ name: 'disabled-rules-skip-bans-KDA-BM-prices-quality-only-required', passed: true });
    const credentialsBefore = structuredClone(readSettings().steamWebApi), beforeNoKey = profile();
    await writeFixture(() => repo.setScalar('settings', { ...readSettings(), steamWebApi: { apiKey: '' } }));
    const missingKey = (await enqueue()).job; await tick(); assert.equal((await detail(missingKey)).status, 'partial'); assert.equal(profile().riskScan.sources.bans.error, 'SOURCE_NOT_CONFIGURED');
    assert.equal(profile().vacBanned, beforeNoKey.vacBanned); assert.equal(profile().playTimeMinutes, beforeNoKey.playTimeMinutes);
    await writeFixture(() => repo.setScalar('settings', { ...readSettings(), steamWebApi: credentialsBefore }));
    checks.push({ name: 'missing-source-key-retains-observed-values', passed: true });
    async function inFlight(name, act) {
      const job = (await enqueue()).job, count = receipts(); const held = { entered: deferred(), release: deferred() }; gate = held; const work = tick(); let expected;
      try { await bounded(held.entered.promise, `${name} reached bans`); await act(job); expected = canonical(); }
      finally { held.release.resolve(); }
      await work; assert.deepEqual(canonical(), expected, name); assert.equal(receipts(), count); assert.notEqual((await detail(job)).status, 'succeeded');
      checks.push({ name, passed: true });
    }
    await inFlight('cancel-via-MemberAdmin-HTTP-no-write', async job => { const d = await detail(job); await request('/member-admin/sync/cancel', { ...input, jobId: job.id, expectedRevision: d.revision }); });
    const settingsBefore = structuredClone(readSettings()), memberBefore = structuredClone(repo.get('members', memberId));
    for (const [name, mutate, restore] of [
      ['Steam-identity-drift', () => repo.put('members', { ...memberBefore, steamId: '76561198000000509', revision: memberBefore.revision + 1 }), () => repo.put('members', memberBefore)],
      ['BM-identity-drift', () => repo.put('members', { ...memberBefore, battlemetricsId: '602', revision: memberBefore.revision + 1 }), () => repo.put('members', memberBefore)],
      ['risk-rule-config-drift', () => repo.setScalar('settings', { ...readSettings(), accountRisk: { ...readSettings().accountRisk, revision: 2, rules: [] } }), () => repo.setScalar('settings', settingsBefore)],
      ['Steam-credentials-drift', () => repo.setScalar('settings', { ...readSettings(), steamWebApi: { apiKey: fakeKey + '-rotated' } }), () => repo.setScalar('settings', settingsBefore)]
    ]) { await inFlight(name, () => writeFixture(mutate)); await writeFixture(restore); }
    const priorProfile = structuredClone(profile());
    await inFlight('profile-revision-drift', () => writeFixture(() => putProfile({ ...priorProfile, inventoryValue: 11, revision: (priorProfile.revision || 1) + 1 })));
    await writeFixture(() => putProfile(priorProfile));
    const relation = repo.all('squadMembers').find(r => r.memberId === memberId && !r.validTo);
    await inFlight('squad-membership-drift', () => writeFixture(() => repo.put('squadMembers', { ...relation, revision: (relation.revision || 1) + 1, squadId: 'isolated-other-squad' })));
    await writeFixture(() => repo.put('squadMembers', relation));
    await inFlight('current-wipe-server-drift', async () => { wipe = (await request(`/wipes/${wipe.id}`, { expectedRevision: wipe.revision, majorChange: true, reason: 'isolated risk fence', serverSnapshot: { battlemetricsId: '732' } }, { method: 'PATCH' })).current; });
    wipe = (await request(`/wipes/${wipe.id}`, { expectedRevision: wipe.revision, majorChange: true, reason: 'restore fixture', serverSnapshot: { battlemetricsId: bmServer } }, { method: 'PATCH' })).current;
    await inFlight('task-scope-drift', job => writeFixture(() => { const row = system.service.repo.get('job', job.id); row.scope.memberIds = ['g05_beta']; system.service.repo.put('job', row); }));
    const mismatch = profile(); await writeFixture(() => putProfile({ ...mismatch, steamId: '76561198000000509' })); const mismatchBefore = canonical(), mismatchCalls = requests.length;
    const blocked = (await enqueue()).job; await tick(); assert.notEqual((await detail(blocked)).status, 'succeeded'); assert.deepEqual(canonical(), mismatchBefore); assert.equal(requests.length, mismatchCalls);
    await writeFixture(() => putProfile(mismatch)); checks.push({ name: 'legacy-profile-Steam-mismatch-never-relabel-risk', passed: true });
    const queued = (await enqueue()).job, queuedBefore = canonical(), queuedCalls = requests.length;
    await writeFixture(() => repo.setScalar('settings', { ...readSettings(), accountRisk: { ...readSettings().accountRisk, revision: 3 } })); await tick(); assert.notEqual((await detail(queued)).status, 'succeeded'); assert.deepEqual(canonical(), queuedBefore); assert.equal(requests.length, queuedCalls); await writeFixture(() => repo.setScalar('settings', settingsBefore));
    checks.push({ name: 'queued-config-drift-rejected-before-network', passed: true });
    const stopJob = (await enqueue()).job, stopBefore = canonical(), stopReceipts = receipts(); const held = { entered: deferred(), release: deferred() }; gate = held; const work = tick();
    try { await bounded(held.entered.promise, 'stop entered'); const stopping = api.v2Runtime.stop(); held.release.resolve(); await bounded(stopping, 'runtime stop'); await work; } finally { held.release.resolve(); }
    assert.deepEqual(canonical(), stopBefore); assert.equal(receipts(), stopReceipts); assert.equal(system.sourceHost.activeIO, 0);
    await bounded(sharedQueue.enqueue({ meta: { source: 'system', priority: -100, operation: 'risk_drain' }, run: async () => null }), 'BM drain');
    assert.equal(sharedQueue.snapshot().pendingCount, 0); checks.push({ name: 'stop-drains-host-and-shared-BM-queue-without-write', passed: true, jobId: stopJob.id });
    assert.equal(report.unexpectedPath, undefined); assert.ok(requests.every(r => r.method === 'GET' && r.credentialMatched), JSON.stringify(requests.filter(r => r.method !== 'GET' || !r.credentialMatched)));
    assert.equal(repo.get('members', memberId).memberStatus, memberBefore.memberStatus); assert.equal(repo.get('members', memberId).discordId, memberBefore.discordId);
    report.finalScan = profile().riskScan; report.queue = sharedQueue.snapshot(); report.cleanup.integrity = db.prepare('PRAGMA quick_check').get().quick_check;
    assert.equal(report.cleanup.integrity, 'ok');
  } finally {
    gate?.release.resolve(); await api?.v2Runtime.stop(); stopBackgroundJobs?.(); await close(server); await close(upstream); await store.drainStoreWrites(); await storage.closeSqliteDatabases();
    report.cleanup = { ...report.cleanup, mainRuntimeStopped: api?.v2Runtime.management.diagnostics().stopped === true, sourceActiveIO: system?.sourceHost.activeIO, mainHttpClosed: !server.listening, upstreamClosed: !upstream.listening, sqliteClosed: true };
  }
  await writeFile(path.join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
