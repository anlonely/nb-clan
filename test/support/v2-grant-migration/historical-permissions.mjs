// Test evidence only: frozen 443-file input mapping, never used by the live host.
import { PERMISSION_MODULES, roleExists, rolePermissions } from '../../../server/permissions.js';
import { IdentityError } from '../../../server/v2/identity/errors.js';

const groups = {
  members: ['read', 'basic_edit', 'review', 'change_status'], risks: ['read', 'manage'],
  squads: ['read', 'manage'], wipes: ['read', 'create', 'edit', 'publish', 'start', 'end', 'archive'],
  signups: ['read', 'self_write', 'delegate', 'override_closed'], stats: ['read', 'export'],
  relay: ['read', 'chat_read'], notifications: ['preview', 'send', 'reconcile', 'mention_role', 'mention_everyone'],
  sync: ['read', 'run', 'manage'], platforms: ['read', 'configure'],
  system: ['accounts', 'permissions', 'proxy', 'storage', 'brand', 'logs', 'api_keys'],
  queries: ['read', 'run'], inventory: ['read', 'query']
};
export const CAPABILITIES = Object.freeze(Object.entries(groups).flatMap(([group, actions]) => actions.map(action => `${group}.${action}`)));
export const grant = (capability, scope, extra = {}) => ({ capability, scope, effect: 'allow', ...extra });
export const selfScope = { type: 'self' };
export const allScope = { type: 'all' };
export const MEMBER_GRANTS = ['members.read', 'squads.read', 'wipes.read', 'signups.read', 'signups.self_write', 'stats.read']
  .map(cap => grant(cap, selfScope));
export const SYSTEM_GRANTS = groups.system.map(action => grant(`system.${action}`, allScope));

const moduleMap = {
  members: ['members.read', 'members.basic_edit'], departedMembers: ['members.read', 'members.change_status'],
  riskAlerts: ['risks.read', 'risks.manage'], squads: ['squads.read', 'squads.manage'],
  server: ['wipes.read', 'wipes.edit'], kda: ['stats.read'], history: ['stats.read'],
  rustTools: ['relay.read'], rustClanInfo: ['relay.read'], rustClanChat: ['relay.chat_read'],
  query: ['queries.read', 'queries.run'], officialKda: ['stats.read', 'queries.run'],
  inventoryDetails: ['inventory.read', 'inventory.query'], sync: ['sync.read', 'sync.run'],
  discordBot: ['platforms.read', 'platforms.configure'], kookBot: ['platforms.read', 'platforms.configure'],
  discordKookSync: ['platforms.read', 'platforms.configure'], wechatMini: ['platforms.read', 'members.review'],
  logs: [null, 'system.logs'], users: [null, 'system.accounts'], permissions: [null, 'system.permissions'],
  system: [null, 'system.brand'], api: [null, 'system.api_keys']
};

export function migrateLegacyGrants(user, store) {
  const review = [];
  if (user.id === 'user_root' || user.username === 'root') return { grants: CAPABILITIES.map(cap => grant(cap, allScope, { source: 'legacy_root' })), review };
  if (!roleExists(user.role, store.permissionRoles)) return { grants: [], review: ['UNKNOWN_ROLE'] };
  if (user.role === 'admin') return { grants: CAPABILITIES.filter(cap => cap !== 'system.permissions').map(cap => grant(cap, allScope, { source: 'legacy_admin' })),
    review: ['PERMISSION_EDITOR_REMAINS_ROOT_ONLY'] };
  const permissions = rolePermissions(user.role, store.permissionRoles);
  const led = (store.squads || []).filter(s => !s.archivedAt && (s.leaderUserIds || [s.leaderUserId]).includes(user.id)).map(s => s.id);
  const grants = [];
  for (const { id } of PERMISSION_MODULES) {
    const cell = permissions[id] || {};
    const [read, edit] = moduleMap[id] || [];
    const platformScope = { type: 'platformTargets', ids: [{ discordBot: 'discord', kookBot: 'kook', discordKookSync: 'discord_kook_bridge', wechatMini: 'wechat' }[id]] };
    if (read && (cell.view || cell.edit)) grants.push(grant(read, read === 'platforms.read' ? platformScope : allScope, { source: 'legacy_compatibility', pendingReview: true }));
    // Legacy /kda/export accepts KDA/history view and applies the same visible-data scope.
    if (['kda', 'history'].includes(id) && (cell.view || cell.edit)) {
      grants.push(grant('stats.export', allScope, { source: 'legacy_compatibility', pendingReview: true }));
    }
    if (!read && (cell.view || cell.edit)) review.push(`${id}.view:UNMAPPED`);
    if (!cell.edit || user.role === 'viewer' && !['query', 'officialKda', 'inventoryDetails'].includes(id)) continue;
    if (edit === 'members.basic_edit' || edit === 'members.change_status' || edit === 'members.review') {
      // Old member writes also had hard role checks; module edit alone is insufficient.
      if (user.role === 'member_manager') grants.push(grant(edit, allScope, { source: 'legacy_effective' }));
      else review.push(`${id}.edit:HARD_ROLE_GUARD`);
    } else if (['squads.manage', 'wipes.edit'].includes(edit)) {
      review.push(`${id}.edit:HARD_ROLE_GUARD`);
    } else if (edit === 'system.permissions') review.push('permissions.edit:ROOT_ONLY');
    else if (edit) {
      grants.push(grant(edit, edit === 'platforms.configure' ? platformScope : allScope, { source: 'legacy_effective' }));
      // A migrated official-query runner also needs the matching read capability.
      if (id === 'officialKda') grants.push(grant('queries.read', allScope, { source: 'legacy_effective' }));
      if (id === 'system') review.push('system.edit:ADDITIONAL_ACTIONS_REQUIRE_REVIEW');
    }
    else review.push(`${id}.edit:UNMAPPED`);
  }
  if (user.role === 'leader') {
    for (const cap of ['members.basic_edit', 'squads.manage', 'signups.delegate']) {
      if (led.length) grants.push(grant(cap, { type: 'squads', ids: led }, { source: 'legacy_leader' }));
    }
    review.push('UNASSIGNED_MEMBER_EDIT_REMOVED');
  }
  return { grants, review };
}

export function validGrant(g) {
  if (!CAPABILITIES.includes(g?.capability) || !['allow', 'deny'].includes(g.effect)) return false;
  if (['self', 'all'].includes(g.scope?.type)) return Object.keys(g.scope).length === 1;
  return ['squads', 'wipes', 'platformTargets'].includes(g.scope?.type) && Array.isArray(g.scope.ids) &&
    g.scope.ids.length > 0 && g.scope.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 160);
}

// Resource relationships come from the repository, never the caller's request body.
export function scopeMatches(scope, actor, resource, relations, effect = 'allow') {
  if (scope?.type === 'all') return true;
  const memberId = resource.kind === 'member' ? resource.id : resource.memberId;
  const memberSquads = id => relations.squadMembers.filter(s => s.memberId === id && !s.validTo).map(s => s.squadId);
  if (scope?.type === 'self') {
    if (resource.kind === 'account') return resource.id === actor.id;
    if (memberId) return memberId === actor.memberId;
    const ownSquads = memberSquads(actor.memberId);
    if (resource.kind === 'squad') return ownSquads.includes(resource.id);
    if (resource.kind === 'wipe') {
      const wipe = relations.wipes.find(w => w.id === resource.id);
      return Boolean(wipe?.audience?.memberIds?.includes(actor.memberId) || wipe?.audience?.squadIds?.some(id => ownSquads.includes(id)) ||
        (wipe?.audience?.includeUnassigned && !ownSquads.length && actor.memberId));
    }
    return false;
  }
  if (!Array.isArray(scope?.ids)) return false;
  if (scope.type === 'squads') {
    if (resource.kind === 'wipe') {
      const audience = relations.wipes.find(w => w.id === resource.id)?.audience;
      if (effect === 'deny') return Boolean(audience && ((audience.squadIds || []).some(id => scope.ids.includes(id)) ||
        (audience.memberIds || []).some(id => memberSquads(id).some(squadId => scope.ids.includes(squadId))) || audience.includeUnassigned));
      // A squad grant manages only an audience wholly covered by that grant.
      return Boolean(audience && !audience.includeUnassigned && (audience.squadIds?.length || audience.memberIds?.length) &&
        (audience.squadIds || []).every(id => scope.ids.includes(id)) &&
        (audience.memberIds || []).every(id => memberSquads(id).some(squadId => scope.ids.includes(squadId))));
    }
    const ids = resource.kind === 'squad' ? [resource.id] : memberId ? memberSquads(memberId) : [];
    return ids.some(id => scope.ids.includes(id));
  }
  if (scope.type === 'wipes') return scope.ids.includes(resource.kind === 'wipe' ? resource.id : resource.wipeId);
  if (scope.type === 'platformTargets') return scope.ids.includes(resource.kind === 'platformTarget' ? resource.id : resource.platformTargetId);
  return false;
}

export function can(actor, capability, resource, relations) {
  if (!actor || actor.status !== 'active' || actor.restricted || !CAPABILITIES.includes(capability)) return false;
  const grants = [...(actor.grants || []), ...(actor.memberId ? MEMBER_GRANTS : [])];
  const matched = grants.filter(g => validGrant(g) && g.capability === capability && scopeMatches(g.scope, actor, resource, relations, g.effect));
  return matched.some(g => g.effect === 'allow') && !matched.some(g => g.effect === 'deny');
}
export function authorize(actor, capability, resource, relations, hidden = false) {
  if (!can(actor, capability, resource, relations)) throw new IdentityError(hidden ? 'RESOURCE_NOT_FOUND' : 'ACCESS_DENIED', hidden ? 404 : 403);
}
export function memberDTO(member) {
  return { id: member.id, displayName: member.displayName || member.customName || member.steamNickname || '',
    avatar: member.avatar || '', specialty: member.specialty || [],
    membershipStatus: ({ active: 'active', suspended: 'paused', left: 'departed', blocked: 'departed' })[member.memberStatus] || member.membershipStatus || 'applicant',
    revision: member.revision || 1 };
}
