import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { memberDTO, chatDTO, inviteDTO } from './source.js';
/** Offline, explicitly called migration of an authorized legacy snapshot. Does not open any source file. */
export function migrateLegacyRelay(repo, store, {
  dryRun = true,
  after = 0,
  limit = 100,
  sourceHash
} = {}) {
  const fingerprint = createHash('sha256').update(JSON.stringify(store)).digest('hex');
  if (after > 0 && !sourceHash) throw new IdentityError('MIGRATION_SOURCE_HASH_REQUIRED', 422);
  if (sourceHash && sourceHash !== fingerprint) throw new IdentityError('MIGRATION_SOURCE_CHANGED', 409);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new IdentityError('INVALID_MIGRATION_PAGE', 422);
  const relay = store.rustplusRelay || {},
    bindings = repo.scopes(),
    rows = [],
    unmapped = [];
  const scopeFor = r => bindings.find(s => s.source === (r.client?.id || r.clientId) && s.server === (r.server?.key || r.serverKey || r.key));
  for (const server of relay.servers || []) {
    const scope = scopeFor(server);
    if (!scope) {
      unmapped.push({
        kind: 'snapshot',
        id: server.key
      });
      continue;
    }
    if (server.snapshot) rows.push({
      kind: 'snapshot',
      scope: scope.id,
      id: server.key,
      at: server.snapshot.capturedAt || server.lastSeenAt || '',
      payload: {
        clan: Object.fromEntries(['id', 'name', 'memberLimit', 'announcement'].filter(k => server.snapshot.clan?.[k] !== undefined).map(k => [k, server.snapshot.clan[k]])),
        members: (server.snapshot.members || []).slice(0, 500).map(memberDTO),
        invites: (server.snapshot.invites || []).slice(0, 250).map(inviteDTO)
      }
    });
  }
  for (const [kind, items, project] of [['chat', relay.chatMessages || [], chatDTO], ['invite', relay.inviteRecords || [], inviteDTO]]) for (const r of items) {
    const scope = scopeFor(r);
    if (!scope) {
      unmapped.push({
        kind,
        id: r.id
      });
      continue;
    }
    if (!r.id || !Number.isFinite(Date.parse(r.sentAt || r.receivedAt))) throw new IdentityError('MIGRATION_RECORD_INVALID', 422);
    rows.push({
      kind,
      scope: scope.id,
      id: r.id,
      at: r.sentAt || r.receivedAt,
      received: r.receivedAt || r.sentAt,
      payload: project(r)
    });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
  const page = rows.slice(after, after + limit),
    result = {
      sourceHash: fingerprint,
      dryRun,
      total: rows.length,
      unmapped,
      processed: 0,
      inserted: 0,
      skipped: 0,
      next: after + page.length < rows.length ? after + page.length : null
    };
  if (!dryRun && unmapped.length) throw new IdentityError('MIGRATION_SOURCE_UNMAPPED', 409);
  const apply = () => {
    for (const r of page) {
      result.processed++;
      if (r.kind === 'snapshot') {
        const s = repo.scope(r.scope);
        if (s.snapshot || s.cutoff || !Number.isFinite(Date.parse(r.at))) {
          result.skipped++;
          continue;
        }
        if (!dryRun) repo.db.prepare('UPDATE v2_realtime_scopes SET snapshot=?,observed=?,watermark=?,received=?,revision=revision+1 WHERE id=?').run(JSON.stringify(r.payload), r.at, r.at, r.at, r.scope);
        result.inserted++;
        continue;
      }
      const seen = repo.db.prepare('SELECT 1 FROM v2_realtime_records WHERE scope=? AND kind=? AND id=?').get(r.scope, r.kind, r.id) || r.kind === 'chat' && repo.db.prepare('SELECT 1 FROM v2_realtime_seen WHERE scope=? AND id=?').get(r.scope, r.id);
      if (seen || repo.scope(r.scope).cutoff) {
        result.skipped++;
        continue;
      }
      if (!dryRun) {
        repo.db.prepare('INSERT INTO v2_realtime_records(scope,kind,id,occurred,received,payload) VALUES(?,?,?,?,?,?)').run(r.scope, r.kind, r.id, r.at, r.received, JSON.stringify(r.payload));
        if (r.kind === 'chat') repo.db.prepare('INSERT INTO v2_realtime_seen VALUES(?,?)').run(r.scope, r.id);
      }
      result.inserted++;
    }
    return result;
  };
  return dryRun ? apply() : repo.transaction(apply);
}
