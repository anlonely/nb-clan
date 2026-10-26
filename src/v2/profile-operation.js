import { ApiError } from './query-client.js';

const stores = new WeakMap();
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const unresolved = state => ['submitting', 'unknown'].includes(state?.status);
function storeFor(client) {
  if (!stores.has(client)) {
    const store = { operation: null }; stores.set(client, store);
    client.subscribeIdentity(() => { store.operation?.dispose(); store.operation = null; });
  }
  return stores.get(client);
}
export const getProfileOperation = client => storeFor(client).operation;
export function dismissProfileOperation(client, operation) {
  const store = storeFor(client);
  if (store.operation !== operation || unresolved(operation?.getState())) return false;
  operation?.dispose(); store.operation = null; return true;
}

// A profile operation survives route changes in memory, but never logout/account
// changes. Its immutable payload and key are kept until a definitive result.
export function createProfileOperation(client, { body, operationId = globalThis.crypto.randomUUID(), timeoutMs, onCommitted = () => {} }) {
  if (!client.getIdentity()) throw new ApiError('AUTH_REQUIRED', { status: 401 });
  const store = storeFor(client);
  if (unresolved(store.operation?.getState())) throw new ApiError('PROFILE_OPERATION_PENDING');
  store.operation?.dispose();
  const generation = client.getGeneration(), listeners = new Set();
  let serializedBody = JSON.stringify(body), immutableBody = freeze(JSON.parse(serializedBody)), pending = null, disposed = false;
  let state = Object.freeze({ status: 'idle', current: null, operationReceipt: null, error: null, replayed: false });
  const emit = patch => { state = Object.freeze({ ...state, ...patch }); for (const listener of listeners) listener(); return state; };
  const active = () => !disposed && generation === client.getGeneration() && store.operation === operation;
  function run() {
    if (!active()) return Promise.resolve(state);
    if (pending) return pending;
    if (!['idle', 'unknown'].includes(state.status)) return Promise.resolve(state);
    emit({ status: 'submitting', error: null });
    pending = (async () => {
      try {
        const envelope = await client.request('/api/v2/me', { method: 'PATCH', body: serializedBody,
          headers: { 'Idempotency-Key': operationId }, timeoutMs });
        if (!active()) return state;
        const data = envelope.data;
        if (!data?.operationReceipt || !Number.isSafeInteger(data.current?.profile?.revision)) {
          return emit({ status: 'unknown', error: new ApiError('INVALID_RESPONSE', { retryable: true }) });
        }
        const cached = client.getQueryState(['me']);
        // An earlier response can arrive after another tab/read established a newer
        // profile revision. The receipt proves the old save, not a rollback of current.
        const useCached = (cached.data?.profile?.revision || 0) > data.current.profile.revision;
        const current = useCached ? cached.data : data.current;
        client.setQueryData(['me'], current, { meta: useCached ? cached.meta : envelope.meta, ttlMs: 60_000 });
        client.invalidateQueries(['home']); client.invalidateQueries(['team']);
        emit({ status: 'committed', current, operationReceipt: data.operationReceipt, replayed: Boolean(data.replayed), error: null });
        onCommitted(current);
        return state;
      } catch (error) {
        if (!active()) return state;
        if (error.errorCode === 'REVISION_CONFLICT') return emit({ status: 'conflict', current: error.current || null, error });
        if (error.status >= 500 || error.status === 202 || ['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE', 'REQUEST_CANCELLED',
          'INVALID_RESPONSE', 'OPERATION_PENDING'].includes(error.errorCode)) return emit({ status: 'unknown', error });
        return emit({ status: 'failed', error });
      } finally { pending = null; }
    })();
    return pending;
  }
  const operation = {
    operationId, get body() { return immutableBody; }, getState: () => state, submit: run, retry: run,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; serializedBody = null; immutableBody = null;
      state = Object.freeze({ status: 'cancelled', current: null, operationReceipt: null, error: null, replayed: false }); listeners.clear(); }
  };
  store.operation = operation; return operation;
}
