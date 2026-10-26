// Only ephemeral, account-scoped data lives here. Nothing is written to browser storage.
export const QUERY_TTL = Object.freeze({ signup: 20_000, home: 20_000, member: 60_000, team: 30_000, brand: 600_000 });
export class ApiError extends Error {
  constructor(errorCode, { status = 0, retryable = false, ...details } = {}) {
    super(errorCode); this.name = 'ApiError'; this.errorCode = errorCode;
    Object.assign(this, { status, retryable }, details);
  }
}
const cancelled = () => new ApiError('REQUEST_CANCELLED');
const superseded = () => new ApiError('REQUEST_SUPERSEDED');
const revokedCodes = new Set(['PERMISSIONS_CHANGED', 'AUTHORIZATION_REVOKED', 'SESSION_REVOKED',
  'ACCOUNT_DISABLED', 'MEMBER_DEPARTED', 'ACCESS_RESTRICTED', 'ELIGIBILITY_DENIED']);
const idleState = () => Object.freeze({ data: undefined, meta: undefined, status: 'idle', loading: false,
  refreshing: false, stale: true, error: null, updatedAt: null });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const queryKey = key => JSON.stringify(canonical(Array.isArray(key) ? key : [key]));
const matches = (key, match) => typeof match === 'function' ? match(key) : match === undefined ||
  (Array.isArray(match) ? match : [match]).every((value, i) => queryKey(value) === queryKey(key[i]));
function apiPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/api/v2/') || path.includes('\\')) throw new ApiError('INVALID_API_PATH');
  const parsed = new URL(path, 'http://query.local');
  if (parsed.origin !== 'http://query.local' || !parsed.pathname.startsWith('/api/v2/') || parsed.hash) throw new ApiError('INVALID_API_PATH');
  return path;
}

export function createQueryClient({ fetchImpl = (...args) => fetch(...args), now = Date.now,
  defaultTimeoutMs = 12_000, onAuthorizationLost = () => {}, maxEntries = 100 } = {}) {
  let generation = 0, identity = null;
  const entries = new Map(), listeners = new Map(), identityListeners = new Set(), requests = new Set();
  const keyId = key => JSON.stringify([identity?.accountId || null, identity?.scopeVersion ?? null, generation, queryKey(key)]);
  const emit = entry => { for (const listener of listeners.get(entry.logicalId) || []) listener(); };
  const update = (entry, value) => { entry.state = Object.freeze({ ...entry.state, ...value }); emit(entry); };
  function cancelEntry(entry) {
    entry.sequence += 1; entry.controller?.abort(); entry.controller = null; entry.promise = null;
  }
  function queueRefetch(entry) {
    if (entry.refetchTask) return;
    const task = {}; entry.refetchTask = task;
    // One event can invalidate both a resource prefix and its individual keys.
    // Cancel stale work immediately, but issue only one replacement per turn.
    queueMicrotask(() => {
      if (entry.refetchTask !== task) return;
      entry.refetchTask = null;
      if (entries.get(entry.id) !== entry || !entry.state.stale || !listeners.get(entry.logicalId)?.size) return;
      fetchQuery(entry.key, entry.path, { ...entry.options, force: true }).catch(() => {});
    });
  }
  function entryFor(key) {
    const id = keyId(key); let entry = entries.get(id);
    if (!entry) {
      // Inactive resource caches have a bounded lifetime in memory even during a long session.
      if (entries.size >= maxEntries) for (const [oldId, old] of entries) {
        if (!listeners.get(old.logicalId)?.size && !old.promise) { clearTimeout(old.timer); entries.delete(oldId); break; }
      }
      entry = { id, logicalId: queryKey(key), key: Array.isArray(key) ? key : [key], sequence: 0, state: idleState() };
      entries.set(id, entry);
    }
    return entry;
  }
  function reset(nextIdentity, reason, notify) {
    generation += 1; identity = nextIdentity ? Object.freeze({ ...nextIdentity }) : null;
    for (const request of requests) request.abort();
    for (const entry of entries.values()) { clearTimeout(entry.timer); cancelEntry(entry); }
    entries.clear();
    for (const listener of identityListeners) listener({ identity, generation, reason });
    for (const set of listeners.values()) for (const listener of set) listener();
    if (notify) onAuthorizationLost({ reason, identity, generation });
  }
  function clearIdentity(reason = 'signed_out', { notify = true } = {}) { reset(null, reason, notify); }
  function setIdentity(next) {
    if (!next?.accountId || next.scopeVersion == null) throw new ApiError('INVALID_IDENTITY');
    if (identity?.accountId !== next.accountId || identity?.scopeVersion !== next.scopeVersion) reset(next, 'identity_changed', false);
    else identity = Object.freeze({ ...identity, ...next });
  }
  async function request(path, { method = 'GET', body, headers = {}, csrfToken, signal, timeoutMs = defaultTimeoutMs } = {}) {
    apiPath(path); const epoch = generation, scope = identity, controller = new AbortController();
    if (signal?.aborted) throw cancelled();
    let timer, rejectAbort, timeout = false;
    const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(epoch !== generation ? superseded() : timeout
      ? new ApiError('REQUEST_TIMEOUT', { retryable: true }) : cancelled());
    const forwardAbort = () => controller.abort();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', forwardAbort, { once: true });
    requests.add(controller);
    if (timeoutMs > 0) timer = setTimeout(() => { timeout = true; controller.abort(); }, timeoutMs);
    const check = () => { if (epoch !== generation) throw superseded(); if (controller.signal.aborted) throw timeout
      ? new ApiError('REQUEST_TIMEOUT', { retryable: true }) : cancelled(); };
    try {
      const write = !['GET', 'HEAD'].includes(method.toUpperCase());
      const requestHeaders = new Headers(headers); requestHeaders.set('Accept', 'application/json');
      if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
      if (write && (csrfToken ?? scope?.csrfToken)) requestHeaders.set('X-CSRF-Token', csrfToken ?? scope.csrfToken);
      const work = (async () => {
        const response = await fetchImpl(path, { method, headers: requestHeaders, credentials: 'same-origin',
          cache: 'no-store', redirect: 'error', signal: controller.signal,
          ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
        check(); let envelope;
        try { envelope = await response.json(); }
        catch { throw new ApiError('INVALID_RESPONSE', { status: response.status, retryable: true }); }
        check();
        if (!response.ok || envelope?.error) {
          const error = new ApiError(envelope?.error?.errorCode || `HTTP_${response.status}`,
            { ...envelope?.error, status: response.status, retryable: envelope?.error?.retryable ?? response.status >= 500 });
          if (response.status === 401 || response.status === 403 && revokedCodes.has(error.errorCode)) {
            requests.delete(controller); signal?.removeEventListener('abort', forwardAbort); clearIdentity(error.errorCode);
          }
          throw error;
        }
        if (!envelope || !Object.hasOwn(envelope, 'data')) throw new ApiError('INVALID_RESPONSE', { status: response.status, retryable: true });
        if (scope && envelope.meta?.scopeVersion != null && envelope.meta.scopeVersion !== scope.scopeVersion) {
          requests.delete(controller); signal?.removeEventListener('abort', forwardAbort);
          clearIdentity('PERMISSIONS_CHANGED'); throw new ApiError('PERMISSIONS_CHANGED', { status: 401 });
        }
        if (envelope.meta?.schemaVersion != null && envelope.meta.schemaVersion !== 1) {
          throw new ApiError('CLIENT_VERSION_UNSUPPORTED', { status: response.status, retryable: false });
        }
        return envelope;
      })();
      return await Promise.race([work, abortPromise]);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (epoch !== generation) throw superseded();
      if (controller.signal.aborted) throw cancelled();
      throw new ApiError('NETWORK_UNAVAILABLE', { retryable: true });
    } finally {
      clearTimeout(timer); requests.delete(controller);
      controller.signal.removeEventListener('abort', onAbort); signal?.removeEventListener('abort', forwardAbort);
    }
  }
  function armStale(entry, ttlMs) {
    clearTimeout(entry.timer);
    if (ttlMs === Infinity) return;
    entry.timer = setTimeout(() => { if (entries.get(entry.id) === entry) update(entry, { stale: true }); }, Math.max(0, ttlMs));
    entry.timer.unref?.();
  }
  function setQueryData(key, data, { meta, ttlMs = QUERY_TTL.signup } = {}) {
    const entry = entryFor(key); entry.refetchTask = null; cancelEntry(entry);
    update(entry, { data, meta, status: 'success', loading: false, refreshing: false, stale: ttlMs <= 0, error: null, updatedAt: now() });
    entry.expiresAt = now() + ttlMs; armStale(entry, ttlMs); return data;
  }
  function fetchQuery(key, path, { ttlMs = QUERY_TTL.signup, force = false, timeoutMs } = {}) {
    const entry = entryFor(key);
    if (entry.promise) return entry.promise;
    if (!force && entry.state.status === 'success' && !entry.state.stale && now() < entry.expiresAt) return Promise.resolve({ data: entry.state.data, meta: entry.state.meta });
    const sequence = ++entry.sequence, epoch = generation, controller = new AbortController();
    entry.controller = controller; entry.path = path; entry.options = { ttlMs, timeoutMs };
    update(entry, { status: entry.state.data === undefined ? 'loading' : entry.state.status,
      loading: entry.state.data === undefined, refreshing: entry.state.data !== undefined, error: null });
    const valid = () => epoch === generation && sequence === entry.sequence && entries.get(entry.id) === entry;
    entry.promise = request(path, { signal: controller.signal, timeoutMs }).then(envelope => {
      if (!valid()) throw superseded();
      update(entry, { data: envelope.data, meta: envelope.meta, status: 'success', loading: false, refreshing: false,
        stale: ttlMs <= 0, error: null, updatedAt: now() });
      entry.expiresAt = now() + ttlMs; armStale(entry, ttlMs); return envelope;
    }).catch(error => {
      if (valid()) update(entry, { status: error.errorCode === 'REQUEST_CANCELLED' ? (entry.state.data === undefined ? 'idle' : 'success') : 'error',
        loading: false, refreshing: false, stale: true, error: error.errorCode === 'REQUEST_CANCELLED' ? null : error });
      throw error;
    }).finally(() => { if (valid()) { entry.promise = null; entry.controller = null; } });
    return entry.promise;
  }
  function invalidateQueries(match, { refetch = true } = {}) {
    for (const entry of [...entries.values()]) if (matches(entry.key, match)) {
      cancelEntry(entry); clearTimeout(entry.timer);
      update(entry, { stale: true, loading: false, refreshing: false,
        status: entry.state.data === undefined ? 'idle' : entry.state.status });
      if (refetch && entry.path && listeners.get(entry.logicalId)?.size) queueRefetch(entry);
      else entry.refetchTask = null;
    }
  }
  function cancelQuery(key) {
    const entry = entries.get(keyId(key)); if (!entry) return;
    entry.refetchTask = null; cancelEntry(entry); update(entry, { loading: false, refreshing: false, status: entry.state.data === undefined ? 'idle' : 'success' });
  }
  function subscribeQuery(key, listener) {
    const id = queryKey(key); if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(listener);
    return () => { const set = listeners.get(id); set?.delete(listener); if (!set?.size) { listeners.delete(id); cancelQuery(key); } };
  }
  return { request, setIdentity, clearIdentity, clearScope: clearIdentity, getIdentity: () => identity,
    getGeneration: () => generation, fetchQuery, setQueryData, invalidateQueries, cancelQuery, subscribeQuery,
    getQueryState: key => entryFor(key).state,
    subscribeIdentity(listener) { identityListeners.add(listener); return () => identityListeners.delete(listener); },
    dispose() { reset(null, 'disposed', false); listeners.clear(); identityListeners.clear(); } };
}
