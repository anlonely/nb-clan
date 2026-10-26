import { ApiError } from '../query-client.js';
import { notifySuccess } from '../toast-store.js';

const PREFIX = 'nb-g06-operation:';
const stores = new WeakMap(), internals = new WeakMap();
const EMPTY_STATE = Object.freeze({ status: 'idle', current: null, operationReceipt: null, error: null, replayed: false });
const EMPTY_SNAPSHOT = Object.freeze({ operation: null, state: EMPTY_STATE });
const unresolved = state => ['submitting', 'unknown'].includes(state?.status);
const conflicts = new Set(['CONTENT_RECONFIRM_REQUIRED', 'REVISION_CONFLICT', 'PREVIEW_STALE', 'PREVIEW_EXPIRED']);
const cancelled = new Set(['REQUEST_SUPERSEDED', 'AUTH_REQUIRED', 'PERMISSIONS_CHANGED', 'AUTHORIZATION_REVOKED', 'SESSION_REVOKED']);
const uncertain = new Set(['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE', 'REQUEST_CANCELLED', 'INVALID_RESPONSE', 'OPERATION_PENDING', 'OPERATION_RECEIPT_EXPIRED']);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const storageError = () => new ApiError('ADMIN_OPERATION_STORAGE_UNAVAILABLE', { message: '浏览器无法保存操作恢复记录。请允许本站使用会话存储后重试；本次请求尚未发出。' });
function storage() { try { const value = globalThis.sessionStorage; if (!value) throw new Error(); return value; } catch { throw storageError(); } }
function identityFor(client) {
  const identity = client.getIdentity();
  if (!identity?.accountId || identity.scopeVersion == null) throw new ApiError('AUTH_REQUIRED', { status: 401 });
  return { accountId: identity.accountId, scopeVersion: identity.scopeVersion };
}
const scopePrefix = identity => `${PREFIX}${encodeURIComponent(identity.accountId)}:${encodeURIComponent(String(identity.scopeVersion))}:`;
function slotKey(client, slot) {
  if (typeof slot !== 'string' || !slot || slot.length > 300 || /[\u0000-\u001f\u007f]/.test(slot)) throw new ApiError('INVALID_OPERATION_SLOT');
  return `${scopePrefix(identityFor(client))}${encodeURIComponent(slot)}`;
}
function purgeForeign(client) {
  const target = storage(), prefix = scopePrefix(identityFor(client));
  for (let i = target.length - 1; i >= 0; i--) {
    const key = target.key(i); if (key?.startsWith(PREFIX) && !key.startsWith(prefix)) target.removeItem(key);
  }
}
function forget(key) { try { storage().removeItem(key); } catch { /* A stale journal can only restore to unknown, never auto-send. */ } }
function storeFor(client) {
  if (!stores.has(client)) {
    const store = { slots: new Map(), listeners: new Set(), operations: new Set() }; stores.set(client, store);
    client.subscribeIdentity(() => {
      // Logout, permission generation changes and account switching fence every
      // slot, including operations belonging to a page that is no longer mounted.
      try { const target = storage(); for (let i = target.length - 1; i >= 0; i--) { const key = target.key(i); if (key?.startsWith(PREFIX)) target.removeItem(key); } } catch { /* Never replay while signed out. */ }
      for (const operation of [...store.operations]) internals.get(operation)?.cancel();
      store.slots.clear();
      for (const listener of store.listeners) listener();
    });
  }
  return stores.get(client);
}
function notify(client, operation) {
  const store = storeFor(client), details = internals.get(operation);
  if (details?.slot && store.slots.get(details.slot)?.operation === operation) {
    store.slots.set(details.slot, Object.freeze({ operation, state: operation.getState() }));
    for (const listener of store.listeners) listener();
  }
}
function noCredentials(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:csrf|csrftoken|cookie|authorization|token|accesstoken|refreshtoken|password|privatetoken|controltoken)$/i.test(key.replace(/[-_]/g, ''))) throw new ApiError('ADMIN_OPERATION_SECRET_NOT_ALLOWED');
    noCredentials(child);
  }
}
function validOptions({ path, method, domain, operationId, body }) {
  if (!['scheduling', 'notifications'].includes(domain)) throw new ApiError('INVALID_OPERATION_DOMAIN');
  if (typeof path !== 'string' || !path.startsWith('/api/v2/') || /[\\?#\u0000-\u0020]/.test(path) || new URL(path, 'https://admin.invalid').pathname !== path) throw new ApiError('INVALID_API_PATH');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ApiError('INVALID_OPERATION_METHOD');
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(operationId)) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
  if (!object(body)) throw new ApiError('INVALID_ADMIN_OPERATION');
  noCredentials(body);
}
function saveJournal(client, slot, operation, status = operation.getState().status) {
  const details = internals.get(operation), identity = identityFor(client);
  if (!details?.active() || details.client !== client) throw new ApiError('REQUEST_SUPERSEDED');
  const record = { version: 1, ...identity, slot, operationId: operation.operationId, path: operation.path, method: operation.method,
    domain: operation.domain, body: details.serialized(), timeoutMs: details.timeoutMs, status, keyConflict: details.keyConflict() };
  try { purgeForeign(client); storage().setItem(slotKey(client, slot), JSON.stringify(record)); }
  catch (error) { if (error instanceof ApiError && error.errorCode !== 'ADMIN_OPERATION_STORAGE_UNAVAILABLE') throw error; throw storageError(); }
}

// The journal contains only an immutable command, never the session/CSRF token,
// authority cache, or returned private data. Only sessionStorage is used.
export function persistAdminOperation(client, slot, operation) {
  const store = storeFor(client), details = internals.get(operation), existing = store.slots.get(slot)?.operation;
  slotKey(client, slot);
  if (!details || details.client !== client || !details.active()) throw new ApiError('REQUEST_SUPERSEDED');
  if (existing && existing !== operation && unresolved(existing.getState())) throw new ApiError('ADMIN_OPERATION_PENDING');
  saveJournal(client, slot, operation);
  if (details.slot && details.slot !== slot) {
    if (store.slots.get(details.slot)?.operation === operation) store.slots.delete(details.slot);
    forget(slotKey(client, details.slot));
  }
  if (existing && existing !== operation) existing.dispose();
  details.slot = slot;
  store.slots.set(slot, Object.freeze({ operation, state: operation.getState() }));
  for (const listener of store.listeners) listener();
  return operation;
}

export function getAdminOperationSnapshot(client, slot) { return storeFor(client).slots.get(slot) || EMPTY_SNAPSHOT; }
export function subscribeAdminOperations(client, listener) {
  const store = storeFor(client); store.listeners.add(listener); return () => store.listeners.delete(listener);
}
export function clearAdminOperation(client, slot) {
  const store = storeFor(client), operation = store.slots.get(slot)?.operation;
  if (operation && unresolved(operation.getState())) return false;
  // A caller must restore a journal before it can dismiss it. This prevents an
  // unmounted/refreshing page from accidentally deleting an unknown operation.
  if (!operation) {
    try { if (storage().getItem(slotKey(client, slot))) return false; } catch { return false; }
    return true;
  }
  forget(slotKey(client, slot)); operation.dispose(); return true;
}

export function createAdminOperation(client, { path, method = 'POST', body, domain = 'scheduling', operationId = globalThis.crypto.randomUUID(), timeoutMs } = {}) {
  identityFor(client); method = typeof method === 'string' ? method.toUpperCase() : method;
  validOptions({ path, method, domain, operationId, body });
  const generation = client.getGeneration(), store = storeFor(client), listeners = new Set();
  let serializedBody;
  try { serializedBody = JSON.stringify(body); } catch { throw new ApiError('INVALID_ADMIN_OPERATION'); }
  let immutableBody = freeze(JSON.parse(serializedBody)), state = EMPTY_STATE, pending = null, disposed = false, keyConflict = false;
  const active = () => !disposed && generation === client.getGeneration() && serializedBody !== null;
  const emit = patch => {
    state = Object.freeze({ ...state, ...patch }); notify(client, operation);
    for (const listener of listeners) listener(); return state;
  };
  function record(status) {
    const details = internals.get(operation);
    if (!details.slot) persistAdminOperation(client, `operation:${operationId}`, operation);
    saveJournal(client, details.slot, operation, status);
  }
  function finish(patch) {
    const next = emit(patch), details = internals.get(operation);
    if (unresolved(next)) { try { record(next.status); } catch { /* Pre-send journal already preserves the command as unknown. */ } }
    else if (details.slot) forget(slotKey(client, details.slot));
    return next;
  }
  function run(reconcile = false) {
    if (!active()) return Promise.resolve(state);
    if (pending) return pending;
    if (!['idle', 'unknown'].includes(state.status) && !(state.status === 'failed' && state.error?.errorCode === 'ADMIN_OPERATION_STORAGE_UNAVAILABLE')) return Promise.resolve(state);
    // Write the durable unknown marker BEFORE invoking the transport. A refresh
    // between these two instructions is harmless and requires a manual check.
    if (!reconcile) {
      try { record('unknown'); }
      catch (error) { return Promise.resolve(emit({ status: unresolved(state) ? 'unknown' : 'failed', error })); }
    }
    const hadUnknown = state.status === 'unknown';
    // Install the shared promise before notifying synchronous subscribers.
    let resolvePending; pending = new Promise(resolve => { resolvePending = resolve; }); const flight = pending;
    emit({ status: reconcile ? 'unknown' : 'submitting', error: null });
    (async () => {
      try {
        const receiptPath = domain === 'notifications' ? '/api/v2/notifications/operations/' : '/api/v2/operations/';
        const envelope = await client.request(reconcile ? `${receiptPath}${encodeURIComponent(operationId)}` : path,
          reconcile ? { timeoutMs } : { method, body: serializedBody, headers: { 'Idempotency-Key': operationId }, timeoutMs });
        if (!active()) return state;
        const data = envelope?.data, receipt = data?.operationReceipt;
        if (!object(data?.current) || !object(receipt) || receipt.operationId !== operationId ||
          typeof receipt.action !== 'string' || !receipt.action || !Number.isFinite(Date.parse(receipt.committedAt)) || typeof data.replayed !== 'boolean') {
          return finish({ status: 'unknown', error: new ApiError('INVALID_RESPONSE', { retryable: true }) });
        }
        // A colliding key proves a different command may already exist. Its
        // receipt must not be mistaken for acceptance of this frozen body.
        if (keyConflict) return finish({ status: 'unknown', current: data.current, operationReceipt: receipt,
          replayed: data.replayed, error: new ApiError('IDEMPOTENCY_CONFLICT', { status: 409 }) });
        notifySuccess('保存成功', { id: operationId });
        return finish({ status: 'committed', current: data.current, operationReceipt: receipt, replayed: data.replayed, error: null });
      } catch (error) {
        if (!active()) return state;
        if (error.errorCode === 'IDEMPOTENCY_CONFLICT') { keyConflict = true; return finish({ status: 'unknown', error }); }
        if (cancelled.has(error.errorCode)) return finish({ status: 'cancelled', current: null, error });
        if (reconcile || error.status >= 500 || error.status === 202 || uncertain.has(error.errorCode) ||
          (hadUnknown && [401, 403].includes(error.status))) return finish({ status: 'unknown', error });
        if (conflicts.has(error.errorCode)) return finish({ status: 'conflict', current: error.current || null, error });
        return finish({ status: 'failed', error });
      }
    })().then(result => { pending = null; resolvePending(result); }, error => { pending = null; resolvePending(active() ? finish({ status: 'unknown', error }) : state); });
    return flight;
  }
  const operation = Object.freeze({ operationId, path, method, domain, get body() { return immutableBody; }, getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit: () => run(), retry: () => run(), reconcile: () => run(true),
    dispose() {
      if (disposed) return;
      disposed = true; serializedBody = null; immutableBody = null; store.operations.delete(operation);
      const slot = internals.get(operation).slot;
      if (slot && store.slots.get(slot)?.operation === operation) { store.slots.delete(slot); for (const listener of store.listeners) listener(); }
      state = Object.freeze({ ...EMPTY_STATE, status: 'cancelled' }); listeners.clear();
    }
  });
  internals.set(operation, { client, active, timeoutMs, serialized: () => serializedBody, keyConflict: () => keyConflict,
    restore(conflict) { keyConflict = conflict; emit({ status: 'unknown', error: new ApiError(conflict ? 'IDEMPOTENCY_CONFLICT' : 'ADMIN_OPERATION_RESTORED', { retryable: true }) }); },
    cancel() { serializedBody = null; immutableBody = null; emit({ ...EMPTY_STATE, status: 'cancelled', error: new ApiError('REQUEST_SUPERSEDED') }); store.operations.delete(operation); }
  });
  store.operations.add(operation); return operation;
}

export function restoreAdminOperation(client, slot) {
  const existing = getAdminOperationSnapshot(client, slot).operation; if (existing) return existing;
  if (!client.getIdentity()?.accountId) return null;
  const key = slotKey(client, slot); let raw;
  try { purgeForeign(client); raw = storage().getItem(key); } catch { return null; }
  if (!raw) return null;
  let record, operation;
  try {
    record = JSON.parse(raw); const identity = identityFor(client);
    if (record.version !== 1 || record.accountId !== identity.accountId || record.scopeVersion !== identity.scopeVersion ||
      record.slot !== slot || typeof record.body !== 'string' || !['idle', 'submitting', 'unknown'].includes(record.status)) throw new Error();
    const body = JSON.parse(record.body);
    if (JSON.stringify(body) !== record.body) throw new Error();
    operation = createAdminOperation(client, { ...record, body });
  } catch { forget(key); return null; }
  const store = storeFor(client), details = internals.get(operation); details.slot = slot;
  store.slots.set(slot, Object.freeze({ operation, state: operation.getState() }));
  details.restore(record.keyConflict === true); return operation;
}

// Call from an effect or an explicit action, never while rendering: restoring a
// journal notifies the same store observed by the page-specific operation hook.
// Enumeration itself does not issue a request or submit any restored command.
export function listPendingAdminOperations(client) {
  if (!client.getIdentity()?.accountId) return [];
  const store = storeFor(client), slots = new Set(store.slots.keys());
  try {
    purgeForeign(client); const target = storage(), prefix = scopePrefix(identityFor(client));
    for (let i = target.length - 1; i >= 0; i--) {
      const key = target.key(i);
      if (key?.startsWith(prefix)) {
        try { slots.add(decodeURIComponent(key.slice(prefix.length))); } catch { forget(key); }
      }
    }
  } catch { /* In-memory pending commands remain accessible if storage is blocked. */ }
  for (const slot of slots) {
    try { restoreAdminOperation(client, slot); } catch { /* An invalid slot cannot be replayed. */ }
  }
  return [...store.slots].filter(([, snapshot]) => unresolved(snapshot.state))
    .map(([slot, snapshot]) => ({ slot, operation: snapshot.operation })).sort((a, b) => a.slot.localeCompare(b.slot));
}
