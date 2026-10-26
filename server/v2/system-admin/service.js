import { timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { scrypt } from 'node:crypto';
import { SystemRepository } from './repository.js';
import { assertAccess, accessDTO } from './access.js';
import { need, fields, revision, signature, operationId, nowIso, hashSecret, logoUrl, displayLogoUrl, proxyUrl, maskedProxy, SystemError, text } from './model.js';
import { artifactDTO } from './storage.js';
import { readSystemLogs, logsCSV } from './logs.js';
import { readProxyNodes, selectedProxyUrl } from '../../proxy-nodes.js';
const areaFor = action => action.startsWith('account.grants') || action.startsWith('role.') ? 'permissions' :
  ({ account: 'accounts', brand: 'brand', proxy: 'proxy', public: 'api_keys', storage: 'storage', logs: 'logs' })[action.split('.')[0]];
const asyncActions = new Set(['storage.backup','storage.restore','storage.quarantine','storage.recover','proxy.probe']);
export const SYSTEM_COMMANDS = Object.freeze(['brand.save','brand.upload','brand.upload.start','brand.upload.part','brand.upload.finish','brand.upload.abort','brand.reset','proxy.save','proxy.select','proxy.toggle','proxy.probe','public.save','public.clear',
  'account.create','account.status','account.role','account.password','account.delete','account.batch','account.grants','account.binding','account.restriction','account.restriction.remove','account.cleanup',
  'role.save','role.delete','storage.export-config','storage.backup','storage.restore','storage.quarantine','storage.recover','logs.export']);

/** The host owns the global write queue and cache lifecycle. No default bypass exists. */
export function createSystemWriteOwner({ runWrite, patchCache, invalidateAuthContexts }) {
  need(typeof runWrite === 'function' && typeof patchCache === 'function' && typeof invalidateAuthContexts === 'function', 'SYSTEM_OWNER_REQUIRED', 503);
  let accepting = false; const pending = new Set();
  return {
    start() { accepting = true; },
    async stop() { accepting = false; await Promise.allSettled([...pending]); },
    run(fn) { need(accepting, 'SYSTEM_OWNER_STOPPED', 503); const p = Promise.resolve(runWrite(fn)); pending.add(p); p.finally(() => pending.delete(p)).catch(() => {}); return p; },
    async effects(change) { if (change.identity) await invalidateAuthContexts(change.accounts || []); await patchCache(change); }
  };
}
export class SystemAdminService {
  constructor({ identity, identityAdmin, owner, storage, proxyEnvironment = {}, proxyNodes = readProxyNodes, probe }) {
    need(identityAdmin?.identity === identity && owner && storage, 'SYSTEM_ADAPTERS_REQUIRED', 503);
    this.identity = identity; this.identityAdmin = identityAdmin; this.owner = owner; this.storage = storage; this.probe = probe;
    this.repo = new SystemRepository(identity.repo.db); this.proxyEnvironment = Object.freeze({ ...proxyEnvironment }); this.proxyNodes = proxyNodes;
  }
  actor(id) { return this.identity.actorForAccount(id); }
  brand() {
    const s = this.repo.settings().system || {};
    const safeLogo = displayLogoUrl(s.teamLogoUrl);
    return { revision: this.repo.meta('brand'), teamLogoUrl: safeLogo, legacyLogoUnavailable: Boolean(s.teamLogoUrl && !safeLogo), teamLogoUpdatedAt: s.teamLogoUpdatedAt || '',
      logoArtifactId: this.repo.meta('logoArtifactId', null) };
  }
  proxy() {
    const saved = this.repo.settings().system?.proxy || {};
    const enabled = saved.enabled !== false;
    let nodes = [];
    // A broken catalog must not prevent switching off or reading direct mode.
    try { nodes = this.proxyNodes(); } catch (error) { if (enabled) throw error; }
    const chosen = enabled && saved.nodeId ? nodes.find(node => node.id === saved.nodeId) : null;
    const savedUrl = enabled && saved.nodeId ? (chosen ? selectedProxyUrl(saved, nodes) : '') : saved.url;
    const effective = service => !enabled ? { url: '', source: 'disabled', scope: saved.scope || 'global' } : (saved.url || saved.nodeId) && (saved.scope === 'global' || saved.scope === service)
      ? { url: savedUrl, source: chosen ? 'node' : saved.nodeId ? 'node-unavailable' : 'store', scope: saved.scope } : { url: this.proxyEnvironment[service] || this.proxyEnvironment.global || '',
        source: this.proxyEnvironment[service] || this.proxyEnvironment.global ? 'env' : 'none', scope: this.proxyEnvironment[service] ? service : 'global' };
    const dto = p => ({ enabled: Boolean(p.url), endpoint: p.source === 'node' ? '' : maskedProxy(p.url), source: p.source, scope: p.scope });
    return { revision: this.repo.meta('proxy'), enabled, nodes: nodes.map(({id,name}) => ({id,name})),
      saved: { endpoint: saved.nodeId ? '' : maskedProxy(savedUrl), nodeId: saved.nodeId || '', scope: saved.scope || 'global', enabled: Boolean(saved.url || saved.nodeId) },
      effective: { battlemetrics: dto(effective('battlemetrics')), kda: dto(effective('kda')) }, updatedAt: saved.updatedAt || '',
      lastProbe: this.repo.meta('lastProbe', null) };
  }
  publicApi() {
    const s = this.repo.settings().publicApi || {};
    return { revision: this.repo.meta('api_keys'), enabled: Boolean(s.tokenHash), updatedAt: s.tokenUpdatedAt || '',
      endpoint: '/api/integrations/public-query', secretScope: 'public-query-only' };
  }
  read(actor, area, query = {}) {
    actor = this.actor(actor.id); assertAccess(this.identity, actor, area);
    if (area === 'brand') return { ...this.brand(), uploads: this.repo.db.prepare('SELECT id, revision, total_bytes totalBytes, expires_at expiresAt FROM v2_system_uploads WHERE actor_id=? ORDER BY id LIMIT 4').all(actor.id) };
    if (area === 'proxy') return this.proxy();
    if (area === 'api_keys') return this.publicApi();
    if (area === 'accounts') return { ...this.identityAdmin.list(actor, query), revision: this.repo.meta('accounts') };
    if (area === 'permissions') return this.identityAdmin.roles(actor);
    if (area === 'logs') return readSystemLogs(this.repo, actor, query);
    if (area === 'storage') {
      const cursor = query.cursor ? operationId(query.cursor) : '', artifacts = this.repo.artifacts(cursor), hasMore = artifacts.length > 100;
      return { revision: this.repo.meta('storage'), ...this.storage.status(), artifacts: artifacts.slice(0, 100).map(artifactDTO),
        recoveryPolicy: 'verified-candidate-no-live-overwrite', hasMore, nextCursor: hasMore ? artifacts[99].id : null };
    }
  }
  access(actor) { return accessDTO(this.identity, this.actor(actor.id)); }
  getOperation(actor, id) {
    actor = this.actor(actor.id); const op = this.repo.operation(operationId(id));
    need(op && op.actorId === actor.id, 'RESOURCE_NOT_FOUND', 404); assertAccess(this.identity, actor, areaFor(op.action), true);
    return { operationId: op.id, action: op.action, state: op.state, ...op.result };
  }
  async flush(op) {
    const effect = op.recovery?.effects;
    if (effect) { await this.owner.effects(effect); if (effect.events?.length) this.identity.publish(effect.events); }
  }
  async command(actor, action, target = '', input, id, { authenticate } = {}) {
    need(SYSTEM_COMMANDS.includes(action), 'UNKNOWN_SYSTEM_COMMAND', 404); id = operationId(id); text(target, 160);
    fields(input, Object.keys(input || {}));
    actor = this.actor(actor.id); const area = areaFor(action); assertAccess(this.identity, actor, area, true);
    const sig = signature(this.repo.meta('signatureKey'), { action, target, input });
    // Hash off the write queue. Plain secrets never enter a persisted command or receipt.
    const prepared = { ...input };
    if (action === 'account.create' || action === 'account.password') {
      fields(input, action === 'account.create' ? ['expectedRevision','username','password','roleId'] : ['expectedRevision','password']);
      prepared.passwordHash = await hashSecret(input.password); delete prepared.password;
    }
    if (action === 'public.save') {
      fields(input, ['expectedRevision','token']); prepared.tokenHash = await hashSecret(input.token, { min: 16, max: 256 }); delete prepared.token;
    }
    return this.owner.run(async () => {
      if (authenticate) { const state = await authenticate(); need(state.actor.id === actor.id, 'AUTH_CHANGED', 401); }
      actor = this.actor(actor.id); assertAccess(this.identity, actor, area, true);
        const prior = this.repo.operation(id);
      if (prior) {
        need(prior.actorId === actor.id && prior.signature === sig, 'OPERATION_CONFLICT', 409);
        if (prior.state === 'succeeded') { await this.flush(prior); return { operationId: id, state: 'succeeded', ...prior.result, replayed: true }; }
      }
      const op = prior || { id, actorId: actor.id, action, target, signature: sig, createdAt: nowIso() };
      if (asyncActions.has(action)) return this.external(actor, op, prepared);
      const pending = this.repo.db.prepare("SELECT id FROM v2_system_operations WHERE state='pending' AND action LIKE ? LIMIT 1").get(action.split('.')[0]+'.%');
      need(!pending,'OPERATION_PENDING',409,pending ? {operationId:pending.id} : undefined);
      const result = this.repo.transaction(() => {
        // No awaiting between final authority check, domain mutation, audit and receipt.
        actor = this.actor(actor.id); assertAccess(this.identity, actor, area, true);
        const tx = { events: [], changedAccounts: new Set() };
        let result;
        if (action.startsWith('account.') || action.startsWith('role.')) {
          if (action === 'account.cleanup' || action === 'account.batch') revision(input.expectedRevision, this.repo.meta('accounts'));
          result = this.identityAdmin.apply(actor, action, target, prepared, tx); this.repo.bump('accounts');
        } else result = this.apply(actor, action, target, prepared, id);
        const effects = { identity: tx.changedAccounts.size > 0 || action.startsWith('role.'), accounts: [...tx.changedAccounts], events: tx.events,
          settings: ['brand','proxy','api_keys'].includes(area), area, operationId: id };
        const completed = { ...op, state: 'succeeded', result, recovery: { effects } };
        this.repo.saveOperation(completed); this.repo.audit(completed); return completed;
      });
      await this.flush(result);
      return { operationId: id, state: result.state, ...result.result };
    });
  }
  apply(actor, action, target, input, id) {
    const area = areaFor(action), settings = this.repo.settings(), stamp = nowIso();
    if (action === 'storage.export-config') {
      fields(input,['expectedRevision']); revision(input.expectedRevision,this.repo.meta('storage'));
      return { fileName:'system-configuration.json',contentType:'application/json',content:JSON.stringify({schemaVersion:1,exportedAt:nowIso(),
        brand:this.brand(),proxy:this.proxy(),publicApi:this.publicApi(),secrets:'omitted',sources:'owned_by_platform_admin'},null,2) };
    }
    if (action === 'logs.export') {
      fields(input, ['expectedRevision','query']); revision(input.expectedRevision, 0);
      const page = readSystemLogs(this.repo, actor, input.query || {});
      return { fileName: 'system-logs.csv', contentType: 'text/csv', content: logsCSV(page), nextCursor: page.nextCursor, rows: page.items.length, range: page.range };
    }
    if (action.startsWith('brand.upload.')) return this.uploadCommand(actor, action, target, input, id);
    revision(input.expectedRevision, this.repo.meta(area));
    if (action === 'brand.save' || action === 'brand.reset' || action === 'brand.upload') {
      settings.system ||= {};
      if (action === 'brand.upload') {
        fields(input, ['expectedRevision','mimeType','data']);
        // Finish assembles at most 2 MiB; HTTP parts stay below G03's 32 KiB parser.
        need(['image/png','image/jpeg','image/webp','image/gif'].includes(input.mimeType) && typeof input.data === 'string', 'INVALID_IMAGE');
        const b = Buffer.from(input.data, 'base64'); need(b.length > 12 && b.length <= 2 * 1024 * 1024 && b.toString('base64') === input.data, 'INVALID_IMAGE_SIZE');
        const ext = ({ 'image/png': 'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif' })[input.mimeType];
        const valid = ext === 'png' ? b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) : ext === 'jpg' ? b[0] === 255 && b[1] === 216 && b[2] === 255 :
          ext === 'webp' ? b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP' : /^GIF8[79]a/.test(b.subarray(0,6).toString());
        need(valid, 'INVALID_IMAGE');
        const a = this.storage.upload(id, b, ext); a.mimeType = input.mimeType; this.repo.putArtifact(a);
        this.repo.setMeta('logoArtifactId', a.id); this.repo.bump('storage');
        settings.system.teamLogoUrl = `/api/v2/system-admin/brand/logo/${a.id}`;
      } else {
        fields(input, action === 'brand.save' ? ['expectedRevision','teamLogoUrl'] : ['expectedRevision']);
        if (action === 'brand.reset' || input.teamLogoUrl !== settings.system.teamLogoUrl) {
          settings.system.teamLogoUrl = action === 'brand.reset' ? '' : logoUrl(input.teamLogoUrl); this.repo.setMeta('logoArtifactId', null);
        }
      }
      settings.system.teamLogoUpdatedAt = stamp;
    } else if (action === 'proxy.toggle') {
      fields(input, ['expectedRevision','enabled']); need(typeof input.enabled === 'boolean', 'INVALID_PROXY_ENABLED');
      settings.system ||= {}; settings.system.proxy = { ...settings.system.proxy, enabled: input.enabled, updatedAt: stamp };
    } else if (action === 'proxy.select') {
      fields(input, ['expectedRevision','nodeId','scope']); need(['global','battlemetrics','kda'].includes(input.scope), 'INVALID_PROXY_SCOPE');
      const node = this.proxyNodes().find(item => item.id === input.nodeId); need(node, 'PROXY_NODE_UNAVAILABLE', 422);
      settings.system ||= {}; settings.system.proxy = { ...(settings.system.proxy?.enabled === undefined ? {} : { enabled: settings.system.proxy.enabled }), nodeId: node.id, scope: input.scope, updatedAt: stamp };
    } else if (action === 'proxy.save') {
      fields(input, ['expectedRevision','url','scope']); need(['global','battlemetrics','kda'].includes(input.scope), 'INVALID_PROXY_SCOPE');
      settings.system ||= {}; settings.system.proxy = { ...(settings.system.proxy?.enabled === undefined ? {} : { enabled: settings.system.proxy.enabled }), url: proxyUrl(input.url), scope: input.scope, updatedAt: stamp };
    } else if (action === 'public.save' || action === 'public.clear') {
      fields(input, action === 'public.save' ? ['expectedRevision','tokenHash'] : ['expectedRevision']);
      settings.publicApi = { ...settings.publicApi, tokenHash: action === 'public.save' ? input.tokenHash : '', tokenUpdatedAt: stamp };
    } else need(false, 'UNKNOWN_SYSTEM_COMMAND', 404);
    this.repo.saveSettings(settings); this.repo.bump(area);
    return { current: area === 'brand' ? this.brand() : area === 'proxy' ? this.proxy() : this.publicApi() };
  }
  uploadCommand(actor, action, target, input, id) {
    const db = this.repo.db;
    if (action === 'brand.upload.start') {
      fields(input, ['expectedRevision','mimeType','totalBytes']); revision(input.expectedRevision, this.repo.meta('brand'));
      need(['image/png','image/jpeg','image/webp','image/gif'].includes(input.mimeType) && Number.isSafeInteger(input.totalBytes) && input.totalBytes > 12 && input.totalBytes <= 2 * 1024 * 1024, 'INVALID_IMAGE_SIZE');
      need(db.prepare('SELECT count(*) n FROM v2_system_uploads WHERE actor_id=?').get(actor.id).n < 4, 'UPLOAD_CAPACITY', 409);
      db.prepare('INSERT INTO v2_system_uploads VALUES (?,?,?,?,?,?,?)').run(id, actor.id, 1, input.expectedRevision, input.mimeType, input.totalBytes, new Date(Date.now()+3600000).toISOString());
      return { current: { id, revision: 1, brandRevision: input.expectedRevision, partBytes: 18000 } };
    }
    const u = db.prepare('SELECT * FROM v2_system_uploads WHERE id=? AND actor_id=?').get(target, actor.id);
    need(u, 'RESOURCE_NOT_FOUND', 404); revision(input.expectedRevision, u.revision);
    if (action === 'brand.upload.abort') {
      fields(input,['expectedRevision']); db.prepare('DELETE FROM v2_system_upload_parts WHERE upload_id=?').run(target);
      db.prepare('DELETE FROM v2_system_uploads WHERE id=?').run(target); return { aborted: target };
    }
    need(u.expires_at > nowIso(), 'UPLOAD_EXPIRED', 410);
    if (action === 'brand.upload.part') {
      fields(input,['expectedRevision','part','data']); need(Number.isSafeInteger(input.part) && input.part >= 0 && input.part < 117 && typeof input.data === 'string', 'INVALID_UPLOAD_PART');
      const buffer = Buffer.from(input.data,'base64'); need(buffer.length > 0 && buffer.length <= 18000 && buffer.toString('base64') === input.data, 'INVALID_UPLOAD_PART');
      const summary = db.prepare('SELECT count(*) n, coalesce(sum(length(bytes)),0) size FROM v2_system_upload_parts WHERE upload_id=?').get(target);
      need(input.part === summary.n && summary.size+buffer.length <= u.total_bytes, 'UPLOAD_PART_CONFLICT', 409);
      db.prepare('INSERT INTO v2_system_upload_parts VALUES (?,?,?)').run(target,input.part,buffer);
      db.prepare('UPDATE v2_system_uploads SET revision=revision+1 WHERE id=?').run(target);
      return { current: { id: target, revision: u.revision+1, receivedBytes: summary.size+buffer.length } };
    }
    fields(input,['expectedRevision']); revision(u.brand_revision,this.repo.meta('brand'));
    const buffer = Buffer.concat(db.prepare('SELECT bytes FROM v2_system_upload_parts WHERE upload_id=? ORDER BY part').all(target).map(r => Buffer.from(r.bytes)));
    need(buffer.length === u.total_bytes, 'UPLOAD_INCOMPLETE', 409);
    const result = this.apply(actor,'brand.upload','',{ expectedRevision:u.brand_revision,mimeType:u.mime_type,data:buffer.toString('base64') },id);
    db.prepare('DELETE FROM v2_system_upload_parts WHERE upload_id=?').run(target); db.prepare('DELETE FROM v2_system_uploads WHERE id=?').run(target);
    return result;
  }
  async external(actor, op, input) {
    const area = areaFor(op.action);
    if (!op.recovery) {
      this.repo.transaction(() => {
        revision(input.expectedRevision, this.repo.meta(area));
        const active = this.repo.db.prepare("SELECT id FROM v2_system_operations WHERE state='pending' AND action LIKE ? LIMIT 1").get(area + '.%');
        need(!active, 'OPERATION_PENDING', 409, active ? { operationId: active.id } : undefined);
        let artifact;
        if (op.action === 'proxy.probe') {
          fields(input, ['expectedRevision','service']); need(['battlemetrics','kda'].includes(input.service), 'INVALID_PROBE_SERVICE'); need(typeof this.probe === 'function', 'PROBE_ADAPTER_UNAVAILABLE', 503);
        } else if (op.action === 'storage.backup') fields(input, ['expectedRevision']);
        else {
          fields(input, ['expectedRevision','artifactRevision','preview']); artifact = this.repo.artifact(op.target); need(artifact, 'RESOURCE_NOT_FOUND', 404);
          revision(input.artifactRevision, artifact.revision);
          if (op.action === 'storage.quarantine') {
            need(artifact.state === 'active' && this.repo.meta('logoArtifactId', null) !== artifact.id, 'ACTIVE_ARTIFACT_PROTECTED', 409);
            need(input.preview === signature(this.repo.meta('signatureKey'), { actor: actor.id, permissionVersion: actor.permissionVersion, artifact, revision: input.expectedRevision }), 'CLEANUP_PREVIEW_REQUIRED', 409);
          }
          if (op.action === 'storage.recover') need(artifact.state === 'quarantined', 'ARTIFACT_NOT_QUARANTINED', 409);
          if (op.action === 'storage.restore') need(artifact.kind === 'backup' && artifact.state === 'active', 'BACKUP_REQUIRED', 409);
        }
        op.recovery = { artifact, service: input.service, revision: input.expectedRevision };
        op.state = 'pending'; this.repo.saveOperation(op);
      });
    }
    let result;
    try {
      if (op.action === 'storage.backup') result = this.storage.backup(op.id);
      if (op.action === 'storage.restore') result = this.storage.restore(op.id, op.recovery.artifact);
      if (op.action === 'storage.quarantine') result = this.storage.quarantine(op.recovery.artifact);
      if (op.action === 'storage.recover') result = this.storage.recover(op.recovery.artifact);
      if (op.action === 'proxy.probe') {
        // Fixed service target is chosen by the injected provider. No URL comes from this request.
        const raw = await this.probe({ service: op.recovery.service, operationId: op.id, signal: AbortSignal.timeout(10000) });
        need(raw && ['reachable','unreachable','unknown'].includes(raw.status), 'INVALID_PROBE_RESULT', 503);
        result = { service: op.recovery.service, status: raw.status, httpStatus: Number.isInteger(raw.httpStatus) ? raw.httpStatus : null,
          durationMs: Math.max(0, Math.min(10000, Number(raw.durationMs) || 0)), checkedAt: nowIso(), externalAcceptance: false };
      }
    } catch (e) {
      // Durable pending intent: retry same operation to reconcile deterministic file state.
      // Never expose filesystem paths/upstream errors/credentials.
      throw new SystemError(e instanceof SystemError ? e.errorCode : 'SYSTEM_ACTION_UNCERTAIN', 503, { operationId: op.id });
    }
    this.repo.transaction(() => {
      if (area === 'storage') { this.repo.putArtifact(result); op.result = { current: artifactDTO(result), revision: this.repo.bump('storage') }; }
      else { this.repo.setMeta('lastProbe', result); op.result = { current: result, revision: this.repo.bump('proxy') }; }
      op.state = 'succeeded'; op.recovery.effects = { area, operationId: op.id, identity: false, settings: false };
      this.repo.saveOperation(op); this.repo.audit(op);
    });
    await this.flush(op);
    return { operationId: op.id, state: op.state, ...op.result };
  }
  async recoverOperation(actor, id, { authenticate } = {}) {
    id = operationId(id);
    return this.owner.run(async () => {
      if (authenticate) { const state = await authenticate(); need(state.actor.id === actor.id, 'AUTH_CHANGED', 401); }
      actor = this.actor(actor.id); const op = this.repo.operation(id);
      need(op && op.actorId === actor.id, 'RESOURCE_NOT_FOUND', 404);
      assertAccess(this.identity, actor, areaFor(op.action), true);
      if (op.state === 'succeeded') { await this.flush(op); return {operationId:id,state:op.state,...op.result,replayed:true}; }
      need(asyncActions.has(op.action) && op.recovery, 'COMMAND_RETRY_REQUIRED', 409);
      return this.external(actor,op,{});
    });
  }
  preview(actor, id) {
    actor = this.actor(actor.id); assertAccess(this.identity, actor, 'storage', true);
    const artifact = this.repo.artifact(id); need(artifact, 'RESOURCE_NOT_FOUND', 404);
    need(artifact.state === 'active' && this.repo.meta('logoArtifactId', null) !== id, 'ACTIVE_ARTIFACT_PROTECTED', 409);
    return { artifact: artifactDTO(artifact), revision: this.repo.meta('storage'), effect: 'move_to_recoverable_quarantine',
      preview: signature(this.repo.meta('signatureKey'), { actor: actor.id, permissionVersion: actor.permissionVersion, artifact, revision: this.repo.meta('storage') }) };
  }
  async verifyPublicToken(token) {
    const encoded = this.repo.settings().publicApi?.tokenHash || '', [scheme, salt, hash] = encoded.split('$');
    if (scheme !== 'scrypt' || !salt || !hash || typeof token !== 'string' || token.length > 256) return false;
    const actual = await promisify(scrypt)(token, salt, 64), expected = Buffer.from(hash, 'hex');
    // Re-read configuration after scrypt; a concurrent clear/rotation wins.
    return this.repo.settings().publicApi?.tokenHash === encoded && actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
