import { normalizeText } from './store.js';

export const MEMBER_STATUSES = new Set(['active', 'suspended', 'left', 'blocked']);

export const MEMBER_STATUS_TEXT = {
  active: '正常',
  suspended: '暂停',
  left: '退队',
  blocked: '黑名单'
};

export function normalizeMemberStatus(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return MEMBER_STATUSES.has(normalized) ? normalized : 'active';
}

export function memberStatusText(value) {
  const status = normalizeMemberStatus(value);
  return MEMBER_STATUS_TEXT[status] || status;
}
