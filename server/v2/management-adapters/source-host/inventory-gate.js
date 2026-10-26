// Manual inventory queries and automatic member scans share one Steam exit.
// Serialize their inventory requests and fail fast during an upstream cooldown.
export function createInventoryGate({ now = Date.now } = {}) {
  let tail = Promise.resolve(), retryAt = 0, retryAfterKnown = false, strikes = 0;
  const cancelled = () => Object.assign(new Error('SOURCE_TIMEOUT'), { errorCode: 'SOURCE_TIMEOUT', status: 503 });
  const limited = () => Object.assign(new Error('RATE_LIMITED'), {
    errorCode: 'RATE_LIMITED', status: 429, sourceId: 'community',
    retryAfterMs: Math.max(1000, retryAt - now()), retryAfterKnown
  });
  return (request, signal) => {
    if (signal?.aborted) return Promise.reject(cancelled());
    const pending = tail.then(async () => {
      if (signal?.aborted) throw cancelled();
      if (retryAt > now()) throw limited();
      const response = await request();
      if (response.status === 429) {
        const value = response.headers.get('retry-after');
        const seconds = /^\d+(\.\d+)?$/.test(value || ''), date = Date.parse(value);
        retryAfterKnown = Boolean(value && (seconds || Number.isFinite(date)));
        const delay = seconds ? Number(value) * 1000 : date - now();
        // With no server deadline, this is a local backoff, never a promised recovery time.
        const fallback = Math.min(900000, 60000 * 2 ** Math.min(strikes++, 4));
        retryAt = now() + Math.min(3600000, Math.max(1000, retryAfterKnown ? delay : fallback));
        throw limited();
      }
      if (response.ok) { strikes = 0; retryAt = 0; retryAfterKnown = false; }
      return response;
    });
    // Cancellation releases the caller immediately, but never releases this
    // serial slot until the owned request settles. A queued cancelled read is skipped.
    tail = pending.catch(() => {});
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => reject(cancelled());
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
}
