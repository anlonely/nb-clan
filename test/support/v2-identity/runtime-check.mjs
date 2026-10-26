import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { migrateCopy } from './migrate.mjs';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';

const runDir = process.env.G03_RUN_DIR;
assert.ok(runDir && process.env.NB_DISABLE_BACKGROUND_JOBS === '1' && process.env.NB_V2_IDENTITY_ENABLED === '1');
const { ensureStore, readStore, updateStore, drainStoreWrites } = await import('../../../server/store.js');
const { openSqliteDatabase, closeSqliteDatabases } = await import('../../../server/storage/sqlite.js');
await ensureStore();
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
await updateStore(store => {
  store.members.push({ id: 'fixture_paused', steamId: '76561198000000002', memberStatus: 'suspended', steamNickname: '隔离暂停成员' });
  store.members.push({ id: 'fixture_blocked', steamId: '76561198000000003', memberStatus: 'blocked', steamNickname: '隔离限制成员' });
  store.discordMemberApplications.push({ id: 'legacy_pending', status: 'pending', steamId: '76561198000000004', discordUserId: 'fixture_discord' });
  store.settings.discord.publicKey = rawPublicKey;
  store.users.push({ id: 'duplicate_a', username: 'fixture_a', role: 'member', boundSteamId: '76561198000000002' },
    { id: 'duplicate_b', username: 'fixture_b', role: 'leader', boundSteamId: '76561198000000002' });
  store.members.push({ id: 'verified_kook', steamId: '76561198000000005', memberStatus: 'active', kookAccountId: 'fixture_kook' });
  store.users.push({ id: 'verified_user', username: 'fixture_kook', role: 'admin', boundSteamId: '76561198000000005', kookId: 'fixture_kook',
    loginProviders: { kook: { id: 'fixture_kook', verifiedSteamId: '76561198000000005', steamVerifiedAt: '2026-09-01T00:00:00Z' } } });
});
const legacy = await readStore();
const source = path.join(runDir, 'constructed-legacy.json');
await writeFile(source, JSON.stringify(legacy));
const planned = await migrateCopy({ source, output: path.join(runDir, 'dry-run') });
const migrated = await migrateCopy({ source, output: path.join(runDir, 'migration'), mode: 'apply' });
assert.equal(planned.sourceUnchanged, true); assert.equal(migrated.integrity, 'ok'); assert.equal(migrated.replay.replayed, true);
const check = new DatabaseSync(migrated.candidate, { readOnly: true });
try {
  const repo = new IdentityRepository(check);
  assert.equal(repo.get('members', 'fixture_paused').membershipStatus, 'paused');
  assert.equal(repo.all('restrictions').some(r => r.memberId === 'fixture_blocked'), true);
  assert.equal(repo.all('applications').find(a => a.id === 'legacy_pending').status, 'pending');
  assert.equal(repo.get('accounts', 'duplicate_a').memberId, null);
  assert.equal(repo.all('conflicts').some(c => c.kind === 'DUPLICATE_MEMBER_ACCOUNTS'), true);
  assert.equal(repo.all('bindings').find(b => b.accountId === 'verified_user').status, 'verified');
} finally { check.close(); }

const db = await openSqliteDatabase(); installIdentitySchema(db); const repo = new IdentityRepository(db);
applyIdentityMigration(repo, planIdentityMigration(legacy));
const app = express(), server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.NB_V2_PUBLIC_ORIGIN = origin;
const { createApiRouter, stopBackgroundJobs } = await import('../../../server/api.js');
app.use('/api', createApiRouter());
app.get('/api/v2/fixture-g04-access', async (req, res) => {
  try { const { actor } = await req.v2Identity.authenticate(); res.json({ accountId: actor.id }); }
  catch (error) { res.status(error.status || 503).json({ errorCode: error.errorCode }); }
});
const evidence = { scope: 'real application router, isolated SQLite, no external authentication', checks: [], origin, migration: {
  sourceUnchanged: migrated.sourceUnchanged, counts: migrated.counts, replayed: migrated.replay.replayed, integrity: migrated.integrity } };
const jar = new Map();
async function request(route, options = {}) {
  const response = await fetch(`${origin}/api${route}`, { redirect: 'manual', ...options, headers: {
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin, 'content-type': 'application/json', ...options.headers } });
  for (const line of response.headers.getSetCookie()) { const [key, value] = line.split(';')[0].split('='); value ? jar.set(key, value) : jar.delete(key); }
  const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  evidence.checks.push({ route, status: response.status }); return { response, payload };
}
try {
  const migrationMarker = repo.scalar('v2IdentityMigration');
  db.prepare('DELETE FROM json_scalars WHERE key=?').run('v2IdentityMigration');
  assert.equal((await request('/v2/auth/providers')).response.status, 503);
  repo.setScalar('v2IdentityMigration', migrationMarker);
  const login = await request('/v2/auth/password', { method: 'POST', body: JSON.stringify({ username: 'root', password: process.env.NB_ROOT_PASSWORD }) });
  assert.equal(login.response.status, 200);
  const me = await request('/v2/auth/me'); assert.equal(me.payload.data.accountId, 'user_root');
  const csrf = me.payload.data.csrfToken;
  assert.equal((await request('/v2/fixture-g04-access')).payload.accountId, 'user_root');
  const policies = await request('/v2/identity/policies'); assert.equal(policies.payload.data.policies.length, 2);
  const archive = await request('/v2/identity/legacy-discord-applications');
  assert.equal(archive.payload.data.mode, 'legacy_readonly'); assert.equal(archive.payload.data.applications[0].status, 'pending');
  const { createSession } = await import('../../../server/auth.js');
  jar.set('nb_session', await createSession('user_root'));
  assert.equal((await request('/members')).response.status, 401);
  jar.delete('nb_session');
  const members = await request('/v2/members'); assert.equal(members.response.status, 200);
  assert.equal(JSON.stringify(members.payload).includes('passwordHash'), false);
  const legacySubmit = await request('/settings/discord/member-registration-card', { method: 'POST', body: '{}' });
  assert.equal(legacySubmit.response.status, 410);
  const legacyReview = await request('/third-party/admin/discord-member-applications/legacy_pending/review', { method: 'POST', body: '{"status":"approved"}' });
  assert.equal(legacyReview.response.status, 410);
  assert.equal(repo.all('applications')[0].status, 'pending');
  // Real signed Discord interaction route, with an isolated key and no outbound message request.
  for (const customId of ['nb_member_register:open', 'nb_member_register:submit:pvp', 'nb_member_review:approved:legacy_pending']) {
    const body = JSON.stringify({ id: `fixture-${customId}`, type: customId.includes('submit') ? 5 : 3, data: { custom_id: customId }, member: { user: { id: 'fixture_discord' } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
    const reply = await request('/integrations/discord/interactions', { method: 'POST', body,
      headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
    assert.equal(reply.response.status, 200); assert.match(reply.payload.data.content, /已封存/);
  }
  assert.equal(repo.all('applications').find(a => a.id === 'legacy_pending').status, 'pending');
  const oldLogin = await request('/auth/discord/start'); assert.equal(oldLogin.response.status, 303);
  const noGrant = await request('/v2/identity/policies', { method: 'PUT', headers: { 'x-csrf-token': csrf }, body: JSON.stringify({
    provider: 'discord', guildId: 'fixture-guild', allowedRoleIds: ['fixture-role'], enabled: true, defaultRoleId: 'admin', matchMode: 'any', expectedRevision: 1 }) });
  assert.equal(noGrant.response.status, 422);
  const logout = await request('/v2/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrf }, body: '{}' }); assert.equal(logout.response.status, 200);
  assert.equal((await request('/v2/auth/me')).response.status, 401);
} finally {
  stopBackgroundJobs(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await drainStoreWrites(); await closeSqliteDatabases();
  await writeFile(path.join(runDir, 'runtime.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
