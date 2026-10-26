import { requireValue as need } from '../../member-admin/repository.js';

// Provider-scoped invalidation also covers pre-account OAuth states,
// whose platform subject is not known until code exchange finishes. The host
// must check the captured generation after external awaits before issuing a
// handoff/onboarding context. Steam already re-reads onboarding before bind.
export function createMemberContextInvalidator({ authContexts, invalidatePlatformSessions }) {
  need(authContexts?.entries instanceof Map && typeof invalidatePlatformSessions === 'function',
    'IDENTITY_CONTEXT_INVALIDATOR_REQUIRED', 503);
  const generations = new Map();
  const applied = new Set();
  return {
    assertReady: () => true,
    capture: (provider = '*') => generations.get(provider) || 0,
    assertCurrent(value, provider = '*') { need(value === (generations.get(provider) || 0), 'AUTH_CONTEXT_EXPIRED', 410); },
    invalidate(event) {
      if (applied.has(event.id)) return;
      const provider = event.provider === 'wechat' && event.appId ? `wechat:${event.appId}` : event.provider;
      authContexts.invalidateProvider?.(provider);
      for (const key of new Set(['*', provider])) generations.set(key, (generations.get(key) || 0) + 1);
      const removed = new Set();
      for (const [key, entry] of authContexts.entries) {
        const p = entry.profile?.provider || entry.provider;
        const externalId = entry.profile?.id || entry.externalId;
        const subject = p?.startsWith('wechat:') ? `${p.slice(7)}:${externalId}` : externalId;
        const targetAccount = event.accountId && entry.accountId === event.accountId;
        const targetProvider = p === provider || p === event.provider && event.provider !== 'wechat';
        if (targetAccount || targetProvider && (!externalId || event.externalIds.includes(subject))) removed.add(key);
      }
      for (const [key, entry] of authContexts.entries) if (removed.has(entry.onboardingHash)) removed.add(key);
      for (const key of removed) authContexts.entries.delete(key);
      const result = invalidatePlatformSessions(event);
      need(!result?.then, 'IDENTITY_CONTEXT_INVALIDATOR_ASYNC', 503);
      applied.add(event.id);
    }
  };
}
