import '../results.mjs';
import '../v2-source-main/offline.mjs';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const base = path.join(root, 'test/support/v2-departure-audit/.runtime');
if (process.argv[2] !== '--isolated-child') {
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(path.join(base, 'run-'));
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child'], {
      cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai',
        SOURCE_MAIN_DEPENDENCY_ROOT: decodeURIComponent(new URL('../../../', import.meta.url).pathname), DEPARTURE_AUDIT_RUN: run,
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
    const output = path.join(root, 'output/test-results/g07-departure-audit/runtime-report.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Departure audit: ${report.checks.length} checks passed; ${output}`);
  } finally { await rm(run, { recursive: true, force: true }); }
} else {
  const run = process.env.DEPARTURE_AUDIT_RUN;
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
  const fakeKey = 'explicit-isolated-fake-discord-bot-key';
  const guildId = '100000000000000001', discordUserId = '100000000000000002', roleA = '100000000000000003', roleB = '100000000000000004';
  const memberId = 'g05_alpha';
  const memberships = () => db.prepare("SELECT payload_json FROM json_records WHERE collection='squadMembers' AND json_extract(payload_json,'$.memberId')=? AND COALESCE(json_extract(payload_json,'$.validTo'),'')='' ORDER BY id").all(memberId).map(r => JSON.parse(r.payload_json));
  const originalSquad = memberships()[0]; assert.ok(originalSquad);
  repo.put('members', { ...repo.get('members', memberId), discordId: discordUserId });
  repo.put('identities', { ...repo.get('identities', 'discord_alpha'), externalId: discordUserId });
  repo.put('policies', { ...repo.all('policies').find(p => p.provider === 'discord'), provider: 'discord', enabled: true, guildId, allowedRoleIds: [roleA], matchMode: 'any', policyRevision: 1 });
  repo.setScalar('settings', { ...repo.scalar('settings'), discord: { botToken: fakeKey, guildId, revision: 1,
    memberRegisterRoleSquadRules: [{ roleId: roleA, roleName: '配置角色甲', squadId: originalSquad.squadId }, { roleId: roleB, squadId: 'another-squad' }] }, system: { proxy: {} } });
  const readSettings = () => repo.scalar('settings');
  const setDiscord = patch => repo.setScalar('settings', { ...readSettings(), discord: { ...readSettings().discord, ...patch, revision: readSettings().discord.revision + 1 } });
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const bounded = async (promise, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), 10000); })]); } finally { clearTimeout(timer); } };
  const requests = [], checks = [], report = { boundary: 'Isolated real main HTTP/G03/MemberAdmin/SyncCenter worker/canonical SQLite; constructed Discord loopback only', checks, requests, cleanup: {} };
  let mode = 'valid', gate, api, system, stopBackgroundJobs, globalWrite;
  const upstream = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: u.pathname, credentialMatched: req.headers.authorization === `Bot ${readSettings().discord.botToken}` });
    const heldMode = mode;
    if (gate && u.pathname.includes('/members/')) { const held = gate; gate = null; held.entered.resolve(); await held.release.promise; }
    let status = 200, payload;
    if (u.pathname.endsWith('/roles')) {
      payload = [{ id: guildId, name: '@everyone' }, { id: roleA, name: '正式成员' }, { id: roleB, name: '预备成员' }];
      if (heldMode === 'roles403') { status = 403; payload = { message: fakeKey }; }
      if (heldMode === 'roles404') { status = 404; payload = { code: 10004 }; }
      if (heldMode === 'oversize') payload = [{ id: guildId, name: 'x'.repeat(40000) }];
      if (heldMode === 'removedRole') payload = payload.filter(r => r.id !== roleA);
    } else if (u.pathname === `/api/v10/guilds/${guildId}/members/${discordUserId}`) {
      payload = { user: { id: discordUserId, username: '隔离成员' }, roles: [roleA, roleB] };
      if (heldMode === 'missingRole') payload.roles = [];
      if (heldMode === 'wrongUser') payload.user.id = '100000000000000009';
      if (heldMode === 'unknownRole') payload.roles = ['100000000000000009'];
      if (heldMode === 'tooManyRoles') payload.roles = Array(501).fill(roleA);
      if (heldMode === 'timeout') { res.on('close', () => {}); return; }
      if (heldMode === 'malformed') { res.writeHead(200); res.end('{'); return; }
      if (heldMode === 'redirect') { res.writeHead(302, { Location: 'https://discord.com/api/v10/guilds/100000000000000001/members/100000000000000002' }); res.end('{}'); return; }
      if (heldMode === 'absent') { status = 404; payload = { code: 10007, message: 'Unknown Member' }; }
      if (heldMode === 'wrong404') { status = 404; payload = { code: 10004, message: 'Unknown Guild' }; }
      if (/^http/.test(heldMode)) { status = Number(heldMode.slice(4)); payload = { message: fakeKey }; }
    } else { status = 500; payload = {}; report.unexpectedPath = u.pathname; }
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '1' } : {}) }); res.end(JSON.stringify(payload)); }
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
      globalWrite = deps.runStoreWriteTask;
      assert.equal(globalWrite, store.runStoreWriteTask);
      return createManagementRuntime({ ...deps, intervalMs: 60000, memberOptions: () => ({ invalidatePlatformSessions: () => { throw new Error('audit fixture has no platform sessions'); } }),
        sourceHostOptions: () => ({ fetchImpl: fetch, capabilities: { discordMembershipAudit: true }, allowLoopbackForTests: true, timeoutMs: 500, maxBytes: 32768,
          origins: { discord: `http://127.0.0.1:${upstream.address().port}` } }) });
    } });
    app.use('/api', api);
    const identity = await api.v2Runtime.getIdentity(); await api.v2Runtime.start(); system = api.v2Runtime.management.getSystem(identity);
    const login = await fetch(`${origin}/api/v2/auth/owner-password`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: process.env.NB_ROOT_PASSWORD }) });
    const logged = await login.json(); assert.equal(login.status, 200, JSON.stringify(logged));
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; '), csrf = logged.data.csrfToken;
    const request = async (route, body, { method = body === undefined ? 'GET' : 'POST', key = randomUUID(), status = 200, omitCsrf = false } = {}) => {
      const response = await fetch(`${origin}/api/v2${route}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(omitCsrf ? {} : { 'X-CSRF-Token': csrf }), 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json(); assert.equal(response.status, status, `${route}: ${JSON.stringify(value)}`); return value.data || value;
    };
    const auditInput = { kind: 'discordMembershipAudit', memberIds: [memberId] };
    const enqueue = key => request('/member-admin/sync/request', auditInput, { ...(key ? { key } : {}) });
    const detail = job => request('/member-admin/sync/status', { ...auditInput, jobId: job.id });
    const tick = () => bounded(api.v2Runtime.management.tick(), 'single management worker');
    const canonical = () => structuredClone(repo.get('members', memberId));
    const receipts = () => db.prepare('SELECT count(*) n FROM v2_source_adapter_receipts').get().n;
    const profiles = () => db.prepare("SELECT payload_json FROM json_records WHERE collection='memberProfiles' ORDER BY id").all();
    const protectedFields = m => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('discordMembership') && !['revision','updatedAt','discordName'].includes(k)));
    const immutableBefore = protectedFields(canonical()), profilesBefore = profiles();
    await request('/sync-center/sources/discord', { expectedRevision: 1, minIntervalMs: 0, maxAttempts: 1, timeoutMs: 15000 });
    const getBefore = canonical();
    const emptyCoverage = await request(`/sync-center/coverage?type=discord_membership_audit&scope=members&memberIds=${memberId}`);
    assert.equal(emptyCoverage.quality, 'unknown'); await request('/sync-center/sources'); await request('/sync-center/jobs');
    assert.deepEqual(canonical(), getBefore); assert.equal(requests.length, 0);
    await request('/member-admin/sync/request', auditInput, { omitCsrf: true, status: 403 });
    checks.push({ name: 'real-G03-CSRF-GET-read-only-one-global-write-owner', passed: true });
    const key = randomUUID(), first = (await enqueue(key)).job;
    assert.equal(first.type, 'discord_membership_audit'); assert.equal((await enqueue(key)).job.id, first.id);
    const dedup = await enqueue(); assert.equal(dedup.job.id, first.id); assert.equal(dedup.deduplicated, true);
    await tick(); assert.equal((await detail(first)).status, 'succeeded');
    assert.equal(canonical().discordMembershipStatus, 'valid'); assert.equal(canonical().discordMembershipGuildId, guildId);
    assert.deepEqual(canonical().discordMembershipExpectedRoleIds, [roleA]); assert.deepEqual(canonical().discordMembershipExpectedRoleNames, ['正式成员']);
    assert.deepEqual(canonical().discordMembershipActualRoleIds, [roleA, roleB]); assert.deepEqual(canonical().discordMembershipActualRoleNames, ['正式成员','预备成员']);
    assert.equal(canonical().discordMembershipLastOkAt, canonical().discordMembershipCheckedAt);
    assert.equal(receipts(), 1); assert.equal(requests.length, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM v2_source_adapter_cache').get().n, 0);
    const cachedMember = (await store.readStore()).members.find(m => m.id === memberId);
    assert.deepEqual(Object.fromEntries(Object.keys(canonical()).map(k => [k, cachedMember[k]])), canonical());
    const goodCoverage = await request(`/sync-center/coverage?type=discord_membership_audit&scope=members&memberIds=${memberId}`);
    assert.equal(goodCoverage.quality, 'complete');
    checks.push({ name: 'MemberAdmin-HTTP-single-worker-idempotency-dedup-canonical-role-names-cache-receipt', passed: true, jobId: first.id });
    async function runMode(next, status, reason = '') {
      mode = next; const count = requests.length, job = (await enqueue()).job; await tick();
      assert.equal((await detail(job)).status, status === 'check_failed' ? 'failed' : 'succeeded', JSON.stringify(await detail(job)));
      const m = canonical(); assert.equal(m.discordMembershipStatus, status, next); assert.equal(m.discordMembershipError, reason, next);
      assert.ok(requests.length - count <= 2, next); assert.deepEqual(protectedFields(m), immutableBefore); assert.deepEqual(profiles(), profilesBefore);
      if (next === 'http429') {
        const cooldown = system.service.repo.get('source', 'discord').nextAllowedAt; assert.ok(cooldown > Date.now());
        const queued = (await enqueue()).job, noCalls = requests.length; await tick();
        assert.equal((await detail(queued)).status, 'queued'); assert.equal(requests.length, noCalls);
        await request('/member-admin/sync/cancel', { ...auditInput, jobId: queued.id, expectedRevision: (await detail(queued)).revision });
        await new Promise(resolve => setTimeout(resolve, Math.max(0, cooldown - Date.now() + 10)));
      }
      checks.push({ name: next, passed: true, status, error: reason, calls: requests.length - count }); return m;
    }
    let m = await runMode('missingRole', 'missing_role'); const missingSince = m.discordMembershipMissingSince;
    await runMode('absent', 'not_in_guild'); assert.equal(canonical().discordMembershipMissingSince, missingSince);
    await runMode('http401', 'check_failed', 'DISCORD_TOKEN_INVALID');
    assert.equal(canonical().discordMembershipMissingSince, missingSince); assert.equal(canonical().discordMembershipLastKnownStatus, 'not_in_guild');
    assert.equal(canonical().discordMembershipLastFailureAt, canonical().discordMembershipCheckedAt);
    const failedCoverage = await request(`/sync-center/coverage?type=discord_membership_audit&scope=members&memberIds=${memberId}`); assert.equal(failedCoverage.quality, 'unknown'); assert.equal(failedCoverage.lastError, 'DISCORD_TOKEN_INVALID'); assert.equal(failedCoverage.lastSuccessAt, canonical().discordMembershipLastKnownAt); assert.notEqual(failedCoverage.lastSuccessAt, canonical().discordMembershipLastFailureAt);
    const failedList = await request('/member-admin/members?view=departed&auditStatus=check_failed');
    assert.ok(failedList.items.some(m => m.id === memberId && m.platformAudit.status === 'check_failed' && m.memberStatus === 'active'));
    for (const [next, reason] of [ ['http403','DISCORD_FORBIDDEN'], ['http500','DISCORD_UNAVAILABLE'], ['http429','DISCORD_RATE_LIMITED'],
      ['wrong404','DISCORD_NOT_FOUND_UNCONFIRMED'], ['roles404','DISCORD_NOT_FOUND_UNCONFIRMED'], ['roles403','DISCORD_FORBIDDEN'],
      ['removedRole','DISCORD_ROLE_CONFIG_INVALID'], ['unknownRole','DISCORD_ROLES_CHANGED'], ['wrongUser','SOURCE_INVALID_DATA'], ['tooManyRoles','SOURCE_INVALID_DATA'],
      ['malformed','SOURCE_INVALID_JSON'], ['oversize','SOURCE_RESPONSE_TOO_LARGE'], ['redirect','SOURCE_REDIRECT_REJECTED'], ['timeout','SOURCE_TIMEOUT'] ]) await runMode(next, 'check_failed', reason);
    await runMode('valid', 'valid'); assert.equal(canonical().discordMembershipMissingSince, '');
    mode = 'valid';
    const writeFixture = fn => globalWrite(async () => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } });
    const originalSettings = structuredClone(readSettings().discord);
    const originalPolicy = structuredClone(repo.all('policies').find(p => p.provider === 'discord'));
    const setPolicy = patch => repo.put('policies', { ...originalPolicy, ...patch });
    await writeFixture(() => repo.put('squadMembers', { ...originalSquad, validTo: new Date().toISOString() }));
    const fallback = (await enqueue()).job; await tick(); assert.equal((await detail(fallback)).status, 'succeeded');
    assert.deepEqual(canonical().discordMembershipExpectedRoleIds, [roleA]);
    await writeFixture(() => repo.put('squadMembers', originalSquad));
    await writeFixture(() => setDiscord({ memberRegisterRoleSquadRules: [], memberRegisterRoleId: roleB }));
    const legacyRole = (await enqueue()).job; await tick(); assert.equal((await detail(legacyRole)).status, 'succeeded'); assert.deepEqual(canonical().discordMembershipExpectedRoleIds, [roleA]);
    await writeFixture(() => setDiscord(originalSettings));
    checks.push({ name: 'canonical-policy-overrides-legacy-squad-and-role-settings', passed: true });
    const withSteam = canonical();
    await writeFixture(() => repo.put('members', { ...withSteam, steamId: '' }));
    const discordOnly = (await enqueue()).job; await tick(); assert.equal((await detail(discordOnly)).status, 'succeeded');
    assert.equal(canonical().steamId, ''); assert.deepEqual(profiles(), profilesBefore);
    await writeFixture(() => repo.put('members', { ...canonical(), steamId: withSteam.steamId }));
    checks.push({ name: 'Discord-audit-does-not-require-Steam-or-create-profile', passed: true });
    const beforeMissing = canonical();
    const originalIdentity = repo.get('identities', 'discord_alpha');
    await writeFixture(() => repo.put('identities', { ...originalIdentity, externalId: '' }));
    const missingCalls = requests.length, missing = (await enqueue()).job; await tick(); assert.equal((await detail(missing)).status, 'no_work');
    assert.equal((await detail(missing)).items[0].reason, 'MISSING_IDENTITY'); assert.equal(requests.length, missingCalls);
    await writeFixture(() => repo.put('identities', originalIdentity));
    checks.push({ name: 'missing-Discord-identity-skipped-no-I/O-no-unlink', passed: true });
    async function inFlight(name, act) {
      mode = 'valid'; const job = (await enqueue()).job, receiptBefore = receipts();
      const held = { entered: deferred(), release: deferred() }; gate = held; const work = tick(); let afterMutation;
      try { await bounded(held.entered.promise, `${name} upstream arrival`); await act(job); afterMutation = canonical(); }
      finally { held.release.resolve(); }
      await work; assert.deepEqual(canonical(), afterMutation, name); assert.equal(receipts(), receiptBefore);
      const done = name === 'task-scope-drift' ? await request(`/sync-center/jobs/${job.id}`) : await detail(job); assert.notEqual(done.status, 'succeeded', name);
      checks.push({ name, passed: true, finalStatus: done.status, reason: done.items[0]?.reason });
    }
    await inFlight('in-flight-MemberAdmin-HTTP-cancel', async job => {
      const d = await detail(job); await request('/member-admin/sync/cancel', { ...auditInput, jobId: job.id, expectedRevision: d.revision });
    });
    for (const [name, mutation, restore] of [
      ['guild-drift', () => setPolicy({ guildId: '100000000000000008' }), () => setPolicy({})],
      ['role-config-drift', () => setPolicy({ allowedRoleIds: [roleB] }), () => setPolicy({})],
      ['credential-drift', () => setDiscord({ botToken: fakeKey + '-rotated' }), () => setDiscord(originalSettings)],
      ['Discord-identity-drift', () => repo.put('members', { ...canonical(), discordId: '100000000000000009', revision: canonical().revision + 1 }), () => repo.put('members', { ...canonical(), discordId: discordUserId, revision: canonical().revision + 1 })]
    ]) { await inFlight(name, () => writeFixture(mutation)); await writeFixture(restore); }
    await inFlight('task-scope-drift', job => writeFixture(() => {
      const row = system.service.repo.get('job', job.id); row.scope.memberIds = ['g05_beta']; system.service.repo.put('job', row);
    }));
    const queued = (await enqueue()).job, queuedBefore = canonical(), queuedCalls = requests.length;
    await writeFixture(() => setPolicy({ policyRevision: 999 })); await tick(); assert.notEqual((await detail(queued)).status, 'succeeded');
    assert.deepEqual(canonical(), queuedBefore); assert.equal(requests.length, queuedCalls); await writeFixture(() => setPolicy({}));
    checks.push({ name: 'queued-config-drift-fenced-before-network', passed: true });
    const stopJob = (await enqueue()).job, stopBefore = canonical(), stopReceipts = receipts();
    const held = { entered: deferred(), release: deferred() }; gate = held; const work = tick();
    try { await bounded(held.entered.promise, 'stop arrival'); const stopping = api.v2Runtime.stop(); held.release.resolve(); await bounded(stopping, 'stop'); await work; }
    finally { held.release.resolve(); }
    assert.deepEqual(canonical(), stopBefore); assert.equal(receipts(), stopReceipts); assert.equal(system.sourceHost.activeIO, 0);
    await store.drainStoreWrites(); checks.push({ name: 'stop-fences-canonical-and-drains-existing-owner', passed: true, jobId: stopJob.id });
    assert.ok(requests.every(r => r.method === 'GET' && r.credentialMatched)); assert.equal(report.unexpectedPath, undefined);
    assert.deepEqual(profiles(), profilesBefore); assert.equal(db.prepare('SELECT count(*) n FROM v2_source_windows').get().n, 0);
    report.lastAudit = Object.fromEntries(Object.entries(canonical()).filter(([k]) => k.startsWith('discordMembership')));
    report.receipts = receipts(); report.cleanup.integrity = db.prepare('PRAGMA quick_check').get().quick_check;
    assert.equal(report.cleanup.integrity, 'ok');
  } finally {
    gate?.release.resolve(); await api?.v2Runtime.stop(); stopBackgroundJobs?.();
    await close(server); await close(upstream); await store.drainStoreWrites(); await storage.closeSqliteDatabases();
    report.cleanup = { ...report.cleanup, mainRuntimeStopped: api?.v2Runtime.management.diagnostics().stopped === true,
      mainHttpClosed: !server.listening, upstreamClosed: !upstream.listening, sourceActiveIO: system?.sourceHost.activeIO, sqliteClosed: true };
  }
  await writeFile(path.join(run, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
