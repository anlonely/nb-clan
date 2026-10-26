import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('sqlite-primary Discord member review sync updates original and duplicate cards', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-review-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_MEMBER_PROFILE_QUEUE_DELAY_MS: process.env.NB_MEMBER_PROFILE_QUEUE_DELAY_MS,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_MEMBER_PROFILE_QUEUE_DELAY_MS = '1';
  delete process.env.NB_DISABLE_BACKGROUND_JOBS;

  let server = null;
  let discordServer = null;
  const discordEdits = [];
  const discordDeletes = [];
  const discordDirectMessages = [];
  const originalFetch = globalThis.fetch;
  let repositoryForDiscordMock = null;
  const discordKeys = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = discordKeys.publicKey.export({ type: 'spki', format: 'der' });
  const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');

  try {
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.patch('/channels/:channelId/messages/:messageId', (req, res) => {
      discordEdits.push({
        channelId: req.params.channelId,
        messageId: req.params.messageId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      if (req.params.messageId === 'sqlite_review_delete_run_failure' && repositoryForDiscordMock) {
        repositoryForDiscordMock.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
      }
      if (req.params.messageId === 'sqlite_review_edit_limited' || req.params.messageId === 'sqlite_review_delete_run_failure') {
        res.status(400).json({
          message: 'Maximum number of edits to messages older than 1 hour reached.'
        });
        return;
      }
      res.json({
        id: req.params.messageId,
        channel_id: req.params.channelId,
        ...req.body
      });
    });
    discordApp.delete('/channels/:channelId/messages/:messageId', (req, res) => {
      discordDeletes.push({
        channelId: req.params.channelId,
        messageId: req.params.messageId,
        authorization: req.get('authorization') || ''
      });
      res.status(204).end();
    });
    discordApp.post('/users/@me/channels', (req, res) => {
      res.json({
        id: `dm_${req.body?.recipient_id || 'unknown'}`,
        type: 1
      });
    });
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      if (req.params.channelId === 'dm_sqlite_feedback_fail_user') {
        res.status(400).json({ message: 'DM failed for test' });
        return;
      }
      const messageId = `discord_message_${discordDirectMessages.length + 1}`;
      discordDirectMessages.push({
        channelId: req.params.channelId,
        messageId,
        body: req.body
      });
      res.json({
        id: messageId,
        channel_id: req.params.channelId
      });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await import('../server/store.js');
    const authModule = await import('../server/auth.js');
    const apiModule = await import('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    repositoryForDiscordMock = repositoryModule;
    const reviewStoreModule = await import('../server/discord-member-review-store.js');
    await storeModule.ensureStore();

    const applicationId = 'discord_member_application_sqlite_review_sync';
    const createdAt = '2026-06-24T10:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        botToken: 'sqlite_discord_bot_token',
        memberReviewChannelId: 'sqlite_review_channel',
        publicKey: discordPublicKey
      };
      store.squads.unshift({
        id: 'squad_sqlite_discord_review',
        name: 'NB-EU',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: applicationId,
        discordUserId: 'sqlite_discord_user',
        discordUsername: 'SQLite Discord User',
        displayName: 'SQLite Discord User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000009999',
        steamInput: '76561198000009999',
        rawInput: '76561198000009999',
        steamNickname: 'SQLite Discord Steam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: 'sqlite_review_channel',
        adminReviewMessageId: 'sqlite_review_primary',
        adminReviewPushedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
      store.logs ||= [];
      store.logs.unshift({
        id: 'log_sqlite_discord_review_duplicate_card',
        type: 'discord_member_review_card_push',
        actorUserId: 'discord:sqlite_discord_user',
        actorUsername: 'SQLite Discord User',
        ip: 'test',
        steamId: '76561198000009999',
        targetId: applicationId,
        summary: 'Pushed duplicate Discord member registration approval card',
        metadata: {
          applicationId,
          channelId: 'sqlite_review_channel',
          messageId: 'sqlite_review_duplicate'
        },
        createdAt
      });
      store.integrationMessageRefs ||= [];
      store.integrationMessageRefs.unshift({
        id: `discord:member_review_card:${applicationId}:sqlite_review_channel:sqlite_review_ref_only`,
        platform: 'discord',
        kind: 'member_review_card',
        targetType: 'discord_member_application',
        targetId: applicationId,
        channelId: 'sqlite_review_channel',
        messageId: 'sqlite_review_ref_only',
        source: 'test_ref_only',
        status: 'active',
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
        updatedAt: createdAt,
        metadata: {}
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const rootSessionId = await authModule.createSession('user_root');
    const rootCookie = `nb_session=${encodeURIComponent(rootSessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const postDiscordInteraction = (body) => {
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), discordKeys.privateKey)
        .toString('hex');
      return fetch(`${baseUrl}/integrations/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp
        },
        body: rawBody
      });
    };
    const statusBeforeCardSyncLookup = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const fullMembersBeforeCardSyncLookup = queryCount(statusBeforeCardSyncLookup, 'list_members');
    const scopedSteamMembersBeforeCardSyncLookup = queryCount(statusBeforeCardSyncLookup, 'list_members_steamId');
    const scopedDiscordMembersBeforeCardSyncLookup = queryCount(statusBeforeCardSyncLookup, 'list_members_discordId');
    const reviewCardSyncStore = await reviewStoreModule.readDiscordMemberReviewCardSyncStore(applicationId);
    assert.equal(reviewCardSyncStore.discordMemberApplications[0]?.id, applicationId);
    const statusAfterCardSyncLookup = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterCardSyncLookup, 'list_members'), fullMembersBeforeCardSyncLookup);
    assert.equal(queryCount(statusAfterCardSyncLookup, 'list_members_steamId') > scopedSteamMembersBeforeCardSyncLookup, true);
    assert.equal(queryCount(statusAfterCardSyncLookup, 'list_members_discordId') > scopedDiscordMembersBeforeCardSyncLookup, true);

    const statusBeforeCardSyncFallback = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const readStoreFullBeforeCardSyncFallback = queryCount(statusBeforeCardSyncFallback, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('get_discordMemberApplications', 1);
    const partialCardSyncStore = await reviewStoreModule.readDiscordMemberReviewCardSyncStore(applicationId);
    const statusAfterCardSyncFallback = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(partialCardSyncStore.discordMemberReviewPartial, true);
    assert.equal(partialCardSyncStore.discordMemberApplications.length, 0);
    assert.equal(queryCount(statusAfterCardSyncFallback, 'read_store_full'), readStoreFullBeforeCardSyncFallback);

    const scopedRuntimeApplicationId = 'discord_member_application_sqlite_runtime_scope';
    const scopedRuntimeMemberId = 'member_sqlite_discord_runtime_scope';
    const scopedRuntimeWipeId = 'wipe_sqlite_discord_runtime_scope';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_runtime_scope_seed',
      upserts: {
        wipes: [{
          id: scopedRuntimeWipeId,
          name: 'SQLite Discord Runtime Scope',
          serverName: 'SQLite Discord Runtime Scope',
          status: 'active',
          battlemetricsId: '32032049',
          startedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }],
        members: [{
          id: scopedRuntimeMemberId,
          steamId: '76561198000009998',
          rawInput: '76561198000009998',
          customName: 'SQLite Runtime Scope Member',
          steamNickname: 'SQLiteRuntimeScopeSteam',
          avatar: '',
          discordId: 'sqlite_runtime_scope_user',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        }],
        memberProfiles: [{
          id: 'profile_sqlite_discord_runtime_scope',
          memberId: scopedRuntimeMemberId,
          steamId: '76561198000009998',
          battlemetricsWipeId: scopedRuntimeWipeId,
          battlemetricsServerId: '32032049',
          battlemetricsSyncedAt: createdAt,
          fetchedAt: createdAt,
          updatedAt: createdAt
        }],
        discordMemberApplications: [{
          id: scopedRuntimeApplicationId,
          discordUserId: 'sqlite_runtime_scope_user',
          discordUsername: 'SQLiteRuntimeScopeUser',
          displayName: 'SQLiteRuntimeScopeUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000009998',
          steamInput: '76561198000009998',
          rawInput: '76561198000009998',
          steamNickname: 'SQLiteRuntimeScopeSteam',
          steamAvatar: '',
          specialties: ['builder'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'pending',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: '',
          reviewedAt: '',
          memberId: scopedRuntimeMemberId,
          adminReviewChannelId: 'sqlite_review_channel',
          adminReviewMessageId: 'sqlite_runtime_scope_primary',
          adminReviewPushedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const statusBeforeApplicationRuntime = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const fullWipesBeforeApplicationRuntime = queryCount(statusBeforeApplicationRuntime, 'list_wipes');
    const scopedWipesByIdBeforeApplicationRuntime = queryCount(statusBeforeApplicationRuntime, 'list_wipes_id');
    const scopedWipesByBattlemetricsBeforeApplicationRuntime = queryCount(statusBeforeApplicationRuntime, 'list_wipes_battlemetricsId');
    const applicationRuntimeStore = await reviewStoreModule.readDiscordMemberApplicationRuntimeStore({
      applicationId: scopedRuntimeApplicationId
    });
    assert.equal(applicationRuntimeStore.wipes.some((wipe) => wipe.id === scopedRuntimeWipeId), true);
    const statusAfterApplicationRuntime = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterApplicationRuntime, 'list_wipes'), fullWipesBeforeApplicationRuntime);
    assert.equal(queryCount(statusAfterApplicationRuntime, 'list_wipes_id') > scopedWipesByIdBeforeApplicationRuntime, true);
    assert.equal(
      queryCount(statusAfterApplicationRuntime, 'list_wipes_battlemetricsId') > scopedWipesByBattlemetricsBeforeApplicationRuntime,
      true
    );

    const statusBeforeApplicationList = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const fullApplicationsBeforeApplicationList = queryCount(statusBeforeApplicationList, 'list_discordMemberApplications');
    const fullLogsBeforeApplicationList = queryCount(statusBeforeApplicationList, 'list_logs');
    const statusApplicationsBeforeApplicationList = queryCount(statusBeforeApplicationList, 'list_discordMemberApplications_status');
    const missingStatusApplicationsBeforeApplicationList = queryCount(statusBeforeApplicationList, 'list_discordMemberApplications_status_missing');
    const countStatusApplicationsBeforeApplicationList = queryCount(statusBeforeApplicationList, 'count_discordMemberApplications_status');
    const countMissingStatusApplicationsBeforeApplicationList = queryCount(statusBeforeApplicationList, 'count_discordMemberApplications_status_missing');
    const applicationListResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications?status=pending`, {
      headers: { cookie: rootCookie }
    });
    const applicationListPayload = await applicationListResponse.json();
    assert.equal(applicationListResponse.status, 200, JSON.stringify(applicationListPayload));
    assert.equal(applicationListPayload.applications.some((application) => application.id === applicationId), true);
    const statusAfterApplicationList = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterApplicationList, 'list_discordMemberApplications'), fullApplicationsBeforeApplicationList);
    assert.equal(queryCount(statusAfterApplicationList, 'list_logs'), fullLogsBeforeApplicationList);
    assert.equal(queryCount(statusAfterApplicationList, 'list_discordMemberApplications_status') > statusApplicationsBeforeApplicationList, true);
    assert.equal(queryCount(statusAfterApplicationList, 'list_discordMemberApplications_status_missing') > missingStatusApplicationsBeforeApplicationList, true);
    assert.equal(queryCount(statusAfterApplicationList, 'count_discordMemberApplications_status') > countStatusApplicationsBeforeApplicationList, true);
    assert.equal(queryCount(statusAfterApplicationList, 'count_discordMemberApplications_status_missing') > countMissingStatusApplicationsBeforeApplicationList, true);

    const autoBackfillApplicationId = 'discord_member_application_sqlite_auto_backfill';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_auto_backfill_seed',
      upserts: {
        discordMemberApplications: [{
          id: autoBackfillApplicationId,
          discordUserId: 'sqlite_auto_backfill_user',
          discordUsername: 'SQLiteAutoBackfillUser',
          displayName: 'SQLiteAutoBackfillUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007780',
          steamInput: '76561198000007780',
          rawInput: '76561198000007780',
          steamNickname: 'SQLiteAutoBackfillSteam',
          steamAvatar: '',
          specialties: ['farmer'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'approved',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: 'user_root',
          reviewedByName: 'root',
          reviewedAt: createdAt,
          memberId: '',
          adminReviewChannelId: '',
          adminReviewMessageId: '',
          adminReviewPushedAt: '',
          adminReviewSyncedAt: '',
          adminReviewSyncError: '',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const statusBeforeAutoBackfill = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const fullApplicationsBeforeAutoBackfill = queryCount(statusBeforeAutoBackfill, 'list_discordMemberApplications');
    const statusApplicationsBeforeAutoBackfill = queryCount(statusBeforeAutoBackfill, 'list_discordMemberApplications_status');
    const missingStatusApplicationsBeforeAutoBackfill = queryCount(statusBeforeAutoBackfill, 'list_discordMemberApplications_status_missing');
    const fullMembersBeforeAutoBackfill = queryCount(statusBeforeAutoBackfill, 'list_members');
    const scopedMembersBeforeAutoBackfill = queryCount(statusBeforeAutoBackfill, 'list_members_steamId');
    const autoBackfill = await apiModule.syncMissingDiscordMemberReviewCards({
      silent: false,
      force: true,
      limit: 10
    });
    assert.equal(autoBackfill.checked, 1);
    assert.equal(autoBackfill.pushed, 1);
    assert.equal(autoBackfill.failed, 0);
    const statusAfterAutoBackfill = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterAutoBackfill, 'list_discordMemberApplications'), fullApplicationsBeforeAutoBackfill);
    assert.equal(queryCount(statusAfterAutoBackfill, 'list_discordMemberApplications_status') > statusApplicationsBeforeAutoBackfill, true);
    assert.equal(queryCount(statusAfterAutoBackfill, 'list_discordMemberApplications_status_missing') > missingStatusApplicationsBeforeAutoBackfill, true);
    assert.equal(queryCount(statusAfterAutoBackfill, 'list_members'), fullMembersBeforeAutoBackfill);
    assert.equal(queryCount(statusAfterAutoBackfill, 'list_members_steamId') > scopedMembersBeforeAutoBackfill, true);
    const autoBackfillApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', autoBackfillApplicationId);
    assert.equal(Boolean(autoBackfillApplication.adminReviewMessageId), true);
    assert.equal(Boolean(autoBackfillApplication.adminReviewSyncedAt || autoBackfillApplication.adminReviewPushedAt), true);
    assert.equal(discordDirectMessages.some((message) => message.channelId === 'sqlite_review_channel'), true);
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;

    const operationRunFailureApplicationId = 'discord_member_application_sqlite_operation_run_failure';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_operation_run_failure_seed',
      upserts: {
        discordMemberApplications: [{
          id: operationRunFailureApplicationId,
          discordUserId: 'sqlite_operation_run_failure_user',
          discordUsername: 'SQLiteOperationRunFailureUser',
          displayName: 'SQLiteOperationRunFailureUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007782',
          steamInput: '76561198000007782',
          rawInput: '76561198000007782',
          steamNickname: 'SQLiteOperationRunFailureSteam',
          steamAvatar: '',
          specialties: ['builder'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'approved',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: 'user_root',
          reviewedByName: 'root',
          reviewedAt: createdAt,
          memberId: '',
          adminReviewChannelId: '',
          adminReviewMessageId: '',
          adminReviewPushedAt: '',
          adminReviewSyncedAt: '',
          adminReviewSyncError: '',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    const operationRunFailureBackfill = await apiModule.syncMissingDiscordMemberReviewCards({
      ids: [operationRunFailureApplicationId],
      silent: true,
      force: true
    });
    assert.equal(operationRunFailureBackfill.checked, 1);
    assert.equal(operationRunFailureBackfill.pushed, 0);
    assert.equal(operationRunFailureBackfill.failed, 1);
    assert.equal(discordEdits.length, 0);
    assert.equal(discordDeletes.length, 0);
    assert.equal(discordDirectMessages.length, 0);
    assert.equal(discordDirectMessages.some((message) => message.channelId === 'sqlite_review_channel'), false);
    const operationRunFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', operationRunFailureApplicationId);
    assert.equal(operationRunFailureApplication.adminReviewMessageId, '');
    assert.match(operationRunFailureApplication.adminReviewSyncError, /Discord 审核卡片操作记录/);
    const operationRunFailureRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', [operationRunFailureApplicationId], { limit: 0 });
    assert.equal(operationRunFailureRuns.some((run) => (
      run.status === 'failed' &&
      run.type === 'discord_member_review_card_failed' &&
      /Discord 审核卡片操作记录/.test(run.errorSummary || '')
    )), true);

    const autoReconcileApplicationId = 'discord_member_application_sqlite_auto_reconcile';
    const autoReconcileMemberId = 'member_sqlite_discord_auto_reconcile';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_auto_reconcile_seed',
      upserts: {
        members: [{
          id: autoReconcileMemberId,
          steamId: '76561198000007781',
          rawInput: '76561198000007781',
          customName: 'SQLite Auto Reconcile Member',
          steamNickname: 'SQLiteAutoReconcileSteam',
          avatar: '',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        }],
        discordMemberApplications: [{
          id: autoReconcileApplicationId,
          discordUserId: 'sqlite_auto_reconcile_user',
          discordUsername: 'SQLiteAutoReconcileUser',
          displayName: 'SQLiteAutoReconcileUser',
          discordAvatarHash: 'sqlite_auto_reconcile_avatar',
          discordAvatarUrl: '',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007781',
          steamInput: '76561198000007781',
          rawInput: '76561198000007781',
          steamNickname: 'SQLiteAutoReconcileSteam',
          steamAvatar: '',
          specialties: ['pvp'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'pending',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: '',
          reviewedAt: '',
          memberId: '',
          adminReviewChannelId: 'sqlite_review_channel',
          adminReviewMessageId: 'sqlite_auto_reconcile_primary',
          adminReviewPushedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const statusBeforeAutoReconcile = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const fullApplicationsBeforeAutoReconcile = queryCount(statusBeforeAutoReconcile, 'list_discordMemberApplications');
    const fullLogsBeforeAutoReconcile = queryCount(statusBeforeAutoReconcile, 'list_logs');
    const statusApplicationsBeforeAutoReconcile = queryCount(statusBeforeAutoReconcile, 'list_discordMemberApplications_status');
    const countStatusApplicationsBeforeAutoReconcile = queryCount(statusBeforeAutoReconcile, 'count_discordMemberApplications_status');
    const writesBeforeAutoReconcile = statusBeforeAutoReconcile.metrics.writes.total;
    const autoReconcileWriteBefore = writeCount(statusBeforeAutoReconcile, 'discord_member_application_auto_reconcile');
    const autoReconcileResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications?status=approved&q=SQLiteAutoReconcileUser`, {
      headers: { cookie: rootCookie }
    });
    const autoReconcilePayload = await autoReconcileResponse.json();
    assert.equal(autoReconcileResponse.status, 200, JSON.stringify(autoReconcilePayload));
    const autoReconciledApplication = autoReconcilePayload.applications.find((application) => application.id === autoReconcileApplicationId);
    assert.equal(autoReconciledApplication.status, 'approved');
    assert.equal(autoReconciledApplication.memberId, autoReconcileMemberId);
    const statusAfterAutoReconcile = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(statusAfterAutoReconcile.metrics.writes.total, writesBeforeAutoReconcile);
    assert.equal(queryCount(statusAfterAutoReconcile, 'list_discordMemberApplications'), fullApplicationsBeforeAutoReconcile);
    assert.equal(queryCount(statusAfterAutoReconcile, 'list_logs'), fullLogsBeforeAutoReconcile);
    assert.equal(queryCount(statusAfterAutoReconcile, 'list_discordMemberApplications_status') > statusApplicationsBeforeAutoReconcile, true);
    assert.equal(queryCount(statusAfterAutoReconcile, 'count_discordMemberApplications_status') > countStatusApplicationsBeforeAutoReconcile, true);
    assert.equal(writeCount(statusAfterAutoReconcile, 'discord_member_application_auto_reconcile'), autoReconcileWriteBefore + 1);
    const autoReconciledMember = await repositoryModule.getSqliteRecord('members', autoReconcileMemberId);
    const persistedAutoReconciledApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', autoReconcileApplicationId);
    const autoReconcileLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [autoReconcileApplicationId], { limit: 0 });
    assert.equal(autoReconciledMember.discordId, 'sqlite_auto_reconcile_user');
    assert.equal(persistedAutoReconciledApplication.status, 'approved');
    assert.equal(autoReconcileLogs.some((log) => log.type === 'discord_member_application_auto_approve'), true);

    const failedAutoReconcileApplicationId = 'discord_member_application_sqlite_auto_reconcile_failure';
    const failedAutoReconcileMemberId = 'member_sqlite_discord_auto_reconcile_failure';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_auto_reconcile_failure_seed',
      upserts: {
        members: [{
          id: failedAutoReconcileMemberId,
          steamId: '76561198000007783',
          rawInput: '76561198000007783',
          customName: 'SQLite Auto Reconcile Failure Member',
          steamNickname: 'SQLiteAutoReconcileFailureSteam',
          avatar: '',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        }],
        discordMemberApplications: [{
          id: failedAutoReconcileApplicationId,
          discordUserId: 'sqlite_auto_reconcile_failure_user',
          discordUsername: 'SQLiteAutoReconcileFailureUser',
          displayName: 'SQLiteAutoReconcileFailureUser',
          discordAvatarHash: 'sqlite_auto_reconcile_failure_avatar',
          discordAvatarUrl: '',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007783',
          steamInput: '76561198000007783',
          rawInput: '76561198000007783',
          steamNickname: 'SQLiteAutoReconcileFailureSteam',
          steamAvatar: '',
          specialties: ['pvp'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'pending',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: '',
          reviewedAt: '',
          memberId: '',
          adminReviewChannelId: 'sqlite_review_channel',
          adminReviewMessageId: 'sqlite_auto_reconcile_failure_primary',
          adminReviewPushedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const statusBeforeAutoReconcileFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const readStoreFullBeforeAutoReconcileFailure = queryCount(statusBeforeAutoReconcileFailure, 'read_store_full');
    const writesBeforeAutoReconcileFailure = statusBeforeAutoReconcileFailure.metrics.writes.total;
    const sqliteWritesBeforeAutoReconcileFailure = statusBeforeAutoReconcileFailure.metrics.sqliteWrites;
    const autoReconcileFailureWriteBefore = writeCount(statusBeforeAutoReconcileFailure, 'discord_member_application_auto_reconcile');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_application_auto_reconcile', 1);
    const failedAutoReconcileResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications?status=approved&q=SQLiteAutoReconcileFailureUser`, {
      headers: { cookie: rootCookie }
    });
    const failedAutoReconcilePayload = await failedAutoReconcileResponse.json();
    assert.equal(failedAutoReconcileResponse.status, 503, JSON.stringify(failedAutoReconcilePayload));
    assert.match(failedAutoReconcilePayload.error, /Discord 成员申请自动审核写入暂不可用/);
    const statusAfterAutoReconcileFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const failedAutoReconcileMember = await repositoryModule.getSqliteRecord('members', failedAutoReconcileMemberId);
    const failedAutoReconcileApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', failedAutoReconcileApplicationId);
    const failedAutoReconcileLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [failedAutoReconcileApplicationId], { limit: 0 });
    assert.equal(failedAutoReconcileMember.discordId, '');
    assert.equal(failedAutoReconcileApplication.status, 'pending');
    assert.equal(failedAutoReconcileApplication.memberId, '');
    assert.equal(failedAutoReconcileLogs.some((log) => log.type === 'discord_member_application_auto_approve'), false);
    assert.equal(statusAfterAutoReconcileFailure.metrics.writes.total, writesBeforeAutoReconcileFailure);
    assert.equal(statusAfterAutoReconcileFailure.metrics.sqliteWrites, sqliteWritesBeforeAutoReconcileFailure);
    assert.equal(writeCount(statusAfterAutoReconcileFailure, 'discord_member_application_auto_reconcile'), autoReconcileFailureWriteBefore);
    assert.equal(queryCount(statusAfterAutoReconcileFailure, 'read_store_full'), readStoreFullBeforeAutoReconcileFailure);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;

    const syncRouteApplicationId = 'discord_member_application_sqlite_sync_route';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_sync_route_seed',
      upserts: {
        discordMemberApplications: [{
          id: syncRouteApplicationId,
          discordUserId: 'sqlite_sync_route_user',
          discordUsername: 'SQLiteSyncRouteUser',
          displayName: 'SQLiteSyncRouteUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007782',
          steamInput: '76561198000007782',
          rawInput: '76561198000007782',
          steamNickname: 'SQLiteSyncRouteSteam',
          steamAvatar: '',
          specialties: ['builder'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'approved',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: 'user_root',
          reviewedByName: 'root',
          reviewedAt: createdAt,
          memberId: '',
          adminReviewChannelId: '',
          adminReviewMessageId: '',
          adminReviewPushedAt: '',
          adminReviewSyncedAt: '',
          adminReviewSyncError: '',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const statusBeforeSyncRoute = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const fullWipeParticipantsBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'list_wipeParticipants');
    const fullUploadsBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'list_uploads');
    const fullKdaRowsBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'list_kdaRows');
    const fullApplicationsBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'list_discordMemberApplications');
    const getApplicationsBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'get_discordMemberApplications');
    const fullMembersBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'list_members');
    const scopedMembersBeforeSyncRoute = queryCount(statusBeforeSyncRoute, 'list_members_steamId');
    const syncRouteResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/sync-review-cards`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ids: [syncRouteApplicationId] })
    });
    const syncRoutePayload = await syncRouteResponse.json();
    assert.equal(syncRouteResponse.status, 200, JSON.stringify(syncRoutePayload));
    assert.equal(syncRoutePayload.queued, 1);
    assert.equal(syncRoutePayload.backfillQueued, 1);
    const statusAfterSyncRoute = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterSyncRoute, 'list_wipeParticipants'), fullWipeParticipantsBeforeSyncRoute);
    assert.equal(queryCount(statusAfterSyncRoute, 'list_uploads'), fullUploadsBeforeSyncRoute);
    assert.equal(queryCount(statusAfterSyncRoute, 'list_kdaRows'), fullKdaRowsBeforeSyncRoute);
    assert.equal(queryCount(statusAfterSyncRoute, 'list_discordMemberApplications'), fullApplicationsBeforeSyncRoute);
    assert.equal(queryCount(statusAfterSyncRoute, 'get_discordMemberApplications') > getApplicationsBeforeSyncRoute, true);
    assert.equal(queryCount(statusAfterSyncRoute, 'list_members'), fullMembersBeforeSyncRoute);
    assert.equal(queryCount(statusAfterSyncRoute, 'list_members_steamId') > scopedMembersBeforeSyncRoute, true);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;

    const syncOperationRunFailureApplicationId = 'discord_member_application_sqlite_sync_operation_run_failure';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_sync_operation_run_failure_seed',
      upserts: {
        discordMemberApplications: [{
          id: syncOperationRunFailureApplicationId,
          discordUserId: 'sqlite_sync_operation_run_failure_user',
          discordUsername: 'SQLiteSyncOperationRunFailureUser',
          displayName: 'SQLiteSyncOperationRunFailureUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007784',
          steamInput: '76561198000007784',
          rawInput: '76561198000007784',
          steamNickname: 'SQLiteSyncOperationRunFailureSteam',
          steamAvatar: '',
          specialties: ['pvp'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'approved',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: 'user_root',
          reviewedByName: 'root',
          reviewedAt: createdAt,
          memberId: '',
          adminReviewChannelId: 'sqlite_review_channel',
          adminReviewMessageId: 'sqlite_review_sync_operation_run_failure',
          adminReviewPushedAt: createdAt,
          adminReviewSyncedAt: createdAt,
          adminReviewSyncError: '',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    const syncOperationRunFailureResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/sync-review-cards`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ids: [syncOperationRunFailureApplicationId] })
    });
    const syncOperationRunFailurePayload = await syncOperationRunFailureResponse.json();
    assert.equal(syncOperationRunFailureResponse.status, 200, JSON.stringify(syncOperationRunFailurePayload));
    assert.equal(syncOperationRunFailurePayload.queued, 1);
    assert.equal(syncOperationRunFailurePayload.backfillQueued, 0);
    assert.equal(syncOperationRunFailurePayload.syncQueued, 1);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    assert.equal(discordEdits.length, 0);
    assert.equal(discordDeletes.length, 0);
    assert.equal(discordDirectMessages.length, 0);
    assert.equal(discordDirectMessages.some((message) => message.channelId === 'sqlite_review_channel'), false);
    const syncOperationRunFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', syncOperationRunFailureApplicationId);
    assert.equal(syncOperationRunFailureApplication.adminReviewMessageId, 'sqlite_review_sync_operation_run_failure');
    assert.match(syncOperationRunFailureApplication.adminReviewSyncError, /Discord 审核卡片操作记录/);

    const statusBeforeReviewFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const readStoreFullBeforeReviewFailure = queryCount(statusBeforeReviewFailure, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_application_review', 1);
    const failedReviewResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${applicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'approved', adminNote: 'SQLite review patch failure.' })
    });
    const failedReviewPayload = await failedReviewResponse.json();
    assert.equal(failedReviewResponse.status, 503, JSON.stringify(failedReviewPayload));
    assert.equal(failedReviewPayload.ok, false);
    assert.match(failedReviewPayload.error, /Discord 成员审核写入暂不可用/);
    const failedReviewApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', applicationId);
    const statusAfterReviewFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(failedReviewApplication.status, 'pending');
    assert.equal(queryCount(statusAfterReviewFailure, 'read_store_full'), readStoreFullBeforeReviewFailure);

    const reviewOperationRunFailureApplicationId = 'discord_member_application_sqlite_review_operation_run_failure';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_review_operation_run_failure_seed',
      upserts: {
        discordMemberApplications: [{
          id: reviewOperationRunFailureApplicationId,
          discordUserId: 'sqlite_review_operation_run_failure_user',
          discordUsername: 'SQLiteReviewOperationRunFailureUser',
          displayName: 'SQLiteReviewOperationRunFailureUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007783',
          steamInput: '76561198000007783',
          rawInput: '76561198000007783',
          steamNickname: 'SQLiteReviewOperationRunFailureSteam',
          steamAvatar: '',
          specialties: ['farmer'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'pending',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: '',
          reviewedAt: '',
          memberId: '',
          adminReviewChannelId: 'sqlite_review_channel',
          adminReviewMessageId: 'sqlite_review_operation_run_failure',
          adminReviewPushedAt: createdAt,
          adminReviewSyncedAt: '',
          adminReviewSyncError: '',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 10);
    const reviewOperationRunFailureResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${reviewOperationRunFailureApplicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'rejected', adminNote: 'SQLite operation run failure.' })
    });
    const reviewOperationRunFailurePayload = await reviewOperationRunFailureResponse.json();
    assert.equal(reviewOperationRunFailureResponse.status, 200, JSON.stringify(reviewOperationRunFailurePayload));
    assert.equal(reviewOperationRunFailurePayload.ok, true);
    assert.equal(reviewOperationRunFailurePayload.application.status, 'rejected');
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 0);
    assert.equal(discordDirectMessages.length, 0);
    assert.equal(discordDirectMessages.some((message) => message.channelId === 'sqlite_review_channel'), false);
    const reviewOperationRunFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', reviewOperationRunFailureApplicationId);
    assert.equal(reviewOperationRunFailureApplication.status, 'rejected');
    assert.equal(reviewOperationRunFailureApplication.adminReviewMessageId, 'sqlite_review_operation_run_failure');
    assert.match(reviewOperationRunFailureApplication.adminReviewSyncError, /Discord 审核卡片操作记录/);

    const statusBeforeReview = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const writesBeforeReview = statusBeforeReview.metrics.writes.total;
    const beforeDiscordReviewWrite = writeCount(statusBeforeReview, 'discord_member_application_review');
    const beforeReviewSyncResultWrite = writeCount(statusBeforeReview, 'discord_member_review_card_sync_result');
    const beforeReviewSyncResultLogTrimWrite = writeCount(statusBeforeReview, 'discord_member_review_card_sync_result_log_trim');
    const beforeReviewListSquads = queryCount(statusBeforeReview, 'list_squads');
    const beforeReviewSquadsById = queryCount(statusBeforeReview, 'list_squads_id');

    const reviewResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${applicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'approved', adminNote: 'SQLite review approved.' })
    });
    const reviewPayload = await reviewResponse.json();
    assert.equal(reviewResponse.status, 200, JSON.stringify(reviewPayload));
    assert.equal(reviewPayload.ok, true);
    assert.equal(reviewPayload.application.status, 'approved');

    let application = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (discordEdits.length >= 2) {
        application = await repositoryModule.getSqliteRecord('discordMemberApplications', applicationId);
        if (application?.adminReviewSyncedAt) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    assert.deepEqual(
      discordEdits.map((edit) => edit.messageId).sort(),
      ['sqlite_review_duplicate', 'sqlite_review_primary', 'sqlite_review_ref_only']
    );
    for (const edit of discordEdits) {
      assert.equal(edit.authorization, 'Bot sqlite_discord_bot_token');
      assert.equal(edit.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
      assert.equal(edit.body.components.length, 2);
    }

    application ||= await repositoryModule.getSqliteRecord('discordMemberApplications', applicationId);
    assert.equal(application.status, 'approved');
    assert.equal(Boolean(application.adminReviewSyncedAt), true);
    assert.equal(application.adminReviewSyncError, '');
    const feedbackMessage = discordDirectMessages.find((message) => message.channelId === 'dm_sqlite_discord_user');
    assert.equal(Boolean(feedbackMessage), true);
    assert.equal(application.feedbackMessageId, feedbackMessage.messageId);
    assert.equal(Boolean(application.feedbackSentAt), true);
    const logs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [applicationId], { limit: 0 });
    const feedbackLog = logs.find((log) => log.type === 'discord_member_application_feedback');
    assert.equal(Boolean(feedbackLog), true);
    assert.equal(feedbackLog.metadata.messageId, feedbackMessage.messageId);
    assert.equal(feedbackLog.metadata.operationRunId.startsWith('operation_run_'), true);
    const feedbackRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', [applicationId], { limit: 0 });
    const feedbackRun = feedbackRuns.find((run) => run.type === 'discord_member_application_feedback');
    assert.equal(Boolean(feedbackRun), true);
    assert.equal(feedbackRun.status, 'succeeded');
    assert.equal(feedbackRun.source, 'manual');
    assert.equal(feedbackRun.messageId, feedbackMessage.messageId);
    assert.equal(feedbackRun.channelId, 'dm_sqlite_discord_user');
    assert.equal(feedbackRun.metadata.externalActionSucceeded, undefined);
    assert.equal(feedbackRun.metadata.trackingWriteFailed, undefined);
    const updateLog = logs.find((log) => log.type === 'discord_member_review_card_update');
    assert.equal(Boolean(updateLog), true);
    assert.equal(updateLog.metadata.updatedMessages.some((message) => message.messageId === 'sqlite_review_duplicate'), true);
    const statusAfterFeedback = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(statusAfterFeedback.metrics.writes.total, writesBeforeReview);
    assert.equal(writeCount(statusAfterFeedback, 'discord_member_application_review'), beforeDiscordReviewWrite + 1);
    assert.equal(writeCount(statusAfterFeedback, 'discord_member_review_card_sync_result'), beforeReviewSyncResultWrite + 1);
    assert.equal(writeCount(statusAfterFeedback, 'discord_member_review_card_sync_result_log_trim'), beforeReviewSyncResultLogTrimWrite);
    assert.equal(queryCount(statusAfterFeedback, 'list_squads'), beforeReviewListSquads);
    assert.equal(queryCount(statusAfterFeedback, 'list_squads_id') > beforeReviewSquadsById, true);
    const messageRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [applicationId], { limit: 0 });
    const activeMessageIds = messageRefs
      .filter((ref) => ref.status === 'active')
      .map((ref) => ref.messageId)
      .sort();
    assert.deepEqual(activeMessageIds, ['sqlite_review_duplicate', 'sqlite_review_primary', 'sqlite_review_ref_only']);

    const writesBeforeLanguageSwitch = (await storeModule.storeRuntimeStatus({ sqliteSummary: false })).metrics.writes.total;
    const editCountBeforeLanguageSwitch = discordEdits.length;
    const languageResponse = await postDiscordInteraction({
      type: 3,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_language_interaction_token',
      locale: 'zh-CN',
      member: {
        permissions: '8',
        user: { id: 'sqlite_language_admin', username: 'SQLite Language Admin' }
      },
      message: {
        id: 'sqlite_review_primary',
        channel_id: 'sqlite_review_channel'
      },
      data: { custom_id: `nb_member_review:language:${applicationId}:auto` }
    });
    const languagePayload = await languageResponse.json();
    assert.equal(languageResponse.status, 200, JSON.stringify(languagePayload));
    assert.equal(languagePayload.type, 7);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const languageApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', applicationId);
    assert.equal(languageApplication.adminReviewLanguage, 'zh');
    assert.equal(Boolean(languageApplication.adminReviewLanguageUpdatedAt), true);
    assert.equal(discordEdits.length > editCountBeforeLanguageSwitch, true);
    const writesAfterLanguageSwitch = (await storeModule.storeRuntimeStatus({ sqliteSummary: false })).metrics.writes.total;
    assert.equal(writesAfterLanguageSwitch, writesBeforeLanguageSwitch);

    const interactionReviewApplicationId = 'discord_member_application_sqlite_interaction_review';
    const interactionReviewMemberId = 'member_sqlite_interaction_review';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_interaction_review_seed',
      upserts: {
        members: [{
          id: interactionReviewMemberId,
          steamId: '76561198000007785',
          rawInput: '76561198000007785',
          customName: 'SQLite Interaction Review Member',
          steamNickname: 'SQLiteInteractionSteam',
          avatar: '',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        }],
        discordMemberApplications: [{
          id: interactionReviewApplicationId,
          discordUserId: 'sqlite_interaction_review_user',
          discordUsername: 'SQLiteInteractionReviewUser',
          displayName: 'SQLiteInteractionReviewUser',
          discordLanguage: 'en',
          adminReviewLanguage: 'en',
          steamId: '76561198000007785',
          steamInput: '76561198000007785',
          rawInput: '76561198000007785',
          steamNickname: 'SQLiteInteractionSteam',
          steamAvatar: '',
          specialties: ['farmer'],
          squadId: 'squad_sqlite_discord_review',
          squadName: 'NB-EU',
          status: 'pending',
          adminNote: '',
          reviewNote: '',
          reviewedByUserId: '',
          reviewedAt: '',
          memberId: '',
          adminReviewChannelId: 'sqlite_review_channel',
          adminReviewMessageId: 'sqlite_interaction_review_primary',
          adminReviewPushedAt: createdAt,
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const statusBeforeInteractionReview = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const writesBeforeInteractionReview = statusBeforeInteractionReview.metrics.writes.total;
    const interactionReviewWriteBefore = writeCount(statusBeforeInteractionReview, 'discord_member_application_review');
    const interactionReviewResponse = await postDiscordInteraction({
      type: 3,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_interaction_review_token',
      locale: 'en-US',
      member: {
        permissions: '8',
        user: { id: 'sqlite_interaction_admin', username: 'SQLite Interaction Admin' }
      },
      message: {
        id: 'sqlite_interaction_review_primary',
        channel_id: 'sqlite_review_channel'
      },
      data: { custom_id: `nb_member_review:approved:${interactionReviewApplicationId}` }
    });
    const interactionReviewPayload = await interactionReviewResponse.json();
    assert.equal(interactionReviewResponse.status, 200, JSON.stringify(interactionReviewPayload));
    assert.equal(interactionReviewPayload.type, 7);
    assert.equal(interactionReviewPayload.data.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const statusAfterInteractionReview = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(statusAfterInteractionReview.metrics.writes.total, writesBeforeInteractionReview);
    assert.equal(writeCount(statusAfterInteractionReview, 'discord_member_application_review'), interactionReviewWriteBefore + 1);
    const interactionReviewMember = await repositoryModule.getSqliteRecord('members', interactionReviewMemberId);
    const interactionReviewApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', interactionReviewApplicationId);
    assert.equal(interactionReviewMember.discordId, 'sqlite_interaction_review_user');
    assert.equal(interactionReviewApplication.status, 'approved');
    assert.equal(interactionReviewApplication.memberId, interactionReviewMemberId);
    const statusBeforeRepeatInteractionReview = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const repeatInteractionReviewWriteBefore = writeCount(statusBeforeRepeatInteractionReview, 'discord_member_application_review');
    const repeatInteractionReviewResponse = await postDiscordInteraction({
      type: 3,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_interaction_review_repeat_token',
      locale: 'en-US',
      member: {
        permissions: '8',
        user: { id: 'sqlite_interaction_admin', username: 'SQLite Interaction Admin' }
      },
      message: {
        id: 'sqlite_interaction_review_primary',
        channel_id: 'sqlite_review_channel'
      },
      data: { custom_id: `nb_member_review:approved:${interactionReviewApplicationId}` }
    });
    const repeatInteractionReviewPayload = await repeatInteractionReviewResponse.json();
    assert.equal(repeatInteractionReviewResponse.status, 200, JSON.stringify(repeatInteractionReviewPayload));
    assert.equal(repeatInteractionReviewPayload.type, 7);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const statusAfterRepeatInteractionReview = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(statusAfterRepeatInteractionReview.metrics.writes.total, statusBeforeRepeatInteractionReview.metrics.writes.total);
    assert.equal(writeCount(statusAfterRepeatInteractionReview, 'discord_member_application_review'), repeatInteractionReviewWriteBefore);

    const interactionReviewFailureApplicationId = 'discord_member_application_sqlite_interaction_review_failure';
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: interactionReviewFailureApplicationId,
        discordUserId: 'sqlite_interaction_review_failure_user',
        discordUsername: 'SQLiteInteractionReviewFailureUser',
        displayName: 'SQLiteInteractionReviewFailureUser',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007784',
        steamInput: '76561198000007784',
        rawInput: '76561198000007784',
        steamNickname: 'SQLiteInteractionFailureSteam',
        steamAvatar: '',
        specialties: ['farmer'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: 'sqlite_review_channel',
        adminReviewMessageId: 'sqlite_interaction_review_failure',
        adminReviewPushedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
    });
    const statusBeforeInteractionReviewFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const writesBeforeInteractionReviewFailure = statusBeforeInteractionReviewFailure.metrics.writes.total;
    const readStoreFullBeforeInteractionReviewFailure = queryCount(statusBeforeInteractionReviewFailure, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_application_review', 1);
    const interactionReviewFailureResponse = await postDiscordInteraction({
      type: 3,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_interaction_review_failure_token',
      locale: 'en-US',
      member: {
        permissions: '8',
        user: { id: 'sqlite_interaction_admin', username: 'SQLite Interaction Admin' }
      },
      message: {
        id: 'sqlite_interaction_review_failure',
        channel_id: 'sqlite_review_channel'
      },
      data: { custom_id: `nb_member_review:rejected:${interactionReviewFailureApplicationId}` }
    });
    const interactionReviewFailurePayload = await interactionReviewFailureResponse.json();
    assert.equal(interactionReviewFailureResponse.status, 200, JSON.stringify(interactionReviewFailurePayload));
    assert.equal(interactionReviewFailurePayload.type, 4);
    assert.match(interactionReviewFailurePayload.data.content, /Discord 成员审核写入暂不可用/);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const interactionReviewFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', interactionReviewFailureApplicationId);
    const statusAfterInteractionReviewFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(interactionReviewFailureApplication.status, 'pending');
    assert.equal(interactionReviewFailureApplication.reviewedAt, '');
    assert.equal(statusAfterInteractionReviewFailure.metrics.writes.total, writesBeforeInteractionReviewFailure);
    assert.equal(queryCount(statusAfterInteractionReviewFailure, 'read_store_full'), readStoreFullBeforeInteractionReviewFailure);
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;

    const feedbackFailureApplicationId = 'discord_member_application_sqlite_feedback_failure';
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: feedbackFailureApplicationId,
        discordUserId: 'sqlite_feedback_fail_user',
        discordUsername: 'SQLite Feedback Failure User',
        displayName: 'SQLite Feedback Failure User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000005555',
        steamInput: '76561198000005555',
        rawInput: '76561198000005555',
        steamNickname: 'SQLite Feedback Failure Steam',
        steamAvatar: '',
        specialties: ['builder'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: 'sqlite_review_channel',
        adminReviewMessageId: 'sqlite_feedback_fail_review',
        adminReviewPushedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
    });
    const statusBeforeFeedbackFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const writesBeforeFeedbackFailure = statusBeforeFeedbackFailure.metrics.writes.total;
    const reviewWriteBeforeFeedbackFailure = writeCount(statusBeforeFeedbackFailure, 'discord_member_application_review');
    const feedbackFailureReviewResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${feedbackFailureApplicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'rejected', adminNote: 'Feedback failure path.' })
    });
    const feedbackFailureReviewPayload = await feedbackFailureReviewResponse.json();
    assert.equal(feedbackFailureReviewResponse.status, 200, JSON.stringify(feedbackFailureReviewPayload));
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const feedbackFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', feedbackFailureApplicationId);
    assert.equal(feedbackFailureApplication.status, 'rejected');
    assert.equal(Boolean(feedbackFailureApplication.feedbackError), true);
    const feedbackFailureLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [feedbackFailureApplicationId], { limit: 0 });
    const feedbackFailureLog = feedbackFailureLogs.find((log) => log.type === 'discord_member_application_feedback_failed');
    assert.equal(Boolean(feedbackFailureLog), true);
    assert.equal(feedbackFailureLog.metadata.operationRunId.startsWith('operation_run_'), true);
    const feedbackFailureRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', [feedbackFailureApplicationId], { limit: 0 });
    const feedbackFailureRun = feedbackFailureRuns.find((run) => run.type === 'discord_member_application_feedback');
    assert.equal(Boolean(feedbackFailureRun), true);
    assert.equal(feedbackFailureRun.status, 'failed');
    assert.equal(feedbackFailureRun.metadata.externalActionSucceeded, 'false');
    assert.equal(feedbackFailureRun.metadata.trackingWriteFailed, 'false');
    const statusAfterFeedbackFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(statusAfterFeedbackFailure.metrics.writes.total, writesBeforeFeedbackFailure);
    assert.equal(writeCount(statusAfterFeedbackFailure, 'discord_member_application_review'), reviewWriteBeforeFeedbackFailure + 1);

    const feedbackTrackingFailureApplicationId = 'discord_member_application_sqlite_feedback_tracking_failure';
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: feedbackTrackingFailureApplicationId,
        discordUserId: 'sqlite_feedback_tracking_fail_user',
        discordUsername: 'SQLite Feedback Tracking Failure User',
        displayName: 'SQLite Feedback Tracking Failure User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000005556',
        steamInput: '76561198000005556',
        rawInput: '76561198000005556',
        steamNickname: 'SQLite Feedback Tracking Failure Steam',
        steamAvatar: '',
        specialties: ['builder'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: 'sqlite_review_channel',
        adminReviewMessageId: 'sqlite_feedback_tracking_fail_review',
        adminReviewPushedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
    });
    const feedbackTrackingFailureDmCount = discordDirectMessages.length;
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_application_feedback', 1);
    const feedbackTrackingFailureReviewResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${feedbackTrackingFailureApplicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'approved', adminNote: 'Feedback tracking failure path.' })
    });
    const feedbackTrackingFailureReviewPayload = await feedbackTrackingFailureReviewResponse.json();
    assert.equal(feedbackTrackingFailureReviewResponse.status, 200, JSON.stringify(feedbackTrackingFailureReviewPayload));
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const feedbackTrackingFailureMessages = discordDirectMessages
      .slice(feedbackTrackingFailureDmCount)
      .filter((message) => message.channelId.startsWith('dm_sqlite_feedback_tracking_fail'));
    assert.equal(feedbackTrackingFailureMessages.length, 1);
    const feedbackTrackingFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', feedbackTrackingFailureApplicationId);
    assert.equal(feedbackTrackingFailureApplication.status, 'approved');
    assert.equal(feedbackTrackingFailureApplication.feedbackMessageId || '', '');
    assert.equal(feedbackTrackingFailureApplication.feedbackSentAt || '', '');
    assert.equal(feedbackTrackingFailureApplication.feedbackError || '', '');
    const feedbackTrackingFailureLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [feedbackTrackingFailureApplicationId], { limit: 0 });
    assert.equal(feedbackTrackingFailureLogs.some((log) => log.type === 'discord_member_application_feedback'), false);
    assert.equal(feedbackTrackingFailureLogs.some((log) => log.type === 'discord_member_application_feedback_failed'), false);
    const feedbackTrackingFailureRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', [feedbackTrackingFailureApplicationId], { limit: 0 });
    const feedbackTrackingFailureRun = feedbackTrackingFailureRuns.find((run) => run.type === 'discord_member_application_feedback');
    assert.equal(Boolean(feedbackTrackingFailureRun), true);
    assert.equal(feedbackTrackingFailureRun.status, 'failed');
    assert.equal(feedbackTrackingFailureRun.messageId, feedbackTrackingFailureMessages[0].messageId);
    assert.equal(feedbackTrackingFailureRun.channelId, feedbackTrackingFailureMessages[0].channelId);
    assert.equal(feedbackTrackingFailureRun.metadata.externalActionSucceeded, 'true');
    assert.equal(feedbackTrackingFailureRun.metadata.trackingWriteFailed, 'true');
    assert.match(feedbackTrackingFailureRun.errorSummary, /Injected sqlite patch failure/);

    const reviewedDriftApplicationId = 'discord_member_application_sqlite_review_channel_drift';
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: reviewedDriftApplicationId,
        discordUserId: 'sqlite_discord_user_channel_drift',
        discordUsername: 'SQLite Channel Drift User',
        displayName: 'SQLite Channel Drift User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000007777',
        steamInput: '76561198000007777',
        rawInput: '76561198000007777',
        steamNickname: 'SQLite Drift Steam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'rejected',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: 'user_root',
        reviewedAt: createdAt,
        memberId: '',
        adminReviewChannelId: 'sqlite_old_review_channel',
        adminReviewMessageId: 'sqlite_old_review_message',
        adminReviewPushedAt: createdAt,
        adminReviewSyncedAt: createdAt,
        adminReviewSyncError: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const editCountBeforeDriftBackfill = discordEdits.length;
    const postCountBeforeDriftBackfill = discordDirectMessages.length;
    const driftBackfill = await apiModule.syncMissingDiscordMemberReviewCards({
      ids: [reviewedDriftApplicationId],
      silent: false,
      force: true
    });
    assert.equal(driftBackfill.checked, 0);
    assert.equal(driftBackfill.pushed, 0);
    assert.equal(driftBackfill.skipped, true);
    assert.equal(discordEdits.length, editCountBeforeDriftBackfill);
    assert.equal(discordDirectMessages.length, postCountBeforeDriftBackfill);

    const directBackfillApplicationId = 'discord_member_application_sqlite_review_direct_patch';
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: directBackfillApplicationId,
        discordUserId: 'sqlite_discord_user_direct_patch',
        discordUsername: 'SQLite Direct Patch User',
        displayName: 'SQLite Direct Patch User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000006666',
        steamInput: '76561198000006666',
        rawInput: '76561198000006666',
        steamNickname: 'SQLite Direct Patch Steam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'approved',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: 'user_root',
        reviewedAt: createdAt,
        memberId: '',
        adminReviewChannelId: '',
        adminReviewMessageId: '',
        adminReviewPushedAt: '',
        adminReviewSyncedAt: '',
        adminReviewSyncError: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const statusBeforeDirectBackfill = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const writesBeforeDirectBackfill = statusBeforeDirectBackfill.metrics.writes.total;
    const fullMessageRefsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_integrationMessageRefs');
    const scopedMessageRefsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_integrationMessageRefs_targetId');
    const fullOperationRunsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_operationRuns');
    const scopedOperationRunsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_operationRuns_targetId');
    const fullLogsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_logs');
    const scopedLogsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_logs_targetId');
    const fullApplicationsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_discordMemberApplications');
    const getApplicationsBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'get_discordMemberApplications');
    const fullMembersBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_members');
    const scopedMembersBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_members_steamId');
    const fullMemberProfilesBeforeDirectBackfill = queryCount(statusBeforeDirectBackfill, 'list_memberProfiles');
    const directBackfill = await apiModule.syncMissingDiscordMemberReviewCards({
      ids: [directBackfillApplicationId],
      silent: false,
      force: true
    });
    assert.equal(directBackfill.checked, 1);
    assert.equal(directBackfill.pushed, 1);
    assert.equal(directBackfill.failed, 0);
    const statusAfterDirectBackfill = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_integrationMessageRefs'), fullMessageRefsBeforeDirectBackfill);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_integrationMessageRefs_targetId') > scopedMessageRefsBeforeDirectBackfill, true);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_operationRuns'), fullOperationRunsBeforeDirectBackfill);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_operationRuns_targetId') > scopedOperationRunsBeforeDirectBackfill, true);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_logs'), fullLogsBeforeDirectBackfill);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_logs_targetId') > scopedLogsBeforeDirectBackfill, true);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_discordMemberApplications'), fullApplicationsBeforeDirectBackfill);
    assert.equal(queryCount(statusAfterDirectBackfill, 'get_discordMemberApplications') > getApplicationsBeforeDirectBackfill, true);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_members'), fullMembersBeforeDirectBackfill);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_members_steamId') > scopedMembersBeforeDirectBackfill, true);
    assert.equal(queryCount(statusAfterDirectBackfill, 'list_memberProfiles'), fullMemberProfilesBeforeDirectBackfill);
    const directBackfillMessage = discordDirectMessages.find((message) => message.channelId === 'sqlite_review_channel');
    assert.equal(Boolean(directBackfillMessage), true);
    const directBackfillApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', directBackfillApplicationId);
    assert.equal(directBackfillApplication.adminReviewMessageId, directBackfillMessage.messageId);
    assert.equal(Boolean(directBackfillApplication.adminReviewSyncedAt || directBackfillApplication.adminReviewPushedAt), true);
    const directBackfillRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [directBackfillApplicationId], { limit: 0 });
    assert.equal(directBackfillRefs.some((ref) => ref.messageId === directBackfillMessage.messageId && ref.status === 'active'), true);
	    const writesAfterDirectBackfill = (await storeModule.storeRuntimeStatus()).metrics.writes.total;
	    assert.equal(writesAfterDirectBackfill, writesBeforeDirectBackfill);

	    const persistenceFailureApplicationId = 'discord_member_application_sqlite_review_result_persist_failure';
	    discordDirectMessages.length = 0;
	    await storeModule.updateStore((store) => {
	      store.discordMemberApplications ||= [];
	      store.discordMemberApplications.unshift({
	        id: persistenceFailureApplicationId,
	        discordUserId: 'sqlite_discord_user_persist_failure',
	        discordUsername: 'SQLite Persist Failure User',
	        displayName: 'SQLite Persist Failure User',
	        discordLanguage: 'en',
	        adminReviewLanguage: 'en',
	        steamId: '76561198000007779',
	        steamInput: '76561198000007779',
	        rawInput: '76561198000007779',
	        steamNickname: 'SQLite Persist Failure Steam',
	        steamAvatar: '',
	        specialties: ['builder'],
	        squadId: 'squad_sqlite_discord_review',
	        squadName: 'NB-EU',
	        status: 'approved',
	        adminNote: '',
	        reviewNote: '',
	        reviewedByUserId: 'user_root',
	        reviewedAt: createdAt,
	        memberId: '',
	        adminReviewChannelId: '',
	        adminReviewMessageId: '',
	        adminReviewPushedAt: '',
	        adminReviewSyncedAt: '',
	        adminReviewSyncError: '',
	        createdAt,
	        updatedAt: createdAt
	      });
	    });
	    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_review_card_push_result', 1);
	    const persistenceFailureResult = await apiModule.syncMissingDiscordMemberReviewCards({
	      ids: [persistenceFailureApplicationId],
	      silent: true,
	      force: true
	    });
	    assert.equal(persistenceFailureResult.checked, 1);
	    assert.equal(persistenceFailureResult.pushed, 0);
	    assert.equal(persistenceFailureResult.failed, 1);
	    const persistenceFailureMessage = discordDirectMessages.find((message) => message.channelId === 'sqlite_review_channel');
	    assert.equal(Boolean(persistenceFailureMessage), true);
	    const persistenceFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', persistenceFailureApplicationId);
	    assert.equal(persistenceFailureApplication.adminReviewMessageId, persistenceFailureMessage.messageId);
	    assert.match(persistenceFailureApplication.adminReviewSyncError, /discord_member_review_card_push_result/);
	    const persistenceFailureRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [persistenceFailureApplicationId], { limit: 0 });
	    assert.equal(persistenceFailureRefs.some((ref) => (
	      ref.messageId === persistenceFailureMessage.messageId &&
	      ref.status === 'active' &&
	      ref.source === 'review_card_result_persist_failed'
	    )), true);
	    const persistenceFailureRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', [persistenceFailureApplicationId], { limit: 0 });
	    assert.equal(persistenceFailureRuns.some((run) => (
	      run.status === 'failed' &&
	      run.messageId === persistenceFailureMessage.messageId &&
	      run.metadata?.resultPersistenceFailed
	    )), true);
	    const persistenceFailureLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [persistenceFailureApplicationId], { limit: 0 });
	    assert.equal(persistenceFailureLogs.some((log) => (
	      log.type === 'discord_member_review_card_result_persist_failed' &&
	      log.metadata?.resultPersistenceFailed
	    )), true);

	    const editLimitedApplicationId = 'discord_member_application_sqlite_review_edit_limited';
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: editLimitedApplicationId,
        discordUserId: 'sqlite_discord_user_edit_limited',
        discordUsername: 'SQLite Edit Limited User',
        displayName: 'SQLite Edit Limited User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000008888',
        steamInput: '76561198000008888',
        rawInput: '76561198000008888',
        steamNickname: 'SQLite Edit Limited Steam',
        steamAvatar: '',
        specialties: ['pvp'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: 'sqlite_review_channel',
        adminReviewMessageId: 'sqlite_review_edit_limited',
        adminReviewPushedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
    });

    const editLimitedReviewResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${editLimitedApplicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'approved', adminNote: 'SQLite edit limited approved.' })
    });
    const editLimitedReviewPayload = await editLimitedReviewResponse.json();
    assert.equal(editLimitedReviewResponse.status, 200, JSON.stringify(editLimitedReviewPayload));
    for (let attempt = 0; attempt < 80 && (!discordDeletes.length || !discordDirectMessages.some((message) => message.channelId === 'sqlite_review_channel')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(discordEdits.at(-1).messageId, 'sqlite_review_edit_limited');
    assert.deepEqual(discordDeletes, [{
      channelId: 'sqlite_review_channel',
      messageId: 'sqlite_review_edit_limited',
      authorization: 'Bot sqlite_discord_bot_token'
    }]);
    const repost = discordDirectMessages.find((message) => message.channelId === 'sqlite_review_channel');
    assert.equal(Boolean(repost), true);
    assert.equal(repost.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(repost.body.components.length, 2);

    let editLimitedApplication = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      editLimitedApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', editLimitedApplicationId);
      if (editLimitedApplication?.adminReviewMessageId === repost.messageId) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(editLimitedApplication.status, 'approved');
    assert.equal(editLimitedApplication.adminReviewMessageId, repost.messageId);
    assert.equal(Boolean(editLimitedApplication.adminReviewSyncedAt), true);
    const editLimitedLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [editLimitedApplicationId], { limit: 0 });
    const repostLog = editLimitedLogs.find((log) => log.type === 'discord_member_review_card_repost');
    assert.equal(Boolean(repostLog), true);
    assert.equal(repostLog.metadata.uneditableMessages.some((message) => message.messageId === 'sqlite_review_edit_limited'), true);
    assert.equal(repostLog.metadata.deletedMessages.some((message) => message.messageId === 'sqlite_review_edit_limited'), true);
    const editLimitedRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [editLimitedApplicationId], { limit: 0 });
    assert.equal(editLimitedRefs.some((ref) => ref.messageId === 'sqlite_review_edit_limited' && ref.status === 'deleted'), true);
    assert.equal(editLimitedRefs.some((ref) => ref.messageId === repost.messageId && ref.status === 'active'), true);

    const deleteRunFailureApplicationId = 'discord_member_application_sqlite_delete_run_failure';
    discordEdits.length = 0;
    discordDeletes.length = 0;
    discordDirectMessages.length = 0;
    await storeModule.updateStore((store) => {
      store.discordMemberApplications ||= [];
      store.discordMemberApplications.unshift({
        id: deleteRunFailureApplicationId,
        discordUserId: 'sqlite_discord_user_delete_run_failure',
        discordUsername: 'SQLite Delete Run Failure User',
        displayName: 'SQLite Delete Run Failure User',
        discordLanguage: 'en',
        adminReviewLanguage: 'en',
        steamId: '76561198000008889',
        steamInput: '76561198000008889',
        rawInput: '76561198000008889',
        steamNickname: 'SQLite Delete Run Failure Steam',
        steamAvatar: '',
        specialties: ['builder'],
        squadId: 'squad_sqlite_discord_review',
        squadName: 'NB-EU',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        memberId: '',
        adminReviewChannelId: 'sqlite_review_channel',
        adminReviewMessageId: 'sqlite_review_delete_run_failure',
        adminReviewPushedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
    });
    const deleteRunFailureReviewResponse = await fetch(`${baseUrl}/third-party/admin/discord-member-applications/${deleteRunFailureApplicationId}/review`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'approved', adminNote: 'SQLite delete run failure approved.' })
    });
    const deleteRunFailureReviewPayload = await deleteRunFailureReviewResponse.json();
    assert.equal(deleteRunFailureReviewResponse.status, 200, JSON.stringify(deleteRunFailureReviewPayload));
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    assert.equal(discordEdits.length, 1);
    assert.equal(discordEdits[0].messageId, 'sqlite_review_delete_run_failure');
    assert.equal(discordDeletes.length, 0);
    assert.equal(discordDirectMessages.some((message) => message.channelId === 'sqlite_review_channel'), false);
    const deleteRunFailureApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', deleteRunFailureApplicationId);
    assert.equal(deleteRunFailureApplication.status, 'approved');
    assert.equal(deleteRunFailureApplication.adminReviewMessageId, 'sqlite_review_delete_run_failure');
    assert.match(deleteRunFailureApplication.adminReviewSyncError, /Discord 审核卡片删除记录/);

    const autoRoleApplicationDiscordId = '123456789012345798';
    const autoRoleSteamId = '76561198000009997';
    const autoRoleId = 'sqlite_register_role';
    const autoManageRoleId = 'sqlite_manage_role';
    await storeModule.updateStore((store) => {
      const existingDiscord = store.settings.discord || {};
      const target = existingDiscord.targets?.[0] || { id: 'default', name: 'Default channel' };
      const discordPatch = {
        guildId: 'sqlite_guild',
        memberRegisterChannelId: 'sqlite_register_channel',
        memberReviewChannelId: 'sqlite_review_channel',
        memberRegisterRoleId: autoRoleId,
        memberManageRoleId: autoManageRoleId,
        memberRegisterRoleSquadRules: [{ id: 'sqlite_auto_role_rule', roleId: autoRoleId, squadId: 'squad_sqlite_discord_review' }]
      };
      store.settings.discord = {
        ...existingDiscord,
        ...discordPatch,
        targets: [{ ...target, ...discordPatch }]
      };
    });
    globalThis.fetch = async (input, init) => {
      const url = String(input || '');
      if (url.includes(`/profiles/${autoRoleSteamId}?xml=1`)) {
        return {
          ok: true,
          text: async () => `<profile><steamID64>${autoRoleSteamId}</steamID64><steamID><![CDATA[SQLite Auto Role Steam]]></steamID><avatarFull><![CDATA[https://cdn.example.test/${autoRoleSteamId}.png]]></avatarFull><privacyState>public</privacyState><visibilityState>3</visibilityState></profile>`
        };
      }
      return originalFetch(input, init);
    };
    const autoRoleResponse = await postDiscordInteraction({
      type: 5,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_auto_role_submit_token',
      locale: 'en-US',
      guild_id: 'sqlite_guild',
      channel_id: 'sqlite_register_channel',
      member: {
        roles: [autoRoleId],
        permissions: '0',
        user: { id: autoRoleApplicationDiscordId, username: 'SQLiteAutoRoleUser', avatar: 'sqlite_auto_role_avatar' }
      },
      data: {
        custom_id: 'nb_member_register:submit:pvp:none',
        components: [{ type: 18, component: { type: 4, custom_id: 'steam_input', value: autoRoleSteamId } }]
      }
    });
    const autoRolePayload = await autoRoleResponse.json();
    assert.equal(autoRoleResponse.status, 200, JSON.stringify(autoRolePayload));
    assert.equal(autoRolePayload.type, 4);
    assert.match(autoRolePayload.data.content, /completed automatically/);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const autoRoleApplication = await repositoryModule.getSqliteRecordsByJsonField('discordMemberApplications', 'discordUserId', [autoRoleApplicationDiscordId], { limit: 0 });
    assert.equal(autoRoleApplication.length, 1);
    assert.equal(autoRoleApplication[0].status, 'approved');
    assert.equal(autoRoleApplication[0].squadId, 'squad_sqlite_discord_review');
    assert.equal(Boolean(autoRoleApplication[0].memberId), true);
    const autoRoleMember = await repositoryModule.getSqliteRecord('members', autoRoleApplication[0].memberId);
    assert.equal(autoRoleMember.discordId, autoRoleApplicationDiscordId);
    const autoRoleLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [autoRoleApplication[0].id], { limit: 0 });
    assert.equal(autoRoleLogs.some((log) => log.type === 'discord_member_application_auto_approve'), true);
    const autoRoleReviewMessage = discordDirectMessages.find((message) => message.channelId === 'sqlite_review_channel' && message.body.embeds?.[0]?.fields?.some((field) => field.value === autoRoleSteamId));
    assert.equal(Boolean(autoRoleReviewMessage), true);
    assert.equal(autoRoleReviewMessage.body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(autoRoleReviewMessage.body.components[1].components[0].custom_id, `nb_member_review:remove:${autoRoleApplication[0].id}`);
    assert.equal(autoRoleReviewMessage.body.components[1].components[0].disabled, false);

    const autoRoleDeleteDeniedResponse = await postDiscordInteraction({
      type: 3,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_auto_role_delete_denied_token',
      locale: 'en-US',
      guild_id: 'sqlite_guild',
      channel_id: 'sqlite_review_channel',
      member: { roles: [], permissions: '0', user: { id: 'sqlite_auto_role_denied', username: 'SQLiteAutoRoleDenied' } },
      message: { id: autoRoleReviewMessage.messageId, channel_id: 'sqlite_review_channel' },
      data: { custom_id: `nb_member_review:remove:${autoRoleApplication[0].id}` }
    });
    const autoRoleDeleteDeniedPayload = await autoRoleDeleteDeniedResponse.json();
    assert.equal(autoRoleDeleteDeniedResponse.status, 200, JSON.stringify(autoRoleDeleteDeniedPayload));
    assert.equal(autoRoleDeleteDeniedPayload.type, 4);
    assert.match(autoRoleDeleteDeniedPayload.data.content, /member management permission/);

    const autoRoleDeleteResponse = await postDiscordInteraction({
      type: 3,
      application_id: 'sqlite_discord_application',
      token: 'sqlite_auto_role_delete_token',
      locale: 'en-US',
      guild_id: 'sqlite_guild',
      channel_id: 'sqlite_review_channel',
      member: { roles: [autoManageRoleId], permissions: '0', user: { id: 'sqlite_auto_role_manager', username: 'SQLiteAutoRoleManager' } },
      message: { id: autoRoleReviewMessage.messageId, channel_id: 'sqlite_review_channel' },
      data: { custom_id: `nb_member_review:remove:${autoRoleApplication[0].id}` }
    });
    const autoRoleDeletePayload = await autoRoleDeleteResponse.json();
    assert.equal(autoRoleDeleteResponse.status, 200, JSON.stringify(autoRoleDeletePayload));
    assert.equal(autoRoleDeletePayload.type, 7);
    assert.equal(autoRoleDeletePayload.data.components[1].components[0].disabled, true);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const deletedAutoRoleApplication = await repositoryModule.getSqliteRecord('discordMemberApplications', autoRoleApplication[0].id);
    assert.equal(Boolean(deletedAutoRoleApplication.memberDeletedAt), true);
    assert.equal(await repositoryModule.getSqliteRecord('members', autoRoleApplication[0].memberId), null);
    assert.equal(discordEdits.some((edit) => edit.messageId === autoRoleReviewMessage.messageId && edit.body.components?.[1]?.components?.[0]?.disabled === true), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
