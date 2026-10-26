import {resolveLocalTime} from '../../../server/v2/scheduling/time.js';
export function auditFilterParams(search, zone) {
  const params = new URLSearchParams(search), result = new URLSearchParams();
  for (const key of ['action', 'status']) if (params.get(key)) result.set(key, params.get(key));
  for (const key of ['from', 'to']) {
    const day = params.get(key); if (!day) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('TIME_INPUT_INVALID');
    resolveLocalTime({localDateTime: `${day}T00:00:00`, timeZone: zone});
    const next = key === 'to' ? new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : day;
    result.set(key, resolveLocalTime({localDateTime: `${next}T00:00:00`, timeZone: zone}));
  }
  if (result.get('from') && result.get('to') && result.get('from') >= result.get('to')) throw new Error('TIME_INPUT_INVALID');
  return result;
}
