import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
export const need = (ok, code, status = 422) => { if (!ok) throw new IdentityError(code, status); };
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
export const sync = value => { need(!value?.then, 'SYNCHRONOUS_AUTHORITY_REQUIRED', 503); return value; };
export const fields = { name: 120, directConnect: 240, vipUrl: 500, mapLink: 500, rustMapsLink: 500, notes: 1000, status: 20 };
export const statuses = ['active', 'maintenance', 'hidden'];
export function patch(input) {
  need(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_INPUT');
  for (const k of Object.keys(input)) need(Object.hasOwn(fields, k) || ['serverProfileId','serverId','expectedRevision'].includes(k), 'UNKNOWN_FIELD');
  const out = {};
  for (const [k, limit] of Object.entries(fields)) if (Object.hasOwn(input, k)) {
    need(typeof input[k] === 'string', 'INVALID_FIELD');
    const value = input[k].trim(); need(value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'INVALID_FIELD');
    if (k === 'status') need(statuses.includes(value), 'INVALID_SERVER_STATUS');
    if (['vipUrl','mapLink','rustMapsLink'].includes(k) && value) {
      let url; try { url = new URL(value); } catch {} 
      need(url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !/\s/.test(value), 'INVALID_SERVER_URL');
    }
    if (k === 'directConnect' && value) {
      const target = value.replace(/^(?:client\.connect|connect)\s+/i, '').replace(/^steam:\/\/connect\//i, '').replace(/\/$/, '');
      const match = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):([0-9]{1,5})$/.exec(target);
      need(match && Number(match[1]) >= 1 && Number(match[1]) <= 65535, 'INVALID_DIRECT_CONNECT');
    }
    out[k] = value;
  }
  need(Object.keys(out).length, 'EMPTY_PATCH'); return out;
}
export function catalogEntries(raw) {
  need(Array.isArray(raw) && raw.length > 0 && raw.length <= 500, 'CATALOG_REQUIRED', 503);
  const profiles = new Set(), vitals = new Set(), aliases = new Map();
  return raw.map(row => {
    for (const key of ['serverProfileId','vitalServerId']) need(typeof row[key] === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(row[key]), 'INVALID_CATALOG_MAPPING', 503);
    need(!profiles.has(row.serverProfileId) && !vitals.has(row.vitalServerId), 'AMBIGUOUS_CATALOG_MAPPING', 503);
    profiles.add(row.serverProfileId); vitals.add(row.vitalServerId);
    for (const alias of [row.id, row.serverProfileId, row.vitalServerId].filter(Boolean)) {
      need(typeof alias === 'string' && (!aliases.has(alias) || aliases.get(alias) === row.serverProfileId), 'AMBIGUOUS_CATALOG_MAPPING', 503);
      aliases.set(alias, row.serverProfileId);
    }
    // Allowlist the trusted public catalog, never copy credentials or arbitrary host fields.
    return { id: row.id || row.serverProfileId, serverProfileId: row.serverProfileId, vitalServerId: row.vitalServerId,
      name: String(row.name || ''), directConnect: String(row.directConnect || ''), vipUrl: String(row.vipUrl || ''),
      mapLink: String(row.mapLink || ''), rustMapsLink: String(row.rustMapsLink || ''), status: statuses.includes(row.status) ? row.status : 'active' };
  });
}
export function project(base, override = {}) {
  const result = { ...base, baseName: base.name, name: override.name || base.name,
    notes: override.notes || '', overrideUpdatedAt: override.updatedAt || '' };
  for (const k of ['directConnect','vipUrl','mapLink','rustMapsLink']) if (Object.hasOwn(override, k)) result[k] = override[k];
  result.status = statuses.includes(override.status) ? override.status : base.status;
  result.statusLabel = { active: '正常', maintenance: '维护', hidden: '隐藏' }[result.status];
  return result;
}
