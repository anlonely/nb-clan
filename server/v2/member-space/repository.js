import { readSqliteCollectionRecord, upsertSqliteCollectionRecord, readSqliteScalar, runSqliteTransaction } from '../../storage/sqlite-migrate.js';
import { IdentityError } from '../identity/errors.js';
import { MEMBER_GRANTS, validGrant } from '../identity/permissions.js';

const column = (alias, path) => `json_extract(${alias}.payload_json,'$.${path}')`;
const currentMembership = alias => `(${column(alias, 'validTo')} IS NULL OR ${column(alias, 'validTo')}='')`;
const parse = rows => rows.map(row => JSON.parse(row.payload_json));
const sql = (text, args = []) => ({ text, args });

/** SQL equivalents of G03 scopeMatches for a wipe, evaluated before LIMIT.
 * Values, including grant IDs and cursors, are always bound parameters.
 */
export function audiencePredicate(memberId, alias = 'w') {
  if (!memberId) return sql('0');
  const direct = `EXISTS (SELECT 1 FROM json_each(${column(alias, 'audience.memberIds')}) x WHERE x.value=?)`;
  const squad = `EXISTS (SELECT 1 FROM json_records sm JOIN json_each(${column(alias, 'audience.squadIds')}) x
    ON x.value=${column('sm', 'squadId')} WHERE sm.collection='squadMembers' AND ${column('sm', 'memberId')}=? AND ${currentMembership('sm')})`;
  const unassigned = `(${column(alias, 'audience.includeUnassigned')}=1 AND NOT EXISTS (SELECT 1 FROM json_records sm
    WHERE sm.collection='squadMembers' AND ${column('sm', 'memberId')}=? AND ${currentMembership('sm')}))`;
  return sql(`(COALESCE(${column(alias, 'audience.allMembers')},0)=1 OR ${direct} OR ${squad} OR ${unassigned})`, [memberId, memberId, memberId]);
}

function wipeScope(scope, actor, alias, effect, capability) {
  if (scope.type === 'all') return sql('1');
  if (scope.type === 'self') {
    const audience = audiencePredicate(actor.memberId, alias);
    return effect === 'deny' || capability.endsWith('.read') ? audience :
      sql(`(COALESCE(${column(alias, 'audience.allMembers')},0)=0 AND ${audience.text})`, audience.args);
  }
  if (scope.type === 'wipes') return sql(`EXISTS (SELECT 1 FROM json_each(?) x WHERE x.value=${alias}.id)`, [JSON.stringify(scope.ids)]);
  if (scope.type !== 'squads') return sql('0');
  const ids = JSON.stringify(scope.ids), squads = column(alias, 'audience.squadIds'), members = column(alias, 'audience.memberIds');
  const memberMatch = `EXISTS (SELECT 1 FROM json_records sm JOIN json_each(?) allowed ON allowed.value=${column('sm', 'squadId')}
    WHERE sm.collection='squadMembers' AND ${column('sm', 'memberId')}=x.value AND ${currentMembership('sm')})`;
  if (effect === 'deny') return sql(`(COALESCE(${column(alias, 'audience.allMembers')},0)=1 OR EXISTS (SELECT 1 FROM json_each(${squads}) x JOIN json_each(?) allowed ON allowed.value=x.value)
    OR EXISTS (SELECT 1 FROM json_each(${members}) x WHERE ${memberMatch}) OR ${column(alias, 'audience.includeUnassigned')}=1)`, [ids, ids]);
  return sql(`(COALESCE(${column(alias, 'audience.allMembers')},0)=0 AND COALESCE(${column(alias, 'audience.includeUnassigned')},0)=0 AND
    (COALESCE(json_array_length(${squads}),0)+COALESCE(json_array_length(${members}),0))>0 AND
    NOT EXISTS (SELECT 1 FROM json_each(${squads}) x WHERE NOT EXISTS (SELECT 1 FROM json_each(?) allowed WHERE allowed.value=x.value)) AND
    NOT EXISTS (SELECT 1 FROM json_each(${members}) x WHERE NOT ${memberMatch}))`, [ids, ids]);
}

export function wipePermissionPredicate(actor, capability, alias = 'w') {
  if (actor?.status !== 'active' || actor.restricted) return sql('0');
  const grants = [...(actor.grants || []), ...(actor.memberId ? MEMBER_GRANTS : [])]
    .filter(g => validGrant(g) && g.capability === capability);
  const combine = effect => {
    const parts = grants.filter(g => g.effect === effect).map(g => wipeScope(g.scope, actor, alias, effect, capability));
    return sql(parts.length ? parts.map(p => `(${p.text})`).join(' OR ') : '0', parts.flatMap(p => p.args));
  };
  const allow = combine('allow'), deny = combine('deny');
  return sql(`((${allow.text}) AND NOT (${deny.text}))`, [...allow.args, ...deny.args]);
}

export function memberPermissionPredicate(actor, capability, memberExpression, wipeExpression = null) {
  const grants = [...(actor.grants || []), ...(actor.memberId ? MEMBER_GRANTS : [])].filter(g => validGrant(g) && g.capability === capability);
  const scope = g => {
    if (g.scope.type === 'all') return sql('1');
    if (g.scope.type === 'self') return sql(`${memberExpression}=?`, [actor.memberId || '']);
    if (g.scope.type === 'squads') return sql(`EXISTS (SELECT 1 FROM json_records sm JOIN json_each(?) allowed ON allowed.value=${column('sm', 'squadId')}
      WHERE sm.collection='squadMembers' AND ${column('sm', 'memberId')}=${memberExpression} AND ${currentMembership('sm')})`, [JSON.stringify(g.scope.ids)]);
    if (g.scope.type === 'wipes' && wipeExpression) return sql(`EXISTS (SELECT 1 FROM json_each(?) allowed WHERE allowed.value=${wipeExpression})`, [JSON.stringify(g.scope.ids)]);
    return sql('0');
  };
  const combine = effect => {
    const parts = grants.filter(g => g.effect === effect).map(scope);
    return sql(parts.length ? parts.map(p => `(${p.text})`).join(' OR ') : '0', parts.flatMap(p => p.args));
  };
  const allow = combine('allow'), deny = combine('deny');
  return sql(`((${allow.text}) AND NOT (${deny.text}))`, [...allow.args, ...deny.args]);
}

export class MemberSpaceRepository {
  constructor(db) {
    this.db = db;
    if (readSqliteScalar(db, 'v2IdentitySchemaVersion') !== 1 || !readSqliteScalar(db, 'v2IdentityMigration'))
      throw new IdentityError('IDENTITY_MIGRATION_REQUIRED', 503);
    if (readSqliteScalar(db, 'v2SchedulingSchemaVersion') !== 1 || !readSqliteScalar(db, 'v2SchedulingMigration'))
      throw new IdentityError('SCHEDULING_MIGRATION_REQUIRED', 503);
  }
  get(collection, id) { return readSqliteCollectionRecord(this.db, collection, id); }
  put(collection, record) { upsertSqliteCollectionRecord(this.db, collection, record.id, record); return record; }
  transaction(fn) { return runSqliteTransaction(this.db, 'v2_member_space', fn); }
  rosterRevision() { return this.db.prepare('SELECT revision FROM v2_scheduling_clock WHERE id=1').get().revision; }
  bindings(accountId) {
    return parse(this.db.prepare(`SELECT payload_json FROM json_records WHERE collection='v2SteamBindings'
      AND json_extract(payload_json,'$.accountId')=? ORDER BY CASE json_extract(payload_json,'$.status') WHEN 'verified' THEN 0 ELSE 1 END,id LIMIT 1`).all(accountId));
  }
  platforms(accountId) {
    // Explicit public fields only; select a deterministic latest identity per provider.
    return this.db.prepare(`SELECT provider,externalId,verifiedAt,displayName FROM (
      SELECT json_extract(payload_json,'$.provider') AS provider,
        json_extract(payload_json,'$.externalId') AS externalId,
        json_extract(payload_json,'$.verifiedAt') AS verifiedAt,
        json_extract(payload_json,'$.displayName') AS displayName,
        ROW_NUMBER() OVER (PARTITION BY CASE WHEN json_extract(payload_json,'$.provider') LIKE 'wechat:%' THEN 'wechat' ELSE json_extract(payload_json,'$.provider') END
          ORDER BY json_extract(payload_json,'$.verifiedAt') DESC,id) AS position
      FROM json_records WHERE collection='v2Identities' AND json_extract(payload_json,'$.accountId')=?
        AND (json_extract(payload_json,'$.provider') IN ('discord','kook') OR
          (json_extract(payload_json,'$.provider') LIKE 'wechat:%' AND json_extract(payload_json,'$.verifiedAt') IS NOT NULL)))
      WHERE position=1 ORDER BY provider LIMIT 3`).all(accountId);
  }

  memberships(memberIds) {
    if (!memberIds.length) return [];
    // Scope resolution only needs the selected members' current associations.
    const rows = parse(this.db.prepare(`SELECT sm.payload_json FROM json_records sm JOIN json_each(?) ids
      ON ids.value=${column('sm', 'memberId')} WHERE sm.collection='squadMembers' AND ${currentMembership('sm')} ORDER BY sm.id LIMIT 5101`)
      .all(JSON.stringify(memberIds)));
    if (rows.length > 5100) throw new IdentityError('MEMBER_RELATION_LIMIT', 503);
    return rows;
  }
  team(memberId) {
    const row = this.db.prepare(`SELECT s.payload_json FROM json_records s WHERE s.collection='squads'
      AND COALESCE(${column('s', 'archivedAt')},'')='' AND EXISTS (SELECT 1 FROM json_records sm
        WHERE sm.collection='squadMembers' AND ${column('sm', 'memberId')}=? AND ${column('sm', 'squadId')}=s.id AND ${currentMembership('sm')})
      ORDER BY s.id LIMIT 1`).get(memberId);
    return row ? JSON.parse(row.payload_json) : null;
  }
  teams() {
    return this.db.prepare(`SELECT s.id,
      COALESCE(NULLIF(${column('s', 'name')},''),NULLIF(${column('s', 'displayName')},''),s.id) AS name
      FROM json_records s WHERE s.collection='squads' AND COALESCE(${column('s', 'archivedAt')},'')=''
      ORDER BY name COLLATE NOCASE,s.id`).all();
  }
  teamMembers(actor, teamId, after, limit) {
    const permission = memberPermissionPredicate(actor, 'members.directory', 'm.id');
    return parse(this.db.prepare(`SELECT m.payload_json FROM json_records m WHERE m.collection='members' AND m.id>?
      AND EXISTS (SELECT 1 FROM json_records sm WHERE sm.collection='squadMembers' AND ${column('sm', 'memberId')}=m.id
        AND ${column('sm', 'squadId')}=? AND ${currentMembership('sm')}) AND ${permission.text} ORDER BY m.id LIMIT ?`)
      .all(after, teamId, ...permission.args, limit));
  }
  teamPlatformDetails(memberIds) {
    if (!memberIds.length) return { identities: [], wechatUsers: [] };
    const ids = JSON.stringify(memberIds);
    const identities = this.db.prepare(`SELECT json_extract(a.payload_json,'$.memberId') AS memberId,
        json_extract(i.payload_json,'$.provider') AS provider,
        json_extract(i.payload_json,'$.externalId') AS externalId,
        json_extract(i.payload_json,'$.displayName') AS displayName,
        json_extract(i.payload_json,'$.avatarUrl') AS avatarUrl,
        json_extract(i.payload_json,'$.verifiedAt') AS verifiedAt
      FROM json_records a JOIN json_each(?) targets ON targets.value=json_extract(a.payload_json,'$.memberId')
      JOIN json_records i ON i.collection='v2Identities' AND json_extract(i.payload_json,'$.accountId')=a.id
      WHERE a.collection='v2Accounts' AND json_extract(i.payload_json,'$.verifiedAt') IS NOT NULL
        AND (json_extract(i.payload_json,'$.provider') IN ('kook','discord') OR
          json_extract(i.payload_json,'$.provider') LIKE 'wechat:%')`).all(ids);
    const wechatUsers = this.db.prepare(`SELECT w.id AS id, json_extract(payload_json,'$.memberId') AS memberId,
        json_extract(payload_json,'$.appId') AS appId,
        json_extract(payload_json,'$.openid') AS openid,
        json_extract(payload_json,'$.nickname') AS nickname,
        json_extract(payload_json,'$.avatarUploadId') AS avatarUploadId,
        json_extract(payload_json,'$.avatarRevision') AS avatarRevision,
        json_extract(payload_json,'$.avatarUrl') AS avatarUrl
      FROM json_records w JOIN json_each(?) targets ON targets.value=json_extract(w.payload_json,'$.memberId')
      WHERE w.collection='wechatUsers'`).all(ids);
    return { identities, wechatUsers };
  }
  teamSteamProfiles(memberIds) {
    if (!memberIds.length) return [];
    return this.db.prepare(`SELECT m.id AS memberId,
        json_extract(p.payload_json,'$.displayName') AS displayName,
        json_extract(p.payload_json,'$.avatar') AS avatar
      FROM json_records m JOIN json_each(?) targets ON targets.value=m.id
      JOIN json_records p ON p.collection='memberProfiles'
        AND json_extract(p.payload_json,'$.steamId')=json_extract(m.payload_json,'$.steamId')
        AND (COALESCE(json_extract(p.payload_json,'$.memberId'),'')='' OR json_extract(p.payload_json,'$.memberId')=m.id)
      WHERE m.collection='members' ORDER BY json_extract(p.payload_json,'$.fetchedAt') DESC,p.id`)
      .all(JSON.stringify(memberIds));
  }
  nextWipe(actor, now) {
    const audience = audiencePredicate(actor.memberId), permission = wipePermissionPredicate(actor, 'wipes.read');
    const stamp = new Date(now).toISOString(), muster = column('w', 'musterAt'), life = column('w', 'lifecycle');
    const row = this.db.prepare(`SELECT w.payload_json FROM json_records w WHERE w.collection='v2Wipes'
      AND ${audience.text} AND ${permission.text} AND ${muster} IS NOT NULL AND julianday(${muster}) IS NOT NULL
      AND (${life}='active' OR (${life}='scheduled' AND (${muster}>=? OR ${column('w', 'signupClosesAt')}>?)))
      ORDER BY CASE WHEN ${muster}<=? THEN 0 ELSE 1 END,
        CASE WHEN ${muster}<=? THEN ${muster} END DESC,
        CASE WHEN ${muster}>? THEN ${muster} END ASC,w.id ASC LIMIT 1`)
      .get(...audience.args, ...permission.args, stamp, stamp, stamp, stamp, stamp);
    return row ? JSON.parse(row.payload_json) : null;
  }
  history(actor, after, limit) {
    const permission = wipePermissionPredicate(actor, 'wipes.read'), signupPermission = memberPermissionPredicate(actor, 'signups.read', column('s', 'memberId'), 'w.id');
    const statsPermission = memberPermissionPredicate(actor, 'stats.read', column('s', 'memberId'), 'w.id');
    const updated = `COALESCE(${column('s', 'updatedAt')},'')`, tail = after ? JSON.parse(after) : null;
    return this.db.prepare(`SELECT w.payload_json AS wipe_json, s.payload_json AS signup_json FROM json_records s
      JOIN json_records w ON w.collection='v2Wipes' AND w.id=${column('s', 'wipeId')}
      WHERE s.collection='v2Signups' AND ${column('s', 'memberId')}=? AND (?='' OR ${updated}<? OR (${updated}=? AND s.id<?))
      AND ${permission.text} AND ${signupPermission.text} AND ${statsPermission.text} ORDER BY ${updated} DESC,s.id DESC LIMIT ?`)
      .all(actor.memberId, after, tail?.updatedAt || '', tail?.updatedAt || '', tail?.id || '', ...permission.args, ...signupPermission.args, ...statsPermission.args, limit)
      .map(row => ({ wipe: JSON.parse(row.wipe_json), signup: JSON.parse(row.signup_json) }));
  }
}
