const STYLES = new Set(['t', 'T', 'd', 'D', 'f', 'F', 'R']);

// Only absolute instants are accepted: timezone-less text must never inherit
// the application server's timezone. Discord localizes this token per viewer.
export function discordTimestamp(value, style = 'F') {
  if (!STYLES.has(style)) return '';
  let instant;
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59) return '';
    const day = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return '';
    instant = Date.parse(value);
  } else if (value instanceof Date) instant = value.getTime();
  else if (typeof value === 'number') instant = value;
  if (!Number.isFinite(instant) || Math.abs(instant) > 8.64e15) return '';
  return `<t:${Math.floor(instant / 1000)}:${style}>`;
}

// VIP expiry dates include the whole registered day in UTC+8. The instant
// access expires is 16:00Z on that date, or the next day at 00:00 in UTC+8.
export function discordExpiryTimestamp(value, style = 'F') {
  const instant = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T16:00:00.000Z` : value;
  return discordTimestamp(instant, style);
}
