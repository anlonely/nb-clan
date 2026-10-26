import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { installPlatformAdminSchema, PlatformAdminRepository } from '../server/v2/platform-admin/repository.js';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { createManagementSourceAdapters, installSourceAdapterSchema } from '../server/v2/management-adapters/sources/index.js';
import { SyncCenterService } from '../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';
import { installStatsSchema } from '../server/v2/stats/repository.js';
import { installSchedulingSchema } from '../server/v2/scheduling/repository.js';

const scope = { kind: 'members', memberIds: ['g05_alpha'] };
const operation = () => ({ operationId: randomUUID() });

async function setup(t) {
  const base = fixture();
  await base.worker.stop();
  installSourceAdapterSchema(base.db);
  installStatsSchema(base.db);
  installSchedulingSchema(base.db);
  base.repo.put('policies', { ...base.repo.all('policies').find(row => row.provider === 'discord'), enabled: false });
  installPlatformAdminSchema(base.db);
  const platform = new PlatformAdminRepository(base.db);
  const guildId = 'g05_fixture_guild';
  const role = { id: 'pipe-role', name: 'RSC·管道工' };
  const rule = { id: 'pipe-rule', guildId, roleId: role.id, roleName: role.name };
  platform.put('config', 'kook', 'kook', 'g05_account_admin', 1, {
    revision: 1, roleSpecialtyMappings: [{ ...rule, specialty: 'pipe' }],
    roleSquadMappings: [{ ...rule, squadId: 'g05_squad' }],
    roleSystemMappings: [{ ...rule, systemRole: 'admin' }]
  });
  base.repo.remove('squadMembers', 'relation_alpha');
  let roles = ['g05_fixture_role', role.id], failureCode = null, calls = 0;
  const host = createSourceHost({
    fetchImpl: fetch,
    readSettings: () => ({ kook: { botToken: 'isolated-test-bot-token' } }),
    readWipe: () => null,
    readKookContext: memberId => ({
      policy: base.repo.all('policies').find(row => row.provider === 'kook'),
      externalId: base.repo.all('identities').find(row => row.accountId === 'g05_account_alpha' && row.provider === 'kook')?.externalId,
      mappingRevision: platform.get('config', 'kook').revision
    }),
    readKookRoles: async (externalId, requestedGuild, { admissionRoleIds }) => {
      calls++;
      assert.deepEqual(admissionRoleIds, ['g05_fixture_role']);
      assert.equal(requestedGuild, guildId);
      if (failureCode) throw Object.assign(new Error('KOOK unavailable'), { errorCode: failureCode });
      return { externalId, guildId: requestedGuild, roleIds: roles,
        community: { available: true, roles: roles.includes(role.id) ? [role] : [] } };
    },
    capabilities: { kookMemberSync: true }
  });
  const adapters = createManagementSourceAdapters({ identity: base.identity, ...host,
    runWrite: fn => fn(), patchCache: () => {} });
  let clock = Date.now();
  const service = new SyncCenterService({ db: base.db, identity: base.identity, authority: adapters.authority, now: () => clock });
  const worker = createSyncCenterWorker(service, { providers: adapters.providers });
  await service.saveSource(base.actor(), 'kook', { expectedRevision: 1, minIntervalMs: 0 }, operation());
  t.after(async () => { await worker.stop(); host.stop(); await base.close(); });
  const run = async () => {
    const { job } = await service.request(base.actor(), { type: 'kook_member_sync', scope }, operation());
    await worker.step();
    return service.detail(base.actor(), job.id);
  };
  return { ...base, service, worker, run, advance: ms => { clock += ms; },
    setRoles: value => { roles = value; }, setFail: value => { failureCode = value === true ? 'ELIGIBILITY_UNAVAILABLE' : value; }, getCalls: () => calls };
}

test('KOOK scheduled source refreshes role mappings and departure evidence, preserving facts on query failure', async t => {
  const f = await setup(t);
  let job = await f.run();
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.deepEqual(f.repo.get('members', 'g05_alpha').specialty, ['building', 'pipe']);
  assert.deepEqual(f.repo.all('squadMembers').filter(row => row.memberId === 'g05_alpha' && !row.validTo).map(row => row.squadId), ['g05_squad']);
  assert.equal(f.repo.get('accounts', 'g05_account_alpha').roleId, 'admin');
  assert.equal(f.db.prepare("SELECT json_extract(payload_json,'$.status') status FROM json_records WHERE collection='v2CommunityRoleAudits' AND id='g05_alpha:kook'").get().status, 'valid');

  f.setRoles([]);
  job = await f.run();
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.deepEqual(f.repo.get('members', 'g05_alpha').specialty, ['building']);
  assert.equal(f.repo.all('squadMembers').filter(row => row.memberId === 'g05_alpha' && !row.validTo).length, 0);
  assert.equal(f.repo.get('accounts', 'g05_account_alpha').roleId, 'member');
  assert.equal(f.db.prepare("SELECT json_extract(payload_json,'$.status') status FROM json_records WHERE collection='v2CommunityRoleAudits' AND id='g05_alpha:kook'").get().status, 'missing_role');
  assert.equal(f.repo.get('accounts', 'g05_account_alpha').roleAccessLock.reason, 'community_role_missing');

  const before = f.repo.get('members', 'g05_alpha');
  f.setFail(true);
  job = await f.run();
  assert.notEqual(job.status, 'succeeded');
  assert.deepEqual(f.repo.get('members', 'g05_alpha'), before);
  assert.equal(f.db.prepare("SELECT json_extract(payload_json,'$.status') status FROM json_records WHERE collection='v2CommunityRoleAudits' AND id='g05_alpha:kook'").get().status, 'missing_role');
  assert.equal(f.getCalls(), 3);

  f.setFail(false);
  f.setRoles(['g05_fixture_role', 'pipe-role']);
  f.advance(10_000);
  await f.worker.step();
  job = f.service.detail(f.actor(), job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.items));
  assert.equal(f.repo.get('accounts', 'g05_account_alpha').roleAccessLock, null);
});

test('KOOK member update can run from an automatic plan', async t => {
  const f = await setup(t);
  const { rule } = await f.service.saveRule(f.actor(), null, {
    expectedRevision: 0, name: '刷新 KOOK 成员角色', type: 'kook_member_sync', scope,
    intervalMinutes: 5, enabled: true
  }, operation());
  f.advance(5 * 60_000 + 1);
  const scheduled = await f.service.tick();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].job.trigger, 'auto');
  await f.worker.step();
  assert.equal(f.service.detail(f.actor(), scheduled[0].job.id).status, 'succeeded');
  assert.equal(f.service.rules(f.actor()).items.find(item => item.id === rule.id).enabled, true);
});

test('invalid KOOK admission role pauses its source without changing member evidence', async t => {
  const f = await setup(t);
  f.setFail('ADMISSION_ROLE_CONFIG_INVALID');
  const job = await f.run();
  assert.equal(job.status, 'paused');
  assert.equal(job.items[0].reason, 'ADMISSION_ROLE_CONFIG_INVALID');
  assert.equal(f.service.sourceStatus('kook').pauseReason, 'ADMISSION_ROLE_CONFIG_INVALID');
  assert.equal(f.repo.get('members', 'g05_alpha').kookRoleSync, undefined);
});
