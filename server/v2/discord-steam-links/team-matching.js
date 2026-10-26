const roleId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);

/** Only signed roles from this interaction participate. Labels and Steam IDs
 * never select a website member or a team. */
export function matchSteamTeam({ enabled, target, discordRoleIds } = {}) {
  if (enabled !== true) return { status: 'disabled' };
  const held = new Set((Array.isArray(discordRoleIds) ? discordRoleIds : []).filter(roleId));
  const matches = ['CN', 'EU'].map(code => {
    const prefix = code === 'CN' ? 'Cn' : 'Eu';
    const configured = target?.[`steamTeam${prefix}RoleIds`];
    const roleIds = [...new Set((Array.isArray(configured) ? configured : []).filter(value => roleId(value) && held.has(value)))].sort();
    return { code, squadId: target?.[`steamTeam${prefix}SquadId`], roleIds, targetId: target?.id };
  }).filter(team => team.roleIds.length);
  if (matches.length > 1) return { status: 'role_conflict' };
  if (!matches.length) return { status: 'no_match' };
  const team = matches[0];
  if (typeof team.squadId !== 'string' || !team.squadId.trim()) return { status: 'squad_unavailable' };
  return { status: 'matched', team };
}

export const steamTeamSyncStatuses = Object.freeze(['synced', 'unchanged', 'manual_preserved', 'identity_conflict',
  'member_unavailable', 'squad_unavailable']);

export const steamTeamStatusKey = status => ({
  synced: 'teamSynced', unchanged: 'teamUnchanged', manual_preserved: 'teamManualPreserved',
  identity_conflict: 'teamIdentityConflict', member_unavailable: 'teamMemberUnavailable', squad_unavailable: 'teamSquadUnavailable',
  no_match: 'teamNoMatch', role_conflict: 'teamRoleConflict', disabled: 'teamDisabled', failed: 'teamSyncFailed',
})[status] || 'teamSyncFailed';
