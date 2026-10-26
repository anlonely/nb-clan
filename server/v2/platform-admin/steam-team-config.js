import { authorize, can } from '../identity/permissions.js';
import { IdentityError } from '../identity/errors.js';

const collection = { kind: 'account', id: '__collection__' };
const capabilities = ['members.basic_edit', 'squads.manage'];
export const canConfigureSteamTeams = (actor, relations) => capabilities.every(capability => can(actor, capability, collection, relations));

function teamConfiguration(config) {
  const command = config.commands?.find(row => row.id === 'setsteam');
  const automatic = command?.autoMatchTeamByRole === true;
  const targets = (config.targets || []).filter(row => row.steamTeamCnSquadId || row.steamTeamEuSquadId ||
    row.steamTeamCnRoleIds?.length || row.steamTeamEuRoleIds?.length).map(row => ({
    id: row.id, guildId: row.guildId, channelId: row.channelId, enabled: row.enabled === true,
    assigned: row.enabledCommandIds?.includes('setsteam') === true,
    cn: { squadId: row.steamTeamCnSquadId || '', roles: [...(row.steamTeamCnRoleIds || [])].sort() },
    eu: { squadId: row.steamTeamEuSquadId || '', roles: [...(row.steamTeamEuRoleIds || [])].sort() },
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { automatic, active: automatic ? config.enabled === true && command.enabled === true : false, targets };
}

// A platform-configure grant alone cannot delegate website member creation or
// team changes to a Discord command. Validate the complete merged policy, even
// when its switch and role mappings are saved from different editor sections.
export function authorizeSteamTeamConfiguration(identity, actor, current, patch) {
  const candidate = { ...current, ...patch };
  if (JSON.stringify(teamConfiguration(current)) === JSON.stringify(teamConfiguration(candidate))) return;
  const relations = identity.relations();
  for (const capability of capabilities) authorize(actor, capability, collection, relations);
  for (const target of candidate.targets || []) for (const field of ['steamTeamCnSquadId', 'steamTeamEuSquadId']) {
    if (!target[field]) continue;
    const squad = identity.repo.get('squads', target[field]);
    if (!squad || squad.archivedAt) throw new IdentityError('SQUAD_UNAVAILABLE', 422);
    authorize(actor, 'squads.manage', { kind: 'squad', id: squad.id }, relations);
  }
}
