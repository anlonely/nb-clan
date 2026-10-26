import { runStoreWriteTask as originalRunStoreWriteTask } from '../../store.js';
import { assertRelayAccess, relayAccess } from './access.js';
import { fields, need, operationId, RelayAdminError, safeError, signature } from './model.js';
import { RelayAdminRepository } from './repository.js';
import { createRustgoWebApiClient, normalizeRustgoConnection } from './web-api-client.js';

const scalarKey = 'v2RustgoWebApi';
const action = 'web-api-save';
const emptyConfig = () => ({ revision: 0, baseUrl: '', tenantId: '', apiKey: '', serverIds: [], infoEnabled: false, chatEnabled: false,
  lastOperationId: null, updatedAt: null, chatStartAt: null, serverActivatedAt: {} });
const publicConfig = config => ({ revision: config.revision, baseUrl: config.baseUrl, tenantId: config.tenantId,
  apiKeyConfigured: Boolean(config.apiKey), serverIds: [...config.serverIds], infoEnabled: config.infoEnabled,
  chatEnabled: config.chatEnabled, lastOperationId: config.lastOperationId || null });

function connectionInput(input) {
  need(typeof input.baseUrl === 'string' && (input.tenantId === undefined || typeof input.tenantId === 'string'), 'WEB_API_INVALID_CONNECTION');
  need(input.apiKey === undefined || typeof input.apiKey === 'string', 'WEB_API_INVALID_API_KEY');
  return normalizeRustgoConnection({ baseUrl: input.baseUrl, tenantId: input.tenantId || '', apiKey: input.apiKey || '' });
}

function saveInput(input) {
  fields(input, ['expectedRevision', 'baseUrl', 'tenantId', 'apiKey', 'clearApiKey', 'serverIds', 'infoEnabled', 'chatEnabled']);
  need(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'EXPECTED_REVISION_REQUIRED');
  need(typeof input.infoEnabled === 'boolean' && typeof input.chatEnabled === 'boolean', 'WEB_API_INVALID_SWITCH');
  need(input.clearApiKey === undefined || typeof input.clearApiKey === 'boolean', 'WEB_API_INVALID_API_KEY');
  need(Array.isArray(input.serverIds) && input.serverIds.length <= 20 && input.serverIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)), 'WEB_API_INVALID_SERVER_IDS');
  const connection = connectionInput(input);
  need(!input.clearApiKey || !connection.apiKey, 'WEB_API_INVALID_API_KEY');
  return { expectedRevision: input.expectedRevision, ...connection, clearApiKey: Boolean(input.clearApiKey),
    serverIds: [...new Set(input.serverIds)], infoEnabled: input.infoEnabled, chatEnabled: input.chatEnabled };
}

function resolveConnection(input, current) {
  const changed = input.baseUrl !== current.baseUrl || input.tenantId !== current.tenantId;
  need(!(changed && current.apiKey && !input.apiKey && !input.clearApiKey), 'WEB_API_NEW_KEY_REQUIRED');
  return { baseUrl: input.baseUrl, tenantId: input.tenantId, apiKey: input.clearApiKey ? '' : input.apiKey || current.apiKey };
}

function requireConnection(config) {
  need(config.baseUrl && config.apiKey, 'WEB_API_CONNECTION_REQUIRED');
}

/** Independent scalar; API credentials never enter the legacy settings cache or operation receipts. */
export function createRustgoWebApiConfig({ identity, runStoreWriteTask = originalRunStoreWriteTask,
  discoverServers = config => createRustgoWebApiClient().listServers(config), readStatus = () => ({ state: 'unavailable' }) } = {}) {
  need(identity?.repo?.db && typeof runStoreWriteTask === 'function' && typeof discoverServers === 'function' && typeof readStatus === 'function', 'RELAY_ADMIN_HOST_REQUIRED', 503);
  const repo = new RelayAdminRepository(identity.repo.db), pending = new Set(), activeOperations = new Map();
  let started = false, accepting = false, discovering = 0;
  const ready = () => need(accepting, 'RELAY_ADMIN_STOPPED', 503);
  const currentActor = (actor, mutation = false) => { ready(); return assertRelayAccess(identity, actor, mutation); };
  const readPrivate = () => {
    const raw = identity.repo.scalar(scalarKey);
    if (raw === undefined || raw === null) return emptyConfig();
    need(raw && Object.getPrototypeOf(raw) === Object.prototype && Number.isSafeInteger(raw.revision) && raw.revision >= 0 &&
      typeof raw.baseUrl === 'string' && typeof raw.tenantId === 'string' && typeof raw.apiKey === 'string' &&
      Array.isArray(raw.serverIds) && raw.serverIds.length <= 20 && raw.serverIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) &&
      typeof raw.infoEnabled === 'boolean' && typeof raw.chatEnabled === 'boolean', 'RELAY_ADMIN_INVALID_SETTINGS', 503);
    return structuredClone(raw);
  };
  const status = () => { try { return readStatus(); } catch { return { state: 'unavailable' }; } };
  const dto = (config, actor) => ({ ...publicConfig(config), canWrite: relayAccess(identity, actor, true).allowed, status: status() });
  const receipt = (op, actor, replayed = false) => ({ ...op.result, operationId: op.id, action: op.action, state: 'succeeded',
    replayed, canWrite: relayAccess(identity, actor, true).allowed, status: status() });
  function track(fn) {
    ready(); need(pending.size < 16, 'RELAY_ADMIN_BUSY', 429);
    const task = Promise.resolve().then(fn).catch(error => { throw safeError(error); }); pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  async function reauthenticate(actor, authenticate, scope) {
    if (authenticate) {
      const state = await authenticate();
      need(state?.actor?.id === actor.id && state.actor.permissionVersion === actor.permissionVersion, 'AUTH_CHANGED', 401);
    }
    actor = currentActor(actor, true); need(identity.scopeDigest(actor) === scope, 'AUTH_CHANGED', 401); return actor;
  }
  return Object.freeze({
    start() { need(!started, 'RELAY_ADMIN_ALREADY_STARTED', 503); started = true; accepting = true; },
    async stop() { accepting = false; await Promise.allSettled([...pending]); },
    readPrivate,
    read(actor) { actor = currentActor(actor); return dto(readPrivate(), actor); },
    getOperation(actor, id) {
      actor = currentActor(actor, true); id = operationId(id);
      const op = repo.operation(id);
      if (!op && activeOperations.get(id)?.actorId === actor.id) throw new RelayAdminError('OPERATION_IN_PROGRESS', 503);
      need(op?.actorId === actor.id && op.action === action, 'RESOURCE_NOT_FOUND', 404);
      return receipt(op, actor);
    },
    save(actor, input, id, { authenticate } = {}) {
      actor = currentActor(actor, true); input = saveInput(input); id = operationId(id);
      const actorId = actor.id, scope = identity.scopeDigest(actor), sig = signature(repo.signatureKey, { actorId, action, input });
      const active = activeOperations.get(id);
      if (active) { need(active.actorId === actorId && active.signature === sig, 'OPERATION_CONFLICT', 409); throw new RelayAdminError('OPERATION_IN_PROGRESS', 503); }
      ready(); need(pending.size < 16, 'RELAY_ADMIN_BUSY', 429); activeOperations.set(id, { actorId, signature: sig });
      return track(() => runStoreWriteTask(async () => {
        actor = await reauthenticate(actor, authenticate, scope);
        const previous = repo.operation(id);
        if (previous) {
          need(previous.actorId === actorId && previous.action === action && previous.signature === sig, 'OPERATION_CONFLICT', 409);
          return receipt(previous, actor, true);
        }
        const op = repo.transaction(() => {
          actor = currentActor(actor, true); need(identity.scopeDigest(actor) === scope, 'AUTH_CHANGED', 401);
          const current = readPrivate(); need(current.revision === input.expectedRevision, 'REVISION_CONFLICT', 409);
          need(current.revision < Number.MAX_SAFE_INTEGER, 'RELAY_ADMIN_INVALID_SETTINGS', 503);
          const connection = resolveConnection(input, current);
          if (input.clearApiKey) need(!input.infoEnabled && !input.chatEnabled, 'WEB_API_DISABLE_BEFORE_CLEAR');
          if (input.infoEnabled || input.chatEnabled) {
            requireConnection(connection); need(input.serverIds.length > 0, 'WEB_API_SERVER_REQUIRED');
          }
          const now = new Date().toISOString(), targetChanged = connection.baseUrl !== current.baseUrl || connection.tenantId !== current.tenantId || connection.apiKey !== current.apiKey;
          const config = { ...connection, revision: current.revision + 1, serverIds: input.serverIds,
            infoEnabled: input.infoEnabled, chatEnabled: input.chatEnabled, lastOperationId: id, updatedAt: now,
            chatStartAt: input.chatEnabled && (!current.chatEnabled || targetChanged) ? now : current.chatStartAt || null,
            serverActivatedAt: Object.fromEntries(input.serverIds.map(serverId => [serverId,
              !targetChanged && current.serverIds.includes(serverId) && current.serverActivatedAt?.[serverId] || now])) };
          identity.repo.setScalar(scalarKey, config);
          const op = { id, actorId, permissionVersion: actor.permissionVersion, action, signature: sig, result: publicConfig(config) };
          repo.saveOperation(op, now); return op;
        });
        return receipt(op, actor);
      })).finally(() => activeOperations.delete(id));
    },
    servers(actor, input, { authenticate } = {}) {
      actor = currentActor(actor, true); fields(input, ['baseUrl', 'tenantId', 'apiKey']);
      const connection = resolveConnection(connectionInput(input), readPrivate()); requireConnection(connection);
      const scope = identity.scopeDigest(actor); need(discovering < 2 && pending.size < 16, 'RELAY_ADMIN_BUSY', 429); discovering++;
      return track(async () => {
        actor = await reauthenticate(actor, authenticate, scope);
        const result = await discoverServers(connection);
        await reauthenticate(actor, authenticate, scope);
        return result;
      }).finally(() => { discovering--; });
    }
  });
}
