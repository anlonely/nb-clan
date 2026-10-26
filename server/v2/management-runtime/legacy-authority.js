import { roleCan, isLeader, isMember } from '../../permissions.js';
import { can } from '../identity/permissions.js';

/** Preserve audited legacy effective actions; a role label on a V2 account is
 * insufficient. Current G03 restrictions and resource scope still apply. */
export function createLegacyManagementAuthority(identity) {
  function context(actor) {
    const current = identity.actorForAccount(actor.id);
    if (current.permissionVersion !== actor.permissionVersion) return null;
    const account = identity.repo.get('accounts', current.id);
    const user = account?.legacyUserId && identity.repo.get('users', account.legacyUserId);
    if (!['owner','admin'].includes(current.roleId)) return null;
    return { current, user: user || {role:'admin'}, root: current.roleId === 'owner',
      roles: identity.repo.all('permissionRoles'), relations: identity.relations() };
  }
  const edit = c => ['owner','admin'].includes(c.current.roleId);
  return {
    isTrustedRoot(actor) { return context(actor)?.root === true; },
    authorizeStatsWrite(actor, action, resource) {
      const c = context(actor);
      if (!c || !can(c.current, 'stats.read', resource, c.relations)) return false;
      if (action === 'history.visibility') return ['owner','admin'].includes(c.current.roleId);
      return ['stats.import', 'stats.import.member', 'stats.ingest', 'stats.ingest.member', 'stats.replace-source', 'stats.sync']
        .includes(action) && edit(c, 'kda');
    },
    authorizeRealtimeAction(actor, action, scope) {
      const c = context(actor);
      if (!c || !can(c.current, action === 'clear-chat' ? 'relay.chat_read' : 'relay.read', scope.resource, c.relations)) return false;
      if (action === 'clear-chat') return edit(c, 'rustClanChat') || edit(c, 'rustTools');
      if (action === 'reset') return edit(c, 'rustClanInfo') || edit(c, 'rustTools');
      if (action === 'import-member') return edit(c);
      return false;
    }
  };
}
