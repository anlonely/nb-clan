import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { queryKey } from './query-client.js';

export function useQuery(client, key, path, { enabled = true, ttlMs, refetchOnMount = true, timeoutMs } = {}) {
  const serializedKey = queryKey(key);
  const stableKey = useMemo(() => JSON.parse(serializedKey), [serializedKey]);
  // Closed dialogs and disabled route queries must not remain active observers:
  // invalidation otherwise starts requests even while their effect is disabled.
  const subscribe = useCallback(listener => enabled ? client.subscribeQuery(stableKey, listener) : () => {}, [client, stableKey, enabled]);
  const getSnapshot = useCallback(() => client.getQueryState(stableKey), [client, stableKey]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const retry = useCallback(() => client.fetchQuery(stableKey, path, { ttlMs, timeoutMs, force: true }), [client, stableKey, path, ttlMs, timeoutMs]);
  const generation = client.getGeneration();
  useEffect(() => {
    if (enabled) client.fetchQuery(stableKey, path, { ttlMs, timeoutMs, force: refetchOnMount }).catch(() => {});
  }, [client, stableKey, path, enabled, ttlMs, timeoutMs, refetchOnMount, generation]);
  return { ...state, retry };
}
