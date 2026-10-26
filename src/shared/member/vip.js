const VITAL_VIP_TYPES = new Set(['priority', 'queue_skip']);
const VITAL_VIP_DISPLAY_OFFSET_MS = 8 * 60 * 60 * 1000;

function vitalVipTypeForMember(member = {}) {
  return member.vitalVipType || member.vitalVip?.type || 'none';
}

function normalizeVipDate(value, nowMs = Date.now()) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const fullDate = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  const monthDay = raw.match(/^(\d{1,2})[-/](\d{1,2})$/);
  const year = fullDate?.[1] || new Date(nowMs + VITAL_VIP_DISPLAY_OFFSET_MS).getUTCFullYear();
  const month = Number(fullDate?.[2] || monthDay?.[1]);
  const day = Number(fullDate?.[3] || monthDay?.[2]);
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (numericYear < 2020 || numericYear > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = new Date(Date.UTC(numericYear, month - 1, day));
  if (
    date.getUTCFullYear() !== numericYear ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return '';
  return `${String(numericYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isVitalVipActive(member = {}, nowMs = Date.now()) {
  const type = vitalVipTypeForMember(member);
  if (!VITAL_VIP_TYPES.has(type)) return false;
  if (typeof member.vitalVip?.active === 'boolean') return member.vitalVip.active;
  if (member.vitalVip?.expired === true) return false;
  const expiresAt = normalizeVipDate(member.vitalVipExpiresAt || member.vitalVip?.expiresAt, nowMs);
  if (!expiresAt) return true;
  const today = new Date(nowMs + VITAL_VIP_DISPLAY_OFFSET_MS).toISOString().slice(0, 10);
  return expiresAt >= today;
}

function activeVitalVipType(member = {}, nowMs = Date.now()) {
  return isVitalVipActive(member, nowMs) ? vitalVipTypeForMember(member) : 'none';
}

export {
  activeVitalVipType,
  isVitalVipActive,
  vitalVipTypeForMember
};
