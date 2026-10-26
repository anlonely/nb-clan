import { randomUUID } from 'node:crypto';
import { authorize } from '../../identity/permissions.js';
import { platformAliases, legacyFingerprint } from '../../identity/migration.js';
import { hash, requireValue as need } from '../../member-admin/repository.js';

// A G03 repository-backed domain extension. The enclosing MemberAdminService
// owns the savepoint, receipt, history and outbox. No network or publishing here.
export class IdentityMemberLifecycle {
  constructor({ identity, contexts }) {
    this.identity = identity;
    this.contexts = contexts;
  }
  observeUnlink(actor, memberId, provider) {
    const repo = this.identity.repo, a = this.identity.actorForAccount(actor.id);
    need(a.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    need(['wechat', 'discord', 'kook'].includes(provider), 'INVALID_PROVIDER', 422);
    for (const cap of ['members.review', 'system.accounts']) authorize(a, cap, { kind: 'member', id: memberId }, this.identity.relations());
    const member = repo.get('members', memberId);
    need(member, 'RESOURCE_NOT_FOUND', 404);
    const accounts = repo.all('accounts').filter(a => a.memberId === memberId);
    const users = repo.all('users').filter(u => accounts.some(a => a.legacyUserId === u.id) || (/^\d{17}$/.test(member.steamId || '') && u.boundSteamId === member.steamId));
    const identities = repo.all('identities').filter(i => accounts.some(a => a.id === i.accountId));
    const wechatAliases = [member, ...users].flatMap(row => [row.wechatUserId, row.wechatId]).filter(Boolean);
    const wx = repo.all('wechatUsers').filter(u => u.memberId === memberId || wechatAliases.includes(u.id));
    return { memberId, provider, expectedRevision: member.revision || 1,
      expectedIdentityFingerprint: hash([member, accounts.map(a => [a.id, a.memberId, a.revision, a.permissionVersion]),
        identities.map(i => [i.id, i.provider, i.externalId, i.accountId, i.revision]),
        users.map(u => [u.id, u.revision, u.boundSteamId, u.wechatUserId, u.wechatId, platformAliases(u, provider)]),
        wx.map(u => [u.id, u.memberId, u.appId, u.openid || u.openId, u.revision])]) };
  }
  assertTransaction({ db, tx, actor, member }) {
    need(db === this.identity.repo.db && tx?.actor?.id === actor.id && db.isTransaction,
      'IDENTITY_SAME_TRANSACTION_REQUIRED', 503);
    const current = this.identity.actorForAccount(actor.id);
    need(current.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    authorize(current, 'members.review', { kind: 'member', id: member.id }, this.identity.relations());
    return current;
  }
  deleteInTransaction(args) {
    const actor = this.assertTransaction(args), { tx, member } = args, repo = this.identity.repo;
    authorize(actor, 'system.accounts', { kind: 'member', id: member.id }, this.identity.relations());
    need(this.contexts?.invalidate && this.contexts?.assertReady?.() === true, 'IDENTITY_CONTEXT_INVALIDATOR_REQUIRED', 503);
    const accounts = repo.all('accounts').filter(a => a.memberId === member.id);
    need(!accounts.some(a => a.id === actor.id), 'CANNOT_DELETE_CURRENT_MEMBER', 409);
    const users = repo.all('users').filter(u => accounts.some(a => a.legacyUserId === u.id) || (/^\d{17}$/.test(member.steamId || '') && u.boundSteamId === member.steamId));
    need(!repo.all('accounts').some(a => !accounts.some(target => target.id === a.id) && users.some(u => a.legacyUserId === u.id)), 'IDENTITY_CONFLICT', 409);
    const identities = repo.all('identities').filter(i => accounts.some(a => a.id === i.accountId));
    const wx = repo.all('wechatUsers').filter(u => u.memberId === member.id || u.id === member.wechatUserId || u.id === member.wechatId);
    need(wx.every(u => !u.memberId || u.memberId === member.id), 'IDENTITY_CONFLICT', 409);
    for (const binding of repo.all('bindings').filter(b => b.memberId === member.id || accounts.some(a => a.id === b.accountId))) tx.remove('v2SteamBindings', binding.id);
    for (const identity of identities) tx.remove('v2Identities', identity.id);
    for (const session of repo.all('sessions').filter(s => accounts.some(a => a.id === s.accountId))) tx.remove('v2Sessions', session.id);
    for (const account of accounts) tx.put('v2Accounts', { ...account, memberId: null, status: 'disabled', grants: [],
      permissionVersion: (account.permissionVersion || 1) + 1, revision: (account.revision || 1) + 1, updatedAt: tx.stamp });
    for (const user of users) {
      const cleared = { ...user, boundSteamId: '', memberId: null, status: 'disabled', disabled: true, loginProviders: {}, revision: (user.revision || 1) + 1, updatedAt: tx.stamp };
      for (const field of ['steamId','steamNickname','steamAvatar','avatar','discordId','discordUserId','discordName','discordAvatarHash','discordAvatarUrl','kookId','kookUserId','kookAccountId','kookName','kookAvatar','wechatUserId','wechatId']) cleared[field] = '';
      tx.put('users', cleared);
    }
    for (const user of wx) tx.put('wechatUsers', { ...user, memberId: '', status: 'guest', revision: (user.revision || 1) + 1, updatedAt: tx.stamp });
    // Do not leave stale platform/member bindings in migration-era typed mirrors.
    for (const [table, records] of [['users', users], ['wechat_users', wx]]) {
      if (!repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const remove = repo.db.prepare(`DELETE FROM ${table} WHERE id=?`);
      for (const record of records) remove.run(record.id);
    }
    for (const eligibility of repo.all('eligibility').filter(e => identities.some(i => i.provider === e.provider && i.externalId === e.externalId))) tx.put('v2Eligibility', { ...eligibility, status: 'unknown', expiresAt: tx.stamp });
    // Preserve account IDs for audit only; durable effects invalidate unfinished OAuth and platform sessions after commit.
    for (const provider of new Set(['steam', 'discord', 'kook', 'wechat', ...identities.map(i => i.provider), ...wx.filter(w => w.appId).map(w => `wechat:${w.appId}`)])) {
      const appId = provider.startsWith('wechat:') ? provider.slice(7) : null;
      const externalIds = [...new Set([
        ...identities.filter(i => i.provider === provider).map(i => appId ? `${appId}:${i.externalId}` : i.externalId),
        ...[member, ...users].flatMap(record => platformAliases(record, provider)),
        ...(provider === 'steam' ? [member.steamId] : []),
        ...(['wechat'].includes(provider) || appId ? wx.filter(w => w.appId && (w.openid || w.openId)).map(w => `${w.appId}:${w.openid || w.openId}`) : [])
      ].filter(Boolean))];
      for (const accountId of accounts.length ? accounts.map(a => a.id) : [null]) tx.put('v2IdentityEvents', {
        id: `event_${randomUUID()}`, accountId, reason: 'member_deleted', memberId: member.id, provider: appId ? 'wechat' : provider, appId,
        externalIds, wechatUserIds: wx.map(w => w.id), createdAt: tx.stamp
      });
    }
    return { revoked: true };
  }
  unlinkInTransaction(args) {
    const actor = this.assertTransaction(args);
    const { tx, member, provider } = args, repo = this.identity.repo;
    authorize(actor, 'system.accounts', { kind: 'member', id: member.id }, this.identity.relations());
    need(this.contexts?.invalidate && this.contexts?.assertReady?.() === true,
      'IDENTITY_CONTEXT_INVALIDATOR_REQUIRED', 503);
    need(typeof args.expectedIdentityFingerprint === 'string' && /^[a-f0-9]{64}$/.test(args.expectedIdentityFingerprint),
      'IDENTITY_OBSERVATION_REQUIRED', 422);
    need(args.expectedIdentityFingerprint === this.observeUnlink(actor, member.id, provider).expectedIdentityFingerprint,
      'IDENTITY_OBSERVATION_CHANGED', 409);
    const allAccounts = repo.all('accounts'), allUsers = repo.all('users');
    const accounts = allAccounts.filter(a => a.memberId === member.id);
    need(accounts.length <= 1, 'IDENTITY_CONFLICT', 409);
    const users = allUsers.filter(u => accounts.some(a => a.legacyUserId === u.id) || (/^\d{17}$/.test(member.steamId || '') && u.boundSteamId === member.steamId));
    need(users.length <= 1 && users.every(u => accounts.every(a => !a.legacyUserId || a.legacyUserId === u.id)), 'IDENTITY_CONFLICT', 409);
    need(!allAccounts.some(a => !accounts.some(target => target.id === a.id) && users.some(u => u.id === a.legacyUserId || u.id === a.id)), 'IDENTITY_CONFLICT', 409);
    const wechatAliases = [member, ...users].flatMap(row => [row.wechatUserId, row.wechatId]).filter(Boolean);
    const wx = provider === 'wechat' ? repo.all('wechatUsers').filter(u => u.memberId === member.id || wechatAliases.includes(u.id)) : [];
    need(wx.length <= 1 && wx.every(u => !u.memberId || u.memberId === member.id), 'IDENTITY_CONFLICT', 409);
    const appId = wx[0]?.appId;
    if (provider === 'wechat' && !appId) need(!repo.all('identities').some(i => accounts.some(a => a.id === i.accountId) &&
      (i.provider === 'wechat' || i.provider.startsWith('wechat:'))), 'WECHAT_APP_SCOPE_REQUIRED', 409);
    const providerMatches = p => provider === 'wechat' ? p === 'wechat' || Boolean(appId) && p === `wechat:${appId}` : p === provider;
    const identities = repo.all('identities').filter(i => providerMatches(i.provider) && accounts.some(a => i.accountId === a.id) &&
      (provider !== 'wechat' || i.provider !== 'wechat' || appId && i.externalId.startsWith(`${appId}:`)));
    const legacyWechatRecordOnly = provider === 'wechat' && wx.length === 0 && identities.length === 0;
    if (legacyWechatRecordOnly) need(new Set(wechatAliases.map(String)).size <= 1, 'IDENTITY_CONFLICT', 409);
    if (provider === 'wechat') for (const u of users) {
      need(!u.wechatUserId || wx.some(w => w.id === u.wechatUserId) || legacyWechatRecordOnly, 'WECHAT_APP_SCOPE_CONFLICT', 409);
      need(!u.loginProviders?.wechat?.appId || u.loginProviders.wechat.appId === appId, 'WECHAT_APP_SCOPE_CONFLICT', 409);
    }
    const ids = new Set(provider === 'wechat' ? wx.filter(u => u.appId && (u.openid || u.openId)).map(u => `${u.appId}:${u.openid || u.openId}`) :
      [member, ...users].flatMap(r => platformAliases(r, provider)));
    identities.forEach(i => ids.add(i.provider.startsWith('wechat:') ? `${i.provider.slice(7)}:${i.externalId}` : i.externalId));
    const subjectMatches = (p, externalId) => providerMatches(p) && ids.has(p.startsWith('wechat:') ? `${p.slice(7)}:${externalId}` : externalId);
    need(identities.length || ids.size || wx.length || provider === 'wechat' && wechatAliases.length, 'IDENTITY_NOT_LINKED', 409);
    need(!repo.all('identities').some(i => subjectMatches(i.provider, i.externalId) && !accounts.some(a => a.id === i.accountId)), 'IDENTITY_CONFLICT', 409);
    if (provider !== 'wechat') {
      need(!repo.all('members').some(m => m.id !== member.id && platformAliases(m, provider).some(v => ids.has(v))), 'IDENTITY_CONFLICT', 409);
      need(!allUsers.some(u => !users.some(v => v.id === u.id) && platformAliases(u, provider).some(v => ids.has(v))), 'IDENTITY_CONFLICT', 409);
    }
    const clear = record => {
      const next = { ...record, updatedAt: tx.stamp, revision: (record.revision || 1) + 1 };
      const fields = provider === 'wechat' ? ['wechatUserId'] : provider === 'kook' ?
        ['kookId', 'kookUserId', 'kookAccountId', 'kookName', 'kookAvatar'] :
        ['discordId', 'discordUserId', 'discordName', 'discordAvatarHash', 'discordAvatarUrl'];
      for (const field of fields) next[field] = '';
      if (provider === 'wechat' && (legacyWechatRecordOnly || !next.wechatId || wx.some(u => u.id === next.wechatId) || next.wechatId === member.wechatUserId)) next.wechatId = '';
      if (next.loginProviders?.[provider]) { next.loginProviders = { ...next.loginProviders }; delete next.loginProviders[provider]; }
      return next;
    };
    tx.put('members', clear(member));
    for (const u of wx) tx.put('wechatUsers', { ...u, memberId: '', status: 'guest', revision: (u.revision || 1) + 1, updatedAt: tx.stamp });
    for (const u of users) tx.put('users', clear(u));
    for (const i of identities) { repo.remove('identities', i.id); tx.changes.push({ collection: 'v2Identities', id: i.id, deleted: true }); }
    for (const e of repo.all('eligibility').filter(e => subjectMatches(e.provider, e.externalId))) {
      tx.put('v2Eligibility', { ...e, status: 'unknown', expiresAt: tx.stamp });
    }
    for (const a of accounts) {
      const legacy = a.legacyUserId && repo.get('users', a.legacyUserId);
      tx.put('v2Accounts', { ...a, permissionVersion: a.permissionVersion + 1, revision: a.revision + 1,
        ...(legacy ? { legacyFingerprint: legacyFingerprint(legacy, repo.all('permissionRoles')) } : {}) });
    }
    for (const s of repo.all('sessions').filter(s => accounts.some(a => a.id === s.accountId) || subjectMatches(s.identityProvider || '', s.externalId))) {
      repo.remove('sessions', s.id); tx.changes.push({ collection: 'v2Sessions', id: s.id, deleted: true });
    }
    // Durable effect descriptors are part of the existing member outbox/receipt.
    const event = { id: `event_${randomUUID()}`, accountId: accounts[0]?.id || null,
      reason: 'member_identity_unlinked', memberId: member.id, provider, appId: appId || null,
      externalIds: [...ids], wechatUserIds: wx.map(u => u.id), createdAt: tx.stamp };
    tx.put('v2IdentityEvents', event);
    return { revoked: true };
  }
}
