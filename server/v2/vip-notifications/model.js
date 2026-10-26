import { hash, need } from '../notifications/shared.js';

export const VIP_SOURCES = Object.freeze(['vital', 'rustinity', 'atlas']);
export const REMINDER_DAYS = 3;
export const SCAN_INTERVAL_MS = 60 * 60 * 1000;
const DAY = 86400000, DISPLAY_OFFSET = 8 * 60 * 60 * 1000;

export function vipType(source, value) {
  need(VIP_SOURCES.includes(source), 'VIP_SOURCE_INVALID', 422);
  const raw = typeof value === 'string' ? value.trim().slice(0, 40).toLowerCase() : '';
  if (['queue', 'skip', 'no_queue', 'queue-skip'].includes(raw) || source === 'rustinity' && ['vip', 'rustinity_vip'].includes(raw)) return 'queue_skip';
  if (source !== 'rustinity' && (['vip', 'priority_queue'].includes(raw) || source === 'atlas' && raw === 'atlas_vip')) return 'priority';
  return (source === 'rustinity' ? ['none', 'queue_skip'] : ['none', 'priority', 'queue_skip']).includes(raw) ? raw : 'none';
}

// Preserve the legacy normalization and 28-day fallback as a read-only projection.
// The supplied clock is authoritative even for a legacy month/day value.
export function vipDate(value, now) {
  const raw = typeof value === 'string' ? value.trim().slice(0, 40) : '';
  const full = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/), short = raw.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (!full && !short) return '';
  const y = Number(full?.[1] || new Date(now).getUTCFullYear()), m = Number(full?.[2] || short?.[1]), d = Number(full?.[3] || short?.[2]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 2020 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return date.toISOString().slice(0, 10);
}
const add = (date, days) => new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);

export function vipSnapshot(member, source, now) {
  need(Number.isSafeInteger(now) && Number.isFinite(new Date(now).getTime()), 'VIP_CLOCK_INVALID', 503);
  const type = vipType(source, member[source + 'VipType']);
  let purchasedAt = vipDate(member[source + 'VipPurchasedAt'], now), expiresAt = vipDate(member[source + 'VipExpiresAt'], now);
  if (type === 'none') purchasedAt = expiresAt = '';
  else {
    if (purchasedAt && !expiresAt) expiresAt = add(purchasedAt, 28);
    if (expiresAt && !purchasedAt) purchasedAt = add(expiresAt, -28);
  }
  const utcDate = new Date(now).toISOString().slice(0, 10), displayDate = new Date(now + DISPLAY_OFFSET).toISOString().slice(0, 10);
  const expired = Boolean(expiresAt && expiresAt < displayDate), active = type !== 'none' && !expired;
  const daysUntilExpiry = expiresAt ? Math.ceil((Date.parse(`${expiresAt}T00:00:00.000Z`) - Date.parse(`${utcDate}T00:00:00.000Z`)) / DAY) : null;
  const due = active && Boolean(expiresAt) && daysUntilExpiry >= 0 && daysUntilExpiry <= REMINDER_DAYS;
  const legacySent = source === 'vital' && Boolean(expiresAt) && vipDate(member.vitalVipReminderExpiresAt, now) === expiresAt;
  const facts = { source, type, purchasedAt, expiresAt };
  return { ...facts, fingerprint: hash(facts), active, expired, daysUntilExpiry, due, legacySent,
    periodKey: expiresAt ? hash(['discord', source, 'vip-reminder', member.id, expiresAt]) : null };
}
