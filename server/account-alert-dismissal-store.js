import {
  normalizeText,
  nowIso,
  patchStoreCache,
  readStore,
  runStoreWriteTask,
  updateStore
} from './store.js';
import { getSqliteCollection, getSqliteRecord, writeSqliteStorePatch } from './storage/repository.js';
import { replaceCachedRecord } from './storage/store-patch-diff.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import { memberDisplayName } from './steam.js';
import {
  appendLog,
  applyCachedLogPatch,
  createLogEntry,
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';

export const ACCOUNT_ALERT_DISMISSAL_TYPES = new Set([
  'low-game-hours',
  'low-inventory',
  'no-online-14d',
  'private-account',
  'private-inventory',
  'private-playtime',
  'account-restricted',
  'steam-ban-or-restriction',
  'unassigned-squad'
]);

function accountAlertDismissalsUnavailableError(error) {
  return Object.assign(new Error('账号提醒确认状态读取暂不可用，请稍后重试'), {
    status: 503,
    code: 'account_alert_dismissals_unavailable',
    cause: error
  });
}

function emptyAccountAlertDismissalStore(dismissals = []) {
  return {
    accountAlertDismissals: dismissals,
    settings: {},
    users: [],
    members: [],
    squads: [],
    squadMembers: [],
    wipes: [],
    wipeParticipants: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    permissionRoles: [],
    syncState: {}
  };
}

export function publicAccountAlertDismissal(item = {}) {
  return {
    id: item.id || '',
    memberId: item.memberId || '',
    type: item.type || '',
    dismissedAt: item.dismissedAt || '',
    dismissedByUserId: item.dismissedByUserId || ''
  };
}

export function publicAccountAlertDismissals(store = {}) {
  return (store.accountAlertDismissals || []).map(publicAccountAlertDismissal);
}

export function normalizeAccountAlertDismissalInput(body = {}) {
  let memberId = normalizeText(body.memberId, 100);
  let type = normalizeText(body.type, 80);
  const id = normalizeText(body.id, 180);
  if ((!memberId || !type) && id.includes(':')) {
    const [parsedMemberId, ...rest] = id.split(':');
    memberId ||= normalizeText(parsedMemberId, 100);
    type ||= normalizeText(rest.join(':'), 80);
  }
  if (!memberId || !type || (!ACCOUNT_ALERT_DISMISSAL_TYPES.has(type) && !type.startsWith('risk_rule_'))) return null;
  return {
    id: `${memberId}:${type}`,
    memberId,
    type
  };
}

export async function readAccountAlertDismissalsRuntimeStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    return emptyAccountAlertDismissalStore(await getSqliteCollection('accountAlertDismissals', { limit: 0 }));
  } catch (error) {
    console.warn('[nb-clan] sqlite account alert dismissals fallback:', error?.message || error);
    throw accountAlertDismissalsUnavailableError(error);
  }
}

export async function upsertAccountAlertDismissal(req, dismissal) {
  if (!sqlitePrimaryMode()) {
    await updateStore((store) => {
      store.accountAlertDismissals ||= [];
      const member = store.members.find((item) => item.id === dismissal.memberId);
      if (!member) {
        throw Object.assign(new Error('成员不存在'), { status: 404 });
      }
      const existingIndex = store.accountAlertDismissals.findIndex((item) => item.id === dismissal.id);
      const nextDismissal = {
        ...dismissal,
        dismissedAt: nowIso(),
        dismissedByUserId: req.user.id
      };
      if (existingIndex >= 0) store.accountAlertDismissals[existingIndex] = nextDismissal;
      else store.accountAlertDismissals.push(nextDismissal);
      appendLog(store, req, 'account_alert_dismiss', `确认账号提醒 ${memberDisplayName(member)} ${dismissal.type}`, {
        memberId: member.id,
        steamId: member.steamId,
        targetId: dismissal.id
      });
    });
    return;
  }
  await runStoreWriteTask(async () => {
    const member = await getSqliteRecord('members', dismissal.memberId).catch(() => null);
    if (!member) throw Object.assign(new Error('成员不存在'), { status: 404 });
    const nextDismissal = {
      ...dismissal,
      dismissedAt: nowIso(),
      dismissedByUserId: req.user.id
    };
    const log = createLogEntry(req, 'account_alert_dismiss', `确认账号提醒 ${memberDisplayName(member)} ${dismissal.type}`, {
      memberId: member.id,
      steamId: member.steamId,
      targetId: dismissal.id
    });
    const patchResult = await writeSqliteStorePatch({
      reason: 'account_alert_dismiss',
      upserts: {
        accountAlertDismissals: [nextDismissal],
        logs: [log]
      },
      trims: logTrimPatch()
    });
    await patchStoreCache((store) => {
      store.accountAlertDismissals ||= [];
      replaceCachedRecord(store.accountAlertDismissals, nextDismissal);
      applyCachedLogPatch(store, [log], trimmedLogIds(patchResult));
    });
  });
}

export async function clearAccountAlertDismissals(req) {
  if (!sqlitePrimaryMode()) {
    let cleared = 0;
    await updateStore((store) => {
      const currentDismissals = Array.isArray(store.accountAlertDismissals) ? store.accountAlertDismissals : [];
      cleared = currentDismissals.length;
      store.accountAlertDismissals = [];
      appendLog(store, req, 'account_alert_dismiss_clear', `清除账号提醒确认状态 ${cleared} 条`, { metadata: { cleared } });
    });
    return cleared;
  }
  return runStoreWriteTask(async () => {
    const dismissals = await getSqliteCollection('accountAlertDismissals', { limit: 0 });
    const cleared = dismissals.length;
    const log = createLogEntry(req, 'account_alert_dismiss_clear', `清除账号提醒确认状态 ${cleared} 条`, { metadata: { cleared } });
    const patchResult = await writeSqliteStorePatch({
      reason: 'account_alert_dismiss_clear',
      replaces: { accountAlertDismissals: [] },
      upserts: { logs: [log] },
      trims: logTrimPatch()
    });
    await patchStoreCache((store) => {
      store.accountAlertDismissals = [];
      applyCachedLogPatch(store, [log], trimmedLogIds(patchResult));
    });
    return cleared;
  });
}
