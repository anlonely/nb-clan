import test from 'node:test';
import { authenticatedSession } from './support/authenticated-session.mjs';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { MINI_DOMAIN_COMMANDS, MINI_RETIRED_COMMANDS } from '../server/v2/platform-admin/mini-program.js';
import { DOMAIN_GAPS } from '../server/v2/management-adapters/platforms/index.js';
import { createPlatformDomainAdapters } from '../server/v2/management-adapters/platforms/domains.js';
import { SystemAdminService } from '../server/v2/system-admin/service.js';
import { migrateSystemAdmin } from '../server/v2/system-admin/repository.js';
import { IdentityError } from '../server/v2/identity/errors.js';

async function setup(t) { const f = fixture(); t.after(() => f.close()); await f.start(); const session = await f.login('admin');
  return { ...f, call: (command, input = {}, operationId) => f.command(session.token, command, input, operationId) }; }

test('command inventory has concrete bridges or a named domain/external owner gap', async t => {
  const f = await setup(t), capabilities = f.host.mini.capabilities();
  assert.equal(capabilities.commands.length, Object.keys(MINI_DOMAIN_COMMANDS).length);
  assert.deepEqual(capabilities.commands.filter(c => !c.available).map(c => c.id).sort(), Object.keys(DOMAIN_GAPS).filter(id => Object.hasOwn(MINI_DOMAIN_COMMANDS, id)).sort());
  for (const command of Object.keys(DOMAIN_GAPS).filter(id => Object.hasOwn(MINI_DOMAIN_COMMANDS, id))) await assert.rejects(() => f.call(command), e => e.errorCode === DOMAIN_GAPS[command]);
  for (const command of MINI_RETIRED_COMMANDS) {
    assert.equal(capabilities.commands.some(row => row.id === command), false);
    await assert.rejects(() => f.call(command), e => e.errorCode === 'MINI_MANAGEMENT_RETIRED');
  }
  assert.equal((await f.call('servers')).items[0].id, 'host-server');
  assert.ok((await f.call('specialties')).specialties.pvp);
  const member = await f.login(); assert.equal((await f.command(member.token, 'access_status')).memberId, 'm002');
});

test('retired member and squad management cannot enqueue or mutate canonical state', async t => {
  const f = await setup(t), baseline = f.queueLog.length;
  const before = { members: f.ir.all('members'), squads: f.ir.all('squads'), accounts: f.ir.all('accounts') };
  for (const command of ['member_status', 'member_specialty', 'member_squad', 'member_delete', 'squad_save', 'squad_delete']) {
    await assert.rejects(() => f.call(command, { memberId: 'm003', expectedRevision: 1, specialty: ['pvp'], squadId: 's2', reason: 'retired request' }), e => e.errorCode === 'MINI_MANAGEMENT_RETIRED');
  }
  assert.equal(f.queueLog.length, baseline);
  assert.deepEqual({ members: f.ir.all('members'), squads: f.ir.all('squads'), accounts: f.ir.all('accounts') }, before);
});

test('retired scheduling management cannot create wipes or delegated signups', async t => {
  const f = await setup(t), baseline = f.queueLog.length, before = { wipes: f.sr.all('wipes'), signups: f.sr.all('signups') };
  for (const command of ['wipe_create', 'wipe_edit', 'wipe_publish', 'wipe_close_signup', 'wipe_open', 'wipe_end', 'participant_save', 'participant_remove']) {
    await assert.rejects(() => f.call(command, { wipeId: 'host-wipe', memberId: 'm002', expectedRevision: 1 }), e => e.errorCode === 'MINI_MANAGEMENT_RETIRED');
  }
  assert.equal(f.queueLog.length, baseline);
  assert.deepEqual({ wipes: f.sr.all('wipes'), signups: f.sr.all('signups') }, before);
});

test('query/export management is retired while self profile refresh keeps its durable owner', async t => {
  const f = await setup(t);
  for (const command of ['query', 'export']) await assert.rejects(() => f.call(command, { sourceId: 'official', steamInput: '76561198000000002', format: 'json' }), e => e.errorCode === 'MINI_MANAGEMENT_RETIRED');
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_stats_jobs').get().n, 0);
  const member = await f.login('leader');
  await assert.rejects(() => f.command(member.token, 'profile_refresh', { expectedRevision: 1 }), e => e.errorCode === 'ACCESS_DENIED');
  assert.equal(f.sync.list(f.actor('admin')).items.length, 0);
  // Only a real administrator with its own verified member binding has sync.run.
  await authenticatedSession(f.identity, 'admin');
  const admin = await f.login('admin'), refresh = await f.command(admin.token, 'profile_refresh', { expectedRevision: 1 });
  assert.equal(refresh.job.type, 'steam_profile_backfill'); assert.deepEqual(refresh.job.scope.memberIds, [f.actor('admin').memberId]);
  await assert.rejects(() => f.command(admin.token, 'profile_refresh', { memberId: 'm002' }), e => e.errorCode === 'MINI_SELF_PROFILE_ONLY');
});

test('optional shared SystemAdminService log projection and denial retain their domain error status', async t => {
  const f = await setup(t); migrateSystemAdmin(f.db, { apply: true });
  // This read path does not use the write owner, credential or storage ports.
  const system = new SystemAdminService({ identity: f.identity, identityAdmin: { identity: f.identity }, owner: {}, storage: {} });
  const domain = createPlatformDomainAdapters({ ...f, system });
  const value = domain.mini.admin.logs({ actor: f.actor('admin'), input: {} });
  assert.ok(Array.isArray(value.items));
  assert.throws(() => domain.mini.admin.logs({ actor: f.actor('member'), input: {} }), e => e instanceof IdentityError && e.status === 403);
});
