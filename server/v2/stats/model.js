import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
export const need = (ok, code, status = 422) => {
  if (!ok) throw new IdentityError(code, status);
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const text = (v, n = 160) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : '';
export const stamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
export function publicAvatar(value) {
  if (typeof value !== 'string' || value.length > 500) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'avatars.steamstatic.com' || /^avatars\.[a-z]+\.steamstatic\.com$/.test(url.hostname)) ? url.href : '';
  } catch { return ''; }
}
export const METRICS = ['kills', 'deaths', 'assists', 't3Kills', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'steamTotalSeconds', 'playTimeSeconds'];
export const normalizeNumeric = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') &&
  Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const numeric = normalizeNumeric;
export function normalizeMetricValues(row = {}, context = {}) {
  const values = Object.fromEntries(METRICS.map(k => [k, numeric(row.values?.[k] ?? row[k])])),
    raw = row.values || row,
    sourceId = row.sourceId || row.source || context.sourceId;
  for (const [out, input] of [['onlineSeconds', 'onlineTimeMinutes'], ['playTimeSeconds', 'playTimeMinutes']])
    if (values[out] === null && numeric(raw[input]) !== null) values[out] = numeric(numeric(raw[input]) * 60);
  for (const k of METRICS) if (row.capabilities?.[k] === false) values[k] = null;
  if (sourceId === 'battlemetrics_online' || row.raw?.battlemetricsOnlineOnly)
    for (const k of METRICS.filter(k => !['onlineSeconds', 'steamTotalSeconds', 'playTimeSeconds'].includes(k))) values[k] = null;
  if (sourceId === 'vital' && row.capabilities?.assists !== true) values.assists = null;
  const capabilities = Object.fromEntries(METRICS.map(k => [k, values[k] !== null]));
  values.kd = values.kills !== null && values.deaths !== null && row.capabilities?.kd !== false ? Number((values.kills / Math.max(values.deaths, 1)).toFixed(2)) : null;
  values.kda = values.kd !== null && capabilities.assists && row.capabilities?.kda !== false ? numeric(Number(((values.kills + values.assists) / Math.max(values.deaths, 1)).toFixed(2))) : null;
  return { values, capabilities };
}
export function projectStatCategories(categories) {
  let remaining = 200;
  return (Array.isArray(categories) ? categories : []).slice(0, 12).map(category => ({
    id: text(category?.id, 80),
    fields: (Array.isArray(category?.fields) ? category.fields : []).slice(0, Math.max(0, remaining)).map(field => {
      remaining--;
      const value = typeof field?.value === 'number' || typeof field?.value === 'string' && field.value.trim() !== '' ? numeric(field.value) : null;
      return { id: text(field?.id || field?.name, 120), name: text(field?.name || field?.id, 120),
        value, status: value === null ? 'not_observed' : 'observed' };
    })
  })).filter(category => category.id && category.fields.length);
}
export function normalizeRow(row = {}, context = {}, now = Date.now()) {
  const { values, capabilities } = normalizeMetricValues(row, context);
  const capturedAt = stamp(row.capturedAt || row.syncedAt),
    sourceId = text(row.sourceId || row.source || context.sourceId) || 'legacy_unknown';
  return {
    id: text(row.id) || hash([context.wipeId, row.memberId, sourceId]),
    memberId: text(row.memberId),
    steamId: text(row.steamId, 32),
    displayName: text(row.displayName || row.member?.displayName, 120),
    avatarUrl: [row.avatarUrl, row.avatar, row.steamAvatar, row.member?.avatar, row.member?.steamAvatar, row.member?.avatarUrl, row.steamProfile?.avatar]
      .map(publicAvatar).find(Boolean) || '',
    squadId: text(row.squadId),
    squadName: text(row.squadName, 120),
    wipeId: text(row.wipeId || context.wipeId),
    serverId: text(row.serverId || context.serverId) || 'legacy_unknown',
    sourceId,
    providerWipeId: text(row.providerWipeId || row.vitalWipeId || context.providerWipeId) || null,
    metricVersion: 'nb-kda-1',
    capturedAt,
    receivedAt: stamp(row.receivedAt) || capturedAt,
    sourceRevision: Number.isSafeInteger(row.sourceRevision) ? row.sourceRevision : null,
    coverage: text(row.coverage) || 'unknown',
    status: ['unavailable', 'unsupported'].includes(row.status) ? row.status : !capturedAt ? 'unavailable' : now - Date.parse(capturedAt) > 300000 ? 'stale' : 'fresh',
    values,
    capabilities,
    reasons: Object.fromEntries(Object.entries(values).filter(([, v]) => v === null).map(([k]) => [k, k === 'kda' && !capabilities.assists ? 'assists_unsupported' : 'not_observed'])),
    sourceRaw: {
      kd: numeric(row.sourceRaw?.kd ?? row.kd),
      kda: numeric(row.sourceRaw?.kda ?? row.kda)
    },
    denominatorRule: 'max(deaths,1)',
    confidence: text(row.confidence || row.onlineSummary?.confidence) || 'unknown',
    ...(sourceId === 'vital' ? { categories: projectStatCategories(row.categories) } : {})
  };
}
export function intervalDelta(before, after) {
  need(before.sourceId === after.sourceId && before.serverId === after.serverId && before.wipeId === after.wipeId && before.providerWipeId === after.providerWipeId && before.memberId === after.memberId, 'INTERVAL_SCOPE_MISMATCH');
  need(before.sourceRevision !== null && after.sourceRevision > before.sourceRevision && Date.parse(after.capturedAt) > Date.parse(before.capturedAt), 'INTERVAL_REVISION_INVALID');
  const reset = METRICS.some(k => before.values[k] !== null && after.values[k] !== null && after.values[k] < before.values[k]);
  if (reset) return {
    ...after,
    values: Object.fromEntries(Object.keys(after.values).map(k => [k, null])),
    status: 'unavailable',
    coverage: 'discontinuity',
    reasons: {
      interval: 'source_reset'
    }
  };
  return normalizeRow({
    ...after,
    values: Object.fromEntries(METRICS.map(k => [k, before.values[k] !== null && after.values[k] !== null ? after.values[k] - before.values[k] : null])),
    coverage: 'interval'
  }, after, Date.parse(after.receivedAt));
}
export function sessionSeconds(sessions, {
  serverId,
  from,
  to,
  observedAt
}) {
  const low = Date.parse(from),
    high = Math.min(Date.parse(to), Date.parse(observedAt));
  need(Number.isFinite(low) && Number.isFinite(high) && high >= low, 'INVALID_TIME_RANGE');
  const intervals = sessions.filter(s => s.serverId === serverId).map(s => [Math.max(low, Date.parse(s.start)), Math.min(high, Date.parse(s.end || observedAt))]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((a, b) => a[0] - b[0]);
  let end = low,
    total = 0;
  for (const [a, b] of intervals) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return Math.floor(total / 1000);
}
export function parseSteamInput(value) {
  const input = text(value, 300);
  if (/^7656119\d{10}$/.test(input)) return {
    steamId: input
  };
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new IdentityError('INVALID_STEAM_INPUT', 422);
  }
  need(u.protocol === 'https:' && u.hostname === 'steamcommunity.com' && !u.port && !u.username && !u.password, 'INVALID_STEAM_INPUT');
  const profile = u.pathname.match(/^\/profiles\/(7656119\d{10})\/?$/);
  if (profile) return {
    steamId: profile[1]
  };
  const vanity = u.pathname.match(/^\/id\/([A-Za-z0-9_-]{1,64})\/?$/);
  need(vanity, 'INVALID_STEAM_INPUT');
  return {
    vanity: vanity[1]
  };
}
export function parseImport(input) {
  let rows = input.rows;
  if (!rows) {
    const value = text(input.text, 250000);
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        const obj = JSON.parse(value);
        rows = Array.isArray(obj) ? obj : obj.rows || [obj];
      } catch {
        need(false, 'INVALID_IMPORT');
      }
    } else {
      // RFC-style quoted CSV, including embedded newlines in the original text.
      const records = [];
      let row = [],
        cell = '',
        quote = false;
      const csv = String(input.text || '');
      need(csv.length <= 250000, 'IMPORT_TOO_LARGE');
      for (let i = 0; i <= csv.length; i++) {
        const c = csv[i] || '\n';
        if (c === '"') {
          if (quote && csv[i + 1] === '"') {
            cell += '"';
            i++;
          } else quote = !quote;
        } else if (!quote && (c === ',' || c === '\n')) {
          row.push(cell.replace(/\r$/, ''));
          cell = '';
          if (c === '\n') {
            if (row.some(Boolean)) records.push(row);
            row = [];
          }
        } else cell += c;
      }
      need(!quote, 'INVALID_IMPORT');
      const headers = records.shift() || [];
      rows = records.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    }
  }
  need(Array.isArray(rows) && rows.length > 0 && rows.length <= 500, 'IMPORT_LIMIT');
  const aliases = {
    steamid: 'steamId',
    击杀: 'kills',
    kill: 'kills',
    死亡: 'deaths',
    death: 'deaths',
    助攻: 'assists',
    assist: 'assists',
    t3击杀: 't3Kills',
    t3kills: 't3Kills',
    火箭: 'rockets',
    硫磺: 'sulfur',
    金属矿石: 'metalOre',
    metalore: 'metalOre',
    建筑: 'building',
    在线时长: 'onlineTimeMinutes',
    bm在线分钟: 'onlineTimeMinutes',
    onlinetimeminutes: 'onlineTimeMinutes',
    playtimeminutes: 'playTimeMinutes'
  };
  const seen = new Set();
  return rows.map(raw => {
    need(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_IMPORT');
    const r = {};
    for (const [k, v] of Object.entries(raw)) {
      const normalized = k.toLowerCase().replace(/[\s_-]/g, '');
      r[aliases[normalized] || k] = v;
    }
    need(/^7656119\d{10}$/.test(r.steamId), 'INVALID_STEAM_INPUT');
    need(!seen.has(r.steamId), 'IMPORT_DUPLICATE_MEMBER');
    seen.add(r.steamId);
    const result = {
      steamId: r.steamId
    };
    for (const k of [...METRICS, 'onlineTimeMinutes', 'playTimeMinutes']) if (r[k] !== undefined && r[k] !== null && r[k] !== '') {
      need(numeric(r[k]) !== null, 'INVALID_METRIC');
      result[k] = numeric(r[k]);
    }
    need(Object.keys(result).length > 1, 'INVALID_METRIC');
    return result;
  });
}
