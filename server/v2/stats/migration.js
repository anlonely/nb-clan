import { installStatsSchema, StatsRepository } from './repository.js';
import { hash, need, normalizeRow, stamp, text } from './model.js';
import { vitalCategories } from './vital.js';
/** Explicit, bounded legacy history capture. Never called by a GET or a constructor. */
export function migrateStats(db, {
  dryRun = true,
  after = '',
  limit = 50,
  now = Date.now()
} = {}) {
  need(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'MIGRATION_LIMIT');
  const rows = db.prepare("SELECT id,hash,payload_json FROM json_records WHERE collection='wipeSettlements' AND id>? ORDER BY id LIMIT ?").all(after, limit + 1);
  const plan = {
    dryRun,
    items: [],
    conflicts: [],
    nextCursor: rows.length > limit ? rows[limit - 1].id : null
  };
  const installed = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_stats_meta'").get());
  for (const source of rows.slice(0, limit)) {
    need(Buffer.byteLength(source.payload_json) <= 2000000, 'LEGACY_SNAPSHOT_TOO_LARGE');
    const raw = JSON.parse(source.payload_json),
      wipeId = text(raw.wipeId);
    need(wipeId, 'LEGACY_WIPE_ID_REQUIRED');
    const existing = installed ? db.prepare('SELECT payload FROM v2_stats_archives WHERE wipe_id=? AND revision=1').get(wipeId) : null;
    if (existing) {
      const s = JSON.parse(existing.payload);
      if (s.legacyHash !== source.hash) plan.conflicts.push({
        id: source.id,
        wipeId,
        code: 'LEGACY_SNAPSHOT_CHANGED'
      });else plan.items.push({
        id: source.id,
        wipeId,
        status: 'reused',
        sourceHash: source.hash
      });
      continue;
    }
    need(Array.isArray(raw.kdaSnapshot || []), 'LEGACY_SNAPSHOT_INVALID');
    need((raw.kdaSnapshot || []).length <= 5000, 'LEGACY_SNAPSHOT_TOO_LARGE');
    plan.items.push({
      id: source.id,
      wipeId,
      status: 'capture',
      sourceHash: source.hash
    });
  }
  if (dryRun) return plan;
  need(!plan.conflicts.length, 'MIGRATION_CONFLICT', 409);
  installStatsSchema(db);
  const repo = new StatsRepository(db);
  return repo.transaction(() => {
    for (const item of plan.items.filter(i => i.status === 'capture')) {
      const source = rows.find(r => r.id === item.id),
        raw = JSON.parse(source.payload_json),
        w = repo.get('wipes', item.wipeId) || {},
        participants = raw.participantsSnapshot || [];
      const projected = (raw.kdaSnapshot || []).map((r, index) => normalizeRow({
        ...r,
        id: r.id || `${item.id}:${index}`,
        displayName: r.displayName || participants.find(p => p.memberId === r.memberId)?.displayName || '',
        squadId: r.squadId || participants.find(p => p.memberId === r.memberId)?.squadId || '',
        squadName: r.squadName || participants.find(p => p.memberId === r.memberId)?.squadName || '',
        ...((r.sourceId || r.source) === 'vital' && r.raw?.statistics ? { categories: vitalCategories(r.raw.statistics) } : {}),
        capturedAt: r.capturedAt || r.syncedAt || raw.generatedAt
      }, {
        wipeId: item.wipeId,
        serverId: w.serverProfileId || w.serverId
      }, now));
      const snapshot = {
        wipeId: item.wipeId,
        revision: 1,
        title: w.name || raw.name || item.wipeId,
        sourceId: projected[0]?.sourceId || 'legacy_unknown',
        createdAt: stamp(raw.generatedAt),
        capturedAt: new Date(now).toISOString(),
        reason: '保留旧结算原始快照',
        provenance: 'legacy_capture',
        completeness: 'unknown',
        legacyId: item.id,
        legacyHash: item.sourceHash,
        legacyRaw: raw,
        metricVersion: 'nb-kda-1'
      };
      repo.saveArchive(snapshot, projected);
    }
    return plan;
  });
}
