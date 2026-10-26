import { normalizeText, nowIso, patchStoreCache, readStore, runStoreWriteTask } from './store.js';
import {
  countSqliteRecordsByJsonField,
  countSqliteRecordsByJsonTimeRange,
  countSqliteRecordsWhereJsonFieldMissing,
  findSqliteRecordByJsonField,
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordCounts,
  getSqliteRecordsByJsonField,
  getSqliteRecordsWhereJsonFieldPresent,
  getSqliteRecordsWhereJsonFieldMissing,
  getSqliteScalar,
  writeSqliteStorePatch
} from './storage/repository.js';
import { replaceCachedRecord } from './storage/store-patch-diff.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import { hydrateMemberScopedRuntimeStore } from './member-store.js';
import { readWipeRuntimeStore } from './wipe-store.js';
import { normalizeMemberStatus } from './member-status.js';
import { parseLogDateRange } from './log-date-range.js';
import {
  getSqliteRecordsByJsonFieldInChunks,
  getSqliteRecordsByIds,
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';
import {
  currentWipe,
  isWipeStartedServer,
  kdaSyncUsesAllMembers
} from './wipe-utils.js';

const WECHAT_NOTIFICATION_TEMPLATE_ENV_KEYS = {
  joinReviewResult: ['NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT', 'NB_WECHAT_TEMPLATE_REVIEW_RESULT'],
  adminJoinReview: ['NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW', 'NB_WECHAT_TEMPLATE_ADMIN_REVIEW_PENDING', 'NB_WECHAT_TEMPLATE_ADMIN_REVIEW'],
  wipeSignupStatus: ['NB_WECHAT_TEMPLATE_WIPE_SIGNUP_STATUS'],
  wipeOpen: ['NB_WECHAT_TEMPLATE_WIPE_OPEN'],
  wipeReminder: ['NB_WECHAT_TEMPLATE_WIPE_REMINDER']
};

const WECHAT_APPLICATION_SUMMARY_STATUSES = ['pending', 'need_more', 'approved', 'rejected', 'cancelled'];

function wechatRuntimeStoreShell(overrides = {}) {
  return {
    users: [],
    members: [],
    squads: [],
    squadMembers: [],
    wipes: [],
    wipeParticipants: [],
    uploads: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    wipeSettlements: [],
    permissionRoles: [],
    wechatUsers: [],
    joinApplications: [],
    wechatNotifications: [],
    operationRuns: [],
    logs: [],
    settings: {},
    syncState: {},
    ...overrides
  };
}

function wechatPartialStore(error, source, overrides = {}) {
  return wechatRuntimeStoreShell({
    wechatPartial: true,
    wechatReadSource: source,
    wechatReadError: normalizeText(error?.message || error, 240),
    ...overrides
  });
}

function wechatPartialList(error, source, overrides = {}) {
  return {
    wechatPartial: true,
    wechatReadSource: source,
    wechatReadError: normalizeText(error?.message || error, 240),
    ...overrides
  };
}

function wechatStoreReadUnavailableError(label, cause) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'wechat_store_read_unavailable',
    skipApiErrorLog: true,
    cause
  });
}

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function isWechatSystemId(value) {
  return /^wechat_user_[a-z0-9-]+$/i.test(normalizeText(value, 120));
}

export function configuredWechatSubscriptionTemplates(store = {}) {
  const configured = store.settings?.wechat?.subscriptionTemplates || {};
  return Object.fromEntries(Object.keys(WECHAT_NOTIFICATION_TEMPLATE_ENV_KEYS).map((key) => {
    const storedValue = normalizeText(configured[key], 160);
    if (storedValue) return [key, storedValue];
    const envValue = WECHAT_NOTIFICATION_TEMPLATE_ENV_KEYS[key]
      .map((envKey) => normalizeText(process.env[envKey], 160))
      .find(Boolean) || '';
    return [key, envValue];
  }));
}

export async function readWechatAuthStore(tokenHash = '') {
  if (!sqliteEnabled()) return readStore();
  try {
    if (tokenHash) {
      const session = await findSqliteRecordByJsonField('wechatSessions', 'tokenHash', tokenHash);
      if (!session) return { wechatSessions: [], wechatUsers: [] };
      const wechatUser = session.wechatUserId ? await getSqliteRecord('wechatUsers', session.wechatUserId) : null;
      return {
        wechatSessions: [session],
        wechatUsers: wechatUser ? [wechatUser] : []
      };
    }
    const [wechatSessions, wechatUsers] = await Promise.all([
      getSqliteCollection('wechatSessions', { limit: 1000 }),
      getSqliteCollection('wechatUsers', { limit: 1000 })
    ]);
    return { wechatSessions, wechatUsers };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat auth store fallback:', error?.message || error);
    return wechatPartialList(error, 'wechat_auth', { wechatSessions: [], wechatUsers: [] });
  }
}

export async function readWechatUserByIdForAuth(wechatUserId) {
  const normalizedId = normalizeText(wechatUserId, 120);
  if (!normalizedId) return null;
  if (sqliteEnabled()) {
    try {
      return await getSqliteRecord('wechatUsers', normalizedId);
    } catch (error) {
      console.warn('[nb-clan] sqlite wechat signed auth fallback:', error?.message || error);
      return null;
    }
  }
  const store = await readStore();
  return (store.wechatUsers || []).find((item) => item.id === normalizedId) || null;
}

export async function readWechatLoginIdentityStore(identity) {
  if (!sqliteEnabled()) return readStore();
  try {
    return { wechatUsers: await readWechatUsersByIdentity(identity) };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat login identity fallback:', error?.message || error);
    return wechatPartialList(error, 'wechat_login_identity', { wechatUsers: [] });
  }
}

export async function readWechatUsersByIdentity(identity, options = {}) {
  const openid = normalizeText(identity?.openid, 128);
  const unionid = normalizeText(identity?.unionid, 128);
  const [openidUser, unionidUser] = await Promise.all([
    openid ? findSqliteRecordByJsonField('wechatUsers', 'openid', openid) : Promise.resolve(null),
    unionid ? findSqliteRecordByJsonField('wechatUsers', 'unionid', unionid) : Promise.resolve(null)
  ]);
  const candidates = [];
  if (openidUser) candidates.push(openidUser);
  if (unionidUser && !candidates.some((item) => item.id === unionidUser.id)) candidates.push(unionidUser);
  if (options.fullReadOnConflict && openidUser && unionidUser && openidUser.id !== unionidUser.id) {
    return getSqliteCollection('wechatUsers', { limit: 0 });
  }
  return candidates;
}

export async function readWechatNotificationSettingsStore(wechatUserId) {
  if (!sqliteEnabled()) return readStore();
  try {
    const normalizedWechatUserId = normalizeText(wechatUserId, 120);
    const [settings, wechatUser] = await Promise.all([
      getSqliteScalar('settings'),
      normalizedWechatUserId ? getSqliteRecord('wechatUsers', normalizedWechatUserId) : Promise.resolve(null)
    ]);
    if (!wechatUser) return wechatRuntimeStoreShell({ settings: settings || {} });
    return {
      settings: settings || {},
      wechatUsers: [wechatUser]
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat notification settings fallback:', error?.message || error);
    return wechatPartialStore(error, 'wechat_notification_settings', { settings: {} });
  }
}

export async function readWechatAccessStatusStore(wechatUserId) {
  if (!sqliteEnabled()) return readStore();
  try {
    if (sqlitePrimaryMode()) {
      const normalizedWechatUserId = normalizeText(wechatUserId, 120);
      const wechatUser = normalizedWechatUserId ? await getSqliteRecord('wechatUsers', normalizedWechatUserId) : null;
      if (!wechatUser) {
        return {
          users: [],
          members: [],
          squads: [],
          squadMembers: [],
          wipes: [],
          wipeParticipants: [],
          kdaRows: [],
          memberProfiles: [],
          wechatUsers: [],
          joinApplications: [],
          wechatNotifications: [],
          settings: {},
          syncState: {}
        };
      }
      const [joinApplications, wechatNotifications] = await Promise.all([
        getSqliteRecordsByJsonField('joinApplications', 'wechatUserId', [normalizedWechatUserId], { limit: 0 }),
        getSqliteRecordsByJsonField('wechatNotifications', 'wechatUserId', [normalizedWechatUserId], { limit: 0 })
      ]);
      const memberIds = new Set();
      if (wechatUser.memberId) memberIds.add(wechatUser.memberId);
      for (const application of joinApplications) {
        if (application.memberId) memberIds.add(application.memberId);
      }
      const applicationSteamIds = joinApplications.map((application) => normalizeText(application.steamId, 80)).filter(Boolean);
      const [membersById, membersBySteamId] = await Promise.all([
        getSqliteRecordsByIds('members', [...memberIds]),
        applicationSteamIds.length
          ? getSqliteRecordsByJsonField('members', 'steamId', applicationSteamIds, { limit: 0 })
          : Promise.resolve([])
      ]);
      const members = mergeRecordsById(membersById, membersBySteamId);
      const scopedMemberIds = members.map((member) => member.id).filter(Boolean);
      const memberSteamIds = members.map((member) => normalizeText(member.steamId, 80)).filter(Boolean);
      const [squadMembers, wipes, usersByBoundSteamId, usersBySteamId, usersById] = await Promise.all([
        scopedMemberIds.length
          ? getSqliteRecordsByJsonField('squadMembers', 'memberId', scopedMemberIds, { limit: 0 })
          : Promise.resolve([]),
        scopedMemberIds.length
          ? getSqliteRecordsByJsonField('wipes', 'status', ['active', 'closed'], { limit: 0 })
          : Promise.resolve([]),
        memberSteamIds.length
          ? getSqliteRecordsByJsonField('users', 'boundSteamId', memberSteamIds, { limit: 0 })
          : Promise.resolve([]),
        memberSteamIds.length
          ? getSqliteRecordsByJsonField('users', 'steamId', memberSteamIds, { limit: 0 })
          : Promise.resolve([]),
        getSqliteRecordsByIds('users', members
          .map((member) => normalizeText(member.invitedByUserId, 120))
          .filter((id) => id && !id.startsWith('discord:')))
      ]);
      const squadIds = uniqueNormalizedTexts(squadMembers.map((item) => item.squadId), 120);
      const squads = await getSqliteRecordsByIds('squads', squadIds);
      const users = mergeRecordsById(usersByBoundSteamId, usersBySteamId, usersById);
      const store = {
        users,
        members,
        squads,
        squadMembers,
        wipes,
        wipeParticipants: [],
        kdaRows: [],
        memberProfiles: [],
        wechatUsers: [wechatUser],
        joinApplications,
        wechatNotifications,
        settings: {},
        syncState: {}
      };
      await hydrateMemberScopedRuntimeStore(store, members.map((member) => member.id));
      const participantSquadIds = uniqueNormalizedTexts((store.wipeParticipants || [])
        .map((item) => item.squadId)
        .filter((id) => id && !(store.squads || []).some((squad) => squad.id === id)), 120);
      if (participantSquadIds.length) {
        const participantSquads = await getSqliteRecordsByIds('squads', participantSquadIds);
        store.squads = mergeRecordsById(store.squads, participantSquads);
      }
      return store;
    }
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      kdaRows,
      memberProfiles,
      wechatUsers,
      joinApplications,
      wechatNotifications
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteCollection('wipeParticipants', { limit: 0 }),
      getSqliteCollection('kdaRows', { limit: 0 }),
      getSqliteCollection('memberProfiles', { limit: 0 }),
      getSqliteCollection('wechatUsers', { limit: 0 }),
      getSqliteCollection('joinApplications', { limit: 0 }),
      getSqliteCollection('wechatNotifications', { limit: 0 })
    ]);
    if (!wechatUsers.some((item) => item.id === wechatUserId)) return readStore();
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      kdaRows,
      memberProfiles,
      wechatUsers,
      joinApplications,
      wechatNotifications,
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat access-status fallback:', error?.message || error);
    return wechatPartialStore(error, 'wechat_access_status');
  }
}

export async function readWechatWipeRuntimeStore(wipeId = 'current', {
  currentMemberId = '',
  includeUploads = true,
  includeWechatUsers = true,
  includeMemberContext = true,
  includePermissionRoles = false
} = {}) {
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includeUploads, includeWechatUsers, includePermissionRoles });
  const requestedWipeId = normalizeText(wipeId, 120) || 'current';
  const normalizedCurrentMemberId = normalizeText(currentMemberId, 120);
  try {
    const [wipes, permissionRoles] = await Promise.all([
      requestedWipeId === 'current'
        ? getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 })
        : getSqliteRecord('wipes', requestedWipeId).then((wipe) => (wipe ? [wipe] : [])),
      includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 1000 }) : Promise.resolve([])
    ]);
    const wipe = requestedWipeId === 'current'
      ? currentWipe({ wipes })
      : wipes.find((item) => item.id === requestedWipeId);
    const normalizedWipeId = normalizeText(wipe?.id, 120);
    const [wipeParticipantsByWipe, uploads] = await Promise.all([
      includeMemberContext && normalizedWipeId
        ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [normalizedWipeId], { limit: 0 })
        : Promise.resolve([]),
      includeUploads && normalizedWipeId
        ? getSqliteRecordsByJsonField('uploads', 'ownerId', [normalizedWipeId], { limit: 0 })
        : Promise.resolve([])
    ]);
    const memberIds = uniqueNormalizedTexts([
      normalizedCurrentMemberId,
      ...wipeParticipantsByWipe.map((participant) => participant.memberId)
    ], 120);
    const members = includeMemberContext && memberIds.length
      ? await getSqliteRecordsByIds('members', memberIds)
      : [];
    const memberSteamIds = uniqueNormalizedTexts(members.map((member) => member.steamId), 80);
    const memberWechatUserIds = uniqueNormalizedTexts(
      members.flatMap((member) => [
        member.wechatUserId,
        isWechatSystemId(member.wechatId) ? member.wechatId : ''
      ]),
      120
    );
    const invitedByUserIds = uniqueNormalizedTexts(
      members
        .map((member) => member.invitedByUserId)
        .filter((id) => !normalizeText(id, 120).startsWith('discord:')),
      120
    );
    const [
      squadMembers,
      usersByBoundSteamId,
      usersBySteamId,
      usersById,
      wechatUsersByMemberId,
      wechatUsersById
    ] = await Promise.all([
      includeMemberContext && memberIds.length
        ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
        : Promise.resolve([]),
      includeMemberContext && memberSteamIds.length
        ? getSqliteRecordsByJsonField('users', 'boundSteamId', memberSteamIds, { limit: 0 })
        : Promise.resolve([]),
      includeMemberContext && memberSteamIds.length
        ? getSqliteRecordsByJsonField('users', 'steamId', memberSteamIds, { limit: 0 })
        : Promise.resolve([]),
      includeMemberContext && invitedByUserIds.length
        ? getSqliteRecordsByIds('users', invitedByUserIds)
        : Promise.resolve([]),
      includeWechatUsers && includeMemberContext && memberIds.length
        ? getSqliteRecordsByJsonField('wechatUsers', 'memberId', memberIds, { limit: 0 })
        : Promise.resolve([]),
      includeWechatUsers && includeMemberContext && memberWechatUserIds.length
        ? getSqliteRecordsByIds('wechatUsers', memberWechatUserIds)
        : Promise.resolve([])
    ]);
    const squadIds = uniqueNormalizedTexts([
      ...wipeParticipantsByWipe.map((participant) => participant.squadId),
      ...squadMembers.map((item) => item.squadId)
    ], 120);
    const squads = includeMemberContext && squadIds.length
      ? await readSqliteRecordsByIds('squads', squadIds)
      : [];
    const store = {
      users: mergeRecordsById(usersByBoundSteamId, usersBySteamId, usersById),
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants: wipeParticipantsByWipe,
      uploads,
      wechatUsers: mergeRecordsById(wechatUsersByMemberId, wechatUsersById),
      wipeSettlements: [],
      permissionRoles,
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      discordMemberApplications: [],
      settings: {},
      syncState: {}
    };
    if (includeMemberContext && memberIds.length) {
      await hydrateMemberScopedRuntimeStore(store, memberIds, { includeWechatUsers });
      store.wechatUsers = mergeRecordsById(store.wechatUsers, wechatUsersById);
    }
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat wipe runtime fallback:', error?.message || error);
    throw wechatStoreReadUnavailableError('微信档期读取', error);
  }
}

export async function readWechatAdminWipeLifecycleWriteStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const includeNotificationContext = Boolean(options.includeNotificationContext);
    const [
      wipes,
      settings
    ] = await Promise.all([
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteScalar('settings')
    ]);
    const notificationTemplateConfigured = Boolean(
      includeNotificationContext &&
      configuredWechatSubscriptionTemplates({ settings: settings || {} }).wipeOpen
    );
    const requestedWipeId = normalizeText(options.requestedWipeId, 120);
    const notificationTargetWipeId = notificationTemplateConfigured
      ? requestedWipeId === 'current'
        ? normalizeText(currentWipe({ wipes })?.id, 120)
        : requestedWipeId
      : '';
    const [
      activeMembers,
      legacyActiveMembers,
      wechatNotifications
    ] = notificationTemplateConfigured
      ? await Promise.all([
          getSqliteRecordsByJsonField('members', 'memberStatus', ['active'], { limit: 0 }),
          getSqliteRecordsWhereJsonFieldMissing('members', 'memberStatus', { limit: 0 }),
          notificationTargetWipeId
            ? getSqliteRecordsByJsonField('wechatNotifications', 'applicationId', [notificationTargetWipeId], { limit: 0 })
            : Promise.resolve([])
        ])
      : [[], [], []];
    const members = notificationTemplateConfigured
      ? mergeRecordsById(activeMembers, legacyActiveMembers)
          .filter((member) => normalizeMemberStatus(member.memberStatus) === 'active')
      : [];
    const memberIds = uniqueNormalizedTexts(members.map((member) => member.id), 160);
    const wechatUsers = notificationTemplateConfigured && memberIds.length
      ? await getSqliteRecordsByJsonFieldInChunks('wechatUsers', 'memberId', memberIds)
      : [];
    return {
      users: [],
      members,
      squads: [],
      squadMembers: [],
      wipes,
      wipeParticipants: [],
      uploads: [],
      wechatUsers,
      wechatNotifications,
      operationRuns: [],
      logs: [],
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      wipeSettlements: [],
      permissionRoles: [],
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat admin wipe lifecycle fallback:', error?.message || error);
    return wechatPartialStore(error, 'wechat_admin_wipe_lifecycle');
  }
}

export async function readWechatWipeSignupWriteStore(wechatUserId, requestedWipeId) {
  const normalizedWechatUserId = normalizeText(wechatUserId, 120);
  const normalizedWipeId = normalizeText(requestedWipeId, 120);
  const [
    squads,
    wipes,
    wechatUser,
    settings
  ] = await Promise.all([
    getSqliteCollection('squads', { limit: 0 }),
    normalizedWipeId === 'current'
      ? getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 })
      : getSqliteRecord('wipes', normalizedWipeId).then((wipe) => (wipe ? [wipe] : [])),
    normalizedWechatUserId ? getSqliteRecord('wechatUsers', normalizedWechatUserId) : Promise.resolve(null),
    getSqliteScalar('settings')
  ]);
  const currentMemberId = normalizeText(wechatUser?.memberId, 120);
  const currentMember = currentMemberId ? await getSqliteRecord('members', currentMemberId) : null;
  const baseStore = {
    users: [],
    members: currentMember ? [currentMember] : [],
    squads,
    squadMembers: [],
    wipes,
    permissionRoles: [],
    wipeParticipants: [],
    wechatUsers: wechatUser ? [wechatUser] : [],
    wechatNotifications: [],
    operationRuns: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    settings: settings || {},
    syncState: {},
    logs: []
  };
  const wipe = normalizedWipeId === 'current'
    ? currentWipe(baseStore)
    : wipes.find((item) => item.id === normalizedWipeId);
  const actualWipeId = normalizeText(wipe?.id, 120);
  const shouldPrepareGeneratedKda = Boolean(
    actualWipeId &&
    process.env.NB_DISABLE_EXTERNAL_VITAL === '1' &&
    isWipeStartedServer(wipe)
  );
  const generatedKdaUsesAllMembers = shouldPrepareGeneratedKda && kdaSyncUsesAllMembers(baseStore, wipe);
  const [wipeParticipants, kdaRows, kdaSnapshots] = await Promise.all([
    actualWipeId && shouldPrepareGeneratedKda
      ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [actualWipeId], { limit: 0 })
      : (currentMemberId ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', [currentMemberId], { limit: 0 }) : Promise.resolve([])),
    shouldPrepareGeneratedKda
      ? getSqliteRecordsByJsonField('kdaRows', 'wipeId', [actualWipeId], { limit: 0 })
      : Promise.resolve([]),
    shouldPrepareGeneratedKda
      ? getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [actualWipeId], { limit: 0 })
      : Promise.resolve([])
  ]);
  let members = currentMember ? [currentMember] : [];
  if (generatedKdaUsesAllMembers) {
    const kdaMemberIds = uniqueNormalizedTexts([
      currentMemberId,
      ...wipeParticipants.map((participant) => participant.memberId)
    ], 120);
    const [membersWithSteamId, participantMembers] = await Promise.all([
      getSqliteRecordsWhereJsonFieldPresent('members', 'steamId', { limit: 0 }),
      kdaMemberIds.length ? getSqliteRecordsByIds('members', kdaMemberIds) : Promise.resolve([])
    ]);
    members = mergeRecordsById(membersWithSteamId, participantMembers, currentMember ? [currentMember] : []);
  } else if (shouldPrepareGeneratedKda) {
    const kdaMemberIds = uniqueNormalizedTexts([
      currentMemberId,
      ...wipeParticipants.map((participant) => participant.memberId)
    ], 120);
    members = await getSqliteRecordsByIds('members', kdaMemberIds);
  }
  const scopedMemberIds = uniqueNormalizedTexts([
    currentMemberId,
    ...members.map((member) => member.id)
  ], 120);
  const squadMembers = scopedMemberIds.length
    ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', scopedMemberIds, { limit: 0 })
    : [];
  return {
    ...baseStore,
    members,
    squadMembers,
    wipeParticipants,
    kdaRows,
    kdaSnapshots
  };
}

async function readWechatReviewMemberRuntimeContextForSqlite(members = []) {
  const scopedMembers = Array.isArray(members) ? members.filter(Boolean) : [];
  const memberIds = uniqueNormalizedTexts(scopedMembers.map((member) => member.id), 120);
  if (!memberIds.length) {
    return {
      users: [],
      squads: [],
      squadMembers: [],
      wipes: [],
      wipeParticipants: [],
      kdaRows: [],
      memberProfiles: []
    };
  }
  const memberSteamIds = uniqueNormalizedTexts(scopedMembers.map((member) => member.steamId), 80);
  const invitedByUserIds = uniqueNormalizedTexts(scopedMembers
    .map((member) => member.invitedByUserId)
    .filter((id) => !normalizeText(id, 120).startsWith('discord:')), 120);
  const [squadMembers, wipes, usersByBoundSteamId, usersBySteamId, usersById] = await Promise.all([
    getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }),
    getSqliteRecordsByJsonField('wipes', 'status', ['active', 'closed'], { limit: 0 }),
    memberSteamIds.length ? getSqliteRecordsByJsonField('users', 'boundSteamId', memberSteamIds, { limit: 0 }) : Promise.resolve([]),
    memberSteamIds.length ? getSqliteRecordsByJsonField('users', 'steamId', memberSteamIds, { limit: 0 }) : Promise.resolve([]),
    getSqliteRecordsByIds('users', invitedByUserIds)
  ]);
  const squadIds = uniqueNormalizedTexts(squadMembers.map((item) => item.squadId), 120);
  const squads = await getSqliteRecordsByIds('squads', squadIds);
  const store = {
    members: scopedMembers,
    squads,
    squadMembers,
    wipes,
    wipeParticipants: [],
    kdaRows: [],
    memberProfiles: []
  };
  await hydrateMemberScopedRuntimeStore(store, memberIds);
  return {
    users: mergeRecordsById(usersByBoundSteamId, usersBySteamId, usersById),
    squads: store.squads,
    squadMembers: store.squadMembers,
    wipes: store.wipes,
    wipeParticipants: store.wipeParticipants,
    kdaRows: store.kdaRows,
    memberProfiles: store.memberProfiles
  };
}

async function readWechatAdminReviewListStoreForSqlite(options = {}) {
  const reviewStatuses = options.pendingOnly
    ? ['pending']
    : uniqueNormalizedTexts(options.statuses || [], 40);
  const readReviewRecords = async (collection) => {
    if (!reviewStatuses.length) return getSqliteCollection(collection, { limit: 0 });
    const [statusRecords, legacyPendingRecords] = await Promise.all([
      getSqliteRecordsByJsonField(collection, 'status', reviewStatuses, { limit: 0 }),
      reviewStatuses.includes('pending')
        ? getSqliteRecordsWhereJsonFieldMissing(collection, 'status', { limit: 0 })
        : Promise.resolve([])
    ]);
    return mergeRecordsById(statusRecords, legacyPendingRecords);
  };
  const [
    settings,
    joinApplications
  ] = await Promise.all([
    getSqliteScalar('settings'),
    readReviewRecords('joinApplications')
  ]);
  const wechatUserIds = uniqueNormalizedTexts(joinApplications.map((application) => application.wechatUserId), 120);
  const memberIds = uniqueNormalizedTexts(joinApplications.map((application) => application.memberId), 120);
  const steamIds = uniqueNormalizedTexts(joinApplications.map((application) => application.steamId), 80);
  const [wechatUsers, membersById, membersBySteamId] = await Promise.all([
    readSqliteRecordsByIds('wechatUsers', wechatUserIds),
    getSqliteRecordsByIds('members', memberIds),
    steamIds.length ? getSqliteRecordsByJsonField('members', 'steamId', steamIds, { limit: 0 }) : Promise.resolve([])
  ]);
  const members = mergeRecordsById(membersById, membersBySteamId);
  const runtime = await readWechatReviewMemberRuntimeContextForSqlite(members);
  return {
    users: runtime.users,
    members,
    squads: runtime.squads,
    squadMembers: runtime.squadMembers,
    wipes: runtime.wipes,
    wipeParticipants: runtime.wipeParticipants,
    kdaRows: runtime.kdaRows,
    memberProfiles: runtime.memberProfiles,
    wechatUsers,
    joinApplications,
    wechatNotifications: [],
    operationRuns: [],
    settings: settings || {},
    syncState: {}
  };
}

export async function readWechatAdminReviewStore(options = {}) {
  if (!sqliteEnabled()) return readStore();
  try {
    if (sqlitePrimaryMode() && options.joinApplicationId) {
      const settings = await getSqliteScalar('settings');
      const application = await getSqliteRecord('joinApplications', options.joinApplicationId);
      if (!application) {
        return {
          users: [],
          members: [],
          squads: [],
          squadMembers: [],
          wipes: [],
          wipeParticipants: [],
          kdaRows: [],
          memberProfiles: [],
          wechatUsers: [],
          joinApplications: [],
          wechatNotifications: [],
          operationRuns: [],
          settings: settings || {},
          syncState: {}
        };
      }
      const [wechatUser, membersBySteamId, joinApplicationsBySteamId] = await Promise.all([
        application.wechatUserId ? getSqliteRecord('wechatUsers', application.wechatUserId).catch(() => null) : Promise.resolve(null),
        application.steamId ? getSqliteRecordsByJsonField('members', 'steamId', [application.steamId], { limit: 0 }) : Promise.resolve([]),
        application.steamId ? getSqliteRecordsByJsonField('joinApplications', 'steamId', [application.steamId], { limit: 0 }) : Promise.resolve([])
      ]);
      const memberIds = uniqueNormalizedTexts(membersBySteamId.map((member) => member.id), 120);
      const [runtime, boundWechatUsers] = await Promise.all([
        readWechatReviewMemberRuntimeContextForSqlite(membersBySteamId),
        memberIds.length
          ? getSqliteRecordsByJsonField('wechatUsers', 'memberId', memberIds, { limit: 0 })
          : Promise.resolve([])
      ]);
      return {
        users: runtime.users,
        members: mergeRecordsById(membersBySteamId),
        squads: runtime.squads,
        squadMembers: runtime.squadMembers,
        wipes: runtime.wipes,
        wipeParticipants: runtime.wipeParticipants,
        kdaRows: runtime.kdaRows,
        memberProfiles: runtime.memberProfiles,
        wechatUsers: mergeRecordsById(wechatUser ? [wechatUser] : [], boundWechatUsers),
        joinApplications: mergeRecordsById([application], joinApplicationsBySteamId),
        wechatNotifications: [],
        operationRuns: [],
        settings: settings || {},
        syncState: {}
      };
    }
    if (sqlitePrimaryMode()) {
      return await readWechatAdminReviewListStoreForSqlite(options);
    }
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      kdaRows,
      memberProfiles,
      wechatUsers,
      joinApplications,
      settings
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteCollection('wipeParticipants', { limit: 0 }),
      getSqliteCollection('kdaRows', { limit: 0 }),
      getSqliteCollection('memberProfiles', { limit: 0 }),
      getSqliteCollection('wechatUsers', { limit: 0 }),
      getSqliteCollection('joinApplications', { limit: 0 }),
      getSqliteScalar('settings')
    ]);
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      kdaRows,
      memberProfiles,
      wechatUsers,
      joinApplications,
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat admin review fallback:', error?.message || error);
    return wechatPartialStore(error, 'wechat_admin_review');
  }
}

async function readWechatApplicationSummaryCounts(collection) {
  const [statusCounts, legacyPendingCount] = await Promise.all([
    countSqliteRecordsByJsonField(collection, 'status', WECHAT_APPLICATION_SUMMARY_STATUSES),
    countSqliteRecordsWhereJsonFieldMissing(collection, 'status', {
      additionalMissingFields: ['reviewedAt', 'reviewedByUserId', 'reviewNote', 'adminNote']
    })
  ]);
  return {
    ...Object.fromEntries(WECHAT_APPLICATION_SUMMARY_STATUSES.map((status) => [status, Number(statusCounts?.[status] || 0)])),
    pending: Number(statusCounts?.pending || 0) + Number(legacyPendingCount || 0)
  };
}

export async function readWechatAdminSummaryStore() {
  const todayRange = parseLogDateRange();
  if (!sqliteEnabled()) {
    const store = await readStore();
    return {
      ...store,
      logSummary: {
        todayCount: (store.logs || []).filter((log) => {
          const createdMs = timestampForSort(log.createdAt);
          return createdMs >= todayRange.fromMs && createdMs < todayRange.toMs;
        }).length,
        range: { from: todayRange.from, to: todayRange.to }
      }
    };
  }
  try {
    const [
      recordCounts,
      squads,
      activeWipes,
      joinApplicationCounts,
      todayLogCount
    ] = await Promise.all([
      getSqliteRecordCounts(),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      readWechatApplicationSummaryCounts('joinApplications'),
      countSqliteRecordsByJsonTimeRange('logs', 'createdAt', todayRange)
    ]);
    const activeWipe = currentWipe({ wipes: activeWipes });
    const activeWipeId = normalizeText(activeWipe?.id, 120);
    const wipeParticipants = activeWipeId
      ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [activeWipeId], { limit: 0 })
      : [];
    const memberIds = uniqueNormalizedTexts(wipeParticipants.map((participant) => participant.memberId), 120);
    const members = memberIds.length ? await readSqliteRecordsByIds('members', memberIds) : [];
    const squadMembers = memberIds.length
      ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
      : [];
    return {
      users: [],
      members,
      squads,
      squadMembers,
      wipes: activeWipes,
      wipeParticipants,
      joinApplications: [],
      permissionRoles: [],
      settings: {},
      syncState: {},
      summaryApplicationCounts: {
        join: joinApplicationCounts
      },
      summaryCounts: {
        members: Number(recordCounts.members || 0),
        squads: squads.filter((squad) => !squad.archivedAt).length,
        export: Number(recordCounts.wipes || 0)
      },
      logSummary: {
        todayCount: todayLogCount,
        range: { from: todayRange.from, to: todayRange.to }
      }
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat admin summary fallback:', error?.message || error);
    return {
      ...wechatPartialStore(error, 'wechat_admin_summary', {
        summaryApplicationCounts: {
          join: {}
        },
        summaryCounts: {
          members: 0,
          squads: 0,
          export: 0
        }
      }),
      logSummary: {
        todayCount: 0,
        range: { from: todayRange.from, to: todayRange.to }
      }
    };
  }
}

async function readWechatAdminReviewManagerContextForSqlite(applicationWechatUserId = '') {
  const [wechatUsersByRole, managerWebUsers] = await Promise.all([
    getSqliteRecordsByJsonField('wechatUsers', 'role', ['admin', 'member_manager'], { limit: 0 }),
    getSqliteRecordsByJsonField('users', 'role', ['admin', 'member_manager'], { limit: 0 })
  ]);
  const managerSteamIds = uniqueNormalizedTexts(
    managerWebUsers.flatMap((user) => [user.boundSteamId, user.steamId]),
    80
  );
  const managerMembers = managerSteamIds.length
    ? await getSqliteRecordsByJsonField('members', 'steamId', managerSteamIds, { limit: 0 })
    : [];
  const managerMemberIds = uniqueNormalizedTexts(managerMembers.map((member) => member.id), 120);
  const wechatUsersByManagerMember = managerMemberIds.length
    ? await getSqliteRecordsByJsonField('wechatUsers', 'memberId', managerMemberIds, { limit: 0 })
    : [];
  const candidateWechatUsers = mergeRecordsById(wechatUsersByRole, wechatUsersByManagerMember)
    .filter((user) => user.id !== applicationWechatUserId);
  const candidateMemberIds = uniqueNormalizedTexts([
    ...candidateWechatUsers.map((user) => user.memberId),
    ...managerMemberIds
  ], 120);
  const candidateMembersById = await getSqliteRecordsByIds('members', candidateMemberIds);
  const members = mergeRecordsById(managerMembers, candidateMembersById);
  const memberSteamIds = uniqueNormalizedTexts(members.map((member) => member.steamId), 80);
  const [linkedUsersByBoundSteamId, linkedUsersBySteamId] = memberSteamIds.length
    ? await Promise.all([
      getSqliteRecordsByJsonField('users', 'boundSteamId', memberSteamIds, { limit: 0 }),
      getSqliteRecordsByJsonField('users', 'steamId', memberSteamIds, { limit: 0 })
    ])
    : [[], []];
  return {
    users: mergeRecordsById(linkedUsersByBoundSteamId, linkedUsersBySteamId, managerWebUsers),
    members,
    wechatUsers: candidateWechatUsers
  };
}

export async function readWechatApplicationWriteStore(wechatUserId = '', options = {}) {
  if (!sqliteEnabled()) return readStore();
  try {
    if (sqlitePrimaryMode()) {
      const normalizedWechatUserId = normalizeText(wechatUserId, 120);
      const targetSteamIds = uniqueNormalizedTexts(options.steamIds || options.steamId, 80);
      const [
        settings,
        wechatUser,
        ownJoinApplications,
        wechatNotifications
      ] = await Promise.all([
        getSqliteScalar('settings'),
        normalizedWechatUserId ? getSqliteRecord('wechatUsers', normalizedWechatUserId) : Promise.resolve(null),
        normalizedWechatUserId ? getSqliteRecordsByJsonField('joinApplications', 'wechatUserId', [normalizedWechatUserId], { limit: 0 }) : Promise.resolve([]),
        normalizedWechatUserId ? getSqliteRecordsByJsonField('wechatNotifications', 'wechatUserId', [normalizedWechatUserId], { limit: 0 }) : Promise.resolve([])
      ]);
      if (!wechatUser) return wechatRuntimeStoreShell({ settings: settings || {} });

      const applicationSteamIds = uniqueNormalizedTexts([
        ...targetSteamIds,
        ...ownJoinApplications.map((application) => application.steamId)
      ], 80);
      const initialMemberIds = uniqueNormalizedTexts(ownJoinApplications.map((application) => application.memberId), 120);
      const [membersById, membersBySteamId] = await Promise.all([
        getSqliteRecordsByIds('members', initialMemberIds),
        applicationSteamIds.length
          ? getSqliteRecordsByJsonField('members', 'steamId', applicationSteamIds, { limit: 0 })
          : Promise.resolve([])
      ]);
      const members = mergeRecordsById(membersById, membersBySteamId);
      const targetMemberIds = uniqueNormalizedTexts([
        ...initialMemberIds,
        ...members.map((member) => member.id)
      ], 120);
      const [
        joinApplicationsBySteamId,
        boundWechatUsers,
        managerContext
      ] = await Promise.all([
        applicationSteamIds.length
          ? getSqliteRecordsByJsonField('joinApplications', 'steamId', applicationSteamIds, { limit: 0 })
          : Promise.resolve([]),
        targetMemberIds.length
          ? getSqliteRecordsByJsonField('wechatUsers', 'memberId', targetMemberIds, { limit: 0 })
          : Promise.resolve([]),
        options.includeReviewManagers === false
          ? Promise.resolve({ users: [], members: [], wechatUsers: [] })
          : readWechatAdminReviewManagerContextForSqlite(normalizedWechatUserId)
      ]);
      return {
        users: mergeRecordsById(managerContext.users),
        members: mergeRecordsById(members, managerContext.members),
        squads: [],
        squadMembers: [],
        wechatUsers: mergeRecordsById([wechatUser], boundWechatUsers, managerContext.wechatUsers),
        joinApplications: mergeRecordsById(ownJoinApplications, joinApplicationsBySteamId),
        wechatNotifications: Array.isArray(wechatNotifications) ? wechatNotifications : [],
        settings: settings || {},
        syncState: {}
      };
    }
    const [
      users,
      members,
      squads,
      squadMembers,
      wechatUsers,
      joinApplications,
      wechatNotifications,
      settings
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wechatUsers', { limit: 0 }),
      getSqliteCollection('joinApplications', { limit: 0 }),
      getSqliteCollection('wechatNotifications', { limit: 0 }),
      getSqliteScalar('settings')
    ]);
    if (wechatUserId && !wechatUsers.some((item) => item.id === wechatUserId)) return readStore();
    return {
      users,
      members,
      squads,
      squadMembers,
      wechatUsers,
      joinApplications,
      wechatNotifications,
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat application write store fallback:', error?.message || error);
    return wechatPartialStore(error, 'wechat_application_write');
  }
}

export async function readWechatManagementStore(wechatUserId = '') {
  if (!sqliteEnabled()) return readStore();
  try {
    if (sqlitePrimaryMode()) {
      const normalizedWechatUserId = normalizeText(wechatUserId, 120);
      const wechatUser = normalizedWechatUserId ? await getSqliteRecord('wechatUsers', normalizedWechatUserId) : null;
      if (!wechatUser) return wechatRuntimeStoreShell();
      const member = wechatUser.memberId ? await getSqliteRecord('members', wechatUser.memberId).catch(() => null) : null;
      const linkedMemberActive = member ? normalizeMemberStatus(member.memberStatus) === 'active' : false;
      const steamId = linkedMemberActive ? normalizeText(member?.steamId, 80) : '';
      let users = [];
      if (steamId) {
        const [usersByBoundSteamId, usersBySteamId] = await Promise.all([
          getSqliteRecordsByJsonField('users', 'boundSteamId', [steamId], { limit: 0 }),
          getSqliteRecordsByJsonField('users', 'steamId', [steamId], { limit: 0 })
        ]);
        users = mergeRecordsById(usersByBoundSteamId, usersBySteamId);
      }
      if (!users.length && linkedMemberActive && wechatUser.role === 'leader' && member?.invitedByUserId) {
        users = mergeRecordsById(await getSqliteRecord('users', member.invitedByUserId));
      }
      return {
        users,
        members: member ? [member] : [],
        wechatUsers: [wechatUser],
        settings: {},
        syncState: {}
      };
    }
    const [users, members, wechatUsers] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('wechatUsers', { limit: 0 })
    ]);
    if (wechatUserId && !wechatUsers.some((item) => item.id === wechatUserId)) return readStore();
    return {
      users,
      members,
      wechatUsers,
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat management store fallback:', error?.message || error);
    return wechatPartialStore(error, 'wechat_management');
  }
}

export async function readWechatNotificationsForUser(wechatUserId, limit = 20) {
  const normalizedUserId = normalizeText(wechatUserId, 120);
  const normalizedLimit = Math.min(Math.max(Number(limit || 20), 1), 50);
  if (!normalizedUserId) return [];
  if (!sqliteEnabled()) {
    const store = await readStore();
    return (store.wechatNotifications || [])
      .filter((item) => item.wechatUserId === normalizedUserId)
      .sort((left, right) => timestampForSort(right.createdAt) - timestampForSort(left.createdAt))
      .slice(0, normalizedLimit);
  }
  try {
    const notifications = await getSqliteRecordsByJsonField('wechatNotifications', 'wechatUserId', [normalizedUserId], { limit: 0 });
    return notifications
      .sort((left, right) => timestampForSort(right.createdAt) - timestampForSort(left.createdAt))
      .slice(0, normalizedLimit);
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat notifications fallback:', error?.message || error);
    return [];
  }
}

export async function markWechatNotificationReadDirect(req, notificationId) {
  return runStoreWriteTask(async () => {
    const notification = await getSqliteRecord('wechatNotifications', notificationId);
    if (!notification || notification.wechatUserId !== req.wechatUser.id) {
      throw Object.assign(new Error('通知不存在'), { status: 404 });
    }
    const updatedNotification = {
      ...notification,
      readAt: notification.readAt || nowIso()
    };
    await writeSqliteStorePatch({
      reason: 'wechat_notification_read',
      upserts: {
        wechatNotifications: [updatedNotification]
      }
    });
    await patchStoreCache((store) => {
      store.wechatNotifications ||= [];
      replaceCachedRecord(store.wechatNotifications, updatedNotification);
    });
    return updatedNotification;
  });
}
