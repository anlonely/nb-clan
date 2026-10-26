import { can, CAPABILITIES, accountRole } from '../identity/permissions.js';
import { need } from './model.js';
export const AREAS = ['brand', 'storage', 'proxy', 'logs', 'api_keys', 'accounts', 'permissions'];
export function legacyUser(identity, actor) { const a = identity.repo.get('accounts', actor.id); return a?.legacyUserId ? identity.repo.get('users', a.legacyUserId) : null; }
export function isTrustedRoot(identity, actor) {
  return accountRole(identity.repo, identity.repo.get('accounts', actor?.id)) === 'owner';
}
export function allowed(identity, actor, area, mutation = false) {
  if (!AREAS.includes(area) || !actor || actor.status !== 'active') return false;
  const role = accountRole(identity.repo, identity.repo.get('accounts', actor.id));
  if (!['owner', 'admin'].includes(role) || area === 'permissions' && role !== 'owner') return false;
  return can(actor, `system.${area}`, { kind: 'system', id: area }, identity.relations());
}
export function assertAccess(identity, actor, area, mutation = false) {
  need(allowed(identity, actor, area, mutation), 'ACCESS_DENIED', 403);
}
export function accessDTO(identity, actor) {
  return { root: isTrustedRoot(identity, actor), areas: Object.fromEntries(AREAS.map(area => [area,
    { read: allowed(identity, actor, area), write: allowed(identity, actor, area, true) }])), capabilities: CAPABILITIES };
}
