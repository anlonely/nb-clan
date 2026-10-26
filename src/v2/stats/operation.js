import { ApiError } from '../query-client.js';

// Keep the submission lock outside React render timing. A pending command is
// never sent twice, and an old page cannot navigate or show success after exit.
export function createStatsOperation({ client, onChange = () => {}, onSaved = () => {}, uuid = () => crypto.randomUUID() }) {
  const generation = client.getGeneration();
  let disposed = false, controller = null, pending = null;
  const current = () => !disposed && generation === client.getGeneration();
  const assertCurrent = () => { if (!current()) throw new ApiError('REQUEST_SUPERSEDED'); };
  return {
    async run(path, body, successMessage = '') {
      assertCurrent();
      if (controller) throw new ApiError('OPERATION_IN_PROGRESS');
      const signature = JSON.stringify([path, body]);
      if (pending?.signature !== signature) pending = { signature, id: uuid() };
      const id = pending.id, requestController = new AbortController();
      controller = requestController;
      onChange({ busy: true });
      try {
        const result = (await client.request(path, {
          method: 'POST', body, headers: { 'Idempotency-Key': id }, signal: requestController.signal
        })).data;
        assertCurrent();
        pending = null;
        onChange({ result });
        client.invalidateQueries(['stats']);
        if (successMessage) onSaved(successMessage, { id });
        return result;
      } catch (error) {
        assertCurrent();
        // Keep the key for an explicit retry, including an in-progress response;
        // cancelling a browser request does not roll back a server command.
        onChange({ error });
        throw error;
      } finally {
        if (controller === requestController) controller = null;
      }
    },
    dispose() { disposed = true; controller?.abort(); pending = null; }
  };
}
