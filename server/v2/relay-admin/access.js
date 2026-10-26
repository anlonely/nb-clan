import { can, validGrant, scopeMatches } from '../identity/permissions.js';
import { need } from './model.js';
const resource = { kind: 'system', id: 'rustplus_relay' };
/** The original gate is API OR Rust tools; a relay.read grant alone is not token-edit authority. */
export function relayAccess(identity, actor, mutation = false) {
  const current = identity.actorForAccount(actor?.id);
  need(current.permissionVersion === actor.permissionVersion, 'AUTH_CHANGED', 401);
  const relations = identity.relations();
  if (!['owner','admin'].includes(current.roleId)) return {allowed:false,source:null,actor:current};
  if ((current.grants || []).some(g => validGrant(g) && g.effect === 'deny' && ['system.api_keys','relay.read'].includes(g.capability) && scopeMatches(g.scope,current,resource,relations,'deny')))
    return {allowed:false,source:null,actor:current};
  return {allowed:can(current,'system.api_keys',resource,relations)||can(current,'relay.read',resource,relations),source:'workspace_role',actor:current};
}
export function assertRelayAccess(identity, actor, mutation = false) {
  const access = relayAccess(identity, actor, mutation); need(access.allowed, 'ACCESS_DENIED', 403); return access.actor;
}
