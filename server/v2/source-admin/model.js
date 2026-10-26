import { randomUUID } from 'node:crypto';
import { signature, fields, operationId } from '../system-admin/model.js';
export { fields, operationId };
export class SourceAdminError extends Error {
  constructor(code, status = 422) { super(code); this.errorCode = code; this.status = status; this.skipApiErrorLog = true; }
}
export const need = (yes, code, status) => { if (!yes) throw new SourceAdminError(code, status); };
export const SOURCES = ['battlemetrics', 'steam', 'kda'];
export const ACTIONS = ['battlemetrics.save', 'battlemetrics.delete', 'battlemetrics.clear', 'battlemetrics.primary', 'steam.save', 'steam.clear'];
export const section = source => source === 'steam' ? 'steamWebApi' : source;
export const revisionFor = (key, source, settings) => signature(key, { source, config: settings[section(source)] ?? null });
const norm = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function keyId(value) { need(typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value), 'INVALID_KEY_ID'); return value; }
export function secret(value, min, max) {
  need(typeof value === 'string', 'INVALID_SECRET_LENGTH'); const key = value.trim();
  need(key.length >= min && key.length <= max && !/[\x00-\x1f\x7f]/.test(key), 'INVALID_SECRET_LENGTH'); return key;
}
// Pure legacy-compatible projection: GET never normalizes or timestamps stored settings.
// Missing/duplicate legacy IDs receive deterministic opaque IDs until a deliberate write.
export function bmKeys(settings, signatureKey) {
  const result = [], seen = new Set(), ids = new Set(), raw = settings?.apiKeys;
  for (const item of Array.isArray(raw) ? raw : []) {
    const apiKey = norm(item?.apiKey, 2048); if (!apiKey || seen.has(apiKey)) continue; seen.add(apiKey);
    let id = norm(item.id, 80);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || ids.has(id) || id.includes(apiKey)) id = `bm_key_${signature(signatureKey, apiKey).slice(0, 32)}`;
    ids.add(id); result.push({ ...item, id, apiKey, label: norm(item.label, 80), createdAt: norm(item.createdAt, 40) || norm(settings.apiKeyUpdatedAt, 40), updatedAt: norm(item.updatedAt, 40) || norm(settings.apiKeyUpdatedAt, 40) });
  }
  const legacy = norm(settings?.apiKey, 2048);
  if (legacy && !seen.has(legacy)) result.unshift({ id: ids.has('bm_key_legacy') ? `bm_key_${signature(signatureKey, legacy).slice(0, 32)}` : 'bm_key_legacy', apiKey: legacy, label: '', createdAt: norm(settings.apiKeyUpdatedAt, 40), updatedAt: norm(settings.apiKeyUpdatedAt, 40) });
  return result;
}
export function applyCommand(settings, action, input, signatureKey) {
  const source = action.split('.')[0], field = section(source), stamp = new Date().toISOString();
  settings[field] ||= {}; const saved = settings[field]; let changedId = null;
  const previous = structuredClone(settings);
  if (source === 'steam') {
    fields(input, action === 'steam.save' ? ['expectedRevision', 'apiKey'] : ['expectedRevision']);
    saved.apiKey = action === 'steam.save' ? secret(input.apiKey, 16, 128) : '';
    saved.apiKeyUpdatedAt = action === 'steam.save' ? stamp : '';
  } else {
    let keys = bmKeys(saved, signatureKey);
    if (action === 'battlemetrics.save') {
      fields(input, ['expectedRevision', 'id', 'apiKey', 'label']);
      need(!Object.hasOwn(input, 'label') || typeof input.label === 'string' && input.label.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(input.label), 'INVALID_LABEL');
      const label = norm(input.label, 80), id = input.id === undefined ? null : keyId(input.id);
      const existing = id ? keys.find(k => k.id === id) : null;
      need(!id || existing, 'RESOURCE_NOT_FOUND', 404);
      const apiKey = Object.hasOwn(input, 'apiKey') ? secret(input.apiKey, 24, 2048) : existing?.apiKey;
      need(apiKey, 'INVALID_SECRET_LENGTH');
      const duplicate = keys.find(k => k.apiKey === apiKey);
      need(!existing || !duplicate || duplicate.id === existing.id, 'DUPLICATE_KEY', 409);
      const target = existing || duplicate;
      if (target) { target.apiKey = apiKey; target.label = label || target.label; target.updatedAt = stamp; changedId = target.id; }
      else { changedId = `bm_key_${randomUUID().replaceAll('-', '')}`; keys.push({ id: changedId, apiKey, label: label || `Token ${keys.length + 1}`, createdAt: stamp, updatedAt: stamp }); }
    } else if (action === 'battlemetrics.clear') { fields(input, ['expectedRevision']); keys = []; saved.lastSyncAt = ''; }
    else {
      fields(input, ['expectedRevision', 'id']); changedId = keyId(input.id);
      const index = keys.findIndex(k => k.id === changedId); need(index >= 0, 'RESOURCE_NOT_FOUND', 404);
      if (action === 'battlemetrics.delete') keys.splice(index, 1);
      else { const [key] = keys.splice(index, 1); keys.unshift(key); }
    }
    // Sanitize labels against both old and new keys so rotating/deleting a key
    // cannot reveal its plaintext through a label left on another record.
    for (const key of keys) key.label = safeLabel(safeLabel(key.label, previous), { ...settings, battlemetrics: { apiKeys: keys } });
    saved.apiKeys = keys; saved.apiKey = keys[0]?.apiKey || '';
    saved.apiKeyUpdatedAt = action === 'battlemetrics.delete' ? keys[0]?.updatedAt || '' : keys.length ? stamp : '';
    saved.lastSyncError = '';
  }
  return { source, keyId: changedId };
}
export function safeLabel(label, settings) {
  const secrets = [settings.steamWebApi?.apiKey, settings.battlemetrics?.apiKey, ...(settings.battlemetrics?.apiKeys || []).map(x => x?.apiKey)].filter(x => typeof x === 'string' && x.length);
  let result = norm(label, 80); for (const key of secrets) result = result.split(key).join('[已隐藏]'); return result;
}
