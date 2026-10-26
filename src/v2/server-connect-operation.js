import { ApiError } from './query-client.js';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const safeError = (error, fallback = 'NETWORK_ERROR') => new ApiError(
  /^[A-Z0-9_]{1,100}$/.test(error?.errorCode || '') ? error.errorCode : fallback,
  { status: Number.isInteger(error?.status) ? error.status : 0 }
);
const deliveryResult = data => {
  const raw = data?.result?.state || data?.status;
  return {
    status: terminal.has(raw) || ['queued', 'running'].includes(raw) ? raw : 'unknown',
    reference: data?.result?.reference || null,
    errorCode: data?.result?.errorCode || data?.errorCode || null
  };
};

// This controller is intentionally per mounted publisher. It never schedules a
// publish/retry: only explicit publish() can create an outbound operation.
export function createServerConnectOperation({ client, onChange = () => {}, uuid = () => crypto.randomUUID() }) {
  const generation = client.getGeneration();
  let disposed = false, sequence = 0, previewController = null, receiptController = null;
  let approved = null, pending = null;
  let state = Object.freeze({ preview: null, previewBusy: false, publishBusy: false,
    operationId: null, result: null, error: null });
  const current = () => !disposed && generation === client.getGeneration();
  const emit = patch => {
    if (!current()) return;
    state = Object.freeze({ ...state, ...patch }); onChange(state);
  };
  const applyResult = (operation, data) => {
    if (!current() || pending !== operation) return null;
    const result = deliveryResult(data), finished = terminal.has(result.status);
    if (finished) { pending = null; approved = null; }
    emit({ result, publishBusy: false, operationId: finished ? null : operation.id,
      ...(finished ? { preview: null } : {}),
      error: result.errorCode ? safeError({ errorCode: result.errorCode }) : null });
    return result;
  };
  function invalidatePreview() {
    if (!current() || pending) return;
    sequence++; previewController?.abort(); previewController = null; approved = null;
    emit({ preview: null, previewBusy: false, result: null, error: null });
  }
  return {
    getState: () => state,
    invalidatePreview,
    async preview(input) {
      if (!current() || pending) return null;
      invalidatePreview();
      const attempt = sequence, controller = new AbortController();
      previewController = controller;
      const latest = () => current() && attempt === sequence && previewController === controller;
      emit({ previewBusy: true });
      try {
        if (!['discord', 'kook'].includes(input?.platform)) throw new ApiError('PLATFORM_TARGET_SCOPE_MISMATCH');
        const binding = structuredClone({ platform: input.platform, targetId: input.targetId,
          expectedRevision: input.expectedRevision, wipeId: input.wipeId,
          serverConnectOverride: input.serverConnectOverride,
          language: input.language || (input.platform === 'discord' ? 'en' : 'zh-CN') });
        const { platform, ...body } = binding;
        const response = await client.request(`/api/v2/platform-admin/${platform}/actions/card_preview`, {
          method: 'POST', body: { ...body, cardType: 'server_connect' },
          headers: { 'Idempotency-Key': uuid() }, signal: controller.signal
        });
        if (!latest()) return null;
        const preview = response.data?.result?.preview;
        if (response.data?.status !== 'succeeded' || !preview?.id || !preview?.contentHash) {
          throw safeError({ errorCode: response.data?.result?.errorCode || response.data?.errorCode }, 'CARD_PREVIEW_FAILED');
        }
        // Keep an independent immutable binding: edits to input or a rendered
        // preview object must not change which target/content the user approved.
        approved = { ...binding, previewId: preview.id, contentHash: preview.contentHash };
        const snapshot = Object.freeze(structuredClone(preview));
        emit({ preview: snapshot, previewBusy: false, error: null });
        return snapshot;
      } catch (error) {
        if (latest()) emit({ preview: null, previewBusy: false, error: safeError(error, 'CARD_PREVIEW_FAILED') });
        return null;
      } finally {
        if (previewController === controller) previewController = null;
      }
    },
    async publish(mode = 'publish') {
      if (!current() || pending || state.publishBusy) return null;
      if (!['publish', 'refresh'].includes(mode)) return null;
      if (!approved || !state.preview || state.previewBusy) {
        emit({ error: new ApiError('CARD_PREVIEW_REQUIRED') }); return null;
      }
      const operation = { id: uuid(), binding: approved };
      pending = operation;
      emit({ operationId: operation.id, publishBusy: true, result: null, error: null });
      const { platform, expectedRevision, targetId, wipeId, previewId, contentHash } = operation.binding;
      try {
        const response = await client.request(`/api/v2/platform-admin/${platform}/actions/card_${mode}`, {
          method: 'POST', body: { expectedRevision, targetId, wipeId, cardType: 'server_connect',
            previewId, contentHash, mentionMode: 'none' }, headers: { 'Idempotency-Key': operation.id }
        });
        return applyResult(operation, response.data);
      } catch (error) {
        if (!current() || pending !== operation) return null;
        const failure = safeError(error);
        // API validation failures happen before a publish is accepted. A timeout,
        // conflict with an existing operation, or server failure still needs its receipt.
        const rejected = failure.status >= 400 && failure.status < 500 && failure.status !== 408 &&
          !['OPERATION_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT'].includes(failure.errorCode);
        if (rejected) { pending = null; approved = null; }
        const result = { status: rejected ? 'failed' : 'unknown', reference: null, errorCode: failure.errorCode };
        emit({ result, error: failure, publishBusy: false, operationId: rejected ? null : operation.id,
          ...(rejected ? { preview: null } : {}) });
        return result;
      }
    },
    async checkReceipt() {
      if (!current() || !pending || state.publishBusy || receiptController) return null;
      const operation = pending, controller = new AbortController();
      receiptController = controller; emit({ publishBusy: true, error: null });
      try {
        const response = await client.request(`/api/v2/platform-admin/operations/${encodeURIComponent(operation.id)}`, { signal: controller.signal });
        return applyResult(operation, response.data);
      } catch (error) {
        if (!current() || pending !== operation) return null;
        const failure = safeError(error);
        emit({ publishBusy: false, error: failure,
          result: { status: 'unknown', reference: state.result?.reference || null, errorCode: failure.errorCode } });
        return null;
      } finally {
        if (receiptController === controller) receiptController = null;
      }
    },
    dispose() {
      disposed = true; sequence++; approved = null;
      previewController?.abort(); receiptController?.abort();
      previewController = null; receiptController = null;
    }
  };
}
