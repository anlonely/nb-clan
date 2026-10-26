export const ROLES = {
  ADMIN: 'admin',
  MEMBER_MANAGER: 'member_manager',
  LEADER: 'leader',
  MEMBER: 'member',
  VIEWER: 'viewer'
};

export const BUILTIN_ROLE_IDS = Object.values(ROLES);

export const PERMISSION_MODULES = [
  { id: 'query', labelKey: 'navQuery' },
  { id: 'members', labelKey: 'navMembers' },
  { id: 'departedMembers', labelKey: 'navDepartedMembers' },
  { id: 'riskAlerts', labelKey: 'highRiskAccountAlerts' },
  { id: 'squads', labelKey: 'navSquads' },
  { id: 'server', labelKey: 'navServer' },
  { id: 'rustTools', labelKey: 'navRustTools' },
  { id: 'rustClanInfo', labelKey: 'navRustClanInfo' },
  { id: 'rustClanChat', labelKey: 'navRustClanChat' },
  { id: 'kda', labelKey: 'navKda' },
  { id: 'history', labelKey: 'navHistory' },
  { id: 'discordBot', labelKey: 'navDiscordBot' },
  { id: 'kookBot', labelKey: 'navKookBot' },
  { id: 'discordKookSync', labelKey: 'navDiscordKookSync' },
  { id: 'wechatMini', labelKey: 'navWechatMiniProgram' },
  { id: 'logs', labelKey: 'navLogs' },
  { id: 'sync', labelKey: 'syncCenter' },
  { id: 'system', labelKey: 'navSystem' },
  { id: 'api', labelKey: 'navApi' },
  { id: 'users', labelKey: 'navUsers' },
  { id: 'permissions', labelKey: 'navPermissions' },
  { id: 'officialKda', labelKey: 'navOfficialKda' },
  { id: 'inventoryDetails', labelKey: 'navInventoryDetails' }
];

const PERMISSION_MODULE_IDS = new Set(PERMISSION_MODULES.map((module) => module.id));
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

function normalizePermissionText(value, maxLength = 120) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

export function normalizePermissionRoleCode(value) {
  const code = normalizePermissionText(value, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return ROLE_CODE_PATTERN.test(code) ? code : '';
}

function permissionCell(view = false, edit = false) {
  const canEdit = Boolean(edit);
  return {
    view: Boolean(view || canEdit),
    edit: canEdit
  };
}

function matrixFor({ view = [], edit = [] } = {}) {
  const viewIds = new Set(view);
  const editIds = new Set(edit);
  const matrix = {};
  for (const module of PERMISSION_MODULES) {
    matrix[module.id] = permissionCell(viewIds.has(module.id), editIds.has(module.id));
  }
  return matrix;
}

const ALL_MODULE_IDS = PERMISSION_MODULES.map((module) => module.id);
const OPS_MODULE_IDS = ['squads', 'server', 'rustTools', 'rustClanInfo', 'rustClanChat', 'kda', 'history'];
const EXTERNAL_LOOKUP_MODULE_IDS = ['officialKda', 'inventoryDetails'];

const BUILTIN_ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: matrixFor({ view: ALL_MODULE_IDS, edit: ALL_MODULE_IDS }),
  [ROLES.MEMBER_MANAGER]: matrixFor({
    view: ['query', 'members', 'departedMembers', 'riskAlerts', 'wechatMini', ...EXTERNAL_LOOKUP_MODULE_IDS],
    edit: ['query', 'members', 'departedMembers', 'riskAlerts', 'wechatMini', ...EXTERNAL_LOOKUP_MODULE_IDS]
  }),
  [ROLES.LEADER]: matrixFor({
    view: ['query', 'members', 'departedMembers', 'riskAlerts', ...OPS_MODULE_IDS, ...EXTERNAL_LOOKUP_MODULE_IDS],
    edit: ['query', 'riskAlerts', ...EXTERNAL_LOOKUP_MODULE_IDS]
  }),
  [ROLES.MEMBER]: matrixFor({
    view: ['query', 'members', 'departedMembers', ...OPS_MODULE_IDS, ...EXTERNAL_LOOKUP_MODULE_IDS],
    edit: ['query', ...EXTERNAL_LOOKUP_MODULE_IDS]
  }),
  [ROLES.VIEWER]: matrixFor({
    view: ['query', 'members', 'departedMembers', 'riskAlerts', ...OPS_MODULE_IDS, 'wechatMini', 'logs', 'users', 'permissions', ...EXTERNAL_LOOKUP_MODULE_IDS],
    edit: ['query', ...EXTERNAL_LOOKUP_MODULE_IDS]
  })
};

export function normalizePermissionMatrix(input = {}) {
  const matrix = {};
  for (const module of PERMISSION_MODULES) {
    const raw = input?.[module.id] || {};
    matrix[module.id] = permissionCell(raw.view, raw.edit);
  }
  return matrix;
}

export function builtinRolePermissions(role) {
  return normalizePermissionMatrix(BUILTIN_ROLE_PERMISSIONS[normalizeRole(role)] || {});
}

export function builtinRolePayload(role) {
  const normalizedRole = normalizeRole(role);
  return {
    code: normalizedRole,
    name: normalizedRole,
    description: '',
    builtIn: true,
    system: true,
    locked: true,
    permissions: builtinRolePermissions(normalizedRole),
    createdAt: '',
    updatedAt: ''
  };
}

export function normalizePermissionRole(input = {}, existing = {}, now = '', options = {}) {
  const rawCode = input.code || input.id || existing.code || existing.id || '';
  const code = normalizePermissionRoleCode(rawCode);
  const builtIn = BUILTIN_ROLE_IDS.includes(code);
  if (!code || (builtIn && options.allowBuiltIn !== true)) return null;
  const name = normalizePermissionText(input.name ?? existing.name ?? code, 40) || code;
  const description = normalizePermissionText(input.description ?? existing.description ?? '', 240);
  const createdAt = normalizePermissionText(existing.createdAt || input.createdAt || now, 40);
  const updatedAt = normalizePermissionText(input.updatedAt || now || existing.updatedAt || createdAt, 40);
  return {
    code,
    name,
    description,
    builtIn,
    system: builtIn,
    locked: false,
    permissions: normalizePermissionMatrix(input.permissions || existing.permissions || (builtIn ? builtinRolePermissions(code) : {})),
    createdAt,
    updatedAt
  };
}

export function normalizePermissionRoles(roles = [], now = '') {
  const byCode = new Map();
  for (const role of Array.isArray(roles) ? roles : []) {
    const normalized = normalizePermissionRole(role, {}, now, { allowBuiltIn: true });
    if (normalized) byCode.set(normalized.code, normalized);
  }
  return [...byCode.values()];
}

export function roleExists(role, customRoles = []) {
  const normalizedRole = normalizePermissionText(role, 40);
  return BUILTIN_ROLE_IDS.includes(normalizedRole) || normalizePermissionRoles(customRoles).some((item) => item.code === normalizedRole);
}

export function normalizeRole(role, customRoles = []) {
  if (role === ROLES.MEMBER_MANAGER) return ROLES.MEMBER_MANAGER;
  if (role === ROLES.ADMIN) return ROLES.ADMIN;
  if (role === ROLES.LEADER) return ROLES.LEADER;
  if (role === ROLES.MEMBER) return ROLES.MEMBER;
  if (role === ROLES.VIEWER) return ROLES.VIEWER;
  if (normalizePermissionRoles(customRoles).some((item) => item.code === role)) return role;
  return '';
}

export function rolePermissions(role, customRoles = []) {
  const normalizedRole = normalizePermissionText(role, 40);
  const customRole = normalizePermissionRoles(customRoles).find((item) => item.code === normalizedRole);
  if (customRole) return normalizePermissionMatrix(customRole.permissions);
  if (BUILTIN_ROLE_IDS.includes(normalizedRole)) return builtinRolePermissions(normalizedRole);
  return normalizePermissionMatrix({});
}

export function permissionAllows(permissions = {}, moduleId, action = 'view') {
  if (!PERMISSION_MODULE_IDS.has(moduleId)) return false;
  const cell = permissions[moduleId] || {};
  if (action === 'edit') return Boolean(cell.edit);
  return Boolean(cell.view || cell.edit);
}

export function roleCan(role, customRoles = [], moduleId, action = 'view') {
  return permissionAllows(rolePermissions(role, customRoles), moduleId, action);
}

export function userCan(user, customRoles = [], moduleId, action = 'view') {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return roleCan(user.role, customRoles, moduleId, action);
}

export function roleHasAnyEditPermission(role, customRoles = []) {
  const permissions = rolePermissions(role, customRoles);
  return PERMISSION_MODULES.some((module) => permissionAllows(permissions, module.id, 'edit'));
}

export function roleEditModuleIds(role, customRoles = []) {
  const permissions = rolePermissions(role, customRoles);
  return PERMISSION_MODULES.filter((module) => permissionAllows(permissions, module.id, 'edit')).map((module) => module.id);
}

export function canManageAnyMember(user) {
  return user?.role === ROLES.ADMIN || user?.role === ROLES.MEMBER_MANAGER;
}

export function isAdmin(user) {
  return user?.role === ROLES.ADMIN;
}

export function isLeader(user) {
  return user?.role === ROLES.LEADER;
}

export function isViewer(user) {
  return user?.role === ROLES.VIEWER;
}

export function isMember(user) {
  return user?.role === ROLES.MEMBER;
}

export function canViewAllData(user) {
  return isAdmin(user) || isViewer(user);
}

export function squadLeaderIds(squad) {
  if (!squad) return [];
  const ids = Array.isArray(squad.leaderUserIds) ? squad.leaderUserIds : [squad.leaderUserId];
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}

export function isSquadLeader(user, squad) {
  return Boolean(user?.id && !squad?.archivedAt && squadLeaderIds(squad).includes(user.id));
}

export function canManageMember(user, member, context = {}) {
  if (!user || !member) return false;
  if (canManageAnyMember(user)) return true;
  if (user.role === ROLES.MEMBER) return Boolean(user.boundSteamId && member.steamId === user.boundSteamId);
  if (user.role !== ROLES.LEADER) return false;

  const hasSquadContext = Object.hasOwn(context || {}, 'memberSquadId');
  if (!hasSquadContext) return member.invitedByUserId === user.id;

  const memberSquadId = String(context.memberSquadId || '').trim();
  if (!memberSquadId) return true;
  const leaderSquadIds = new Set((context.leaderSquadIds || []).map((id) => String(id || '').trim()).filter(Boolean));
  return leaderSquadIds.has(memberSquadId);
}

export function canUseSquads(user, squads = []) {
  return canViewAllData(user) || isLeader(user) || isMember(user) || squads.some((squad) => isSquadLeader(user, squad));
}

export function canManageSquad(user, squad) {
  if (!user || !squad) return false;
  if (isAdmin(user)) return true;
  return isSquadLeader(user, squad);
}

export function canViewSquad(user, squad) {
  if (!user || !squad || squad.archivedAt) return false;
  if (canViewAllData(user)) return true;
  if (isLeader(user)) return true;
  if (isMember(user)) return true;
  return canManageSquad(user, squad);
}

export function canManageWipes(user) {
  return isAdmin(user);
}

export function canViewWipes(user, squads = []) {
  return canViewAllData(user) || isLeader(user) || isMember(user) || squads.some((squad) => isSquadLeader(user, squad));
}

export function canManageWipeParticipant(user, member, memberSquad, leaderSquad) {
  if (!user || !member) return false;
  if (isAdmin(user)) return true;
  if (!leaderSquad) return false;
  if (!memberSquad?.squadId) return true;
  return memberSquad.squadId === leaderSquad.id;
}
