import { can, validGrant } from '../identity/permissions.js';
import { need, sync } from './model.js';
export function fresh(identity, actor) {
  const current = identity.actorForAccount(actor?.id);
  need(current.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
  need(current.status === 'active' && !current.restricted, 'ACCESS_DENIED', 403);
  return current;
}
export function globalCapability(identity, actor, capability) {
  return actor.grants?.some(g => validGrant(g) && g.capability === capability && g.effect === 'allow' && g.scope.type === 'all') &&
    !actor.grants.some(g => g.capability === capability && g.effect === 'deny') &&
    can(actor, capability, { kind: 'account', id: '__global_server_catalog__' }, identity.relations());
}
export function legacyServerAuthority(identity, actor) {
  const account = identity.repo.get('accounts', actor.id);
  const user = account?.legacyUserId && identity.repo.get('users', account.legacyUserId);
  // Old PUT had a hard admin role guard; module server.edit alone was insufficient.
  return Boolean(user && user.role === 'admin');
}
export function authorizeServerWrite(identity, actor, options) {
  need(globalCapability(identity, actor, 'wipes.edit'), 'GLOBAL_WIPES_EDIT_REQUIRED', 403);
  const trustedRoot = options.isTrustedRoot && sync(options.isTrustedRoot(actor)) === true;
  const legacy = options.authorizeLegacyServerManagement
    ? sync(options.authorizeLegacyServerManagement(actor)) === true : legacyServerAuthority(identity, actor);
  need(trustedRoot || legacy, 'LEGACY_SERVER_MANAGEMENT_REQUIRED', 403);
}
