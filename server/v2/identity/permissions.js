import { PERMISSION_MODULES, roleExists, rolePermissions, canViewWipes } from '../../permissions.js';
import { IdentityError } from './errors.js';

const groups = {
  members: ['read', 'directory', 'basic_edit', 'review', 'change_status'], risks: ['read', 'manage'],
  squads: ['read', 'manage'], wipes: ['read', 'create', 'edit', 'publish', 'start', 'end', 'archive'],
  signups: ['read', 'roster', 'self_write', 'delegate', 'override_closed'], stats: ['read', 'ranking', 'export'],
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
  .map(cap => grant(cap, selfScope))
  // Closed, read-only directory/ranking/roster projections; these never grant access
  // to another member's full profile, contact details or management commands.
  .concat(['members.directory', 'stats.ranking', 'signups.roster'].map(cap => grant(cap, allScope)));
// Existing deployments may explicitly designate a verified Steam owner.
// Fresh installations use the private database marker created by setup.
export const OWNER_STEAM_ID = /^7656119\d{10}$/.test(process.env.NB_OWNER_STEAM_ID || '') ? process.env.NB_OWNER_STEAM_ID : '';
export function mappedSystemRoleSources(account) {
  return Array.isArray(account?.roleDerivedSystemRoles) ? account.roleDerivedSystemRoles :
    account?.roleDerivedSystemRole ? [account.roleDerivedSystemRole] : [];
}
export function activeMappedSystemRoleSources(repo, account, sources = mappedSystemRoleSources(account)) {
  if (!account || !sources.length || !repo.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_admin_records'").get()) return [];
  const linked = new Set(repo.all('identities').filter(identity => identity.accountId === account.id).map(identity => identity.provider));
  const policies = new Map(repo.all('policies').map(policy => [policy.provider, policy]));
  const configs = new Map();
  return sources.filter(source => {
    if (!['discord', 'kook'].includes(source?.provider) || !['member', 'admin'].includes(source.systemRole) ||
        !linked.has(source.provider) || !policies.get(source.provider)?.enabled ||
        policies.get(source.provider).guildId !== source.guildId) return false;
    if (!configs.has(source.provider)) {
      const row = repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='config' AND id=?").get(source.provider);
      configs.set(source.provider, row ? JSON.parse(row.payload) : null);
    }
    return (configs.get(source.provider)?.roleSystemMappings || []).some(rule =>
      rule.guildId === source.guildId && rule.roleId === source.roleId && rule.systemRole === source.systemRole);
  });
}
export function accountRole(repo, account) {
  const installationOwner = repo.scalar?.('v2InstallationOwner');
  if (installationOwner?.version === 1 && installationOwner.accountId === 'user_root' &&
      account?.id === 'user_root' && account.legacyUserId === 'user_root' && repo.get('users', 'user_root')?.username === 'root') return 'owner';
  const verified = repo.all('bindings').find(b => b.accountId === account?.id && b.status === 'verified');
  if (OWNER_STEAM_ID && verified?.steamId === OWNER_STEAM_ID && verified.memberId === account.memberId && repo.get('members', account.memberId)?.steamId === OWNER_STEAM_ID) return 'owner';
  if (account?.roleId !== 'admin') return 'member';
  if (account.adminAssignedByOwner === true) return 'admin';
  return activeMappedSystemRoleSources(repo, account).some(source => source.systemRole === 'admin') ? 'admin' : 'member';
}
export function roleGrants(role) {
  return role === 'owner' || role === 'admin'
    ? CAPABILITIES.filter(cap => role === 'owner' || cap !== 'system.permissions').map(cap => grant(cap, allScope))
    : structuredClone(MEMBER_GRANTS);
}
export const SYSTEM_GRANTS = groups.system.map(action => grant(`system.${action}`, allScope));
export const QUERY_SOURCES = Object.freeze(['official', 'inventory', 'vital', 'moose', 'member']);
const queryCapabilities = ['queries.read', 'queries.run', 'inventory.read', 'inventory.query'];

// These are the old HTTP gates, including the global readonly-viewer guard.
// The Stats host supplies querySourceId after resolving/validating the source.
function legacyQueryGrants(user, permissions) {
  const readable = ['official', 'member', 'vital'];
  if (permissions.officialKda?.view || permissions.officialKda?.edit) readable.push('moose');
  const runnable = readable.filter(source => user.role !== 'viewer' || !['vital', 'moose'].includes(source));
  return [
    grant('queries.read', { type: 'querySources', ids: readable }, { source: 'legacy_query_routes' }),
    grant('queries.run', { type: 'querySources', ids: runnable }, { source: 'legacy_query_routes' }),
    ...['inventory.read', 'inventory.query'].map(cap => grant(cap, { type: 'querySources', ids: ['inventory'] }, { source: 'legacy_query_routes' }))
  ];
}

function legacyStatsGrants(user, store, permissions, led, review) {
  const operational = ['admin', 'viewer', 'member'].includes(user.role) ||
    ['squads', 'server', 'kda', 'history'].some(id => permissions[id]?.view || permissions[id]?.edit);
  const visible = canViewWipes(user, (store.squads || []).filter(s => !s.archivedAt)) ||
    ['kda', 'history'].some(id => permissions[id]?.view || permissions[id]?.edit);
  if (!visible) return [];
  const extra = { source: 'legacy_compatibility', pendingReview: true };
  if (operational) return ['wipes.read', 'stats.read', 'stats.export'].map(cap => grant(cap, allScope, extra));
  // canViewWipeRecord grants a leader the current wipe and historical wipes
  // containing their squad. Row access remains squad scoped, including exports.
  const ids = (store.wipes || []).filter(w => led.length ? w.status !== 'closed' ||
    (store.wipeSettlements || []).some(s => s.wipeId === w.id && s.participantsSnapshot?.some(p => led.includes(p.squadId))) ||
    (store.wipeParticipants || []).some(p => p.wipeId === w.id && led.includes(p.squadId)) :
    user.role === 'leader' && w.status === 'active').map(w => w.id);
  review.push('LEADER_WIPE_SNAPSHOT_REQUIRES_EXPLICIT_REFRESH', 'HISTORICAL_SQUAD_MEMBERSHIP_REQUIRES_REVIEW');
  return [
    ...(ids.length ? [grant('wipes.read', { type: 'wipes', ids }, extra)] : []),
    ...(led.length ? ['stats.read', 'stats.export'].map(cap => grant(cap, { type: 'squads', ids: led }, { source: 'legacy_leader' })) : [])
  ];
}

function legacyAdminGrants(user, permissions, review) {
  const read = id => Boolean(permissions[id]?.view || permissions[id]?.edit);
  const edit = id => Boolean(permissions[id]?.edit);
  // The legacy wipe lifecycle and member mutations retain their separate hard
  // admin role gates. Module-gated actions must respect built-in overrides too.
  const gated = {
    'risks.read': read('riskAlerts'), 'risks.manage': edit('riskAlerts'),
    'squads.manage': edit('squads'),
    'relay.read': read('rustTools') || read('rustClanInfo'), 'relay.chat_read': read('rustClanChat'),
    'sync.read': read('sync'), 'sync.run': edit('sync'), 'sync.manage': edit('sync'),
    'system.accounts': edit('users'), 'system.logs': read('logs'),
    'system.proxy': edit('system'), 'system.storage': edit('system'), 'system.brand': edit('system'),
    'system.api_keys': edit('api'), 'system.permissions': false,
    // Legacy admin status proves neither notification target membership nor
    // permission to mention roles/everyone. Keep preview; require explicit grants
    // for all side effects after the still-open migration review is resolved.
    'notifications.send': false, 'notifications.reconcile': false,
    'notifications.mention_role': false, 'notifications.mention_everyone': false
  };
  review.push('PERMISSION_EDITOR_REMAINS_ROOT_ONLY', 'NOTIFICATION_TARGET_AND_MENTION_MAPPING_REQUIRES_REVIEW');
  const grants = CAPABILITIES.filter(cap => !queryCapabilities.includes(cap) && !cap.startsWith('platforms.') &&
    gated[cap] !== false).map(cap => grant(cap, allScope, { source: 'legacy_admin' }));
  for (const [id, target] of Object.entries({ discordBot: 'discord', kookBot: 'kook', discordKookSync: 'discord_kook_bridge', wechatMini: 'wechat' })) {
    for (const [cap, allowed] of [['platforms.read', read(id)], ['platforms.configure', edit(id)]]) {
      if (allowed) grants.push(grant(cap, { type: 'platformTargets', ids: [target] }, { source: 'legacy_effective' }));
    }
  }
  return [...grants, ...legacyQueryGrants(user, permissions)];
}

const moduleMap = {
  members: ['members.read', 'members.basic_edit'], departedMembers: ['members.read', 'members.change_status'],
  riskAlerts: ['risks.read', 'risks.manage'], squads: ['squads.read', 'squads.manage'],
  server: ['wipes.read', 'wipes.edit'], kda: ['stats.read'], history: ['stats.read'],
  rustTools: ['relay.read'], rustClanInfo: ['relay.read'], rustClanChat: ['relay.chat_read'],
  sync: ['sync.read', 'sync.run'],
  discordBot: ['platforms.read', 'platforms.configure'], kookBot: ['platforms.read', 'platforms.configure'],
  discordKookSync: ['platforms.read', 'platforms.configure'], wechatMini: ['platforms.read', 'members.review'],
  logs: [null, 'system.logs'], users: [null, 'system.accounts'], permissions: [null, 'system.permissions'],
  system: [null, 'system.brand'], api: [null, 'system.api_keys']
};

// Historical import formula only. Runtime authority comes from accountRole/roleGrants.
export function migrateLegacyGrants(user, store) {
  const review = [];
  if (user.id === 'user_root' || user.username === 'root') return { grants: CAPABILITIES.map(cap => grant(cap, allScope, { source: 'legacy_root' })), review };
  if (!roleExists(user.role, store.permissionRoles)) return { grants: [], review: ['UNKNOWN_ROLE'] };
  const permissions = rolePermissions(user.role, store.permissionRoles);
  if (user.role === 'admin') return { grants: legacyAdminGrants(user, permissions, review), review };
  const led = (store.squads || []).filter(s => !s.archivedAt && (s.leaderUserIds || [s.leaderUserId]).includes(user.id)).map(s => s.id);
  const grants = [];
  for (const { id } of PERMISSION_MODULES) {
    if (['query', 'officialKda', 'inventoryDetails'].includes(id)) continue;
    const cell = permissions[id] || {};
    const [read, edit] = moduleMap[id] || [];
    const platformScope = { type: 'platformTargets', ids: [{ discordBot: 'discord', kookBot: 'kook', discordKookSync: 'discord_kook_bridge', wechatMini: 'wechat' }[id]] };
    if (read && (cell.view || cell.edit)) grants.push(grant(read, read === 'platforms.read' ? platformScope : allScope, { source: 'legacy_compatibility', pendingReview: true }));
    if (!read && (cell.view || cell.edit)) review.push(`${id}.view:UNMAPPED`);
    if (!cell.edit || user.role === 'viewer') continue;
    if (edit === 'members.basic_edit' || edit === 'members.change_status' || edit === 'members.review') {
      // Old member writes also had hard role checks; module edit alone is insufficient.
      if (user.role === 'member_manager') grants.push(grant(edit, allScope, { source: 'legacy_effective' }));
      else review.push(`${id}.edit:HARD_ROLE_GUARD`);
    } else if (['squads.manage', 'wipes.edit'].includes(edit)) {
      review.push(`${id}.edit:HARD_ROLE_GUARD`);
    } else if (edit === 'system.permissions') review.push('permissions.edit:ROOT_ONLY');
    else if (edit) {
      grants.push(grant(edit, edit === 'platforms.configure' ? platformScope : allScope, { source: 'legacy_effective' }));
      if (id === 'system') review.push('system.edit:ADDITIONAL_ACTIONS_REQUIRE_REVIEW');
    }
    else review.push(`${id}.edit:UNMAPPED`);
  }
  grants.push(...legacyStatsGrants(user, store, permissions, led, review), ...legacyQueryGrants(user, permissions));
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
  if (g.scope?.type === 'querySources') return queryCapabilities.includes(g.capability) &&
    Object.keys(g.scope).length === 2 && Array.isArray(g.scope.ids) && g.scope.ids.length > 0 &&
    g.scope.ids.every(id => QUERY_SOURCES.includes(id));
  if (['self', 'all'].includes(g.scope?.type)) return Object.keys(g.scope).length === 1;
  return ['squads', 'wipes', 'platformTargets'].includes(g.scope?.type) && Array.isArray(g.scope.ids) &&
    g.scope.ids.length > 0 && g.scope.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 160);
}

// Resource relationships come from the repository, never the caller's request body.
export function scopeMatches(scope, actor, resource, relations, effect = 'allow', capability = null) {
  if (scope?.type === 'all') return true;
  if (scope?.type === 'querySources') return QUERY_SOURCES.includes(resource.querySourceId) &&
    Array.isArray(scope.ids) && scope.ids.includes(resource.querySourceId);
  const memberId = resource.kind === 'member' ? resource.id : resource.memberId;
  const memberSquads = id => relations.squadMembers.filter(s => s.memberId === id && !s.validTo).map(s => s.squadId);
  if (scope?.type === 'self') {
    if (resource.kind === 'account') return resource.id === actor.id;
    if (memberId) return memberId === actor.memberId;
    const ownSquads = memberSquads(actor.memberId);
    if (resource.kind === 'squad') return ownSquads.includes(resource.id);
    if (resource.kind === 'wipe') {
      const wipe = relations.wipes.find(w => w.id === resource.id);
      if (wipe?.audience?.allMembers === true && actor.memberId &&
        (effect === 'deny' || capability === null || capability.endsWith('.read'))) return true;
      if (wipe?.audience?.allMembers === true && effect === 'allow') return false;
      return Boolean(wipe?.audience?.memberIds?.includes(actor.memberId) || wipe?.audience?.squadIds?.some(id => ownSquads.includes(id)) ||
        (wipe?.audience?.includeUnassigned && !ownSquads.length && actor.memberId));
    }
    return false;
  }
  if (!Array.isArray(scope?.ids)) return false;
  if (scope.type === 'squads') {
    if (resource.kind === 'wipe') {
      const audience = relations.wipes.find(w => w.id === resource.id)?.audience;
      if (effect === 'deny') return Boolean(audience && (audience.allMembers === true || (audience.squadIds || []).some(id => scope.ids.includes(id)) ||
        (audience.memberIds || []).some(id => memberSquads(id).some(squadId => scope.ids.includes(squadId))) || audience.includeUnassigned));
      // A squad grant manages only an audience wholly covered by that grant.
      return Boolean(audience && !audience.allMembers && !audience.includeUnassigned && (audience.squadIds?.length || audience.memberIds?.length) &&
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
  const matched = grants.filter(g => g?.capability === capability && validGrant(g) && scopeMatches(g.scope, actor, resource, relations, g.effect, capability));
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
