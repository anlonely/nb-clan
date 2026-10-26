import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { createMiniMemberViews } from '../server/v2/management-adapters/platforms/mini-members.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { platformRoleContext } from '../server/v2/identity/role-specialties.js';
import { PlatformAdminRepository, installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';

const community = { available: true, name: 'RSG 战队', iconUrl: 'https://img.kookapp.cn/assets/guild.png',
  roles: [{ id: 'held', name: '一队队员' }, { id: 'not-held', name: '不属于我的角色' }] };

function memberFixture(t) {
  const f = fixture(); t.after(() => f.close());
  const checkedAt = new Date(f.now()).toISOString();
  f.ir.put('identities', { id: 'community-kook', provider: 'kook', accountId: 'member', externalId: '1686000000000000', verifiedAt: checkedAt });
  f.ir.put('policies', { id: 'community-policy', provider: 'kook', enabled: true, guildId: 'guild-1', policyRevision: 4,
    allowedRoleIds: ['allowed-but-not-held'] });
  const proof = { id: 'community-evidence', provider: 'kook', externalId: '1686000000000000', guildId: 'guild-1', policyRevision: 4,
    status: 'eligible', roleIds: ['held', 'held', 'unknown-role'], checkedAt, communityCheckedAt: checkedAt,
    expiresAt: new Date(f.now() + 300000).toISOString(), community };
  f.ir.put('eligibility', proof);
  const views = createMiniMemberViews(f);
  return { ...f, proof, read: () => views.home({ actor: f.actor('member') }) };
}

async function linkPage(home) {
  const file = fileURLToPath(new URL('../wechat-miniprogram/miniprogram/pages/link/index/index.js', import.meta.url));
  const localRequire = createRequire(file);
  const api = { communityAvatarDisplayUrl: async () => 'wxfile://kook-avatar', ensureCanEnterApp: async () => ({ complete: true, linked: true }), readCommand: async name => {
    assert.equal(name, 'member_home'); return home;
  } };
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { definition = value; },
    require: request => request.endsWith('/services/api') ? api : localRequire(request),
    wx: { removeStorageSync() {} }, Date, setInterval, clearInterval });
  const page = { ...definition, active: true, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  await page.load();
  return page;
}

test('mini KOOK card displays verified community metadata and only the current users actual named roles', async t => {
  const f = memberFixture(t), home = f.read();
  const dto = home.identities.find(row => row.provider === 'kook');
  assert.equal(dto.communityName, 'RSG 战队');
  assert.equal(dto.communityAvatarUrl, community.iconUrl);
  assert.equal(dto.communityStatus, 'fresh');
  assert.deepEqual(dto.roles, [{ id: 'held', name: '一队队员' }, { id: 'unknown-role', name: '' }]);
  assert.ok(!JSON.stringify(dto).includes('allowed-but-not-held'));
  assert.ok(!JSON.stringify(dto).includes('不属于我的角色'));
  const page = await linkPage(home), card = page.data.identities.find(row => row.provider === 'kook');
  assert.equal(card.communityName, 'RSG 战队');
  assert.equal(card.displayAvatar, 'wxfile://kook-avatar');
  assert.deepEqual(Array.from(card.roles, row => row.name), ['一队队员']);
  assert.equal(card.rolesNote, '1 个角色名待同步');
  assert.notEqual(card.displayName, dto.externalId);
  assert.equal(card.accountName, '');
  page.avatarError({ currentTarget: { dataset: { provider: 'kook' } } });
  assert.equal(page.data.identities.find(row => row.provider === 'kook').displayAvatar, '');
});

test('missing community data and raw role IDs are honest placeholders instead of displayed names', async t => {
  const f = memberFixture(t);
  f.ir.put('eligibility', { ...f.proof, community: { available: false, name: '', roles: [] }, communityCheckedAt: null });
  const home = f.read(), dto = home.identities.find(row => row.provider === 'kook');
  assert.equal(dto.communityStatus, 'unavailable');
  assert.equal(dto.communityAvatarUrl, '');
  const page = await linkPage(home), card = page.data.identities.find(row => row.provider === 'kook');
  assert.equal(card.communityName, '暂无服务器资料');
  assert.equal(card.roles.length, 0);
  assert.match(card.rolesNote, /2 个角色名待同步/);
  const unlinked = page.data.identities.find(row => row.provider === 'discord');
  assert.equal(unlinked.communityName, '尚未关联');
});

test('community display freshness follows metadata observation, never a newer role-only refresh', async t => {
  const f = memberFixture(t);
  const { communityCheckedAt, ...legacy } = f.proof;
  f.ir.put('eligibility', legacy);
  const oldRecord = f.read().identities.find(row => row.provider === 'kook');
  assert.equal(oldRecord.communityAvatarUrl, community.iconUrl);
  assert.equal(oldRecord.communityUpdatedAt, legacy.checkedAt);
  assert.equal(oldRecord.communityStatus, 'fresh');
  f.ir.put('eligibility', { ...f.proof, communityCheckedAt: new Date(f.now() - 300001).toISOString() });
  const home = f.read(), dto = home.identities.find(row => row.provider === 'kook');
  assert.equal(dto.rolesStatus, 'stale'); assert.equal(dto.communityStatus, 'stale');
  const page = await linkPage(home), card = page.data.identities.find(row => row.provider === 'kook');
  assert.match(card.communityNote, /较旧/); assert.match(card.rolesNote, /较旧/);
  f.ir.put('policies', { ...f.ir.get('policies', 'community-policy'), guildId: 'different-guild', policyRevision: 5 });
  assert.equal(f.read().identities.find(row => row.provider === 'kook').communityName, '');
});

function eligibilityFixture(t) {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db); t.after(() => db.close());
  const repo = new IdentityRepository(db);
  let now = Date.parse('2026-09-25T00:00:00.000Z'), roleIds = ['held', 'not-held'], metadata = community;
  repo.put('policies', { id: 'kook-policy', provider: 'kook', enabled: true, guildId: 'guild-1', policyRevision: 1,
    allowedRoleIds: ['held'], matchMode: 'any' });
  const service = new IdentityService(repo, { now: () => now, providers: { kook: { roles: async (externalId, guildId, options) =>
    ({ externalId, guildId, roleIds, ...(options.includeCommunity ? { community: metadata } : {}) }) } } });
  return { repo, service, advance: () => { now += 300001; }, roles: value => { roleIds = value; }, metadata: value => { metadata = value; } };
}

test('ordinary eligibility refresh retains same-scope display metadata at its original time and intersects current roles', async t => {
  const f = eligibilityFixture(t), first = await f.service.checkEligibility('kook', '1686', { includeCommunity: true });
  installPlatformAdminSchema(f.repo.db);
  new PlatformAdminRepository(f.repo.db).put('config', 'kook', 'kook', '', 0, {});
  assert.equal(platformRoleContext(f.repo.db, first).matches({ roleName: '一队队员' }), true);
  f.advance(); f.roles(['held', 'new-role']);
  const current = await f.service.checkEligibility('kook', '1686');
  assert.equal(current.community.name, community.name);
  assert.equal(current.community.iconUrl, community.iconUrl);
  assert.equal(current.communityCheckedAt, first.checkedAt);
  assert.notEqual(current.checkedAt, first.checkedAt);
  assert.deepEqual(current.roleIds, ['held', 'new-role']);
  assert.deepEqual(current.community.roles, [{ id: 'held', name: '一队队员' }]);
  assert.equal(current.community.displayOnly, true);
  assert.equal(platformRoleContext(f.repo.db, current).matches({ roleName: '一队队员' }), false);
  assert.equal(platformRoleContext(f.repo.db, current).matches({ guildId: 'guild-1', roleId: 'held' }), true);
  f.metadata({ available: false, name: '', iconUrl: null, roles: [] });
  const unavailable = await f.service.checkEligibility('kook', '1686', { includeCommunity: true });
  assert.equal(unavailable.communityCheckedAt, first.checkedAt);
  assert.equal(unavailable.community.name, community.name);
  f.roles([]);
  await assert.rejects(f.service.checkEligibility('kook', '1686'), { errorCode: 'ELIGIBILITY_DENIED' });
  const denied = f.repo.get('eligibility', first.id);
  assert.equal(denied.status, 'ineligible');
  assert.deepEqual(denied.community.roles, []);
});

test('different identity, guild or policy revision never reuses community metadata', async t => {
  const f = eligibilityFixture(t);
  await f.service.checkEligibility('kook', '1686', { includeCommunity: true });
  assert.equal((await f.service.checkEligibility('kook', 'another-user')).community, undefined);
  const policy = f.repo.get('policies', 'kook-policy');
  f.repo.put('policies', { ...policy, guildId: 'another-guild' });
  assert.equal((await f.service.checkEligibility('kook', '1686')).community, undefined);
  f.repo.put('policies', policy);
  await f.service.checkEligibility('kook', '1686', { includeCommunity: true });
  f.repo.put('policies', { ...policy, policyRevision: 2 });
  assert.equal((await f.service.checkEligibility('kook', '1686')).community, undefined);
});
