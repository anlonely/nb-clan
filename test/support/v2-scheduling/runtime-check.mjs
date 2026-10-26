import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, writeFile } from 'node:fs/promises';
import { randomUUID, createHash, generateKeyPairSync, sign } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { grant } from '../../../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { planSchedulingMigration, applySchedulingMigration } from '../../../server/v2/scheduling/migration.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runDir = path.resolve(process.env.G04_RUN_DIR || '.');
assert.ok(runDir.startsWith(`${root}/work/v2-scheduling/run-`), 'Use verify.mjs to create an isolated G04 run directory');
assert.equal(process.env.NB_DISABLE_BACKGROUND_JOBS, '1');
assert.equal(process.env.NB_DISABLE_EXTERNAL_VITAL, '1');
assert.equal(process.env.NB_DISABLE_EXTERNAL_ATLAS, '1');
assert.equal(process.env.NB_STORAGE_MODE, 'sqlite-primary');
assert.equal(process.env.NB_V2_IDENTITY_ENABLED, '1');
assert.equal(path.resolve(process.env.NB_DATA_DIR || '.'), path.join(runDir, 'runtime-data'));
assert.equal(path.resolve(process.env.NB_SQLITE_FILE || '.'), path.join(runDir, 'runtime-data/nb-clan.sqlite'));
assert.ok(process.env.NB_ROOT_PASSWORD);
await assert.rejects(access(process.env.NB_SQLITE_FILE), { code: 'ENOENT' }, 'Runtime must start with a new SQLite file');

const evidence = {
  startedAt: new Date().toISOString(), scope: 'real createApiRouter, isolated SQLite and loopback HTTP',
  externalAuthentication: 'not tested; verified bindings and fresh eligibility are constructed fixtures',
  platformDelivery: 'disabled; no platform messages requested', checks: [], http: [], passed: false
};
const { ensureStore, readStore, updateStore, drainStoreWrites } = await import('../../../server/store.js');
const { openSqliteDatabase, closeSqliteDatabases } = await import('../../../server/storage/sqlite.js');
await ensureStore();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
await updateStore(store => { store.settings.discord.publicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'); });
const legacy = await readStore();
assert.equal(legacy.members.length, 0);
const db = await openSqliteDatabase();
installIdentitySchema(db); const identityRepo = new IdentityRepository(db);
evidence.identityMigration = applyIdentityMigration(identityRepo, planIdentityMigration(legacy));
installSchedulingSchema(db); const schedulingRepo = new SchedulingRepository(db);
evidence.schedulingMigration = applySchedulingMigration(schedulingRepo, planSchedulingMigration({ wipes: [] }));
const fixtures = [
  { memberId: 'g04_alpha', accountId: 'g04_account_alpha', steamId: '76561198000000401', squadId: 'g04_squad' },
  { memberId: 'g04_beta', accountId: 'g04_account_beta', steamId: '76561198000000402', squadId: 'g04_squad' },
  { memberId: 'g04_foreign', accountId: 'g04_account_foreign', steamId: '76561198000000403', squadId: 'g04_foreign_squad' }
];
for (const fixture of fixtures) {
  identityRepo.put('members', { id: fixture.memberId, steamId: fixture.steamId, memberStatus: 'active',
    membershipStatus: 'active', displayName: fixture.memberId, revision: 1 });
  identityRepo.put('accounts', { id: fixture.accountId, memberId: fixture.memberId, status: 'active',
    roleId: 'member', grants: [], permissionVersion: 1, revision: 1 });
  identityRepo.put('bindings', { id: `binding_${fixture.memberId}`, accountId: fixture.accountId, memberId: fixture.memberId,
    steamId: fixture.steamId, status: 'verified', verifiedAt: new Date().toISOString(), proofSource: 'controlled_test_fixture', revision: 1 });
  identityRepo.put('squadMembers', { id: `relation_${fixture.memberId}`, memberId: fixture.memberId, squadId: fixture.squadId });
  for (const provider of ['discord', 'kook']) identityRepo.put('identities', { id: `${provider}_${fixture.memberId}`,
    provider, externalId: `${provider}_${fixture.memberId}`, accountId: fixture.accountId,
    verifiedAt: new Date().toISOString(), revision: 1 });
}
identityRepo.put('squads', { id: 'g04_squad', name: 'G04 isolated squad', leaderUserIds: ['g04_account_leader'] });
identityRepo.put('squads', { id: 'g04_foreign_squad', name: 'G04 foreign squad' });
identityRepo.put('accounts', { id: 'g04_account_leader', memberId: null, status: 'active', roleId: 'leader',
  grants: [grant('signups.delegate', { type: 'squads', ids: ['g04_squad'] })], permissionVersion: 1, revision: 1 });
for (const policy of identityRepo.all('policies')) identityRepo.put('policies', {
  ...policy, enabled: true, guildId: 'g04_fixture_guild', allowedRoleIds: ['g04_fixture_role']
});
const fixtureIdentity = new IdentityService(identityRepo, {
  providers: Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: ['g04_fixture_role'] })
  }]))
});
async function memberClient(fixture, provider) {
  const eligibility = await fixtureIdentity.checkEligibility(provider, `${provider}_${fixture.memberId}`);
  const session = fixtureIdentity.issueSession(identityRepo.get('accounts', fixture.accountId), eligibility);
  return { jar: new Map([['nb_v2_session', session.token], ['nb_v2_csrf', session.csrfToken]]), csrf: session.csrfToken };
}
await fixtureIdentity.checkEligibility('discord', `discord_${fixtures[1].memberId}`);
const alpha = await memberClient(fixtures[0], 'discord');
const alphaSecondSession = await memberClient(fixtures[0], 'kook');
const foreign = await memberClient(fixtures[2], 'discord');
const leaderSession = fixtureIdentity.issueSession(identityRepo.get('accounts', 'g04_account_leader'));
const leader = { jar: new Map([['nb_v2_session', leaderSession.token]]), csrf: leaderSession.csrfToken };
const admin = { jar: new Map() }, anonymous = { jar: new Map() };
const app = express(), server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.NB_V2_PUBLIC_ORIGIN = origin;
evidence.origin = origin;
const { createApiRouter, stopBackgroundJobs } = await import('../../../server/api.js');
app.use('/api', createApiRouter());
async function request(client, route, { method = 'GET', body, operationId, csrf = true, originHeader = origin, extraHeaders = {} } = {}) {
  const response = await fetch(`${origin}/api${route}`, {
    method, redirect: 'manual', headers: {
      cookie: [...client.jar].map(([key, value]) => `${key}=${value}`).join('; '), origin: originHeader,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(csrf && client.csrf ? { 'x-csrf-token': client.csrf } : {}),
      ...(operationId ? { 'Idempotency-Key': operationId } : {}), ...extraHeaders
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  for (const line of response.headers.getSetCookie()) {
    const [key, value] = line.split(';')[0].split('='); value ? client.jar.set(key, value) : client.jar.delete(key);
  }
  const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  const trace = { method, route, status: response.status, errorCode: payload?.error?.errorCode || null,
    requestId: payload?.meta?.requestId || payload?.error?.requestId || null };
  evidence.http.push(trace);
  return { status: response.status, payload, data: payload?.data, trace };
}
function status(reply, expected, errorCode) {
  assert.equal(reply.status, expected, JSON.stringify({ expected, ...reply.trace, payload: reply.payload }));
  if (errorCode) assert.equal(reply.payload.error.errorCode, errorCode);
  return reply.data;
}
async function check(name, fn) {
  const startedAt = new Date().toISOString();
  try { const result = await fn(); evidence.checks.push({ name, passed: true, startedAt }); return result; }
  catch (error) { evidence.checks.push({ name, passed: false, startedAt, message: error.message }); throw error; }
}
const mutation = (client, route, body, operationId = randomUUID(), method = 'POST', extra = {}) =>
  request(client, route, { method, body, operationId, ...extra });
const signupBody = (revision, contentRevision, response = 'attending_on_time') => ({
  response, expectedArrivalAt: null, timeZone: 'Asia/Shanghai', expectedSignupRevision: revision, confirmedContentRevision: contentRevision
});
const wipeOf = data => data.current;
let wipe, firstSignup, firstBody, firstKey, currentSignup;
try {
  await check('Unauthenticated scheduling reads fail closed', async () => status(await request(anonymous, '/v2/wipes'), 401));
  await check('Real root password login creates a V2 session and reads without a CSRF token', async () => {
    status(await request(admin, '/v2/auth/password', { method: 'POST', body: { username: 'root', password: process.env.NB_ROOT_PASSWORD } }), 200);
    const me = status(await request(admin, '/v2/auth/me', { csrf: false }), 200);
    assert.equal(me.accountId, 'user_root'); assert.equal(me.memberId, null); admin.csrf = me.csrfToken;
    status(await request(admin, '/v2/wipes', { csrf: false }), 200);
  });
  const now = Date.now();
  const createInput = {
    title: 'G04 isolated runtime event', description: 'Local fixture; no external delivery',
    serverProfileId: 'g04_local_server', serverSnapshot: { id: 'g04_local_server', name: 'Isolated server', address: '127.0.0.1' },
    audience: { squadIds: ['g04_squad'], memberIds: [], includeUnassigned: false },
    timeZone: 'Asia/Shanghai', autoOpenSignup: true, signupOpensAt: new Date(now - 3_600_000).toISOString(),
    signupClosesAt: new Date(now + 7_200_000).toISOString(), musterAt: new Date(now + 3_600_000).toISOString(),
    serverScheduledWipeAt: new Date(now + 5_400_000).toISOString(), serverScheduleSource: 'manual', autoStart: false
  };
  await check('Missing CSRF, forged origin and missing capability cannot create a wipe', async () => {
    status(await mutation(admin, '/v2/wipes', createInput, randomUUID(), 'POST', { csrf: false }), 403, 'CSRF_INVALID');
    status(await mutation(admin, '/v2/wipes', createInput, randomUUID(), 'POST', { originHeader: 'https://forged.invalid' }), 403, 'CSRF_INVALID');
    status(await mutation(alpha, '/v2/wipes', createInput), 403);
  });
  await check('Create and publish use the real registered routes without sending messages', async () => {
    wipe = wipeOf(status(await mutation(admin, '/v2/wipes', createInput), 201));
    assert.equal(wipe.lifecycle, 'draft'); assert.notEqual(wipe.musterAt, wipe.serverScheduledWipeAt);
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}/commands/publish`, { expectedRevision: wipe.revision }), 200));
    assert.equal(wipe.lifecycle, 'scheduled');
  });
  await check('V2 audience authorizes its members while hiding a foreign member', async () => {
    status(await request(alpha, `/v2/wipes/${wipe.id}/summary`, { csrf: false }), 200);
    status(await request(foreign, `/v2/wipes/${wipe.id}/summary`), 404);
    const list = status(await request(foreign, '/v2/wipes'), 200);
    assert.equal(JSON.stringify(list).includes(wipe.id), false);
  });
  await check('First signup and double-click replay preserve a stable receipt and one current slot', async () => {
    firstBody = signupBody(0, wipe.contentRevision); firstKey = randomUUID();
    firstSignup = status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, firstBody, firstKey, 'PUT'), 200);
    assert.equal(firstSignup.current.signupRevision, 1); assert.equal(firstSignup.replayed, false);
    const retry = status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, firstBody, firstKey, 'PUT'), 200);
    assert.equal(retry.replayed, true); assert.deepEqual(retry.operationReceipt, firstSignup.operationReceipt);
    status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, { ...firstBody, response: 'not_attending' }, firstKey, 'PUT'), 409, 'IDEMPOTENCY_CONFLICT');
    const operation = status(await request(alpha, `/v2/operations/${firstKey}`), 200);
    assert.equal(operation.operationReceipt.operationId, firstKey);
  });
  await check('Concurrent authenticated sessions sharing one member allow one write at the expected version', async () => {
    const replies = await Promise.all([
      mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, signupBody(1, wipe.contentRevision, 'not_attending'), randomUUID(), 'PUT'),
      mutation(alphaSecondSession, `/v2/wipes/${wipe.id}/my-signup`, signupBody(1, wipe.contentRevision, null), randomUUID(), 'PUT')
    ]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    status(replies.find(reply => reply.status === 409), 409, 'REVISION_CONFLICT');
    currentSignup = status(replies.find(reply => reply.status === 200), 200).current;
    assert.equal(currentSignup.signupRevision, 2);
  });
  await check('A leader without a member binding delegates only inside its squad', async () => {
    status(await mutation(leader, `/v2/wipes/${wipe.id}/signups/g04_beta`, {
      ...signupBody(0, wipe.contentRevision), reason: 'Controlled captain delegation'
    }, randomUUID(), 'PUT'), 200);
    status(await mutation(leader, `/v2/wipes/${wipe.id}/signups/g04_foreign`, {
      ...signupBody(0, wipe.contentRevision), reason: 'Must remain out of scope'
    }, randomUUID(), 'PUT'), 403);
  });
  await check('Closed signup still replays a committed operation with its latest current value', async () => {
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}/commands/close-signup`, {
      expectedRevision: wipe.revision, reason: 'Local deadline simulation'
    }), 200));
    const retry = status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, firstBody, firstKey, 'PUT'), 200);
    assert.deepEqual(retry.operationReceipt, firstSignup.operationReceipt); assert.equal(retry.current.signupRevision, 2);
    status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, signupBody(2, wipe.contentRevision), randomUUID(), 'PUT'), 409, 'SIGNUP_CLOSED');
  });
  await check('Root without a member binding can override a closed signup with a reason', async () => {
    status(await mutation(admin, `/v2/wipes/${wipe.id}/signups/g04_beta`, {
      ...signupBody(1, wipe.contentRevision, 'not_attending'), reason: 'Controlled post-close correction'
    }, randomUUID(), 'PUT'), 200);
    status(await mutation(admin, `/v2/wipes/${wipe.id}/my-signup`, signupBody(0, wipe.contentRevision), randomUUID(), 'PUT'), 403);
  });
  await check('Reopen and material reschedule reject stale content confirmation', async () => {
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}/commands/reopen-signup`, {
      expectedRevision: wipe.revision, closesAt: new Date(Date.now() + 10_800_000).toISOString(), reason: 'Reopen locally'
    }), 200));
    const oldContentRevision = wipe.contentRevision;
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}`, {
      expectedRevision: wipe.revision, musterAt: new Date(Date.now() + 4_500_000).toISOString()
    }, randomUUID(), 'PATCH'), 200));
    assert.equal(wipe.contentRevision, oldContentRevision + 1);
    status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, signupBody(2, oldContentRevision), randomUUID(), 'PUT'), 409, 'CONTENT_RECONFIRM_REQUIRED');
    currentSignup = status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, signupBody(2, wipe.contentRevision), randomUUID(), 'PUT'), 200).current;
    assert.equal(currentSignup.signupRevision, 3);
  });
  await check('Summary and scoped roster agree and contain no foreign member or sensitive fields', async () => {
    const summary = status(await request(admin, `/v2/wipes/${wipe.id}/summary`), 200);
    const roster = status(await request(admin, `/v2/wipes/${wipe.id}/signups`), 200);
    assert.equal(summary.counts.eligibleTotal, 2);
    assert.equal(summary.counts.eligibleTotal, summary.counts.unanswered + summary.counts.responseTotal);
    assert.equal(summary.rosterRevision, roster.rosterRevision);
    assert.equal(JSON.stringify(roster).includes('g04_foreign'), false);
    const ownRoster = status(await request(alpha, `/v2/wipes/${wipe.id}/signups`), 200);
    assert.equal(JSON.stringify(ownRoster).includes('g04_beta'), false);
    assert.equal(/passwordHash|csrfHash|permissionVersion|steamId/.test(JSON.stringify(ownRoster)), false);
  });
  await check('Start preserves unknown actual times; aborted end has a settlement and archive exit', async () => {
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}/commands/start`, { expectedRevision: wipe.revision }), 200));
    assert.equal(wipe.lifecycle, 'active'); assert.equal(wipe.actualStartedAt, null); assert.equal(wipe.serverActualWipeAt, null);
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}/commands/end`, {
      expectedRevision: wipe.revision, outcome: 'aborted', reason: 'Controlled interrupted event'
    }), 200));
    assert.equal(wipe.lifecycle, 'ended'); assert.equal(wipe.outcome, 'aborted'); assert.ok(wipe.settlementStatus);
    status(await mutation(admin, `/v2/wipes/${wipe.id}/signups/g04_beta`, {
      ...signupBody(2, wipe.contentRevision), reason: 'Cannot override ended lifecycle'
    }, randomUUID(), 'PUT'), 409, 'WIPE_IMMUTABLE');
    wipe = wipeOf(status(await mutation(admin, `/v2/wipes/${wipe.id}/commands/archive`, {
      expectedRevision: wipe.revision, reason: 'Archive with explicit missing-data disclosure', completeness: 'partial'
    }), 200));
    assert.equal(wipe.lifecycle, 'archived');
    status(await mutation(admin, `/v2/wipes/${wipe.id}`, { expectedRevision: wipe.revision, description: 'Must not mutate archive' }, randomUUID(), 'PATCH'), 409, 'WIPE_IMMUTABLE');
  });
  await check('A successful receipt cannot bypass current account revocation', async () => {
    const account = identityRepo.get('accounts', fixtures[0].accountId);
    identityRepo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
    status(await mutation(alpha, `/v2/wipes/${wipe.id}/my-signup`, firstBody, firstKey, 'PUT'), 401);
  });
  await check('A valid legacy Web cookie alone cannot authorize V2 or old member routes', async () => {
    const { createSession } = await import('../../../server/auth.js');
    const legacyClient = { jar: new Map([['nb_session', await createSession('user_root')]]) };
    status(await request(legacyClient, '/v2/wipes'), 401);
    status(await request(legacyClient, '/members'), 401);
  });
  await check('Old WeChat scheduling mutations return 410 and cannot write legacy or V2 signups', async () => {
    const beforeV2 = JSON.stringify(schedulingRepo.all('signups'));
    const beforeLegacy = JSON.stringify((await readStore()).wipeParticipants);
    for (const [route, method] of [
      ['/wechat/admin/wipes', 'POST'], [`/wechat/admin/wipes/${wipe.id}`, 'PATCH'], [`/wechat/wipes/${wipe.id}/signup`, 'POST']
    ]) status(await request(anonymous, route, { method, body: { status: 'join' } }), 410, 'LEGACY_SCHEDULING_READONLY');
    assert.equal(JSON.stringify(schedulingRepo.all('signups')), beforeV2);
    assert.equal(JSON.stringify((await readStore()).wipeParticipants), beforeLegacy);
  });
  await check('Discord verifies the signature before directing an old card to confirmation, without a signup write', async () => {
    const beforeV2 = JSON.stringify(schedulingRepo.all('signups'));
    const beforeLegacy = JSON.stringify((await readStore()).wipeParticipants);
    const body = { id: randomUUID(), type: 3, data: { custom_id: `nb_wipe_signup:join:${wipe.id}` },
      member: { user: { id: 'discord_g04_alpha' } } };
    status(await request(anonymous, '/integrations/discord/interactions', { method: 'POST', body }), 401);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + JSON.stringify(body)), privateKey).toString('hex');
    const reply = await request(anonymous, '/integrations/discord/interactions', { method: 'POST', body,
      extraHeaders: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
    assert.equal(reply.status, 200); assert.equal(reply.payload.type, 4); assert.equal(reply.payload.data.flags, 64);
    assert.match(reply.payload.data.content, /网站确认/); assert.ok(reply.payload.data.content.includes(wipe.id));
    assert.equal(JSON.stringify(schedulingRepo.all('signups')), beforeV2);
    assert.equal(JSON.stringify((await readStore()).wipeParticipants), beforeLegacy);
  });
  await check('Committed revisions have durable audit, receipt, outbox and immutable snapshots in SQLite', async () => {
    const signups = schedulingRepo.forWipe('signups', wipe.id);
    assert.equal(signups.length, 2);
    const receipts = schedulingRepo.all('receipts');
    assert.ok(receipts.length > 5); assert.ok(schedulingRepo.forWipe('events', wipe.id).length > 5);
    assert.ok(schedulingRepo.forWipe('outbox', wipe.id).length > 5);
    assert.equal(schedulingRepo.forWipe('archives', wipe.id).length, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    evidence.rows = Object.fromEntries(['wipes', 'signups', 'contents', 'archives', 'events', 'outbox', 'receipts']
      .map(name => [name, schedulingRepo.all(name).length]));
    evidence.finalWipe = { id: wipe.id, lifecycle: wipe.lifecycle, revision: wipe.revision, contentRevision: wipe.contentRevision };
    evidence.receiptHash = createHash('sha256').update(JSON.stringify(firstSignup.operationReceipt)).digest('hex');
  });
  evidence.passed = true;
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
} finally {
  stopBackgroundJobs(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await drainStoreWrites(); await closeSqliteDatabases();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(path.join(runDir, 'runtime.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence, null, 2));
