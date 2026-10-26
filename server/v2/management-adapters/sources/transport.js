import { need } from '../../stats/model.js';

export function checkAbort(signal) {
  need(!signal?.aborted, 'SOURCE_TIMEOUT', 503);
}
export function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('SOURCE_TIMEOUT'), { errorCode: 'SOURCE_TIMEOUT' }));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** Host supplies an origin-bound read transport. Called once per HTTP page, including retries.
 * Reuses the host's ONE BM queue; no independent quota or nested queue in readers.
 */
export function createBattlemetricsReadTransport({ queue, get }) {
  need(queue?.enqueue && queue?.waitTurn && typeof get === 'function', 'SOURCE_NOT_CONFIGURED', 503);
  return async (path, { signal, queueMeta, ...options } = {}) => {
    checkAbort(signal);
    need(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && new URL(path, 'https://api.battlemetrics.com').origin === 'https://api.battlemetrics.com', 'INVALID_DATA');
    return abortable(queue.enqueue({ meta: queueMeta, run: async task => {
      checkAbort(signal);
      // Old queue waitTurn is not abortable. Race only the caller; the wait retains its
      // quota reservation, and the post-wait guard prevents cancelled network activity.
      await queue.waitTurn(task);
      checkAbort(signal);
      const method = options.method || 'GET';
      need(method === 'GET' || method === 'POST' && path === '/players/match', 'INVALID_DATA');
      const response = await get(path, { ...options, method, signal });
      checkAbort(signal);
      queue.observeRateLimitHeaders(response.headers);
      if (response.status === 429) {
        const retry = response.headers?.get?.('retry-after');
        const delay = /^\d+(\.\d+)?$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        const retryAfterMs = Math.min(3600000, Math.max(1000, Number.isFinite(delay) ? delay : 60000));
        queue.markRateLimited(retryAfterMs);
        throw Object.assign(new Error('RATE_LIMITED'), { status: 429, retryAfterMs });
      }
      need(response.status !== 401 && response.status !== 403, 'CREDENTIALS_INVALID', 503);
      need(response.ok, 'SOURCE_UNAVAILABLE', 503);
      return response.json();
    }}), signal);
  };
}
export function sourceFailure(error) {
  if (error?.status === 429) return { outcome: 'retry', reason: 'RATE_LIMITED', retryAfterMs: error.retryAfterMs || 60000 };
  const code = error?.errorCode;
  if (['CREDENTIALS_INVALID', 'PROXY_UNAVAILABLE', 'SOURCE_NOT_CONFIGURED', 'ADMISSION_ROLE_CONFIG_INVALID'].includes(code)) return { outcome: 'common_failure', reason: code };
  if (code === 'SOURCE_NO_MATCH') return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' };
  if (['INVALID_DATA', 'INVALID_TIME_RANGE', 'SOURCE_CONTEXT_CHANGED'].includes(code)) return { outcome: 'failed', reason: 'INVALID_DATA' };
  return { outcome: 'retry', reason: code === 'SOURCE_TIMEOUT' ? code : 'SOURCE_UNAVAILABLE' };
}
