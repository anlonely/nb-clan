import { randomUUID } from 'node:crypto';
import { validGrant, accountRole, roleGrants } from '../identity/permissions.js';
import { legacyFingerprint } from '../identity/migration.js';
import { need, text, fields, revision, safeText } from './model.js';
import { isTrustedRoot, assertAccess } from './access.js';

export function accountDTO(repo, a) {
  const u = a.legacyUserId && repo.get('users', a.legacyUserId);
  const member = a.memberId && repo.get('members', a.memberId);
  const steamProfile = member && !member.steamNickname && member.steamId && repo.db.prepare(`SELECT json_extract(payload_json,'$.displayName') AS nickname FROM json_records
    WHERE collection='memberProfiles' AND json_extract(payload_json,'$.memberId')=? AND json_extract(payload_json,'$.steamId')=?
    ORDER BY json_extract(payload_json,'$.fetchedAt') DESC,id LIMIT 1`).get(member.id, member.steamId);
  const bindingRow = repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='v2SteamBindings' AND json_extract(payload_json,'$.accountId')=? AND json_extract(payload_json,'$.status')!='revoked' ORDER BY json_extract(payload_json,'$.status')='verified' DESC,id LIMIT 1").get(a.id);
  const binding = bindingRow && JSON.parse(bindingRow.payload_json);
  return { id: a.id, username: u?.username || a.displayName || a.id, status: a.status,
    roleAccessLocked: Boolean(a.roleAccessLock), roleAccessLockedAt: a.roleAccessLock?.at || null,
    roleId: accountRole(repo, a),
    memberId: a.memberId || null, revision: a.revision, permissionVersion: a.permissionVersion,
    orphan: Boolean(a.memberId && !member), deleted: Boolean(a.deletedAt), passwordConfigured: Boolean(u?.passwordHash), root: accountRole(repo, a) === 'owner',
    steamNickname: member?.steamNickname || steamProfile?.nickname || '',
    steamId: binding?.steamId || '', bindingStatus: binding?.status || 'unbound' };
}
/** G03 authoritative administration extension. It is injected into SystemAdminService.
 * No alternate Account/Role/Binding store exists here. Called only inside the owner's
 * SQLite transaction; existing G03 changeAccount/saveRestriction are reused through a
 * transaction-scoped facade, so their events publish only after the outer commit.
 */
export function createSystemIdentityAdapter(identity) {
  need(identity?.repo && typeof identity.changeAccount === 'function', 'IDENTITY_ADMIN_REQUIRED', 503);
  const repo = identity.repo;
  const roles = () => repo.all('permissionRoles');
  function targetGuard(actor, target, { deleting = false } = {}) {
    need(target, 'RESOURCE_NOT_FOUND', 404);
    const root = accountRole(repo, target) === 'owner';
    const owner = isTrustedRoot(identity, actor);
    need(!deleting || target.id !== actor.id && !root, 'PROTECTED_ACCOUNT', 403);
    need(owner || accountRole(repo, target) === 'member', 'PROTECTED_ACCOUNT', 403);
    return { root, admin: owner };
  }
  function assignment(actor, roleId, target) {
    need(['member', 'admin'].includes(roleId), 'ROLE_NOT_FOUND', 404);
    need(isTrustedRoot(identity, actor) || roleId === 'member' && (!target || accountRole(repo, target) === 'member'), 'ROLE_ESCALATION', 403);
    return { grants: roleGrants(roleId), review: [] };
  }
  function scoped(tx) {
    const r = Object.create(repo); r.transaction = fn => fn(r);
    const s = Object.create(identity); s.repo = r; s.publish = events => tx.events.push(...events);
    return s;
  }
  function invalidate(s, account, reason, tx) {
    const next = { ...account, permissionVersion: account.permissionVersion + 1, revision: account.revision + 1 };
    if (account.legacyUserId) next.legacyFingerprint = legacyFingerprint(repo.get('users', account.legacyUserId), roles());
    repo.put('accounts', next);
    for (const session of repo.all('sessions').filter(x => x.accountId === account.id)) repo.remove('sessions', session.id);
    tx.events.push(s.event(account.id, reason)); tx.changedAccounts.add(account.id); return next;
  }
  return {
    identity,
    list(actor, { q = '', cursor = '', limit = 30, orphan = '0', deleted = '0' } = {}) {
      assertAccess(identity, actor, 'accounts');
      need(['0','1'].includes(deleted), 'INVALID_ACCOUNT_FILTER', 422);
      text(q, 120); text(cursor, 160); limit = Math.min(100, Math.max(1, Number(limit) || 30));
      const rows = repo.db.prepare(`SELECT a.payload_json FROM json_records a LEFT JOIN json_records u ON u.collection='users'
        AND u.id=json_extract(a.payload_json,'$.legacyUserId') LEFT JOIN json_records m ON m.collection='members'
        AND m.id=json_extract(a.payload_json,'$.memberId') WHERE a.collection='v2Accounts' AND a.id>?
        AND (instr(lower(coalesce(json_extract(u.payload_json,'$.username'),a.id)),lower(?))>0
          OR instr(lower(coalesce(json_extract(m.payload_json,'$.steamNickname'),'')),lower(?))>0
          OR EXISTS (SELECT 1 FROM json_records p WHERE p.collection='memberProfiles'
            AND json_extract(p.payload_json,'$.memberId')=m.id
            AND json_extract(p.payload_json,'$.steamId')=json_extract(m.payload_json,'$.steamId')
            AND instr(lower(coalesce(json_extract(p.payload_json,'$.displayName'),'')),lower(?))>0))
        AND (?!='1' OR json_extract(a.payload_json,'$.deletedAt') IS NOT NULL)
        AND (?!='0' OR json_extract(a.payload_json,'$.deletedAt') IS NULL)
        AND (?!='1' OR (json_extract(a.payload_json,'$.roleId')='member' AND json_extract(a.payload_json,'$.status')='active' AND json_extract(a.payload_json,'$.memberId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_records m WHERE m.collection='members' AND m.id=json_extract(a.payload_json,'$.memberId'))))
        ORDER BY a.id LIMIT ?`).all(cursor, q, q, q, deleted, deleted, orphan, limit + 1);
      const items = rows.slice(0, limit).map(r => accountDTO(repo, JSON.parse(r.payload_json)));
      return { items, nextCursor: rows.length > limit ? items.at(-1).id : null };
    },
    roles(actor, { editable = true } = {}) {
      assertAccess(identity, actor, editable ? 'permissions' : 'accounts');
      const catalog = editable ? ['member', 'admin', 'owner'] : isTrustedRoot(identity, actor) ? ['member', 'admin'] : ['member'];
      return { items: catalog.map(code => ({ code, name: { member: '成员', admin: '管理员', owner: '所有者' }[code], builtIn: true, revision: 0 })), modules: [] };
    },
    grants(actor, accountId) {
      assertAccess(identity, actor, 'permissions'); const a = repo.get('accounts', accountId); need(a, 'RESOURCE_NOT_FOUND', 404);
      return { ...accountDTO(repo, a), grants: a.grants || [], restrictions: repo.all('restrictions').filter(r => r.accountId === a.id).map(r => ({
        id: r.id, accountId: r.accountId, kind: r.kind, reason: safeText(r.reason), startsAt: r.startsAt, endsAt: r.endsAt, revision: r.revision })) };
    },
    apply(actor, action, targetId, input, tx) {
      const s = scoped(tx), stamp = new Date(identity.now()).toISOString();
      const target = targetId && repo.get('accounts', targetId);
      const changed = a => { tx.changedAccounts.add(a.id); return accountDTO(repo, a); };
      if (action === 'account.create') {
        fields(input, ['expectedRevision', 'username', 'passwordHash', 'roleId']); revision(input.expectedRevision, 0);
        need(/^[a-zA-Z0-9_.-]{2,32}$/.test(input.username) && input.username.toLowerCase() !== 'root', 'INVALID_USERNAME');
        need(!repo.all('users').some(u => u.username?.toLowerCase() === input.username.toLowerCase()), 'USERNAME_EXISTS', 409);
        need(input.roleId !== 'leader', 'LEADER_REQUIRES_VERIFIED_BINDING', 409);
        const mapped = assignment(actor, input.roleId), uid = `user_${randomUUID()}`, aid = uid;
        const u = { id: uid, username: input.username, role: input.roleId, passwordHash: input.passwordHash, createdAt: stamp, updatedAt: stamp, createdBy: actor.id };
        repo.put('users', u);
        const a = { id: aid, legacyUserId: uid, legacyFingerprint: legacyFingerprint(u, roles()), status: 'active', roleId: input.roleId, adminAssignedByOwner: input.roleId === 'admin',
          memberId: null, grants: mapped.grants, permissionVersion: 1, revision: 1, createdAt: stamp };
        repo.put('accounts', a); s.audit(action, actor.id, { targetAccountId: aid }); return { current: changed(a), compatibilityReview: mapped.review };
      }
      if (action.startsWith('role.') || action === 'account.grants') need(false, 'FIXED_ROLE_PERMISSIONS', 403);
      if (action === 'account.cleanup') {
        fields(input, ['expectedRevision', 'accountIds']);
        need(Array.isArray(input.accountIds) && input.accountIds.length > 0 && input.accountIds.length <= 100, 'INVALID_ACCOUNT_IDS');
        // Only explicit reviewed orphan candidates, preserving identities/binding/audits as tombstones.
        const removed = [];
        for (const id of [...new Set(input.accountIds)]) {
          const a = repo.get('accounts', id); targetGuard(actor, a, { deleting: true });
          need(a.status !== 'disabled' && a.roleId === 'member' && a.memberId && !repo.get('members', a.memberId), 'NOT_ORPHAN', 409);
          changed(invalidate(s, { ...a, status: 'disabled', deletedAt: stamp, deletionReason: 'orphan_cleanup' }, 'account_deleted', tx)); removed.push(id);
        }
        return { disabledOrphans: removed };
      }
      if (action === 'account.batch') {
        fields(input, ['expectedRevision', 'mode', 'accounts', 'status', 'roleId']);
        need(['delete', 'status', 'role'].includes(input.mode), 'INVALID_ACCOUNT_BATCH', 422);
        need(Array.isArray(input.accounts) && input.accounts.length > 0 && input.accounts.length <= 100, 'INVALID_ACCOUNT_IDS', 422);
        need(input.mode !== 'status' || ['active', 'disabled'].includes(input.status), 'INVALID_STATUS', 422);
        need(input.mode !== 'role' || ['member', 'admin'].includes(input.roleId), 'ROLE_NOT_FOUND', 404);
        const seen = new Set();
        const targets = input.accounts.map(item => {
          need(item && typeof item.id === 'string' && !seen.has(item.id) && Number.isInteger(item.expectedRevision), 'INVALID_ACCOUNT_IDS', 422);
          seen.add(item.id);
          const account = repo.get('accounts', item.id);
          targetGuard(actor, account, { deleting: input.mode === 'delete' });
          revision(item.expectedRevision, account.revision);
          need(!account.deletedAt || input.mode === 'status' && input.status === 'active', 'ACCOUNT_ALREADY_DELETED', 409);
          return item;
        });
        const items = targets.map(item => this.apply(actor,
          input.mode === 'delete' ? 'account.delete' : input.mode === 'role' ? 'account.role' : 'account.status',
          item.id,
          { expectedRevision: item.expectedRevision, ...(input.mode === 'delete' ? { reason: '管理员批量删除账号' } : input.mode === 'role' ? { roleId: input.roleId } : { status: input.status }) }, tx).current);
        return { items };
      }
      const guard = targetGuard(actor, target, { deleting: action === 'account.delete' });
      revision(input.expectedRevision, target.revision);
      if (action === 'account.status' || action === 'account.grants') {
        fields(input, ['expectedRevision', action === 'account.grants' ? 'grants' : 'status']);
        need(!guard.root, 'ROOT_PERMISSIONS_PROTECTED', 403);
        if (action === 'account.grants') { assertAccess(identity, actor, 'permissions', true); need(Array.isArray(input.grants) && input.grants.length <= 300 && input.grants.every(validGrant), 'INVALID_GRANTS'); }
        const updated = s.changeAccount(actor, target.id, input);
        if (action === 'account.status' && input.status === 'active' && updated.deletedAt) {
          delete updated.deletedAt; delete updated.deletionReason;
          repo.put('accounts', updated);
        }
        return { current: changed(updated) };
      }
      if (action === 'account.password') {
        fields(input, ['expectedRevision', 'passwordHash']);
        const u = target.legacyUserId && repo.get('users', target.legacyUserId); need(u, 'PASSWORD_ACCOUNT_REQUIRED', 409);
        repo.put('users', { ...u, passwordHash: input.passwordHash, updatedAt: stamp });
        return { current: changed(invalidate(s, target, 'password_changed', tx)) };
      }
      if (action === 'account.role') {
        fields(input, ['expectedRevision', 'roleId']); need(!guard.root, 'ROOT_PERMISSIONS_PROTECTED', 403);
        const mapped = assignment(actor, input.roleId, target);
        if (input.roleId === 'leader') need(repo.all('bindings').some(b => b.accountId === target.id && b.status === 'verified'), 'LEADER_REQUIRES_VERIFIED_BINDING', 409);
        const u = target.legacyUserId && repo.get('users', target.legacyUserId);
        if (u) repo.put('users', { ...u, role: input.roleId, updatedAt: stamp });
        // Authority is exclusively defined by the assigned built-in role.
        const next = { ...target, roleId: input.roleId, adminAssignedByOwner: input.roleId === 'admin',
          roleDerivedSystemRole: null, roleDerivedSystemRoles: [], grants: mapped.grants };
        return { current: changed(invalidate(s, next, 'role_changed', tx)), compatibilityReview: mapped.review };
      }
      if (action === 'account.delete') {
        fields(input, ['expectedRevision', 'reason']); text(input.reason, 500, true);
        return { current: changed(invalidate(s, { ...target, status: 'disabled', deletedAt: stamp, deletionReason: input.reason }, 'account_deleted', tx)) };
      }
      if (action === 'account.binding') {
        fields(input, ['expectedRevision', 'steamId', 'reason']); text(input.reason, 500, true);
        need(!guard.root && (input.steamId === '' || /^7656119\d{10}$/.test(input.steamId)), 'INVALID_STEAM_ID');
        need(!repo.all('bindings').some(b => b.accountId === target.id && b.status === 'verified'), 'VERIFIED_BINDING_REQUIRES_G03_REVIEW', 409);
        need(!input.steamId || (!repo.all('bindings').some(b => b.accountId !== target.id && b.steamId === input.steamId && b.status !== 'revoked') &&
          !repo.all('members').some(m => m.steamId === input.steamId && m.id !== target.memberId) &&
          !repo.all('users').some(u => u.boundSteamId === input.steamId && u.id !== target.legacyUserId)), 'IDENTITY_CONFLICT', 409);
        for (const b of repo.all('bindings').filter(b => b.accountId === target.id && b.status !== 'revoked')) repo.put('bindings', { ...b, status: 'revoked', revision: (b.revision || 1) + 1 });
        if (input.steamId) repo.put('bindings', { id: `binding_${randomUUID()}`, accountId: target.id, memberId: target.memberId, steamId: input.steamId,
          status: 'legacy_unverified', proofSource: 'admin_candidate', revision: 1, createdAt: stamp });
        return { current: changed(invalidate(s, target, 'binding_candidate_changed', tx)), verificationRequired: true };
      }
      if (action === 'account.restriction.remove') {
        fields(input,['expectedRevision','restrictionId','restrictionRevision','reason']); text(input.reason,500,true);
        const current=repo.get('restrictions',input.restrictionId); need(current && current.accountId===target.id,'RESOURCE_NOT_FOUND',404);
        revision(input.restrictionRevision,current.revision); need(!guard.root,'ROOT_PERMISSIONS_PROTECTED',403);
        repo.remove('restrictions',current.id); s.audit('access_restriction_removed',actor.id,{targetAccountId:target.id,restrictionId:current.id,previous:current,reason:input.reason});
        return {current:changed(invalidate(s,target,'access_restriction_removed',tx))};
      }
      if (action === 'account.restriction') {
        fields(input, ['expectedRevision', 'restrictionRevision', 'id', 'reason', 'startsAt', 'endsAt']); need(!guard.root, 'ROOT_PERMISSIONS_PROTECTED', 403);
        const r = s.saveRestriction(actor, { id: input.id, accountId: target.id, kind: 'deny_access', reason: input.reason,
          startsAt: input.startsAt, endsAt: input.endsAt, expectedRevision: input.restrictionRevision });
        tx.changedAccounts.add(target.id); return { current: { id: r.id, revision: r.revision, accountId: target.id, startsAt: r.startsAt, endsAt: r.endsAt } };
      }
      need(false, 'UNKNOWN_IDENTITY_COMMAND', 404);
    }
  };
}
