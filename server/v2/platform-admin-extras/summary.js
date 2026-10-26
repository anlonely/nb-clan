import { can, validGrant, MEMBER_GRANTS } from '../identity/permissions.js';
import { fresh } from './authority.js';
import { need, hash, sync } from './model.js';
const possible = (actor, cap) => {
  const grants = [...(actor.grants || []), ...(actor.memberId ? MEMBER_GRANTS : [])].filter(validGrant).filter(g => g.capability === cap);
  return grants.some(g => g.effect === 'allow') && !grants.some(g => g.effect === 'deny' && g.scope.type === 'all');
};
export function readSummary({ identity, members, scheduling, stats, system, now }, actor, input = {}) {
  actor = fresh(identity, actor);
  need(typeof input.wipeId === 'string' && input.wipeId.length > 0 && input.wipeId.length <= 160, 'EXPLICIT_WIPE_REQUIRED');
  need(scheduling, 'SCHEDULING_PROJECTION_REQUIRED', 503);
  const selectedWipe = sync(scheduling.getWipe(actor, input.wipeId));
  const observedAt = new Date(now()).toISOString(), scope = { actorId: actor.id, permissionVersion: actor.permissionVersion,
    digest: identity.scopeDigest(actor), wipeId: input.wipeId, countScope: 'authorized_resources' };
  const blocks = {}, counts = {};
  const add = (name, data, version) => {
    blocks[name] = { ...data, scope, observedAt, version: version ?? hash(data) };
    counts[name] = data.countKnown ? data.total : null;
  };
  const page = (name, fn) => {
    const result = sync(fn());
    add(name, { total: result.total, countKnown: Number.isSafeInteger(result.total), partial: !Number.isSafeInteger(result.total),
      source: `members.${name}` }, result.revision);
  };
  if (members && possible(actor, 'members.read')) page('members', () => members.members(actor, { limit: 1 }));
  if (members && possible(actor, 'squads.read')) page('squads', () => members.squads(actor, { limit: 1 }));
  const wipeAllowed = can(actor, 'wipes.read', { kind: 'wipe', id: input.wipeId }, identity.relations());
  if (scheduling && wipeAllowed) {
    const wipe = selectedWipe;
    add('wipe', { id: wipe.id, title: wipe.title, lifecycle: wipe.lifecycle, total: null, participantCount: null,
      countKnown: false, partial: true, reason: 'BOUNDED_PARTICIPANT_COUNT_UNAVAILABLE', source: 'scheduling.getWipe', contentRevision: wipe.contentRevision }, wipe.revision);
  }
  if (stats && wipeAllowed && possible(actor, 'stats.read')) {
    const result = sync(stats.sources(actor, input.wipeId));
    add('stats', { total: result.items.reduce((n, s) => n + s.count, 0), countKnown: true, partial: false,
      unit: 'authorized_stat_rows', source: 'stats.sources', sources: result.items }, hash([result.archiveRevision, result.visibility, result.items]));
  }
  if (stats && wipeAllowed && stats.canExport(actor, input.wipeId)) add('export', { total: null, countKnown: false, partial: true,
    reason: 'EXPORTABLE_WIPE_COUNT_UNAVAILABLE', source: 'capability-only' });
  if (system && can(actor, 'system.logs', { kind: 'system', id: 'logs' }, identity.relations())) {
    const day = new Date(now() + 8 * 3600000).toISOString().slice(0, 10), from = new Date(`${day}T00:00:00+08:00`).toISOString();
    const to = new Date(Date.parse(from) + 86400000).toISOString();
    try {
      const result = sync(system.read(actor, 'logs', { from, to, limit: 1, source: 'audit' }));
      add('logs', { total: result.nextCursor ? null : result.items.length, countKnown: !result.nextCursor, partial: Boolean(result.nextCursor),
        source: 'system.logs:audit', range: result.range, timeZone: 'Asia/Shanghai', reason: result.nextCursor ? 'PAGE_HAS_MORE_COUNT_UNKNOWN' : null }, hash(result));
    } catch (error) { if (error.status !== 403) throw error; }
  }
  return { dtoVersion: 2, wipeId: input.wipeId, observedAt, scope, version: hash(Object.fromEntries(Object.entries(blocks).map(([key, { observedAt: ignored, ...block }]) => [key, block]))), partial: Object.values(blocks).some(b => b.partial),
    counts, ...blocks, compatibility: { legacyCounts: 'Use countKnown; missing block means no capability; null means unknown, never zero.' } };
}
