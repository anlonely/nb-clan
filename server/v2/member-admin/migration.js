import { MemberAdminRepository, installMemberAdminSchema, hash, requireValue } from './repository.js';
/** Explicit migration only. It records existing facts without changing a single
 * legacy member, identity, relationship, application, risk rule or dismissal. */
export function migrateMemberAdmin(db, {
  apply = false,
  now = new Date().toISOString()
} = {}) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='v2_member_admin_meta'").get();
  const existing = tables && db.prepare('SELECT migration FROM v2_member_admin_meta WHERE id=1').get()?.migration;
  if (existing) return {
    ...JSON.parse(existing),
    replayed: true
  };
  const collections = ['members', 'squads', 'squadMembers', 'joinApplications', 'discordMemberApplications', 'accountAlertDismissals'];
  const plan = {
    schemaVersion: 1,
    counts: {},
    conflicts: [],
    sourceHashes: {},
    relations: []
  };
  for (const collection of collections) {
    const rows = db.prepare('SELECT id,payload_json,hash FROM json_records WHERE collection=? ORDER BY id').all(collection);
    requireValue(rows.length <= 10000, 'MIGRATION_COLLECTION_LIMIT', 503);
    plan.counts[collection] = rows.length;
    plan.sourceHashes[collection] = hash(rows);
    if (collection === 'squadMembers') {
      const seen = new Map();
      for (const r of rows) {
        const rel = JSON.parse(r.payload_json);
        plan.relations.push(rel);
        if (!rel.validTo) {
          if (seen.has(rel.memberId)) plan.conflicts.push({
            code: 'MULTIPLE_CURRENT_SQUADS',
            memberId: rel.memberId,
            relationIds: [seen.get(rel.memberId), rel.id]
          });
          seen.set(rel.memberId, rel.id);
        }
      }
    }
  }
  const members = new Set(db.prepare("SELECT id FROM json_records WHERE collection='members'").all().map(r => r.id));
  const squads = new Set(db.prepare("SELECT id FROM json_records WHERE collection='squads'").all().map(r => r.id));
  for (const rel of plan.relations) {
    if (!members.has(rel.memberId) || !squads.has(rel.squadId)) plan.conflicts.push({
      code: 'ORPHAN_RELATION',
      relationId: rel.id,
      memberId: rel.memberId,
      squadId: rel.squadId
    });
  }
  const manifest = {
    ...plan,
    relations: undefined,
    planHash: hash(plan),
    appliedAt: apply ? now : null
  };
  if (!apply) return {
    ...manifest,
    dryRun: true
  };
  requireValue(!plan.conflicts.length, 'MIGRATION_CONFLICT', 409, {
    current: manifest
  });
  installMemberAdminSchema(db);
  const repo = new MemberAdminRepository(db);
  return repo.transaction(() => {
    for (const rel of plan.relations) {
      repo.db.prepare('INSERT INTO v2_member_admin_history(kind,resource_id,member_id,squad_id,actor_id,action,payload,created_at) VALUES(?,?,?,?,?,?,?,?)').run('member', rel.memberId, rel.memberId, rel.squadId, 'migration', 'legacy.relationship', JSON.stringify({
        fromSquadId: null,
        toSquadId: rel.squadId,
        validFrom: rel.validFrom || rel.createdAt || null,
        validTo: rel.validTo || null,
        legacyRelationId: rel.id,
        unknownStart: !rel.validFrom && !rel.createdAt
      }), now);
    }
    repo.db.prepare('UPDATE v2_member_admin_meta SET migration=? WHERE id=1').run(JSON.stringify(manifest));
    return {
      ...manifest,
      replayed: false
    };
  });
}
