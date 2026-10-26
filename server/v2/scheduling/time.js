// All parsing is independent of the host's TZ. Local inputs must be resolved
// against an explicit IANA zone, including a deliberate choice in a DST fold.
const formatters = new Map();
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ABSOLUTE = /^(.*?)(Z|[+-]\d{2}:\d{2})$/;

function fail(errorCode, field, extra = {}) {
  throw Object.assign(new Error(errorCode), { errorCode, status: 422, retryable: false,
    fieldErrors: { [field]: errorCode }, ...extra });
}

export function validateTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(timeZone)) {
    fail('TIME_ZONE_INVALID', 'timeZone');
  }
  if (formatters.has(timeZone)) return timeZone;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn', { timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    // Keep user-selected aliases for audit, but validate against ICU's zone DB.
    if (!formatters.has(timeZone)) {
      if (formatters.size >= 128) formatters.delete(formatters.keys().next().value);
      formatters.set(timeZone, formatter);
    }
  } catch { fail('TIME_ZONE_INVALID', 'timeZone'); }
  return timeZone;
}

function localParts(value) {
  const match = typeof value === 'string' ? value.match(LOCAL) : null;
  if (!match) fail('TIME_INPUT_INVALID', 'localDateTime');
  const [, y, mo, d, h, mi, s = '0', fraction = ''] = match;
  const parts = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi,
    second: +s, millisecond: +(fraction.padEnd(3, '0') || '0') };
  if (parts.year < 1 || parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 ||
      parts.hour > 23 || parts.minute > 59 || parts.second > 59) fail('TIME_INPUT_INVALID', 'localDateTime');
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  if (date.getUTCMonth() + 1 !== parts.month || date.getUTCDate() !== parts.day) fail('TIME_INPUT_INVALID', 'localDateTime');
  return { ...parts, wallMs: date.getTime() };
}

function offsetMilliseconds(value) {
  if (value === 'Z') return 0;
  const match = typeof value === 'string' && value.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match || +match[2] > 23 || +match[3] > 59) fail('TIME_OFFSET_MISMATCH', 'utcOffset');
  return (match[1] === '-' ? -1 : 1) * (+match[2] * 60 + +match[3]) * 60_000;
}

function zonedParts(ms, zone) {
  const parts = {};
  for (const part of formatters.get(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return { ...parts, wallMs: date.getTime() };
}

function offsetLabel(ms) {
  const sign = ms < 0 ? '-' : '+';
  const seconds = Math.abs(ms) / 1000;
  const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor(seconds % 3600 / 60)).padStart(2, '0');
  // Historical IANA offsets may include seconds. Preserve that evidence even
  // though the modern scheduling input deliberately only accepts HH:mm.
  const ss = seconds % 60;
  return `${sign}${hh}:${mm}${ss ? `:${String(ss).padStart(2, '0')}` : ''}`;
}

export function resolveLocalTime({ localDateTime, timeZone, utcOffset } = {}) {
  validateTimeZone(timeZone);
  const parts = localParts(localDateTime);
  const requestedOffset = utcOffset === undefined || utcOffset === null ? null : offsetMilliseconds(utcOffset);
  const offsets = new Set();
  // Probe both sides of every nearby offset transition, including non-hour
  // shifts (Lord Howe) and date-line changes (Apia). Candidates are then
  // validated by a full wall-clock round trip; no nearest-time coercion.
  for (let hours = -48; hours <= 48; hours += 3) {
    const probe = parts.wallMs - parts.millisecond + hours * 3_600_000;
    offsets.add(zonedParts(probe, timeZone).wallMs - probe);
  }
  const candidates = [...offsets].map(offset => ({ ms: parts.wallMs - offset, offset }))
    .filter(candidate => zonedParts(candidate.ms, timeZone).wallMs === parts.wallMs - parts.millisecond)
    .sort((a, b) => a.ms - b.ms)
    .map(candidate => ({ utc: new Date(candidate.ms).toISOString(), utcOffset: offsetLabel(candidate.offset), offset: candidate.offset }));
  const publicCandidates = candidates.map(({ utc, utcOffset: offset }) => ({ utc, utcOffset: offset }));
  if (!candidates.length) fail('TIME_NONEXISTENT', 'localDateTime', { candidates: [] });
  if (requestedOffset !== null) {
    const selected = candidates.find(candidate => candidate.offset === requestedOffset);
    if (!selected) fail('TIME_OFFSET_MISMATCH', 'utcOffset', { candidates: publicCandidates });
    return selected.utc;
  }
  if (candidates.length > 1) fail('TIME_AMBIGUOUS', 'localDateTime', { candidates: publicCandidates });
  return candidates[0].utc;
}

export function normalizeTime(value, timeZone, rawInput) {
  if (value === null || value === undefined || value === '') {
    if (rawInput !== undefined && rawInput !== null) fail('TIME_INPUT_INVALID', 'time');
    return null;
  }
  validateTimeZone(timeZone);
  const match = typeof value === 'string' && value.match(ABSOLUTE);
  if (!match) fail('TIME_INPUT_INVALID', 'time');
  const parts = localParts(match[1]);
  const utc = new Date(parts.wallMs - offsetMilliseconds(match[2])).toISOString();
  if (rawInput !== undefined && rawInput !== null) {
    if (typeof rawInput !== 'object' || Array.isArray(rawInput)) fail('TIME_INPUT_INVALID', 'rawTimeInputs');
    const rawZone = rawInput.timeZone ?? timeZone;
    validateTimeZone(rawZone);
    if (formatters.get(rawZone).resolvedOptions().timeZone !== formatters.get(timeZone).resolvedOptions().timeZone) {
      fail('TIME_ZONE_MISMATCH', 'rawTimeInputs');
    }
    const resolved = resolveLocalTime({ ...rawInput, timeZone: rawZone });
    if (resolved !== utc) fail('TIME_UTC_MISMATCH', 'rawTimeInputs');
  }
  return utc;
}

export function arrivalAfterHours(musterAt, hours) {
  const muster = normalizeTime(musterAt, 'UTC');
  if (!muster || typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) fail('ARRIVAL_TIME_INVALID', 'hours');
  const result = new Date(Date.parse(muster) + hours * 3_600_000);
  if (!Number.isFinite(result.getTime())) fail('ARRIVAL_TIME_INVALID', 'hours');
  return result.toISOString();
}
