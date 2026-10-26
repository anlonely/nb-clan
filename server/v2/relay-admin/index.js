import { hashPassword, runStoreWriteTask, patchStoreCache as originalPatchStoreCache } from '../../store.js';
import { assertRelayAccess, relayAccess } from './access.js';
import { RelayAdminRepository } from './repository.js';
import { need, normalizeInput, operationId, signature, safeError, RelayAdminError } from './model.js';
import { createRustgoWebApiConfig } from './web-api-config.js';
export { installRelayAdminSchema } from './repository.js';
export { createRelayAdminRouter } from './routes.js';
/** One canonical settings owner: original queue + same SQLite. No timers, auth cache, network or implicit migration. */
export function createRelayAdmin({ identity, invalidateRelayAuthCache, patchStoreCache = originalPatchStoreCache, hashToken = hashPassword, webApiOptions = {} } = {}) {
  need(identity?.repo?.db && typeof patchStoreCache === 'function' && typeof hashToken === 'function', 'RELAY_ADMIN_HOST_REQUIRED', 503);
  const repo = new RelayAdminRepository(identity.repo.db), pending = new Set(), activeOperations = new Map(); let started = false, accepting = false;
  const webApi = createRustgoWebApiConfig({ ...webApiOptions, identity });
  const ready = () => need(accepting, 'RELAY_ADMIN_STOPPED', 503);
  const currentActor = (actor, mutation = false) => { ready(); return assertRelayAccess(identity, actor, mutation); };
  function invalidate() {
    need(typeof invalidateRelayAuthCache === 'function', 'RELAY_AUTH_INVALIDATOR_REQUIRED', 503);
    try { const value = invalidateRelayAuthCache(); if (value?.then) Promise.resolve(value).catch(() => {}); need(value === undefined, 'RELAY_AUTH_INVALIDATION_FAILED', 503); }
    catch { throw new RelayAdminError('RELAY_AUTH_INVALIDATION_FAILED', 503); }
  }
  const snapshot = settings => {
    const relay = settings.rustplusRelay || {}, configured = typeof relay.tokenHash === 'string' && Boolean(relay.tokenHash);
    const date = typeof relay.tokenUpdatedAt === 'string' && Number.isFinite(Date.parse(relay.tokenUpdatedAt)) ? new Date(relay.tokenUpdatedAt).toISOString() : null;
    return { configured, masked: configured ? '********' : '', tokenUpdatedAt: date, revision: repo.revision(settings) };
  };
  function track(fn) {
    ready(); need(pending.size < 16, 'RELAY_ADMIN_BUSY', 429);
    const task = Promise.resolve().then(fn).catch(error => { throw safeError(error); }); pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  const queued = fn => runStoreWriteTask(async () => { try { ready(); return await fn(); } catch (e) { throw safeError(e); } });
  const receipt = (op, cacheState = 'not_checked') => ({ operationId: op.id, action: op.action, state: cacheState === 'refreshed' ? 'succeeded' : 'committed', ...op.result, cacheState });
  function ownOperation(actor, id) {
    const op = repo.operation(id);
    if (!op && activeOperations.get(id)?.actorId === actor.id) throw new RelayAdminError('OPERATION_IN_PROGRESS', 503);
    need(op?.actorId === actor.id, 'RESOURCE_NOT_FOUND', 404); return op;
  }
  async function reauthenticate(actor, authenticate, scope) {
    if (authenticate) { const state = await authenticate(); need(state?.actor?.id === actor.id && state.actor.permissionVersion === actor.permissionVersion, 'AUTH_CHANGED', 401); }
    actor = currentActor(actor, true); need(identity.scopeDigest(actor) === scope, 'AUTH_CHANGED', 401); return actor;
  }
  async function flush() {
    const settings = repo.settings(); invalidate();
    try { await patchStoreCache(store => { store.settings = structuredClone(settings); }); }
    catch { throw new RelayAdminError('CACHE_REFRESH_REQUIRED', 503); }
  }
  const service = {
    identity, repo, webApi,
    start() { need(!started, 'RELAY_ADMIN_ALREADY_STARTED', 503); webApi.start(); started = true; accepting = true; },
    async stop() { accepting = false; await Promise.allSettled([webApi.stop(), ...pending]); },
    diagnostics() { return { accepting, pending: pending.size }; },
    read(actor) {
      actor = currentActor(actor); const permission = relayAccess(identity, actor, true);
      return { ...snapshot(repo.settings()), canWrite: permission.allowed && typeof invalidateRelayAuthCache === 'function', authorizationSource: permission.source,
        readAuthorizationSource: relayAccess(identity, actor).source, authInvalidatorReady: typeof invalidateRelayAuthCache === 'function', endpoint: '/api/integrations/rustplus/relay', tokenMinLength: 16, tokenMaxLength: 256 };
    },
    getOperation(actor, id) { actor = currentActor(actor, true); return receipt(ownOperation(actor, operationId(id))); },
    command(actor, action, input, id, { authenticate } = {}) {
      actor = currentActor(actor, true); need(typeof invalidateRelayAuthCache === 'function', 'RELAY_AUTH_INVALIDATOR_REQUIRED', 503);
      input = normalizeInput(action, input); id = operationId(id);
      const scope = identity.scopeDigest(actor), actorId = actor.id, sig = signature(repo.signatureKey, { actorId, action, input });
      const active = activeOperations.get(id);
      if (active) { need(active.actorId === actorId && active.signature === sig, 'OPERATION_CONFLICT', 409); throw new RelayAdminError('OPERATION_IN_PROGRESS', 503); }
      ready(); need(pending.size < 16, 'RELAY_ADMIN_BUSY', 429); activeOperations.set(id, { actorId, signature: sig });
      return track(async () => {
        // Expensive original scrypt is outside both the SQLite transaction and the global queue.
        const previous = repo.operation(id);
        if (previous) need(previous.actorId === actorId && previous.signature === sig, 'OPERATION_CONFLICT', 409);
        let tokenHash = !previous && action === 'save' ? await hashToken(input.token) : null;
        input = { expectedRevision: input.expectedRevision }; // Discard the plaintext once hashing finishes.
        return queued(async () => {
          actor = await reauthenticate(actor, authenticate, scope);
          const prior = repo.operation(id);
          if (prior) { need(prior.actorId === actorId && prior.signature === sig, 'OPERATION_CONFLICT', 409); await flush(); return { ...receipt(prior, 'refreshed'), replayed: true }; }
          need(action !== 'save' || typeof tokenHash === 'string' && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(tokenHash), 'RELAY_HASH_FAILED', 503);
          const op = repo.transaction(() => {
            currentActor(actor, true); need(identity.scopeDigest(actor) === scope, 'AUTH_CHANGED', 401);
            const settings = repo.settings(); need(input.expectedRevision === repo.revision(settings), 'REVISION_CONFLICT', 409);
            need(settings.rustplusRelay === undefined || settings.rustplusRelay && typeof settings.rustplusRelay === 'object' && !Array.isArray(settings.rustplusRelay), 'RELAY_ADMIN_INVALID_SETTINGS', 503);
            settings.rustplusRelay ||= {}; const relay = settings.rustplusRelay, now = new Date().toISOString();
            relay.tokenHash = action === 'save' ? tokenHash : ''; relay.tokenUpdatedAt = action === 'save' ? now : '';
            if (action === 'save') relay.lastError = '';
            repo.saveSettings(settings); repo.advanceRevision();
            const op = { id, actorId, permissionVersion: actor.permissionVersion, action, signature: sig, result: snapshot(settings) };
            repo.saveOperation(op, now);
            // Synchronous invalidation precedes commit, with no await/interleaving. Failure rolls back; never restore an old cache.
            invalidate(); return op;
          });
          tokenHash = null; await flush(); return receipt(op, 'refreshed');
        });
      }).finally(() => activeOperations.delete(id));
    },
    recover(actor, id, { authenticate } = {}) {
      actor = currentActor(actor, true); id = operationId(id); const scope = identity.scopeDigest(actor);
      return track(() => queued(async () => { actor = await reauthenticate(actor, authenticate, scope); const op = ownOperation(actor, id); await flush(); return { ...receipt(op, 'refreshed'), replayed: true }; }));
    }
  };
  return Object.freeze(service);
}
