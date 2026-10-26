import { finalizeProviderQuery } from '../source-providers/projection.js';
import { randomUUID } from 'node:crypto';
import { authorize, can, memberDTO, validGrant, scopeMatches } from '../identity/permissions.js';
import { memberPermissionPredicate, wipePermissionPredicate } from '../member-space/repository.js';
import { StatsRepository } from './repository.js';
import { hash, need, text, stamp, normalizeRow, parseImport, parseSteamInput, intervalDelta, projectStatCategories, publicAvatar } from './model.js';
import { vitalCategories } from './vital.js';
import { leaderboardById } from '../../../shared/vital-leaderboards.js';
const j = (a, k) => `json_extract(${a}.payload_json,'$.${k}')`;
const baseSource = a => `COALESCE(${j(a, 'sourceId')},${j(a, 'source')},'legacy_unknown')`;
const vitalHint = key => `COALESCE(NULLIF(trim(${j('w', 'serverSnapshot.' + key)}),''),NULLIF(trim(${j('w', key)}),''),NULLIF(trim(${j('w', 'legacyRaw.' + key)}),''),'')`;
const vitalProvider = `lower(COALESCE(${['serverSnapshot.provider', 'serverSnapshot.serverProvider', 'provider', 'serverProvider', 'legacyRaw.provider', 'legacyRaw.serverProvider'].map(key => `NULLIF(trim(${j('w', key)}),'')`).join(',')},''))`;
const vitalWipePredicate = `(${vitalProvider}='vital' OR ${vitalProvider}='' AND
  (lower(${vitalHint('kdaProvider')})='vital' OR ${vitalHint('kdaProvider')}='' AND
    (${vitalHint('vitalServerId')}!='' OR EXISTS(SELECT 1 FROM json_records r WHERE r.collection='kdaRows' AND ${j('r', 'wipeId')}=w.id AND ${baseSource('r')}='vital') OR
     EXISTS(SELECT 1 FROM v2_stats_archive_rows ar WHERE ar.wipe_id=w.id AND ar.source_id='vital'))))`;
export const MEMBER_QUERY_PROJECTION_VERSION = 'member-public-1';
const querySources = ['official', 'inventory', 'member', 'vital', 'moose'];
const steamIdValid = value => typeof value === 'string' && /^7656119\d{10}$/.test(value);
const explicitlyDenied = (actor, capability, resource, relations) => actor.grants.some(g =>
  validGrant(g) && g.capability === capability && g.effect === 'deny' && scopeMatches(g.scope, actor, resource, relations, 'deny'));
// Only this closed shape can reach a member query job, cache or export. Provider
// fields/rows, profile URLs, nested member objects and error text are never copied.
function projectMemberQuery(raw, now) {
  const value = raw.publicMember;
  const present = value && steamIdValid(value.steamId);
  const publicMember = present ? {
    steamId: value.steamId, displayName: text(value.displayName, 120), avatar: publicAvatar(value.avatar),
    profileUrl: `https://steamcommunity.com/profiles/${value.steamId}/`,
    ...(value.squad ? { squad: { id: text(value.squad.id), name: text(value.squad.name, 120) } } : {}),
    ...(value.currentWipe ? { currentWipe: { id: text(value.currentWipe.id), title: text(value.currentWipe.title, 120),
      response: ['attending_on_time', 'attending_later', 'not_attending'].includes(value.currentWipe.response) ? value.currentWipe.response : null } } : {}),
    ...(value.details ? { details: { membershipStatus: text(value.details.membershipStatus, 32),
      specialty: Array.isArray(value.details.specialty) ? value.details.specialty.filter(x => typeof x === 'string').slice(0, 12).map(x => text(x, 80)) : [] } } : {})
  } : null;
  const fields = !present ? [{ name: '成员档案', value: '不存在或不在可见范围', status: 'unavailable' }] : [
    { name: 'Steam 主页', value: publicMember.profileUrl, status: 'observed' },
    ...(publicMember.squad ? [{ name: '所属队伍', value: publicMember.squad.name, status: 'observed' }] : []),
    ...(publicMember.currentWipe ? [{ name: '当前档期', value: publicMember.currentWipe.title, status: 'observed' },
      { name: '报名回复', value: publicMember.currentWipe.response || '未回复', status: 'observed' }] : []),
    ...(publicMember.details ? [{ name: '成员状态', value: publicMember.details.membershipStatus, status: 'observed' },
      { name: '专长', value: publicMember.details.specialty.join('、'), status: 'observed' }] : [])
  ];
  return { sourceId: 'member', projectionVersion: MEMBER_QUERY_PROJECTION_VERSION,
    fetchedAt: stamp(raw.fetchedAt) || new Date(now).toISOString(), status: present ? 'fresh' : 'unavailable',
    steamId: steamIdValid(raw.steamId) ? raw.steamId : null, displayName: publicMember?.displayName || '',
    publicMember, fields, rows: [], errors: [] };
}
export class StatsService {
  constructor(identity, {
    authorizeWrite = () => false,
    writeCurrent,
    enqueueSync,
    readSync,
    providers = {},
    renderExport,
    now = identity.now || Date.now
  } = {}) {
    this.identity = identity;
    this.repo = new StatsRepository(identity.repo.db);
    this.now = now;
    Object.assign(this, {
      authorizeWrite,
      writeCurrent,
      enqueueSync,
      readSync,
      providers,
      renderExport
    });
  }
  actor(input) {
    const a = this.identity.actorForAccount(input?.id);
    need(a.permissionVersion === input.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    need(a.status === 'active' && !a.restricted, 'ACCESS_DENIED', 403);
    return a;
  }
  scope(a) {
    return this.identity.scopeDigest(a);
  }
  wipe(a, id) {
    const w = this.repo.get('v2Wipes', id);
    need(w, 'RESOURCE_NOT_FOUND', 404);
    authorize(a, 'wipes.read', {
      kind: 'wipe',
      id
    }, this.identity.relations(), true);
    return w;
  }
  supportsVitalStats(w) {
    return Boolean(this.repo.db.prepare(`SELECT 1 FROM json_records w WHERE w.collection='v2Wipes' AND w.id=? AND ${vitalWipePredicate}`).get(w.id));
  }
  hidden(a, id) {
    const v = this.repo.db.prepare('SELECT * FROM v2_stats_visibility WHERE wipe_id=?').get(id);
    if (v?.hidden && !this.authorizeWrite(a, 'history.visibility', {
      kind: 'wipe',
      id
    })) need(false, 'RESOURCE_NOT_FOUND', 404);
    return v || {
      revision: 0,
      hidden: 0,
      reason: ''
    };
  }
  writeAllowed(a, action, id) {
    need(this.authorizeWrite(a, action, {
      kind: 'wipe',
      id
    }) === true, 'STATS_WRITE_NOT_GRANTED', 403);
  }
  receipt(a, id, action, body, fn) {
    need(typeof id === 'string' && /^[A-Za-z0-9_.:-]{8,160}$/.test(id), 'OPERATION_ID_REQUIRED');
    return this.repo.transaction(() => {
      a = this.actor(a);
      const prior = this.repo.db.prepare('SELECT * FROM v2_stats_operations WHERE account_id=? AND operation_id=?').get(a.id, id),
        digest = hash([action, body]);
      if (prior) {
        need(prior.action === action && prior.command_hash === digest, 'IDEMPOTENCY_CONFLICT', 409);
        return {
          ...JSON.parse(prior.result),
          replayed: true
        };
      }
      const result = fn();
      const out = {
        operationReceipt: {
          operationId: id,
          action,
          committedAt: new Date(this.now()).toISOString()
        },
        ...result,
        replayed: false
      };
      this.repo.db.prepare('INSERT INTO v2_stats_operations VALUES(?,?,?,?,?)').run(a.id, id, action, digest, JSON.stringify(out));
      this.repo.db.prepare('INSERT INTO v2_stats_audit(account_id,operation_id,action,wipe_id,reason,created_at) VALUES(?,?,?,?,?,?)').run(a.id, id, action, body.wipeId || null, text(body.reason, 500), out.operationReceipt.committedAt);
      return out;
    });
  }
  catalog(input, query = {}) {
    return this.repo.transaction(() => {
      const a = this.actor(input),
        p = wipePermissionPredicate(a, 'wipes.read'),
        limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
      need(!query.provider || query.provider === 'vital', 'INVALID_SOURCE');
      const providerWhere = query.provider === 'vital' ? `AND ${vitalWipePredicate}` : '';
      const rows = this.repo.db.prepare(`SELECT w.id,${j('w', 'title')} title,${j('w', 'lifecycle')} lifecycle,${j('w', 'serverProfileId')} serverId,
        COALESCE(${j('w', 'serverActualWipeAt')},${j('w', 'serverScheduledWipeAt')},${j('w', 'actualStartedAt')},${j('w', 'musterAt')},${j('w', 'createdAt')}) startedAt,
        COALESCE(v.hidden,0) hidden,COALESCE(v.revision,0) visibilityRevision
        FROM json_records w LEFT JOIN v2_stats_visibility v ON v.wipe_id=w.id WHERE w.collection='v2Wipes' AND ${p.text}
        AND (?='' OR instr(lower(${j('w', 'title')}),lower(?))>0) ${providerWhere} ORDER BY w.id LIMIT 1001`).all(...p.args, text(query.q), text(query.q));
      need(rows.length <= 1000, 'WIPE_CATALOG_LIMIT', 503);
      const visible = rows.filter(w => (!w.hidden || this.authorizeWrite(a, 'history.visibility', {
        kind: 'wipe',
        id: w.id
      })) && (query.hidden === '1' || !w.hidden));
      // The first catalog entry is the workspace default: current wipes precede
      // upcoming and historical wipes, regardless of their random IDs.
      const priority = w => w.lifecycle === 'active' ? 0 : w.lifecycle === 'scheduled' ? 1 : 2;
      visible.sort((left, right) => priority(left) - priority(right) ||
        ((Date.parse(left.startedAt) || 0) - (Date.parse(right.startedAt) || 0)) * (left.lifecycle === 'scheduled' ? 1 : -1) || left.id.localeCompare(right.id));
      const context = [a.id, this.scope(a), 'wipes-current-first', query.q || '', query.hidden || '', query.provider || '', hash(visible)];
      const cursor = query.cursor ? this.repo.decode(query.cursor, context, this.now()) : null;
      const offset = cursor ? visible.findIndex(w => w.id === cursor.after) + 1 : 0;
      need(!cursor || offset > 0, 'CURSOR_EXPIRED', 410);
      const selected = visible.slice(offset, offset + limit).map(w => ({
        ...w,
        archiveRevision: this.repo.latest(w.id)
      }));
      return {
        items: selected,
        nextCursor: visible.length > offset + limit ? this.repo.encode({
          context: hash(context),
          after: selected.at(-1).id,
          expiresAt: this.now() + 300000
        }) : null
      };
    });
  }
  canExport(a, wipeId) {
    const p = memberPermissionPredicate(a, 'stats.export', j('r', 'memberId'), j('r', 'wipeId'));
    return can(a, 'stats.export', {
      kind: 'wipe',
      id: wipeId
    }, this.identity.relations()) || Boolean(this.repo.db.prepare(`SELECT 1 FROM json_records r WHERE r.collection='kdaRows' AND ${j('r', 'wipeId')}=? AND ${p.text} LIMIT 1`).get(wipeId, ...p.args));
  }
  sources(input, wipeId) {
    const a = this.actor(input),
      w = this.wipe(a, wipeId);
    this.hidden(a, wipeId);
    const p = memberPermissionPredicate(a, 'stats.read', j('r', 'memberId'), j('r', 'wipeId'));
    const rows = this.repo.db.prepare(`SELECT ${baseSource('r')} sourceId,COUNT(*) count,MAX(${j('r', 'syncedAt')}) capturedAt FROM json_records r WHERE r.collection='kdaRows' AND ${j('r', 'wipeId')}=? AND ${p.text} GROUP BY 1 LIMIT 51`).all(wipeId, ...p.args);
    need(rows.length <= 50, 'SOURCE_LIMIT', 503);
    return {
      wipe: {
        id: w.id,
        title: w.title,
        lifecycle: w.lifecycle,
        revision: w.revision,
        supportsVitalStats: this.supportsVitalStats(w)
      },
      items: rows,
      archiveRevision: this.repo.latest(wipeId),
      visibility: (() => {
        const v = this.hidden(a, wipeId);
        return {
          revision: v.revision,
          hidden: v.hidden,
          ...(this.authorizeWrite(a, 'history.visibility', {
            kind: 'wipe',
            id: wipeId
          }) ? {
            reason: v.reason
          } : {})
        };
      })(),
      actions: {
        import: this.authorizeWrite(a, 'stats.import', {
          kind: 'wipe',
          id: wipeId
        }) === true,
        sync: ['scheduled', 'active'].includes(w.lifecycle) && this.supportsVitalStats(w) && this.authorizeWrite(a, 'stats.sync', {
          kind: 'wipe',
          id: wipeId
        }) === true && can(a, 'sync.run', {
          kind: 'wipe',
          id: wipeId
        }, this.identity.relations()),
        archive: can(a, 'wipes.archive', {
          kind: 'wipe',
          id: wipeId
        }, this.identity.relations()),
        visibility: this.authorizeWrite(a, 'history.visibility', {
          kind: 'wipe',
          id: wipeId
        }) === true,
        export: this.canExport(a, wipeId)
      }
    };
  }
  list(input, query = {}) {
    return this.repo.transaction(() => {
      const a = this.actor(input),
        wipeId = text(query.wipeId),
        w = this.wipe(a, wipeId);
      this.hidden(a, wipeId);
      const relations = this.identity.relations();
      need(query.sourceId && query.metricVersion === 'nb-kda-1', 'STATS_CONTEXT_REQUIRED');
      if (query.sourceId === 'vital') need(this.supportsVitalStats(w), 'SOURCE_WIPE_MISMATCH', 422);
      const revision = Number(query.revision || 0);
      need(Number.isSafeInteger(revision) && revision >= 0, 'INVALID_REVISION');
      const archive = revision ? this.repo.archive(wipeId, revision) : null;
      need(!revision || archive, 'RESOURCE_NOT_FOUND', 404);
      if (query.sourceId === 'vital' && archive?.sourceId) need(archive.sourceId === 'vital', 'SOURCE_WIPE_MISMATCH', 422);
      const permission = memberPermissionPredicate(a, 'stats.read', j('r', 'memberId'), j('r', 'wipeId'));
      const namePermission = memberPermissionPredicate(a, 'members.read', j('r', 'memberId'));
      const exportPermission = query.exporting ? memberPermissionPredicate(a, 'stats.export', j('r', 'memberId'), j('r', 'wipeId')) : {
        text: '1',
        args: []
      };
      const sort = ['kills', 'deaths', 'assists', 't3Kills', 'kd', 'kda', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds'].includes(query.sort) ? query.sort : 'kills',
        order = query.order === 'asc' ? 'ASC' : 'DESC';
      const from = revision ? 'v2_stats_archive_rows r' : "json_records r",
        where = revision ? 'r.wipe_id=? AND r.revision=?' : `r.collection='kdaRows' AND ${j('r', 'wipeId')}=?`,
        bind = revision ? [wipeId, revision] : [wipeId];
      const revisionRows = revision ? null : this.repo.db.prepare(`SELECT r.id,r.hash FROM json_records r WHERE r.collection='kdaRows' AND ${j('r', 'wipeId')}=? ORDER BY r.id LIMIT 5001`).all(wipeId);
      need(!revisionRows || revisionRows.length <= 5000, 'STATS_READ_LIMIT', 503);
      const version = revision ? hash(archive) : hash(revisionRows);
      const context = [a.id, this.scope(a), wipeId, query.sourceId, revision, query.q || '', query.squadId || '', query.memberId || '', sort, order, version, Boolean(query.exporting)];
      const cursor = query.cursor ? this.repo.decode(query.cursor, context, this.now()) : null;
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 50)),
        offset = cursor?.offset || 0;
      need(offset <= 10000, 'READ_LIMIT', 422);
      const metric = `nb_stats_metric(r.payload_json,'${sort}')`;
      const squadFilter = revision ? `${j('r', 'squadId')}=?` : `EXISTS(SELECT 1 FROM json_records sm WHERE sm.collection='squadMembers' AND ${j('sm', 'memberId')}=${j('r', 'memberId')} AND ${j('sm', 'squadId')}=? AND COALESCE(${j('sm', 'validTo')},'')='')`;
      const rows = this.repo.db.prepare(`SELECT r.payload_json,m.payload_json member_json,
 CASE WHEN ${metric} IS NOT NULL THEN RANK() OVER(ORDER BY (${metric} IS NULL),${metric} ${order}) END leaderboard_rank
 FROM ${from} LEFT JOIN json_records m ON m.collection='members' AND m.id=${j('r', 'memberId')} WHERE ${where} AND ${baseSource('r')}=? AND ${permission.text} AND ${exportPermission.text}
 AND (?='' OR ${j('r', 'memberId')}=?) AND (?='' OR (${namePermission.text} AND (instr(lower(COALESCE(${j('r', 'displayName')},${j('m', 'displayName')},${j('m', 'customName')},'')),lower(?))>0 OR instr(COALESCE(${j('r', 'steamId')},''),?)>0)))
 AND (?='' OR ${squadFilter})
 ORDER BY (${metric} IS NULL),${metric} ${order},r.id ASC LIMIT ? OFFSET ?`).all(...bind, text(query.sourceId), ...permission.args, ...exportPermission.args, text(query.memberId), text(query.memberId), text(query.q), ...namePermission.args, text(query.q), text(query.q), text(query.squadId), text(query.squadId), limit + 1, offset);
      const selected = rows.slice(0, limit).map(raw => {
        const r = JSON.parse(raw.payload_json),
          m = raw.member_json ? JSON.parse(raw.member_json) : null;
        const dto = normalizeRow({ ...r, ...(query.sourceId === 'vital' && !r.categories && r.raw?.statistics ? { categories: vitalCategories(r.raw.statistics) } : {}) }, {
          wipeId,
          serverId: w.serverProfileId
        }, this.now());
        dto.rank = dto.values[sort] === null ? null : raw.leaderboard_rank;
        if (can(a, 'members.read', {
          kind: 'member',
          id: r.memberId
        }, relations)) {
          if (!revision) {
            dto.displayName = m ? memberDTO(m).displayName : '';
            // Resolve current identity metadata from the member/profile cache;
            // stats collection does not copy these fields into every KDA row.
            dto.avatarUrl = [m?.avatar, m?.steamAvatar, m?.avatarUrl].map(publicAvatar).find(Boolean) || '';
            if (!dto.avatarUrl && steamIdValid(m?.steamId)) {
              const profiles = this.repo.db.prepare(`SELECT json_extract(payload_json,'$.avatar') avatar
 FROM json_records WHERE collection='memberProfiles' AND json_extract(payload_json,'$.steamId')=?
 AND (COALESCE(json_extract(payload_json,'$.memberId'),'')='' OR json_extract(payload_json,'$.memberId')=?)
 ORDER BY json_extract(payload_json,'$.fetchedAt') DESC,id LIMIT 5`).all(m.steamId, m.id);
              dto.avatarUrl = profiles.map(profile => publicAvatar(profile.avatar)).find(Boolean) || '';
            }
            const relation = this.repo.db.prepare("SELECT json_extract(payload_json,'$.squadId') squadId FROM json_records WHERE collection='squadMembers' AND json_extract(payload_json,'$.memberId')=? AND COALESCE(json_extract(payload_json,'$.validTo'),'')='' LIMIT 1").get(r.memberId);
            dto.squadId = relation?.squadId || '';
            dto.squadName = text(this.repo.get('squads', dto.squadId)?.name, 120);
          }
        } else {
          dto.displayName = '';
          dto.avatarUrl = '';
          dto.steamId = '';
          dto.squadName = '';
        }
        return dto;
      });
      const legacy = w.legacyRaw || this.repo.get('wipes', wipeId) || {};
      const server = { ...legacy, ...w, ...w.serverSnapshot };
      const frozenWipe = archive?.wipe || {};
      return {
        wipe: {
          id: w.id,
          title: archive?.title || w.title,
          lifecycle: w.lifecycle,
          serverName: revision ? text(frozenWipe.serverName, 120) : text(server.name || server.serverName, 120),
          serverId: revision ? text(frozenWipe.serverId) || selected.find(row => row.serverId)?.serverId || '' : text(w.serverProfileId || server.serverId || server.vitalServerId),
          providerWipeId: revision ? text(frozenWipe.providerWipeId) || selected.find(row => row.providerWipeId)?.providerWipeId || null : text(server.vitalWipeId) || selected.find(row => row.providerWipeId)?.providerWipeId || null,
          startedAt: revision ? stamp(frozenWipe.startedAt) : stamp(w.serverActualWipeAt || w.actualStartedAt || legacy.startedAt || w.serverScheduledWipeAt),
          closedAt: revision ? stamp(frozenWipe.closedAt) : stamp(w.endedAt || legacy.closedAt)
        },
        items: selected,
        sourceId: query.sourceId,
        metricVersion: 'nb-kda-1',
        revision,
        dataRevision: version,
        countScope: 'authorized_stats_rows',
        rankingScope: 'authorized_filtered_rows',
        rankMetric: sort,
        rowOffset: offset,
        nextCursor: rows.length > limit ? this.repo.encode({
          context: hash(context),
          offset: offset + limit,
          expiresAt: this.now() + 300000
        }) : null,
        archive: archive ? {
          revision: archive.revision,
          reason: archive.reason,
          createdAt: archive.createdAt,
          provenance: archive.provenance,
          completeness: archive.completeness
        } : null
      };
    });
  }
  collect(a, query) {
    let cursor,
      items = [],
      first;
    do {
      const page = this.list(a, {
        ...query,
        limit: 100,
        cursor
      });
      first ||= page;
      need(!first || page.dataRevision === first.dataRevision, 'REVISION_CONFLICT', 409);
      items.push(...page.items);
      need(items.length <= 5000, 'EXPORT_LIMIT');
      cursor = page.nextCursor;
    } while (cursor);
    return {
      ...first,
      items,
      nextCursor: null
    };
  }
  import(input, body, id) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    this.writeAllowed(a, 'stats.import', w.id);
    need(this.writeCurrent, 'STATS_WRITER_REQUIRED', 503);
    // The injected owner invokes apply within the common store write queue and one SQLite transaction,
    // committing legacy rows, snapshots, receipt and audit together, then invalidating/patching its cache.
    return this.writeCurrent(() => {
      this.actor(a);
      this.writeAllowed(a, 'stats.import', w.id);
      return this.receipt(a, id, 'stats.import', body, () => {
        const current = this.wipe(a, w.id);
        need(['active', 'scheduled'].includes(current.lifecycle), 'STATS_FROZEN', 409);
        need(body.expectedRevision === current.revision, 'REVISION_CONFLICT', 409);
        const parsed = parseImport(body),
          upserts = [];
        for (const r of parsed) {
          const matches = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? LIMIT 2").all(r.steamId);
          need(matches.length === 1, 'IMPORT_MEMBER_NOT_FOUND');
          const m = JSON.parse(matches[0].payload_json);
          authorize(a, 'stats.read', {
            kind: 'stat',
            memberId: m.id,
            wipeId: w.id
          }, this.identity.relations());
          need(this.authorizeWrite(a, 'stats.import.member', {
            kind: 'member',
            id: m.id,
            wipeId: w.id
          }) === true, 'STATS_WRITE_NOT_GRANTED', 403);
          const legacy = this.repo.get('wipes', w.id);
          const participant = this.repo.db.prepare("SELECT 1 FROM json_records WHERE collection IN ('wipeParticipants','v2Signups') AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? AND (collection='wipeParticipants' AND json_extract(payload_json,'$.status') NOT IN ('unavailable','not_join','not_attending') OR collection='v2Signups' AND json_extract(payload_json,'$.response') IN ('attending_on_time','attending_later')) LIMIT 1").get(w.id, m.id);
          need(participant || legacy?.kdaMemberScope === 'all_members', 'IMPORT_MEMBER_OUT_OF_WIPE');
          const existingRow = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? LIMIT 1").get(w.id, m.id),
            old = existingRow ? JSON.parse(existingRow.payload_json) : {};
          need(body.expectedRows?.[m.id] === hash(old), 'ROW_REVISION_CONFLICT', 409);
          const next = {
            ...old,
            ...r,
            id: old.id || randomUUID(),
            memberId: m.id,
            wipeId: w.id,
            serverId: current.serverProfileId,
            source: 'manual_import',
            sourceId: 'manual_import',
            sourceRevision: (old.sourceRevision || 0) + 1,
            syncedAt: new Date(this.now()).toISOString(),
            capturedAt: new Date(this.now()).toISOString()
          };
          upserts.push(next);
        }
        return {
          upserts,
          imported: upserts.length,
          ignored: 0
        };
      });
    });
  }
  ingest(input, body, id) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    this.writeAllowed(a, 'stats.ingest', w.id);
    need(this.writeCurrent, 'STATS_WRITER_REQUIRED', 503);
    need(Array.isArray(body.rows) && body.rows.length > 0 && body.rows.length <= 500, 'INGEST_LIMIT');
    need(body.sourceId && body.serverId === w.serverProfileId && body.providerWipeId, 'STATS_CONTEXT_REQUIRED');
    return this.writeCurrent(() => this.receipt(a, id, 'stats.ingest', body, () => {
      const current = this.wipe(a, w.id);
      need(current.revision === body.expectedRevision, 'REVISION_CONFLICT', 409);
      const seen = new Set(),
        upserts = [];
      for (const raw of body.rows) {
        need(raw && typeof raw.memberId === 'string' && !seen.has(raw.memberId), 'INGEST_DUPLICATE_MEMBER');
        seen.add(raw.memberId);
        need(this.authorizeWrite(a, 'stats.ingest.member', {
          kind: 'member',
          id: raw.memberId,
          wipeId: w.id
        }) === true, 'STATS_WRITE_NOT_GRANTED', 403);
        const member = this.repo.get('members', raw.memberId);
        need(member, 'RESOURCE_NOT_FOUND', 404);
        const found = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? LIMIT 1").get(w.id, raw.memberId),
          old = found ? JSON.parse(found.payload_json) : {};
        need(body.expectedRows?.[raw.memberId] === hash(old), 'ROW_REVISION_CONFLICT', 409);
        need(Number.isSafeInteger(raw.sourceRevision) && raw.sourceRevision > 0 && stamp(raw.capturedAt), 'SOURCE_REVISION_REQUIRED');
        if (old.sourceId === body.sourceId || old.source === body.sourceId) {
          need(raw.sourceRevision > (old.sourceRevision || 0) && (!stamp(old.capturedAt || old.syncedAt) || Date.parse(raw.capturedAt) >= Date.parse(old.capturedAt || old.syncedAt)), 'STALE_SOURCE_REVISION', 409);
        } else if (old.id) {
          need(body.replaceSource === true && text(body.reason), 'SOURCE_REPLACEMENT_REQUIRED', 409);
          this.writeAllowed(a, 'stats.replace-source', w.id);
        }
        const projected = normalizeRow({
          ...raw,
          sourceId: body.sourceId,
          serverId: body.serverId,
          providerWipeId: body.providerWipeId,
          wipeId: w.id
        }, w, this.now());
        const row = {
          id: old.id || randomUUID(),
          memberId: member.id,
          steamId: member.steamId,
          wipeId: w.id,
          ...projected.values,
          capabilities: projected.capabilities,
          source: body.sourceId,
          sourceId: body.sourceId,
          serverId: body.serverId,
          providerWipeId: body.providerWipeId,
          sourceRevision: raw.sourceRevision,
          capturedAt: stamp(raw.capturedAt),
          syncedAt: new Date(this.now()).toISOString(),
          receivedAt: new Date(this.now()).toISOString(),
          coverage: text(raw.coverage) || 'unknown',
          ...(body.sourceId === 'vital' ? { categories: projected.categories } : {})
        };
        upserts.push(row);
      }
      return {
        upserts,
        accepted: upserts.length
      };
    }));
  }
  importPreview(input, body) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    this.writeAllowed(a, 'stats.import', w.id);
    const rows = parseImport(body),
      expectedRows = {};
    for (const r of rows) {
      const m = this.repo.db.prepare("SELECT id FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? LIMIT 1").get(r.steamId);
      need(m, 'IMPORT_MEMBER_NOT_FOUND');
      need(this.authorizeWrite(a, 'stats.import.member', {
        kind: 'member',
        id: m.id,
        wipeId: w.id
      }) === true, 'STATS_WRITE_NOT_GRANTED', 403);
      const old = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? LIMIT 1").get(w.id, m.id);
      expectedRows[m.id] = hash(old ? JSON.parse(old.payload_json) : {});
    }
    return {
      rows,
      expectedRows,
      expectedRevision: w.revision
    };
  }
  archive(input, body, id) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    authorize(a, 'wipes.archive', {
      kind: 'wipe',
      id: w.id
    }, this.identity.relations());
    need(text(body.reason, 500), 'REASON_REQUIRED');
    return this.receipt(a, id, 'stats.archive', body, () => {
      need(['ended', 'archived', 'cancelled'].includes(w.lifecycle), 'ARCHIVE_NOT_TERMINAL', 409);
      const revision = this.repo.latest(w.id);
      need(body.expectedRevision === revision, 'REVISION_CONFLICT', 409);
      need(body.sourceId, 'STATS_CONTEXT_REQUIRED');
      const page = this.collect(a, {
        wipeId: w.id,
        sourceId: body.sourceId,
        metricVersion: 'nb-kda-1'
      });
      need(['complete', 'missing_data'].includes(body.completeness), 'COMPLETENESS_REQUIRED');
      need(body.completeness !== 'complete' || page.items.length > 0 && page.items.every(r => r.values.kills !== null && r.values.deaths !== null), 'STATS_INCOMPLETE', 409);
      // Require complete row visibility before creating a shared archive; scoped exporters cannot freeze a partial clan archive.
      const all = this.repo.db.prepare("SELECT COUNT(*) n FROM json_records r WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')=? AND COALESCE(json_extract(payload_json,'$.sourceId'),json_extract(payload_json,'$.source'),'legacy_unknown')=?").get(w.id, body.sourceId).n;
      need(all === page.items.length, 'ARCHIVE_SCOPE_INCOMPLETE', 403);
      const s = {
        wipeId: w.id,
        wipe: page.wipe,
        revision: revision + 1,
        title: w.title,
        sourceId: body.sourceId,
        createdAt: new Date(this.now()).toISOString(),
        reason: text(body.reason, 500),
        actorAccountId: a.id,
        provenance: 'v2_stats_snapshot',
        completeness: body.completeness,
        metricVersion: 'nb-kda-1',
        baseRevision: revision || null,
        schedulingArchiveRevision: w.archiveRevision || null
      };
      if (body.corrections) {
        need(Array.isArray(body.corrections) && body.corrections.length <= 500, 'CORRECTION_LIMIT');
        const seen = new Set();
        for (const correction of body.corrections) {
          need(correction && typeof correction.memberId === 'string' && !seen.has(correction.memberId), 'INVALID_CORRECTION');
          seen.add(correction.memberId);
          const row = page.items.find(r => r.memberId === correction.memberId);
          need(row, 'CORRECTION_MEMBER_NOT_FOUND');
          need(correction.values && typeof correction.values === 'object' && !Array.isArray(correction.values), 'INVALID_CORRECTION');
          for (const [k, v] of Object.entries(correction.values)) need(['kills', 'deaths', 'assists', 't3Kills', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds'].includes(k) && (v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0), 'INVALID_METRIC');
          const updated = normalizeRow({
            ...row,
            values: {
              ...row.values,
              ...correction.values
            },
            coverage: 'manual_revision',
            capabilities: {
              ...row.capabilities,
              ...Object.fromEntries(Object.entries(correction.values).map(([k, v]) => [k, v !== null]))
            }
          }, row, this.now());
          Object.assign(row, updated);
        }
        s.corrections = body.corrections;
      }
      need(body.completeness !== 'complete' || page.items.every(r => r.values.kills !== null && r.values.deaths !== null), 'STATS_INCOMPLETE', 409);
      const prior = s.schedulingArchiveRevision ? this.repo.get('v2WipeArchives', `${w.id}:${s.schedulingArchiveRevision}`) : null;
      s.roster = prior?.roster?.rows || this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='v2Signups' AND json_extract(payload_json,'$.wipeId')=? ORDER BY id LIMIT 5001").all(w.id).map(r => {
        const p = JSON.parse(r.payload_json),
          m = this.repo.get('members', p.memberId);
        return {
          memberId: p.memberId,
          displayName: m ? memberDTO(m).displayName : '',
          response: p.response,
          expectedArrivalAt: p.expectedArrivalAt,
          signupRevision: p.signupRevision
        };
      });
      need(s.roster.length <= 5000, 'ARCHIVE_ROSTER_LIMIT', 503);
      this.repo.saveArchive(s, page.items);
      return {
        current: {
          ...s,
          roster: undefined,
          corrections: undefined
        }
      };
    });
  }
  visibility(input, body, id) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    this.writeAllowed(a, 'history.visibility', w.id);
    need(text(body.reason, 500) && typeof body.hidden === 'boolean', 'REASON_REQUIRED');
    return this.receipt(a, id, 'history.visibility', body, () => {
      need(['ended', 'archived', 'cancelled'].includes(w.lifecycle), 'ARCHIVE_NOT_TERMINAL', 409);
      const current = this.hidden(a, w.id);
      need(body.expectedRevision === current.revision, 'REVISION_CONFLICT', 409);
      const next = {
        wipeId: w.id,
        revision: current.revision + 1,
        hidden: body.hidden,
        reason: text(body.reason, 500)
      };
      this.repo.db.prepare('INSERT OR REPLACE INTO v2_stats_visibility VALUES(?,?,?,?)').run(w.id, next.revision, Number(next.hidden), next.reason);
      return {
        current: next
      };
    });
  }
  history(input, wipeId, query = {}) {
    const a = this.actor(input);
    const w = this.wipe(a, wipeId);
    this.hidden(a, wipeId);
    const before = Number(query.before || 2147483647);
    need(Number.isSafeInteger(before) && before > 0, 'INVALID_REVISION');
    const sourceId = text(query.sourceId, 32);
    if (sourceId === 'vital') need(this.supportsVitalStats(w), 'SOURCE_WIPE_MISMATCH', 422);
    const sourceFilter = sourceId ? "AND json_extract(payload,'$.sourceId')=?" : '';
    const rows = this.repo.db.prepare(`SELECT revision,json_extract(payload,'$.sourceId') sourceId,json_extract(payload,'$.createdAt') createdAt,json_extract(payload,'$.reason') reason,json_extract(payload,'$.provenance') provenance,json_extract(payload,'$.completeness') completeness FROM v2_stats_archives WHERE wipe_id=? AND revision<? ${sourceFilter} ORDER BY revision DESC LIMIT 51`).all(wipeId, before, ...(sourceId ? [sourceId] : []));
    return {
      items: rows.slice(0, 50),
      nextBefore: rows.length > 50 ? rows[49].revision : null
    };
  }
  archiveRoster(input, wipeId, revision, query = {}) {
    const a = this.actor(input);
    this.wipe(a, wipeId);
    this.hidden(a, wipeId);
    const archive = this.repo.archive(wipeId, Number(revision));
    need(archive, 'RESOURCE_NOT_FOUND', 404);
    const rows = archive.roster || archive.legacyRaw?.participantsSnapshot || [];
    const allowed = rows.filter(r => can(a, 'signups.read', {
      kind: 'signup',
      wipeId,
      memberId: r.memberId
    }, this.identity.relations()));
    const after = text(query.after);
    const selected = allowed.filter(r => r.memberId > after).sort((a, b) => a.memberId.localeCompare(b.memberId));
    return {
      items: selected.slice(0, 50).map(r => ({
        memberId: r.memberId,
        displayName: can(a, 'members.read', {
          kind: 'member',
          id: r.memberId
        }, this.identity.relations()) ? text(r.displayName || r.member?.displayName, 120) : '',
        response: r.response ?? r.status ?? null,
        expectedArrivalAt: stamp(r.expectedArrivalAt),
        signupRevision: r.signupRevision ?? null,
        squadName: text(r.squadName, 120)
      })),
      nextAfter: selected.length > 50 ? selected[49].memberId : null,
      countScope: 'authorized_snapshot_participants'
    };
  }
  audit(input, wipeId, query = {}) {
    const a = this.actor(input);
    this.wipe(a, wipeId);
    need(this.authorizeWrite(a, 'history.visibility', {
      kind: 'wipe',
      id: wipeId
    }) === true || can(a, 'wipes.archive', {
      kind: 'wipe',
      id: wipeId
    }, this.identity.relations()), 'ACCESS_DENIED', 403);
    const before = Number(query.before || Number.MAX_SAFE_INTEGER);
    need(Number.isSafeInteger(before) && before > 0, 'INVALID_CURSOR');
    const rows = this.repo.db.prepare('SELECT id,action,reason,created_at occurredAt FROM v2_stats_audit WHERE wipe_id=? AND id<? ORDER BY id DESC LIMIT 51').all(wipeId, before);
    return {
      items: rows.slice(0, 50),
      nextBefore: rows.length > 50 ? rows[49].id : null
    };
  }
  interval(input, body) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    this.hidden(a, w.id);
    authorize(a, 'stats.read', {
      kind: 'stat',
      wipeId: w.id,
      memberId: body.memberId
    }, this.identity.relations());
    need(stamp(body.from) && stamp(body.to) && Date.parse(body.from) < Date.parse(body.to), 'INVALID_TIME_RANGE');
    const rows = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaSnapshots' AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? AND COALESCE(json_extract(payload_json,'$.sourceId'),json_extract(payload_json,'$.source'),'legacy_unknown')=? AND json_extract(payload_json,'$.capturedAt')>=? AND json_extract(payload_json,'$.capturedAt')<=? ORDER BY json_extract(payload_json,'$.capturedAt'),id LIMIT 1001").all(w.id, body.memberId, text(body.sourceId), stamp(body.from), stamp(body.to));
    need(rows.length >= 2 && rows.length <= 1000, 'INTERVAL_INSUFFICIENT_DATA', 409);
    const normalized = rows.map(r => normalizeRow(JSON.parse(r.payload_json), {
      wipeId: w.id,
      serverId: w.serverProfileId
    }, this.now()));
    const item = intervalDelta(normalized[0], normalized.at(-1));
    if (!can(a, 'members.read', { kind: 'member', id: body.memberId }, this.identity.relations())) item.avatarUrl = '';
    return {
      item,
      from: normalized[0].capturedAt,
      to: normalized.at(-1).capturedAt
    };
  }
  async sync(input, body, id) {
    const a = this.actor(input),
      w = this.wipe(a, body.wipeId);
    need(body.sourceId === 'vital' && this.supportsVitalStats(w), 'SOURCE_WIPE_MISMATCH', 422);
    this.writeAllowed(a, 'stats.sync', w.id);
    authorize(a, 'sync.run', {
      kind: 'wipe',
      id: w.id
    }, this.identity.relations());
    need(this.enqueueSync, 'SYNC_ADAPTER_REQUIRED', 503);
    need(body.sourceId && id, 'STATS_CONTEXT_REQUIRED');
    return this.enqueueSync({
      actor: a,
      kind: 'kda',
      wipeId: w.id,
      sourceId: text(body.sourceId),
      operationId: id,
      expectedRevision: body.expectedRevision
    });
  }
  memberQuery(steamId, { actor: input }) {
    const a = this.actor(input);
    need(steamIdValid(steamId), 'VANITY_RESOLVER_REQUIRED', 503);
    this.queryAuth(a, { sourceId: 'member', steamInput: steamId });
    const rows = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? ORDER BY id LIMIT 2").all(steamId);
    const member = rows.length === 1 ? JSON.parse(rows[0].payload_json) : null;
    const relations = this.identity.relations(), resource = { kind: 'member', id: member?.id, querySourceId: 'member' };
    if (!member || explicitlyDenied(a, 'members.read', resource, relations)) return projectMemberQuery({ steamId }, this.now());
    const dto = memberDTO(member), publicMember = { steamId, displayName: dto.displayName, avatar: dto.avatar };
    const memberships = relations.squadMembers.filter(sm => sm.memberId === member.id && !sm.validTo);
    const squad = memberships.map(sm => this.repo.get('squads', sm.squadId)).find(s => s && !s.archivedAt &&
      can(a, 'squads.read', { kind: 'squad', id: s.id }, relations));
    if (squad) publicMember.squad = { id: squad.id, name: squad.name };
    const wipe = relations.wipes.filter(w => w.lifecycle === 'active').find(w =>
      can(a, 'wipes.read', { kind: 'wipe', id: w.id }, relations) &&
      can(a, 'signups.read', { kind: 'member', id: member.id, wipeId: w.id }, relations));
    if (wipe) {
      const signup = this.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='v2Signups' AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.memberId')=? ORDER BY id LIMIT 1").get(wipe.id, member.id);
      publicMember.currentWipe = { id: wipe.id, title: wipe.title, response: signup ? JSON.parse(signup.payload_json).response : null };
    }
    if (can(a, 'members.read', resource, relations)) publicMember.details = {
      membershipStatus: dto.membershipStatus, specialty: dto.specialty
    };
    return projectMemberQuery({ steamId, publicMember }, this.now());
  }
  queryCapabilities(input, { steamInput } = {}) {
    const a = this.actor(input), parsed = steamInput ? parseSteamInput(steamInput) : null;
    const member = parsed?.steamId && this.repo.db.prepare("SELECT id FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? ORDER BY id LIMIT 1").get(parsed.steamId);
    const relations = this.identity.relations();
    const resource = source => ({ kind: member ? 'member' : 'query', id: member?.id || source, querySourceId: source });
    return { permissionVersion: a.permissionVersion,
      sources: querySources.map(sourceId => {
        const [read, run] = sourceId === 'inventory' ? ['inventory.read', 'inventory.query'] : ['queries.read', 'queries.run'];
        return { sourceId, read: can(a, read, resource(sourceId), relations), run: can(a, run, resource(sourceId), relations),
          requiresSubject: !parsed?.steamId };
      }),
      catalogs: ['vital', 'moose'].map(provider => ({ provider,
        read: can(a, 'queries.read', { kind: 'query', id: 'catalog', querySourceId: provider }, relations) })) };
  }
  queryAuth(a, body) {
    need(['official', 'vital', 'moose', 'inventory', 'member', 'catalog'].includes(body.sourceId), 'INVALID_SOURCE');
    if (body.sourceId === 'catalog') need(body.provider === undefined || ['vital', 'moose'].includes(body.provider), 'INVALID_SOURCE');
    const querySourceId = body.sourceId === 'catalog' ? body.provider || 'vital' : body.sourceId;
    const inventory = body.sourceId === 'inventory';
    const parsed = body.sourceId !== 'catalog' && body.steamInput ? parseSteamInput(body.steamInput) : null;
    const member = parsed?.steamId && this.repo.db.prepare("SELECT id FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? LIMIT 1").get(parsed.steamId);
    const resource = member ? {
      kind: 'member',
      id: member.id
    } : {
      kind: 'query',
      id: body.sourceId
    };
    resource.querySourceId = querySourceId;
    if (body.sourceId !== 'catalog') authorize(a, inventory ? 'inventory.query' : 'queries.run', resource, this.identity.relations());
    authorize(a, inventory ? 'inventory.read' : 'queries.read', resource, this.identity.relations());
    return {
      parsed,
      memberId: member?.id || null
    };
  }
  resolvedQueryAuth(a, body, result) {
    if (body.sourceId === 'catalog') return null;
    const parsed = parseSteamInput(body.steamInput);
    const steamId = parsed.steamId || result?.steamId;
    need(steamIdValid(steamId), 'VANITY_RESOLVER_REQUIRED', 503);
    need(!parsed.steamId || !result?.steamId || parsed.steamId === result.steamId, 'QUERY_SUBJECT_MISMATCH', 409);
    this.queryAuth(a, { ...body, steamInput: steamId });
    return steamId;
  }
  createJob(input, kind, body, id) {
    const a = this.actor(input);
    need(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST');
    need(['query', 'export'].includes(kind), 'INVALID_JOB_KIND');
    if (kind === 'query') {
      need(['official', 'vital', 'moose', 'inventory', 'member', 'catalog'].includes(body.sourceId), 'INVALID_SOURCE');
      this.queryAuth(a, body);
      if (body.sourceId !== 'catalog') parseSteamInput(body.steamInput);
      if (['vital', 'moose'].includes(body.sourceId)) need(text(body.serverId) && text(body.providerWipeId), 'SOURCE_CONTEXT_REQUIRED');
      need(!body.categoryIds || Array.isArray(body.categoryIds) && body.categoryIds.length <= 20 && body.categoryIds.every(v => typeof v === 'string' && v.length <= 80), 'INVALID_CATEGORIES');
      need(JSON.stringify(body).length < 12000, 'QUERY_TOO_LARGE');
    } else {
      if (body.queryJobId) {
        const source = this.readJob(a, body.queryJobId);
        need(source.kind === 'query' && source.status === 'succeeded', 'QUERY_NOT_READY', 409);
      } else {
        const w = this.wipe(a, body.wipeId);
        this.hidden(a, w.id);
        need(this.canExport(a, w.id), 'ACCESS_DENIED', 403);
      }
      need(['csv', 'html', 'pdf', 'png', 'json'].includes(body.format), 'INVALID_EXPORT_FORMAT');
      need(body.ranking === undefined || body.ranking === 'all' || Boolean(leaderboardById(body.ranking)), 'INVALID_RANKING');
      need(['zh', 'en', 'ru', 'tr', 'th', 'ko'].includes(body.language || 'zh'), 'INVALID_LANGUAGE');
      try {
        new Intl.DateTimeFormat('en', {
          timeZone: body.timeZone || 'Asia/Shanghai'
        });
      } catch {
        need(false, 'INVALID_TIME_ZONE');
      }
    }
    return this.receipt(a, id, `stats.${kind}`, body, () => {
      need(this.repo.db.prepare("SELECT COUNT(*) n FROM v2_stats_jobs WHERE account_id=? AND status IN ('queued','running')").get(a.id).n < 5, 'JOB_LIMIT', 429);
      const jobId = randomUUID();
      this.repo.db.prepare('INSERT INTO v2_stats_jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(jobId, a.id, a.permissionVersion, this.scope(a), kind, 'queued', 0, this.now() + 3600000, JSON.stringify(body), null);
      return {
        jobId,
        status: 'queued'
      };
    });
  }
  readJob(input, id) {
    const a = this.actor(input),
      job = this.repo.job(id);
    need(job && job.account_id === a.id, 'RESOURCE_NOT_FOUND', 404);
    need(job.permission_version === a.permissionVersion && job.scope_digest === this.scope(a), 'PERMISSIONS_CHANGED', 401);
    need(job.expires_at > this.now(), 'QUERY_EXPIRED', 410);
    if (job.kind === 'query') this.queryAuth(a, job.payload);else if (job.payload.queryJobId) {
      const source = this.readJob(a, job.payload.queryJobId);
      need(source.kind === 'query' && source.status === 'succeeded', 'QUERY_NOT_READY', 409);
    } else {
      this.wipe(a, job.payload.wipeId);
      this.hidden(a, job.payload.wipeId);
      // Scope digest is pinned at enqueue and rechecked above, including current membership relations.
    }
    let result = job.result;
    if (job.kind === 'query' && job.status === 'succeeded') this.resolvedQueryAuth(a, job.payload, result);
    if (job.kind === 'query' && job.payload.sourceId === 'member') {
      if (job.status === 'succeeded') {
        const parsed = parseSteamInput(job.payload.steamInput);
        const steamId = parsed.steamId || result?.steamId;
        const safe = this.memberQuery(steamId, { actor: a });
        result = { ...safe, fetchedAt: stamp(result?.fetchedAt) || new Date(job.expires_at - 3600000).toISOString() };
      } else result = job.status === 'failed' ? {
        errorCode: result?.errorCode === 'VANITY_RESOLVER_REQUIRED' ? 'VANITY_RESOLVER_REQUIRED' : 'MEMBER_QUERY_UNAVAILABLE',
        retryable: false
      } : null;
    }
    if (job.kind === 'export' && job.payload.queryJobId && job.status === 'succeeded') {
      const source = this.readJob(a, job.payload.queryJobId);
      if (source.result?.sourceId === 'member') need(result?.queryProjectionVersion === MEMBER_QUERY_PROJECTION_VERSION &&
        result.queryProjectionHash === hash(source.result), 'QUERY_EXPORT_REGENERATE_REQUIRED', 409);
    }
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      expiresAt: new Date(job.expires_at).toISOString(),
      result
    };
  }
  async runJob(id) {
    let job = this.repo.job(id);
    if (!job || job.status !== 'queued') return false;
    let a;
    try {
      a = this.identity.actorForAccount(job.account_id);
      this.readJob(a, id);
    } catch {
      this.repo.db.prepare("UPDATE v2_stats_jobs SET status='failed',epoch=epoch+1,result=? WHERE id=? AND status='queued'").run(JSON.stringify({
        errorCode: 'AUTHORIZATION_REVOKED_OR_EXPIRED',
        retryable: false
      }), id);
      return true;
    }
    const epoch = job.epoch + 1;
    const claimed = this.repo.db.prepare("UPDATE v2_stats_jobs SET status='running',epoch=? WHERE id=? AND status='queued' AND epoch=?").run(epoch, id, job.epoch);
    if (!claimed.changes) return false;
    let result,
      status = 'succeeded';
    try {
      if (job.kind === 'query') {
        const adapter = this.providers[job.payload.sourceId] || (job.payload.sourceId === 'member' ? (input, options) => this.memberQuery(input.steamId, options) : null);
        need(adapter, 'SOURCE_UNAVAILABLE', 503);
        const context = this.queryAuth(a, job.payload),
          input = {
            ...job.payload,
            ...context.parsed
          };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          result = await Promise.race([adapter(input, {
            signal: controller.signal,
            actor: a
          }), new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('SOURCE_TIMEOUT')), {
            once: true
          }))]);
        } finally {
          clearTimeout(timer);
        }
        need(JSON.stringify(result).length <= 250000, 'SOURCE_RESULT_TOO_LARGE', 503);
        // A vanity link resolves inside the provider. Recheck that actual
        // subject before persisting anything, then on every result/export read.
        const resolvedSteamId = this.resolvedQueryAuth(a, job.payload, result);
        if (job.payload.sourceId === 'member') {
          result = this.memberQuery(resolvedSteamId, { actor: a });
        }
        result = projectQuery(result, job.payload.sourceId, this.now());
      } else {
        let data;
        if (job.payload.queryJobId) {
          const source = this.readJob(a, job.payload.queryJobId);
          data = {
            wipe: {
              id: 'query-' + source.id,
              title: '独立查询结果',
              serverId: source.result.serverId || null,
              providerWipeId: source.result.providerWipeId || null
            },
            sourceId: source.result.sourceId,
            metricVersion: 'nb-kda-1',
            revision: 0,
            countScope: 'account_private_query',
            dataRevision: hash(source.result),
            items: source.result.rows || [],
            queryResult: source.result
          };
        } else data = this.repo.transaction(() => {
          const result = this.collect(a, {
            ...job.payload,
            exporting: true
          });
          need(!job.payload.expectedDataRevision || job.payload.expectedDataRevision === result.dataRevision, 'REVISION_CONFLICT', 409);
          if (job.payload.from || job.payload.to) {
            result.items = result.items.map(row => {
              try {
                const delta = this.interval(a, {
                  ...job.payload,
                  memberId: row.memberId
                }).item;
                return {
                  ...delta,
                  displayName: row.displayName,
                  squadName: row.squadName
                };
              } catch (e) {
                if (!['INTERVAL_INSUFFICIENT_DATA', 'INTERVAL_REVISION_INVALID', 'INTERVAL_SCOPE_MISMATCH'].includes(e.errorCode)) throw e;
                return {
                  ...row,
                  values: Object.fromEntries(Object.keys(row.values).map(k => [k, null])),
                  status: 'unavailable',
                  coverage: e.errorCode
                };
              }
            });
            result.timeRange = {
              from: job.payload.from,
              to: job.payload.to
            };
          }
          return result;
        });
        need(this.renderExport, 'EXPORT_RENDERER_REQUIRED', 503);
        result = await this.renderExport(data, job.payload);
        if (data.queryResult?.sourceId === 'member') result = { ...result,
          queryProjectionVersion: MEMBER_QUERY_PROJECTION_VERSION, queryProjectionHash: hash(data.queryResult) };
        if (data.queryResult?.sourceId === 'member') {
          const source = this.readJob(a, job.payload.queryJobId);
          need(hash(source.result) === result.queryProjectionHash, 'QUERY_EXPORT_REGENERATE_REQUIRED', 409);
        }
      }
    } catch (e) {
      status = 'failed';
      result = {
        errorCode: e.errorCode || 'SOURCE_UNAVAILABLE',
        retryable: true,
        ...(e.errorCode === 'RATE_LIMITED' ? {
          retryAfterMs: Math.min(3600000, Math.max(1000, Number(e.retryAfterMs) || 60000)),
          retryAfterKnown: e.retryAfterKnown === true,
          ...(e.retryAfterKnown === true ? { retryAt: new Date(this.now() + Math.min(3600000, Math.max(1000, Number(e.retryAfterMs) || 60000))).toISOString() } : {}),
          ...(['community','store','scmm','rusthelp'].includes(e.sourceId) ? { sourceId: e.sourceId } : {})
        } : {})
      };
    }
    // Late provider or renderer completion cannot bypass revocation, expiry, or an execution generation.
    try {
      this.readJob(a, id);
    } catch {
      status = 'failed';
      result = {
        errorCode: 'AUTHORIZATION_REVOKED',
        retryable: false
      };
    }
    this.repo.db.prepare("UPDATE v2_stats_jobs SET status=?,result=? WHERE id=? AND status='running' AND epoch=?").run(status, JSON.stringify(result), id, epoch);
    return true;
  }
  recoverJobs() {
    return this.repo.db.prepare("UPDATE v2_stats_jobs SET status='failed',epoch=epoch+1,result=? WHERE status='running'").run(JSON.stringify({
      errorCode: 'EXECUTION_INTERRUPTED',
      retryable: true
    })).changes;
  }
}
export function projectQuery(raw = {}, sourceId, now) {
  if (sourceId === 'member') return projectMemberQuery(raw, now);
  const allowed = ['fresh', 'stale', 'unavailable', 'unsupported', 'private', 'partial'];
  const result = {
    sourceId,
    fetchedAt: stamp(raw.fetchedAt) || new Date(now).toISOString(),
    status: allowed.includes(raw.status) ? raw.status : 'fresh',
    steamId: /^7656119\d{10}$/.test(raw.steamId) ? raw.steamId : null,
    displayName: text(raw.displayName, 120),
    ...(['vital', 'moose'].includes(sourceId) ? { serverId: text(raw.serverId), providerWipeId: text(raw.providerWipeId) } : {}),
    errors: (raw.errors || []).slice(0, 10).map(e => ({
      sourceId: text(e.sourceId),
      errorCode: text(e.errorCode),
      ...(e.errorCode === 'RATE_LIMITED' && e.retryAfterKnown === true ? {
        retryAfterKnown: true,
        retryAt: new Date(now + Math.min(3600000, Math.max(1000, Number(e.retryAfterMs) || 60000))).toISOString()
      } : {})
    }))
  };
  if (sourceId === 'official' || sourceId === 'inventory') result.steamProfile = {
    avatar: publicAvatar(raw.steamProfile?.avatar),
    createdAt: stamp(raw.steamProfile?.createdAt),
    ...(sourceId === 'inventory' ? { playtimeMinutes: typeof raw.steamProfile?.playtimeMinutes === 'number' && Number.isFinite(raw.steamProfile.playtimeMinutes) && raw.steamProfile.playtimeMinutes >= 0 ? raw.steamProfile.playtimeMinutes : null } : {})
  };
  if (sourceId === 'inventory') result.inventory = {
    status: text(raw.inventory?.status) || result.status,
    currency: text(raw.inventory?.currency, 10) || null,
    total: typeof raw.inventory?.total === 'number' ? raw.inventory.total : null,
    items: (raw.inventory?.items || []).slice(0, 2000).map(i => ({
      name: text(i.name, 120),
      quantity: Number.isFinite(i.quantity) ? i.quantity : null,
      price: Number.isFinite(i.price) ? i.price : null,
      tradable: typeof i.tradable === 'boolean' ? i.tradable : null,
      category: text(i.category),
      dlc: typeof i.dlc === 'boolean' ? i.dlc : null
    })),
    truncated: (raw.inventory?.items?.length || 0) > 2000
  };else if (sourceId === 'catalog') result.items = (raw.items || []).slice(0, 200).map(i => ({
    id: text(i.id),
    name: text(i.name, 120),
    serverId: text(i.serverId),
    providerWipeId: text(i.providerWipeId),
    category: text(i.category),
    ...(i.startTime !== undefined || i.endTime !== undefined || i.state !== undefined ? {
      startTime: stamp(i.startTime), endTime: stamp(i.endTime),
      state: ['current', 'archived', 'unknown'].includes(i.state) ? i.state : 'unknown'
    } : {})
  }));else {
    result.rows = (raw.rows || []).slice(0, 100).map(r => normalizeRow(r, {
      sourceId,
      serverId: raw.serverId,
      providerWipeId: raw.providerWipeId
    }, now));
    result.fields = (raw.fields || []).slice(0, 200).map(f => ({
      name: text(f.name, 120),
      value: f.value == null ? null : typeof f.value === 'number' ? f.value : text(f.value, 300),
      status: text(f.status) || 'observed'
    }));
    if (sourceId === 'vital') result.categories = projectStatCategories(raw.categories);
  }
  return finalizeProviderQuery(raw, result, sourceId, now);
}
