import { error, integer, need } from './model.js';
import { IdentityError } from '../identity/errors.js';

export function createMediaLifecycle(options = {}) {
  const timeoutMs = integer(options.timeoutMs, 8000, 50, 30000), maxActive = integer(options.maxActive, 4, 1, 16);
  const active = new Set(); let stopped = false, stopping;
  function run(fn, signal) {
    if (stopped) return Promise.reject(error('MEDIA_STOPPED'));
    if (active.size >= maxActive) return Promise.reject(error('MEDIA_CAPACITY', 429));
    const controller = new AbortController(), job = { controller };
    const abort = () => controller.abort(error('MEDIA_CANCELLED'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(error('MEDIA_TIMEOUT', 504)), timeoutMs);
    const check = () => { if (controller.signal.aborted) throw controller.signal.reason; need(!stopped, 'MEDIA_STOPPED', 503); };
    active.add(job);
    job.promise = Promise.resolve().then(() => { check(); return fn({ signal: controller.signal, check }); })
      .then(value => { check(); return value; })
      .catch(e => {
        if (controller.signal.aborted) throw controller.signal.reason;
        // Rebuild domain errors rather than retain upstream message/cause/current fields carrying URLs or credentials.
        throw e instanceof IdentityError && /^[A-Z0-9_]{1,80}$/.test(e.errorCode) ? error(e.errorCode, e.status) : error('MEDIA_UNAVAILABLE');
      })
      .finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(job); });
    return job.promise;
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    for (const job of active) job.controller.abort(error('MEDIA_STOPPED'));
    // Retain ownership of late injected I/O and queued writes; never Promise.race away cleanup.
    stopping = Promise.allSettled([...active].map(job => job.promise)).then(() => {});
    return stopping;
  }
  return { run, stop, diagnostics: () => ({ stopped, active: active.size, timeoutMs, maxActive }) };
}
