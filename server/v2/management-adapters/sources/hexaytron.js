// Pure parser extracted from api.js:10150-10323; no API import or message sending.
import { text as normalizeText } from '../../stats/model.js';
const nowIso = () => new Date().toISOString();
const HEXAYTRON_PLAYTIME_FIELDS = [
  { key: 'atlas', label: 'Atlas' },
  { key: 'vital', label: 'Vital' },
  { key: 'rustinity', label: 'Rustinity' },
  { key: 'building', label: 'Building' },
  { key: 'aimtrain', label: 'Aimtrain' },
  { key: 'official', label: 'Official' }
];
const HEXAYTRON_FIELD_BY_NORMALIZED_LABEL = new Map([
  ...HEXAYTRON_PLAYTIME_FIELDS.map((field) => [field.key, field]),
  ['rust', { key: 'rust', label: 'Rust' }],
  ['firstseen', { key: 'firstSeen', label: 'First Seen' }]
]);

function normalizeHexaytronLabel(value = '') {
  return normalizeText(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseHexaytronNumber(value = '') {
  const normalized = normalizeText(value, 120).replace(/,/g, '');
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function parseHexaytronHours(value = '') {
  const text = normalizeText(value, 240).replace(/,/g, '');
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h|小时|小時)\b/i);
  if (!match) return null;
  const hours = Number(match[1]);
  return Number.isFinite(hours) ? hours : null;
}

function parseHexaytronDaysAgo(value = '') {
  const text = normalizeText(value, 240).replace(/,/g, '');
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:days?)\s*ago/i);
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isFinite(days) ? Math.round(days) : null;
}

function collectDiscordMessageStrings(value, parts = [], seen = new Set()) {
  if (value === null || value === undefined) return parts;
  if (typeof value === 'string' || typeof value === 'number') {
    parts.push(String(value));
    return parts;
  }
  if (typeof value !== 'object' || seen.has(value)) return parts;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectDiscordMessageStrings(item, parts, seen);
    return parts;
  }
  for (const item of Object.values(value)) collectDiscordMessageStrings(item, parts, seen);
  return parts;
}

function discordMessageTextBlob(message = {}) {
  return collectDiscordMessageStrings({
    content: message.content || '',
    embeds: message.embeds || [],
    components: message.components || [],
    attachments: message.attachments || []
  }).join('\n');
}

function extractBattlemetricsPlayerLink(text = '') {
  const raw = String(text || '');
  const match = raw.match(/https?:\/\/(?:www\.)?battlemetrics\.com\/(?:rcon\/)?players\/(\d+)/i) ||
    raw.match(/battlemetrics\.com\/(?:rcon\/)?players\/(\d+)/i);
  if (!match) return { id: '', url: '' };
  const id = match[1];
  const urlMatch = raw.match(new RegExp(`https?://[^\\s"'<>]*battlemetrics\\.com/(?:rcon/)?players/${id}[^\\s"'<>]*`, 'i'));
  return {
    id,
    url: urlMatch?.[0] || `https://www.battlemetrics.com/players/${id}`
  };
}

function applyHexaytronPair(target, label, value) {
  const key = normalizeHexaytronLabel(label);
  const field = HEXAYTRON_FIELD_BY_NORMALIZED_LABEL.get(key);
  if (!field) return;
  if (field.key === 'firstSeen') {
    const days = parseHexaytronDaysAgo(value) ?? parseHexaytronNumber(value);
    if (days !== null) target.firstSeenDaysAgo = Math.max(0, Math.round(days));
    return;
  }
  const hours = parseHexaytronHours(value);
  if (hours === null) return;
  if (field.key === 'rust') {
    target.rustHours = hours;
    return;
  }
  target.serverHours.set(field.key, {
    key: field.key,
    label: field.label,
    hours
  });
}

function parseHexaytronLinePairs(target, text = '') {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => normalizeText(line, 240))
    .filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const currentKey = normalizeHexaytronLabel(current);
    if (HEXAYTRON_FIELD_BY_NORMALIZED_LABEL.has(currentKey) && lines[index + 1]) {
      applyHexaytronPair(target, current, lines[index + 1]);
      index += 1;
      continue;
    }
    for (const [labelKey, field] of HEXAYTRON_FIELD_BY_NORMALIZED_LABEL.entries()) {
      if (labelKey === 'firstseen') {
        const firstSeenMatch = current.match(/\bfirst\s*seen\b\s*[:：-]?\s*(\d[\d,.]*(?:\.\d+)?\s*days?\s*ago)/i);
        if (firstSeenMatch) applyHexaytronPair(target, field.label, firstSeenMatch[1]);
        continue;
      }
      const labelPattern = field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const regex = new RegExp(`\\b${labelPattern}\\b\\s*[:：-]?\\s*(\\d[\\d,.]*(?:\\.\\d+)?\\s*(?:hours?|hrs?|h|小时|小時))`, 'i');
      const match = current.match(regex);
      if (match) applyHexaytronPair(target, field.label, match[1]);
    }
  }
}

export function parseHexaytronMessageProfile(message = {}, steamId = '') {
  const target = {
    serverHours: new Map(),
    rustHours: null,
    firstSeenDaysAgo: null
  };
  for (const embed of Array.isArray(message.embeds) ? message.embeds : []) {
    for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
      applyHexaytronPair(target, field?.name || '', field?.value || '');
    }
  }
  parseHexaytronLinePairs(target, discordMessageTextBlob(message));
  const textBlob = discordMessageTextBlob(message);
  const battlemetrics = extractBattlemetricsPlayerLink(textBlob);
  const servers = HEXAYTRON_PLAYTIME_FIELDS
    .map((field) => target.serverHours.get(field.key) || null)
    .filter(Boolean)
    .map((field) => ({
      ...field,
      minutes: Math.round(Number(field.hours || 0) * 60)
    }));
  const hasData = servers.length || target.rustHours !== null || target.firstSeenDaysAgo !== null || battlemetrics.id;
  if (!hasData) return null;
  return {
    steamId: normalizeText(steamId, 80),
    battlemetricsId: battlemetrics.id,
    battlemetricsUrl: battlemetrics.url,
    servers,
    rustHours: target.rustHours,
    rustMinutes: target.rustHours === null ? null : Math.round(Number(target.rustHours || 0) * 60),
    firstSeenDaysAgo: target.firstSeenDaysAgo,
    sourceMessageId: normalizeText(message.id, 80),
    sourceAuthorId: normalizeText(message.author?.id, 80),
    sourceAuthorName: normalizeText(message.author?.username || message.author?.global_name || message.author?.display_name, 120),
    rawText: normalizeText(textBlob, 2000),
    fetchedAt: nowIso(),
    error: ''
  };
}

