import { normalizeText } from './store.js';

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function startOfServerDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function parseLogDateRange(query = {}) {
  const fromMs = timestampForSort(normalizeText(query.from, 80));
  const toMs = timestampForSort(normalizeText(query.to, 80));
  if (fromMs || toMs) {
    const nowMs = Date.now();
    const startMs = fromMs || startOfServerDay(new Date(toMs || nowMs)).getTime();
    const endMs = toMs && toMs > startMs ? toMs : nowMs + 1;
    return {
      fromMs: startMs,
      toMs: endMs,
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString()
    };
  }

  const date = normalizeText(query.date, 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map((item) => Number(item));
    const offsetMinutes = Number(query.timeZoneOffsetMinutes);
    const normalizedOffset = Number.isFinite(offsetMinutes) ? offsetMinutes : 0;
    const startMs = Date.UTC(year, month - 1, day) + normalizedOffset * 60_000;
    const endMs = startMs + 24 * 60 * 60 * 1000;
    return {
      fromMs: startMs,
      toMs: endMs,
      from: new Date(startMs).toISOString(),
      to: new Date(endMs).toISOString()
    };
  }

  const start = startOfServerDay();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    fromMs: start.getTime(),
    toMs: end.getTime(),
    from: start.toISOString(),
    to: end.toISOString()
  };
}
