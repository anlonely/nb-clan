import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { authorize, can } from '../identity/permissions.js';
import {realtimeReadScope} from './read-snapshot.js';
import { decodedRealtimeNames } from './names.js';
import { isUnassignedRelayResource } from './repository.js';
const fail = (c, s = 422) => {
  throw new IdentityError(c, s);
};
const SEARCH_TEXT = ['displayName','steamId','inviterName','inviterSteamId','inviteeName','inviteeSteamId','invitedBy','status','statusLabel','message','translatedMessage'].map(k => `COALESCE(json_extract(payload,'$.${k}'),'')`).join(' || char(10) || ');
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const realtimeScopeLabel = scope => isUnassignedRelayResource(scope.resource)
  ? `${scope.sourceName || scope.source} · ${scope.label.replace(/^未分配\s*·\s*/, '')}`
  : scope.label;
export class RealtimeService {
  constructor(identity, {
    repository,
    now = Date.now,
    ttlMs = 120000,
    authorizeLegacyAction,
    sourceReset,
    members
  } = {}) {
    Object.assign(this, {
      identity,
      repo: repository,
      now,
      ttlMs,
      authorizeLegacyAction,
      sourceReset,
      members
    });
  }
  current(actor) {
    const a = this.identity.actorForAccount(actor.id);
    if (a.permissionVersion !== actor.permissionVersion) fail('PERMISSIONS_CHANGED', 401);
    return a;
  }
  requireRepo() {
    if (!this.repo) fail('SOURCE_ADAPTER_REQUIRED', 503);
  }
  authorizationRelations() {
    return this.identity.relations();
  }
  resourceVisible(actor, resource) {
    if (resource.kind !== 'system') return true;
    if (!isUnassignedRelayResource(resource)) return false;
    return this.identity.actorForAccount(actor.id).roleId === 'owner';
  }
  access(actor, id, cap = 'relay.read') {
    this.requireRepo();
    const a = this.current(actor),
      s = this.repo.scope(id);
    if (!s) fail('RESOURCE_NOT_FOUND', 404);
    if (!this.resourceVisible(a, s.resource)) fail('ACCESS_DENIED', 403);
    authorize(a, cap, s.resource, this.authorizationRelations(a, s.resource));
    return {
      a,
      s
    };
  }
  catalog(actor, mode = 'info') {
    this.requireRepo();
    const a = this.current(actor),
      cap = mode === 'chat' ? 'relay.chat_read' : 'relay.read',
      rows = this.repo.scopes();
    if (rows.length > 500) fail('SOURCE_CATALOG_LIMIT', 503);
    const visibleRows = rows.filter(s => this.resourceVisible(a, s.resource));
    return {
      items: visibleRows.filter(s => can(a, cap, s.resource, this.identity.relations())).map(s => ({
        id: s.id,
        sourceId: s.source,
        serverKey: s.server,
        label: realtimeScopeLabel(s)
      })),
      sourceStatus: visibleRows.length ? 'available' : 'unavailable'
    };
  }
  cursor(a, s, kind, value, filter = '') {
    const body = Buffer.from(JSON.stringify({
      v: 1,
      a: a.id,
      p: a.permissionVersion,
      d: this.identity.scopeDigest(a),
      s: s.id,
      source: s.source,
      server: s.server,
      e: s.epoch,
      k: kind,
      f: filter,
      n: value,
      t: this.now()
    })).toString('base64url');
    return `${body}.${createHmac('sha256', this.repo.secret).update(body).digest('base64url')}`;
  }
  decode(token, a, s, kind, filter = '') {
    try {
      if (typeof token !== 'string' || token.length > 3000) throw 0;
      const [b, mac, ...rest] = token.split('.'),
        expected = createHmac('sha256', this.repo.secret).update(b).digest();
      const actual = Buffer.from(mac, 'base64url');
      if (rest.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw 0;
      const c = JSON.parse(Buffer.from(b, 'base64url'));
      if (c.v !== 1 || c.a !== a.id || c.p !== a.permissionVersion || c.d !== this.identity.scopeDigest(a) || c.s !== s.id || c.source !== s.source || c.server !== s.server || c.e !== s.epoch || c.k !== kind || c.f !== filter || this.now() - c.t > 86400000 || c.t > this.now() + 1000 || !Number.isSafeInteger(c.n) || c.n < 0) throw 0;
      return c.n;
    } catch {
      fail('CURSOR_EXPIRED', 410);
    }
  }
  sourceState(s) {
    return {
      status: this.status(s),
      sourceId: s.source,
      name: s.sourceName || s.source,
      firstReceivedAt: s.firstReceived,
      lastReportAt: s.lastReport,
      observedAt: s.observed
    };
  }
  status(s) {
    const age = this.now() - Date.parse(s.observed);
    if (s.snapshot?.expiresAt && (!Number.isFinite(Date.parse(s.snapshot.expiresAt)) || Date.parse(s.snapshot.expiresAt) <= this.now())) return 'stale';
    return !s.snapshot ? 'unavailable' : !Number.isFinite(age) || age < -30000 || age > this.ttlMs ? 'stale' : 'fresh';
  }
  summary(actor, id) {
    const {
        a,
        s
      } = this.access(actor, id),
      status = this.status(s),
      snapshot = s.snapshot;
    const linked = new Map(this.identity.repo.all('members').map(m => [m.steamId, m]));
    const members = (snapshot?.members || []).map(m => {
      const identity = linked.get(m.steamId),
        visible = identity && can(a, 'members.read', {
          kind: 'member',
          id: identity.id
        }, this.identity.relations());
      return {
        ...decodedRealtimeNames(m, ['displayName', 'gameClanName']),
        online: status === 'fresh' ? m.online : null,
        observedOnline: m.online,
        memberId: visible ? identity.id : null,
        registered: Boolean(identity),
        squadName: visible ? this.identity.repo.all('squads').filter(q => this.identity.repo.all('squadMembers').some(r => r.squadId === q.id && r.memberId === identity.id && !r.validTo)).map(q => q.name).join(' / ') : null
      };
    });
    const online = status === 'fresh' ? members.filter(m => m.online).length : null;
    return {
      scope: {
        id: s.id,
        sourceId: s.source,
        serverKey: s.server,
        label: s.label
      },
      source: this.sourceState(s),
      revision: s.revision,
      epoch: s.epoch,
      status,
      observedAt: s.observed,
      receivedAt: s.received,
      ttlMs: this.ttlMs,
      clan: snapshot?.clan || null,
      members,
      invites: (snapshot?.invites || []).map(invite => decodedRealtimeNames(invite, ['displayName', 'inviterName', 'invitedBy', 'inviteeName'])),
      counts: {
        members: members.length,
        online,
        offline: online === null ? null : members.length - online
      },
      squads: [...new Set(members.map(m => m.squadName || '未关联队伍'))].map(name => ({
        name,
        total: members.filter(m => (m.squadName || '未关联队伍') === name).length,
        online: status === 'fresh' ? members.filter(m => (m.squadName || '未关联队伍') === name && m.online).length : null
      })),
      commands: {
        clearChat: this.allowed(a, s, 'clear-chat'),
        reset: this.allowed(a, s, 'reset'),
        importMember: this.allowed(a, s, 'import-member')
      }
    };
  }
  allowed(a, s, action) {
    // The host preserves the original per-module edit guard. System storage
    // authority is unrelated to clearing relay history or resetting a source.
    return this.resourceVisible(a, s.resource) && Boolean(this.authorizeLegacyAction && this.authorizeLegacyAction(a, action, s) === true);
  }
  page(actor, id, {
    kind = 'chat',
    before,
    limit = 50,
    q = ''
  } = {}) {
    const {
      a,
      s
    } = this.access(actor, id, kind === 'chat' ? 'relay.chat_read' : 'relay.read');
    if (!['chat', 'invite'].includes(kind)) fail('INVALID_RECORD_KIND');
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_LIMIT');
    q = String(q).trim().slice(0, 120);
    const filter = hash({
        q,
        kind
      }),
      edge = before ? this.decode(before, a, s, kind, filter) : Number.MAX_SAFE_INTEGER;
    // The event high-water is captured synchronously with the initial history page, closing the read/subscribe gap.
    const high = this.repo.high(id),
      rows = this.repo.db.prepare(`SELECT * FROM v2_realtime_records WHERE scope=? AND kind=? AND seq<? AND (?='' OR instr(lower(${SEARCH_TEXT}),lower(?))>0) ORDER BY seq DESC LIMIT ?`).all(id, kind, edge, q, q, limit + 1),
      items = rows.slice(0, limit).map(r => ({
        ...decodedRealtimeNames(JSON.parse(r.payload), ['displayName', 'inviterName', 'invitedBy', 'inviteeName']),
        sequence: r.seq,
        occurredAt: r.occurred,
        receivedAt: r.received
      }));
    return {
      source: this.sourceState(s),
      items,
      nextCursor: rows.length > limit ? this.cursor(a, s, kind, items.at(-1).sequence, filter) : null,
      tailCursor: this.cursor(a, s, 'events', high),
      revision: s.revision,
      scopeId: id,
      counts: kind === 'invite' ? this.inviteCounts(id, q) : undefined
    };
  }
  inviteCounts(id, q) {
    const rows = this.repo.db.prepare(`SELECT json_extract(payload,'$.status') AS status,COUNT(*) AS n FROM v2_realtime_records WHERE scope=? AND kind='invite' AND (?='' OR instr(lower(${SEARCH_TEXT}),lower(?))>0) GROUP BY status`).all(id, q, q);
    return Object.fromEntries(rows.map(r => [r.status || 'unknown', r.n]));
  }
  events(actor, id, after) {
    return realtimeReadScope(this,id).readEvents(actor,id,after);
  }
  readEvents(actor, id, after) {
    const {
      a,
      s
    } = this.access(actor, id, 'relay.chat_read');
    let n;
    try {
      n = after ? this.decode(after, a, s, 'events') : this.repo.high(id);
    } catch (e) {
      if (e.status !== 410) throw e;
      return {
        resetRequired: true,
        cursor: this.cursor(a, s, 'events', this.repo.high(id)),
        events: []
      };
    }
    const floor = Number(this.repo.db.prepare('SELECT value FROM v2_realtime_meta WHERE key=?').get(`floor:${id}`)?.value || 0);
    if (n < floor) return {
      resetRequired: true,
      cursor: this.cursor(a, s, 'events', this.repo.high(id)),
      events: []
    };
    const rows = this.repo.db.prepare('SELECT * FROM v2_realtime_events WHERE scope=? AND seq>? ORDER BY seq LIMIT 101').all(id, n);
    if (rows.length > 100 || rows.some(r => this.now() - r.created > 86400000)) return {
      resetRequired: true,
      cursor: this.cursor(a, s, 'events', this.repo.high(id)),
      events: []
    };
    const events = rows.map(r => ({
      eventId: this.cursor(a, s, 'events', r.seq),
      eventType: r.type,
      sourceId: s.source,
      serverKey: s.server,
      resourceId: s.id,
      resourceRevision: s.revision,
      scopeVersion: a.permissionVersion,
      occurredAt: JSON.parse(r.payload).sentAt || new Date(r.created).toISOString(),
      receivedAt: new Date(r.created).toISOString(),
      payload: decodedRealtimeNames(JSON.parse(r.payload), ['displayName', 'inviterName', 'invitedBy', 'inviteeName'])
    }));
    return {
      source: this.sourceState(s),
      events,
      cursor: events.at(-1)?.eventId || this.cursor(a, s, 'events', n),
      resetRequired: false
    };
  }
  async command(actor, id, action, input = {}, operationId) {
    const {
      a,
      s
    } = this.access(actor, id, action === 'clear-chat' ? 'relay.chat_read' : 'relay.read');
    if (!['clear-chat', 'reset', 'import-member'].includes(action)) fail('UNKNOWN_COMMAND', 404);
    if (!this.allowed(a, s, action)) fail(this.authorizeLegacyAction ? 'ACCESS_DENIED' : 'LEGACY_AUTHORITY_REQUIRED', this.authorizeLegacyAction ? 403 : 503);
    if (!/^[A-Za-z0-9_-]{12,120}$/.test(operationId || '')) fail('OPERATION_ID_REQUIRED');
    if (action === 'import-member') {
      if (!this.members?.importMember) fail('MEMBERS_ADAPTER_REQUIRED', 503);
      const member = s.snapshot?.members.find(m => m.steamId === input.steamId);
      if (!member) fail('RESOURCE_NOT_FOUND', 404);
      authorize(a, 'members.basic_edit', {
        kind: 'squad',
        id: input.squadId
      }, this.identity.relations());
      const result = await this.members.importMember({
        actor: a,
        operationId,
        expectedRevision: input.expectedRevision,
        source: {
          scopeId: id,
          sourceId: s.source,
          serverKey: s.server,
          observedAt: s.observed
        },
        steamId: member.steamId,
        displayName: member.displayName,
        squadId: input.squadId
      });
      this.current(actor);
      return result;
    }
    const signature = hash({
        id,
        action,
        input
      }),
      receipt = this.repo.db.prepare('SELECT * FROM v2_realtime_receipts WHERE id=?').get(operationId);
    if (receipt) {
      if (receipt.actor !== a.id || receipt.signature !== signature) fail('IDEMPOTENCY_CONFLICT', 409);
      return {
        ...JSON.parse(receipt.result),
        replayed: true
      };
    }
    if (input.expectedRevision !== s.revision) fail('REVISION_CONFLICT', 409);
    if (!input.reason?.trim() || input.reason.length > 500) fail('REASON_REQUIRED');
    if (action === 'reset' && !this.sourceReset) fail('SOURCE_RESET_ADAPTER_REQUIRED', 503);
    const apply = () => this.repo.transaction(() => {
      const current = this.repo.scope(id);
      if (current.revision !== s.revision) fail('REVISION_CONFLICT', 409);
      const kinds = action === 'clear-chat' ? ['chat'] : ['chat', 'invite'];
      for (const kind of kinds) this.repo.db.prepare('DELETE FROM v2_realtime_records WHERE scope=? AND kind=?').run(id, kind);
      this.repo.db.prepare(`UPDATE v2_realtime_scopes SET revision=revision+1,epoch=epoch+1${action === 'reset' ? ',snapshot=NULL,observed=NULL,received=NULL,cutoff=?' : ''} WHERE id=?`).run(...(action === 'reset' ? [new Date(this.now()).toISOString(), id] : [id]));
      const result = {
        operationId,
        scopeId: id,
        action,
        revision: s.revision + 1,
        epoch: s.epoch + 1,
        localHistoryCleared: true,
        sourceReset: action === 'reset'
      };
      this.repo.db.prepare('INSERT INTO v2_realtime_receipts VALUES(?,?,?,?)').run(operationId, a.id, signature, JSON.stringify(result));
      this.repo.db.prepare('INSERT INTO v2_realtime_audit(scope,actor,action,operation,created,detail) VALUES(?,?,?,?,?,?)').run(id, a.id, action, operationId, new Date(this.now()).toISOString(), JSON.stringify({
        reason: input.reason,
        fromRevision: s.revision,
        toRevision: s.revision + 1
      }));
      this.repo.emit(id, 'scope.reset', {}, this.now());
      return result;
    });
    // sourceReset is a synchronous same-transaction adapter. No network/restart side effects are authorized here.
    let result;
    if (action === 'reset') result = this.repo.transaction(() => {
      let calls = 0,
        accepting = true;
      try {
        const out = this.sourceReset({
          actor: a,
          scope: s,
          operationId,
          apply: () => {
            if (!accepting || calls++) fail('INVALID_SOURCE_ADAPTER', 503);
            return apply();
          }
        });
        if (out?.then) {
          out.catch(() => {});
          fail('INVALID_SOURCE_ADAPTER', 503);
        }
        if (calls !== 1 || out?.operationId !== operationId) fail('INVALID_SOURCE_ADAPTER', 503);
        return out;
      } finally {
        accepting = false;
      }
    });else result = apply();
    this.repo.notify(id);
    return result;
  }
  memberOptions(actor, id) {
    const {
      a,
      s
    } = this.access(actor, id);
    if (!this.allowed(a, s, 'import-member')) fail('ACCESS_DENIED', 403);
    return {
      squads: this.identity.repo.all('squads').filter(q => !q.archivedAt && can(a, 'members.basic_edit', {
        kind: 'squad',
        id: q.id
      }, this.identity.relations())).map(q => ({
        id: q.id,
        name: q.name
      }))
    };
  }
}
