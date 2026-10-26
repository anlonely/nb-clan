import { clearCurrentSignupsForDepartedMember } from '../scheduling/departure.js';

const PROVIDERS = new Set(['kook', 'discord']);
const MISSING = new Set(['missing_role', 'not_in_guild']);

/** Reconcile only observations for the member's current bindings and admission policies.
 * The caller's SQLite transaction owns the audit, lock, and signup changes. */
export function reconcileMemberRoleDeparture(identity, memberId) {
  const repo = identity.repo;
  if (!repo.db.isTransaction) throw new Error('ROLE_DEPARTURE_TRANSACTION_REQUIRED');
  const member = repo.get('members', memberId);
  const account = repo.all('accounts').find(row => row.memberId === memberId);
  if (!member || !account) return { state: 'skipped', clearedSignups: 0 };

  const policies = new Map(repo.all('policies')
    .filter(row => PROVIDERS.has(row.provider) && row.enabled && row.guildId && row.allowedRoleIds?.length)
    .map(row => [row.provider, row]));
  const links = repo.all('identities').filter(row => row.accountId === account.id &&
    PROVIDERS.has(row.provider) && row.externalId && policies.has(row.provider));
  if (!links.length) return { state: 'unknown', clearedSignups: 0 };
  const audits = repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='v2CommunityRoleAudits' AND json_extract(payload_json,'$.memberId')=?")
    .all(memberId).map(row => JSON.parse(row.payload_json));
  const matching = links.map(link => {
    const policy = policies.get(link.provider);
    return audits.find(row => row.provider === link.provider && row.externalId === link.externalId &&
      row.guildId === policy.guildId && row.policyRevision === policy.policyRevision &&
      row.matchMode === policy.matchMode && JSON.stringify(row.expectedRoleIds) === JSON.stringify(policy.allowedRoleIds));
  });
  const hasValid = matching.some(row => row?.status === 'valid');
  const allMissing = matching.length === links.length && matching.every(row => MISSING.has(row?.status));
  if (!hasValid && !allMissing) return { state: 'unknown', clearedSignups: 0 };

  const locked = Boolean(account.roleAccessLock);
  if (hasValid && !locked) return { state: 'active', clearedSignups: 0 };
  if (allMissing && locked) return { state: 'locked', clearedSignups: 0 };
  const now = new Date(identity.now()).toISOString();
  const nextLock = allMissing ? { reason: 'community_role_missing', at: now,
    providers: links.map(link => link.provider) } : null;
  repo.put('accounts', { ...account, roleAccessLock: nextLock,
    permissionVersion: (account.permissionVersion || 1) + 1, revision: (account.revision || 1) + 1 });
  repo.put('members', { ...member, roleAccessLock: nextLock,
    revision: (member.revision || 1) + 1, updatedAt: now });
  if (account.legacyUserId) {
    const user = repo.get('users', account.legacyUserId);
    if (user) repo.put('users', { ...user, roleAccessLock: nextLock, updatedAt: now });
  }
  for (const wechatUser of repo.all('wechatUsers').filter(row => row.memberId === memberId)) {
    repo.put('wechatUsers', { ...wechatUser, roleAccessLock: nextLock, updatedAt: now });
  }
  const clearedSignups = allMissing ? clearCurrentSignupsForDepartedMember(identity, memberId) : 0;
  identity.audit(allMissing ? 'community_role_locked' : 'community_role_unlocked', account.id,
    { memberId, providers: links.map(link => link.provider), clearedSignups });
  identity.event(account.id, allMissing ? 'community_role_locked' : 'community_role_unlocked');
  return { state: allMissing ? 'locked' : 'active', clearedSignups };
}
