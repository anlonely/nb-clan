import { deploymentText } from './branding.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerWipeRoutes requires ${name}`);
  }
  return value;
}

function requiredValue(name, value) {
  if (value === undefined || value === null) {
    throw new TypeError(`registerWipeRoutes requires ${name}`);
  }
  return value;
}

function mergeWipePermissionStore(store, permissionStore) {
  return {
    ...store,
    permissionRoles: permissionStore.permissionRoles || store.permissionRoles || [],
    squads: store.squads?.length ? store.squads : (permissionStore.squads || [])
  };
}

export function registerWipeReadRoutes(router, {
  requireAuth,
  normalizeText,
  sqlitePrimaryMode,
  readStore,
  promoteStartedWipesToCurrentIfNeeded,
  promoteAndRefreshStartedWipeVitalMetadata,
  readCurrentWipeRuntimeStore,
  readWipeListStore,
  readWipeAccessCheckStore,
  readKdaRuntimeStore,
  canViewWipesInStore,
  canViewWipeRecord,
  canViewOperationalData,
  currentWipe,
  isWipeStartedServer,
  leaderSquads,
  enrichWipe,
  enrichWipeListItem,
  BUILTIN_ROLE_IDS,
  exportTimeRangeRequestedFromQuery,
  exportTimeRangeFromQuery,
  syncGeneratedKdaRowsForWipeIfNeeded,
  validExportLanguage,
  exportTimeZone,
  detailForWipe,
  appendLogDirect,
  rankingSpecsFromQuery,
  exportDetailToHtml,
  exportDetailToCsv,
  setDownloadFileHeaders,
  rankingHtmlFileName,
  rankingCsvFileName,
  sendRankingPdfExport
} = {}) {
  const ensureAuth = requiredDependency('requireAuth', requireAuth);
  const cleanText = requiredDependency('normalizeText', normalizeText);
  const isSqlitePrimaryMode = requiredDependency('sqlitePrimaryMode', sqlitePrimaryMode);
  const readFullStore = requiredDependency('readStore', readStore);
  const promoteStartedWipes = requiredDependency('promoteStartedWipesToCurrentIfNeeded', promoteStartedWipesToCurrentIfNeeded);
  const promoteAndRefreshStartedWipe = requiredDependency('promoteAndRefreshStartedWipeVitalMetadata', promoteAndRefreshStartedWipeVitalMetadata);
  const readCurrentWipeStore = requiredDependency('readCurrentWipeRuntimeStore', readCurrentWipeRuntimeStore);
  const readWipeList = requiredDependency('readWipeListStore', readWipeListStore);
  const readWipeAccessCheck = requiredDependency('readWipeAccessCheckStore', readWipeAccessCheckStore);
  const readKdaRuntime = requiredDependency('readKdaRuntimeStore', readKdaRuntimeStore);
  const canViewWipes = requiredDependency('canViewWipesInStore', canViewWipesInStore);
  const canViewWipe = requiredDependency('canViewWipeRecord', canViewWipeRecord);
  const canViewOperational = requiredDependency('canViewOperationalData', canViewOperationalData);
  const getCurrentWipe = requiredDependency('currentWipe', currentWipe);
  const isStartedServer = requiredDependency('isWipeStartedServer', isWipeStartedServer);
  const getLeaderSquads = requiredDependency('leaderSquads', leaderSquads);
  const publicWipe = requiredDependency('enrichWipe', enrichWipe);
  const publicWipeListItem = requiredDependency('enrichWipeListItem', enrichWipeListItem);
  const builtInRoleIds = requiredValue('BUILTIN_ROLE_IDS', BUILTIN_ROLE_IDS);
  const timeRangeRequestedFromQuery = requiredDependency('exportTimeRangeRequestedFromQuery', exportTimeRangeRequestedFromQuery);
  const timeRangeFromQuery = requiredDependency('exportTimeRangeFromQuery', exportTimeRangeFromQuery);
  const syncGeneratedRows = requiredDependency('syncGeneratedKdaRowsForWipeIfNeeded', syncGeneratedKdaRowsForWipeIfNeeded);
  const validLanguage = requiredDependency('validExportLanguage', validExportLanguage);
  const getExportTimeZone = requiredDependency('exportTimeZone', exportTimeZone);
  const getDetailForWipe = requiredDependency('detailForWipe', detailForWipe);
  const writeLog = requiredDependency('appendLogDirect', appendLogDirect);
  const getRankingSpecs = requiredDependency('rankingSpecsFromQuery', rankingSpecsFromQuery);
  const detailToHtml = requiredDependency('exportDetailToHtml', exportDetailToHtml);
  const detailToCsv = requiredDependency('exportDetailToCsv', exportDetailToCsv);
  const setFileHeaders = requiredDependency('setDownloadFileHeaders', setDownloadFileHeaders);
  const htmlFileName = requiredDependency('rankingHtmlFileName', rankingHtmlFileName);
  const csvFileName = requiredDependency('rankingCsvFileName', rankingCsvFileName);
  const sendPdfExport = requiredDependency('sendRankingPdfExport', sendRankingPdfExport);

  router.get('/wipes/current', ensureAuth, async (req, res, next) => {
    try {
      await promoteAndRefreshStartedWipe(req);
      const store = isSqlitePrimaryMode()
        ? await readCurrentWipeStore({ includeUploads: true, includeWipeSettlements: true, includePermissionRoles: true })
        : await readFullStore();
      if (!canViewWipes(store, req.user)) {
        sendFail(res, 403, '无权查看档期');
        return;
      }
      sendOk(res, { wipe: publicWipe(store, getCurrentWipe(store), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/wipes', ensureAuth, async (req, res, next) => {
    try {
      await promoteStartedWipes(req);
      const roleCode = cleanText(req.user?.role, 40);
      const store = await readWipeList({
        includePermissionRoles: Boolean(roleCode && !builtInRoleIds.includes(roleCode))
      });
      if (!canViewWipes(store, req.user)) {
        sendFail(res, 403, '无权查看档期');
        return;
      }
      const leaderSquadIds = new Set(getLeaderSquads(store, req.user).map((squad) => squad.id));
      const wipes = store.wipes
        .filter((wipe) => {
          if (canViewOperational(req.user, store)) return true;
          return store.wipeParticipants.some((item) => item.wipeId === wipe.id && leaderSquadIds.has(item.squadId));
        })
        .map((wipe) => publicWipeListItem(store, wipe, req.user, leaderSquadIds));
      sendOk(res, { wipes });
    } catch (error) {
      next(error);
    }
  });

  router.get('/wipes/:id/export', ensureAuth, async (req, res, next) => {
    try {
      const permissionStore = await readWipeAccessCheck(req.user);
      if (!canViewWipes(permissionStore, req.user)) {
        sendFail(res, 403, '无权导出 KDA');
        return;
      }
      const timeRangeRequested = timeRangeRequestedFromQuery(req.query);
      await syncGeneratedRows(req.params.id, 'wipe_export_kda_rows_refresh');
      const store = await readKdaRuntime({
        wipeIds: [req.params.id],
        includeKdaSnapshots: timeRangeRequested,
        scopeMembersToRows: true
      });
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      if (!wipe) {
        sendFail(res, 404, '档期不存在');
        return;
      }
      let detailStore = store;
      if (!canViewWipe(store, wipe, req.user)) {
        const permissionAwareStore = mergeWipePermissionStore(store, permissionStore);
        if (!canViewWipe(permissionAwareStore, wipe, req.user)) {
          sendFail(res, 403, '无权查看档期');
          return;
        }
        detailStore = permissionAwareStore;
      }
      const language = validLanguage(cleanText(req.query?.language, 10) || 'zh');
      const timeZone = getExportTimeZone(language, cleanText(req.query?.timeZone, 80));
      const timeRange = timeRangeFromQuery(req.query);
      const detail = getDetailForWipe(detailStore, wipe, req.user, {
        scope: cleanText(req.query?.scope, 40),
        squadId: cleanText(req.query?.squadId, 80),
        squadIds: req.query?.squadIds,
        sort: cleanText(req.query?.sort, 40),
        order: cleanText(req.query?.order, 10),
        timeRange
      });
      await writeLog(req, 'export', `导出档案 ${wipe.name}`, { targetId: wipe.id });
      const format = cleanText(req.query?.format, 20) || 'csv';
      const ranking = cleanText(req.query?.ranking, 80) || (format === 'pdf' ? 'all' : 'kills');
      const rankingSpecs = getRankingSpecs(ranking);
      if (format === 'html') {
        const html = detailToHtml(detail, language, req.user, { rankingSpec: rankingSpecs[0], timeZone });
        setFileHeaders(res, {
          contentType: 'text/html; charset=utf-8',
          fileName: htmlFileName(wipe, language, rankingSpecs[0]),
          asciiFileName: htmlFileName(wipe, 'en', rankingSpecs[0])
        });
        res.send(html);
        return;
      }
      if (format === 'pdf') {
        await sendPdfExport(res, {
          detail,
          wipe,
          language,
          user: req.user,
          rankingSpecs,
          timeZone,
          detailExport: true
        });
        return;
      }
      const csv = detailToCsv(detail, language, req.user, { timeZone });
      setFileHeaders(res, {
        contentType: 'text/csv; charset=utf-8',
        fileName: csvFileName(wipe, language, 'settlement'),
        asciiFileName: csvFileName(wipe, 'en', 'settlement')
      });
      res.send(`\uFEFF${csv}`);
    } catch (error) {
      next(error);
    }
  });

  router.get('/wipes/:id', ensureAuth, async (req, res, next) => {
    try {
      const permissionStore = await readWipeAccessCheck(req.user);
      if (!canViewWipes(permissionStore, req.user)) {
        sendFail(res, 403, '无权查看档期');
        return;
      }
      const timeRangeRequested = timeRangeRequestedFromQuery(req.query);
      let store = await readKdaRuntime({
        wipeIds: [req.params.id],
        includeKdaSnapshots: timeRangeRequested,
        scopeMembersToRows: true
      });
      let wipe = store.wipes.find((item) => item.id === req.params.id);
      if (!wipe) {
        sendFail(res, 404, '档期不存在');
        return;
      }
      if (wipe.status !== 'closed' && isStartedServer(wipe)) {
        await syncGeneratedRows(req.params.id, 'wipe_detail_kda_rows_refresh');
        store = await readKdaRuntime({
          wipeIds: [req.params.id],
          includeKdaSnapshots: timeRangeRequested,
          scopeMembersToRows: true
        });
        wipe = store.wipes.find((item) => item.id === req.params.id);
        if (!wipe) {
          sendFail(res, 404, '档期不存在');
          return;
        }
      }
      let detailStore = store;
      if (!canViewWipe(store, wipe, req.user)) {
        const permissionAwareStore = mergeWipePermissionStore(store, permissionStore);
        if (!canViewWipe(permissionAwareStore, wipe, req.user)) {
          sendFail(res, 403, '无权查看档期');
          return;
        }
        detailStore = permissionAwareStore;
      }
      const timeRange = timeRangeFromQuery(req.query);
      sendOk(res, getDetailForWipe(detailStore, wipe, req.user, {
        scope: cleanText(req.query?.scope, 40),
        squadId: cleanText(req.query?.squadId, 80),
        squadIds: req.query?.squadIds,
        q: cleanText(req.query?.q, 120),
        sort: cleanText(req.query?.sort, 40),
        order: cleanText(req.query?.order, 10),
        timeRange
      }));
    } catch (error) {
      next(error);
    }
  });
}

export function registerWipeWriteRoutes(router, {
  requireAdmin,
  normalizeText,
  updateStore,
  currentWipe,
  appendLog,
  createWebWipeDirect,
  buildWebWipeCreateDraft,
  queueRustMapsImageSyncForWipe,
  readWipeParticipantResponseStore,
  enrichWipe,
  updateWebWipeDirect,
  assertWipeMutable,
  buildWebWipeEditDraft,
  deleteWebWipeDirect,
  readWipeRuntimeStore,
  removeWipeUploadFile,
  dataDir,
  sqlitePrimaryMode,
  readStore,
  getSqliteRecord,
  createId,
  nowIso,
  writeWipeUploadDirect,
  deleteWipeUploadDirect,
  updateKdaWriteStore,
  closeWipeInStore
} = {}) {
  const ensureAdmin = requiredDependency('requireAdmin', requireAdmin);
  const cleanText = requiredDependency('normalizeText', normalizeText);
  const writeStore = requiredDependency('updateStore', updateStore);
  const getCurrentWipe = requiredDependency('currentWipe', currentWipe);
  const appendStoreLog = requiredDependency('appendLog', appendLog);
  const createWipeDirect = requiredDependency('createWebWipeDirect', createWebWipeDirect);
  const createWipeDraft = requiredDependency('buildWebWipeCreateDraft', buildWebWipeCreateDraft);
  const queueMapImageSync = requiredDependency('queueRustMapsImageSyncForWipe', queueRustMapsImageSyncForWipe);
  const readWipeParticipantResponse = requiredDependency('readWipeParticipantResponseStore', readWipeParticipantResponseStore);
  const publicWipe = requiredDependency('enrichWipe', enrichWipe);
  const updateWipeDirect = requiredDependency('updateWebWipeDirect', updateWebWipeDirect);
  const ensureWipeMutable = requiredDependency('assertWipeMutable', assertWipeMutable);
  const editWipeDraft = requiredDependency('buildWebWipeEditDraft', buildWebWipeEditDraft);
  const deleteWipeDirect = requiredDependency('deleteWebWipeDirect', deleteWebWipeDirect);
  const readWipeRuntime = requiredDependency('readWipeRuntimeStore', readWipeRuntimeStore);
  const removeUploadFile = requiredDependency('removeWipeUploadFile', removeWipeUploadFile);
  const dataDirectory = requiredValue('dataDir', dataDir);
  const isSqlitePrimaryMode = requiredDependency('sqlitePrimaryMode', sqlitePrimaryMode);
  const readFullStore = requiredDependency('readStore', readStore);
  const getSqliteRow = requiredDependency('getSqliteRecord', getSqliteRecord);
  const newId = requiredDependency('createId', createId);
  const currentIsoTime = requiredDependency('nowIso', nowIso);
  const writeUploadDirect = requiredDependency('writeWipeUploadDirect', writeWipeUploadDirect);
  const deleteUploadDirect = requiredDependency('deleteWipeUploadDirect', deleteWipeUploadDirect);
  const updateKdaWrite = requiredDependency('updateKdaWriteStore', updateKdaWriteStore);
  const closeWipe = requiredDependency('closeWipeInStore', closeWipeInStore);

  router.post('/wipes', ensureAdmin, async (req, res, next) => {
    try {
      const serverName = cleanText(req.body?.serverName, 120);
      if (!serverName) {
        sendFail(res, 400, '服务器名称必填');
        return;
      }
      let createdWipeId = await createWipeDirect(req);
      if (!createdWipeId) createdWipeId = await writeStore((store) => {
        if (getCurrentWipe(store)) throw Object.assign(new Error('已经存在进行中的档期'), { status: 409 });
        const wipe = createWipeDraft(req);
        store.wipes.unshift(wipe);
        appendStoreLog(store, req, 'wipe_create', `创建当前档 ${wipe.name}`, { targetId: wipe.id });
        return wipe.id;
      });
      queueMapImageSync(createdWipeId, req.user.id);
      const store = await readWipeParticipantResponse(createdWipeId, {
        includeUploads: true,
        includeWipeSettlements: true
      });
      sendOk(res, { wipe: publicWipe(store, getCurrentWipe(store), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/wipes/:id', ensureAdmin, async (req, res, next) => {
    try {
      let updatedWipeId = await updateWipeDirect(req);
      if (!updatedWipeId) updatedWipeId = await writeStore((store) => {
        const index = store.wipes.findIndex((wipe) => wipe.id === req.params.id);
        const wipe = store.wipes[index];
        ensureWipeMutable(wipe);
        const nextWipe = editWipeDraft(req, wipe);
        store.wipes[index] = nextWipe;
        appendStoreLog(store, req, 'wipe_edit', `编辑当前档 ${nextWipe.name}`, { targetId: wipe.id });
        return nextWipe.id;
      });
      queueMapImageSync(updatedWipeId, req.user.id);
      const store = await readWipeParticipantResponse(req.params.id, {
        includeUploads: true,
        includeWipeSettlements: true
      });
      sendOk(res, { wipe: publicWipe(store, store.wipes.find((wipe) => wipe.id === req.params.id), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/wipes/:id', ensureAdmin, async (req, res, next) => {
    try {
      let deleted = await deleteWipeDirect(req);
      if (!deleted) deleted = await writeStore((store) => {
        const index = store.wipes.findIndex((wipe) => wipe.id === req.params.id);
        if (index === -1) throw Object.assign(new Error('档期不存在'), { status: 404 });
        const wipe = store.wipes[index];
        if (wipe.status !== 'closed') throw Object.assign(new Error('进行中的档期请先结档'), { status: 409 });
        const uploads = store.uploads.filter((upload) => upload.ownerType === 'wipe' && upload.ownerId === wipe.id);
        store.wipes.splice(index, 1);
        store.wipeParticipants = store.wipeParticipants.filter((item) => item.wipeId !== wipe.id);
        store.kdaRows = store.kdaRows.filter((item) => item.wipeId !== wipe.id);
        store.kdaSnapshots = store.kdaSnapshots.filter((item) => item.wipeId !== wipe.id);
        store.wipeSettlements = store.wipeSettlements.filter((item) => item.wipeId !== wipe.id);
        store.uploads = store.uploads.filter((upload) => !(upload.ownerType === 'wipe' && upload.ownerId === wipe.id));
        appendStoreLog(store, req, 'wipe_delete', `删除档案 ${wipe.name}`, { targetId: wipe.id });
        return { wipe, uploads };
      });
      await Promise.all((deleted.uploads || []).map((upload) => removeUploadFile(upload)));
      const store = await readWipeRuntime({ includeWipeSettlements: true, includePermissionRoles: true });
      sendOk(res, { wipes: store.wipes.map((wipe) => publicWipe(store, wipe, req.user)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wipes/:id/screenshots', ensureAdmin, async (req, res, next) => {
    try {
      const mimeType = cleanText(req.body?.mimeType, 80);
      const originalName = cleanText(req.body?.originalName, 120) || 'server-screenshot.png';
      const dataUrl = String(req.body?.dataUrl || '');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || !dataUrl.includes(',')) {
        sendFail(res, 400, '截图格式不支持');
        return;
      }
      const buffer = Buffer.from(dataUrl.split(',').at(-1), 'base64');
      if (buffer.length > 5 * 1024 * 1024) {
        sendFail(res, 400, '截图不能超过 5MB');
        return;
      }
      const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/').at(-1);
      const uploadDir = path.join(dataDirectory, 'uploads', 'server-screenshots');
      const fileName = `${newId('upload')}.${ext}`;
      const validationWipe = isSqlitePrimaryMode()
        ? await getSqliteRow('wipes', req.params.id)
        : (await readFullStore()).wipes.find((item) => item.id === req.params.id);
      ensureWipeMutable(validationWipe);
      const filePath = path.join(uploadDir, fileName);
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(filePath, buffer);
      try {
        const upload = {
          id: newId('upload'),
          ownerType: 'wipe',
          ownerId: req.params.id,
          kind: 'server_screenshot',
          fileName,
          originalName,
          mimeType,
          size: buffer.length,
          url: `/uploads/server-screenshots/${fileName}`,
          createdBy: req.user.id,
          createdAt: currentIsoTime()
        };
        const directWrite = await writeUploadDirect(req, upload, {
          logType: 'wipe_screenshot_upload',
          logMessage: `上传服务器截图 ${originalName}`
        });
        if (!directWrite) {
          await writeStore((store) => {
            const wipe = store.wipes.find((item) => item.id === req.params.id);
            ensureWipeMutable(wipe);
            store.uploads.unshift({ ...upload, ownerId: wipe.id });
            appendStoreLog(store, req, 'wipe_screenshot_upload', `上传服务器截图 ${originalName}`, { targetId: wipe.id });
          });
        }
      } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
      }
      const store = await readWipeParticipantResponse(req.params.id, {
        includeUploads: true,
        includeWipeSettlements: true
      });
      sendOk(res, { wipe: publicWipe(store, store.wipes.find((wipe) => wipe.id === req.params.id), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/wipes/:id/screenshots/:uploadId', ensureAdmin, async (req, res, next) => {
    try {
      let upload = await deleteUploadDirect(req, {
        allowedKinds: ['server_screenshot'],
        notFoundMessage: '截图不存在',
        logType: 'wipe_screenshot_delete',
        logMessage: (found) => `删除服务器截图 ${found.originalName || found.fileName}`
      });
      if (!upload) {
        upload = await writeStore((store) => {
          const wipe = store.wipes.find((item) => item.id === req.params.id);
          ensureWipeMutable(wipe);
          const found = store.uploads.find((item) => item.id === req.params.uploadId && item.ownerType === 'wipe' && item.ownerId === wipe.id);
          if (!found) throw Object.assign(new Error('截图不存在'), { status: 404 });
          store.uploads = store.uploads.filter((item) => item.id !== found.id);
          appendStoreLog(store, req, 'wipe_screenshot_delete', `删除服务器截图 ${found.originalName || found.fileName}`, { targetId: wipe.id });
          return found;
        });
      }
      const fileName = path.basename(upload.fileName || '');
      if (fileName && fileName === upload.fileName) {
        await fs.unlink(path.join(dataDirectory, 'uploads', 'server-screenshots', fileName)).catch(() => {});
      }
      const store = await readWipeParticipantResponse(req.params.id, {
        includeUploads: true,
        includeWipeSettlements: true
      });
      sendOk(res, { wipe: publicWipe(store, store.wipes.find((wipe) => wipe.id === req.params.id), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wipes/:id/map-files', ensureAdmin, async (req, res, next) => {
    try {
      const mimeType = cleanText(req.body?.mimeType, 120);
      const originalName = cleanText(req.body?.originalName, 160) || 'map-file';
      const kind = cleanText(req.body?.kind, 40) === 'map_image' ? 'map_image' : 'map_file';
      const dataUrl = String(req.body?.dataUrl || '');
      if (!dataUrl.includes(',')) {
        sendFail(res, 400, '地图文件格式不支持');
        return;
      }
      if (kind === 'map_image' && !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
        sendFail(res, 400, '地图图片格式不支持');
        return;
      }
      const buffer = Buffer.from(dataUrl.split(',').at(-1), 'base64');
      if (buffer.length > 20 * 1024 * 1024) {
        sendFail(res, 400, '地图文件不能超过 20MB');
        return;
      }
      const imageExtByMime = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp'
      };
      const ext = kind === 'map_image' ? imageExtByMime[mimeType] : '.map';
      const uploadDir = path.join(dataDirectory, 'uploads', 'map-files');
      const fileName = `${newId('upload')}${ext}`;
      const validationWipe = isSqlitePrimaryMode()
        ? await getSqliteRow('wipes', req.params.id)
        : (await readFullStore()).wipes.find((item) => item.id === req.params.id);
      ensureWipeMutable(validationWipe);
      const filePath = path.join(uploadDir, fileName);
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(filePath, buffer);
      try {
        const upload = {
          id: newId('upload'),
          ownerType: 'wipe',
          ownerId: req.params.id,
          kind,
          fileName,
          originalName,
          mimeType,
          size: buffer.length,
          url: `/uploads/map-files/${fileName}`,
          createdBy: req.user.id,
          createdAt: currentIsoTime()
        };
        const directWrite = await writeUploadDirect(req, upload, {
          logType: 'wipe_map_upload',
          logMessage: `上传地图资源 ${originalName}`
        });
        if (!directWrite) {
          await writeStore((store) => {
            const wipe = store.wipes.find((item) => item.id === req.params.id);
            ensureWipeMutable(wipe);
            store.uploads.unshift({ ...upload, ownerId: wipe.id });
            appendStoreLog(store, req, 'wipe_map_upload', `上传地图资源 ${originalName}`, { targetId: wipe.id });
          });
        }
      } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        throw error;
      }
      const store = await readWipeParticipantResponse(req.params.id, {
        includeUploads: true,
        includeWipeSettlements: true
      });
      sendOk(res, { wipe: publicWipe(store, store.wipes.find((wipe) => wipe.id === req.params.id), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/wipes/:id/map-files/:uploadId', ensureAdmin, async (req, res, next) => {
    try {
      let upload = await deleteUploadDirect(req, {
        allowedKinds: ['map_file', 'map_image'],
        notFoundMessage: '地图资源不存在',
        logType: 'wipe_map_delete',
        logMessage: (found) => `删除地图资源 ${found.originalName || found.fileName}`
      });
      if (!upload) {
        upload = await writeStore((store) => {
          const wipe = store.wipes.find((item) => item.id === req.params.id);
          ensureWipeMutable(wipe);
          const found = store.uploads.find((item) => item.id === req.params.uploadId && item.ownerType === 'wipe' && item.ownerId === wipe.id && (item.kind === 'map_file' || item.kind === 'map_image'));
          if (!found) throw Object.assign(new Error('地图资源不存在'), { status: 404 });
          store.uploads = store.uploads.filter((item) => item.id !== found.id);
          appendStoreLog(store, req, 'wipe_map_delete', `删除地图资源 ${found.originalName || found.fileName}`, { targetId: wipe.id });
          return found;
        });
      }
      const fileName = path.basename(upload.fileName || '');
      if (fileName && fileName === upload.fileName) {
        await fs.unlink(path.join(dataDirectory, 'uploads', 'map-files', fileName)).catch(() => {});
      }
      const store = await readWipeParticipantResponse(req.params.id, {
        includeUploads: true,
        includeWipeSettlements: true
      });
      sendOk(res, { wipe: publicWipe(store, store.wipes.find((wipe) => wipe.id === req.params.id), req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wipes/:id/close', ensureAdmin, async (req, res, next) => {
    try {
      await updateKdaWrite((store) => {
        const wipe = store.wipes.find((item) => item.id === req.params.id);
        closeWipe(store, wipe, req.user, req);
      }, 'wipe_close', { requestedWipeId: req.params.id });
      const store = await readWipeRuntime({ includeUploads: true, includeWipeSettlements: true, includePermissionRoles: true });
      sendOk(res, { wipe: publicWipe(store, store.wipes.find((wipe) => wipe.id === req.params.id), req.user) });
    } catch (error) {
      next(error);
    }
  });
}

export function registerWipeDiscordAttendanceRoutes(router, {
  requireAdmin,
  previewDiscordWipeAttendanceCard,
  pushDiscordWipeAttendanceCard,
  readWipeRuntimeStore,
  enrichWipe
} = {}) {
  const ensureAdmin = requiredDependency('requireAdmin', requireAdmin);
  const previewAttendanceCard = requiredDependency('previewDiscordWipeAttendanceCard', previewDiscordWipeAttendanceCard);
  const pushAttendanceCard = requiredDependency('pushDiscordWipeAttendanceCard', pushDiscordWipeAttendanceCard);
  const readWipeRuntime = requiredDependency('readWipeRuntimeStore', readWipeRuntimeStore);
  const publicWipe = requiredDependency('enrichWipe', enrichWipe);

  router.post('/wipes/current/discord-attendance/preview', ensureAdmin, async (req, res, next) => {
    try {
      const result = await previewAttendanceCard(req, {
        body: req.body || {},
        createdBy: req.user?.steamNickname || req.user?.username || deploymentText("Clan Portal")
      });
      sendOk(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/wipes/current/discord-attendance', ensureAdmin, async (req, res, next) => {
    try {
      const result = await pushAttendanceCard(req, {
        body: req.body || {},
        createdBy: req.user?.steamNickname || req.user?.username || deploymentText("Clan Portal")
      });
      const store = await readWipeRuntime({ includeUploads: true, includeWipeSettlements: true, includePermissionRoles: true });
      sendOk(res, {
        discord: result.discord,
        wipe: publicWipe(store, result.wipe, req.user),
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  });
}

export function registerWipeParticipantRoutes(router, {
  requireAuth,
  normalizeText,
  syncLeaderMembersForViewer,
  readWipeParticipantResponseStore,
  readWipeParticipantCandidatesStore,
  canViewWipesInStore,
  participantCandidates,
  normalizeWechatWipeSignupStatus,
  writeWebWipeParticipantsDirect,
  updateStore,
  assertWipeMutable,
  upsertWebMemberWipeSignup,
  isWipeStartedServer,
  syncKdaRows,
  attendanceStatusText,
  memberDisplayName,
  appendLog,
  triggerNewMemberDataSyncSafe,
  queueDiscordWipeAttendanceCardRefresh,
  visibleParticipants,
  wipeParticipantsPayload,
  normalizeParticipantStatus,
  WECHAT_WIPE_SIGNUP_STATUSES,
  memberSquadMap,
  leaderSquads,
  createId,
  nowIso,
  recordMemberNotAttending,
  queueStartedWipeKdaRowsRefresh,
  wipeParticipantMutationResponseQuery,
  canManageWipeParticipant,
  isAdmin,
  activeSquads
} = {}) {
  const ensureAuth = requiredDependency('requireAuth', requireAuth);
  const cleanText = requiredDependency('normalizeText', normalizeText);
  const syncLeaderMembers = requiredDependency('syncLeaderMembersForViewer', syncLeaderMembersForViewer);
  const readParticipantResponse = requiredDependency('readWipeParticipantResponseStore', readWipeParticipantResponseStore);
  const readParticipantCandidates = requiredDependency('readWipeParticipantCandidatesStore', readWipeParticipantCandidatesStore);
  const canViewWipes = requiredDependency('canViewWipesInStore', canViewWipesInStore);
  const getParticipantCandidates = requiredDependency('participantCandidates', participantCandidates);
  const normalizeSignupStatus = requiredDependency('normalizeWechatWipeSignupStatus', normalizeWechatWipeSignupStatus);
  const writeParticipantsDirect = requiredDependency('writeWebWipeParticipantsDirect', writeWebWipeParticipantsDirect);
  const writeStore = requiredDependency('updateStore', updateStore);
  const ensureWipeMutable = requiredDependency('assertWipeMutable', assertWipeMutable);
  const upsertMemberSignup = requiredDependency('upsertWebMemberWipeSignup', upsertWebMemberWipeSignup);
  const isStartedServer = requiredDependency('isWipeStartedServer', isWipeStartedServer);
  const syncKdaRowsForWipe = requiredDependency('syncKdaRows', syncKdaRows);
  const getAttendanceStatusText = requiredDependency('attendanceStatusText', attendanceStatusText);
  const getMemberDisplayName = requiredDependency('memberDisplayName', memberDisplayName);
  const appendStoreLog = requiredDependency('appendLog', appendLog);
  const triggerNewMemberDataSync = requiredDependency('triggerNewMemberDataSyncSafe', triggerNewMemberDataSyncSafe);
  const queueAttendanceRefresh = requiredDependency('queueDiscordWipeAttendanceCardRefresh', queueDiscordWipeAttendanceCardRefresh);
  const getVisibleParticipants = requiredDependency('visibleParticipants', visibleParticipants);
  const getWipeParticipantsPayload = requiredDependency('wipeParticipantsPayload', wipeParticipantsPayload);
  const normalizeStatus = requiredDependency('normalizeParticipantStatus', normalizeParticipantStatus);
  const signupStatuses = requiredValue('WECHAT_WIPE_SIGNUP_STATUSES', WECHAT_WIPE_SIGNUP_STATUSES);
  const getMemberSquadMap = requiredDependency('memberSquadMap', memberSquadMap);
  const getLeaderSquads = requiredDependency('leaderSquads', leaderSquads);
  const newId = requiredDependency('createId', createId);
  const currentIsoTime = requiredDependency('nowIso', nowIso);
  const recordNotAttending = requiredDependency('recordMemberNotAttending', recordMemberNotAttending);
  const queueKdaRowsRefresh = requiredDependency('queueStartedWipeKdaRowsRefresh', queueStartedWipeKdaRowsRefresh);
  const mutationResponseQuery = requiredDependency('wipeParticipantMutationResponseQuery', wipeParticipantMutationResponseQuery);
  const canManageParticipant = requiredDependency('canManageWipeParticipant', canManageWipeParticipant);
  const isAdminUser = requiredDependency('isAdmin', isAdmin);
  const getActiveSquads = requiredDependency('activeSquads', activeSquads);

  router.get('/wipes/:id/participants', ensureAuth, async (req, res, next) => {
    try {
      const store = await readParticipantResponse(req.params.id);
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      if (!wipe) {
        sendFail(res, 404, '档期不存在');
        return;
      }
      sendOk(res, getWipeParticipantsPayload(store, wipe, req.user, req.query || {}));
    } catch (error) {
      next(error);
    }
  });

  router.get('/wipes/:id/participant-candidates', ensureAuth, async (req, res, next) => {
    try {
      await syncLeaderMembers(req.user);
      const store = await readParticipantCandidates(req.params.id);
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      if (!wipe) {
        sendFail(res, 404, '档期不存在');
        return;
      }
      if (!canViewWipes(store, req.user)) {
        sendFail(res, 403, '无权查看档期');
        return;
      }
      sendOk(res, { members: getParticipantCandidates(store, wipe, req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wipes/:id/my-signup', ensureAuth, async (req, res, next) => {
    let addedMemberId = '';
    let updatedWipeId = '';
    let localGeneratedKdaSynced = false;
    try {
      const status = normalizeSignupStatus(req.body?.status);
      if (!status) {
        sendFail(res, 400, '报名状态无效');
        return;
      }
      const directWrite = await writeParticipantsDirect(req, 'self_signup', { status });
      if (directWrite) {
        addedMemberId = directWrite.addedMemberIds[0] || '';
        updatedWipeId = directWrite.updatedWipeId;
        localGeneratedKdaSynced = Boolean(directWrite.localGeneratedKdaSynced);
      } else {
        await writeStore((store) => {
          const wipe = store.wipes.find((item) => item.id === req.params.id);
          const result = upsertMemberSignup(store, { wipe, user: req.user, status });
          updatedWipeId = wipe.id;
          if (result.added) addedMemberId = result.member.id;
          if (isStartedServer(wipe)) {
            syncKdaRowsForWipe(store, wipe);
            localGeneratedKdaSynced = process.env.NB_DISABLE_EXTERNAL_VITAL === '1';
          }
          const statusText = getAttendanceStatusText(status, { language: 'zh', context: 'wechat' });
          appendStoreLog(store, req, 'wipe_member_signup', `Web 自助报名 ${getMemberDisplayName(result.member)} ${statusText}`, {
            targetId: wipe.id,
            steamId: result.member.steamId,
            actorUserId: req.user.id,
            actorUsername: req.user.username,
            metadata: { memberId: result.member.id, status, source: 'web' }
          });
        });
      }
      const syncResult = addedMemberId
        ? await triggerNewMemberDataSync([addedMemberId], {
            source: 'web_wipe_signup',
            skipLocalCurrentKda: localGeneratedKdaSynced
          })
        : { queued: false, requested: 0 };
      queueAttendanceRefresh(updatedWipeId, 'web_self_signup');
      const store = await readParticipantResponse(req.params.id);
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      sendOk(res, {
        participants: getVisibleParticipants(store, wipe, req.user),
        syncQueued: syncResult.queued ? syncResult.requested : 0
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/wipes/:id/participants', ensureAuth, async (req, res, next) => {
    try {
      const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.map((id) => cleanText(id, 80)).filter(Boolean) : [];
      const status = normalizeStatus(req.body?.status);
      if (!signupStatuses.has(status)) {
        sendFail(res, 400, '参与状态不支持');
        return;
      }
      const addedMemberIds = [];
      let updatedWipeId = '';
      const directWrite = await writeParticipantsDirect(req, 'add', {
        memberIds,
        status,
        note: req.body?.note
      });
      if (directWrite) {
        addedMemberIds.push(...directWrite.addedMemberIds);
        updatedWipeId = directWrite.updatedWipeId;
      } else {
        await writeStore((store) => {
          const wipe = store.wipes.find((item) => item.id === req.params.id);
          ensureWipeMutable(wipe);
          updatedWipeId = wipe.id;
          const candidates = new Map(getParticipantCandidates(store, wipe, req.user).map((member) => [member.id, member]));
          const squadsByMember = getMemberSquadMap(store);
          const captainSquads = getLeaderSquads(store, req.user);
          for (const memberId of memberIds) {
            const member = candidates.get(memberId);
            if (!member) throw Object.assign(new Error('存在无权添加的参与人员'), { status: 403 });
            if (store.wipeParticipants.some((item) => item.wipeId === wipe.id && item.memberId === memberId)) continue;
            const memberSquadId = squadsByMember.get(memberId)?.squadId || '';
            const squadId = memberSquadId || captainSquads[0]?.id || '';
            const now = currentIsoTime();
            store.wipeParticipants.push({
              id: newId('wipe_participant'),
              wipeId: wipe.id,
              memberId,
              squadId,
              status,
              source: 'admin',
              sourceUserId: req.user.id,
              note: cleanText(req.body?.note, 500),
              addedByUserId: req.user.id,
              createdAt: now,
              updatedAt: now
            });
            if (status === 'not_attending') {
              recordNotAttending(store, { memberId, wipeId: wipe.id, source: 'admin', at: now });
            }
            addedMemberIds.push(memberId);
          }
          appendStoreLog(store, req, 'wipe_participant_add', `当前档添加参与人员 ${memberIds.length} 人`, { targetId: wipe.id });
        });
      }
      const kdaRefreshQueued = addedMemberIds.length ? queueKdaRowsRefresh(updatedWipeId, 'web_participant_add') : false;
      const syncResult = await triggerNewMemberDataSync(addedMemberIds, { source: 'wipe_participant_add' });
      if (addedMemberIds.length) queueAttendanceRefresh(updatedWipeId, 'web_participant_add');
      const store = await readParticipantResponse(req.params.id);
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      sendOk(res, {
        ...getWipeParticipantsPayload(store, wipe, req.user, mutationResponseQuery(req.body || {})),
        added: addedMemberIds.length,
        kdaRefreshQueued,
        syncQueued: syncResult.queued ? syncResult.requested : 0
      });
    } catch (error) {
      next(error);
    }
  });

  router.put('/wipes/:id/participants/:memberId', ensureAuth, async (req, res, next) => {
    try {
      const status = normalizeStatus(req.body?.status);
      if (!signupStatuses.has(status)) {
        sendFail(res, 400, '参与状态不支持');
        return;
      }
      let updatedWipeId = '';
      const directWrite = await writeParticipantsDirect(req, 'edit', {
        memberId: req.params.memberId,
        status
      });
      if (directWrite) {
        updatedWipeId = directWrite.updatedWipeId;
      } else {
        await writeStore((store) => {
          const wipe = store.wipes.find((item) => item.id === req.params.id);
          ensureWipeMutable(wipe);
          updatedWipeId = wipe.id;
          const index = store.wipeParticipants.findIndex((item) => item.wipeId === wipe.id && item.memberId === req.params.memberId);
          if (index === -1) throw Object.assign(new Error('参与人员不存在'), { status: 404 });
          const participant = store.wipeParticipants[index];
          const member = store.members.find((item) => item.id === participant.memberId);
          const captainSquads = getLeaderSquads(store, req.user);
          const memberSquad = getMemberSquadMap(store).get(member?.id);
          const leaderSquad = memberSquad
            ? captainSquads.find((squad) => squad.id === memberSquad.squadId) || null
            : captainSquads[0] || null;
          if (!canManageParticipant(req.user, member, memberSquad, leaderSquad)) {
            throw Object.assign(new Error('无权管理该参与人员'), { status: 403 });
          }
          let squadId = participant.squadId;
          if (isAdminUser(req.user) && Object.hasOwn(req.body || {}, 'squadId')) {
            const requestedSquadId = cleanText(req.body.squadId, 80);
            if (requestedSquadId && !getActiveSquads(store).some((squad) => squad.id === requestedSquadId)) {
              throw Object.assign(new Error('队伍不存在'), { status: 404 });
            }
            squadId = requestedSquadId;
          } else if (leaderSquad) {
            squadId = leaderSquad.id;
          }
          const previousStatus = normalizeStatus(participant.status);
          const now = currentIsoTime();
          store.wipeParticipants[index] = {
            ...participant,
            status,
            squadId,
            source: 'admin',
            sourceUserId: req.user.id,
            updatedAt: now
          };
          if (status === 'not_attending' && previousStatus !== 'not_attending') {
            recordNotAttending(store, { memberId: member.id, wipeId: wipe.id, source: 'admin', at: now });
          }
          appendStoreLog(store, req, 'wipe_participant_edit', '当前档修改参与人员', { targetId: wipe.id });
        });
      }
      queueAttendanceRefresh(updatedWipeId, 'web_participant_edit');
      const store = await readParticipantResponse(req.params.id);
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      sendOk(res, { participants: getVisibleParticipants(store, wipe, req.user) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/wipes/:id/participants/:memberId', ensureAuth, async (req, res, next) => {
    try {
      let updatedWipeId = '';
      const directWrite = await writeParticipantsDirect(req, 'remove', {
        memberId: req.params.memberId
      });
      if (directWrite) {
        updatedWipeId = directWrite.updatedWipeId;
      } else {
        await writeStore((store) => {
          const wipe = store.wipes.find((item) => item.id === req.params.id);
          ensureWipeMutable(wipe);
          updatedWipeId = wipe.id;
          const participant = store.wipeParticipants.find((item) => item.wipeId === wipe.id && item.memberId === req.params.memberId);
          if (!participant) throw Object.assign(new Error('参与人员不存在'), { status: 404 });
          const member = store.members.find((item) => item.id === participant.memberId);
          const captainSquads = getLeaderSquads(store, req.user);
          const memberSquad = getMemberSquadMap(store).get(member?.id);
          const leaderSquad = memberSquad
            ? captainSquads.find((squad) => squad.id === memberSquad.squadId) || null
            : captainSquads[0] || null;
          if (!canManageParticipant(req.user, member, memberSquad, leaderSquad)) {
            throw Object.assign(new Error('无权管理该参与人员'), { status: 403 });
          }
          store.wipeParticipants = store.wipeParticipants.filter((item) => !(item.wipeId === wipe.id && item.memberId === req.params.memberId));
          appendStoreLog(store, req, 'wipe_participant_remove', '当前档移除参与人员', { targetId: wipe.id });
        });
      }
      queueAttendanceRefresh(updatedWipeId, 'web_participant_remove');
      const store = await readParticipantResponse(req.params.id);
      const wipe = store.wipes.find((item) => item.id === req.params.id);
      sendOk(res, { participants: getVisibleParticipants(store, wipe, req.user) });
    } catch (error) {
      next(error);
    }
  });
}
