// Journal only operation ID/action. Token lives only for the active request, never in browser storage.
export function createRelayCommand({ client, storage, onChange = () => {}, onSaved = () => {}, uuid = () => crypto.randomUUID() }) {
  const generation = client.getGeneration(), account = client.getIdentity()?.accountId, key = `v2-relay-admin-operation:${account}`;
  let disposed = false, controller = null, storageReady = true, state = { phase: 'idle', journal: null, error: null };
  const valid = () => !disposed && generation === client.getGeneration() && account === client.getIdentity()?.accountId;
  const safeError = e => ({ errorCode: /^[A-Z_]{1,80}$/.test(e?.errorCode) ? e.errorCode : 'RELAY_REQUEST_FAILED', status: Number.isInteger(e?.status) ? e.status : 0 });
  const emit = patch => { if (valid()) { state = { ...state, ...patch }; onChange(state); } };
  try { const j = JSON.parse(storage.getItem(key)); if (j && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(j.id) && ['save','clear'].includes(j.action)) state = { phase: 'unknown', journal: { id: j.id.toLowerCase(), action: j.action }, error: null }; }
  catch { storageReady = false; state = { ...state, phase: 'error', error: { errorCode: 'JOURNAL_UNAVAILABLE' } }; }
  function finish(phase, result, operationId = null) {
    try { storage.removeItem(key); } catch { emit({ phase: 'unknown', error: { errorCode: 'JOURNAL_UNAVAILABLE' } }); return; }
    emit({ phase, journal: null, error: null, result }); if (phase === 'saved') onSaved(result, operationId);
  }
  return {
    snapshot: () => state,
    async run(action, input) {
      if (!valid()) return;
      if (state.journal || ['submitting','recovering'].includes(state.phase)) throw Error('OPERATION_PENDING');
      if (!['save','clear'].includes(action)) throw Error('INVALID_ACTION');
      const journal = { id: uuid(), action };
      try { if (!storageReady) throw Error(); storage.setItem(key, JSON.stringify(journal)); }
      catch { emit({ phase: 'error', error: { errorCode: 'JOURNAL_UNAVAILABLE' } }); return; }
      controller = new AbortController(); emit({ phase: 'submitting', journal, error: null });
      let body = { input: structuredClone(input) };
      try { const r = await client.request(`/api/v2/relay-admin/commands/${action}`, { method: 'POST', body, headers: { 'Idempotency-Key': journal.id }, signal: controller.signal, timeoutMs: 30000 }); if (valid()) finish('saved', r.data, journal.id); }
      catch (error) {
        if (!valid()) return; const e = safeError(error), unknown = !e.status || e.status >= 500;
        if (unknown) emit({ phase: 'unknown', error: e });
        else { try { storage.removeItem(key); emit({ phase: 'error', journal: null, error: e }); } catch { emit({ phase: 'unknown', error: { errorCode: 'JOURNAL_UNAVAILABLE' } }); } }
      } finally { body = null; controller = null; }
    },
    async recover() {
      if (!valid() || !state.journal || ['submitting','recovering'].includes(state.phase)) return;
      const j = state.journal; controller = new AbortController(); emit({ phase: 'recovering', error: null });
      try { const r = await client.request(`/api/v2/relay-admin/operations/${j.id}/recover`, { method: 'POST', headers: { 'Idempotency-Key': j.id }, signal: controller.signal, timeoutMs: 30000 }); if (valid()) finish('saved', r.data, j.id); }
      catch (error) { if (!valid()) return; if (error.status === 404 && error.errorCode === 'RESOURCE_NOT_FOUND') finish('not-recorded'); else emit({ phase: 'unknown', error: safeError(error) }); }
      finally { controller = null; }
    },
    dispose() { disposed = true; controller?.abort(); controller = null; }
  };
}
