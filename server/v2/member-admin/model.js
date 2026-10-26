import { requireValue } from './repository.js';
import { specialties, normalizeSpecialties as normalize, specialtyQueryValues } from '../../../shared/member-preferences.js';
export { specialties, specialtyQueryValues };
export function normalizeSpecialties(value = []) {
  try { return normalize(value, { strict: true }); } catch { requireValue(false, 'INVALID_SPECIALTIES'); }
}
export function text(value, max = 160, required = false) {
  requireValue(typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), 'INVALID_FIELD');
  const s = value.trim();
  requireValue(!required || s.length, 'REQUIRED_FIELD');
  return s;
}
export function steamId(input) {
  const s = text(input, 300, true);
  const id = /^\d{17}$/.test(s) ? s : /^https?:\/\/steamcommunity\.com\/profiles\/(\d{17})\/?(?:\?.*)?$/.exec(s)?.[1];
  requireValue(id, 'STEAM_RESOLUTION_REQUIRED');
  return id;
}
export function memberFields(input, existing = {}) {
  const allowed = ['customName', 'discordId', 'discordName', 'wechatId', 'phone', 'notes', 'region', 'timezone', 'battlemetricsId', 'specialty', 'vitalVipType', 'vitalVipPurchasedAt', 'vitalVipExpiresAt', 'atlasVipType', 'atlasVipPurchasedAt', 'atlasVipExpiresAt'];
  for (const k of Object.keys(input)) requireValue(allowed.includes(k), 'FIELD_NOT_WRITABLE');
  const out = {};
  for (const k of allowed) if (Object.hasOwn(input, k)) out[k] = k === 'specialty' ? normalizeSpecialties(input[k]) : text(input[k], k === 'notes' ? 1000 : 160);
  if (Object.hasOwn(out, 'timezone') && out.timezone) {
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: out.timezone
      });
    } catch {
      requireValue(false, 'INVALID_TIMEZONE');
    }
  }
  for (const prefix of ['vital', 'atlas']) {
    const type = prefix + 'VipType',
      purchase = prefix + 'VipPurchasedAt',
      expires = prefix + 'VipExpiresAt';
    if (![type, purchase, expires].some(k => Object.hasOwn(out, k))) continue;
    const next = {
      ...existing,
      ...out
    };
    requireValue(['none', 'priority', 'queue_skip'].includes(next[type] || 'none'), 'INVALID_VIP_TYPE');
    if (!next[type] || next[type] === 'none') {
      Object.assign(out, {
        [type]: 'none',
        [purchase]: '',
        [expires]: ''
      });
      continue;
    }
    for (const key of [purchase, expires]) if (next[key]) requireValue(/^\d{4}-\d{2}-\d{2}$/.test(next[key]) && Number.isFinite(Date.parse(next[key])) && new Date(next[key]).toISOString().slice(0, 10) === next[key], 'INVALID_VIP_DATE');
    requireValue(next[purchase], 'VIP_PURCHASE_DATE_REQUIRED');
    const add = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
    if (!next[expires] || Object.hasOwn(out, purchase) && !Object.hasOwn(out, expires)) out[expires] = add(next[purchase], 28);
    requireValue((out[expires] || next[expires]) >= next[purchase], 'INVALID_VIP_DATE');
  }
  if (Object.hasOwn(out, 'timezone')) out.timeZone = out.timezone;
  if (Object.hasOwn(out, 'customName')) out.displayName = out.customName;
  if (Object.hasOwn(out, 'specialty')) out.specialties = out.specialty;
  return out;
}
export const statusLabels = {
  active: '正常',
  suspended: '暂停',
  left: '离队',
  blocked: '黑名单'
};
export function statusOf(m) {
  return m.memberStatus || {
    paused: 'suspended',
    departed: 'left',
    active: 'active'
  }[m.membershipStatus] || 'active';
}
export const membershipOf = s => ({
  active: 'active',
  suspended: 'paused',
  left: 'departed',
  blocked: 'departed'
})[s];
export function csvCell(value) {
  let s = Array.isArray(value) ? value.join(' / ') : String(value ?? '');
  if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
