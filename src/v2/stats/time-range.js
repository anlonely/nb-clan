import { resolveLocalTime, validateTimeZone } from '../../../server/v2/scheduling/time.js';

export function statsTimeRange({ from = '', to = '', timeZone, fromOffset = '', toOffset = '', required = false }) {
  validateTimeZone(timeZone);
  if (!from && !to && !required) return {};
  if (!from || !to) throw Object.assign(new Error('INVALID_TIME_RANGE'), { errorCode: 'INVALID_TIME_RANGE' });
  const start = resolveLocalTime({ localDateTime: from, timeZone, ...(fromOffset.trim() ? { utcOffset: fromOffset.trim() } : {}) });
  const end = resolveLocalTime({ localDateTime: to, timeZone, ...(toOffset.trim() ? { utcOffset: toOffset.trim() } : {}) });
  if (Date.parse(start) >= Date.parse(end)) throw Object.assign(new Error('INVALID_TIME_RANGE'), { errorCode: 'INVALID_TIME_RANGE' });
  return { from: start, to: end };
}
