import { normalizeText } from './store.js';

export function currentWipe(store) {
  return (store?.wipes || []).find((wipe) => wipe.status === 'active') || null;
}

export function wipeStartTimeMs(wipe) {
  const time = Date.parse(wipe?.startedAt || '');
  return Number.isFinite(time) ? time : 0;
}

export function isWipeStartedServer(wipe, nowMs = Date.now()) {
  const startedAt = wipeStartTimeMs(wipe);
  return !startedAt || startedAt <= nowMs;
}

export function normalizeKdaMemberScope(value = '') {
  const scope = normalizeText(value, 40);
  if (scope === 'all_members' || scope === 'members') return 'all_members';
  if (scope === 'participants') return 'participants';
  return '';
}

export function wipeHasAllMembersKdaScope(wipe) {
  return normalizeKdaMemberScope(wipe?.kdaMemberScope || wipe?.kdaSyncScope || wipe?.kdaScope) === 'all_members';
}

export function kdaSyncUsesAllMembers(store, wipe) {
  if (!wipe?.id) return false;
  if (wipeHasAllMembersKdaScope(wipe)) return true;
  const active = currentWipe(store);
  return Boolean(wipe?.id && wipe.status !== 'closed' && active?.id === wipe.id);
}
