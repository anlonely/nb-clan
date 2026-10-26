import { normalizeText, readStore } from './store.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsWhereJsonFieldMissing
} from './storage/repository.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import { memberRuntimeStoreShell } from './member-store.js';
import {
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';

function currentWipe(store) {
  return (store.wipes || []).find((wipe) => wipe.status === 'active') || null;
}

function isWechatSystemId(value) {
  return /^wechat_user_[a-z0-9-]+$/i.test(normalizeText(value, 120));
}

export async function readSquadRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  const includeMembers = options.includeMembers !== false;
  const activeOnlyWipes = options.activeOnlyWipes === true;
  try {
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      includeMembers ? getSqliteCollection('members', { limit: 0 }) : Promise.resolve([]),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      activeOnlyWipes
        ? getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 })
        : getSqliteCollection('wipes', { limit: 0 }),
      activeOnlyWipes ? Promise.resolve(null) : getSqliteCollection('wipeParticipants', { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const activeWipe = activeOnlyWipes ? currentWipe({ wipes }) : null;
    const activeWipeId = normalizeText(activeWipe?.id, 120);
    const scopedWipeParticipants = activeOnlyWipes
      ? (activeWipeId ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [activeWipeId], { limit: 0 }) : [])
      : wipeParticipants;
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants: scopedWipeParticipants,
      permissionRoles,
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      wipeSettlements: [],
      uploads: [],
      discordMemberApplications: [],
      wechatUsers: [],
      accountAlertDismissals: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite squad runtime store fallback:', error?.message || error);
    return readStore();
  }
}

export async function readWechatAdminSquadRuntimeStore(fallbackRuntimeStore = readStore) {
  if (!sqlitePrimaryMode()) return fallbackRuntimeStore();
  try {
    const [
      users,
      squads,
      squadMembers,
      activeWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const activeWipe = currentWipe({ wipes: activeWipes });
    const activeWipeId = normalizeText(activeWipe?.id, 120);
    const wipeParticipants = activeWipeId
      ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [activeWipeId], { limit: 0 })
      : [];
    return {
      users,
      members: [],
      squads,
      squadMembers,
      wipes: activeWipes,
      wipeParticipants,
      permissionRoles,
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      wipeSettlements: [],
      uploads: [],
      discordMemberApplications: [],
      wechatUsers: [],
      accountAlertDismissals: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat admin squad runtime fallback:', error?.message || error);
    return fallbackRuntimeStore();
  }
}

export async function readSquadMemberRuntimeStore(squadId, query = {}, options = {}) {
  if (!sqlitePrimaryMode()) return readSquadRuntimeStore();
  const normalizedSquadId = normalizeText(squadId, 120);
  try {
    const [targetSquads, squadMembers, activeWipes, closedWipes, permissionRoles] = await Promise.all([
      normalizedSquadId ? readSqliteRecordsByIds('squads', [normalizedSquadId]) : Promise.resolve([]),
      normalizedSquadId
        ? getSqliteRecordsByJsonField('squadMembers', 'squadId', [normalizedSquadId], { limit: 0 })
        : Promise.resolve([]),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles === false ? Promise.resolve([]) : getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const squads = targetSquads;
    const memberIds = uniqueNormalizedTexts(squadMembers.map((item) => item.memberId), 120);
    const activeWipe = currentWipe({ wipes: activeWipes });
    const activeWipeId = normalizeText(activeWipe?.id, 120);
    const leaderUserIds = uniqueNormalizedTexts(targetSquads.flatMap((squad) => {
      const ids = Array.isArray(squad?.leaderUserIds) ? squad.leaderUserIds : [squad?.leaderUserId];
      return ids;
    }), 120);
    const viewerUserId = normalizeText(options.viewer?.id, 120);
    const scopedUserIds = uniqueNormalizedTexts([...leaderUserIds, viewerUserId], 120);
    const [users, members, activeWipeParticipants] = await Promise.all([
      scopedUserIds.length ? readSqliteRecordsByIds('users', scopedUserIds) : Promise.resolve([]),
      memberIds.length
        ? getSqliteRecordsByJsonField('members', 'id', memberIds, { limit: 0 })
        : Promise.resolve([]),
      activeWipeId
        ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [activeWipeId], { limit: 0 })
        : Promise.resolve([])
    ]);
    const store = memberRuntimeStoreShell({
      users,
      members,
      squads,
      squadMembers,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    store.wipeParticipants = activeWipeParticipants;
    if (options.includeWechatUsers && memberIds.length) {
      const memberWechatUserIds = uniqueNormalizedTexts(
        members.flatMap((member) => [
          member.wechatUserId,
          isWechatSystemId(member.wechatId) ? member.wechatId : ''
        ]),
        120
      );
      const [wechatUsersByMemberId, wechatUsersById] = await Promise.all([
        getSqliteRecordsByJsonField('wechatUsers', 'memberId', memberIds, { limit: 0 }),
        memberWechatUserIds.length ? readSqliteRecordsByIds('wechatUsers', memberWechatUserIds) : Promise.resolve([])
      ]);
      store.wechatUsers = mergeRecordsById(wechatUsersByMemberId, wechatUsersById);
    }
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite squad member runtime fallback:', error?.message || error);
    return readSquadRuntimeStore();
  }
}

export async function readSquadCandidateRuntimeStore(squadId, options = {}) {
  if (!sqlitePrimaryMode()) return readSquadRuntimeStore();
  try {
    const [
      members,
      squads,
      squadMembers,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      options.includePermissionRoles === false ? Promise.resolve([]) : getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const invitedByUserIds = uniqueNormalizedTexts(
      members
        .map((member) => member.invitedByUserId)
        .filter((value) => !normalizeText(value, 120).startsWith('discord:')),
      120
    );
    const users = invitedByUserIds.length ? await readSqliteRecordsByIds('users', invitedByUserIds) : [];
    return memberRuntimeStoreShell({
      users,
      members,
      squads,
      squadMembers,
      permissionRoles
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite squad candidate runtime fallback:', error?.message || error);
    return readSquadRuntimeStore();
  }
}

export async function readSquadMemberAddWriteRuntimeStore(squadId, memberIds = []) {
  const normalizedSquadId = normalizeText(squadId, 120);
  const normalizedMemberIds = uniqueNormalizedTexts(memberIds, 120);
  const [
    squadRecords,
    permissionRoles,
    members,
    squadMembers,
    activeWipes,
    plannedWipes,
    missingStatusWipes
  ] = await Promise.all([
    normalizedSquadId ? readSqliteRecordsByIds('squads', [normalizedSquadId]) : Promise.resolve([]),
    getSqliteCollection('permissionRoles', { limit: 0 }),
    normalizedMemberIds.length ? readSqliteRecordsByIds('members', normalizedMemberIds) : Promise.resolve([]),
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
    getSqliteRecordsByJsonField('wipes', 'status', ['planned'], { limit: 0 }),
    getSqliteRecordsWhereJsonFieldMissing('wipes', 'status', { limit: 0 })
  ]);
  const [
    wipeParticipants,
    kdaRows,
    kdaSnapshots
  ] = await Promise.all([
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('kdaRows', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([])
  ]);
  return {
    store: {
      users: [],
      members,
      squads: squadRecords,
      squadMembers,
      wipes: mergeRecordsById(activeWipes, plannedWipes, missingStatusWipes),
      permissionRoles,
      wipeParticipants,
      kdaRows,
      kdaSnapshots,
      memberProfiles: [],
      settings: {},
      syncState: {}
    },
    squad: squadRecords.find((item) => item.id === normalizedSquadId && !item.archivedAt) || null,
    memberIds: normalizedMemberIds
  };
}

export async function readSquadMemberRemoveWriteRuntimeStore(squadId, memberId) {
  const normalizedSquadId = normalizeText(squadId, 120);
  const normalizedMemberIds = uniqueNormalizedTexts([memberId], 120);
  const [
    squadRecords,
    permissionRoles,
    members,
    squadMembers,
    activeWipes,
    plannedWipes,
    missingStatusWipes
  ] = await Promise.all([
    normalizedSquadId ? readSqliteRecordsByIds('squads', [normalizedSquadId]) : Promise.resolve([]),
    getSqliteCollection('permissionRoles', { limit: 0 }),
    normalizedMemberIds.length ? readSqliteRecordsByIds('members', normalizedMemberIds) : Promise.resolve([]),
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
    getSqliteRecordsByJsonField('wipes', 'status', ['planned'], { limit: 0 }),
    getSqliteRecordsWhereJsonFieldMissing('wipes', 'status', { limit: 0 })
  ]);
  const steamIds = uniqueNormalizedTexts(members.map((member) => member.steamId), 80);
  const [
    wipeParticipantsByMemberId,
    wipeParticipantsBySteamId,
    kdaRowsByMemberId,
    kdaRowsBySteamId,
    kdaSnapshotsByMemberId,
    kdaSnapshotsBySteamId
  ] = await Promise.all([
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    steamIds.length ? getSqliteRecordsByJsonField('wipeParticipants', 'steamId', steamIds, { limit: 0 }) : Promise.resolve([]),
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('kdaRows', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    steamIds.length ? getSqliteRecordsByJsonField('kdaRows', 'steamId', steamIds, { limit: 0 }) : Promise.resolve([]),
    normalizedMemberIds.length ? getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', normalizedMemberIds, { limit: 0 }) : Promise.resolve([]),
    steamIds.length ? getSqliteRecordsByJsonField('kdaSnapshots', 'steamId', steamIds, { limit: 0 }) : Promise.resolve([])
  ]);
  return {
    store: {
      users: [],
      members,
      squads: squadRecords,
      squadMembers,
      wipes: mergeRecordsById(activeWipes, plannedWipes, missingStatusWipes),
      permissionRoles,
      wipeParticipants: mergeRecordsById(wipeParticipantsByMemberId, wipeParticipantsBySteamId),
      kdaRows: mergeRecordsById(kdaRowsByMemberId, kdaRowsBySteamId),
      kdaSnapshots: mergeRecordsById(kdaSnapshotsByMemberId, kdaSnapshotsBySteamId),
      memberProfiles: [],
      settings: {},
      syncState: {}
    },
    squad: squadRecords.find((item) => item.id === normalizedSquadId && !item.archivedAt) || null,
    memberIds: normalizedMemberIds
  };
}

export async function readSquadLeaderWriteContext(users = [], leaderUserIds = []) {
  const leaders = leaderUserIds.map((userId) => (users || []).find((user) => user.id === userId));
  if (leaders.some((leader) => !leader)) throw Object.assign(new Error('请选择有效队长'), { status: 400 });
  const leaderSteamIds = uniqueNormalizedTexts(leaders.map((leader) => leader?.boundSteamId), 80);
  const members = leaderSteamIds.length
    ? await getSqliteRecordsByJsonField('members', 'steamId', leaderSteamIds, { limit: 0 })
    : [];
  const memberIds = uniqueNormalizedTexts(members.map((member) => member.id), 120);
  const squadMembers = memberIds.length
    ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
    : [];
  return { leaders, members, squadMembers };
}
