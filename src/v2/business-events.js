import { useEffect } from 'react';

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function parseEvent(type, event, scopeVersion) {
  if (typeof event?.data !== 'string' || event.data.length > 32768) return null;
  let data; try { data = JSON.parse(event.data); } catch { return null; }
  if (data?.schemaVersion !== 1 || data.scopeVersion !== scopeVersion) return null;
  if (type === 'reset') return exact(data, ['schemaVersion', 'scopeVersion', 'reason']) &&
    ['initial', 'reconnect', 'scope_changed', 'domain_changed'].includes(data.reason) ? data : null;
  if (type === 'authorization-revoked') return exact(data, ['schemaVersion', 'scopeVersion']) ? data : null;
  if (!exact(data, ['schemaVersion', 'scopeVersion', 'changes']) || !Array.isArray(data.changes) || !data.changes.length || data.changes.length > 100) return null;
  for (const change of data.changes) {
    if (!id(change?.wipeId)) return null;
    if (['wipe', 'signup'].includes(change.kind)) { if (!exact(change, ['kind', 'wipeId'])) return null; }
    else if (change.kind !== 'notification' || !exact(change, ['kind', 'wipeId', 'intentId', 'deliveryId']) || !id(change.intentId) || !id(change.deliveryId)) return null;
  }
  return data;
}

function invalidate(client, changes) {
  const keys = new Map(), add = key => keys.set(JSON.stringify(key), key);
  for (const change of changes) {
    for (const key of [['home'], ['wipes'], ['history'], ['admin-wipes'], ['wipe', change.wipeId]]) add(key);
    if (change.kind === 'notification') {
      for (const key of [['notification-options', change.wipeId], ['notification-intents', change.wipeId],
        ['notification-intent', change.intentId], ['notification-delivery', change.deliveryId]]) add(key);
    } else {
      for (const key of [['signups', change.wipeId], ['admin-signup', change.wipeId], ['admin-history', change.wipeId],
        ['admin-archive', change.wipeId], ['notification-options', change.wipeId], ['notification-intents', change.wipeId],
        ['notification-intent'], ['notification-delivery']]) add(key);
    }
  }
  for (const key of keys.values()) client.invalidateQueries(key);
}

/** Small lifecycle controller, also exercised with a mock EventSource in tests.
 * Native EventSource owns reconnect/backoff; each connection must receive reset
 * before incremental hints. Neither tokens nor stream cursors are persisted. */
export function connectBusinessEvents({ client, session, online, refreshSession,
  EventSourceImpl = globalThis.EventSource } = {}) {
  const identity = client?.getIdentity();
  if (!online || !session?.accountId || identity?.accountId !== session.accountId || !EventSourceImpl) return () => {};
  const generation = client.getGeneration(), accountId = identity.accountId, scopeVersion = identity.scopeVersion;
  const source = new EventSourceImpl('/api/v2/events');
  let closed = false, awaitingReset = true, receivedReset = false, unsubscribe = () => {};
  let refreshing = false, refreshAgain = false;
  const current = () => !closed && generation === client.getGeneration() &&
    accountId === client.getIdentity()?.accountId && scopeVersion === client.getIdentity()?.scopeVersion;
  const handlers = {};
  const close = () => {
    if (closed) return; closed = true;
    for (const [type, listener] of Object.entries(handlers)) source.removeEventListener(type, listener);
    source.onerror = null; source.close(); unsubscribe();
  };
  function refreshBootstrap() {
    if (!refreshSession || !current()) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    Promise.resolve().then(async () => {
      do {
        refreshAgain = false;
        if (!current()) break;
        await refreshSession();
      } while (refreshAgain && current());
    }).catch(() => {}).finally(() => { refreshing = false; });
  }
  function receive(type, event) {
    if (!current()) { close(); return; }
    const data = parseEvent(type, event, scopeVersion); if (!data) return;
    if (type === 'authorization-revoked') { close(); client.clearIdentity('authorization-revoked'); return; }
    if (type === 'reset') {
      if (data.reason === 'scope_changed') {
        close();
        // notify is intentional: App clears session and unmounts private pages
        // immediately, while bootstrap restores the same account's new scope.
        client.clearIdentity('business_scope_changed');
        const clearedGeneration = client.getGeneration();
        Promise.resolve().then(() => {
          if (client.getGeneration() === clearedGeneration && !client.getIdentity()) return refreshSession?.();
        }).catch(() => {});
      } else {
        awaitingReset = false; client.invalidateQueries();
        // Brand and navigation live in bootstrap, outside the query cache.
        // Native reconnection may have no Last-Event-ID and report initial again.
        if (data.reason === 'domain_changed' || data.reason === 'reconnect' || receivedReset) refreshBootstrap();
        receivedReset = true;
      }
      return;
    }
    if (!awaitingReset) invalidate(client, data.changes);
  }
  for (const type of ['reset', 'invalidate', 'authorization-revoked']) {
    handlers[type] = event => receive(type, event); source.addEventListener(type, handlers[type]);
  }
  source.onerror = () => { if (!current()) close(); else awaitingReset = true; };
  unsubscribe = client.subscribeIdentity(() => { if (!current()) close(); });
  return close;
}

export function useBusinessEvents({ client, session, online, refreshSession }) {
  useEffect(() => connectBusinessEvents({ client, session, online, refreshSession }),
    [client, session?.accountId, client.getIdentity()?.scopeVersion, client.getGeneration(), online, refreshSession]);
}
