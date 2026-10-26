import { randomUUID } from 'node:crypto';
import { accountRole, activeMappedSystemRoleSources, mappedSystemRoleSources, roleGrants } from './permissions.js';
import { applyRoleSpecialties, platformRoleContext } from './role-specialties.js';

const stamp = now => new Date(now()).toISOString();

function applySquadMapping(repo, member, evidence, context, now) {
  const current = repo.all('squadMembers').filter(row => row.memberId === member.id && !row.validTo);
  if (current.length > 1) return;
  const previous = member.roleDerivedSquad || null;
  // A manual move supersedes an earlier automatic move, including when the
  // member no longer belongs to any squad.
  const owned = previous && current[0]?.squadId === previous.squadId;
  const rule = (context.config?.roleSquadMappings || []).find(context.matches);
  const squad = rule && repo.get('squads', rule.squadId);
  const selected = squad && !squad.archivedAt ? rule : null;
  if (!selected && !previous) return;
  if (previous && !owned) {
    repo.put('members', { ...member, roleDerivedSquad: null, revision: (member.revision || 1) + 1, updatedAt: stamp(now) });
    return;
  }
  // Do not claim an existing manual squad merely because it matches the rule.
  if (selected && current.length && !previous) return;
  const squadId = selected?.squadId || null;
  if ((current[0]?.squadId || null) !== squadId) {
    for (const relation of current) repo.remove('squadMembers', relation.id);
    if (squadId) repo.put('squadMembers', { id: `squad_member_${randomUUID()}`, memberId: member.id, squadId,
      validFrom: stamp(now), validTo: null, createdAt: stamp(now), addedByUserId: `${evidence.provider}:${evidence.externalId}` });
  }
  const nextSource = selected ? { provider: evidence.provider, guildId: evidence.guildId, roleId: selected.roleId, squadId } : null;
  if (JSON.stringify(nextSource) !== JSON.stringify(previous)) repo.put('members', { ...member, roleDerivedSquad: nextSource,
    revision: (member.revision || 1) + 1, updatedAt: stamp(now) });
}

function applySystemMapping(repo, account, evidence, context) {
  if (!account || accountRole(repo, account) === 'owner' || account.adminAssignedByOwner === true) return;
  const previous = mappedSystemRoleSources(account);
  const matches = (context.config?.roleSystemMappings || []).filter(context.matches).map(rule => ({
    provider: evidence.provider, guildId: evidence.guildId, roleId: rule.roleId, systemRole: rule.systemRole
  }));
  if (!matches.length && !previous.length) return;
  const sources = activeMappedSystemRoleSources(repo, account, [
    ...previous.filter(source => source.provider !== evidence.provider), ...matches
  ]).sort((a, b) => Number(b.systemRole === 'admin') - Number(a.systemRole === 'admin') ||
    a.provider.localeCompare(b.provider) || a.roleId.localeCompare(b.roleId));
  // Every verified platform contributes; the highest mapped role wins.
  const selected = sources[0] || null;
  const systemRole = selected?.systemRole || 'member';
  if (account.roleId === systemRole && JSON.stringify(account.roleDerivedSystemRole || null) === JSON.stringify(selected) &&
      JSON.stringify(previous) === JSON.stringify(sources)) return;
  repo.put('accounts', { ...account, roleId: systemRole, roleDerivedSystemRole: selected, roleDerivedSystemRoles: sources,
    grants: roleGrants(systemRole), permissionVersion: (account.permissionVersion || 1) + 1,
    revision: (account.revision || 1) + 1 });
}

export function applyRoleMappings(repo, member, account, evidence, now) {
  if (!member) return;
  const context = platformRoleContext(repo.db, evidence);
  if (!context) return;
  applyRoleSpecialties(repo, member, evidence, now);
  applySquadMapping(repo, repo.get('members', member.id), evidence, context, now);
  applySystemMapping(repo, account && repo.get('accounts', account.id), evidence, context);
}

export function applyVerifiedSystemRole(repo, account, evidence) {
  const context = platformRoleContext(repo.db, evidence);
  if (context) applySystemMapping(repo, account, evidence, context);
}
