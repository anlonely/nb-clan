import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { createManagementSourceAdapters, installSourceAdapterSchema } from '../server/v2/management-adapters/sources/index.js';
import { SyncCenterService } from '../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';
import { installStatsSchema } from '../server/v2/stats/repository.js';
import { installSchedulingSchema } from '../server/v2/scheduling/repository.js';

const memberId = 'g05_alpha';
const discordId = '123456789012345678', guildId = '223456789012345678';
const roles = ['323456789012345678', '423456789012345678'];
const scope = { kind: 'members', memberIds: [memberId] };
const operation = () => ({ operationId: randomUUID() });

async function setup(t) {
  const base = fixture();
  await base.worker.stop();
  installSourceAdapterSchema(base.db);
  installStatsSchema(base.db);
  installSchedulingSchema(base.db);
  base.repo.put('members', { ...base.repo.get('members', memberId), discordUserId: discordId });
  base.repo.put('identities', { ...base.repo.get('identities', 'discord_alpha'), externalId: discordId });
  base.repo.put('policies', { ...base.repo.all('policies').find(row => row.provider === 'discord'),
    guildId, allowedRoleIds: roles, matchMode: 'all', policyRevision: 2 });
  base.repo.put('policies', { ...base.repo.all('policies').find(row => row.provider === 'kook'), enabled: false });
  let actualRoleIds = [...roles], unavailable = false, clock = Date.now();
  const calls = [];
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (unavailable) return new Response('{}', { status: 503 });
    if (path === `/api/v10/guilds/${guildId}/roles`) return Response.json([
      { id: guildId, name: '@everyone' }, ...roles.map((id, i) => ({ id, name: `准入${i + 1}` }))
    ]);
    if (path === `/api/v10/guilds/${guildId}/members/${discordId}`) return Response.json({
      user: { id: discordId, username: 'Original', avatar: 'a_0123456789abcdef0123456789abcdef' },
      nick: '战队昵称', roles: actualRoleIds
    });
    return new Response('{}', { status: 404 });
  };
  const host = createSourceHost({ fetchImpl, readSettings: () => ({ discord: { botToken: 'isolated-test-token' } }),
    readWipe: () => null, capabilities: { discordMembershipAudit: true },
    readDiscordContext: id => ({ policy: base.repo.all('policies').find(row => row.provider === 'discord'),
      externalId: id === memberId ? base.repo.get('identities', 'discord_alpha').externalId : '' }) });
  const adapters = createManagementSourceAdapters({ identity: base.identity, ...host,
    runWrite: fn => fn(), patchCache: () => {} });
  const service = new SyncCenterService({ db: base.db, identity: base.identity, authority: adapters.authority,
    now: () => clock });
  const worker = createSyncCenterWorker(service, { providers: adapters.providers });
  await service.saveSource(base.actor(), 'discord', { expectedRevision: 1, minIntervalMs: 0 }, operation());
  t.after(async () => { await worker.stop(); host.stop(); await base.close(); });
  const run = async () => {
    const { job } = await service.request(base.actor(), { type: 'discord_membership_audit', scope }, operation());
    await worker.step();
    return service.detail(base.actor(), job.id);
  };
  return { ...base, host, service, worker, run, calls,
    setRoles: ids => { actualRoleIds = ids; }, setUnavailable: value => { unavailable = value; },
    advance: ms => { clock += ms; } };
}

test('Discord member update applies all-role admission, locks on confirmed loss and unlocks after recovery', async t => {
  const f = await setup(t);
  const config = f.service.authority.resolveScope({ actor: f.actor(), type: 'discord_membership_audit', scope }).scope;
  assert.equal(config.sourceContexts[memberId].guildId, guildId);

  f.setRoles([roles[0]]);
  const member = f.repo.get('members', memberId);
  const source = f.host.readSourceConfig({ type: 'discord_membership_audit', scope, member });
  assert.equal(source.enabled, true);
  const observed = await f.host.readers.discordMembership({ member, config: source });
  assert.equal(observed.status, 'missing_role', JSON.stringify(observed));
  const first = await f.run();
  assert.equal(first.status, 'succeeded', JSON.stringify(first.items));
  assert.equal(f.repo.get('members', memberId).discordMembershipStatus, 'missing_role');
  assert.equal(f.repo.get('members', memberId).discordId, discordId);
  assert.equal(f.repo.get('members', memberId).discordName, '战队昵称');
  assert.equal(f.repo.get('members', memberId).discordAvatarHash, 'a_0123456789abcdef0123456789abcdef');
  assert.equal(f.repo.get('accounts', 'g05_account_alpha').roleAccessLock.reason, 'community_role_missing');
  const audit = f.db.prepare("SELECT payload_json FROM json_records WHERE collection='v2CommunityRoleAudits' AND id=?")
    .get(`${memberId}:discord`);
  assert.deepEqual(JSON.parse(audit.payload_json).expectedRoleIds, roles);
  assert.deepEqual(JSON.parse(audit.payload_json).actualRoleIds, [roles[0]]);

  f.setUnavailable(true);
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.repo.get('members', memberId).discordMembershipStatus, 'check_failed');
  assert.ok(f.repo.get('accounts', 'g05_account_alpha').roleAccessLock);

  f.setUnavailable(false);
  f.setRoles(roles);
  assert.equal((await f.run()).status, 'succeeded');
  assert.equal(f.repo.get('accounts', 'g05_account_alpha').roleAccessLock, null);
  assert.equal(f.repo.get('members', memberId).discordMembershipStatus, 'valid');
  assert.ok(f.calls.includes(`/api/v10/guilds/${guildId}/members/${discordId}`));
});

test('Discord member update can run from an automatic plan', async t => {
  const f = await setup(t);
  const { rule } = await f.service.saveRule(f.actor(), null, {
    expectedRevision: 0, name: '每小时更新 Discord 成员资料', type: 'discord_membership_audit', scope,
    intervalMinutes: 60, enabled: true
  }, operation());
  f.advance(60 * 60_000 + 1);
  const scheduled = await f.service.tick();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].job.trigger, 'auto');
  await f.worker.step();
  assert.equal(f.service.detail(f.actor(), scheduled[0].job.id).status, 'succeeded');
  assert.equal(f.service.rules(f.actor()).items.find(item => item.id === rule.id).enabled, true);
});
