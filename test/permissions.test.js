import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERMISSION_MODULES,
  canManageMember,
  canManageSquad,
  canManageWipeParticipant,
  canUseSquads,
  canViewSquad,
  canViewWipes,
  normalizePermissionRole,
  normalizeRole,
  roleCan,
  rolePermissions,
  userCan
} from '../server/permissions.js';

test('normalizes supported roles', () => {
  assert.equal(normalizeRole('admin'), 'admin');
  assert.equal(normalizeRole('leader'), 'leader');
  assert.equal(normalizeRole('viewer'), 'viewer');
  assert.equal(normalizeRole('member_manager'), 'member_manager');
  assert.equal(normalizeRole('unknown'), '');
});

test('normalizes and applies custom permission roles', () => {
  const role = normalizePermissionRole({
    code: 'ops_audit',
    name: 'Ops audit',
    permissions: {
      users: { view: true },
      permissions: { edit: true },
      members: { edit: true }
    }
  });
  assert.equal(role.code, 'ops_audit');
  assert.equal(role.permissions.members.view, true);
  assert.equal(role.permissions.members.edit, true);
  assert.equal(normalizeRole('ops_audit', [role]), 'ops_audit');
  assert.equal(roleCan('ops_audit', [role], 'users', 'view'), true);
  assert.equal(roleCan('ops_audit', [role], 'users', 'edit'), false);
  assert.equal(userCan({ role: 'ops_audit' }, [role], 'permissions', 'edit'), true);
  assert.equal(rolePermissions('missing_role', [role]).members.edit, false);
});

test('kook bot is controlled as a standalone permission module', () => {
  assert.equal(PERMISSION_MODULES.some((module) => module.id === 'kookBot' && module.labelKey === 'navKookBot'), true);
  assert.equal(roleCan('admin', [], 'kookBot', 'edit'), true);
  assert.equal(roleCan('member_manager', [], 'kookBot', 'view'), false);

  const role = normalizePermissionRole({
    code: 'kook_operator',
    name: 'KOOK operator',
    permissions: {
      kookBot: { edit: true },
      discordBot: { view: false }
    }
  });
  assert.equal(role.permissions.kookBot.view, true);
  assert.equal(role.permissions.kookBot.edit, true);
  assert.equal(roleCan('kook_operator', [role], 'kookBot', 'edit'), true);
  assert.equal(roleCan('kook_operator', [role], 'discordBot', 'view'), false);
});

test('discord-kook sync is controlled as a standalone permission module', () => {
  assert.equal(PERMISSION_MODULES.some((module) => module.id === 'discordKookSync' && module.labelKey === 'navDiscordKookSync'), true);
  assert.equal(roleCan('admin', [], 'discordKookSync', 'edit'), true);
  assert.equal(roleCan('member_manager', [], 'discordKookSync', 'view'), false);
  assert.equal(roleCan('viewer', [], 'discordKookSync', 'view'), false);

  const role = normalizePermissionRole({
    code: 'bridge_operator',
    name: 'Bridge operator',
    permissions: {
      discordKookSync: { edit: true },
      discordBot: { view: false },
      kookBot: { view: false }
    }
  });
  assert.equal(role.permissions.discordKookSync.view, true);
  assert.equal(role.permissions.discordKookSync.edit, true);
  assert.equal(roleCan('bridge_operator', [role], 'discordKookSync', 'edit'), true);
  assert.equal(roleCan('bridge_operator', [role], 'discordBot', 'view'), false);
  assert.equal(roleCan('bridge_operator', [role], 'kookBot', 'view'), false);
});

test('departed members is controlled as a standalone permission module', () => {
  assert.equal(PERMISSION_MODULES.some((module) => module.id === 'departedMembers' && module.labelKey === 'navDepartedMembers'), true);
  assert.equal(roleCan('admin', [], 'departedMembers', 'edit'), true);
  assert.equal(roleCan('member_manager', [], 'departedMembers', 'edit'), true);
  assert.equal(roleCan('leader', [], 'departedMembers', 'view'), true);
  assert.equal(roleCan('member', [], 'departedMembers', 'view'), true);
  assert.equal(roleCan('viewer', [], 'departedMembers', 'view'), true);

  const role = normalizePermissionRole({
    code: 'departed_auditor',
    name: 'Departed auditor',
    permissions: {
      departedMembers: { view: true },
      members: { view: false }
    }
  });
  assert.equal(role.permissions.departedMembers.view, true);
  assert.equal(role.permissions.departedMembers.edit, false);
  assert.equal(roleCan('departed_auditor', [role], 'departedMembers', 'view'), true);
  assert.equal(roleCan('departed_auditor', [role], 'members', 'view'), false);
});

test('rust clan info and chat are controlled as standalone permission modules', () => {
  assert.equal(PERMISSION_MODULES.some((module) => module.id === 'rustClanInfo' && module.labelKey === 'navRustClanInfo'), true);
  assert.equal(PERMISSION_MODULES.some((module) => module.id === 'rustClanChat' && module.labelKey === 'navRustClanChat'), true);
  assert.equal(roleCan('admin', [], 'rustClanInfo', 'edit'), true);
  assert.equal(roleCan('admin', [], 'rustClanChat', 'edit'), true);

  const roles = [
    normalizePermissionRole({
      code: 'clan_info_reader',
      name: 'Clan info reader',
      permissions: {
        rustClanInfo: { view: true },
        rustClanChat: { view: false }
      }
    }),
    normalizePermissionRole({
      code: 'clan_chat_operator',
      name: 'Clan chat operator',
      permissions: {
        rustClanChat: { edit: true },
        rustClanInfo: { view: false }
      }
    })
  ];

  assert.equal(roleCan('clan_info_reader', roles, 'rustClanInfo', 'view'), true);
  assert.equal(roleCan('clan_info_reader', roles, 'rustClanChat', 'view'), false);
  assert.equal(roleCan('clan_chat_operator', roles, 'rustClanChat', 'view'), true);
  assert.equal(roleCan('clan_chat_operator', roles, 'rustClanChat', 'edit'), true);
  assert.equal(roleCan('clan_chat_operator', roles, 'rustClanInfo', 'view'), false);
});

test('stored permission roles can override built-in role matrices', () => {
  const viewerOverride = normalizePermissionRole({
    code: 'viewer',
    name: 'Viewer',
    permissions: {
      users: { view: false },
      logs: { view: true }
    }
  }, {}, '2026-01-01T00:00:00.000Z', { allowBuiltIn: true });
  assert.equal(viewerOverride.builtIn, true);
  assert.equal(rolePermissions('viewer', [viewerOverride]).users.view, false);
  assert.equal(rolePermissions('viewer', [viewerOverride]).logs.view, true);
});

test('leader member management follows current squad assignment', () => {
  const leader = { id: 'user_leader', role: 'leader', boundSteamId: '76561198000009999' };
  assert.equal(canManageMember(leader, { invitedByUserId: 'other_user' }, { memberSquadId: '', leaderSquadIds: ['squad_1'] }), true);
  assert.equal(canManageMember(leader, { invitedByUserId: 'other_user' }, { memberSquadId: 'squad_1', leaderSquadIds: ['squad_1'] }), true);
  assert.equal(canManageMember(leader, { invitedByUserId: 'user_leader' }, { memberSquadId: 'squad_2', leaderSquadIds: ['squad_1'] }), false);
  assert.equal(canManageMember(leader, { invitedByUserId: 'user_leader' }), true);
  assert.equal(canManageMember(leader, { invitedByUserId: 'other_user' }), false);
});

test('admin and member manager can manage all members', () => {
  const member = { invitedByUserId: 'other_user' };
  assert.equal(canManageMember({ id: 'admin', role: 'admin' }, member), true);
  assert.equal(canManageMember({ id: 'manager', role: 'member_manager' }, member), true);
});

test('leader can manage only their own squad', () => {
  const leader = { id: 'leader_1', role: 'leader' };
  const managerCaptain = { id: 'manager_1', role: 'member_manager' };
  assert.equal(canUseSquads(leader), true);
  assert.equal(canUseSquads({ id: 'viewer', role: 'viewer' }), true);
  assert.equal(canUseSquads({ id: 'member', role: 'member' }), true);
  assert.equal(canUseSquads({ id: 'manager', role: 'member_manager' }), false);
  assert.equal(canUseSquads(managerCaptain, [{ leaderUserIds: ['leader_1', 'manager_1'] }]), true);
  assert.equal(canManageSquad(leader, { leaderUserId: 'leader_1' }), true);
  assert.equal(canManageSquad(leader, { leaderUserId: 'leader_2' }), false);
  assert.equal(canViewSquad(leader, { leaderUserId: 'leader_2' }), true);
  assert.equal(canManageSquad(managerCaptain, { leaderUserIds: ['leader_1', 'manager_1'] }), true);
  assert.equal(canManageSquad({ id: 'admin', role: 'admin' }, { leaderUserId: 'leader_2' }), true);
  assert.equal(canManageSquad({ id: 'viewer', role: 'viewer' }, { leaderUserId: 'leader_2' }), false);
  assert.equal(canViewSquad({ id: 'viewer', role: 'viewer' }, { leaderUserId: 'leader_2' }), true);
});

test('wipe participant permissions follow leader ownership and squad membership', () => {
  const leader = { id: 'leader_1', role: 'leader' };
  const managerCaptain = { id: 'manager_1', role: 'member_manager' };
  const leaderSquad = { id: 'squad_1' };
  assert.equal(canViewWipes(leader), true);
  assert.equal(canViewWipes({ id: 'viewer', role: 'viewer' }), true);
  assert.equal(canViewWipes({ id: 'member', role: 'member' }), true);
  assert.equal(canViewWipes({ id: 'manager', role: 'member_manager' }), false);
  assert.equal(canViewWipes(managerCaptain, [{ leaderUserIds: ['manager_1'] }]), true);
  assert.equal(canManageWipeParticipant(leader, { invitedByUserId: 'other' }, null, leaderSquad), true);
  assert.equal(canManageWipeParticipant(leader, { invitedByUserId: 'other' }, { squadId: 'squad_1' }, leaderSquad), true);
  assert.equal(canManageWipeParticipant(leader, { invitedByUserId: 'other' }, { squadId: 'squad_2' }, leaderSquad), false);
  assert.equal(canManageWipeParticipant(managerCaptain, { invitedByUserId: 'other' }, { squadId: 'squad_1' }, leaderSquad), true);
  assert.equal(canManageWipeParticipant({ id: 'admin', role: 'admin' }, { invitedByUserId: 'other' }, null, null), true);
});
