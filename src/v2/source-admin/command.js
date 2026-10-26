// Persist only the receipt ID/action. Credentials and configuration payloads stay in memory.
const actions = new Set(['battlemetrics.save','battlemetrics.delete','battlemetrics.clear','battlemetrics.primary','steam.save','steam.clear']);
export function createSourceCommand({ client, storage, onChange = () => {}, onSaved = () => {}, uuid = () => crypto.randomUUID() }) {
  const generation = client.getGeneration(), account = client.getIdentity()?.accountId;
  const key = `v2-source-admin-operation:${account}`;
  let body = null, disposed = false, state = { phase: 'idle', journal: null, error: null };
  const valid = () => !disposed && generation === client.getGeneration() && account === client.getIdentity()?.accountId;
  try { const j = JSON.parse(storage.getItem(key)); if (j && /^[a-f0-9-]{36}$/i.test(j.id) && actions.has(j.action)) state = { phase: 'unknown', journal: { id: j.id, action: j.action }, error: null }; } catch {}
  const update = value => { if (valid()) { state = { ...state, ...value }; onChange(state); } };
  function clear() { storage.removeItem(key); body = null; }
  function success(result, operationId) { clear(); update({ phase: 'saved', journal: null, error: null, result }); onSaved(result, operationId); }
  async function send() {
    if (!valid() || !state.journal || !body) return;
    const j = state.journal; update({ phase: 'submitting', error: null });
    try {
      const r = await client.request(`/api/v2/source-admin/commands/${j.action}`, { method: 'POST', body: { input: body }, headers: { 'Idempotency-Key': j.id }, timeoutMs: 30000 });
      if (valid()) success(r.data, j.id);
    } catch (e) {
      if (!valid()) return;
      const unknown = !e.status || e.status >= 500;
      if (!unknown) clear();
      update({ phase: unknown ? 'unknown' : 'error', journal: unknown ? j : null, error: { errorCode: e.errorCode, status: e.status } });
    }
  }
  return {
    snapshot: () => state,
    canRetry: () => Boolean(body),
    async run(action, input) {
      if (!valid()) return;
      if (state.journal || state.phase === 'submitting') throw Error('OPERATION_PENDING');
      if (!actions.has(action)) throw Error('INVALID_ACTION');
      const j = { id: uuid(), action };
      try { storage.setItem(key, JSON.stringify(j)); } catch { update({ phase: 'error', error: { errorCode: 'JOURNAL_UNAVAILABLE' } }); return; }
      body = structuredClone(input); update({ journal: j }); return send();
    },
    retry: () => state.phase === 'unknown' ? send() : undefined,
    async recover() {
      if (!valid() || !state.journal || state.phase === 'submitting') return;
      const j = state.journal; update({ phase: 'submitting', error: null });
      try {
        // GET succeeded cannot certify the cache side effect. POST recover always repairs it.
        const r = await client.request(`/api/v2/source-admin/operations/${j.id}/recover`, { method: 'POST', headers: { 'Idempotency-Key': j.id }, timeoutMs: 30000 });
        if (valid()) success(r.data, j.id);
      } catch (e) {
        if (!valid()) return;
        if (e.status === 404) { clear(); update({ phase: 'not-recorded', journal: null, error: null }); }
        else update({ phase: 'unknown', error: { errorCode: e.errorCode, status: e.status } });
      }
    },
    dispose() { disposed = true; body = null; }
  };
}
