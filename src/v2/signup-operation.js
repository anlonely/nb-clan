import { ApiError } from './query-client.js';

const conflicts = new Set(['REVISION_CONFLICT']);
const cancelledCodes = new Set(['REQUEST_SUPERSEDED', 'AUTH_REQUIRED', 'PERMISSIONS_CHANGED']);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// A changed signup revision requires a new operation after loading the latest reply.
// An unknown result must keep this object alive and retry its original bytes and key.
export function createSignupOperation(client, { wipeId, body, operationId = globalThis.crypto.randomUUID(), timeoutMs } = {}) {
  if (!client.getIdentity()?.accountId) throw new ApiError('AUTH_REQUIRED', { status: 401 });
  if (!wipeId || !body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('INVALID_SIGNUP');
  if (!/^[A-Za-z0-9:_-]{1,200}$/.test(operationId)) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED');
  const generation = client.getGeneration(), listeners = new Set();
  let serializedBody = JSON.stringify(body), immutableBody = freeze(JSON.parse(serializedBody)), pending = null;
  let state = Object.freeze({ status: 'idle', current: null, operationReceipt: null, error: null, replayed: false });
  const emit = patch => { state = Object.freeze({ ...state, ...patch }); for (const listener of listeners) listener(); return state; };
  const unsubscribeIdentity = client.subscribeIdentity(() => {
    serializedBody = null; immutableBody = null;
    emit({ status: 'cancelled', current: null, operationReceipt: null, error: new ApiError('REQUEST_SUPERSEDED') });
  });
  async function run(reconcile) {
    if (generation !== client.getGeneration() || !serializedBody) return state;
    if (pending) return pending;
    if (!reconcile && ['committed', 'conflict', 'failed', 'cancelled'].includes(state.status)) return state;
    emit({ status: reconcile ? 'unknown' : 'submitting', error: null });
    pending = (async () => {
      try {
        const envelope = await client.request(reconcile ? `/api/v2/operations/${encodeURIComponent(operationId)}`
          : `/api/v2/wipes/${encodeURIComponent(wipeId)}/my-signup`, reconcile ? { timeoutMs }
            : { method: 'PUT', body: serializedBody, headers: { 'Idempotency-Key': operationId }, timeoutMs });
        if (generation !== client.getGeneration() || !serializedBody) return state;
        const { data } = envelope;
        if (!data?.operationReceipt || !data?.current) return emit({ status: 'unknown', error: new ApiError('OPERATION_PENDING', { retryable: true }) });
        // The receipt can describe revision 1 while current is already revision 3.
        return emit({ status: 'committed', current: data.current, operationReceipt: data.operationReceipt, replayed: Boolean(data.replayed), error: null });
      } catch (error) {
        if (generation !== client.getGeneration() || !serializedBody) return state;
        if (conflicts.has(error.errorCode)) return emit({ status: 'conflict', current: error.current || null, error });
        if (cancelledCodes.has(error.errorCode)) return emit({ status: 'cancelled', current: null, error });
        if ((reconcile && error.status === 404) || error.status >= 500 || error.status === 202 ||
          ['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE', 'REQUEST_CANCELLED', 'INVALID_RESPONSE', 'OPERATION_PENDING'].includes(error.errorCode)) return emit({ status: 'unknown', error });
        return emit({ status: 'failed', error });
      } finally { pending = null; }
    })();
    return pending;
  }
  return { operationId, get body() { return immutableBody; }, getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit: () => run(false), retry: () => run(false), reconcile: () => run(true),
    dispose() { unsubscribeIdentity(); serializedBody = null; immutableBody = null;
      state = Object.freeze({ status: 'cancelled', current: null, operationReceipt: null, error: null, replayed: false }); listeners.clear(); } };
}
