import { randomBytes } from 'node:crypto';
import { IdentityError } from '../../../server/v2/identity/errors.js';
import { MEMBER_GRANTS, CAPABILITIES, grant } from '../../../server/v2/identity/permissions.js';

export const fixtures = Object.freeze([
  { key: 'alpha', accountId: 'g05_account_alpha', memberId: 'g05_alpha', steamId: '76561198000000501', squadId: 'g05_squad', displayName: '阿北', roleId: 'member' },
  { key: 'beta', accountId: 'g05_account_beta', memberId: 'g05_beta', steamId: '76561198000000502', squadId: 'g05_squad', displayName: '小林', roleId: 'member' },
  { key: 'leader', accountId: 'g05_account_leader', memberId: 'g05_leader', steamId: '76561198000000503', squadId: 'g05_squad', displayName: '周队', roleId: 'leader' },
  { key: 'admin', accountId: 'g05_account_admin', memberId: 'g05_admin', steamId: '76561198000000504', squadId: 'g05_squad', displayName: '值班管理员', roleId: 'admin' },
  { key: 'foreign', accountId: 'g05_account_foreign', memberId: 'g05_foreign', steamId: '76561198000000505', squadId: 'g05_foreign_squad', displayName: '另一队成员', roleId: 'member' },
  { key: 'new', accountId: null, memberId: null, steamId: '76561198000000506', squadId: null, displayName: '新队员', roleId: 'member' },
  { key: 'denied', accountId: null, memberId: null, steamId: '76561198000000507', squadId: null, displayName: '无平台资格', roleId: 'member' }
]);
export function seedIdentities(repo) {
  const now = new Date().toISOString();
  repo.transaction(() => {
    repo.put('squads', { id: 'g05_squad', name: '北境一队', description: '固定晚间开荒队，集合前在语音频道确认。', leaderUserIds: ['g05_account_leader'], createdAt: now, revision: 1 });
    repo.put('squads', { id: 'g05_foreign_squad', name: '北境二队', leaderUserIds: [], createdAt: now, revision: 1 });
    for (const f of fixtures.filter(f => f.accountId)) {
      repo.put('members', { id: f.memberId, steamId: f.steamId, displayName: f.displayName, customName: f.displayName,
        memberStatus: 'active', membershipStatus: 'active', specialty: ['建筑'], timeZone: 'Asia/Shanghai', language: 'zh-CN', theme: 'light', createdAt: now, revision: 1 });
      const grants = structuredClone(MEMBER_GRANTS);
      if (f.roleId === 'leader') grants.push(...['members.basic_edit', 'signups.delegate'].map(cap => grant(cap, { type: 'squads', ids: ['g05_squad'] })));
      if (f.roleId === 'admin') grants.push(...CAPABILITIES.filter(cap => cap !== 'system.permissions').map(cap => grant(cap, { type: 'all' })));
      repo.put('accounts', { id: f.accountId, memberId: f.memberId, status: 'active', roleId: f.roleId, adminAssignedByOwner: f.roleId === 'admin', grants, permissionVersion: 1, revision: 1, createdAt: now });
      repo.put('bindings', { id: `binding_${f.key}`, accountId: f.accountId, memberId: f.memberId, steamId: f.steamId,
        status: 'verified', verifiedAt: now, proofSource: 'controlled_local_fixture_not_external_authentication', revision: 1 });
      repo.put('squadMembers', { id: `relation_${f.key}`, squadId: f.squadId, memberId: f.memberId, validFrom: now, validTo: null });
      for (const provider of ['discord', 'kook']) repo.put('identities', { id: `${provider}_${f.key}`, provider,
        externalId: `${provider}_g05_${f.key}`, accountId: f.accountId, verifiedAt: now, revision: 1 });
    }
    for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'g05_fixture_guild', allowedRoleIds: ['g05_fixture_role'] });
  });
}
export function controlledProviders(origin) {
  const tickets = new Map(), denied = new Set(['denied']), unavailable = new Set();
  const providers = Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    configured: () => true,
    authorizationUrl: state => `${origin}/api/v2/__fixtures/oauth/${provider}?${new URLSearchParams({ state })}`,
    async exchange(code) {
      const entry = tickets.get(code); tickets.delete(code);
      if (!entry || entry.provider !== provider || Date.now() > entry.expiresAt) throw new IdentityError('AUTH_INVALID_CALLBACK', 401);
      return { provider, id: `${provider}_g05_${entry.fixture.key}`, displayName: entry.fixture.displayName };
    },
    async roles(externalId, guildId) {
      const fixture = fixtures.find(f => externalId === `${provider}_g05_${f.key}`);
      if (!fixture || unavailable.has(fixture.key)) throw new IdentityError('ELIGIBILITY_UNAVAILABLE', 503);
      return { externalId, guildId, roleIds: denied.has(fixture.key) ? [] : ['g05_fixture_role'] };
    }
  }]));
  return { providers, denied, unavailable, ticket(provider, key) {
    const fixture = fixtures.find(f => f.key === key);
    if (!fixture || !providers[provider]) throw new IdentityError('AUTH_INVALID_CALLBACK', 401);
    const code = randomBytes(24).toString('base64url'); tickets.set(code, { provider, fixture, expiresAt: Date.now() + 60_000 }); return code;
  } };
}
