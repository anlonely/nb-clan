import { digest } from './contexts.js';
import { migrateLegacyGrants } from './permissions.js';

export const KOOK_ALIASES = ['kookId', 'kookUserId', 'kookAccountId'];
export function platformAliases(record, provider) {
  const fields = provider === 'kook' ? KOOK_ALIASES : ['discordId', 'discordUserId'];
  return [...new Set([...fields.map(key => record[key]), record.loginProviders?.[provider]?.id]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}
export const legacyFingerprint = (user, roles = []) => digest(JSON.stringify({ role: user?.role,
  disabled: user?.disabled, status: user?.status, steamId: user?.boundSteamId, permissions: roles }));
export const membershipStatus = member => ({ active: 'active', paused: 'paused', suspended: 'paused', departed: 'departed',
  left: 'departed', inactive: 'paused', applicant: 'applicant', blocked: 'departed', blacklist: 'departed', blacklisted: 'departed' })
  [member.memberStatus || member.membershipStatus || 'active'] || 'applicant';
export const legacyBlocked = member => Boolean(member?.blacklisted || member?.isBlacklisted || member?.blacklist ||
  ['blocked', 'blacklist', 'blacklisted', 'banned'].includes(member?.memberStatus) || member?.status === 'blacklisted');

export function planIdentityMigration(store, now = new Date().toISOString()) {
  const out = { accounts: [], identities: [], bindings: [], restrictions: [], conflicts: [], members: [], policies: [] };
  const conflict = (kind, refs) => {
    const id = `conflict_${digest(JSON.stringify([kind, [...refs].sort()])).slice(0, 24)}`;
    if (!out.conflicts.some(c => c.id === id)) out.conflicts.push({ id, kind, refs, status: 'open', createdAt: now, revision: 1 });
  };
  const users = store.users || [], members = store.members || [];
  for (const member of members) {
    out.members.push({ ...member, membershipStatus: membershipStatus(member), revision: member.revision || 1 });
    if (legacyBlocked(member)) out.restrictions.push({ id: `legacy_blacklist_${member.id}`, memberId: member.id,
      kind: 'deny_access', reason: 'legacy_blacklist', startsAt: member.createdAt || now, revision: 1 });
  }
  const ambiguous = new Set();
  const by = (records, field) => {
    const map = new Map();
    for (const record of records) if (record[field]) {
      const key = String(record[field]); map.set(key, [...(map.get(key) || []), record]);
    }
    return map;
  };
  const steamMembers = by(members, 'steamId'), steamUsers = by(users, 'boundSteamId');
  for (const [steam, list] of steamMembers) if (list.length > 1) {
    conflict('DUPLICATE_STEAM_MEMBERS', list.map(x => x.id));
    for (const user of steamUsers.get(steam) || []) ambiguous.add(user.id);
  }
  for (const list of steamUsers.values()) if (list.length > 1) {
    conflict('DUPLICATE_MEMBER_ACCOUNTS', list.map(x => x.id)); list.forEach(x => ambiguous.add(x.id));
  }
  for (const user of users) {
    const linked = steamMembers.get(user.boundSteamId) || [];
    const member = !ambiguous.has(user.id) && linked.length === 1 ? linked[0] : null;
    const { grants, review } = migrateLegacyGrants(user, store);
    if (review.length) conflict('LEGACY_PERMISSION_REVIEW', [user.id, ...review]);
    out.accounts.push({ id: user.id, legacyUserId: user.id, memberId: member?.id || null,
      status: user.disabled || user.status === 'disabled' ? 'disabled' : 'active',
      roleId: user.role, grants, permissionVersion: 1, revision: 1,
      legacyFingerprint: legacyFingerprint(user, store.permissionRoles), createdAt: user.createdAt || now });
    if (member?.steamId) {
      const kook = user.loginProviders?.kook;
      const verified = kook?.steamVerifiedAt && Number.isFinite(Date.parse(kook.steamVerifiedAt)) &&
        kook.verifiedSteamId === member.steamId && platformAliases(member, 'kook').length === 1 &&
        platformAliases(member, 'kook')[0] === kook.id && platformAliases(user, 'kook').every(id => id === kook.id);
      out.bindings.push({ id: `binding_legacy_${user.id}`, accountId: user.id, memberId: member.id,
        steamId: member.steamId, status: verified ? 'verified' : 'legacy_unverified',
        verifiedAt: verified ? kook.steamVerifiedAt : null, proofSource: verified ? 'legacy_kook_openid' : 'legacy_manual', revision: 1 });
    }
  }
  for (const provider of ['discord', 'kook']) {
    const ids = new Set([...users, ...members].flatMap(r => platformAliases(r, provider)));
    for (const externalId of ids) {
      const matchingUsers = users.filter(u => platformAliases(u, provider).includes(externalId));
      const matchingMembers = members.filter(m => platformAliases(m, provider).includes(externalId));
      const accountIds = new Set([...matchingUsers.map(u => u.id),
        ...out.accounts.filter(a => matchingMembers.some(m => m.id === a.memberId)).map(a => a.id)]);
      if (matchingMembers.length > 1 || accountIds.size > 1 || [...matchingUsers, ...matchingMembers].some(r => platformAliases(r, provider).length > 1)) {
        conflict('PLATFORM_ALIAS_CONFLICT', [provider, ...accountIds, ...matchingMembers.map(m => m.id)]);
        // Do not import a verified Steam claim from an ambiguous platform identity.
        out.bindings.filter(b => accountIds.has(b.accountId)).forEach(b => Object.assign(b, { status: 'legacy_unverified', verifiedAt: null, proofSource: 'legacy_conflict' }));
        continue;
      }
      if (accountIds.size !== 1) continue;
      const accountId = [...accountIds][0];
      if (ambiguous.has(accountId)) continue;
      out.identities.push({ id: `identity_${digest(`${provider}:${externalId}`).slice(0, 24)}`,
        provider, externalId, accountId, verifiedAt: null, source: 'legacy_alias', revision: 1 });
    }
  }
  const appId = store.settings?.wechat?.appId || store.settings?.wechatMini?.appId || '';
  for (const wx of store.wechatUsers || []) {
    const duplicateOpenIds = (store.wechatUsers || []).filter(item => item.openid && item.openid === wx.openid);
    if (duplicateOpenIds.length > 1) {
      conflict('WECHAT_DUPLICATE_IDENTITY', duplicateOpenIds.map(item => item.id)); continue;
    }
    const account = out.accounts.find(a => a.memberId && a.memberId === wx.memberId);
    if (!appId || !account || !wx.openid) {
      conflict('WECHAT_LINK_REVIEW', [wx.id]); continue;
    }
    const provider = `wechat:${appId}`;
    const externalId = String(wx.openid);
    out.identities.push({ id: `identity_${digest(`${provider}:${externalId}`).slice(0, 24)}`,
      provider, externalId, accountId: account.id, verifiedAt: null, source: 'legacy_wechat', revision: 1 });
  }
  // Existing KOOK allowlist becomes an explicit disabled policy to review before enabling V2.
  // No platform permission is inferred from mere possession of OAuth credentials.
  for (const provider of ['discord', 'kook']) out.policies.push({ id: `policy_${provider}`, provider,
    guildId: store.settings?.[provider]?.guildId || '', allowedRoleIds: provider === 'kook' ? ['46829059', '70213945'] : [],
    matchMode: 'any', enabled: false, defaultRoleId: 'member', policyRevision: 1 });
  return out;
}

export function applyIdentityMigration(repo, plan) {
  return repo.transaction(() => {
    const existing = repo.scalar('v2IdentityMigration');
    if (existing) return { ...existing, replayed: true };
    for (const [collection, records] of Object.entries(plan)) for (const record of records) repo.put(collection, record);
    const manifest = { version: 1, appliedAt: new Date().toISOString(),
      counts: Object.fromEntries(Object.entries(plan).map(([key, rows]) => [key, rows.length])),
      planHash: digest(JSON.stringify(plan)) };
    repo.setScalar('v2IdentityMigration', manifest);
    return { ...manifest, replayed: false };
  });
}
