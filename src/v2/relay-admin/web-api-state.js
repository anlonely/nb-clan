const API = '/api/v2/relay-admin/web-api';
const busyPhases = new Set(['saving', 'checking', 'unknown']);
const safeError = error => ({
  errorCode: /^[A-Z0-9_]{1,100}$/.test(error?.errorCode || '') ? error.errorCode : 'WEB_API_REQUEST_FAILED',
  status: Number.isInteger(error?.status) ? error.status : 0
});
const ids = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string'))];
const draftFrom = config => ({ expectedRevision: config.revision, baseUrl: config.baseUrl || '',
  tenantId: config.tenantId || '', serverIds: ids(config.serverIds), infoEnabled: !!config.infoEnabled,
  chatEnabled: !!config.chatEnabled, apiKey: '', clearApiKey: false });
const publicConfig = data => ({ revision: data.revision, baseUrl: data.baseUrl || '', tenantId: data.tenantId || '',
  serverIds: ids(data.serverIds), infoEnabled: !!data.infoEnabled, chatEnabled: !!data.chatEnabled,
  apiKeyConfigured: !!data.apiKeyConfigured, canWrite: !!data.canWrite,
  lastOperationId: data.lastOperationId || null, status: data.status || { state: 'disabled' } });
const normalizedSource = value => {
  try {
    const url = new URL(value.trim());
    let path = url.pathname.replace(/\/+$/, '');
    if (!path) path = '/api/v1'; else if (!path.endsWith('/v1')) path += '/v1';
    return url.origin + path;
  } catch { return value?.trim() || ''; }
};
const sameSource = (left, right) => normalizedSource(left?.baseUrl || '') === normalizedSource(right?.baseUrl || '') && left?.tenantId === right?.tenantId;
export const webApiHasCredentials = (draft, config) => !!draft?.baseUrl.trim() && !draft.clearApiKey &&
  (!!draft.apiKey.trim() || !!config?.apiKeyConfigured && sameSource(draft, config));

// A single mounted form owns its requests. Only an operation ID and revision may
// be journaled; API keys never enter browser storage, a URL, or an error message.
export function createWebApiState({ client, storage, onChange = () => {}, uuid = () => crypto.randomUUID() }) {
  const generation = client.getGeneration(), accountId = client.getIdentity()?.accountId;
  const journalKey = `v2-relay-web-api-operation:${accountId}`;
  let disposed = false, configSequence = 0, serverSequence = 0;
  let configController = null, serverController = null, saveController = null, checkController = null;
  let state = { config: null, draft: null, dirty: false, loading: false, loadError: null,
    servers: null, serversLoading: false, serversError: null, phase: 'idle', error: null, journal: null, keyInputCleared: false };
  const current = () => !disposed && client.getGeneration() === generation && client.getIdentity()?.accountId === accountId;
  const emit = patch => { if (current()) { state = { ...state, ...patch }; onChange(state); } };
  const locked = () => busyPhases.has(state.phase);
  const writable = () => state.config?.canWrite && !state.loadError && !locked();
  try {
    const saved = JSON.parse(storage?.getItem(journalKey) || 'null');
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(saved?.id || '') && Number.isInteger(saved?.expectedRevision)) {
      state = { ...state, phase: 'unknown', keyInputCleared: saved.keyChanged === true,
        journal: { id: saved.id, expectedRevision: saved.expectedRevision, keyChanged: saved.keyChanged === true } };
    }
  } catch { /* A read failure is shown if a later save cannot write its journal. */ }
  function clearJournal() { try { storage?.removeItem(journalKey); } catch { /* Receipt is already known. */ } }
  function acceptConfig(raw, { saved = false } = {}) {
    if (!Number.isInteger(raw?.revision)) throw { errorCode: 'INVALID_RESPONSE' };
    const config = publicConfig(raw);
    // A status request that began before a save must not replace its newer result.
    if (state.config && config.revision < state.config.revision) return state.config;
    const resetDraft = saved || !state.draft || !state.dirty && !locked();
    emit({ config, loadError: null, ...(resetDraft ? { draft: draftFrom(config), dirty: false } : {}) });
    return config;
  }
  function finishSaved(raw) {
    const config = acceptConfig(raw, { saved: true });
    clearJournal(); emit({ phase: config.revision > raw.revision ? 'superseded' : 'saved', journal: null, error: null, keyInputCleared: false }); return config;
  }
  async function refresh() {
    if (!current() || configController) return null;
    const controller = new AbortController(), sequence = ++configSequence;
    configController = controller; emit({ loading: true });
    try {
      const result = await client.request(API, { signal: controller.signal });
      if (!current() || sequence !== configSequence) return null;
      return acceptConfig(result.data);
    } catch (error) {
      if (current() && sequence === configSequence) emit({ loadError: safeError(error) });
      return null;
    } finally {
      if (configController === controller) { configController = null; emit({ loading: false }); }
    }
  }
  function invalidateServers() {
    serverSequence++; serverController?.abort(); serverController = null;
    emit({ servers: null, serversLoading: false, serversError: null });
  }
  async function checkResult() {
    if (!current() || !state.journal || checkController || state.phase === 'saving') return;
    const journal = state.journal, controller = new AbortController(); checkController = controller;
    emit({ phase: 'checking', error: null });
    // Read directly to avoid accepting a cached or already-running status request.
    try {
      const fresh = await client.request(API, { signal: controller.signal });
      if (!current() || state.journal !== journal) return;
      const config = acceptConfig(fresh.data);
      if (config.lastOperationId === journal.id && config.revision > journal.expectedRevision) {
        finishSaved(config); return;
      }
      try {
        const receipt = await client.request(`${API}/operations/${encodeURIComponent(journal.id)}`, { signal: controller.signal });
        if (!current() || state.journal !== journal) return;
        if (receipt.data?.state !== 'succeeded') throw { errorCode: 'OPERATION_IN_PROGRESS', status: 503 };
        // The receipt can appear after our first GET. Use another fresh read so
        // that the form never claims an older configuration is the saved one.
        const latest = await client.request(API, { signal: controller.signal });
        if (!current() || state.journal !== journal) return;
        const confirmed = acceptConfig(latest.data);
        if (confirmed.lastOperationId !== journal.id) {
          clearJournal(); emit({ phase: 'superseded', journal: null, error: null, keyInputCleared: false });
        } else finishSaved(confirmed);
      } catch (error) {
        if (!current() || state.journal !== journal) return;
        if (error?.status === 404 && error?.errorCode === 'RESOURCE_NOT_FOUND') {
          clearJournal();
          emit({ phase: 'not-recorded', journal: null, error: null });
        } else emit({ phase: 'unknown', error: safeError(error) });
      }
    } catch (error) {
      if (current() && state.journal === journal) emit({ phase: 'unknown', error: safeError(error) });
    } finally { if (checkController === controller) checkController = null; }
  }
  return {
    snapshot: () => state,
    refresh,
    checkResult,
    change(field, value) {
      if (!current() || !writable() || !state.draft) return;
      if (!['baseUrl', 'apiKey', 'serverIds', 'infoEnabled', 'chatEnabled', 'clearApiKey'].includes(field)) return;
      if (['baseUrl', 'apiKey', 'clearApiKey'].includes(field)) invalidateServers();
      const draft = { ...state.draft, [field]: field === 'serverIds' ? ids(value) : value };
      if (field === 'apiKey' && value) draft.clearApiKey = false;
      if (field === 'clearApiKey' && value) { draft.apiKey = ''; draft.infoEnabled = false; draft.chatEnabled = false; }
      emit({ draft, dirty: true, phase: 'idle', error: null,
        ...(field === 'apiKey' && value || field === 'clearApiKey' && value ? { keyInputCleared: false } : {}) });
    },
    discard() {
      if (!current() || locked() || !state.config) return;
      invalidateServers(); emit({ draft: draftFrom(state.config), dirty: false, phase: 'idle', error: null, keyInputCleared: false });
    },
    async readServers() {
      if (!current() || !writable() || !webApiHasCredentials(state.draft, state.config)) return;
      invalidateServers();
      const controller = new AbortController(), sequence = serverSequence;
      serverController = controller; emit({ serversLoading: true });
      let input = { baseUrl: state.draft.baseUrl.trim(), tenantId: state.draft.tenantId,
        ...(state.draft.apiKey.trim() ? { apiKey: state.draft.apiKey.trim() } : {}) };
      try {
        const response = await client.request(`${API}/servers`, { method: 'POST', body: { input }, signal: controller.signal, timeoutMs: 30000 });
        if (!current() || sequence !== serverSequence) return;
        if (!Array.isArray(response.data?.items)) throw { errorCode: 'INVALID_RESPONSE' };
        const seen = new Set();
        const servers = response.data.items.filter(item => item?.state === 'running' && typeof item.id === 'string' && !seen.has(item.id) && seen.add(item.id))
          .map(item => ({ id: item.id, name: item.name || item.id, state: 'running', clanAvailable: item.clanAvailable }));
        emit({ servers, serversError: null });
      } catch (error) {
        if (current() && sequence === serverSequence) emit({ serversError: safeError(error) });
      } finally {
        input = null;
        if (serverController === controller) { serverController = null; emit({ serversLoading: false }); }
      }
    },
    async save() {
      if (!current() || !writable() || !state.dirty || !state.draft || state.keyInputCleared) return;
      if (state.draft.expectedRevision !== state.config.revision) {
        emit({ error: { errorCode: 'REVISION_CONFLICT' } }); return;
      }
      const journal = { id: uuid(), expectedRevision: state.draft.expectedRevision, keyChanged: !!state.draft.apiKey.trim() };
      try { storage?.setItem(journalKey, JSON.stringify(journal)); }
      catch { emit({ error: { errorCode: 'JOURNAL_UNAVAILABLE' } }); return; }
      let input = { ...state.draft, baseUrl: state.draft.baseUrl.trim(), serverIds: [...state.draft.serverIds] };
      if (!input.apiKey.trim()) delete input.apiKey; else input.apiKey = input.apiKey.trim();
      if (!input.clearApiKey) delete input.clearApiKey;
      const controller = new AbortController(); saveController = controller;
      // Clear the visible password immediately. It only lives in this request now.
      emit({ phase: 'saving', journal, error: null, keyInputCleared: journal.keyChanged, draft: { ...state.draft, apiKey: '' } });
      try {
        const response = await client.request(`${API}/config`, { method: 'POST', body: { input },
          headers: { 'Idempotency-Key': journal.id }, signal: controller.signal, timeoutMs: 30000 });
        if (current()) finishSaved(response.data);
      } catch (error) {
        if (!current()) return;
        const failure = safeError(error);
        if (failure.status >= 400 && failure.status < 500 && failure.status !== 408 && !['OPERATION_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT'].includes(failure.errorCode)) {
          clearJournal(); emit({ phase: 'error', journal: null, error: failure });
          if (failure.errorCode === 'REVISION_CONFLICT') await refresh();
        } else { emit({ phase: 'unknown', error: failure }); await checkResult(); }
      } finally { input = null; if (saveController === controller) saveController = null; }
    },
    dispose() {
      disposed = true; configSequence++; serverSequence++;
      configController?.abort(); serverController?.abort(); saveController?.abort(); checkController?.abort();
      state = { ...state, draft: null };
    }
  };
}
