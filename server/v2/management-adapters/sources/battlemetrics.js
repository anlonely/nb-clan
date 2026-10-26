import { need, text, stamp } from '../../stats/model.js';
import { checkAbort } from './transport.js';
const rows = raw => [...(Array.isArray(raw?.data) ? raw.data : raw?.data ? [raw.data] : []), ...(raw?.included || [])];
// Derived from legacy api.js battlemetricsMatchPayload/extractBattlemetricsPlayerMatches.
// Deliberately omits the unsafe first-player fallback when no Steam identifier is returned.
export async function readBattlemetricsIdentity({ member, profile, context, request, signal }) {
  const raw = await request('/players/match', { method: 'POST', body: { data: [{ type: 'identifier', attributes: { type: 'steamID', identifier: member.steamId } }] } });
  const all = rows(raw), ids = new Set();
  for (const row of all) if (row.type === 'identifier' && row.attributes?.type === 'steamID' && row.attributes.identifier === member.steamId) {
    for (const relationship of Object.values(row.relationships || {})) for (const ref of Array.isArray(relationship?.data) ? relationship.data : relationship?.data ? [relationship.data] : []) if (ref.type === 'player') ids.add(String(ref.id));
  }
  if (ids.size === 1) {
    const id = [...ids][0], player = all.find(p => p.type === 'player' && String(p.id) === id);
    return { match: { battlemetricsId: id, steamId: member.steamId, displayName: text(player?.attributes?.name, 120), confidence: 'direct' } };
  }
  const candidates = new Map([...ids].map(id => [id, { battlemetricsId: id, confidence: 'alias' }]));
  if (context.battlemetricsServerId) for (const alias of [...new Set([member.customName, member.steamNickname, profile?.displayName].filter(Boolean))].slice(0, 3)) {
    checkAbort(signal);
    const query = new URLSearchParams({ 'filter[search]': text(alias, 120), 'filter[servers]': context.battlemetricsServerId, 'page[size]': '10' });
    const found = await request(`/players?${query}`);
    for (const p of rows(found)) if (p.type === 'player' && /^\d{1,30}$/.test(p.id)) candidates.set(p.id, { battlemetricsId: p.id, displayName: text(p.attributes?.name, 120), confidence: 'alias' });
    if (candidates.size >= 10) break;
  }
  return { candidates: [...candidates.values()].slice(0, 10) };
}
// Same sessions endpoint as legacy battlemetricsPlayerSessions; bounded pages, no writes,
// no assumed sort order or early cutoff, and absolute pagination links are origin-checked.
export async function readBattlemetricsSessions({ playerId, context, request, signal, config }) {
  need(/^\d{1,30}$/.test(playerId), 'INVALID_DATA');
  const query = new URLSearchParams({ 'page[size]': '100', 'filter[servers]': context.battlemetricsServerId });
  const basePath = `/players/${playerId}/relationships/sessions`;
  let path = `${basePath}?${query}`;
  const sessions = [], seen = new Set(), maxPages = Math.min(100, Math.max(1, config.sessionPageLimit || 20));
  for (let page = 0; path && page < maxPages; page++) {
    checkAbort(signal); need(!seen.has(path), 'INVALID_DATA'); seen.add(path);
    const raw = await request(path); need(Array.isArray(raw?.data) && raw.data.length <= 100, 'INVALID_DATA');
    for (const row of raw.data) {
      need(stamp(row.attributes?.start) && (!row.attributes.stop || stamp(row.attributes.stop)), 'INVALID_DATA');
      const serverId = row.relationships?.server?.data?.id;
      need(typeof serverId === 'string', 'INVALID_DATA');
      sessions.push({ serverId, start: row.attributes.start, end: row.attributes.stop || null });
    }
    const next = raw.links?.next;
    if (!next) { path = null; break; }
    const url = new URL(next, 'https://api.battlemetrics.com');
    need(url.origin === 'https://api.battlemetrics.com' && !url.username && !url.password && url.pathname === basePath, 'INVALID_DATA');
    path = url.pathname + url.search;
  }
  return { sessions, complete: !path, observedAt: new Date().toISOString() };
}
