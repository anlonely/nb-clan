import { ApiError } from './query-client.js';
import { managementHome } from './management-navigation.js';

export function safeAuthReturnTo(value) {
  if (typeof value !== 'string' || value.length > 2048) return '/app/home';
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return '/app/home'; }
  if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.includes('%') || !/^\/(app|admin)\//.test(decoded) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded.split(/[?#]/)[0]) || /(?:callback|\/auth\/)/i.test(decoded)) return '/app/home';
  const url = new URL(value, 'https://auth.local');
  return url.origin === 'https://auth.local' && /^\/(app|admin)\//.test(url.pathname) ? `${url.pathname}${url.search}${url.hash}` : '/app/home';
}

export function sessionAuthReturnTo(value, session) {
  const target = safeAuthReturnTo(value);
  // Preserve explicit deep links; only the default home changes for an account
  // whose currently authorized workspace is administration alone.
  return target === '/app/home' && session?.workspaces?.member === false && session.workspaces.admin === true
    ? managementHome(session) : target;
}

// One mounted login step owns one flow. A replacement read/action and disposal both
// fence callbacks, including transports that ignore cancellation and late navigation.
export function createAuthFlow({ client, continuing, returnTo, onChange, go,
  refreshSession, redirect = url => globalThis.location.assign(url) }) {
  let sequence = 0, controller = null, disposed = false;
  let state = Object.freeze({ data: null, error: null, busy: false, loading: true });
  const publish = patch => { state = Object.freeze({ ...state, ...patch }); onChange(state); };
  const superseded = () => new ApiError('REQUEST_SUPERSEDED');
  function run(work, { loading = false } = {}) {
    if (disposed) return Promise.resolve(null);
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, ticket = ++sequence, generation = client.getGeneration();
    const current = () => !disposed && ticket === sequence && !signal.aborted;
    const authorized = () => current() && generation === client.getGeneration();
    const request = async (path, options) => {
      if (!authorized()) throw superseded();
      const result = await client.request(path, { ...options, signal });
      if (!authorized()) throw superseded();
      return result;
    };
    publish({ error: null, busy: !loading, loading, ...(loading ? { data: null } : {}) });
    return Promise.resolve().then(() => work({ request, current, authorized, signal })).catch(error => {
      if (current()) publish({ error, ...(generation !== client.getGeneration() ? { data: null } : {}) });
      return null;
    }).finally(() => { if (current()) publish({ busy: false, loading: false }); });
  }
  async function read({ request, current }) {
    const result = await request(continuing ? '/api/v2/auth/continue' : '/api/v2/auth/providers');
    if (current()) publish({ data: result.data });
    return result.data;
  }
  async function finish(target, task) {
    if (!task.authorized()) return null;
    // This is the one expected authorization transition: the successful bootstrap
    // may adopt a new account/scope. No redirect happens on a failed/stale bootstrap.
    const session = await refreshSession({ signal: task.signal });
    if (!task.current()) return null;
    if (!session || client.getIdentity()?.accountId !== session.accountId) throw new ApiError('AUTH_REFRESH_REQUIRED', { retryable: true });
    go(sessionAuthReturnTo(target || returnTo, session), { replace: true });
    return session;
  }
  return {
    getState: () => state,
    load: () => run(read, { loading: true }),
    act(action) {
      if (state.busy || disposed) return Promise.resolve(null);
      const context = state.data;
      if (!continuing || !context?.csrfToken || !['steam/start', 'eligibility/retry', 'cancel'].includes(action)) return Promise.resolve(null);
      return run(async task => {
        const result = await task.request(`/api/v2/auth/${action}`, { method: 'POST', body: {}, csrfToken: context.csrfToken,
          ...(action === 'eligibility/retry' ? { timeoutMs: 80_000 } : {}) });
        if (action === 'steam/start') {
          if (task.authorized()) redirect(result.data.authorizationUrl);
        } else if (action === 'cancel') {
          if (task.authorized()) go(`/login?returnTo=${encodeURIComponent(safeAuthReturnTo(context.returnTo || returnTo))}`);
        } else if (result.data.step === 'complete') await finish(result.data.returnTo, task);
        else await read(task);
      });
    },
    passwordLogin({ username, password }) {
      if (state.busy || disposed) return Promise.resolve(null);
      return run(async task => {
        const result = await task.request('/api/v2/auth/password', { method: 'POST',
          body: { username, password, returnTo: safeAuthReturnTo(returnTo) } });
        await finish(result.data.returnTo, task);
      });
    },
    ownerLogin(password) {
      if (state.busy || disposed || continuing || state.data?.ownerPasswordLogin !== true) return Promise.resolve(null);
      return run(async task => {
        await task.request('/api/v2/auth/owner-password', { method: 'POST', body: { username: 'root', password } });
        await finish(returnTo, task);
      });
    },
    dispose() { disposed = true; sequence += 1; controller?.abort();
      state = Object.freeze({ data: null, error: null, busy: false, loading: false }); }
  };
}
