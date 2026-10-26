import { IdentityError } from '../../identity/errors.js';
import { need } from '../../platform-admin/model.js';

// Owns only this host's admission and external calls, never a shared worker/DB.
export function createPlatformHostLifecycle({ replayMemberOutbox, timeoutMs = 10000 }) {
  need(typeof replayMemberOutbox === 'function', 'PLATFORM_OUTBOX_DRAIN_REQUIRED', 503);
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 120000, 'PLATFORM_TIMEOUT_INVALID', 422);
  let state = 'created', starting, stopping;
  const pending = new Set(), controllers = new Set();
  const assertReady = () => need(state === 'ready', 'PLATFORM_HOST_NOT_READY', 503);
  function track(fn) {
    assertReady();
    const work = Promise.resolve().then(() => { assertReady(); return fn(); });
    pending.add(work);
    work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  async function io(fn, args = {}) {
    assertReady();
    const controller = new AbortController();
    controllers.add(controller);
    let timer;
    const assertCurrent = () => { assertReady(); need(!controller.signal.aborted, 'PLATFORM_IO_CANCELLED', 503); return args.assertCurrent?.(); };
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new IdentityError('PLATFORM_IO_CANCELLED', 503)), { once: true });
      timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => { assertCurrent(); return fn({ ...args, signal: controller.signal, assertCurrent }); }), cancelled]);
      assertCurrent();
      return value;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function start() {
    need(!['stopping', 'stopped'].includes(state), 'PLATFORM_HOST_STOPPED', 503);
    if (!starting) {
      state = 'starting';
      starting = Promise.resolve().then(replayMemberOutbox).then(() => {
        need(state === 'starting', 'PLATFORM_HOST_STOPPED', 503);
        state = 'ready';
      }).catch(error => { if (state === 'starting') { state = 'created'; starting = null; } throw error; });
    }
    return starting;
  }
  function stop(stopForwarding) {
    if (stopping) return stopping;
    state = 'stopping';
    for (const controller of controllers) controller.abort();
    stopping = (async () => {
      await Promise.allSettled([starting, stopForwarding?.(), ...pending]);
      state = 'stopped';
    })();
    return stopping;
  }
  return { assertReady, track, io, start, stop,
    diagnostics: () => ({ state, operations: pending.size, externalCalls: controllers.size, timerActive: false }) };
}
