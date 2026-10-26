import { normalizeText, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import {
  getSqliteCollection,
  getSqliteRecordsByJsonField,
  getSqliteScalar,
  writeSqliteStorePatch
} from './storage/repository.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import { applyStoreCollectionCachePatch } from './storage/store-patch-diff.js';
import {
  LOG_HISTORY_LIMIT,
  appendLog,
  applyCachedLogPatch,
  createLogEntry,
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';

const PROXY_SCOPES = new Set(['global', 'battlemetrics', 'kda']);
const SERVICE_PROXY_SETTINGS_CACHE_MS = 3_000;
let serviceProxySettingsCache = {
  expiresAt: 0,
  settings: null
};

export function invalidateServiceProxySettingsCache() {
  serviceProxySettingsCache = { expiresAt: 0, settings: null };
}

function settingsPartialStore(error, source = '', extra = {}) {
  return {
    settings: {},
    settingsPartial: true,
    settingsReadSource: normalizeText(source, 120),
    settingsReadError: normalizeText(error?.message || error, 500),
    ...extra
  };
}

function settingsStoreWriteUnavailableError(label, cause) {
  const causeMessage = normalizeText(cause?.message || cause, 240);
  return Object.assign(new Error(`${label}暂不可用，请稍后重试${causeMessage ? `：${causeMessage}` : ''}`), {
    status: 503,
    code: 'settings_store_write_unavailable',
    skipApiErrorLog: true,
    cause
  });
}

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export function normalizeProxyScope(value) {
  const scope = normalizeText(value, 40) || 'global';
  return PROXY_SCOPES.has(scope) ? scope : '';
}

export function systemSettings(store) {
  store.settings ||= {};
  store.settings.system ||= {};
  store.settings.system.proxy ||= {};
  store.settings.system.proxy.url ||= '';
  store.settings.system.proxy.scope ||= 'global';
  store.settings.system.proxy.updatedAt ||= '';
  store.settings.system.teamLogoUrl ||= '';
  store.settings.system.teamLogoUpdatedAt ||= '';
  const normalizedScope = normalizeProxyScope(store.settings.system.proxy.scope);
  store.settings.system.proxy.scope = normalizedScope || 'global';
  return store.settings.system;
}

export async function readSettingsRuntimeStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      settings: await getSqliteScalar('settings') || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite settings store fallback:', error?.message || error);
    return settingsPartialStore(error, 'settings_runtime');
  }
}

export async function readServiceProxyStore() {
  if (!sqliteEnabled()) return readStore();
  const now = Date.now();
  try {
    if (!serviceProxySettingsCache.settings || now >= serviceProxySettingsCache.expiresAt) {
      serviceProxySettingsCache = {
        expiresAt: now + SERVICE_PROXY_SETTINGS_CACHE_MS,
        settings: await getSqliteScalar('settings') || {}
      };
    }
    return { settings: serviceProxySettingsCache.settings };
  } catch (error) {
    console.warn('[nb-clan] sqlite proxy settings partial fallback:', error?.message || error);
    return {
      settings: serviceProxySettingsCache.settings || {},
      serviceProxySettingsPartial: true,
      serviceProxySettingsReadError: normalizeText(error?.message || error, 500)
    };
  }
}

export async function readSettingsPermissionRuntimeStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [settings, permissionRoles, rustplusRelay] = await Promise.all([
      getSqliteScalar('settings'),
      getSqliteCollection('permissionRoles', { limit: 0 }),
      getSqliteScalar('rustplusRelay')
    ]);
    return {
      settings: settings || {},
      rustplusRelay: rustplusRelay || {},
      permissionRoles,
      users: [],
      members: [],
      squads: [],
      squadMembers: [],
      wipes: [],
      wipeParticipants: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      accountAlertDismissals: [],
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite settings permission store fallback:', error?.message || error);
    return settingsPartialStore(error, 'settings_permission', {
      rustplusRelay: {},
      permissionRoles: [],
      users: [],
      members: [],
      squads: [],
      squadMembers: [],
      wipes: [],
      wipeParticipants: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      accountAlertDismissals: [],
      syncState: {}
    });
  }
}

export async function updateSettingsLogStore(mutator, reason = 'settings_update') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const store = {
      settings: await getSqliteScalar('settings') || {},
      logs: []
    };
    const result = await mutator(store);
    const resultPatch = result && typeof result === 'object' ? result : {};
    const extraUpserts = resultPatch.upserts && typeof resultPatch.upserts === 'object' ? resultPatch.upserts : {};
    const extraDeletes = resultPatch.deletes && typeof resultPatch.deletes === 'object' ? resultPatch.deletes : {};
    const extraReplaces = resultPatch.replaces && typeof resultPatch.replaces === 'object' ? resultPatch.replaces : {};
    const extraScalars = resultPatch.scalars && typeof resultPatch.scalars === 'object' ? resultPatch.scalars : {};
    const extraPositions = resultPatch.positions && typeof resultPatch.positions === 'object' ? resultPatch.positions : {};
    const extraTrims = resultPatch.trims && typeof resultPatch.trims === 'object' ? resultPatch.trims : {};
    const createdLogs = (store.logs || [])
      .toSorted((left, right) => timestampForSort(right.createdAt) - timestampForSort(left.createdAt))
      .slice(0, LOG_HISTORY_LIMIT);
    const upserts = { ...extraUpserts };
    if (createdLogs.length) {
      upserts.logs = [...(Array.isArray(upserts.logs) ? upserts.logs : []), ...createdLogs];
    }
    let patchResult;
    try {
      patchResult = await writeSqliteStorePatch({
        reason,
        upserts,
        deletes: extraDeletes,
        replaces: extraReplaces,
        scalars: { ...extraScalars, settings: store.settings || {} },
        positions: extraPositions,
        trims: {
          ...extraTrims,
          ...(createdLogs.length ? logTrimPatch() : {})
        }
      });
    } catch (error) {
      if (error?.status) throw error;
      console.warn('[nb-clan] sqlite settings log write failed:', error?.message || error);
      throw settingsStoreWriteUnavailableError('系统配置写入', error);
    }
    await patchStoreCache((cachedStore) => {
      cachedStore.settings = store.settings || {};
      const nonLogCollections = [...new Set([
        ...Object.keys(extraUpserts),
        ...Object.keys(extraDeletes)
      ])].filter((collection) => collection !== 'logs');
      if (nonLogCollections.length) {
        applyStoreCollectionCachePatch(cachedStore, nonLogCollections, extraUpserts, extraDeletes);
      }
      if (createdLogs.length) applyCachedLogPatch(cachedStore, createdLogs, trimmedLogIds(patchResult));
    });
    return result;
  });
}

export async function updateSettingsStore(mutator, reason = 'settings_update') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const store = {
      settings: await getSqliteScalar('settings') || {}
    };
    const result = await mutator(store);
    try {
      await writeSqliteStorePatch({
        reason,
        scalars: { settings: store.settings || {} }
      });
    } catch (error) {
      if (error?.status) throw error;
      console.warn('[nb-clan] sqlite settings write failed:', error?.message || error);
      throw settingsStoreWriteUnavailableError('系统配置写入', error);
    }
    await patchStoreCache((cachedStore) => {
      cachedStore.settings = store.settings || {};
    });
    return result;
  });
}

export async function writeTeamLogoUploadDirect(req, upload) {
  if (!sqlitePrimaryMode()) return null;
  try {
    return await runStoreWriteTask(async () => {
      const [settings, existingUploads] = await Promise.all([
        getSqliteScalar('settings'),
        getSqliteRecordsByJsonField('uploads', 'ownerId', ['team-logo'], { limit: 0 })
      ]);
      const store = { settings: settings || {} };
      const nextUpload = { ...upload, ownerType: 'system', ownerId: 'team-logo', kind: 'team_logo' };
      const removedUploads = (existingUploads || []).filter((item) => (
        item?.ownerType === 'system' && item.ownerId === 'team-logo' && item.kind === 'team_logo'
      ));
      const removedUploadIds = removedUploads.map((item) => item.id).filter(Boolean);
      const settingsSystem = systemSettings(store);
      settingsSystem.teamLogoUrl = nextUpload.url;
      settingsSystem.teamLogoUpdatedAt = nextUpload.createdAt;
      const log = createLogEntry(req, 'system_settings_edit', `上传战队徽标 ${nextUpload.originalName || nextUpload.fileName}`);
      const patchResult = await writeSqliteStorePatch({
        reason: 'system_team_logo_upload',
        upserts: {
          uploads: [nextUpload],
          logs: [log]
        },
        deletes: removedUploadIds.length ? { uploads: removedUploadIds } : {},
        scalars: { settings: store.settings },
        positions: {
          uploads: { [nextUpload.id]: 0 },
          logs: { [log.id]: 0 }
        },
        trims: logTrimPatch()
      });
      await patchStoreCache((cachedStore) => {
        cachedStore.settings = store.settings;
        const deleteUploadIds = new Set(removedUploadIds);
        cachedStore.uploads = (cachedStore.uploads || []).filter((item) => !deleteUploadIds.has(item?.id) && item?.id !== nextUpload.id);
        cachedStore.uploads.unshift(nextUpload);
        applyCachedLogPatch(cachedStore, [log], trimmedLogIds(patchResult));
      });
      return { upload: nextUpload, removedUploads };
    });
  } catch (error) {
    if (error?.status) throw error;
    console.warn('[nb-clan] sqlite team logo upload failed:', error?.message || error);
    throw settingsStoreWriteUnavailableError('战队徽标写入', error);
  }
}

export async function writeTeamLogoUploadStore(req, upload) {
  if (!sqlitePrimaryMode()) {
    const removedUploads = [];
    await updateStore((store) => {
      store.uploads ||= [];
      const settings = systemSettings(store);
      removedUploads.push(...store.uploads.filter((item) => item.ownerType === 'system' && item.ownerId === 'team-logo' && item.kind === 'team_logo'));
      store.uploads = store.uploads.filter((item) => !(item.ownerType === 'system' && item.ownerId === 'team-logo' && item.kind === 'team_logo'));
      store.uploads.unshift(upload);
      settings.teamLogoUrl = upload.url;
      settings.teamLogoUpdatedAt = upload.createdAt;
      appendLog(store, req, 'system_settings_edit', `上传战队徽标 ${upload.originalName || upload.fileName}`);
    });
    return { upload, removedUploads };
  }
  return writeTeamLogoUploadDirect(req, upload);
}
