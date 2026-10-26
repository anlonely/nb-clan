function roleLabel(role, t) {
  if (role === 'admin') return t('adminRole');
  if (role === 'leader') return t('leaderRole');
  if (role === 'member') return t('memberRole');
  if (role === 'viewer') return t('viewerRole');
  if (role === 'member_manager') return t('managerRole');
  return role || t('managerRole');
}

function accountRoleLabel(user, t) {
  if (user?.isRoot || user?.username === 'root') return t('superAdminRole');
  const builtInLabel = roleLabel(user?.role, t);
  if (builtInLabel !== user?.role) return builtInLabel;
  return user?.roleLabel || user?.role || t('managerRole');
}

function modulePermission(user, moduleId) {
  return user?.permissions?.[moduleId] || {};
}

function canViewModule(user, moduleId) {
  if (user?.isRoot || user?.id === 'user_root' || user?.username === 'root') return true;
  const permission = modulePermission(user, moduleId);
  return Boolean(permission.view || permission.edit);
}

function canViewOperationalBackendData(user) {
  if (user?.isRoot || user?.id === 'user_root' || user?.username === 'root') return true;
  if (['admin', 'viewer', 'member'].includes(user?.role)) return true;
  return ['squads', 'server', 'kda', 'history'].some((moduleId) => canViewModule(user, moduleId));
}

function canEditModule(user, moduleId) {
  if (user?.isRoot || user?.id === 'user_root' || user?.username === 'root') return true;
  return Boolean(modulePermission(user, moduleId).edit);
}

function roleCanBeAssignedByUser(user, role) {
  if (!role?.code) return false;
  if (user?.isRoot || user?.id === 'user_root' || user?.username === 'root') return true;
  if (!canEditModule(user, 'users')) return false;
  if (role.code === 'admin') return false;
  if (role.permissions?.permissions?.edit) return false;
  const permissions = role.permissions || {};
  return Object.entries(permissions).every(([moduleId, value]) => {
    if (value?.edit && !canEditModule(user, moduleId)) return false;
    if ((value?.view || value?.edit) && !canViewModule(user, moduleId)) return false;
    return true;
  });
}

function roleOptionsForUser(user, roles = []) {
  return roles.filter((role) => roleCanBeAssignedByUser(user, role));
}

function ensureCurrentRoleOption(options, roles, roleCode) {
  if (!roleCode || options.some((role) => role.code === roleCode)) return options;
  const current = roles.find((role) => role.code === roleCode);
  return current ? [current, ...options] : options;
}

function roleOptionLabel(role, t) {
  if (!role) return '';
  const builtIn = roleLabel(role.code, t);
  return builtIn !== role.code ? builtIn : (role.name || role.code);
}

function normalizePermissionDraft(permissions = {}) {
  const next = {};
  Object.entries(permissions || {}).forEach(([moduleId, value]) => {
    const edit = Boolean(value?.edit);
    next[moduleId] = {
      view: Boolean(value?.view || edit),
      edit
    };
  });
  return next;
}

function updatePermissionDraft(permissions, moduleId, action, checked) {
  const current = normalizePermissionDraft(permissions);
  const cell = current[moduleId] || { view: false, edit: false };
  if (action === 'edit') {
    current[moduleId] = { view: checked ? true : cell.view, edit: checked };
  } else {
    current[moduleId] = { view: checked, edit: checked ? cell.edit : false };
  }
  return current;
}


export {
  roleLabel,
  accountRoleLabel,
  modulePermission,
  canViewModule,
  canViewOperationalBackendData,
  canEditModule,
  roleCanBeAssignedByUser,
  roleOptionsForUser,
  ensureCurrentRoleOption,
  roleOptionLabel,
  normalizePermissionDraft,
  updatePermissionDraft
};
