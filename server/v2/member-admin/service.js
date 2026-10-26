import { normalizeSpecialties as projectSpecialties } from '../../../shared/member-preferences.js';
import { riskScanDTO, riskFieldEvidence } from './risk-scan.js';
import { randomUUID } from 'node:crypto';
import { can, authorize, accountRole } from '../identity/permissions.js';
import { legacyBlocked, platformAliases } from '../identity/migration.js';
import { MemberAdminRepository, hash, requireValue, fail } from './repository.js';
import { specialties, normalizeSpecialties, specialtyQueryValues, memberFields, steamId, text, statusOf, membershipOf, csvCell } from './model.js';
import { riskEvidence, defaultRules, validateRules } from './risk.js';
import { currentDepartureAudits, departureCandidatePredicate, scanDepartureRoles } from './departure-audit.js';
const id = prefix => `${prefix}_${randomUUID()}`;
const actionReason = (value, fallback) => value === undefined || typeof value === 'string' && !value.trim() ? fallback : text(value, 500, true);
const revision = row => row?.revision || 1;
const capFor = kind => kind === 'squad' ? 'squads.read' : kind === 'risk' ? 'risks.read' : 'members.read';
export class MemberAdminService {
  constructor(identity, adapters = {}) {
    this.identity = identity;
    this.repo = new MemberAdminRepository(identity.repo.db);
    this.adapters = adapters;
    this.now = identity.now || Date.now;
  }
  fresh(actor) {
    const next = this.identity.actorForAccount(actor.id);
    requireValue(next.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    return next;
  }
  auth(actor, cap, kind = 'member', resourceId = '__collection__') {
    authorize(actor, cap, {
      kind,
      id: resourceId
    }, this.repo.relations());
  }
  allowed(actor, cap, kind, resourceId) {
    return can(actor, cap, {
      kind,
      id: resourceId
    }, this.repo.relations());
  }
  global(actor, cap) {
    this.auth(actor, cap, 'account', '__collection__');
  }
  member(actor, memberId, cap = 'members.read') {
    this.auth(actor, cap, 'member', memberId);
    const m = this.repo.get('members', memberId);
    requireValue(m && !m.deletedAt, 'RESOURCE_NOT_FOUND', 404);
    return m;
  }
  squad(actor, squadId, cap = 'squads.read') {
    this.auth(actor, cap, 'squad', squadId);
    const s = this.repo.get('squads', squadId);
    requireValue(s, 'RESOURCE_NOT_FOUND', 404);
    return s;
  }
  assertManageableIdentity(actor, memberId, { allowSelfUnlink = false } = {}) {
    const accounts = this.identity.repo.all('accounts').filter(account => account.memberId === memberId);
    requireValue(accounts.every(account => {
      if (allowSelfUnlink && account.id === actor.id && actor.memberId === memberId) return true;
      const role = accountRole(this.identity.repo, account);
      return role !== 'owner' && (actor.roleId === 'owner' || role !== 'admin');
    }), 'PROTECTED_ACCOUNT', 403);
  }
  checkRevision(row, expected) {
    requireValue(expected === revision(row), 'REVISION_CONFLICT', 409, {
      current: {
        id: row.id,
        revision: revision(row)
      }
    });
  }
  stamp() {
    return new Date(this.now()).toISOString();
  }
  options(actor) {
    actor = this.fresh(actor);
    return {
      specialties,
      statuses: ['active', 'suspended', 'left', 'blocked'],
      permissions: {
        create: this.allowed(actor, 'members.basic_edit', 'account', '__collection__'),
        createSquad: this.allowed(actor, 'squads.manage', 'account', '__collection__'),
        rules: this.allowed(actor, 'risks.manage', 'account', '__collection__') && this.allowed(actor, 'system.permissions', 'account', '__collection__') && this.adapters.isTrustedRoot?.(actor) === true
      },
      adapters: {
        sync: Boolean(this.adapters.sync),
        unlink: Boolean(this.adapters.unlinkIdentity)
      },
      revision: this.repo.revision()
    };
  }
  page(actor, kind, query, collection, predicate, project) {
    const limit = query.limit === undefined ? 30 : Number(query.limit);
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_PAGE');
    const normalized = {
      ...query
    };
    delete normalized.cursor;
    delete normalized.limit;
    const scopeHash = hash([actor.id, actor.permissionVersion, actor.grants, actor.memberId, this.repo.relations()]);
    const filterHash = hash([kind, normalized]);
    let after = '';
    if (query.cursor) {
      try {
        const c = JSON.parse(Buffer.from(text(query.cursor, 3000), 'base64url').toString());
        requireValue(c.v === 1 && c.scope === scopeHash && c.filter === filterHash && c.revision === this.repo.revision() && typeof c.after === 'string', 'CURSOR_EXPIRED', 409);
        after = c.after;
      } catch (error) {
        if (error.errorCode) throw error;
        fail('CURSOR_EXPIRED', 409);
      }
    }
    const result = this.repo.list(collection, predicate, {
      after,
      limit
    });
    return {
      items: result.rows.map(project),
      total: result.total,
      limit,
      nextCursor: result.hasMore ? Buffer.from(JSON.stringify({
        v: 1,
        scope: scopeHash,
        filter: filterHash,
        revision: this.repo.revision(),
        after: result.rows.at(-1).id
      })).toString('base64url') : null,
      revision: this.repo.revision(),
      countScope: 'authorized_resources'
    };
  }
  memberDTO(actor, m, detail = false) {
    const privateRead = this.allowed(actor, 'members.basic_edit', 'member', m.id) || this.allowed(actor, 'members.review', 'member', m.id);
    const current = this.repo.currentSquad(m.id);
    const squad = current[0] && this.repo.get('squads', current[0].squadId);
    let specialty;
    try {
      specialty = projectSpecialties(m.specialty || m.specialties || []);
    } catch {
      specialty = [];
    }
    const storedAvatar = m.avatar || m.steamAvatar || m.avatarUrl;
    // Older syncs saved the Steam avatar only in memberProfiles.
    const cachedProfile = !storedAvatar && m.steamId ? this.repo.find('memberProfiles', 'steamId', m.steamId, 2)
      .find(p => p.steamId === m.steamId && (!p.memberId || p.memberId === m.id)) : null;
    const out = {
      id: m.id,
      displayName: m.customName || m.steamNickname || m.displayName || m.steamId,
      steamId: m.steamId,
      avatar: storedAvatar || cachedProfile?.avatar || '',
      specialty,
      memberStatus: statusOf(m),
      deletedAt: m.deletedAt || null,
      revision: revision(m),
      squadId: squad?.id || null,
      squadName: squad?.name || '未分队',
      updatedAt: m.updatedAt || m.createdAt || null,
      source: 'members',
      canEdit: this.allowed(actor, 'members.basic_edit', 'member', m.id),
      canDelete: Boolean(this.adapters.deleteIdentity) && this.allowed(actor, 'members.basic_edit', 'account', '__collection__') && ['members.basic_edit','members.change_status','members.review','system.accounts'].every(cap => this.allowed(actor, cap, 'member', m.id)),
      canChangeStatus: this.allowed(actor, 'members.change_status', 'member', m.id),
      canManageSquad: this.allowed(actor, 'squads.manage', 'member', m.id),
      canRiskManage: this.allowed(actor, 'risks.manage', 'member', m.id),
      canUnlink: this.allowed(actor, 'members.review', 'member', m.id) && this.allowed(actor, 'system.accounts', 'member', m.id)
    };
    if (privateRead) for (const prefix of ['atlas']) for (const suffix of ['Type', 'PurchasedAt', 'ExpiresAt']) out[prefix + 'Vip' + suffix] = m[prefix + 'Vip' + suffix] || (suffix === 'Type' ? 'none' : '');
    if (privateRead) Object.assign(out, {
      vitalVipType: m.vitalVipType || 'none',
      vitalVipPurchasedAt: m.vitalVipPurchasedAt || '',
      vitalVipExpiresAt: m.vitalVipExpiresAt || ''
    });
    if (privateRead) {
      const user = m.invitedByUserId && this.repo.get('users', m.invitedByUserId);
      out.inviterName = m.invitedByName || m.inviterName || user?.username || m.invitedByUserId || '';
      if (m.discordSteamDeclaration?.ownershipVerified === false && /^\d{17}$/.test(m.discordSteamDeclaration.steamId || '')) out.declaredSteamId = m.discordSteamDeclaration.steamId;
      out.bindingStatus = this.repo.find('v2SteamBindings', 'memberId', m.id).some(b => b.status === 'verified') ? 'verified' : 'legacy_unverified';
    }
    if (this.allowed(actor, 'stats.read', 'member', m.id)) {
      const p = this.repo.find('memberProfiles', 'memberId', m.id, 2)[0];
      const seconds = p?.battlemetricsWeeklyPlayTimeSeconds;
      out.recentActivity = {
        minutes: seconds !== undefined && seconds !== null && Number.isFinite(Number(seconds)) ? Math.round(Number(seconds) / 60) : null,
        observedAt: p?.battlemetricsSyncedAt || null,
        source: 'BattleMetrics',
        freshness: !p?.battlemetricsSyncedAt ? 'unknown' : this.now() - Date.parse(p.battlemetricsSyncedAt) > 86400000 ? 'stale' : 'fresh'
      };
    }
    if (this.allowed(actor, 'risks.read', 'member', m.id)) out.riskSummary = {
      count: this.risksFor(actor, m).filter(e => e.state !== 'done' && !e.suppressed).length
    };
    if (detail && privateRead) for (const key of ['customName', 'discordId', 'discordName', 'wechatId', 'wechatUserId', 'phone', 'notes', 'region', 'timezone', 'battlemetricsId']) out[key] = (key === 'timezone' ? m.timeZone || m.timezone : m[key]) || '';
    if (detail && privateRead) {
      const accounts = this.repo.find('v2Accounts', 'memberId', m.id);
      const identities = accounts.flatMap(account => this.repo.find('v2Identities', 'accountId', account.id));
      const users = accounts.map(account => account.legacyUserId && this.repo.get('users', account.legacyUserId)).filter(Boolean);
      const wechatAliases = [m.wechatId, m.wechatUserId, ...users.flatMap(user => [user.wechatId, user.wechatUserId])].filter(Boolean);
      const wechatRecord = this.repo.find('wechatUsers', 'memberId', m.id)[0] ||
        wechatAliases.map(value => this.repo.get('wechatUsers', value))
          .find(row => row && (!row.memberId || row.memberId === m.id));
      out.platformBindings = ['discord', 'kook', 'wechat'].map(provider => {
        const aliases = provider === 'wechat' ? wechatAliases :
          [m, ...users].flatMap(record => platformAliases(record, provider));
        const recordedId = aliases.find(value => typeof value === 'string' && value.trim()) || null;
        const linked = identities.filter(row => provider === 'wechat' ? row.provider === 'wechat' || row.provider?.startsWith('wechat:') : row.provider === provider)
          .sort((a, b) => Number(Boolean(b.verifiedAt)) - Number(Boolean(a.verifiedAt)) || String(b.verifiedAt || '').localeCompare(String(a.verifiedAt || '')))[0];
        const displayName = provider === 'discord' ? m.discordName : provider === 'kook' ? m.kookName : wechatRecord?.nickname;
        return {
          provider,
          status: linked ? linked.verifiedAt ? 'verified' : 'historical' : wechatRecord && provider === 'wechat' ? 'historical' : recordedId ? 'record_only' : 'unlinked',
          externalId: linked?.externalId || null,
          recordedId: linked ? null : recordedId || (provider === 'wechat' ? wechatRecord?.id : null),
          displayName: displayName && (provider === 'wechat' || !linked || aliases.includes(linked.externalId)) ? displayName : '',
          verifiedAt: linked?.verifiedAt || null,
          canUnlink: provider === 'wechat' ? Boolean(wechatRecord || !linked && recordedId) : Boolean(linked || recordedId)
        };
      });
    }
    if (detail && this.allowed(actor, 'risks.read', 'member', m.id)) { out.risks = this.risksFor(actor, m); out.riskScan = riskScanDTO(this.riskProfile(m), m); }
    if (privateRead || out.canChangeStatus) out.platformAudit = Object.fromEntries(['Status', 'CheckedAt', 'MissingSince', 'LastOkAt', 'LastFailureAt', 'Error', 'GuildId', 'ExpectedRoleIds', 'ActualRoleIds', 'ExpectedRoleNames', 'ActualRoleNames'].map(suffix => [suffix[0].toLowerCase() + suffix.slice(1), m['discordMembership' + suffix] ?? null]));
    if (detail) out.identity = {
      steamBinding: this.repo.find('v2SteamBindings', 'memberId', m.id).some(b => b.status === 'verified') ? 'verified' : 'legacy_unverified',
      restrictionPresent: this.repo.find('v2AccessRestrictions', 'memberId', m.id).some(r => !r.endsAt || Date.parse(r.endsAt) > this.now())
    };
    return out;
  }
  members(actor, query = {}) {
    actor = this.fresh(actor);
    // One synchronous list projection; no cached relations escape this call.
    const view = Object.create(this), repo = Object.create(this.repo);
    const relations = this.repo.relations();
    repo.relations = () => relations;
    view.repo = repo;
    for (const method of ['get','find','currentSquad']) {
      const values = new Map();
      repo[method] = (...args) => { const key = JSON.stringify(args); if (!values.has(key)) values.set(key,this.repo[method](...args)); return values.get(key); };
    }
    let settings;
    view.riskSettings = () => settings ||= this.riskSettings();
    return view.readMembers(actor, query);
  }
  readMembers(actor, query = {}) {
    actor = this.fresh(actor);
    const p = this.repo.scope(actor, 'members.read');
    const clauses = [p.text],
      args = [...p.args];
    if (query.departure === '1') {
      const access = this.repo.scope(actor, 'members.change_status');
      const review = this.repo.scope(actor, 'members.review');
      clauses.push(`(${access.text} OR ${review.text})`);
      args.push(...access.args, ...review.args);
      if (query.auditStatus) requireValue(['not_in_guild', 'missing_role'].includes(query.auditStatus), 'INVALID_AUDIT_STATUS');
      clauses.push("COALESCE(json_extract(r.payload_json,'$.memberStatus'),CASE json_extract(r.payload_json,'$.membershipStatus') WHEN 'paused' THEN 'suspended' WHEN 'departed' THEN 'left' ELSE 'active' END)='active'");
      clauses.push(departureCandidatePredicate(query.auditStatus));
    }
    if (query.auditStatus && query.departure !== '1') {
      requireValue(['not_in_guild', 'missing_role', 'check_failed', 'valid'].includes(query.auditStatus), 'INVALID_AUDIT_STATUS');
      clauses.push("json_extract(r.payload_json,'$.discordMembershipStatus')=?");
      args.push(query.auditStatus);
    }
    if (query.q) {
      const q = text(query.q, 120);
      const edit = this.repo.scope(actor, 'members.basic_edit');
      const review = this.repo.scope(actor, 'members.review');
      const names = ['customName', 'steamNickname', 'steamId'].map(field => `instr(lower(COALESCE(json_extract(r.payload_json,'$.${field}'),'')),lower(?))>0`).join(' OR ');
      const privateFields = ['discordId', 'discordName', 'wechatId', 'notes', 'discordSteamDeclaration.steamId'];
      const privateMatch = privateFields.map(field => `instr(lower(COALESCE(json_extract(r.payload_json,'$.${field}'),'')),lower(?))>0`).join(' OR ');
      const squadMatch = `EXISTS(SELECT 1 FROM json_records sm JOIN json_records sq ON sq.collection='squads' AND sq.id=json_extract(sm.payload_json,'$.squadId') WHERE sm.collection='squadMembers' AND json_extract(sm.payload_json,'$.memberId')=r.id AND COALESCE(json_extract(sm.payload_json,'$.validTo'),'')='' AND instr(lower(json_extract(sq.payload_json,'$.name')),lower(?))>0)`;
      clauses.push(`(${names} OR ${squadMatch} OR ((${edit.text} OR ${review.text}) AND (${privateMatch})))`);
      args.push(q, q, q, q, ...edit.args, ...review.args, ...privateFields.map(() => q));
    }
    if (query.status) {
      requireValue(['active', 'suspended', 'left', 'blocked'].includes(query.status), 'INVALID_STATUS');
      clauses.push("COALESCE(json_extract(r.payload_json,'$.memberStatus'),CASE json_extract(r.payload_json,'$.membershipStatus') WHEN 'paused' THEN 'suspended' WHEN 'departed' THEN 'left' ELSE 'active' END)=?");
      args.push(query.status);
    }
    clauses.push("COALESCE(json_extract(r.payload_json,'$.deletedAt'),'')=''");
    if (query.squadId) {
      clauses.push(`${query.squadId === '__unassigned' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM json_records sm WHERE sm.collection='squadMembers' AND json_extract(sm.payload_json,'$.memberId')=r.id AND COALESCE(json_extract(sm.payload_json,'$.validTo'),'')='' ${query.squadId === '__unassigned' ? '' : "AND json_extract(sm.payload_json,'$.squadId')=?"})`);
      if (query.squadId !== '__unassigned') args.push(text(query.squadId));
    }
    if (query.specialty) {
      requireValue(Object.hasOwn(specialties, query.specialty), 'INVALID_SPECIALTIES');
      clauses.push("EXISTS(SELECT 1 FROM json_each(CASE json_type(r.payload_json,'$.specialty') WHEN 'array' THEN json_extract(r.payload_json,'$.specialty') ELSE json_array(json_extract(r.payload_json,'$.specialty')) END) sp JOIN json_each(?) allowed ON allowed.value=sp.value)");
      args.push(JSON.stringify(specialtyQueryValues(query.specialty)));
    }
    if (query.vip) {
      requireValue(['none', 'priority', 'queue_skip'].includes(query.vip), 'INVALID_VIP_TYPE');
      clauses.push("COALESCE(json_extract(r.payload_json,'$.vitalVipType'),'none')=?");
      args.push(query.vip);
    }
    return this.page(actor, 'members', query, 'members', {
      text: clauses.join(' AND '),
      args
    }, m => {
      const dto = this.memberDTO(actor, m);
      if (query.departure === '1') dto.platformAudits = currentDepartureAudits(this.identity, this.repo, m.id);
      return dto;
    });
  }
  scanDeparture(actor, input = {}) {
    return scanDepartureRoles(this, actor, input);
  }
  detail(actor, memberId) {
    actor = this.fresh(actor);
    return this.memberDTO(actor, this.member(actor, memberId), true);
  }
  squads(actor, query = {}) {
    actor = this.fresh(actor);
    const p = this.repo.scope(actor, 'squads.read', 'squad');
    if (query.archived !== 'all') p.text += " AND COALESCE(json_extract(r.payload_json,'$.archivedAt'),'')=''";
    return this.page(actor, 'squads', query, 'squads', p, s => this.squadDTO(actor, s));
  }
  squadDTO(actor, s) {
    const manage = this.allowed(actor, 'squads.manage', 'squad', s.id);
    return {
      id: s.id,
      name: s.name,
      revision: revision(s),
      leaderUserIds: s.leaderUserIds || [s.leaderUserId].filter(Boolean),
      archivedAt: s.archivedAt || null,
      notes: manage ? s.notes || '' : undefined,
      canManage: manage
    };
  }
  leaders(actor, query = {}) {
    actor = this.fresh(actor);
    this.global(actor, 'squads.manage');
    return this.page(actor, 'leaders', query, 'v2Accounts', {
      text: "json_extract(r.payload_json,'$.status')='active'",
      args: []
    }, a => ({
      id: a.legacyUserId || a.id,
      accountId: a.id,
      name: this.repo.get('users', a.legacyUserId || a.id)?.username || a.id
    }));
  }
  audit(actor, kind, resourceId, query = {}) {
    actor = this.fresh(actor);
    requireValue(['member', 'squad'].includes(kind), 'INVALID_KIND');
    this.auth(actor, capFor(kind), kind, resourceId);
    // Before/after contact details and risk notes are never returned to plain readers.
    const privateRead = this.allowed(actor, kind === 'squad' ? 'squads.manage' : 'members.basic_edit', kind, resourceId);
    const after = Number(query.after || 0),
      limit = Number(query.limit || 30);
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_PAGE');
    const descending = Object.hasOwn(query, 'before');
    const before = query.before === '0' ? Number.MAX_SAFE_INTEGER : Number(query.before);
    if (descending) requireValue(Number.isSafeInteger(before) && before > 0, 'INVALID_PAGE');
    const rows = descending ? this.repo.historyBefore(kind, resourceId, before, limit) : this.repo.history(kind, resourceId, after, limit);
    const squadName = squadId => !squadId ? '未分队' : this.allowed(actor, 'squads.read', 'squad', squadId) ? this.repo.get('squads', squadId)?.name || '原队伍' : '其他队伍';
    const actorName = actorId => {
      if (!privateRead) return '管理员';
      const account = this.repo.get('v2Accounts', actorId);
      const user = this.repo.get('users', actorId) || account?.legacyUserId && this.repo.get('users', account.legacyUserId);
      const member = account?.memberId && this.repo.get('members', account.memberId);
      return user?.username || member?.customName || member?.displayName || '管理员';
    };
    return {
      items: rows.slice(0, limit).map(r => ({
        ...r,
        actorName: actorName(r.actorId),
        fromSquadName: r.payload.fromSquadId ? squadName(r.payload.fromSquadId) : null,
        toSquadName: r.payload.toSquadId ? squadName(r.payload.toSquadId) : null,
        memberName: r.payload.memberId && this.allowed(actor, 'members.read', 'member', r.payload.memberId) ? (() => { const member = this.repo.get('members', r.payload.memberId); return member?.customName || member?.displayName || '成员'; })() : null,
        payload: privateRead ? r.payload : {
          fromSquadId: r.payload.fromSquadId,
          toSquadId: r.payload.toSquadId,
          memberStatus: r.payload.memberStatus
        }
      })),
      nextAfter: !descending && rows.length > limit ? rows[limit - 1].seq : null,
      nextBefore: descending && rows.length > limit ? rows[limit - 1].seq : null
    };
  }
  write(actor, operationId, action, input, authorizeWrite, perform) {
    text(operationId, 160, true);
    requireValue(/^[A-Za-z0-9_.:-]{8,160}$/.test(operationId), 'INVALID_OPERATION_ID');
    requireValue(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_BODY');
    return this.repo.transaction(() => {
      actor = this.fresh(actor);
      authorizeWrite(actor);
      const fingerprint = hash([action, input]),
        prior = this.repo.db.prepare('SELECT * FROM v2_member_admin_operations WHERE actor_id=? AND operation_id=?').get(actor.id, operationId);
      if (prior) {
        requireValue(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 409);
        return {
          ...JSON.parse(prior.payload),
          replayed: true
        };
      }
      const changes = [],
        events = [],
        stamp = this.stamp();
      const tx = {
        actor,
        stamp,
        changes,
        events,
        put: (collection, row) => {
          this.repo.put(collection, row);
          changes.push({
            collection,
            id: row.id,
            record: row
          });
          return row;
        },
        remove: (collection, recordId) => {
          this.repo.remove(collection, recordId);
          changes.push({
            collection,
            id: recordId,
            deleted: true
          });
        },
        history: (kind, resourceId, payload = {}, memberId = null, squadId = null) => {
          this.repo.db.prepare('INSERT INTO v2_member_admin_history(kind,resource_id,member_id,squad_id,actor_id,action,payload,created_at) VALUES(?,?,?,?,?,?,?,?)').run(kind, resourceId, memberId, squadId, actor.id, action, JSON.stringify(payload), stamp);
        },
        event: (changeType, memberIds = [], squadIds = []) => events.push({
          changeType,
          memberIds: [...new Set(memberIds)],
          squadIds: [...new Set(squadIds)]
        })
      };
      const data = perform(tx);
      requireValue(!data?.then, 'ASYNC_TRANSACTION_FORBIDDEN', 500);
      this.repo.db.prepare('UPDATE v2_member_admin_meta SET revision=revision+1 WHERE id=1').run();
      const result = {
        operationId,
        data,
        changes,
        events,
        revision: this.repo.revision(),
        replayed: false
      };
      this.repo.db.prepare('INSERT INTO v2_member_admin_operations VALUES(?,?,?,?,?)').run(actor.id, operationId, fingerprint, JSON.stringify(result), stamp);
      this.repo.db.prepare('INSERT INTO v2_member_admin_outbox(operation_id,payload,created_at) VALUES(?,?,?)').run(operationId, JSON.stringify({
        schemaVersion: 1,
        actorId: actor.id,
        events,
        changes: changes.map(({
          collection,
          id,
          deleted
        }) => ({
          collection,
          id,
          deleted: Boolean(deleted)
        }))
      }), stamp);
      return result;
    });
  }
  operation(actor, operationId) {
    actor = this.fresh(actor);
    const r = this.repo.db.prepare('SELECT payload FROM v2_member_admin_operations WHERE actor_id=? AND operation_id=?').get(actor.id, text(operationId));
    requireValue(r, 'OPERATION_NOT_FOUND', 404);
    const result = JSON.parse(r.payload);
    return {
      operationId: result.operationId,
      committed: true,
      revision: result.revision
    };
  }
  bump(row, fields, stamp) {
    return {
      ...row,
      ...fields,
      revision: revision(row) + 1,
      updatedAt: stamp
    };
  }
  create(actor, input, op) {
    const parsed = steamId(input.steamInput);
    const fields = memberFields(input.fields || {});
    return this.write(actor, op, 'member.create', input, a => {
      this.global(a, 'members.basic_edit');
      if (input.squadId) {
        const sq = this.squad(a, input.squadId, 'squads.manage');
        requireValue(!sq.archivedAt, 'SQUAD_ARCHIVED', 409);
      }
    }, tx => {
      requireValue(!this.repo.find('members', 'steamId', parsed, 2).length, 'MEMBER_EXISTS', 409);
      const m = tx.put('members', {
        id: id('member'),
        steamId: parsed,
        rawInput: input.steamInput,
        customName: '',
        steamNickname: '',
        memberStatus: 'active',
        membershipStatus: 'active',
        specialty: [],
        ...fields,
        revision: 1,
        invitedByUserId: tx.actor.id,
        createdAt: tx.stamp,
        updatedAt: tx.stamp
      });
      if (input.squadId) this.assign(tx, m, input.squadId);
      tx.history('member', m.id, {
        steamId: parsed
      }, m.id);
      tx.event('member.created', [m.id], input.squadId ? [input.squadId] : []);
      return {
        id: m.id,
        revision: 1
      };
    });
  }
  edit(actor, memberId, input, op) {
    return this.write(actor, op, `member.edit:${memberId}`, input, a => this.member(a, memberId, 'members.basic_edit'), tx => {
      const m = this.repo.get('members', memberId);
      this.checkRevision(m, input.expectedRevision);
      requireValue(!m.deletedAt, 'MEMBER_DELETED', 409);
      const fields = memberFields(input.fields || {}, m);
      if (['discordId', 'wechatId'].some(k => Object.hasOwn(fields, k) && fields[k] !== m[k])) {
        this.auth(tx.actor, 'members.review', 'member', memberId);
        requireValue(!this.repo.find('v2Identities', 'accountId', this.repo.find('v2Accounts', 'memberId', memberId, 2)[0]?.id || '').length && !m.wechatUserId, 'IDENTITY_ADAPTER_REQUIRED', 503);
      }
      let nextSteam = m.steamId;
      if (input.steamInput && steamId(input.steamInput) !== m.steamId) {
        this.auth(tx.actor, 'members.review', 'member', memberId);
        requireValue(!this.repo.find('v2SteamBindings', 'memberId', memberId).length && !this.repo.find('v2Accounts', 'memberId', memberId, 2).length, 'VERIFIED_IDENTITY_IMMUTABLE', 409);
        nextSteam = steamId(input.steamInput);
        requireValue(!this.repo.find('members', 'steamId', nextSteam, 2).length, 'MEMBER_EXISTS', 409);
      }
      const updated = tx.put('members', this.bump(m, {
        ...fields,
        steamId: nextSteam
      }, tx.stamp));
      tx.history('member', m.id, {
        before: m,
        after: updated
      }, m.id);
      tx.event('member.profile', [m.id]);
      return {
        id: m.id,
        revision: updated.revision
      };
    });
  }
  status(actor, memberId, input, op) {
    return this.write(actor, op, `member.status:${memberId}`, input, a => {
      this.member(a, memberId, 'members.change_status');
      this.assertManageableIdentity(a, memberId);
    }, tx => {
      const m = this.repo.get('members', memberId);
      this.checkRevision(m, input.expectedRevision);
      requireValue(['active', 'suspended', 'left', 'blocked'].includes(input.status), 'INVALID_STATUS');
      const reason = actionReason(input.reason, '管理员确认调整成员状态');
      // A status restoration never silently clears independent G03 deny_access restrictions.
      requireValue(!m.deletedAt, 'MEMBER_DELETED', 409);
      const next = tx.put('members', this.bump(m, {
        memberStatus: input.status,
        membershipStatus: membershipOf(input.status)
      }, tx.stamp));
      tx.history('member', m.id, {
        previousStatus: statusOf(m),
        memberStatus: input.status,
        reason
      }, m.id);
      tx.event('member.status', [m.id], this.repo.currentSquad(m.id).map(r => r.squadId));
      return {
        id: m.id,
        revision: next.revision,
        restrictionPreserved: true
      };
    });
  }
  deleteMembers(actor, input, op) {
    requireValue(Array.isArray(input.targets) && input.targets.length > 0 && input.targets.length <= 100, 'INVALID_TARGETS');
    requireValue(new Set(input.targets.map(t => t.id)).size === input.targets.length, 'DUPLICATE_TARGET');
    const reason = actionReason(input.reason, '管理员确认删除成员');
    return this.write(actor, op, 'member.delete', input, a => {
      this.global(a, 'members.basic_edit');
      for (const t of input.targets) {
        for (const cap of ['members.basic_edit', 'members.change_status', 'members.review', 'system.accounts']) this.auth(a, cap, 'member', t.id);
        this.assertManageableIdentity(a, t.id);
      }
    }, tx => {
      requireValue(typeof this.adapters.deleteIdentity === 'function', 'IDENTITY_ADAPTER_REQUIRED', 503);
      for (const t of input.targets) {
        const member = this.repo.get('members', t.id);
        requireValue(member, 'RESOURCE_NOT_FOUND', 404);
        this.checkRevision(member, t.expectedRevision);
      }
      for (const t of input.targets) {
        const m = this.repo.get('members', t.id);
        const squadIds = this.repo.currentSquad(m.id).map(r => r.squadId);
        const result = this.adapters.deleteIdentity({ db: this.repo.db, tx, actor: tx.actor, member: m });
        requireValue(result?.revoked === true && !result?.then, 'INVALID_IDENTITY_ADAPTER', 503);
        this.assign(tx, m, null);
        for (const collection of ['memberProfiles', 'v2MemberProfileReceipts', 'accountAlertDismissals']) {
          const records = this.repo.db.prepare("SELECT id FROM json_records WHERE collection=? AND (json_extract(payload_json,'$.memberId')=? OR (?='memberProfiles' AND json_extract(payload_json,'$.steamId')=?))").all(collection, m.id, collection, /^\d{17}$/.test(m.steamId || '') ? m.steamId : null);
          for (const row of records) tx.remove(collection, row.id);
        }
        this.repo.db.prepare('DELETE FROM v2_member_admin_risk_state WHERE member_id=?').run(m.id);
        tx.remove('members', m.id);
        this.repo.clearDeletedMemberProjections(m);
        tx.history('member', m.id, { deleted: true, retainedHistory: true, reason }, m.id);
        tx.event('member.deleted', [m.id], squadIds);
      }
      return { deleted: input.targets.length, memberIds: input.targets.map(t => t.id), retainedHistory: true };
    });
  }
  assign(tx, m, squadId, reason = '') {
    const current = this.repo.currentSquad(m.id);
    requireValue(current.length <= 1, 'MEMBERSHIP_CONFLICT', 409);
    if ((current[0]?.squadId || null) === (squadId || null)) return;
    // Canonical current relations remain compatible with legacy readers; immutable history is in this module.
    for (const rel of current) tx.remove('squadMembers', rel.id);
    if (squadId) tx.put('squadMembers', {
      id: id('squad_member'),
      memberId: m.id,
      squadId,
      validFrom: tx.stamp,
      validTo: null,
      createdAt: tx.stamp,
      addedByUserId: tx.actor.id
    });
    const payload = {
      fromSquadId: current[0]?.squadId || null,
      toSquadId: squadId || null,
      validFrom: tx.stamp,
      ...(reason ? { reason } : {})
    };
    tx.history('member', m.id, payload, m.id, squadId);
    for (const sid of [current[0]?.squadId, squadId].filter(Boolean)) tx.history('squad', sid, {
      ...payload,
      memberId: m.id
    }, m.id, sid);
    tx.event('member.squad', [m.id], [current[0]?.squadId, squadId].filter(Boolean));
  }
  move(actor, memberId, input, op) {
    return this.write(actor, op, `member.move:${memberId}`, input, a => {
      this.member(a, memberId, 'members.basic_edit');
      const current = this.repo.currentSquad(memberId);
      for (const r of current) this.squad(a, r.squadId, 'squads.manage');
      if (input.squadId) this.squad(a, input.squadId, 'squads.manage');else this.auth(a, 'squads.manage', 'member', memberId);
    }, tx => {
      const m = this.repo.get('members', memberId);
      this.checkRevision(m, input.expectedRevision);
      requireValue(!m.deletedAt, 'MEMBER_DELETED', 409);
      if (input.squadId) requireValue(!this.repo.get('squads', input.squadId).archivedAt, 'SQUAD_ARCHIVED', 409);
      const reason = actionReason(input.reason, '管理员确认调整成员队伍');
      this.assign(tx, m, input.squadId, reason);
      const next = tx.put('members', this.bump(m, { roleDerivedSquad: null, discordSteamTeam: null }, tx.stamp));
      return {
        id: m.id,
        revision: next.revision
      };
    });
  }
  moveMany(actor, input, op) {
    requireValue(Array.isArray(input.targets) && input.targets.length > 0 && input.targets.length <= 100 && new Set(input.targets.map(t => t.id)).size === input.targets.length, 'INVALID_TARGETS');
    const reason = actionReason(input.reason, '管理员确认批量调整队伍');
    return this.write(actor, op, 'member.moveMany', input, a => {
      if (input.squadId) this.squad(a, input.squadId, 'squads.manage');
      for (const target of input.targets) {
        this.member(a, target.id, 'members.basic_edit');
        const current = this.repo.currentSquad(target.id);
        for (const r of current) this.squad(a, r.squadId, 'squads.manage');
        if (!input.squadId) this.auth(a, 'squads.manage', 'member', target.id);
      }
    }, tx => {
      if (input.squadId) requireValue(!this.repo.get('squads', input.squadId).archivedAt, 'SQUAD_ARCHIVED', 409);
      for (const target of input.targets) {
        const m = this.repo.get('members', target.id);
        this.checkRevision(m, target.expectedRevision);
        requireValue(!m.deletedAt, 'MEMBER_DELETED', 409);
      }
      for (const target of input.targets) {
        const m = this.repo.get('members', target.id);
        this.assign(tx, m, input.squadId, reason);
        tx.put('members', this.bump(m, { roleDerivedSquad: null, discordSteamTeam: null }, tx.stamp));
      }
      return {
        moved: input.targets.length,
        memberIds: input.targets.map(t => t.id)
      };
    });
  }
  async resolveSteam(actor, input, operationId) {
    actor = this.fresh(actor);
    this.global(actor, 'members.basic_edit');
    text(operationId, 160, true);
    try {
      return {
        steamId: steamId(input.steamInput),
        source: 'numeric_input'
      };
    } catch (error) {
      if (error.errorCode !== 'STEAM_RESOLUTION_REQUIRED') throw error;
    }
    const url = text(input.steamInput, 300, true);
    requireValue(/^https?:\/\/steamcommunity\.com\/id\/[A-Za-z0-9_-]{1,100}\/?$/.test(url), 'INVALID_STEAM_URL');
    requireValue(typeof this.adapters.resolveSteam === 'function', 'STEAM_RESOLVER_REQUIRED', 503);
    const result = await this.adapters.resolveSteam({
      actor,
      steamInput: url,
      operationId
    });
    this.fresh(actor);
    return {
      steamId: steamId(result.steamId),
      source: 'resolver'
    };
  }
  clearLegacyRiskConfirmations(actor, input, op) {
    return this.write(actor, op, 'risk.clearLegacy', input, a => this.global(a, 'risks.manage'), tx => {
      const reason = actionReason(input.reason, '管理员确认清除全局历史确认');
      const rows = this.repo.all('accountAlertDismissals');
      for (const row of rows) {
        this.auth(tx.actor, 'risks.manage', 'member', row.memberId);
        tx.remove('accountAlertDismissals', row.id);
      }
      tx.history('risk', 'confirmations', {
        cleared: rows.length,
        reason
      });
      return {
        cleared: rows.length
      };
    });
  }
  saveSquad(actor, squadId, input, op) {
    const name = text(input.name, 80, true),
      notes = text(input.notes || '', 500);
    return this.write(actor, op, `squad.save:${squadId || "new"}`, input, a => squadId ? this.squad(a, squadId, 'squads.manage') : this.global(a, 'squads.manage'), tx => {
      const old = squadId ? this.repo.get('squads', squadId) : null;
      if (old) {
        this.checkRevision(old, input.expectedRevision);
        requireValue(!old.archivedAt, 'SQUAD_ARCHIVED', 409);
      }
      const leaderUserIds = input.leaderUserIds ?? old?.leaderUserIds;
      requireValue(Array.isArray(leaderUserIds) && leaderUserIds.length > 0 && leaderUserIds.length <= 20 && new Set(leaderUserIds).size === leaderUserIds.length, 'INVALID_LEADERS');
      if (!old || JSON.stringify(leaderUserIds) !== JSON.stringify(old.leaderUserIds || [old.leaderUserId])) this.global(tx.actor, 'squads.manage');
      for (const uid of leaderUserIds) {
        text(uid);
        const account = this.repo.get('v2Accounts', uid) || this.repo.find('v2Accounts', 'legacyUserId', uid, 2)[0];
        requireValue(account?.status === 'active', 'INVALID_LEADERS');
      }
      const s = tx.put('squads', {
        ...old,
        id: old?.id || id('squad'),
        name,
        notes,
        leaderUserIds,
        leaderUserId: leaderUserIds[0],
        archivedAt: null,
        createdAt: old?.createdAt || tx.stamp,
        updatedAt: tx.stamp,
        revision: old ? revision(old) + 1 : 1
      });
      tx.history('squad', s.id, {
        before: old,
        after: s
      }, null, s.id);
      tx.event('squad.changed', [], [s.id]);
      return {
        id: s.id,
        revision: s.revision
      };
    });
  }
  archiveSquad(actor, squadId, input, op) {
    return this.write(actor, op, `squad.archive:${squadId || "new"}`, input, a => {
      this.global(a, 'squads.manage');
      this.squad(a, squadId, 'squads.manage');
    }, tx => {
      const s = this.repo.get('squads', squadId);
      this.checkRevision(s, input.expectedRevision);
      const reason = actionReason(input.reason, '管理员确认解散队伍');
      const rows = this.repo.find('squadMembers', 'squadId', s.id, 1001).filter(r => !r.validTo);
      requireValue(rows.length <= 1000, 'SQUAD_TOO_LARGE', 409);
      for (const r of rows) {
        this.member(tx.actor, r.memberId, 'members.basic_edit');
        const m = this.repo.get('members', r.memberId);
        this.assign(tx, m, null);
        tx.put('members', this.bump(m, { roleDerivedSquad: null, discordSteamTeam: null }, tx.stamp));
      }
      const next = tx.put('squads', this.bump(s, {
        archivedAt: tx.stamp
      }, tx.stamp));
      tx.history('squad', s.id, {
        reason,
        before: s
      }, null, s.id);
      tx.event('squad.archived', rows.map(r => r.memberId), [s.id]);
      return {
        id: s.id,
        revision: next.revision
      };
    });
  }
  previewImport(actor, input) {
    actor = this.fresh(actor);
    this.global(actor, 'members.basic_edit');
    if (input.squadId) {
      const squad = this.squad(actor, input.squadId, 'squads.manage');
      requireValue(!squad.archivedAt, 'SQUAD_ARCHIVED', 409);
    }
    const lines = text(input.text, 60000, true).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    requireValue(lines.length <= 200, 'IMPORT_LIMIT');
    const fields = memberFields(input.fields || {}),
      seen = new Set();
    const rows = lines.map(raw => {
      let sid;
      try {
        sid = steamId(raw);
      } catch {
        return {
          input: raw,
          status: 'failed',
          code: 'STEAM_RESOLUTION_REQUIRED'
        };
      }
      const duplicate = seen.has(sid) || this.repo.find('members', 'steamId', sid, 2).length;
      seen.add(sid);
      return {
        input: raw,
        steamId: sid,
        status: duplicate ? 'skipped' : 'new',
        code: duplicate ? 'MEMBER_EXISTS' : null
      };
    });
    return {
      rows,
      requested: rows.length,
      added: rows.filter(r => r.status === 'new').length,
      skipped: rows.filter(r => r.status === 'skipped').length,
      failed: rows.filter(r => r.status === 'failed').length,
      previewHash: hash([rows, fields, input.squadId || null])
    };
  }
  importMembers(actor, input, op) {
    const lines = text(input.text, 60000, true).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    requireValue(lines.length <= 200, 'IMPORT_LIMIT');
    const fields = memberFields(input.fields || {});
    return this.write(actor, op, 'member.import', input, a => {
      this.global(a, 'members.basic_edit');
      if (input.squadId) this.squad(a, input.squadId, 'squads.manage');
    }, tx => {
      if (input.previewHash) requireValue(input.previewHash === this.previewImport(tx.actor, input).previewHash, 'IMPORT_PREVIEW_CHANGED', 409);
      const results = [],
        seen = new Set();
      for (const raw of lines) {
        let sid;
        try {
          sid = steamId(raw);
        } catch {
          results.push({
            input: raw,
            status: 'failed',
            code: 'STEAM_RESOLUTION_REQUIRED'
          });
          continue;
        }
        if (seen.has(sid) || this.repo.find('members', 'steamId', sid, 2).length) {
          results.push({
            input: raw,
            status: 'skipped',
            code: 'MEMBER_EXISTS'
          });
          continue;
        }
        seen.add(sid);
        const m = tx.put('members', {
          id: id('member'),
          steamId: sid,
          rawInput: raw,
          customName: '',
          steamNickname: '',
          memberStatus: 'active',
          membershipStatus: 'active',
          specialty: [],
          ...fields,
          revision: 1,
          createdAt: tx.stamp,
          updatedAt: tx.stamp,
          invitedByUserId: tx.actor.id
        });
        if (input.squadId) this.assign(tx, m, input.squadId);
        tx.history('member', m.id, {
          imported: true
        }, m.id);
        results.push({
          input: raw,
          id: m.id,
          status: 'imported'
        });
        tx.event('member.created', [m.id], input.squadId ? [input.squadId] : []);
      }
      return {
        results,
        requested: lines.length,
        imported: results.filter(r => r.status === 'imported').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        failed: results.filter(r => r.status === 'failed').length
      };
    });
  }
  export(actor, query = {}) {
    actor = this.fresh(actor);
    const page = this.members(actor, {
      ...query,
      limit: Math.min(Number(query.limit) || 100, 100)
    });
    const fields = String(query.fields || 'displayName,steamId,squadName,specialty,memberStatus').split(',');
    const publicFields = ['displayName', 'steamId', 'squadName', 'specialty', 'memberStatus'],
      privateFields = ['phone', 'notes', 'discordId', 'discordName', 'wechatId', 'battlemetricsId', 'vitalVipType', 'vitalVipPurchasedAt', 'vitalVipExpiresAt', 'atlasVipType', 'atlasVipPurchasedAt', 'atlasVipExpiresAt'];
    requireValue(fields.length > 0 && fields.every(f => [...publicFields, ...privateFields].includes(f)), 'INVALID_EXPORT_FIELDS');
    const rows = page.items.map(m => {
      if (fields.some(f => privateFields.includes(f))) this.member(actor, m.id, 'members.basic_edit');
      return this.detail(actor, m.id);
    });
    return {
      ...page,
      items: undefined,
      fields,
      csv: '\ufeff' + [fields.map(csvCell).join(','), ...rows.map(m => fields.map(f => csvCell(m[f])).join(','))].join('\r\n')
    };
  }
  rules(actor) {
    actor = this.fresh(actor);
    this.global(actor, 'risks.read');
    const raw = this.repo.db.prepare("SELECT payload_json FROM json_scalars WHERE key='settings'").get();
    const settings = raw ? JSON.parse(raw.payload_json) : {};
    return {
      rules: settings.accountRisk?.rules || defaultRules(),
      squadFilter: settings.accountRisk?.squadFilter || '',
      revision: settings.accountRisk?.revision || 1
    };
  }
  saveRules(actor, input, op) {
    const rules = validateRules(input.rules);
    return this.write(actor, op, 'risk.rules', input, a => {
      this.global(a, 'risks.manage');
      this.global(a, 'system.permissions');
      requireValue(this.adapters.isTrustedRoot?.(a) === true, 'TRUSTED_ROOT_REQUIRED', 403);
    }, tx => {
      requireValue(typeof this.adapters.saveRiskSettings === 'function', 'RISK_SETTINGS_ADAPTER_REQUIRED', 503);
      const old = this.rules(tx.actor);
      requireValue(input.expectedRevision === old.revision, 'REVISION_CONFLICT', 409);
      const next = {
        rules,
        squadFilter: text(input.squadFilter || ''),
        revision: old.revision + 1,
        configured: true,
        updatedAt: tx.stamp
      };
      const result = this.adapters.saveRiskSettings({
        db: this.repo.db,
        settings: next,
        tx,
        actor: tx.actor
      });
      requireValue(!result?.then && result?.revision === next.revision, 'INVALID_SETTINGS_ADAPTER', 503);
      tx.history('risk', 'rules', {
        before: old,
        after: next
      });
      tx.event('risk.rules');
      return next;
    });
  }
  riskProfile(m) {
    return (m.steamId ? this.repo.find('memberProfiles', 'steamId', m.steamId, 2).find(p => p.steamId === m.steamId && (!p.memberId || p.memberId === m.id)) : null) ||
      this.repo.find('memberProfiles', 'memberId', m.id, 2).find(p => !p.steamId || p.steamId === m.steamId);
  }
  riskSettings() {
    const raw = this.repo.db.prepare("SELECT payload_json FROM json_scalars WHERE key='settings'").get();
    return raw ? JSON.parse(raw.payload_json).accountRisk || {} : {};
  }
  risksFor(actor, m) {
    const profile = this.riskProfile(m), scan = riskScanDTO(profile, m);
    const config = this.riskSettings();
    const rawSignals = profile?.accountSignals || profile || m.accountSignals || {};
    const signals = {
      ...rawSignals,
      lastOnlineAt: rawSignals.lastOnlineAt || profile?.battlemetricsLastOnlineAt || null
    };
    // Older scans marked Steam's ambiguous zero as public playtime. Do not
    // turn that stored value into a low-hours finding before the next scan.
    signals.playTimeKnown = Boolean(signals.playTimeKnown) && Number(signals.playTimeMinutes) > 0 && (!signals.playTimeVisibility || signals.playTimeVisibility === 'public');
    if (signals.inventoryVisibility) signals.inventoryPublic = signals.inventoryVisibility === 'public' && signals.inventoryValue !== null && signals.inventoryValue !== undefined;
    const sourceAt = profile?.fetchedAt || profile?.syncedAt || profile?.updatedAt || m.profileSyncedAt || null;
    const squadId = this.repo.currentSquad(m.id)[0]?.squadId;
    return riskEvidence({
      ...m,
      squadId,
      accountSignals: signals
    }, config.rules || defaultRules(), config.squadFilter || '', this.now()).map(e => {
      const state = this.repo.db.prepare('SELECT revision,status,note,evidence_hash AS evidenceHash FROM v2_member_admin_risk_state WHERE actor_id=? AND member_id=? AND alert_id=?').get(actor.id, m.id, e.id);
      const fieldEvidence = riskFieldEvidence(scan, e.type);
      const observedAt = scan && fieldEvidence ? fieldEvidence.observedAt : e.type === 'no_online_days' ? profile?.battlemetricsSyncedAt || null : ['kd', 'kills', 'deaths', 'rockets'].includes(e.type) ? profile?.officialKdaFetchedAt || null : e.type === 'account_restricted' ? profile?.accountRestrictionCheckedAt || sourceAt : e.type === 'steam_ban_or_restriction' ? profile?.steamBanCheckedAt || sourceAt : sourceAt;
      const fingerprint = hash([e, observedAt, profile?.source || null, ...(scan ? [fieldEvidence] : [])]);
      const dismissal = this.repo.get('accountAlertDismissals', `${m.id}:${e.id}`) || (e.type.startsWith('private_') ? this.repo.get('accountAlertDismissals', `${m.id}:private-account`) : null);
      const dismissed = dismissal && (!dismissal.evidenceHash || dismissal.evidenceHash === fingerprint) ? dismissal : null;
      return {
        ...e,
        evidenceHash: fingerprint,
        state: dismissed ? 'done' : state?.evidenceHash === fingerprint && state.status !== 'done' ? state.status : 'unread',
        stateRevision: this.repo.revision(),
        note: dismissed?.note || (state?.evidenceHash === fingerprint ? state.note : ''),
        reviewedBy: dismissed?.dismissedByUserId || null,
        source: profile ? 'memberProfiles' : 'members',
        ...(scan ? {scanQuality:scan.quality, currentStatus:fieldEvidence?.status || 'unavailable', retained:fieldEvidence?.retained || false, context:fieldEvidence?.context || null} : {}),
        observedAt,
        freshness: !observedAt ? 'unknown' : this.now() - Date.parse(observedAt) > 86400000 ? 'stale' : 'fresh'
      };
    });
  }
  risks(actor, query = {}) {
    actor = this.fresh(actor);
    const limit = query.limit === undefined ? 30 : Number(query.limit);
    requireValue(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_PAGE');
    const normalized = { ...query };
    delete normalized.cursor;
    delete normalized.limit;
    const scopeHash = hash([actor.id, actor.permissionVersion, actor.grants, actor.memberId, this.repo.relations()]);
    const filterHash = hash(['risks', normalized, this.riskSettings()]);
    let after = '';
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(text(query.cursor, 3000), 'base64url').toString());
        requireValue(cursor.v === 1 && cursor.scope === scopeHash && cursor.filter === filterHash && cursor.revision === this.repo.revision() && typeof cursor.after === 'string', 'CURSOR_EXPIRED', 409);
        after = cursor.after;
      } catch (error) {
        if (error.errorCode) throw error;
        fail('CURSOR_EXPIRED', 409);
      }
    }
    const p = this.repo.scope(actor, 'risks.read');
    const rows = this.repo.db.prepare(`SELECT r.id,r.payload_json FROM json_records r WHERE r.collection='members' AND (${p.text}) ORDER BY r.id`).iterate(...p.args);
    const matched = [];
    let total = 0, hasMore = false;
    for (const row of rows) {
      const member = JSON.parse(row.payload_json), alerts = this.risksFor(actor, member);
      if (!alerts.length) continue;
      total++;
      if (row.id <= after) continue;
      if (matched.length < limit) matched.push({ member, alerts });
      else hasMore = true;
    }
    return {
      items: matched.map(({ member, alerts }) => ({ member: this.memberDTO(actor, member), alerts })),
      total,
      limit,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, scope: scopeHash, filter: filterHash, revision: this.repo.revision(), after: matched.at(-1).member.id })).toString('base64url') : null,
      revision: this.repo.revision(),
      countScope: 'authorized_risk_matches'
    };
  }
  riskState(actor, memberId, input, op) {
    return this.write(actor, op, `risk.state:${memberId}`, input, a => {
      this.member(a, memberId, 'risks.read');
      this.member(a, memberId, 'risks.manage');
    }, tx => {
      requireValue(['unread', 'read', 'done'].includes(input.status), 'INVALID_RISK_STATUS');
      const m = this.repo.get('members', memberId),
        evidence = this.risksFor(tx.actor, m).find(r => r.id === input.alertId);
      requireValue(evidence && evidence.evidenceHash === input.evidenceHash, 'RISK_EVIDENCE_CHANGED', 409);
      requireValue(evidence.stateRevision === input.expectedRevision, 'REVISION_CONFLICT', 409);
      const note = input.status === 'done' ? actionReason(input.note, '管理员确认风险已人工复核') : text(input.note || '', 500);
      // Read preferences are per account; confirmed findings remain a shared
      // canonical decision, compatible with legacy accountAlertDismissals.
      const dismissalId = `${memberId}:${input.alertId}`;
      if (input.status === 'done') tx.put('accountAlertDismissals', {
        id: dismissalId, memberId, type: input.alertId, evidenceHash: evidence.evidenceHash,
        note, dismissedAt: tx.stamp, dismissedByUserId: tx.actor.id
      });
      if (input.status === 'unread') {
        if (this.repo.get('accountAlertDismissals', dismissalId)) tx.remove('accountAlertDismissals', dismissalId);
        if (evidence.type.startsWith('private_') && this.repo.get('accountAlertDismissals', `${memberId}:private-account`)) tx.remove('accountAlertDismissals', `${memberId}:private-account`);
      }
      this.repo.db.prepare('INSERT INTO v2_member_admin_risk_state VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(actor_id,member_id,alert_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,note=excluded.note,evidence_hash=excluded.evidence_hash,updated_at=excluded.updated_at').run(tx.actor.id, memberId, input.alertId, evidence.stateRevision + 1, input.status, note, evidence.evidenceHash, tx.stamp);
      tx.history('risk', memberId, {
        alertId: input.alertId,
        status: input.status,
        note
      }, memberId);
      return {
        memberId,
        status: input.status
      };
    });
  }
  clearRiskStates(actor, input, op) {
    return this.write(actor, op, 'risk.reset', input, a => this.global(a, 'risks.manage'), tx => {
      const reason = actionReason(input.reason, '管理员确认清除个人风险确认');
      const r = this.repo.db.prepare('DELETE FROM v2_member_admin_risk_state WHERE actor_id=?').run(tx.actor.id);
      tx.history('risk', 'reset', {
        cleared: Number(r.changes),
        reason
      });
      return {
        cleared: Number(r.changes)
      };
    });
  }
  async sync(actor, input, op, action = 'request') {
    actor = this.fresh(actor);
    text(op, 160, true);
    requireValue(this.adapters.sync && typeof this.adapters.sync[action] === 'function', 'SYNC_ADAPTER_REQUIRED', 503);
    requireValue(['memberProfiles', 'discordMembershipAudit', 'steam', 'battlemetrics', 'kda'].includes(input.kind), 'INVALID_SYNC_KIND');
    requireValue(Array.isArray(input.memberIds) && input.memberIds.length > 0 && input.memberIds.length <= 200, 'INVALID_TARGETS');
    const ids = [...new Set(input.memberIds)];
    for (const mid of ids) {
      this.member(actor, mid, 'members.read');
      this.member(actor, mid, 'sync.run');
      this.member(actor, mid, input.kind === 'discordMembershipAudit' ? 'members.change_status' : input.kind === 'memberProfiles' ? 'risks.manage' : 'members.basic_edit');
    }
    return this.adapters.sync[action]({
      actor,
      scope: {
        accountId: actor.id,
        permissionVersion: actor.permissionVersion,
        memberIds: ids
      },
      kind: input.kind,
      operationId: op,
      jobId: input.jobId || null,
      expectedRevision: input.expectedRevision,
      db: this.repo.db
    });
  }
  unlink(actor, memberId, input, op) {
    return this.write(actor, op, `member.unlink:${memberId}`, input, a => {
      this.member(a, memberId, 'members.review');
      this.member(a, memberId, 'system.accounts');
      this.assertManageableIdentity(a, memberId, { allowSelfUnlink: true });
    }, tx => {
      const m = this.repo.get('members', memberId);
      this.checkRevision(m, input.expectedRevision);
      requireValue(['wechat', 'discord', 'kook'].includes(input.provider), 'INVALID_PROVIDER');
      const reason = actionReason(input.reason, '管理员确认解绑平台关联');
      requireValue(typeof this.adapters.unlinkIdentity === 'function', 'IDENTITY_ADAPTER_REQUIRED', 503);
      const result = this.adapters.unlinkIdentity({
        actor: tx.actor,
        member: m,
        provider: input.provider,
        reason,
        expectedIdentityFingerprint: input.expectedIdentityFingerprint,
        operationId: op,
        db: this.repo.db,
        tx
      });
      requireValue(!result?.then && result?.revoked === true, 'INVALID_IDENTITY_ADAPTER', 503);
      tx.history('member', m.id, {
        provider: input.provider,
        reason,
        revoked: true
      }, m.id);
      tx.event('member.identity', [m.id]);
      return {
        id: m.id,
        revoked: true
      };
    });
  }
  changes(after = 0, limit = 100) {
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_PAGE');
    return this.repo.db.prepare('SELECT seq,operation_id AS operationId,payload,created_at AS createdAt FROM v2_member_admin_outbox WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(r => ({
      ...r,
      payload: JSON.parse(r.payload)
    }));
  }
}
