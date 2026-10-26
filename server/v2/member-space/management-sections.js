import { relayAccess } from '../relay-admin/access.js';
import { can, validGrant } from '../identity/permissions.js';
import { accessDTO } from '../system-admin/access.js';

export function systemManagementSection(identity, actor) {
  if (actor.status !== 'active' || actor.restricted || actor.roleId === 'member') return [];
  const area = Object.entries(accessDTO(identity, actor).areas).find(([, access]) => access.read)?.[0];
  return area ? [{ id: 'system', path: `/admin/system/${area === 'api_keys' ? 'public-api' : area}` }] : [];
}

const sections = [
  ['members', '/admin/members', ['members.read', 'members.basic_edit', 'members.review', 'risks.manage'], 'member'],
  ['stats', '/admin/stats', ['stats.read', 'queries.read', 'inventory.read'], 'member'],
  ['sync', '/admin/sync', ['sync.read'], 'sync'],
  ['realtime', '/admin/realtime/info', ['relay.read', 'relay.chat_read'], 'squad'],
  ['platforms', '/admin/platforms/discord', ['platforms.read', 'system.api_keys'], 'platformTarget']
];

// Navigation hints only. Each domain still checks its actual resource. Implicit
// self grants expose the member workspace, not management navigation.
export function managementSections(actor, relations, explicitGrants, identity) {
  if (actor.status !== 'active' || actor.restricted || actor.roleId === 'member') return [];
  const allows = (capability, kind) =>
    explicitGrants.filter(g => validGrant(g) && g.capability === capability && g.effect === 'allow' && g.scope.type !== 'self')
      .some(g => {
        const resourceKind = capability === 'system.api_keys' ? 'system' : { squads: 'squad', wipes: 'wipe', platformTargets: 'platformTarget' }[g.scope.type] || kind;
        return (g.scope.type === 'all' ? ['__workspace_entry__'] : g.scope.ids || []).some(id =>
          can(actor, capability, { kind: resourceKind, id: capability === 'system.api_keys' ? 'api_keys' : id, ...(g.scope.type === 'querySources' ? {querySourceId:id} : {}) }, relations));
      });
  const result = sections.filter(([, , capabilities, kind]) => capabilities.some(capability => allows(capability, kind)))
    .map(([id, path]) => {
      if (id === 'platforms' && !allows('platforms.read', 'platformTarget')) path = '/admin/platforms/sources';
      if (id === 'stats' && !allows('stats.read', 'member')) {
        const source = ['official', 'member', 'vital', 'moose'].find(querySourceId =>
          can(actor, 'queries.read', {kind:'query', id:querySourceId, querySourceId}, relations));
        path = `/admin/stats/query?source=${source || 'inventory'}`;
      }
      return {id, path};
    });
  // Bot tools use the existing community-platform read authority. Steam,
  // WeChat, API-key and relay-only access must not expose this management area.
  if (['discord', 'kook'].some(id => can(actor, 'platforms.read', {kind:'platformTarget',id}, relations))) {
    const index = result.findIndex(section => section.id === 'platforms');
    result.splice(index < 0 ? result.length : index, 0, {id:'bot',path:'/admin/bot/features'});
  }
  if (identity && !result.some(s=>s.id==='platforms') && relayAccess(identity,actor).allowed) result.push({id:'platforms',path:'/admin/platforms/relay'});
  return result;
}
