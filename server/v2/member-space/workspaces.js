import { can, validGrant } from '../identity/permissions.js';
import { wipePermissionPredicate, memberPermissionPredicate } from './repository.js';
import { managementSections, systemManagementSection } from './management-sections.js';

const wipeActions = ['wipes.edit', 'wipes.publish', 'wipes.start', 'wipes.end', 'wipes.archive'];
const notificationActions = ['notifications.preview', 'notifications.send', 'notifications.reconcile'];

// An entry hint, not target authorization: there may be no configured target in
// this scope. The notification catalog must still resolve and authorize each ID.
function hasNotificationScope(actor) {
  return notificationActions.some(capability => {
    const grants = actor.grants.filter(g => validGrant(g) && g.capability === capability);
    if (grants.some(g => g.effect === 'deny' && g.scope.type === 'all')) return false;
    const denied = new Set(grants.filter(g => g.effect === 'deny' && g.scope.type === 'platformTargets').flatMap(g => g.scope.ids));
    return grants.some(g => g.effect === 'allow' && (g.scope.type === 'all' ||
      g.scope.type === 'platformTargets' && g.scope.ids.some(id => !denied.has(id))));
  });
}

function canCreate(identity, actor, relations) {
  // G04 chooses a new ID itself. Grants for an existing wipe cannot authorize
  // creation. Test only prospective audiences G04 can actually accept.
  const creator = { ...actor, grants: actor.grants.filter(g => !(g.capability === 'wipes.create' && g.scope?.type === 'wipes')) };
  const candidates = [{ squadIds: [], memberIds: [], includeUnassigned: false }];
  if (actor.memberId) candidates.push({ squadIds: [], memberIds: [actor.memberId], includeUnassigned: false });
  const squadIds = new Set(actor.grants.filter(g => validGrant(g) && g.capability === 'wipes.create' &&
    g.effect === 'allow' && g.scope.type === 'squads').flatMap(g => g.scope.ids));
  for (const id of squadIds) if (identity.repo.get('squads', id)) candidates.push({ squadIds: [id], memberIds: [], includeUnassigned: false });
  return candidates.some(audience => can(creator, 'wipes.create', { kind: 'wipe', id: 'prospective-workspace-wipe' },
    { ...relations, wipes: [{ id: 'prospective-workspace-wipe', audience }] }));
}

export function workspaceCapabilities(identity, actor, { memberReadable, relations, schedulingOnly = false }) {
  const member = memberReadable === true;
  if (actor.status !== 'active' || actor.restricted) return { member: false, admin: false };
  if (actor.roleId === 'member') return { member, admin: false };
  if (!schedulingOnly && systemManagementSection(identity, actor).length) return { member, admin: true };
  if (!schedulingOnly && managementSections(actor, relations, actor.grants, identity).length) return { member, admin: true };
  if (canCreate(identity, actor, relations)) return { member, admin: true };

  const read = wipePermissionPredicate(actor, 'wipes.read');
  const actions = wipeActions.map(capability => wipePermissionPredicate(actor, capability));
  const delegate = memberPermissionPredicate(actor, 'signups.delegate', 'm.id', 'w.id');
  // Delegation is scoped to the signup subject, even in a mixed-squad wipe.
  // SQL filters current scope before EXISTS; no hidden rows/counts enter the DTO.
  const audience = `(COALESCE(json_extract(w.payload_json,'$.audience.allMembers'),0)=1 OR EXISTS (SELECT 1 FROM json_each(json_extract(w.payload_json,'$.audience.memberIds')) a WHERE a.value=m.id)
    OR EXISTS (SELECT 1 FROM json_records sm JOIN json_each(json_extract(w.payload_json,'$.audience.squadIds')) a
      ON a.value=json_extract(sm.payload_json,'$.squadId') WHERE sm.collection='squadMembers'
      AND json_extract(sm.payload_json,'$.memberId')=m.id AND COALESCE(json_extract(sm.payload_json,'$.validTo'),'')='')
    OR (json_extract(w.payload_json,'$.audience.includeUnassigned')=1 AND NOT EXISTS
      (SELECT 1 FROM json_records sm WHERE sm.collection='squadMembers' AND json_extract(sm.payload_json,'$.memberId')=m.id
        AND COALESCE(json_extract(sm.payload_json,'$.validTo'),'')='')))`;
  const manageable = [...actions.map(p => p.text),
    `EXISTS (SELECT 1 FROM json_records m WHERE m.collection='members' AND ${audience} AND ${delegate.text})`,
    hasNotificationScope(actor) ? '1' : '0'].join(' OR ');
  const admin = Boolean(identity.repo.db.prepare(`SELECT 1 FROM json_records w WHERE w.collection='v2Wipes'
    AND ${read.text} AND (${manageable}) LIMIT 1`).get(...read.args, ...actions.flatMap(p => p.args), ...delegate.args));
  return { member, admin };
}
