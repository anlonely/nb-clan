const MANAGEMENT_ROLES = new Set(['admin', 'member_manager']);

function normalizedRole(value) {
  return String(value || '').trim().toLowerCase();
}

function canViewPrivateMemberFields(access = {}, member = {}) {
  if (member.canManage === true || access.canManage === true || access.member?.canManage === true) {
    return true;
  }
  const roles = [
    access.role,
    access.managementUser?.role,
    access.wechatManagementUser?.role,
    access.wechatUser?.role
  ];
  return roles.some((role) => MANAGEMENT_ROLES.has(normalizedRole(role)));
}

function hasDisplayValue(value) {
  if (Array.isArray(value)) return value.some(hasDisplayValue);
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  return true;
}

function privateDetailRow(canViewPrivate, sourceValues, row) {
  return canViewPrivate || hasDisplayValue(sourceValues) ? row : null;
}

function compactDetailSections(sections = []) {
  return sections
    .map((section) => ({
      ...section,
      rows: (section.rows || []).filter(Boolean)
    }))
    .filter((section) => section.rows.length > 0);
}

module.exports = {
  canViewPrivateMemberFields,
  compactDetailSections,
  hasDisplayValue,
  privateDetailRow
};
