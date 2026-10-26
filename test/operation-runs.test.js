import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('operationRuns helper, readyz, wechat failure, and BM duplicate guard', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-operation-runs-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NODE_ENV: process.env.NODE_ENV
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NODE_ENV = 'production';

  let server = null;
  try {
    const apiModule = await import('../server/api.js');
    const authModule = await import('../server/auth.js');
    const integrationEventsModule = await import('../server/integration-events.js');
    const storeModule = await import('../server/store.js');
    await storeModule.ensureStore();

    const run = await apiModule.createOperationRun({
      type: 'discord_member_review_card_update',
      platform: 'discord',
      source: 'manual',
      status: 'running',
      targetType: 'member_application',
      targetId: 'application_operation_run_test',
      metadata: {
        safe: 'kept',
        botToken: 'must_not_be_persisted'
      }
    });
    assert.match(run.id, /^operation_run_/);
    await apiModule.updateOperationRun(run.id, {
      status: 'succeeded',
      messageId: 'discord_message_operation_run_test',
      metadata: { channelId: 'discord_channel_operation_run_test' }
    });
    const staleRun = await apiModule.createOperationRun({
      id: 'operation_run_stale_test',
      type: 'kook_pipe_push',
      platform: 'kook',
      source: 'auto',
      status: 'running',
      targetType: 'message',
      targetId: 'kook_pipe_stale_target',
      startedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z'
    });
    const staleResult = await apiModule.reconcileStaleOperationRuns();
    assert.equal(staleResult.updated >= 1, true);

    const now = new Date().toISOString();
    await storeModule.updateStore((store) => {
      store.wechatUsers.push({
        id: 'wechat_user_operation_run',
        openid: 'openid_should_not_be_persisted',
        status: 'approved',
        role: 'member',
        memberId: '',
        nickname: 'Operation WeChat',
        subscriptionPreferences: {
          wipeOpen: {
            status: 'accept',
            templateId: 'tmpl_operation_run',
            updatedAt: now
          }
        },
        createdAt: now,
        updatedAt: now
      });
    });
    const wechatResult = await apiModule.sendWechatSubscribeMessages('operation-run-wechat-failure', [{
      openid: 'openid_should_not_be_persisted',
      templateId: 'tmpl_operation_run',
      wechatUserId: 'wechat_user_operation_run',
      templateKey: 'wipeOpen',
      applicationId: 'application_wechat_operation_run'
    }], {
      sendOne: async () => {
        throw Object.assign(new Error('微信订阅消息发送失败：user refuse to accept the msg'), {
          errcode: 43101,
          errmsg: 'user refuse to accept the msg'
        });
      }
    });
    assert.deepEqual(wechatResult, { sent: 0, failed: 1 });
    const wechatTraceStore = await storeModule.readStore();
    const refusedWechatMessageRef = (wechatTraceStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'wechat' &&
      ref.kind === 'subscribe_message' &&
      ref.targetType === 'wechat_subscribe_message' &&
      ref.targetId === 'application_wechat_operation_run' &&
      ref.channelId === 'wechat_user_operation_run'
    ));
    assert.equal(Boolean(refusedWechatMessageRef), true);
    assert.equal(refusedWechatMessageRef.status, 'refused');
    assert.equal(refusedWechatMessageRef.source, 'wechat_subscribe_message_push');
    assert.equal(refusedWechatMessageRef.metadata.templateKey, 'wipeOpen');
    assert.equal(refusedWechatMessageRef.metadata.operationRunId.startsWith('operation_run_'), true);
    assert.equal(JSON.stringify(refusedWechatMessageRef).includes('openid_should_not_be_persisted'), false);

    const originalConsoleError = console.error;
    let redactionConsoleText = '';
    let redactionResult = null;
    try {
      console.error = (...args) => {
        redactionConsoleText += args.map((item) => String(item?.message || item)).join(' ');
      };
      redactionResult = await apiModule.sendWechatSubscribeMessages('operation-run-wechat-secret-redaction', [{
        openid: 'openid_secret_probe_should_not_persist',
        templateId: 'tmpl_operation_run',
        wechatUserId: 'wechat_user_operation_run',
        templateKey: 'wipeOpen',
        applicationId: 'application_wechat_secret_redaction'
      }], {
        sendOne: async () => {
          throw new Error('request to https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=wx_secret_probe&secret=SECRET_PROBE_SHOULD_NOT_PERSIST failed with access_token=TOKEN_PROBE_SHOULD_NOT_PERSIST openid=openid_secret_probe_should_not_persist');
        }
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.deepEqual(redactionResult, { sent: 0, failed: 1 });
    assert.equal(redactionConsoleText.includes('SECRET_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(redactionConsoleText.includes('TOKEN_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(redactionConsoleText.includes('openid_secret_probe_should_not_persist'), false);
    const redactionStore = await storeModule.readStore();
    const redactionRun = (redactionStore.operationRuns || []).find((item) => item.targetId === 'operation-run-wechat-secret-redaction');
    assert.equal(Boolean(redactionRun), true);
    assert.equal(redactionRun.status, 'failed');
    assert.equal(JSON.stringify(redactionRun).includes('SECRET_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(JSON.stringify(redactionRun).includes('TOKEN_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(JSON.stringify(redactionRun).includes('openid_secret_probe_should_not_persist'), false);
    const redactionRef = (redactionStore.integrationMessageRefs || []).find((ref) => (
      ref.platform === 'wechat' &&
      ref.targetId === 'application_wechat_secret_redaction'
    ));
    assert.equal(Boolean(redactionRef), true);
    assert.equal(redactionRef.status, 'failed');
    assert.equal(JSON.stringify(redactionRef).includes('SECRET_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(JSON.stringify(redactionRef).includes('TOKEN_PROBE_SHOULD_NOT_PERSIST'), false);
    assert.equal(JSON.stringify(redactionRef).includes('openid_secret_probe_should_not_persist'), false);

    const skippedResult = await apiModule.sendWechatSubscribeMessages('operation-run-wechat-skipped', [{
      openid: 'openid_skipped_should_not_persist',
      templateId: 'tmpl_operation_run',
      wechatUserId: 'wechat_user_operation_run',
      templateKey: 'wipeOpen',
      applicationId: 'application_wechat_skipped'
    }], {
      sendOne: async () => ({ ok: false, skipped: true })
    });
    assert.deepEqual(skippedResult, { sent: 0, failed: 0 });
    const skippedStore = await storeModule.readStore();
    const skippedRun = (skippedStore.operationRuns || []).find((item) => item.targetId === 'operation-run-wechat-skipped');
    assert.equal(Boolean(skippedRun), true);
    assert.equal(skippedRun.status, 'skipped');
    assert.equal(String(skippedRun.metadata?.skipped), '1');
    const skippedRef = (skippedStore.integrationMessageRefs || []).find((ref) => ref.targetId === 'application_wechat_skipped');
    assert.equal(Boolean(skippedRef), true);
    assert.equal(skippedRef.status, 'skipped');

    const integrationEvent = await integrationEventsModule.createIntegrationEvent({
      platform: 'discord',
      eventType: 'application_command',
      dedupeKey: 'discord:interaction:operation-run-test',
      sourceId: 'interaction_operation_run_test',
      status: 'processed',
      metadata: {
        commandName: 'ping',
        botToken: 'must_not_be_persisted'
      }
    }, { dedupe: true });
    const duplicateIntegrationEvent = await integrationEventsModule.createIntegrationEvent({
      platform: 'discord',
      eventType: 'application_command',
      dedupeKey: 'discord:interaction:operation-run-test',
      sourceId: 'interaction_operation_run_test',
      status: 'processed',
      metadata: {
        commandName: 'ping',
        authorization: 'must_not_be_persisted'
      }
    }, { dedupe: true });
    assert.equal(integrationEvent.duplicate, false);
    assert.equal(duplicateIntegrationEvent.duplicate, true);
    assert.equal(duplicateIntegrationEvent.event.status, 'duplicate');
    assert.equal(JSON.stringify(duplicateIntegrationEvent.event.metadata).includes('must_not_be_persisted'), false);
    const failedIntegrationEvent = await integrationEventsModule.createIntegrationEvent({
      platform: 'kook',
      eventType: 'message_button_click',
      dedupeKey: 'kook:event:operation-run-failed',
      sourceId: 'kook_operation_run_failed',
      status: 'failed',
      errorSummary: 'KOOK event dispatch failed',
      metadata: {
        reason: 'dispatch',
        signature: 'must_not_be_persisted'
      }
    });
    assert.equal(failedIntegrationEvent.event.status, 'failed');

    await storeModule.updateStore((store) => {
      store.settings.battlemetrics.apiKey = 'bm_api_key_operation_runs_1234567890';
      store.members.push({
        id: 'member_operation_run_bm',
        steamId: '76561198000008881',
        rawInput: '76561198000008881',
        customName: 'Operation BM',
        steamNickname: 'OperationBM',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        invitedByUserId: 'user_root',
        createdAt: now,
        updatedAt: now
      });
      store.wipes.push({
        id: 'wipe_operation_run_bm',
        name: 'Operation BM Wipe',
        status: 'active',
        serverName: 'Operation BM Server',
        startedAt: '2026-06-24T00:00:00.000Z',
        battlemetricsId: 'server_operation_run_bm',
        createdAt: now,
        updatedAt: now
      });
      store.wipeParticipants.push({
        id: 'participant_operation_run_bm',
        wipeId: 'wipe_operation_run_bm',
        memberId: 'member_operation_run_bm',
        status: 'on_time',
        source: 'test',
        createdAt: now,
        updatedAt: now
      });
      store.syncJobs.unshift({
        id: 'sync_job_operation_run_active_bm',
        type: 'battlemetrics_playtime',
        source: 'manual',
        scope: 'battlemetrics',
        status: 'running',
        targetWipeId: 'wipe_operation_run_bm',
        targetServerId: 'server_operation_run_bm',
        targetServerName: 'Operation BM Server',
        totalCount: 1,
        doneCount: 0,
        failedCount: 0,
        skippedCount: 0,
        percent: 0,
        etaSeconds: 30,
        startedAt: now,
        finishedAt: '',
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: now,
        updatedAt: now
      });
      store.syncJobs.push({
        id: 'sync_job_operation_run_active_bm_duplicate',
        type: 'battlemetrics_playtime',
        source: 'manual',
        scope: 'battlemetrics',
        status: 'queued',
        targetWipeId: 'wipe_operation_run_bm',
        targetServerId: 'server_operation_run_bm',
        targetServerName: 'Operation BM Server',
        totalCount: 1,
        doneCount: 0,
        failedCount: 0,
        skippedCount: 0,
        percent: 0,
        etaSeconds: 45,
        startedAt: now,
        finishedAt: '',
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: now,
        updatedAt: now
      });
      store.syncJobs.push({
        id: 'sync_job_operation_run_stale_bm_duplicate',
        type: 'battlemetrics_playtime',
        source: 'manual',
        scope: 'battlemetrics',
        status: 'running',
        targetWipeId: 'wipe_operation_run_bm',
        targetServerId: 'server_operation_run_bm',
        targetServerName: 'Operation BM Server',
        totalCount: 2,
        doneCount: 1,
        failedCount: 0,
        skippedCount: 0,
        percent: 50,
        etaSeconds: 120,
        startedAt: '2020-01-01T00:00:00.000Z',
        finishedAt: '',
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z'
      });
      store.syncState ||= {};
      store.syncState.battlemetricsStaleProbe = {
        status: 'running',
        source: 'manual',
        requested: 2,
        updated: 1,
        failed: 0,
        completed: 1,
        percent: 50,
        etaSeconds: 120,
        syncJobId: 'sync_job_operation_run_stale_bm_duplicate',
        updatedAt: '2020-01-01T00:00:00.000Z'
      };
    });
    const staleSyncResult = await apiModule.reconcileStaleSyncWork();
    assert.equal(staleSyncResult >= 1, true);
    const staleSyncStore = await storeModule.readStore();
    const staleSyncJob = staleSyncStore.syncJobs.find((job) => job.id === 'sync_job_operation_run_stale_bm_duplicate');
    assert.equal(staleSyncJob.status, 'failed');
    assert.equal(staleSyncJob.failedCount, 1);
    assert.match(staleSyncJob.errorSummary, /长时间未更新/);
    assert.equal(staleSyncStore.syncState.battlemetricsStaleProbe.status, 'failed');
    assert.equal(staleSyncStore.syncState.battlemetricsStaleProbe.failed, 1);

    const app = express();
    app.use(express.json());
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const rootSessionId = await authModule.createSession('user_root');
    const rootCookie = `nb_session=${encodeURIComponent(rootSessionId)}`;

    const operationRunsResponse = await fetch(`${baseUrl}/sync/operation-runs/recent`, {
      headers: { cookie: rootCookie }
    });
    const operationRunsPayload = await operationRunsResponse.json();
    assert.equal(operationRunsResponse.status, 200, JSON.stringify(operationRunsPayload));
    assert.equal(operationRunsPayload.ok, true);
    assert.equal(operationRunsPayload.recent.some((item) => item.id === run.id && item.status === 'succeeded'), true);
    const staleOperation = operationRunsPayload.failed.find((item) => item.id === staleRun.id);
    assert.equal(Boolean(staleOperation), true);
    assert.equal(staleOperation.status, 'failed');
    assert.match(staleOperation.errorSummary, /长时间未更新/);
    const failedWechatRun = operationRunsPayload.failed.find((item) => (
      item.type === 'wechat_subscribe_message_push' &&
      item.targetId === 'operation-run-wechat-failure'
    ));
    assert.equal(Boolean(failedWechatRun), true);
    assert.match(failedWechatRun.errorSummary, /微信订阅消息发送失败 1\/1/);
    assert.deepEqual(failedWechatRun.metadata.templateKeys, ['wipeOpen']);
    assert.equal(failedWechatRun.metadata.refusedPreferencesUpdated, '1');
    assert.equal(Array.isArray(failedWechatRun.metadata.messageRefIds), true);
    assert.equal(failedWechatRun.metadata.messageRefIds.includes(refusedWechatMessageRef.id), true);
    assert.equal(failedWechatRun.metadata.failedItems[0].templateKey, 'wipeOpen');
    assert.equal(failedWechatRun.metadata.failedItems[0].wechatUserId, 'wechat_user_operation_run');
    assert.equal(failedWechatRun.metadata.failedItems[0].messageRefId, refusedWechatMessageRef.id);
    assert.equal(JSON.stringify(failedWechatRun.metadata).includes('openid_should_not_be_persisted'), false);

    const readyzResponse = await fetch(`${baseUrl}/readyz?detail=full`);
    const readyzPayload = await readyzResponse.json();
    assert.equal(readyzResponse.status, 200, JSON.stringify(readyzPayload));
    assert.equal(typeof readyzPayload.api.slowThresholdMs, 'number');
    assert.equal(readyzPayload.api.total >= 1, true);
    assert.equal(Array.isArray(readyzPayload.api.routes), true);
    assert.equal(Array.isArray(readyzPayload.api.recentSlow), true);
    assert.equal(Array.isArray(readyzPayload.api.recent5xx), true);
    assert.equal(readyzPayload.api.routes.some((route) => route.method === 'GET' && route.route === '/api/sync/operation-runs/recent'), true);
    assert.equal(Array.isArray(readyzPayload.operations.activeJobs), true);
    assert.equal(readyzPayload.operations.activeJobs.some((job) => job.id === 'sync_job_operation_run_active_bm'), true);
    assert.equal(readyzPayload.operations.activeDuplicateJobs.duplicateJobCount, 1);
    assert.equal(readyzPayload.operations.activeDuplicateJobs.groups[0].jobIds.includes('sync_job_operation_run_active_bm'), true);
    assert.equal(readyzPayload.operations.activeDuplicateJobs.groups[0].jobIds.includes('sync_job_operation_run_active_bm_duplicate'), true);
    assert.equal(readyzPayload.operations.syncJobs.current.some((job) => job.id === 'sync_job_operation_run_active_bm'), true);
    assert.equal(readyzPayload.operations.syncJobs.byType.battlemetrics_playtime.current >= 1, true);
    assert.equal(readyzPayload.operations.syncJobs.byScope.battlemetrics.current >= 1, true);
    assert.equal(readyzPayload.operations.syncJobs.byStatus.running.current >= 1, true);
    assert.equal(readyzPayload.operations.syncJobs.failureRates.failed >= 1, true);
    assert.equal(readyzPayload.operations.syncJobs.queueDepth.current >= 1, true);
    assert.equal(readyzPayload.operations.syncJobs.duplicates.duplicateJobCount, 1);
    assert.equal(readyzPayload.operations.failureRates.syncJobs.failed >= 1, true);
    assert.equal(Array.isArray(readyzPayload.operations.failedOperations), true);
    assert.equal(readyzPayload.operations.operationRuns.byPlatform.discord.succeeded >= 1, true);
    assert.equal(readyzPayload.operations.operationRuns.byPlatform.kook.failed >= 1, true);
    assert.equal(readyzPayload.operations.operationRuns.byPlatform.wechat.failed >= 1, true);
    assert.equal(readyzPayload.operations.operationRuns.byPlatform.kook.failureRate > 0, true);
    assert.equal(readyzPayload.operations.operationRuns.failureRates.failed >= 2, true);
    assert.equal(readyzPayload.operations.operationRuns.failureRates.terminalFailureRate > 0, true);
    assert.equal(readyzPayload.operations.failureRates.operationRuns.failed >= 2, true);
    assert.equal(Array.isArray(readyzPayload.operations.failedIntegrationEvents), true);
    assert.equal(readyzPayload.operations.failedIntegrationEvents.some((item) => item.id === failedIntegrationEvent.event.id), true);
    assert.equal(readyzPayload.operations.integrationEvents.duplicates.some((item) => item.id === duplicateIntegrationEvent.event.id), true);
    assert.equal(readyzPayload.operations.integrationEvents.byPlatform.discord.duplicate >= 1, true);
    assert.equal(readyzPayload.operations.integrationEvents.byPlatform.kook.failed >= 1, true);
    assert.equal(readyzPayload.operations.integrationEvents.byPlatform.discord.duplicateRate > 0, true);
    assert.equal(readyzPayload.operations.integrationEvents.failureRates.failed >= 1, true);
    assert.equal(readyzPayload.operations.integrationEvents.failureRates.duplicate >= 1, true);
    assert.equal(readyzPayload.operations.failureRates.integrationEvents.duplicateRate > 0, true);
    assert.equal(['ok', 'warning', 'critical'].includes(readyzPayload.operations.summary.level), true);
    assert.equal(Array.isArray(readyzPayload.operations.summary.reasons), true);
    assert.equal(typeof readyzPayload.operations.summary.counts.queueDepth, 'number');
    assert.equal(typeof readyzPayload.operations.summary.rates.operationFailureRate, 'number');
    assert.equal(typeof readyzPayload.operations.providerHealth.openCount, 'number');
    assert.equal(Array.isArray(readyzPayload.operations.providerHealth.circuits), true);
    assert.equal(typeof readyzPayload.operations.providerHealth.battlemetrics.nextAvailableInSeconds, 'number');
    assert.equal(typeof readyzPayload.operations.queueDepth.total, 'number');
    assert.equal(readyzPayload.operations.queueDepth.syncJobs.current >= 1, true);
    assert.equal(typeof readyzPayload.operations.queueDepth.storePending, 'number');
    assert.equal(typeof readyzPayload.operations.queueDepth.storeRunning, 'number');
    assert.equal(typeof readyzPayload.operations.storage.queueDepth, 'number');
    assert.equal(typeof readyzPayload.operations.storage.queue.pending, 'number');
    assert.equal(typeof readyzPayload.operations.storage.queue.running, 'number');
    assert.equal(typeof readyzPayload.operations.storage.store.writes.total, 'number');
    assert.equal(typeof readyzPayload.operations.storage.store.clones.maxMs, 'number');
    assert.equal(Array.isArray(readyzPayload.operations.storage.store.topReads), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.store.topWrites), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.store.topClones), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.store.topReadCallers), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.store.topWriteCallers), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.store.topCloneCallers), true);
    assert.equal(['ok', 'warning', 'critical'].includes(readyzPayload.operations.storage.pressure.level), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.pressure.reasons), true);
    assert.equal(typeof readyzPayload.operations.storage.pressure.walSizeBytes, 'number');
    assert.equal(typeof readyzPayload.operations.storage.pressure.eventLoopP99Ms, 'number');
    assert.equal(typeof readyzPayload.operations.storage.pressure.queueDepth, 'number');
    assert.equal(typeof readyzPayload.operations.storage.sqlite.enabled, 'boolean');
    assert.equal(typeof readyzPayload.operations.storage.sqlite.prepares.total, 'number');
    assert.equal(Array.isArray(readyzPayload.operations.storage.sqlite.prepares.top), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.sqlite.slowQueries), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.sqlite.slowWrites), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.sqlite.topQueries), true);
    assert.equal(Array.isArray(readyzPayload.operations.storage.sqlite.topWrites), true);

    const duplicateResponse = await fetch(`${baseUrl}/sync/jobs/battlemetrics-playtime`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ wipeId: 'wipe_operation_run_bm' })
    });
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 200, JSON.stringify(duplicatePayload));
    assert.equal(duplicatePayload.reused, true);
    assert.equal(duplicatePayload.job.id, 'sync_job_operation_run_active_bm');

    const finalStore = await storeModule.readStore();
    const finalWechatUser = finalStore.wechatUsers.find((user) => user.id === 'wechat_user_operation_run');
    assert.equal(finalWechatUser.subscriptionPreferences.wipeOpen.status, 'unknown');
    assert.equal(finalStore.syncJobs.filter((job) => job.type === 'battlemetrics_playtime' && ['queued', 'running'].includes(job.status)).length, 2);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
