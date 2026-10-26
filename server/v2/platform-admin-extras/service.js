import { ExtrasRepository, vitalState } from './repository.js';
import { fresh, globalCapability, authorizeServerWrite } from './authority.js';
import { hash, need, sync, patch, catalogEntries, project } from './model.js';
import { readSummary } from './summary.js';
export class PlatformAdminExtrasService {
  constructor({ identity, members, scheduling, stats, system, readCatalog, runStoreWriteTask, patchCache, publishEvents,
    authorizeLegacyServerManagement, isTrustedRoot, now = Date.now }) {
    need(identity?.repo?.db && [readCatalog,runStoreWriteTask,patchCache,publishEvents].every(fn => typeof fn === 'function'), 'ADMIN_EXTRAS_OWNER_REQUIRED', 503);
    for (const domain of [members,scheduling,stats,system].filter(Boolean)) need(domain.identity === identity && domain.repo.db === identity.repo.db, 'DOMAIN_STORAGE_MISMATCH', 503);
    Object.assign(this, { identity, members, scheduling, stats, system, readCatalog, runStoreWriteTask, patchCache, publishEvents, authorizeLegacyServerManagement, isTrustedRoot, now });
    this.repo = new ExtrasRepository(identity.repo.db);
    this.catalog();
  }
  catalog() {
    const rows = catalogEntries(sync(this.readCatalog()));
    need(hash(rows) === this.repo.meta().baseHash, 'CATALOG_MAPPING_CHANGED', 503); return rows;
  }
  state() {
    const settings = this.repo.settings(), vital = settings.vitalServers || { overrides: [] };
    need(vital && typeof vital === 'object' && !Array.isArray(vital) && Array.isArray(vital.overrides), 'INVALID_CANONICAL_VITAL_SETTINGS', 503);
    need(vital.overrides.every(x => x && typeof x === 'object' && typeof x.vitalServerId === 'string') &&
      new Set(vital.overrides.map(x => x.vitalServerId)).size === vital.overrides.length, 'AMBIGUOUS_CANONICAL_OVERRIDE', 503);
    return { settings, vital };
  }
  servers(actor) {
    actor = fresh(this.identity, actor);
    need(globalCapability(this.identity, actor, 'wipes.read'), 'GLOBAL_WIPES_READ_REQUIRED', 403);
    const catalog = this.catalog(), { vital } = this.state(), meta = this.repo.meta();
    return { items: catalog.map(row => project(row, vital.overrides.find(o => o.vitalServerId === row.vitalServerId))),
      total: catalog.length, countKnown: true, partial: false, revision: meta.revision,
      sourceChanged: hash(vital) !== meta.sourceHash, catalogVersion: meta.baseHash, observedAt: new Date(this.now()).toISOString(),
      scope: 'global_server_catalog', affects: 'future_catalog_selection' };
  }
  summary(actor, input) {
    // All reused read projections execute synchronously on one SQLite read snapshot.
    return this.repo.transaction(() => readSummary(this, actor, input));
  }
  current(profileId) {
    const base = this.catalog().find(x => x.serverProfileId === profileId);
    need(base, 'RESOURCE_NOT_FOUND', 404);
    return project(base, this.state().vital.overrides.find(o => o.vitalServerId === base.vitalServerId));
  }
  async flushPending() {
    let count = 0;
    // Called only under the host's one global queue. Bounded recovery batches.
    for (const row of this.repo.pending()) {
      const receipt = JSON.parse(row.receipt);
      if (!row.cache_done) {
        await this.patchCache({ kind: 'vitalServers', vitalServers: structuredClone(this.state().vital), revision: this.repo.meta().revision });
        this.repo.db.prepare('UPDATE v2_platform_admin_extras_operations SET cache_done=1 WHERE revision=?').run(row.revision);
      }
      if (!row.event_done) {
        await this.publishEvents([{ id: receipt.eventId, type: 'server_catalog.changed', resource: { kind: 'serverCatalog', id: receipt.serverProfileId },
          revision: row.revision, operationId: row.operation_id, observedAt: receipt.committedAt }]);
        this.repo.db.prepare('UPDATE v2_platform_admin_extras_operations SET event_done=1 WHERE revision=?').run(row.revision);
      }
      count++;
    }
    return { recovered: count, pending: Boolean(this.repo.pending().length) };
  }
  recover() { return this.runStoreWriteTask(() => this.flushPending()); }
  async saveServer(actor, input, operationId, { assertCurrent } = {}) {
    actor = fresh(this.identity, actor); authorizeServerWrite(this.identity, actor, this);
    const changes = patch(input);
    need(typeof operationId === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(operationId), 'IDEMPOTENCY_KEY_REQUIRED');
    need(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'EXPECTED_REVISION_REQUIRED');
    need(typeof (input.serverProfileId || input.serverId) === 'string', 'SERVER_PROFILE_REQUIRED');
    const originalActor = actor, fingerprint = hash({ input, action: 'server_save' });
    return this.runStoreWriteTask(async () => {
      const verify = () => {
        if (assertCurrent) {
          const checked = sync(assertCurrent());
          // Existing adapters may implement a void assertion; a returned actor must match.
          if (checked) need(checked.id === originalActor.id && checked.permissionVersion === originalActor.permissionVersion, 'AUTH_CHANGED', 401);
        }
        actor = fresh(this.identity, originalActor); authorizeServerWrite(this.identity, actor, this);
      };
      verify();
      const prior = this.repo.operation(actor.id, operationId);
      if (prior) need(prior.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 409);
      try { const recovery = await this.flushPending(); need(!recovery.pending, 'EFFECTS_RECOVERY_REQUIRED', 503); }
      catch (error) { if (error.errorCode) throw error; throw Object.assign(new Error('EFFECTS_RECOVERY_REQUIRED'), { errorCode: 'EFFECTS_RECOVERY_REQUIRED', status: 503 }); }
      verify();
      let receipt;
      if (prior) receipt = JSON.parse(prior.receipt);
      else receipt = this.repo.transaction(() => {
        verify();
        const catalog = this.catalog();
        const matches = key => catalog.find(row => [row.serverProfileId,row.id,row.vitalServerId].includes(key));
        const base = matches(input.serverProfileId || input.serverId);
        need(base && (!input.serverProfileId || base.serverProfileId === input.serverProfileId), 'RESOURCE_NOT_FOUND', 404);
        if (input.serverId) need(matches(input.serverId)?.serverProfileId === base.serverProfileId, 'SERVER_PROFILE_MISMATCH');
        const meta = this.repo.meta(), { settings, vital } = this.state();
        need(meta.revision === input.expectedRevision, 'REVISION_CONFLICT', 409);
        need(hash(vital) === meta.sourceHash, 'CATALOG_SOURCE_CHANGED', 409);
        const revision = meta.revision + 1, at = new Date(this.now()).toISOString();
        const before = vital.overrides.find(o => o.vitalServerId === base.vitalServerId) || { vitalServerId: base.vitalServerId };
        const after = { ...before, ...changes, vitalServerId: base.vitalServerId, updatedAt: at };
        const next = { ...vital, overrides: vital.overrides.some(o => o.vitalServerId === base.vitalServerId)
          ? vital.overrides.map(o => o.vitalServerId === base.vitalServerId ? after : o) : [...vital.overrides, after] };
        const result = { operationId, action: 'server_save', serverProfileId: base.serverProfileId, vitalServerId: base.vitalServerId,
          revision, committedAt: at, eventId: `admin-extras:${revision}`, changedFields: Object.keys(changes).sort(), committed: true };
        this.repo.saveSettings({ ...settings, vitalServers: next });
        this.repo.db.prepare('UPDATE v2_platform_admin_extras_meta SET revision=?,source_hash=? WHERE id=1').run(revision, hash(next));
        this.repo.db.prepare('INSERT INTO v2_platform_admin_extras_operations(actor_id,operation_id,fingerprint,revision,receipt) VALUES(?,?,?,?,?)')
          .run(actor.id, operationId, fingerprint, revision, JSON.stringify(result));
        this.repo.db.prepare('INSERT INTO v2_platform_admin_extras_audits VALUES(?,?,?,?,?,?,?,?,?)')
          .run(revision, actor.id, operationId, base.serverProfileId, base.vitalServerId, JSON.stringify(result.changedFields), hash(before), hash(after), at);
        return result;
      });
      let effects = 'complete';
      try { await this.flushPending(); } catch { effects = 'pending'; }
      verify();
      return { operationReceipt: receipt, committed: true, replayed: Boolean(prior), effects, current: this.current(receipt.serverProfileId), revision: this.repo.meta().revision };
    });
  }
}
export function createPlatformAdminExtras(options) {
  const service = new PlatformAdminExtrasService(options);
  return { service, miniAdapters: {
    admin: { summary: ({ actor, input, assertCurrent }) => { assertCurrent?.(); return service.summary(actor, input); } },
    scheduling: {
      servers: ({ actor, assertCurrent }) => { assertCurrent?.(); return service.servers(actor); },
      saveServer: ({ actor, input, operationId, assertCurrent }) => service.saveServer(actor, input, operationId, { assertCurrent })
    }
  } };
}
