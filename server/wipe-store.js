import { normalizeText, readStore } from './store.js';
import {
  findSqliteRecordByJsonField,
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsWhereJsonFieldPresent,
  getSqliteScalar
} from './storage/repository.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import {
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';
import { canViewWipes, isAdmin } from './permissions.js';
import { currentWipe, isWipeStartedServer, kdaSyncUsesAllMembers } from './wipe-utils.js';

const DISCORD_ID_MAX_LENGTH = 32;

function wipeStoreReadUnavailableError(label, cause) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'wipe_store_read_unavailable',
    skipApiErrorLog: true,
    cause
  });
}

function requiresGeneratedAllMemberKdaSource(wipe) {
  return process.env.NB_DISABLE_EXTERNAL_VITAL === '1' &&
    isWipeStartedServer(wipe) &&
    kdaSyncUsesAllMembers({ wipes: wipe ? [wipe] : [] }, wipe);
}

async function readGeneratedKdaSourceMembers(wipe, targetMembers = []) {
  const targets = mergeRecordsById(targetMembers);
  if (!requiresGeneratedAllMemberKdaSource(wipe)) return targets;
  const membersWithSteamId = await getSqliteRecordsWhereJsonFieldPresent('members', 'steamId', { limit: 0 });
  return mergeRecordsById(membersWithSteamId, targets);
}

export async function readWipeRuntimeStore({
  includeUploads = false,
  includeWechatUsers = false,
  includeWipeSettlements = false,
  includePermissionRoles = false,
  includeSettings = false
} = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      uploads,
      wechatUsers,
      wipeSettlements,
      permissionRoles,
      settings
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteCollection('wipeParticipants', { limit: 0 }),
      includeUploads ? getSqliteCollection('uploads', { limit: 0 }) : Promise.resolve([]),
      includeWechatUsers ? getSqliteCollection('wechatUsers', { limit: 0 }) : Promise.resolve([]),
      includeWipeSettlements ? getSqliteCollection('wipeSettlements', { limit: 0 }) : Promise.resolve([]),
      includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([]),
      includeSettings ? getSqliteScalar('settings') : Promise.resolve({})
    ]);
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      uploads,
      wechatUsers,
      wipeSettlements,
      permissionRoles,
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wipe runtime fallback:', error?.message || error);
    throw wipeStoreReadUnavailableError('档期数据读取', error);
  }
}

export async function readCurrentWipeRuntimeStore({
  includeUploads = false,
  includeWipeSettlements = false,
  includePermissionRoles = false
} = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [wipes, permissionRoles] = await Promise.all([
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const active = currentWipe({ wipes });
    const activeWipeId = normalizeText(active?.id, 120);
    const [
      wipeParticipants,
      uploads,
      wipeSettlements
    ] = await Promise.all([
      activeWipeId ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [activeWipeId], { limit: 0 }) : Promise.resolve([]),
      includeUploads && activeWipeId ? getSqliteRecordsByJsonField('uploads', 'ownerId', [activeWipeId], { limit: 0 }) : Promise.resolve([]),
      includeWipeSettlements && activeWipeId ? getSqliteRecordsByJsonField('wipeSettlements', 'wipeId', [activeWipeId], { limit: 0 }) : Promise.resolve([])
    ]);
    const memberIds = uniqueNormalizedTexts(wipeParticipants.map((participant) => participant.memberId), 120);
    const members = memberIds.length
      ? await getSqliteRecordsByJsonField('members', 'id', memberIds, { limit: 0 })
      : [];
    const squadMembers = memberIds.length
      ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
      : [];
    const squadIds = uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.squadId),
      ...squadMembers.map((relation) => relation.squadId)
    ], 120);
    const squads = squadIds.length ? await getSqliteRecordsByJsonField('squads', 'id', squadIds, { limit: 0 }) : [];
    const invitedByUserIds = uniqueNormalizedTexts(
      members
        .map((member) => member.invitedByUserId)
        .filter((value) => !normalizeText(value, 120).startsWith('discord:')),
      120
    );
    const users = invitedByUserIds.length ? await readSqliteRecordsByIds('users', invitedByUserIds) : [];
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      uploads,
      wechatUsers: [],
      wipeSettlements,
      permissionRoles,
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite current wipe runtime fallback:', error?.message || error);
    throw wipeStoreReadUnavailableError('当前档期数据读取', error);
  }
}

export async function readWipeListStore(options = {}) {
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includeWipeSettlements: true, includePermissionRoles: true });
  const includePermissionRoles = options.includePermissionRoles !== false;
  try {
    const [squads, wipes, wipeParticipants, wipeSettlements, permissionRoles] = await Promise.all([
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteCollection('wipeParticipants', { limit: 0 }),
      getSqliteCollection('wipeSettlements', { limit: 0 }),
      includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    return {
      users: [],
      members: [],
      squads,
      squadMembers: [],
      wipes,
      wipeParticipants,
      uploads: [],
      wechatUsers: [],
      wipeSettlements,
      permissionRoles,
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wipe list fallback:', error?.message || error);
    return readWipeRuntimeStore({ includeWipeSettlements: true, includePermissionRoles: true });
  }
}

export async function readWechatAdminWipeListStore() {
  if (!sqlitePrimaryMode()) {
    return readWipeRuntimeStore({
      includeUploads: true,
      includeWechatUsers: true,
      includePermissionRoles: true,
      includeSettings: true
    });
  }
  try {
    const [wipes, settings] = await Promise.all([
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteScalar('settings')
    ]);
    const wipeIds = uniqueNormalizedTexts((wipes || []).map((wipe) => wipe.id), 120);
    const [wipeParticipants, uploads] = await Promise.all([
      wipeIds.length ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', wipeIds, { limit: 0 }) : Promise.resolve([]),
      wipeIds.length ? getSqliteRecordsByJsonField('uploads', 'ownerId', wipeIds, { limit: 0 }) : Promise.resolve([])
    ]);
    const memberIds = uniqueNormalizedTexts((wipeParticipants || []).map((participant) => participant.memberId), 120);
    const [members, squadMembers] = await Promise.all([
      memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
      memberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([])
    ]);
    const squadIds = uniqueNormalizedTexts([
      ...(wipeParticipants || []).map((participant) => participant.squadId),
      ...(squadMembers || []).map((relation) => relation.squadId)
    ], 120);
    const squads = squadIds.length ? await readSqliteRecordsByIds('squads', squadIds) : [];
    return {
      users: [],
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      uploads,
      wechatUsers: [],
      wipeSettlements: [],
      permissionRoles: [],
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat admin wipe list fallback:', error?.message || error);
    return readWipeRuntimeStore({
      includeUploads: true,
      includeWechatUsers: true,
      includePermissionRoles: true,
      includeSettings: true
    });
  }
}

function emptyWipeRuntimeStore({ squads = [], permissionRoles = [] } = {}) {
  return {
    users: [],
    members: [],
    squads,
    squadMembers: [],
    wipes: [],
    wipeParticipants: [],
    uploads: [],
    wechatUsers: [],
    wipeSettlements: [],
    permissionRoles,
    memberProfiles: [],
    kdaRows: [],
    kdaSnapshots: [],
    settings: {},
    syncState: {}
  };
}

export async function readWipeAccessCheckStore(user = null) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    if (canViewWipes(user, [])) {
      return emptyWipeRuntimeStore();
    }
    const [squads, permissionRoles] = await Promise.all([
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return emptyWipeRuntimeStore({ squads, permissionRoles });
  } catch (error) {
    console.warn('[nb-clan] sqlite wipe access check fallback:', error?.message || error);
    throw wipeStoreReadUnavailableError('档期权限读取', error);
  }
}

export async function readWipeForVitalMetadataRefresh(normalizedWipeId = '') {
  const wipeId = normalizeText(normalizedWipeId, 120);
  const selectWipe = (wipes = []) => {
    if (wipeId && wipeId !== 'current') {
      return wipes.find((item) => item.id === wipeId) || null;
    }
    return currentWipe({ wipes });
  };

  if (sqlitePrimaryMode()) {
    try {
      if (wipeId && wipeId !== 'current') return await getSqliteRecord('wipes', wipeId);
      return selectWipe(await getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }));
    } catch (error) {
      console.warn('[nb-clan] sqlite wipe metadata lookup failed:', error?.message || error);
      return null;
    }
  }

  const snapshot = await readStore();
  return selectWipe(snapshot.wipes || []);
}

export async function readRustMapsImageSyncContext(wipeId) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!sqlitePrimaryMode()) {
    const snapshot = await readWipeRuntimeStore({ includeUploads: true });
    return {
      wipe: (snapshot.wipes || []).find((item) => item.id === normalizedWipeId) || null,
      uploads: snapshot.uploads || []
    };
  }
  try {
    const [wipe, uploads] = await Promise.all([
      normalizedWipeId ? getSqliteRecord('wipes', normalizedWipeId) : Promise.resolve(null),
      normalizedWipeId ? getSqliteRecordsByJsonField('uploads', 'ownerId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([])
    ]);
    return { wipe, uploads };
  } catch (error) {
    console.warn('[nb-clan] sqlite rustmaps image context fallback:', error?.message || error);
    const snapshot = await readWipeRuntimeStore({ includeUploads: true });
    return {
      wipe: (snapshot.wipes || []).find((item) => item.id === normalizedWipeId) || null,
      uploads: snapshot.uploads || []
    };
  }
}

export async function readWipeParticipantResponseStore(wipeId, {
  includeUploads = false,
  includeWipeSettlements = false
} = {}) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includeUploads, includePermissionRoles: true, includeWipeSettlements });
  try {
    const [wipe, permissionRoles] = await Promise.all([
      normalizedWipeId ? getSqliteRecord('wipes', normalizedWipeId) : Promise.resolve(null),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    if (!wipe) {
      return {
        users: [],
        members: [],
        squads: [],
        squadMembers: [],
        wipes: [],
        wipeParticipants: [],
        uploads: [],
        wechatUsers: [],
        wipeSettlements: [],
        permissionRoles,
        memberProfiles: [],
        kdaRows: [],
        kdaSnapshots: [],
        settings: {},
        syncState: {}
      };
    }

    const [wipeParticipants, uploads, wipeSettlements] = await Promise.all([
      getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [normalizedWipeId], { limit: 0 }),
      includeUploads ? getSqliteRecordsByJsonField('uploads', 'ownerId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
      includeWipeSettlements ? getSqliteRecordsByJsonField('wipeSettlements', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([])
    ]);
    const memberIds = uniqueNormalizedTexts(wipeParticipants.map((participant) => participant.memberId), 120);
    const members = memberIds.length ? await readSqliteRecordsByIds('members', memberIds) : [];
    const squadMembers = memberIds.length
      ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
      : [];
    const inviterUserIds = uniqueNormalizedTexts(
      members
        .map((member) => normalizeText(member.invitedByUserId, 120))
        .filter((id) => id && !id.startsWith('discord:')),
      120
    );
    const squadIds = uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.squadId),
      ...squadMembers.map((item) => item.squadId)
    ], 120);
    const [squads, users] = await Promise.all([
      squadIds.length ? readSqliteRecordsByIds('squads', squadIds) : Promise.resolve([]),
      inviterUserIds.length ? readSqliteRecordsByIds('users', inviterUserIds) : Promise.resolve([])
    ]);
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes: [wipe],
      wipeParticipants,
      uploads,
      wechatUsers: [],
      wipeSettlements,
      permissionRoles,
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wipe participant response fallback:', error?.message || error);
    throw wipeStoreReadUnavailableError('档期报名读取', error);
  }
}

export async function readWipeParticipantCandidatesStore(wipeId) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includePermissionRoles: true });
  try {
    const currentRequested = !normalizedWipeId || normalizedWipeId === 'current';
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      currentRequested
        ? getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 })
        : getSqliteRecord('wipes', normalizedWipeId).then((wipe) => (wipe ? [wipe] : [])),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const targetWipe = currentRequested ? currentWipe({ wipes }) : (wipes[0] || null);
    const targetWipeId = normalizeText(targetWipe?.id, 120);
    const wipeParticipants = targetWipeId
      ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [targetWipeId], { limit: 0 })
      : [];
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      uploads: [],
      wechatUsers: [],
      wipeSettlements: [],
      permissionRoles,
      memberProfiles: [],
      kdaRows: [],
      kdaSnapshots: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wipe participant candidates fallback:', error?.message || error);
    throw wipeStoreReadUnavailableError('档期候选成员读取', error);
  }
}

export async function readDiscordWipeSignupWriteStore(wipeId, discordUserId = '') {
  const normalizedWipeId = normalizeText(wipeId, 120);
  const normalizedDiscordUserId = normalizeText(discordUserId, DISCORD_ID_MAX_LENGTH);
  const [wipe, member] = await Promise.all([
    normalizedWipeId ? getSqliteRecord('wipes', normalizedWipeId) : Promise.resolve(null),
    normalizedDiscordUserId ? findSqliteRecordByJsonField('members', 'discordId', normalizedDiscordUserId) : Promise.resolve(null)
  ]);
  const requiresGeneratedKdaScope = requiresGeneratedAllMemberKdaSource(wipe);
  const memberId = normalizeText(member?.id, 120);
  const [
    members,
    squadMembers,
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    discordAttendanceResponses
  ] = await Promise.all([
    readGeneratedKdaSourceMembers(wipe, member ? [member] : []),
    memberId ? getSqliteRecordsByJsonField('squadMembers', 'memberId', [memberId], { limit: 0 }) : Promise.resolve([]),
    normalizedWipeId && requiresGeneratedKdaScope
      ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [normalizedWipeId], { limit: 0 })
      : (memberId ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', [memberId], { limit: 0 }) : Promise.resolve([])),
    normalizedWipeId ? getSqliteRecordsByJsonField('kdaRows', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    normalizedWipeId ? getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    normalizedWipeId ? getSqliteRecordsByJsonField('discordAttendanceResponses', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([])
  ]);
  const squadIds = [...new Set(squadMembers.map((item) => normalizeText(item.squadId, 120)).filter(Boolean))];
  const squads = squadIds.length ? await readSqliteRecordsByIds('squads', squadIds) : [];
  return {
    users: [],
    members,
    squads,
    squadMembers,
    wipes: wipe ? [wipe] : [],
    permissionRoles: [],
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    discordAttendanceResponses,
    memberProfiles: [],
    settings: {},
    syncState: {},
    logs: []
  };
}

export async function readDiscordSignupInteractionStore(discordUserId) {
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includeSettings: true });
  try {
    const normalizedDiscordId = normalizeText(discordUserId, DISCORD_ID_MAX_LENGTH);
    const [settings, members] = await Promise.all([
      getSqliteScalar('settings'),
      normalizedDiscordId
        ? getSqliteRecordsByJsonField('members', 'discordId', [normalizedDiscordId], { limit: 0 })
        : Promise.resolve([])
    ]);
    const member = members.find((item) => normalizeText(item.discordId, DISCORD_ID_MAX_LENGTH) === normalizedDiscordId) || null;
    return {
      settings: settings || {},
      members: member ? [member] : []
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite discord signup interaction lookup fallback:', error?.message || error);
    return readWipeRuntimeStore({ includeSettings: true });
  }
}

export async function readDiscordSignupWipe(wipeId) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!sqlitePrimaryMode()) {
    const store = await readWipeRuntimeStore({ includeSettings: true });
    return (store.wipes || []).find((item) => item.id === normalizedWipeId) || null;
  }
  try {
    return normalizedWipeId ? await getSqliteRecord('wipes', normalizedWipeId) : null;
  } catch (error) {
    console.warn('[nb-clan] sqlite discord signup wipe lookup fallback:', error?.message || error);
    const store = await readWipeRuntimeStore({ includeSettings: true });
    return (store.wipes || []).find((item) => item.id === normalizedWipeId) || null;
  }
}

export async function readDiscordAttendanceMessageStore(wipeId) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includeSettings: true });
  try {
    const [settings, wipe, wipeParticipants] = await Promise.all([
      getSqliteScalar('settings'),
      normalizedWipeId ? getSqliteRecord('wipes', normalizedWipeId) : Promise.resolve(null),
      normalizedWipeId ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([])
    ]);
    const memberIds = [...new Set(wipeParticipants.map((participant) => normalizeText(participant.memberId, 120)).filter(Boolean))];
    const [members, squadMembers] = await Promise.all([
      memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
      memberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([])
    ]);
    const squadIds = uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.squadId),
      ...squadMembers.map((item) => item.squadId)
    ], 120);
    const squads = squadIds.length ? await readSqliteRecordsByIds('squads', squadIds) : [];
    return {
      users: [],
      members,
      squads,
      squadMembers,
      wipes: wipe ? [wipe] : [],
      permissionRoles: [],
      wipeParticipants,
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite discord attendance message lookup fallback:', error?.message || error);
    return readWipeRuntimeStore({ includeSettings: true });
  }
}

export async function readDiscordAttendanceRefreshStore(wipeId = '') {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!sqlitePrimaryMode()) return readWipeRuntimeStore({ includeUploads: true, includeSettings: true });
  try {
    const [settings, activeWipes, requestedWipe] = await Promise.all([
      getSqliteScalar('settings'),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      normalizedWipeId ? getSqliteRecord('wipes', normalizedWipeId) : Promise.resolve(null)
    ]);
    const activeWipe = activeWipes.find((item) => normalizeText(item.status, 40) === 'active') || null;
    const wipe = normalizedWipeId ? requestedWipe : activeWipe;
    const scopedWipeId = normalizeText(wipe?.id, 120);
    const wipeParticipants = scopedWipeId
      ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [scopedWipeId], { limit: 0 })
      : [];
    const memberIds = [...new Set(wipeParticipants.map((participant) => normalizeText(participant.memberId, 120)).filter(Boolean))];
    const [members, squadMembers] = await Promise.all([
      memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
      memberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([])
    ]);
    const squadIds = uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.squadId),
      ...squadMembers.map((item) => item.squadId)
    ], 120);
    const squads = squadIds.length ? await readSqliteRecordsByIds('squads', squadIds) : [];
    return {
      users: [],
      members,
      squads,
      squadMembers,
      wipes: mergeRecordsById(activeWipes, wipe ? [wipe] : []),
      permissionRoles: [],
      wipeParticipants,
      uploads: [],
      wechatUsers: [],
      wipeSettlements: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite discord attendance refresh lookup fallback:', error?.message || error);
    return readWipeRuntimeStore({ includeUploads: true, includeSettings: true });
  }
}

async function readWebWipeParticipantScopedMutationStore(wipeId, action, input = {}, req = null) {
  const normalizedAction = normalizeText(action, 40);
  if (!['self_signup', 'add', 'edit', 'remove'].includes(normalizedAction)) return null;
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!normalizedWipeId) return null;
  const requestedMemberIds = normalizedAction === 'add'
    ? uniqueNormalizedTexts(Array.isArray(input.memberIds) ? input.memberIds : [], 120)
    : uniqueNormalizedTexts([input.memberId], 120);
  const boundSteamId = normalizedAction === 'self_signup' ? normalizeText(req?.user?.boundSteamId, 80) : '';
  const [wipe, targetMembers] = await Promise.all([
    getSqliteRecord('wipes', normalizedWipeId),
    boundSteamId
      ? getSqliteRecordsByJsonField('members', 'steamId', [boundSteamId], { limit: 0 })
      : []
  ]);
  const requiresGeneratedKdaScope = normalizedAction === 'self_signup' && requiresGeneratedAllMemberKdaSource(wipe);
  const targetMemberIds = uniqueNormalizedTexts([
    ...requestedMemberIds,
    ...targetMembers.map((member) => member.id)
  ], 120);
  const wipeParticipantsPromise = requiresGeneratedKdaScope
    ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [normalizedWipeId], { limit: 0 })
    : (targetMemberIds.length
        ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]));
  const membersPromise = requiresGeneratedKdaScope
    ? readGeneratedKdaSourceMembers(wipe, targetMembers)
    : (normalizedAction === 'self_signup'
        ? Promise.resolve(targetMembers)
        : (targetMemberIds.length ? readSqliteRecordsByIds('members', targetMemberIds) : Promise.resolve([])));
  const [
    members,
    wipeParticipantsRaw,
    squadMembers,
    kdaRows,
    kdaSnapshots
  ] = await Promise.all([
    membersPromise,
    wipeParticipantsPromise,
    targetMemberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', targetMemberIds, { limit: 0 }) : Promise.resolve([]),
    getSqliteRecordsByJsonField('kdaRows', 'wipeId', [normalizedWipeId], { limit: 0 }),
    getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [normalizedWipeId], { limit: 0 })
  ]);
  const wipeParticipants = wipeParticipantsRaw.filter((item) => item.wipeId === normalizedWipeId);
  const requestedSquadId = Object.hasOwn(input || {}, 'squadId') || Object.hasOwn(req?.body || {}, 'squadId')
    ? normalizeText(input.squadId ?? req?.body?.squadId, 120)
    : '';
  const squadIds = uniqueNormalizedTexts([
    requestedSquadId,
    ...wipeParticipants.map((participant) => participant.squadId),
    ...squadMembers.map((item) => item.squadId)
  ], 120);
  const squads = !isAdmin(req?.user)
    ? await getSqliteCollection('squads', { limit: 0 })
    : (squadIds.length ? await readSqliteRecordsByIds('squads', squadIds) : []);
  return {
    users: [],
    members,
    squads,
    squadMembers,
    wipes: wipe ? [wipe] : [],
    permissionRoles: [],
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    memberProfiles: [],
    settings: {},
    syncState: {},
    logs: []
  };
}

async function readWebWipeParticipantFullWriteStore(wipeId) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  const [
    users,
    members,
    squads,
    squadMembers,
    wipes,
    permissionRoles,
    wipeParticipants,
    kdaRows,
    kdaSnapshots
  ] = await Promise.all([
    getSqliteCollection('users', { limit: 0 }),
    getSqliteCollection('members', { limit: 0 }),
    getSqliteCollection('squads', { limit: 0 }),
    getSqliteCollection('squadMembers', { limit: 0 }),
    getSqliteCollection('wipes', { limit: 0 }),
    getSqliteCollection('permissionRoles', { limit: 1000 }),
    getSqliteCollection('wipeParticipants', { limit: 0 }),
    normalizedWipeId ? getSqliteRecordsByJsonField('kdaRows', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    normalizedWipeId ? getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([])
  ]);
  return {
    users,
    members,
    squads,
    squadMembers,
    wipes,
    permissionRoles,
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    memberProfiles: [],
    settings: {},
    syncState: {},
    logs: []
  };
}

export async function readWebWipeParticipantWriteStore(wipeId, action = '', input = {}, req = null) {
  const scoped = await readWebWipeParticipantScopedMutationStore(wipeId, action, input, req);
  return scoped || readWebWipeParticipantFullWriteStore(wipeId);
}

async function readWechatAdminWipeParticipantScopedMutationStore(requestedWipeId, action, input = {}, req = null) {
  const normalizedAction = normalizeText(action, 40);
  if (!['add', 'edit', 'remove'].includes(normalizedAction)) return null;
  const normalizedWipeId = normalizeText(requestedWipeId, 120);
  const requestedMemberIds = normalizedAction === 'add'
    ? uniqueNormalizedTexts(Array.isArray(input.memberIds) ? input.memberIds : [], 120)
    : uniqueNormalizedTexts([input.memberId], 120);
  if (!normalizedWipeId || !requestedMemberIds.length) return null;
  const requestedWipe = normalizedWipeId === 'current'
    ? (await getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }))
        .find((item) => normalizeText(item.status, 40) === 'active') || null
    : await getSqliteRecord('wipes', normalizedWipeId);
  const actualWipeId = normalizeText(requestedWipe?.id, 120);
  if (!actualWipeId) {
    return {
      users: [],
      members: [],
      squads: [],
      squadMembers: [],
      wipes: [],
      permissionRoles: [],
      wipeParticipants: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      settings: {},
      syncState: {},
      logs: []
    };
  }
  const requiresGeneratedKdaScope = requiresGeneratedAllMemberKdaSource(requestedWipe);
  const wipeParticipantsPromise = requiresGeneratedKdaScope || normalizedAction !== 'add'
    ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [actualWipeId], { limit: 0 })
    : getSqliteRecordsByJsonField('wipeParticipants', 'memberId', requestedMemberIds, { limit: 0 });
  const [wipeParticipantsRaw, kdaRows, kdaSnapshots] = await Promise.all([
    wipeParticipantsPromise,
    getSqliteRecordsByJsonField('kdaRows', 'wipeId', [actualWipeId], { limit: 0 }),
    getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [actualWipeId], { limit: 0 })
  ]);
  const wipeParticipants = wipeParticipantsRaw.filter((item) => item.wipeId === actualWipeId);
  const memberIds = uniqueNormalizedTexts([
    ...requestedMemberIds,
    ...wipeParticipants.map((participant) => participant.memberId)
  ], 120);
  const targetMembersPromise = requestedMemberIds.length
    ? readSqliteRecordsByIds('members', requestedMemberIds)
    : Promise.resolve([]);
  const generatedMembersPromise = requiresGeneratedKdaScope
    ? targetMembersPromise.then((targetMembers) => readGeneratedKdaSourceMembers(requestedWipe, targetMembers))
    : null;
  const [members, squadMembers] = await Promise.all([
    generatedMembersPromise || (memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([])),
    memberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([])
  ]);
  const squadIds = uniqueNormalizedTexts([
    ...wipeParticipants.map((participant) => participant.squadId),
    ...squadMembers.map((item) => item.squadId)
  ], 120);
  const hasAdminActor = isAdmin(req?.user) || isAdmin(req?.wechatManagementUser);
  const squads = hasAdminActor
    ? (squadIds.length ? await readSqliteRecordsByIds('squads', squadIds) : [])
    : await getSqliteCollection('squads', { limit: 0 });
  return {
    users: [],
    members,
    squads,
    squadMembers,
    wipes: [requestedWipe],
    permissionRoles: [],
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    memberProfiles: [],
    settings: {},
    syncState: {},
    logs: []
  };
}

async function readWechatAdminWipeParticipantFullWriteStore(requestedWipeId) {
  const normalizedWipeId = normalizeText(requestedWipeId, 120);
  const [
    users,
    members,
    squads,
    squadMembers,
    wipes,
    permissionRoles,
    wipeParticipants
  ] = await Promise.all([
    getSqliteCollection('users', { limit: 0 }),
    getSqliteCollection('members', { limit: 0 }),
    getSqliteCollection('squads', { limit: 0 }),
    getSqliteCollection('squadMembers', { limit: 0 }),
    getSqliteCollection('wipes', { limit: 0 }),
    getSqliteCollection('permissionRoles', { limit: 1000 }),
    getSqliteCollection('wipeParticipants', { limit: 0 })
  ]);
  const baseStore = {
    users,
    members,
    squads,
    squadMembers,
    wipes,
    permissionRoles,
    wipeParticipants,
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    settings: {},
    syncState: {},
    logs: []
  };
  const wipe = normalizedWipeId === 'current'
    ? currentWipe(baseStore)
    : wipes.find((item) => item.id === normalizedWipeId);
  const actualWipeId = normalizeText(wipe?.id, 120);
  const [kdaRows, kdaSnapshots] = actualWipeId
    ? await Promise.all([
        getSqliteRecordsByJsonField('kdaRows', 'wipeId', [actualWipeId], { limit: 0 }),
        getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [actualWipeId], { limit: 0 })
      ])
    : [[], []];
  return {
    ...baseStore,
    kdaRows,
    kdaSnapshots
  };
}

export async function readWechatAdminWipeParticipantWriteStore(requestedWipeId, action = '', input = {}, req = null) {
  const scoped = await readWechatAdminWipeParticipantScopedMutationStore(requestedWipeId, action, input, req);
  return scoped || readWechatAdminWipeParticipantFullWriteStore(requestedWipeId);
}
