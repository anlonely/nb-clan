import dgram from 'node:dgram';
import { computedWipeTimes } from '../../wipe-schedule.js';
import { parseAtlasA2SInfoResponse, atlasCurrentWipeAtFromKeywords } from '../../atlas-server-provider.js';

const SERVERS = Object.freeze({
  'eu-mondays': { host: 'monday.eu.moose.gg', name: 'Rusty Moose |EU Mondays|' },
  'eu-medium': { host: 'medium.eu.moose.gg', name: 'Rusty Moose |EU Medium|' },
  'eu-main': { host: 'main.eu.moose.gg', name: 'Rusty Moose |EU Main|' },
  'eu-monthly': { host: 'monthly.eu.moose.gg', name: 'Rusty Moose |EU Monthly|' }
});
const REQUEST = Buffer.from('\xff\xff\xff\xffTSource Engine Query\0', 'latin1');
const TTL_MS = 5 * 60_000, FAILURE_COOLDOWN_MS = 30_000;

function requestA2S(server, kind, { createSocket, timeoutMs }) {
  const request = kind === 'rules' ? Buffer.from('ffffffff56ffffffff', 'hex') : REQUEST;
  const challengePrefix = kind === 'rules' ? request.subarray(0, 5) : REQUEST;
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    let settled = false, challenges = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket.close(); } catch { /* DNS/connect may not have bound the socket yet. */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('MOOSE_A2S_TIMEOUT')), timeoutMs);
    const send = packet => {
      if (settled) return;
      try { socket.send(packet, error => { if (error) finish(error); }); } catch (error) { finish(error); }
    };
    socket.once('error', error => finish(error));
    socket.on('message', packet => {
      if (settled) return;
      try {
        if (!Buffer.isBuffer(packet) || packet.length < 5 || packet.length > 16384 || packet.readInt32LE(0) !== -1) {
          throw new Error('MOOSE_A2S_INVALID_RESPONSE');
        }
        if (packet[4] === 0x41) {
          // Moose's front end can append padding to the 4-byte challenge nonce
          // (24-byte response observed); only the nonce belongs in the request.
          if (challenges >= 2 || packet.length < 9 || packet.length > 64) throw new Error('MOOSE_A2S_INVALID_CHALLENGE');
          challenges++; send(Buffer.concat([challengePrefix, packet.subarray(5, 9)])); return;
        }
        finish(null, kind === 'rules' ? parseRules(packet) : parseAtlasA2SInfoResponse(packet));
      } catch (error) { finish(error); }
    });
    // A connected UDP socket accepts responses only from the resolved official
    // endpoint. Callers provide an ID, never a host or port.
    try { socket.connect(28015, server.host, () => send(request)); } catch (error) { finish(error); }
  });
}

function parseRules(packet) {
  if (packet[4] !== 0x45 || packet.length < 7) throw new Error('MOOSE_A2S_INVALID_RULES');
  const count = packet.readUInt16LE(5), rules = Object.create(null);
  if (count > 256) throw new Error('MOOSE_A2S_TOO_MANY_RULES');
  let cursor = 7;
  const string = () => {
    const end = packet.indexOf(0, cursor);
    if (end < 0) throw new Error('MOOSE_A2S_TRUNCATED_RULE');
    const value = packet.toString('utf8', cursor, end); cursor = end + 1; return value;
  };
  for (let i = 0; i < count; i++) {
    const key = string(), value = string();
    if (Object.hasOwn(rules, key)) throw new Error('MOOSE_A2S_DUPLICATE_RULE');
    rules[key] = value;
  }
  if (cursor !== packet.length) throw new Error('MOOSE_A2S_TRAILING_RULE_DATA');
  return rules;
}

function officialSchedule(server, rules, now) {
  const title = server.name.replace('Rusty Moose |', 'Official Rusty Moose ').replace(/\|$/, '');
  const description = Object.keys(rules).filter(key => /^description_\d{2}$/.test(key)).sort()
    .map(key => rules[key]).join('').replace(/\\n/g, '\n');
  if (rules.gmn !== 'rust' || rules.favendpoint !== server.host || !description.startsWith(`${title}\n`)) return null;
  const force = 'Force wipes are always on the first Thursday of the month at 2pm EST / 19:00 London Time.';
  if (!description.toLowerCase().includes(force.toLowerCase())) return null;
  const map = description.match(/(?:^|\n) - Map: ([^\n]+)/)?.[1];
  const base = { wipeTimeZone: 'Europe/London', wipeMinuteLocal: 0 };
  let schedule;
  if (server.host === 'monday.eu.moose.gg' && map === 'Mondays @ 15:00 London Time (unless force wipe)') {
    schedule = { ...base, schedule: 'weekly_monday_and_force', wipeHourLocal: 15, forceWipeHourLocal: 19 };
  } else if (['main.eu.moose.gg', 'medium.eu.moose.gg'].includes(server.host) && map === 'Thursdays @ 15:00 London Time (unless force wipe)') {
    schedule = { ...base, schedule: 'monthly_weeks', wipeWeeks: [1, 2, 3, 4, 5],
      wipeHoursLocalByWeek: { 1: 19, 2: 15, 3: 15, 4: 15, 5: 15 } };
  } else if (server.host === 'monthly.eu.moose.gg' && map === 'Monthly @ Force Wipe') {
    schedule = { ...base, schedule: 'monthly_force', wipeHourLocal: 19 };
  } else return null;
  return { nextWipeAt: computedWipeTimes(schedule, new Date(now)).nextStart,
    nextWipeSource: 'moose_official_schedule', nextWipeRule: `Map: ${map}. ${force}`,
    scheduleTimeZone: 'Europe/London' };
}

/** Testable reader with per-server deduplication. No background timer or writes.
 * Success: current and/or next dates, source labels and observation metadata.
 * The next date is computed only from a recognized live official RULES description.
 * Missing, invalid or unavailable data: null (including expired-cache failures).
 */
export function createMooseWipeDateReader({ createSocket = type => dgram.createSocket(type), now = Date.now, timeoutMs = 3000 } = {}) {
  const cache = new Map(), pending = new Map();
  const boundedTimeout = Math.max(1, Math.min(3000, Number(timeoutMs) || 3000));
  return async function read(serverId) {
    const id = typeof serverId === 'string' ? serverId.replace(/^moose-/, '') : '';
    const server = Object.hasOwn(SERVERS, id) ? SERVERS[id] : null;
    if (!server) return null;
    const cached = cache.get(id);
    if (cached && cached.expiresAt > now()) return cached.value ? { ...cached.value } : null;
    if (pending.has(id)) return pending.get(id).then(value => value ? { ...value } : null);
    const request = (async () => {
      let value = null;
      try {
        const info = await requestA2S(server, 'info', { createSocket, timeoutMs: boundedTimeout });
        const isRust = info.gameId === 252490 || (info.gameId === undefined && info.appId === (252490 & 0xffff));
        if (!isRust || info.name.trim() !== server.name || info.folder !== 'rust' || info.game !== 'Rust' ||
            !/(?:^|,)gmrust(?:,|$)/.test(info.keywords)) throw new Error('MOOSE_A2S_SERVER_MISMATCH');
        const observedAt = new Date(now()).toISOString();
        const currentWipeAt = atlasCurrentWipeAtFromKeywords(info.keywords, new Date(observedAt));
        if (!currentWipeAt) throw new Error('MOOSE_A2S_NO_WIPE_DATE');
        value = { currentWipeAt, currentWipeSource: 'moose_a2s', observedAt,
          sourceUrl: `steam://connect/${server.host}:28010`, serverName: info.name };
      } catch { /* A provider failure leaves this template usable without a date. */ }
      try {
        const rules = await requestA2S(server, 'rules', { createSocket, timeoutMs: boundedTimeout });
        const next = officialSchedule(server, rules, now());
        if (next) value = { ...value, ...next, observedAt: new Date(now()).toISOString(),
          sourceUrl: `steam://connect/${server.host}:28010`, serverName: server.name };
      } catch { /* Preserve a verified current date when RULES is unavailable. */ }
      cache.set(id, { value, expiresAt: now() + (value ? TTL_MS : FAILURE_COOLDOWN_MS) });
      return value;
    })();
    pending.set(id, request);
    try { const value = await request; return value ? { ...value } : null; }
    finally { pending.delete(id); }
  };
}

export const readMooseWipeDates = createMooseWipeDateReader();
