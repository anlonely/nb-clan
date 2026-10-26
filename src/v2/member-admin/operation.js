import { notifySuccess } from '../toast-store.js';

const stores = new WeakMap();
const empty = Object.freeze({
  status: 'idle'
});
export function memberOperations(client, storage = globalThis.sessionStorage) {
  if (stores.has(client)) return stores.get(client);
  let state = empty,
    command = null,
    busy = null;
  const listeners = new Set();
  const identity = () => client.getIdentity();
  const key = () => `nb-g07-members:${identity()?.accountId}:${identity()?.scopeVersion}`;
  const emit = patch => {
    state = Object.freeze({
      ...state,
      ...patch
    });
    for (const l of listeners) l();
  };
  const save = () => storage.setItem(key(), JSON.stringify({
    version: 1,
    ...command
  }));
  const clear = () => {
    storage.removeItem(key());
    command = null;
  };
  const invalidate = () => client.invalidateQueries(k => ['member-admin', 'me', 'team', 'home', 'wipes'].includes(k[0]));
  function restore() {
    try {
      const stored = JSON.parse(storage.getItem(key()) || 'null');
      if (stored && stored.version === 1 && /^\/api\/v2\/member-admin\//.test(stored.path) && ['POST', 'PATCH'].includes(stored.method) && typeof stored.operationId === 'string') {
        command = stored;
        emit({
          status: 'unknown',
          path: command.path,
          provider: command.body?.provider,
          operationId: command.operationId
        });
      }
    } catch {
      emit({
        status: 'error',
        error: {
          errorCode: '恢复记录无法读取'
        }
      });
    }
  }
  async function send() {
    if (busy) return busy;
    if (!command) return;
    const generation = client.getGeneration();
    const cmd = command;
    emit({
      status: 'submitting',
      path: cmd.path,
      provider: cmd.body?.provider,
      error: null
    });
    busy = (async () => {
      try {
        const result = await client.request(cmd.path, {
          method: cmd.method,
          body: cmd.body,
          headers: {
            'Idempotency-Key': cmd.operationId
          }
        });
        if (generation !== client.getGeneration()) return;
        clear();
        invalidate();
        notifySuccess('保存成功', { id: cmd.operationId });
        emit({
          status: 'success',
          data: result.data,
          operationId: cmd.operationId
        });
        return result.data;
      } catch (error) {
        if (generation !== client.getGeneration()) return;
        const definitive = /_ADAPTER_REQUIRED$/.test(error.errorCode || '') || ['STEAM_RESOLVER_REQUIRED', 'MEMBER_ADMIN_MIGRATION_REQUIRED'].includes(error.errorCode);
        const unknown = !definitive && (error.retryable || error.status === 0 || ['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE', 'INVALID_RESPONSE'].includes(error.errorCode));
        if (!unknown) clear();
        emit({
          status: unknown ? 'unknown' : error.status === 409 ? 'conflict' : 'error',
          error,
          operationId: cmd.operationId
        });
      } finally {
        busy = null;
      }
    })();
    return busy;
  }
  const api = {
    subscribe: l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot: () => state,
    restore,
    async begin(path, body, method = 'POST') {
      if (['unknown', 'submitting'].includes(state.status)) return;
      command = {
        path: '/api/v2/member-admin' + path,
        method,
        body: structuredClone(body),
        operationId: crypto.randomUUID()
      };
      try {
        save();
      } catch {
        command = null;
        emit({
          status: 'error',
          error: {
            errorCode: '无法保存恢复记录，请允许会话存储'
          }
        });
        return;
      }
      return send();
    },
    retry: send,
    async recover() {
      if (!command) return;
      try {
        const r = await client.request('/api/v2/member-admin/operations/' + encodeURIComponent(command.operationId));
        if (r.data.committed) {
          const operationId = command.operationId;
          clear();
          invalidate();
          notifySuccess('保存成功', { id: operationId });
          emit({
            status: 'success',
            data: {
              recovered: true
            },
            error: null
          });
        }
      } catch (error) {
        emit({
          status: 'unknown',
          error
        });
      }
    },
    dismiss() {
      if (['submitting', 'unknown'].includes(state.status)) return;
      state = empty;
      for (const l of listeners) l();
    }
  };
  client.subscribeIdentity(() => {
    for (let i = storage.length - 1; i >= 0; i--) {
      const k = storage.key(i);
      if (k?.startsWith('nb-g07-members:')) storage.removeItem(k);
    }
    command = null;
    state = empty;
    busy = null;
    for (const l of listeners) l();
  });
  stores.set(client, api);
  return api;
}
