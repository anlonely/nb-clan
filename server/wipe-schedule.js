const DAY_MS = 24 * 60 * 60 * 1000;
const formatterCache = new Map();

function validDate(value, label = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid ${label}`);
  return date;
}

function integerInRange(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function scheduleTimeZone(server = {}) {
  const timeZone = String(server.wipeTimeZone || 'UTC').trim() || 'UTC';
  zonedFormatter(timeZone);
  return timeZone;
}

function validateTimeFieldFamily(server = {}) {
  const hasNamedTimeZone = Boolean(String(server.wipeTimeZone || '').trim());
  const utcFields = ['wipeHourUtc', 'wipeMinuteUtc', 'wipeHoursUtcByWeek'];
  const localFields = [
    'wipeHourLocal',
    'wipeMinuteLocal',
    'wipeHoursLocalByWeek',
    'forceWipeHourLocal',
    'forceWipeMinuteLocal',
    'intermediateWipeHourLocal',
    'intermediateWipeMinuteLocal'
  ];
  if (hasNamedTimeZone && utcFields.some((field) => Object.hasOwn(server, field))) {
    throw new TypeError('Wipe schedule cannot mix an IANA time zone with UTC time fields');
  }
  if (!hasNamedTimeZone && localFields.some((field) => Object.hasOwn(server, field))) {
    throw new TypeError('Local wipe time fields require wipeTimeZone');
  }
}

function zonedFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return formatterCache.get(timeZone);
}

function zonedParts(value, timeZone) {
  const parts = {};
  for (const part of zonedFormatter(timeZone).formatToParts(validDate(value))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    monthIndex: parts.month - 1,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function wallClockMilliseconds(parts) {
  return Date.UTC(
    parts.year,
    parts.monthIndex,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    0
  );
}

function zonedDateTimeToUtc(parts, timeZone) {
  const target = {
    year: integerInRange(parts.year, 1970, 9999, 'wipe year'),
    monthIndex: integerInRange(parts.monthIndex, 0, 11, 'wipe month'),
    day: integerInRange(parts.day, 1, 31, 'wipe day'),
    hour: integerInRange(parts.hour, 0, 23, 'wipe hour'),
    minute: integerInRange(parts.minute, 0, 59, 'wipe minute'),
    second: 0
  };
  const targetWallClock = wallClockMilliseconds(target);
  let candidateMs = targetWallClock;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedParts(new Date(candidateMs), timeZone);
    const difference = targetWallClock - wallClockMilliseconds(observed);
    if (difference === 0) return new Date(candidateMs);
    candidateMs += difference;
  }

  throw new RangeError(`Wipe local time does not exist in ${timeZone}`);
}

function calendarDate(year, monthIndex, day) {
  const normalized = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0, 0));
  return {
    year: normalized.getUTCFullYear(),
    monthIndex: normalized.getUTCMonth(),
    day: normalized.getUTCDate()
  };
}

function addCalendarDays(parts, days) {
  return calendarDate(parts.year, parts.monthIndex, parts.day + days);
}

function localHour(server, week = null) {
  const namedTimeZone = Boolean(String(server.wipeTimeZone || '').trim());
  const hoursByWeek = namedTimeZone ? server.wipeHoursLocalByWeek : server.wipeHoursUtcByWeek;
  const value = week !== null
    ? (hoursByWeek?.[week] ?? (namedTimeZone ? server.wipeHourLocal : server.wipeHourUtc))
    : (namedTimeZone ? server.wipeHourLocal : server.wipeHourUtc);
  return integerInRange(value, 0, 23, 'wipe hour');
}

function localMinute(server) {
  const namedTimeZone = Boolean(String(server.wipeTimeZone || '').trim());
  return integerInRange(namedTimeZone ? (server.wipeMinuteLocal ?? 0) : (server.wipeMinuteUtc ?? 0), 0, 59, 'wipe minute');
}

function candidateAt(localDate, hour, minute, timeZone) {
  return zonedDateTimeToUtc({ ...localDate, hour, minute }, timeZone);
}

function weeklyCandidates(now, timeZone, weekday, hour, minute) {
  const localNow = zonedParts(now, timeZone);
  const today = calendarDate(localNow.year, localNow.monthIndex, localNow.day);
  const todayWeekday = new Date(Date.UTC(today.year, today.monthIndex, today.day)).getUTCDay();
  const offsetToTarget = weekday - todayWeekday;
  const candidates = [];
  for (let weekOffset = -3; weekOffset <= 3; weekOffset += 1) {
    candidates.push(candidateAt(addCalendarDays(today, offsetToTarget + weekOffset * 7), hour, minute, timeZone));
  }
  return candidates;
}

function monthlyWeekCandidates(now, timeZone, weeks, hourForWeek, minute) {
  const localNow = zonedParts(now, timeZone);
  const candidates = [];

  // A week-5-only schedule can skip multiple months, so keep a generous finite horizon.
  for (let monthOffset = -24; monthOffset <= 24; monthOffset += 1) {
    const month = calendarDate(localNow.year, localNow.monthIndex + monthOffset, 1);
    const firstWeekday = new Date(Date.UTC(month.year, month.monthIndex, 1)).getUTCDay();
    const firstThursdayDay = 1 + ((4 - firstWeekday + 7) % 7);
    for (const week of weeks) {
      const day = firstThursdayDay + (week - 1) * 7;
      const localDate = calendarDate(month.year, month.monthIndex, day);
      if (localDate.monthIndex !== month.monthIndex) continue;
      candidates.push(candidateAt(localDate, hourForWeek(week), minute, timeZone));
    }
  }
  return candidates;
}

function biweeklyCandidates(server, now, timeZone, hour, minute) {
  let anchorDate;
  if (server.anchorLocalDate) {
    const match = String(server.anchorLocalDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new TypeError('biweekly anchorLocalDate must use YYYY-MM-DD');
    anchorDate = calendarDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (`${anchorDate.year}-${String(anchorDate.monthIndex + 1).padStart(2, '0')}-${String(anchorDate.day).padStart(2, '0')}` !== server.anchorLocalDate) {
      throw new TypeError('biweekly anchorLocalDate is invalid');
    }
  } else {
    const anchor = validDate(server.anchorStart, 'biweekly wipe anchor');
    const anchorParts = zonedParts(anchor, timeZone);
    anchorDate = calendarDate(anchorParts.year, anchorParts.monthIndex, anchorParts.day);
  }
  const anchorWeekday = new Date(Date.UTC(anchorDate.year, anchorDate.monthIndex, anchorDate.day)).getUTCDay();
  if (anchorWeekday !== 4) throw new TypeError('biweekly wipe anchor must be a Thursday');
  const nowParts = zonedParts(now, timeZone);
  const nowDate = calendarDate(nowParts.year, nowParts.monthIndex, nowParts.day);
  const calendarDayDifference = Math.floor((
    Date.UTC(nowDate.year, nowDate.monthIndex, nowDate.day) -
    Date.UTC(anchorDate.year, anchorDate.monthIndex, anchorDate.day)
  ) / DAY_MS);
  const nearbyPeriod = Math.floor(calendarDayDifference / 14);
  const candidates = [];
  for (let periodOffset = -3; periodOffset <= 3; periodOffset += 1) {
    const localDate = addCalendarDays(anchorDate, (nearbyPeriod + periodOffset) * 14);
    candidates.push(candidateAt(localDate, hour, minute, timeZone));
  }
  return candidates;
}

function normalizedWeeks(server) {
  const weeks = [...new Set((Array.isArray(server.wipeWeeks) ? server.wipeWeeks : [])
    .map(Number)
    .filter((week) => Number.isInteger(week) && week >= 1 && week <= 5))]
    .sort((left, right) => left - right);
  if (!weeks.length) throw new TypeError('monthly_weeks requires at least one wipe week');
  return weeks;
}

function normalizedWeekOffsets(value) {
  const offsets = [...new Set((Array.isArray(value) ? value : [])
    .map(Number)
    .filter((week) => Number.isInteger(week) && week >= 1 && week <= 5))]
    .sort((left, right) => left - right);
  return offsets;
}

function monthlyForceWithIntermediateCandidates(server, now, timeZone, forceHour, forceMinute) {
  const forceCandidates = monthlyWeekCandidates(now, timeZone, [1], () => forceHour, forceMinute);
  const intermediateHour = integerInRange(server.intermediateWipeHourLocal, 0, 23, 'intermediate wipe hour');
  const intermediateMinute = integerInRange(server.intermediateWipeMinuteLocal ?? 0, 0, 59, 'intermediate wipe minute');
  const weeksAfterForce = normalizedWeekOffsets(server.intermediateWeeksAfterForce);
  const weeksBeforeForce = normalizedWeekOffsets(server.intermediateWeeksBeforeForce);
  if (!weeksAfterForce.length && !weeksBeforeForce.length) {
    throw new TypeError('monthly_force_with_intermediate requires at least one week offset');
  }
  const candidates = [...forceCandidates];
  for (const forceCandidate of forceCandidates) {
    const forceParts = zonedParts(forceCandidate, timeZone);
    const forceDate = calendarDate(forceParts.year, forceParts.monthIndex, forceParts.day);
    for (const weeks of weeksAfterForce) {
      candidates.push(candidateAt(addCalendarDays(forceDate, weeks * 7), intermediateHour, intermediateMinute, timeZone));
    }
    for (const weeks of weeksBeforeForce) {
      candidates.push(candidateAt(addCalendarDays(forceDate, weeks * -7), intermediateHour, intermediateMinute, timeZone));
    }
  }
  return candidates;
}

function scheduleCandidates(server, now, timeZone) {
  const minute = localMinute(server);

  if (server.schedule === 'weekly_monday') {
    return weeklyCandidates(now, timeZone, 1, localHour(server), minute);
  }
  if (server.schedule === 'weekly_monday_and_force') {
    const forceHour = integerInRange(server.forceWipeHourLocal ?? 19, 0, 23, 'force wipe hour');
    const forceMinute = integerInRange(server.forceWipeMinuteLocal ?? 0, 0, 59, 'force wipe minute');
    return [
      ...weeklyCandidates(now, timeZone, 1, localHour(server), minute),
      ...monthlyWeekCandidates(now, timeZone, [1], () => forceHour, forceMinute)
    ];
  }
  if (server.schedule === 'biweekly_thursday') {
    return biweeklyCandidates(server, now, timeZone, localHour(server), minute);
  }
  if (server.schedule === 'monthly_force') {
    return monthlyWeekCandidates(now, timeZone, [1], () => localHour(server), minute);
  }
  if (server.schedule === 'monthly_force_with_intermediate') {
    return monthlyForceWithIntermediateCandidates(server, now, timeZone, localHour(server), minute);
  }
  if (server.schedule === 'monthly_weeks') {
    const weeks = normalizedWeeks(server);
    return monthlyWeekCandidates(now, timeZone, weeks, (week) => localHour(server, week), minute);
  }
  throw new TypeError(`Unsupported wipe schedule: ${String(server.schedule || '(empty)')}`);
}

export function computedWipeTimes(server, now = new Date()) {
  if (!server || typeof server !== 'object') throw new TypeError('Wipe server configuration is required');
  validateTimeFieldFamily(server);
  const currentTime = validDate(now, 'current time');
  const timeZone = scheduleTimeZone(server);
  const candidates = [...new Map(scheduleCandidates(server, currentTime, timeZone)
    .map((candidate) => [candidate.getTime(), candidate])).values()]
    .sort((left, right) => left.getTime() - right.getTime());
  const current = [...candidates].reverse().find((candidate) => candidate <= currentTime);
  const next = candidates.find((candidate) => candidate > currentTime);
  if (!current || !next) throw new RangeError(`Unable to bracket wipe schedule for ${server.id || server.name || 'server'}`);
  return {
    currentStart: current.toISOString(),
    nextStart: next.toISOString()
  };
}
