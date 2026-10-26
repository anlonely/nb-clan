import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useApp } from '../context.jsx';
import { ApiError } from '../query-client.js';
import { createAdminOperation, persistAdminOperation, restoreAdminOperation, clearAdminOperation,
  getAdminOperationSnapshot, subscribeAdminOperations } from './operation.js';

export function useAdminOperation(slot) {
  const { client } = useApp();
  const subscribe = useCallback(listener => subscribeAdminOperations(client, listener), [client]);
  const snapshot = useCallback(() => getAdminOperationSnapshot(client, slot), [client, slot]);
  const { operation, state } = useSyncExternalStore(subscribe, snapshot, snapshot);
  const generation = client.getGeneration();
  useEffect(() => { restoreAdminOperation(client, slot); }, [client, slot, generation]);
  const begin = useCallback(options => {
    // Consult the shared store synchronously, not the last rendered hook value:
    // two clicks in the same event turn must still observe the first operation.
    const previous = restoreAdminOperation(client, slot);
    if (['submitting', 'unknown'].includes(previous?.getState().status)) return previous.getState();
    const next = createAdminOperation(client, options);
    try { persistAdminOperation(client, slot, next); }
    catch (error) { next.dispose(); throw error instanceof ApiError ? error : new ApiError('ADMIN_OPERATION_STORAGE_UNAVAILABLE'); }
    return next.submit();
  }, [client, slot]);
  const retry = useCallback(() => restoreAdminOperation(client, slot)?.retry(), [client, slot]);
  const reconcile = useCallback(() => restoreAdminOperation(client, slot)?.reconcile(), [client, slot]);
  const reset = useCallback(() => clearAdminOperation(client, slot), [client, slot]);
  // Leaving a route only removes the React subscription. The in-flight command
  // and journal remain available for a later mount; terminal state stays visible
  // until the page's success effect has consumed it and explicitly resets it.
  return { operation, state, begin, retry, reconcile, reset, busy: ['submitting', 'unknown'].includes(state.status) };
}
