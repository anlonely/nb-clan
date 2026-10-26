const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

function pad(value) {
  return String(value).padStart(2, '0');
}

function localPartsFromMs(ms) {
  const date = new Date(ms + UTC8_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: pad(date.getUTCMonth() + 1),
    day: pad(date.getUTCDate()),
    hour: pad(date.getUTCHours()),
    minute: pad(date.getUTCMinutes()),
    second: pad(date.getUTCSeconds())
  };
}

function parseUtc8InputMs(value) {
  const text = String(value || '').trim();
  if (!text) return NaN;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return NaN;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0
  ) - UTC8_OFFSET_MS;
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  if (!text) return NaN;
  const utc8Ms = parseUtc8InputMs(text);
  if (Number.isFinite(utc8Ms)) return utc8Ms;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatUtc8Time(value, options = {}) {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return options.fallback ?? (value || '-');
  const parts = localPartsFromMs(ms);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  return `${date} ${time}`;
}

function formatUtc8DateWeekTime(value, options = {}) {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) {
    return {
      dateText: options.fallback ?? (value || '-'),
      timeText: ''
    };
  }
  const parts = localPartsFromMs(ms);
  const localDate = new Date(ms + UTC8_OFFSET_MS);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    dateText: `${date} ${WEEKDAY_LABELS[localDate.getUTCDay()]}`,
    timeText: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}

function utc8InputToIso(value) {
  const ms = timeMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function formatUtc8Date(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const direct = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (direct && !/[T ]\d{2}:\d{2}/.test(text)) return direct[0];
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return '';
  const parts = localPartsFromMs(ms);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function todayUtc8Date() {
  const parts = localPartsFromMs(Date.now());
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysDate(value, days) {
  const date = formatUtc8Date(value);
  if (!date) return '';
  const ms = parseUtc8InputMs(`${date} 00:00:00`);
  if (!Number.isFinite(ms)) return '';
  return formatUtc8Date(ms + Number(days || 0) * 24 * 60 * 60 * 1000);
}

module.exports = {
  UTC8_OFFSET_MS,
  addDaysDate,
  formatUtc8Date,
  formatUtc8DateWeekTime,
  formatUtc8Time,
  todayUtc8Date,
  utc8InputToIso
};
