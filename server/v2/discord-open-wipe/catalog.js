import { isIP } from 'node:net';
import { IdentityError } from '../identity/errors.js';
import { normalizeTime, resolveLocalTime, validateTimeZone } from '../scheduling/time.js';

const need = (condition, code, status = 422) => { if (!condition) throw new IdentityError(code, status); };
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function currentTime(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  const instant = value instanceof Date ? value.getTime() : value;
  need(typeof instant === 'number' && Number.isFinite(instant), 'OPEN_WIPE_CLOCK_INVALID', 503);
  return instant;
}

function futureTime(value, now) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const instant = normalizeTime(value, 'UTC');
    return Date.parse(instant) > now ? instant : null;
  } catch { return null; }
}

function catalogTimeZone(value) {
  try { return validateTimeZone(value); }
  catch { return 'UTC'; }
}

function localTime(instant, timeZone) {
  if (!instant) return { wipeAtLocal: '', utcOffset: '' };
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(instant))) if (part.type !== 'literal') parts[part.type] = part.value;
  const wipeAtLocal = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  const offsetMinutes = Math.round((Date.parse(`${wipeAtLocal}:${parts.second}Z`) - Math.floor(Date.parse(instant) / 1000) * 1000) / 60000);
  const absolute = Math.abs(offsetMinutes);
  return { wipeAtLocal, utcOffset: `${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}` };
}

// No DNS or game-server access occurs here. Resolution belongs to the publisher
// after acknowledging Discord's interaction, so an unavailable host cannot
// prevent a usable card from being published.
export function normalizeOpenWipeConnect(value = '') {
  need(typeof value === 'string' && value.length <= 300 && !/[\x00-\x1f\x7f]/.test(value), 'OPEN_WIPE_CONNECT_INVALID');
  let address = value.trim();
  if (!address) return '';
  if (/^steam:\/\/connect\//i.test(address)) address = address.replace(/^steam:\/\/connect\//i, '').replace(/\/$/, '');
  else address = address.replace(/^(?:client\.)?connect +/i, '');
  const match = /^([a-z0-9.-]+|\[[a-f0-9:]+\]):([0-9]{1,5})$/i.exec(address);
  need(match && Number(match[2]) >= 1 && Number(match[2]) <= 65535, 'OPEN_WIPE_CONNECT_INVALID');
  const host = match[1];
  const validHost = host.startsWith('[') ? isIP(host.slice(1, -1)) === 6 : /^[0-9.]+$/.test(host) ? isIP(host) === 4 :
    host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  need(validHost, 'OPEN_WIPE_CONNECT_INVALID');
  return `client.connect ${host.toLowerCase()}:${Number(match[2])}`;
}

/** Read the same trusted catalog as the web Wipe editor. A missing date stays
 * missing, and a malformed catalog address stays editable rather than becoming
 * an executable console command. The caller owns optional catalog preparation. */
export function listOpenWipeServers(catalog, { now = Date.now } = {}) {
  need(typeof catalog?.listOptions === 'function', 'OPEN_WIPE_CATALOG_UNAVAILABLE', 503);
  const instant = currentTime(now), result = catalog.listOptions('servers');
  need(object(result) && Array.isArray(result.items) && result.items.length <= 10000, 'OPEN_WIPE_CATALOG_UNAVAILABLE', 503);
  const seen = new Set();
  return result.items.map(row => {
    need(object(row) && typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 160 && !seen.has(row.id), 'OPEN_WIPE_CATALOG_UNAVAILABLE', 503);
    seen.add(row.id);
    const snapshot = object(row.serverSnapshot) ? row.serverSnapshot : {};
    const label = String(row.label || snapshot.name || row.id).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 180);
    let directConnect = '';
    try { directConnect = normalizeOpenWipeConnect(snapshot.directConnect || snapshot.connectCommand || ''); } catch { /* Manual input remains available. */ }
    return { id: row.id, label, nextWipeAt: futureTime(snapshot.nextWipeAt, instant),
      timeZone: catalogTimeZone(snapshot.scheduleTimeZone || snapshot.wipeTimeZone), directConnect };
  });
}

export function defaultsForServer(catalog, id, options) {
  const server = listOpenWipeServers(catalog, options).find(row => row.id === id);
  need(server, 'OPEN_WIPE_SERVER_INVALID');
  return { ...server, ...localTime(server.nextWipeAt, server.timeZone) };
}

/** `server` is the trusted result of defaultsForServer, never a client snapshot.
 * Non-empty manual values win over automatic defaults. The renderer decides
 * whether adaptiveDisplay uses native Discord timestamps and private locale. */
export function normalizeOpenWipeSettings(input, server, { now = Date.now } = {}) {
  const fields = ['wipeAtLocal', 'timeZone', 'utcOffset', 'directConnect', 'autoConnect', 'notes', 'adaptiveDisplay'];
  need(object(input) && Object.keys(input).every(key => fields.includes(key)), 'OPEN_WIPE_SETTINGS_INVALID');
  need(object(server) && typeof server.id === 'string' && server.id && typeof server.label === 'string' && server.label, 'OPEN_WIPE_SERVER_INVALID');
  for (const field of ['autoConnect', 'adaptiveDisplay']) need(!own(input, field) || typeof input[field] === 'boolean', 'OPEN_WIPE_SETTINGS_INVALID');
  for (const field of ['wipeAtLocal', 'timeZone', 'utcOffset', 'directConnect', 'notes']) need(!own(input, field) || typeof input[field] === 'string', 'OPEN_WIPE_SETTINGS_INVALID');
  const instant = currentTime(now), timeZone = (input.timeZone || server.timeZone || 'UTC').trim();
  validateTimeZone(timeZone);
  let local = (input.wipeAtLocal || '').trim().replace(' ', 'T');
  // Accept the unambiguous day.month.year form shown by Discord's modal as well
  // as the ISO form used by this application's editor.
  local = local.replace(/^(\d{2})\.(\d{2})\.(\d{4})T/, '$3-$2-$1T');
  let wipeAt;
  if (local) wipeAt = resolveLocalTime({ localDateTime: local, timeZone, ...(input.utcOffset?.trim() ? { utcOffset: input.utcOffset.trim() } : {}) });
  else {
    wipeAt = futureTime(server.nextWipeAt, instant);
    need(wipeAt, 'OPEN_WIPE_TIME_REQUIRED');
  }
  need(Date.parse(wipeAt) > instant, 'OPEN_WIPE_TIME_NOT_FUTURE');
  const autoConnect = input.autoConnect ?? true, adaptiveDisplay = input.adaptiveDisplay ?? true;
  const manualConnect = normalizeOpenWipeConnect(input.directConnect || '');
  const directConnect = manualConnect || (autoConnect ? normalizeOpenWipeConnect(server.directConnect || '') : '');
  const notes = (input.notes || '').trim();
  need(notes.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes), 'OPEN_WIPE_NOTES_INVALID');
  return { serverId: server.id, serverName: server.label, wipeAt, ...localTime(wipeAt, timeZone), timeZone,
    directConnect, autoConnect, notes, adaptiveDisplay };
}
