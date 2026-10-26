import { appendLog } from './audit-logs.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerKdaReadRoutes requires ${name}`);
  }
  return value;
}

function requiredValue(name, value) {
  if (value === undefined || value === null) {
    throw new TypeError(`registerKdaReadRoutes requires ${name}`);
  }
  return value;
}

export function registerKdaReadRoutes(router, {
  requireAuth,
  requireModuleEdit,
  rateLimit,
  normalizeText,
  nowIso,
  exportTimeRangeRequestedFromQuery,
  exportTimeRangeFromQuery,
  readKdaRuntimeStore,
  updateKdaWriteStore,
  refreshStartedWipeVitalMetadataIfNeeded,
  canViewWipesInStore,
  currentWipe,
  queryReferenceWipe,
  canViewWipeRecord,
  assertWipeMutable,
  isWipeStartedServer,
  refreshGeneratedKdaRowsForReadStore,
  kdaSyncTargetParticipants,
  wipeKdaCapability,
  estimateVitalKdaSyncSeconds,
  kdaRowsForWipe,
  parseKdaImportRows,
  upsertImportedKdaRows,
  enrichWipe,
  kdaDataFreshness,
  publicWipeKdaCapability,
  visibleSquads,
  enrichSquad,
  validExportLanguage,
  exportTimeZone,
  appendLogDirect,
  kdaInlineSyncMaxParticipants,
  findActiveSyncJob,
  publicSyncJob,
  publicSyncState,
  createSyncJobUnlessActive,
  expandVitalRustName,
  syncJobRunnerMetadataKey,
  writeSyncState,
  syncStatePercent,
  effectiveWipeStatus,
  runKdaSyncJob,
  scheduleSyncJobRunner,
  rankingSpecsFromQuery,
  kdaRowsToCsv,
  setDownloadFileHeaders,
  rankingCsvFileName,
  sendRankingPdfExport,
  kdaRowsToHtml,
  rankingHtmlFileName
} = {}) {
  const ensureAuth = requiredDependency('requireAuth', requireAuth);
  const ensureKdaEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('kda');
  const kdaSyncRateLimit = requiredDependency('rateLimit', rateLimit)({ name: 'kda_sync', windowMs: 180_000, max: 1 });
  const cleanText = requiredDependency('normalizeText', normalizeText);
  const currentIsoTime = requiredDependency('nowIso', nowIso);
  const timeRangeRequestedFromQuery = requiredDependency('exportTimeRangeRequestedFromQuery', exportTimeRangeRequestedFromQuery);
  const timeRangeFromQuery = requiredDependency('exportTimeRangeFromQuery', exportTimeRangeFromQuery);
  const readRuntimeStore = requiredDependency('readKdaRuntimeStore', readKdaRuntimeStore);
  const updateWriteStore = requiredDependency('updateKdaWriteStore', updateKdaWriteStore);
  const refreshStartedWipeMetadata = requiredDependency('refreshStartedWipeVitalMetadataIfNeeded', refreshStartedWipeVitalMetadataIfNeeded);
  const canViewWipes = requiredDependency('canViewWipesInStore', canViewWipesInStore);
  const getCurrentWipe = requiredDependency('currentWipe', currentWipe);
  const getQueryReferenceWipe = requiredDependency('queryReferenceWipe', queryReferenceWipe);
  const canViewWipe = requiredDependency('canViewWipeRecord', canViewWipeRecord);
  const ensureWipeMutable = requiredDependency('assertWipeMutable', assertWipeMutable);
  const wipeStarted = requiredDependency('isWipeStartedServer', isWipeStartedServer);
  const refreshGeneratedRows = requiredDependency('refreshGeneratedKdaRowsForReadStore', refreshGeneratedKdaRowsForReadStore);
  const syncTargetParticipants = requiredDependency('kdaSyncTargetParticipants', kdaSyncTargetParticipants);
  const syncCapabilityForWipe = requiredDependency('wipeKdaCapability', wipeKdaCapability);
  const estimateSyncSeconds = requiredDependency('estimateVitalKdaSyncSeconds', estimateVitalKdaSyncSeconds);
  const rowsForWipe = requiredDependency('kdaRowsForWipe', kdaRowsForWipe);
  const parseImportRows = requiredDependency('parseKdaImportRows', parseKdaImportRows);
  const upsertImportRows = requiredDependency('upsertImportedKdaRows', upsertImportedKdaRows);
  const publicWipe = requiredDependency('enrichWipe', enrichWipe);
  const freshnessForRows = requiredDependency('kdaDataFreshness', kdaDataFreshness);
  const publicKdaCapability = requiredDependency('publicWipeKdaCapability', publicWipeKdaCapability);
  const squadsForUser = requiredDependency('visibleSquads', visibleSquads);
  const publicSquad = requiredDependency('enrichSquad', enrichSquad);
  const validLanguage = requiredDependency('validExportLanguage', validExportLanguage);
  const getExportTimeZone = requiredDependency('exportTimeZone', exportTimeZone);
  const writeLog = requiredDependency('appendLogDirect', appendLogDirect);
  const inlineSyncMaxParticipants = Number(requiredValue('kdaInlineSyncMaxParticipants', kdaInlineSyncMaxParticipants));
  const findActiveJob = requiredDependency('findActiveSyncJob', findActiveSyncJob);
  const publicJob = requiredDependency('publicSyncJob', publicSyncJob);
  const publicState = requiredDependency('publicSyncState', publicSyncState);
  const createSyncJob = requiredDependency('createSyncJobUnlessActive', createSyncJobUnlessActive);
  const expandServerName = requiredDependency('expandVitalRustName', expandVitalRustName);
  const syncRunnerKey = String(requiredValue('syncJobRunnerMetadataKey', syncJobRunnerMetadataKey));
  const writeState = requiredDependency('writeSyncState', writeSyncState);
  const syncPercent = requiredDependency('syncStatePercent', syncStatePercent);
  const getEffectiveWipeStatus = requiredDependency('effectiveWipeStatus', effectiveWipeStatus);
  const runSyncJob = requiredDependency('runKdaSyncJob', runKdaSyncJob);
  const scheduleSyncJob = requiredDependency('scheduleSyncJobRunner', scheduleSyncJobRunner);
  const getRankingSpecs = requiredDependency('rankingSpecsFromQuery', rankingSpecsFromQuery);
  const rowsToCsv = requiredDependency('kdaRowsToCsv', kdaRowsToCsv);
  const setFileHeaders = requiredDependency('setDownloadFileHeaders', setDownloadFileHeaders);
  const csvFileName = requiredDependency('rankingCsvFileName', rankingCsvFileName);
  const sendPdfExport = requiredDependency('sendRankingPdfExport', sendRankingPdfExport);
  const rowsToHtml = requiredDependency('kdaRowsToHtml', kdaRowsToHtml);
  const htmlFileName = requiredDependency('rankingHtmlFileName', rankingHtmlFileName);

  router.get('/kda', ensureAuth, async (req, res, next) => {
    try {
      const requestedWipeId = cleanText(req.query?.wipeId, 120);
      await refreshStartedWipeMetadata(requestedWipeId || 'current', req, { requireMissingVitalWipeId: true });
      const timeRangeRequested = timeRangeRequestedFromQuery(req.query);
      const store = await readRuntimeStore({
        requestedWipeId,
        reference: requestedWipeId && requestedWipeId !== 'current' ? '' : 'current',
        includeKdaSnapshots: timeRangeRequested,
        scopeMembersToRows: true
      });
      if (!canViewWipes(store, req.user)) {
        sendFail(res, 403, '无权查看 KDA');
        return;
      }
      let wipe = requestedWipeId && requestedWipeId !== 'current'
        ? store.wipes.find((item) => item.id === requestedWipeId)
        : getCurrentWipe(store);
      if (!wipe) {
        sendOk(res, {
          wipe: null,
          rows: [],
          dataFreshness: freshnessForRows([]),
          squads: squadsForUser(store, req.user).map((squad) => publicSquad(store, squad, req.user))
        });
        return;
      }
      if (!canViewWipe(store, wipe, req.user)) {
        sendFail(res, 403, '无权查看档期');
        return;
      }
      const timeRange = timeRangeFromQuery(req.query);
      wipe = await refreshGeneratedRows(store, wipe, 'kda_list_rows_refresh', {
        includeKdaSnapshots: timeRange.requested
      });
      const filters = {
        scope: cleanText(req.query?.scope, 40),
        squadId: cleanText(req.query?.squadId, 80),
        squadIds: req.query?.squadIds,
        q: cleanText(req.query?.q, 120),
        sort: cleanText(req.query?.sort, 40),
        order: cleanText(req.query?.order, 10),
        timeRange
      };
      const rows = rowsForWipe(store, wipe, req.user, filters);
      sendOk(res, {
        wipe: publicWipe(store, wipe, req.user),
        rows,
        dataFreshness: {
          ...freshnessForRows(rows),
          ...publicKdaCapability(wipe)
        },
        squads: squadsForUser(store, req.user).map((squad) => publicSquad(store, squad, req.user))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/kda/export', ensureAuth, async (req, res, next) => {
    try {
      const requestedWipeId = cleanText(req.query?.wipeId, 120);
      const timeRangeRequested = timeRangeRequestedFromQuery(req.query);
      const store = await readRuntimeStore({
        requestedWipeId,
        reference: requestedWipeId && requestedWipeId !== 'current' ? '' : 'current',
        includeKdaSnapshots: timeRangeRequested,
        scopeMembersToRows: true
      });
      if (!canViewWipes(store, req.user)) {
        sendFail(res, 403, '无权导出 KDA');
        return;
      }
      let wipe = requestedWipeId && requestedWipeId !== 'current'
        ? store.wipes.find((item) => item.id === requestedWipeId)
        : getCurrentWipe(store);
      if (!wipe) {
        sendFail(res, 404, '档期不存在');
        return;
      }
      if (!canViewWipe(store, wipe, req.user)) {
        sendFail(res, 403, '无权查看档期');
        return;
      }
      const language = validLanguage(cleanText(req.query?.language, 10) || 'zh');
      const timeZone = getExportTimeZone(language, cleanText(req.query?.timeZone, 80));
      const timeRange = timeRangeFromQuery(req.query);
      wipe = await refreshGeneratedRows(store, wipe, 'kda_export_rows_refresh', {
        includeKdaSnapshots: timeRange.requested
      });
      const filters = {
        scope: cleanText(req.query?.scope, 40),
        squadId: cleanText(req.query?.squadId, 80),
        squadIds: req.query?.squadIds,
        q: cleanText(req.query?.q, 120),
        sort: cleanText(req.query?.sort, 40),
        order: cleanText(req.query?.order, 10),
        timeRange
      };
      const rows = rowsForWipe(store, wipe, req.user, filters);
      await writeLog(req, 'export', `导出 KDA ${wipe.name}`, { targetId: wipe.id });
      const format = cleanText(req.query?.format, 20) || 'html';
      const ranking = cleanText(req.query?.ranking, 80) || (format === 'pdf' ? 'all' : 'kills');
      const rankingSpecs = getRankingSpecs(ranking);
      if (format === 'csv') {
        const csv = rowsToCsv(rows, language);
        setFileHeaders(res, {
          contentType: 'text/csv; charset=utf-8',
          fileName: csvFileName(wipe, language, 'kdaData'),
          asciiFileName: csvFileName(wipe, 'en', 'kdaData')
        });
        res.send(`\uFEFF${csv}`);
        return;
      }
      if (format === 'pdf') {
        await sendPdfExport(res, {
          rows,
          wipe,
          language,
          user: req.user,
          rankingSpecs,
          timeZone
        });
        return;
      }
      const html = rowsToHtml(rows, language, { wipe, user: req.user, rankingSpec: rankingSpecs[0], timeZone });
      setFileHeaders(res, {
        contentType: 'text/html; charset=utf-8',
        fileName: htmlFileName(wipe, language, rankingSpecs[0]),
        asciiFileName: htmlFileName(wipe, 'en', rankingSpecs[0])
      });
      res.send(html);
    } catch (error) {
      next(error);
    }
  });

  router.post('/kda/sync', ensureKdaEdit, kdaSyncRateLimit, async (req, res, next) => {
    try {
      const requestedWipeId = cleanText(req.body?.wipeId, 120);
      const timeRangeRequested = timeRangeRequestedFromQuery(req.body);
      await refreshStartedWipeMetadata(requestedWipeId || 'current', req, { requireMissingVitalWipeId: true });
      const currentStore = await readRuntimeStore({
        requestedWipeId,
        reference: requestedWipeId && requestedWipeId !== 'current' ? '' : 'query',
        includeKdaSnapshots: timeRangeRequested
      });
      const current = !requestedWipeId || requestedWipeId === 'current'
        ? getQueryReferenceWipe(currentStore)
        : currentStore.wipes.find((item) => item.id === requestedWipeId);
      if (!current) {
        sendFail(res, 404, '档期不存在');
        return;
      }
      if (current.status !== 'closed' && !wipeStarted(current)) {
        sendFail(res, 400, '计划档尚未开荒');
        return;
      }

      const activeParticipants = syncTargetParticipants(currentStore, current);
      const kdaCapability = syncCapabilityForWipe(current);
      const requested = activeParticipants.length;
      const estimatedSeconds = estimateSyncSeconds(requested);
      const counts = { imported: 0, ignored: 0, requested, completed: 0, failed: 0, estimatedSeconds, source: 'none', ...kdaCapability };
      const timeRange = timeRangeFromQuery(req.body);
      const filters = {
        scope: cleanText(req.body?.scope, 40),
        squadId: cleanText(req.body?.squadId, 80),
        squadIds: req.body?.squadIds,
        q: cleanText(req.body?.q, 120),
        sort: cleanText(req.body?.sort, 40),
        order: cleanText(req.body?.order, 10),
        timeRange
      };
      const activeSyncJobInput = {
        type: 'kda',
        scope: 'kda',
        targetWipeId: current.id,
        targetVitalWipeId: cleanText(current.vitalWipeId, 120),
        targetServerId: cleanText(current.vitalServerId, 80)
      };
      const activeJob = findActiveJob(currentStore, activeSyncJobInput);
      if (activeJob) {
        const rows = rowsForWipe(currentStore, current, req.user, filters);
        sendOk(res, {
          ...counts,
          queued: true,
          job: publicJob(activeJob),
          syncState: publicState(currentStore.syncState?.kda || {}),
          wipe: publicWipe(currentStore, current, req.user),
          rows,
          dataFreshness: {
            ...freshnessForRows(rows),
            ...publicKdaCapability(current)
          },
          reused: true
        });
        return;
      }

      const runInline = Boolean(requested && requested <= inlineSyncMaxParticipants);
      const finishedAt = requested ? '' : currentIsoTime();
      const syncJobResult = await createSyncJob({
        type: 'kda',
        source: 'manual',
        scope: 'kda',
        status: runInline ? 'running' : (requested ? 'queued' : 'completed'),
        targetWipeId: current.id,
        targetVitalWipeId: cleanText(current.vitalWipeId, 120),
        targetServerId: cleanText(current.vitalServerId, 80),
        targetServerName: expandServerName(current.serverName || current.name || ''),
        totalCount: requested,
        percent: requested ? 0 : 100,
        etaSeconds: requested ? estimatedSeconds : 0,
        finishedAt,
        createdBy: req.user.id,
        metadata: {
          runner: syncRunnerKey,
          requestedWipeId: current.id,
          targetVitalWipeId: cleanText(current.vitalWipeId, 120),
          statusKey: 'kda',
          createdByUsername: req.user.username || ''
        }
      }, activeSyncJobInput);
      const syncJob = syncJobResult.job;
      if (syncJobResult.reused) {
        const store = await readRuntimeStore({
          wipeIds: [current.id],
          includeKdaSnapshots: timeRange.requested,
          syncJobIds: [syncJob.id],
          scopeMembersToRows: true
        });
        const wipe = store.wipes.find((item) => item.id === current.id) || current;
        const rows = rowsForWipe(store, wipe, req.user, filters);
        sendOk(res, {
          ...counts,
          queued: true,
          job: publicJob((store.syncJobs || []).find((job) => job.id === syncJob.id) || syncJob),
          syncState: publicState(store.syncState?.kda || {}),
          wipe: publicWipe(store, wipe, req.user),
          rows,
          dataFreshness: {
            ...freshnessForRows(rows),
            ...publicKdaCapability(wipe)
          },
          reused: true
        });
        return;
      }
      await writeState('kda', {
        status: runInline ? 'running' : (requested ? 'queued' : 'complete'),
        source: 'manual',
        requested,
        imported: 0,
        ignored: 0,
        completed: 0,
        failed: 0,
        percent: syncPercent(0, requested),
        estimatedSeconds,
        etaSeconds: requested ? estimatedSeconds : 0,
        wipeId: current.id,
        wipeStatus: getEffectiveWipeStatus(current),
        ...kdaCapability,
        startedAt: runInline ? currentIsoTime() : '',
        syncedAt: requested ? '' : finishedAt,
        error: '',
        syncJobId: syncJob.id,
        syncJobType: 'kda',
        syncJobSource: 'manual',
        syncJobScope: 'kda'
      });
      await writeLog(req, 'kda_sync', `${runInline ? '同步' : '排队同步'} KDA ${current.name}`, {
        targetId: current.id,
        metadata: { requested }
      });
      if (runInline) {
        const resultCounts = await runSyncJob(syncJob);
        const store = await readRuntimeStore({
          wipeIds: [current.id],
          includeKdaSnapshots: timeRange.requested,
          syncJobIds: [syncJob.id],
          scopeMembersToRows: true
        });
        const wipe = store.wipes.find((item) => item.id === current.id) || current;
        const rows = rowsForWipe(store, wipe, req.user, filters);
        sendOk(res, {
          ...resultCounts,
          queued: false,
          job: publicJob((store.syncJobs || []).find((job) => job.id === syncJob.id) || syncJob),
          syncState: publicState(store.syncState?.kda || {}),
          wipe: publicWipe(store, wipe, req.user),
          rows,
          dataFreshness: {
            ...freshnessForRows(rows),
            ...publicKdaCapability(wipe)
          }
        });
        return;
      }
      if (requested) scheduleSyncJob({ force: true });
      const store = await readRuntimeStore({
        wipeIds: [current.id],
        includeKdaSnapshots: timeRange.requested,
        syncJobIds: [syncJob.id],
        scopeMembersToRows: true
      });
      const wipe = store.wipes.find((item) => item.id === current.id) || current;
      const rows = rowsForWipe(store, wipe, req.user, filters);
      sendOk(res, {
        ...counts,
        queued: Boolean(requested),
        job: publicJob((store.syncJobs || []).find((job) => job.id === syncJob.id) || syncJob),
        syncState: publicState(store.syncState?.kda || {}),
        wipe: publicWipe(store, wipe, req.user),
        rows,
        dataFreshness: {
          ...freshnessForRows(rows),
          ...publicKdaCapability(wipe)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/kda/import', ensureKdaEdit, async (req, res, next) => {
    try {
      let rows = [];
      try {
        rows = parseImportRows(req.body);
      } catch {
        sendFail(res, 400, 'KDA 导入数据格式错误');
        return;
      }
      if (!rows.length) {
        sendFail(res, 400, 'KDA 导入数据为空');
        return;
      }
      const requestedWipeId = cleanText(req.body?.wipeId, 120);
      const result = await updateWriteStore((store) => {
        const wipe = requestedWipeId
          ? store.wipes.find((item) => item.id === requestedWipeId)
          : getCurrentWipe(store);
        if (!wipe) throw Object.assign(new Error('档期不存在'), { status: 404 });
        ensureWipeMutable(wipe);
        const counts = upsertImportRows(store, wipe, rows);
        appendLog(store, req, 'kda_sync', `导入 KDA ${wipe.name}：${counts.imported} 条`, { targetId: wipe.id, metadata: counts });
        return counts;
      }, 'kda_manual_import', requestedWipeId ? { requestedWipeId } : { reference: 'current' });
      sendOk(res, result);
    } catch (error) {
      next(error);
    }
  });
}
