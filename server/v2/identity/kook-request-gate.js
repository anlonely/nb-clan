import { IdentityError } from './errors.js';

// Space KOOK bot requests without holding the network request in the scheduling queue.
export function createKookRequestGate({ intervalMs = 1_000, maxPending = 100, maxWaitMs = 75_000,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let nextAt = 0, cooldownUntil = 0, pending = 0, tail = Promise.resolve();
  const busy = waitMs => new IdentityError('KOOK_BUSY', 503, {
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000))
  });
  return {
    cooldown(seconds) {
      cooldownUntil = Math.max(cooldownUntil, now() + Math.max(1, seconds) * 1_000);
    },
    async run(task) {
      if (pending >= maxPending) throw busy(Math.max(intervalMs, cooldownUntil - now()));
      pending += 1;
      const queuedAt = now();
      const slot = tail.then(async () => {
        while (true) {
          const waitMs = Math.max(0, Math.max(nextAt, cooldownUntil) - now());
          if (now() - queuedAt + waitMs > maxWaitMs) throw busy(Math.max(waitMs, intervalMs));
          if (!waitMs) break;
          await sleep(waitMs);
        }
        nextAt = now() + intervalMs;
      });
      tail = slot.catch(() => {});
      try { await slot; return await task(); }
      finally { pending -= 1; }
    }
  };
}
