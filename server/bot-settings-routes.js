import { appendLog } from './audit-logs.js';
import {
  readSettingsRuntimeStore,
  updateSettingsLogStore
} from './settings-store.js';
import {
  normalizeText,
  nowIso
} from './store.js';

function send(res, data = {}) {
  res.json({ ok: true, ...data });
}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerBotSettingsRoutes requires ${name}`);
  }
  return value;
}

function requiredFiniteNumber(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`registerBotSettingsRoutes requires ${name}`);
  }
  return number;
}

function requiredValue(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new TypeError(`registerBotSettingsRoutes requires ${name}`);
  }
  return value;
}

export function registerBotSettingsRoutes(router, {
  requireModuleEdit,
  discordSettings,
  discordSettingsForTarget,
  discordSettingsPayload,
  normalizeDiscordSettingsInput,
  syncDiscordLegacyFields,
  resolveDiscordTargetMetadata,
  applyDiscordTargetMetadata,
  kookSettings,
  kookSettingsPayload,
  normalizeKookSettingsInput,
  readMemberRankingRuntimeStore,
  readWipeRuntimeStore,
  discordCardLanguage,
  discordRankingMetric,
  buildKookMemberRankingCard,
  buildDiscordMemberRegistrationMessage,
  buildDiscordMemberRankingMessage,
  buildDiscordMapMessage,
  refreshKookMemberRankingCard,
  refreshDiscordMemberRankingCard,
  publicMemberRankingRefreshResult,
  discordBotToken,
  kookBotToken,
  createOperationRun,
  requestActorUserId,
  requireOperationRun,
  finishOperationRun,
  registerDiscordCommands,
  discordWipeAttendanceCommandName,
  updateDiscordTargetStatus,
  sendDiscordChannelMessage,
  upsertKookCardMessage,
  discordCardMessageRefUpserts,
  kookCardMessageRefUpserts,
  persistIntegrationMessageRefs,
  sqliteDirectWriteUnavailableError,
  discordIdMaxLength,
  kookIdMaxLength,
  discordMemberRegistrationMessageRefKind,
  discordMemberRankingMessageRefKind,
  discordMapMessageRefKind,
  discordTargetMessageRefTargetType,
  kookMemberRankingMessageRefKind,
  kookTargetMessageRefTargetType,
  memberRankingDefaultMetric
} = {}) {
  const requireDiscordEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('discordBot');
  const requireKookEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('kookBot');
  const getDiscordSettings = requiredDependency('discordSettings', discordSettings);
  const getDiscordSettingsForTarget = requiredDependency('discordSettingsForTarget', discordSettingsForTarget);
  const toDiscordSettingsPayload = requiredDependency('discordSettingsPayload', discordSettingsPayload);
  const normalizeDiscordSettings = requiredDependency('normalizeDiscordSettingsInput', normalizeDiscordSettingsInput);
  const syncDiscordLegacy = requiredDependency('syncDiscordLegacyFields', syncDiscordLegacyFields);
  const resolveDiscordMetadata = requiredDependency('resolveDiscordTargetMetadata', resolveDiscordTargetMetadata);
  const applyDiscordMetadata = requiredDependency('applyDiscordTargetMetadata', applyDiscordTargetMetadata);
  const getKookSettings = requiredDependency('kookSettings', kookSettings);
  const toKookSettingsPayload = requiredDependency('kookSettingsPayload', kookSettingsPayload);
  const normalizeKookSettings = requiredDependency('normalizeKookSettingsInput', normalizeKookSettingsInput);
  const readRankingStore = requiredDependency('readMemberRankingRuntimeStore', readMemberRankingRuntimeStore);
  const readWipeStore = requiredDependency('readWipeRuntimeStore', readWipeRuntimeStore);
  const normalizeCardLanguage = requiredDependency('discordCardLanguage', discordCardLanguage);
  const normalizeRankingMetric = requiredDependency('discordRankingMetric', discordRankingMetric);
  const buildKookRankingCard = requiredDependency('buildKookMemberRankingCard', buildKookMemberRankingCard);
  const buildDiscordRegistrationMessage = requiredDependency('buildDiscordMemberRegistrationMessage', buildDiscordMemberRegistrationMessage);
  const buildDiscordRankingMessage = requiredDependency('buildDiscordMemberRankingMessage', buildDiscordMemberRankingMessage);
  const buildDiscordMapCard = requiredDependency('buildDiscordMapMessage', buildDiscordMapMessage);
  const refreshKookRankingCard = requiredDependency('refreshKookMemberRankingCard', refreshKookMemberRankingCard);
  const refreshDiscordRankingCard = requiredDependency('refreshDiscordMemberRankingCard', refreshDiscordMemberRankingCard);
  const toMemberRankingRefreshResult = requiredDependency('publicMemberRankingRefreshResult', publicMemberRankingRefreshResult);
  const getDiscordBotToken = requiredDependency('discordBotToken', discordBotToken);
  const getKookBotToken = requiredDependency('kookBotToken', kookBotToken);
  const createRun = requiredDependency('createOperationRun', createOperationRun);
  const actorUserId = requiredDependency('requestActorUserId', requestActorUserId);
  const ensureOperationRun = requiredDependency('requireOperationRun', requireOperationRun);
  const finishRun = requiredDependency('finishOperationRun', finishOperationRun);
  const registerCommands = requiredDependency('registerDiscordCommands', registerDiscordCommands);
  const wipeAttendanceCommandName = requiredDependency('discordWipeAttendanceCommandName', discordWipeAttendanceCommandName);
  const updateDiscordStatus = requiredDependency('updateDiscordTargetStatus', updateDiscordTargetStatus);
  const sendDiscordMessage = requiredDependency('sendDiscordChannelMessage', sendDiscordChannelMessage);
  const upsertKookCard = requiredDependency('upsertKookCardMessage', upsertKookCardMessage);
  const discordCardRefUpserts = requiredDependency('discordCardMessageRefUpserts', discordCardMessageRefUpserts);
  const kookCardRefUpserts = requiredDependency('kookCardMessageRefUpserts', kookCardMessageRefUpserts);
  const persistMessageRefs = requiredDependency('persistIntegrationMessageRefs', persistIntegrationMessageRefs);
  const directWriteUnavailable = requiredDependency('sqliteDirectWriteUnavailableError', sqliteDirectWriteUnavailableError);
  const discordIdMax = requiredFiniteNumber('discordIdMaxLength', discordIdMaxLength);
  const kookIdMax = requiredFiniteNumber('kookIdMaxLength', kookIdMaxLength);
  const discordRegistrationRefKind = requiredValue('discordMemberRegistrationMessageRefKind', discordMemberRegistrationMessageRefKind);
  const discordRankingRefKind = requiredValue('discordMemberRankingMessageRefKind', discordMemberRankingMessageRefKind);
  const discordMapRefKind = requiredValue('discordMapMessageRefKind', discordMapMessageRefKind);
  const discordTargetRefTargetType = requiredValue('discordTargetMessageRefTargetType', discordTargetMessageRefTargetType);
  const kookRankingRefKind = requiredValue('kookMemberRankingMessageRefKind', kookMemberRankingMessageRefKind);
  const kookTargetRefTargetType = requiredValue('kookTargetMessageRefTargetType', kookTargetMessageRefTargetType);
  const defaultRankingMetric = memberRankingDefaultMetric || 't3Kills';

  router.put('/settings/discord', requireDiscordEdit, async (req, res, next) => {
    try {
      let discord = null;
      await updateSettingsLogStore((store) => {
        const settings = getDiscordSettings(store);
        const nextSettings = normalizeDiscordSettings(req.body || {}, settings);
        settings.botToken = req.body?.clearToken ? '' : nextSettings.botToken;
        settings.publicKey = nextSettings.publicKey;
        settings.applicationId = nextSettings.applicationId;
        settings.targets = nextSettings.targets;
        syncDiscordLegacy(settings, settings.targets[0]);
        settings.commandHint = nextSettings.commandHint;
        settings.templateTitle = nextSettings.templateTitle;
        settings.templateBody = nextSettings.templateBody;
        if (Array.isArray(nextSettings.commandDefinitions)) {
          settings.commandDefinitions = nextSettings.commandDefinitions;
        }
        settings.updatedAt = nowIso();
        settings.lastPushError = '';
        for (const target of settings.targets) {
          target.lastPushError = '';
        }
        appendLog(store, req, 'discord_settings_edit', 'Updated Discord Bot settings');
        discord = toDiscordSettingsPayload(store);
      }, 'discord_settings_update');
      let metadataSyncError = '';
      try {
        const snapshot = await readSettingsRuntimeStore();
        const metadata = await resolveDiscordMetadata(getDiscordSettings(snapshot));
        await updateSettingsLogStore((store) => {
          const settings = getDiscordSettings(store);
          applyDiscordMetadata(settings, metadata);
          discord = toDiscordSettingsPayload(store);
        }, 'discord_settings_metadata_update');
      } catch (error) {
        metadataSyncError = normalizeText(error?.message || error, 500);
      }
      send(res, { discord, metadataSyncError });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/kook', requireKookEdit, async (req, res, next) => {
    try {
      let kook = null;
      await updateSettingsLogStore((store) => {
        const settings = getKookSettings(store);
        const nextSettings = normalizeKookSettings(req.body || {}, settings);
        settings.botToken = req.body?.clearToken ? '' : nextSettings.botToken;
        settings.verifyToken = nextSettings.verifyToken;
        settings.encryptKey = req.body?.clearEncryptKey ? '' : nextSettings.encryptKey;
        settings.guildId = nextSettings.guildId;
        settings.channelId = nextSettings.channelId;
        settings.memberRegisterChannelId = nextSettings.memberRegisterChannelId;
        settings.kdaQueryChannelId = nextSettings.kdaQueryChannelId;
        settings.memberRankingChannelId = nextSettings.memberRankingChannelId;
        settings.enabledCommandIds = nextSettings.enabledCommandIds;
        if (Array.isArray(nextSettings.eventDefinitions)) {
          settings.eventDefinitions = nextSettings.eventDefinitions;
          settings.commandDefinitions = nextSettings.eventDefinitions;
        }
        settings.updatedAt = nowIso();
        settings.lastPushError = '';
        appendLog(store, req, 'kook_settings_edit', 'Updated KOOK Bot settings');
        kook = toKookSettingsPayload(store);
      }, 'kook_settings_update');
      send(res, { kook });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/kook/member-ranking-card/preview', requireKookEdit, async (req, res, next) => {
    try {
      const snapshot = await readRankingStore({ reference: 'query', scopeMembersToRows: true });
      const language = normalizeCardLanguage(req.body?.language);
      const metric = normalizeRankingMetric(req.body?.metric || defaultRankingMetric).metric;
      send(res, {
        language,
        metric,
        preview: buildKookRankingCard(snapshot, { language, metric })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/kook/member-ranking-card', requireKookEdit, async (req, res, next) => {
    try {
      const snapshot = await readRankingStore({ reference: 'query', scopeMembersToRows: true });
      const settings = getKookSettings(snapshot);
      const channelId = normalizeText(settings.memberRankingChannelId, kookIdMax);
      if (!getKookBotToken(settings) || !channelId) {
        fail(res, 400, 'KOOK Bot Token or member ranking Channel ID is not configured.');
        return;
      }
      const language = normalizeCardLanguage(req.body?.language);
      const metric = normalizeRankingMetric(req.body?.metric || defaultRankingMetric).metric;
      const pushedAt = nowIso();
      const message = buildKookRankingCard(snapshot, { language, metric });
      const operationRun = await createRun({
        type: 'kook_member_ranking_card_push',
        platform: 'kook',
        source: 'manual',
        status: 'running',
        targetType: 'member_ranking_card',
        targetId: channelId,
        channelId,
        dedupeKey: `kook:member-ranking-card:push:${channelId}:${pushedAt}`,
        createdBy: actorUserId(req),
        metadata: { channelId, metric, language }
      }).catch(() => null);
      ensureOperationRun(operationRun);
      let pushResult;
      try {
        pushResult = await upsertKookCard(settings, channelId, message.cards, {
          messageId: settings.lastMemberRankingMessageId,
          fallbackToCreate: true,
          cleanupSource: 'manual',
          createdBy: actorUserId(req)
        });
      } catch (error) {
        const errorMessage = normalizeText(error.message || 'KOOK push failed', 240);
        await updateSettingsLogStore((store) => {
          const nextSettings = getKookSettings(store);
          nextSettings.lastPushError = errorMessage;
          nextSettings.lastMemberRankingRefreshError = errorMessage;
          appendLog(store, req, 'kook_member_ranking_card_failed', errorMessage, {
            metadata: { channelId }
          });
        }, 'kook_member_ranking_card_failed');
        await finishRun(operationRun, {
          status: 'failed',
          errorSummary: errorMessage,
          retryable: true,
          metadata: { channelId, metric, language }
        });
        throw error;
      }
      const messageId = pushResult.messageId || normalizeText(pushResult.message?.msg_id || pushResult.message?.id || pushResult.message?.messageId, 120);
      let trackingWriteError = null;
      try {
        await updateSettingsLogStore((store) => {
          const nextSettings = getKookSettings(store);
          nextSettings.lastMemberRankingPushAt = pushedAt;
          nextSettings.lastMemberRankingMessageId = messageId;
          nextSettings.lastMemberRankingLanguage = language;
          nextSettings.lastMemberRankingMetric = metric;
          nextSettings.lastMemberRankingRefreshAt = pushedAt;
          nextSettings.lastMemberRankingRefreshError = '';
          nextSettings.lastPushAt = pushedAt;
          nextSettings.lastPushError = '';
          appendLog(store, req, 'kook_member_ranking_card_push', 'Pushed KOOK member ranking card', {
            metadata: { messageId, channelId, metric, language }
          });
          return {
            upserts: kookCardRefUpserts(
              kookRankingRefKind,
              kookTargetRefTargetType,
              channelId,
              channelId,
              { ...pushResult, messageId },
              settings,
              {
                store,
                source: 'kook_member_ranking_card_push',
                action: pushResult.action || 'push',
                metadata: { channelId, metric, language }
              }
            )
          };
        }, 'kook_member_ranking_card_push');
      } catch (error) {
        trackingWriteError = error;
      }
      if (trackingWriteError) {
        let recoveredMessageRefCount = 0;
        let messageRefWriteError = null;
        const recoveryRefUpserts = kookCardRefUpserts(
          kookRankingRefKind,
          kookTargetRefTargetType,
          channelId,
          channelId,
          { ...pushResult, messageId },
          settings,
          {
            source: 'kook_member_ranking_card_push_recovery',
            action: pushResult.action || 'push',
            metadata: { channelId, metric, language, trackingWriteFailed: true }
          }
        );
        try {
          recoveredMessageRefCount = await persistMessageRefs(
            recoveryRefUpserts.integrationMessageRefs || [],
            'kook_member_ranking_card_push_message_ref_recovery'
          );
        } catch (refError) {
          messageRefWriteError = refError;
        }
        await finishRun(operationRun, {
          status: 'failed',
          messageId,
          channelId,
          errorSummary: normalizeText(trackingWriteError.message || trackingWriteError, 500),
          retryable: true,
          metadata: {
            channelId,
            metric,
            language,
            action: pushResult.action || '',
            cleanupDeletedCount: pushResult.cleanup?.deleted || 0,
            cleanupFailedCount: pushResult.cleanup?.failed || 0,
            cleanupMissingCount: pushResult.cleanup?.missing || 0,
            externalActionSucceeded: true,
            trackingWriteFailed: true,
            trackingWriteError: normalizeText(trackingWriteError.message || trackingWriteError, 240),
            messageRefRecovered: recoveredMessageRefCount > 0,
            messageRefWriteFailed: Boolean(messageRefWriteError),
            messageRefWriteError: normalizeText(messageRefWriteError?.message || '', 240)
          }
        });
        throw directWriteUnavailable('KOOK 排行卡状态记录', trackingWriteError);
      }
      await finishRun(operationRun, {
        status: 'succeeded',
        messageId,
        channelId,
        metadata: {
          channelId,
          metric,
          language,
          action: pushResult.action || '',
          cleanupDeletedCount: pushResult.cleanup?.deleted || 0,
          cleanupFailedCount: pushResult.cleanup?.failed || 0,
          cleanupMissingCount: pushResult.cleanup?.missing || 0
        }
      });
      const store = await readSettingsRuntimeStore();
      send(res, {
        kook: toKookSettingsPayload(store),
        message: { id: messageId, action: pushResult.action }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/kook/member-ranking-card/refresh', requireKookEdit, async (_req, res, next) => {
    try {
      const refresh = await refreshKookRankingCard({ silent: false });
      const store = await readSettingsRuntimeStore();
      send(res, {
        kook: toKookSettingsPayload(store),
        refresh: toMemberRankingRefreshResult(refresh)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/commands', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readSettingsRuntimeStore();
      const settings = getDiscordSettingsForTarget(getDiscordSettings(snapshot), req.body?.targetId);
      const operationRun = await createRun({
        type: 'discord_command_register',
        platform: 'discord',
        source: 'manual',
        status: 'running',
        targetType: 'discord_commands',
        targetId: settings.targetId || settings.guildId,
        channelId: settings.channelId || '',
        dedupeKey: `discord:command-register:${settings.guildId || 'guild'}:${settings.targetId || 'default'}:${Date.now()}`,
        createdBy: actorUserId(req),
        metadata: {
          targetId: settings.targetId || '',
          targetName: settings.targetName || '',
          guildId: settings.guildId || ''
        }
      }).catch(() => null);
      ensureOperationRun(operationRun);
      let commands;
      try {
        commands = await registerCommands(settings);
      } catch (error) {
        const errorMessage = normalizeText(error.message || 'Discord command registration failed', 240);
        await updateSettingsLogStore((store) => {
          const nextSettings = getDiscordSettings(store);
          updateDiscordStatus(nextSettings, settings.targetId, {
            lastCommandRegisterError: errorMessage
          });
          appendLog(store, req, 'discord_command_register_failed', errorMessage, {
            metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', guildId: settings.guildId || '' }
          });
        }, 'discord_command_register_failed');
        await finishRun(operationRun, {
          status: 'failed',
          errorSummary: errorMessage,
          retryable: true,
          metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', guildId: settings.guildId || '' }
        });
        throw error;
      }
      const registeredAt = nowIso();
      await updateSettingsLogStore((store) => {
        const nextSettings = getDiscordSettings(store);
        updateDiscordStatus(nextSettings, settings.targetId, {
          lastCommandRegisterAt: registeredAt,
          lastCommandRegisterError: '',
          wipeAttendanceCommandId: normalizeText(commands?.wipe?.id, 80),
          kdaCommandId: normalizeText(commands?.kda?.id, 80)
        });
        appendLog(store, req, 'discord_command_register', `Registered Discord commands /${wipeAttendanceCommandName(nextSettings)} and /kda`, {
          metadata: {
            targetId: settings.targetId || '',
            targetName: settings.targetName || '',
            guildId: settings.guildId || '',
            wipeCommandId: commands?.wipe?.id || '',
            wipeCommandName: commands?.wipe?.name || '',
            kdaCommandId: commands?.kda?.id || '',
            kdaCommandName: commands?.kda?.name || ''
          }
        });
      }, 'discord_command_register');
      await finishRun(operationRun, {
        status: 'succeeded',
        providerRequestId: normalizeText(commands?.wipe?.id || commands?.kda?.id, 160),
        metadata: {
          targetId: settings.targetId || '',
          targetName: settings.targetName || '',
          guildId: settings.guildId || '',
          wipeCommandId: commands?.wipe?.id || '',
          wipeCommandName: commands?.wipe?.name || '',
          kdaCommandId: commands?.kda?.id || '',
          kdaCommandName: commands?.kda?.name || ''
        }
      });
      const store = await readSettingsRuntimeStore();
      send(res, {
        discord: toDiscordSettingsPayload(store),
        command: {
          id: normalizeText(commands?.wipe?.id, 80),
          name: normalizeText(commands?.wipe?.name, 80)
        },
        commands: {
          wipe: {
            id: normalizeText(commands?.wipe?.id, 80),
            name: normalizeText(commands?.wipe?.name, 80)
          },
          kda: {
            id: normalizeText(commands?.kda?.id, 80),
            name: normalizeText(commands?.kda?.name, 80)
          }
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/member-registration-card/preview', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readSettingsRuntimeStore();
      const settings = getDiscordSettingsForTarget(getDiscordSettings(snapshot), req.body?.targetId);
      const language = normalizeCardLanguage(req.body?.language);
      send(res, {
        language,
        preview: buildDiscordRegistrationMessage(settings, language)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/member-registration-card', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readSettingsRuntimeStore();
      const settings = getDiscordSettingsForTarget(getDiscordSettings(snapshot), req.body?.targetId);
      const memberRegisterChannelId = normalizeText(settings.memberRegisterChannelId, discordIdMax);
      if (!getDiscordBotToken(settings) || !memberRegisterChannelId) {
        fail(res, 400, 'Discord Bot Token or member registration Channel ID is not configured.');
        return;
      }
      const language = normalizeCardLanguage(req.body?.language);
      const pushedAt = nowIso();
      const operationRun = await createRun({
        type: 'discord_member_registration_card_push',
        platform: 'discord',
        source: 'manual',
        status: 'running',
        targetType: 'member_registration_card',
        targetId: settings.targetId || memberRegisterChannelId,
        channelId: memberRegisterChannelId,
        dedupeKey: `discord:member-registration-card:push:${memberRegisterChannelId}:${pushedAt}`,
        createdBy: actorUserId(req),
        metadata: {
          targetId: settings.targetId || '',
          targetName: settings.targetName || '',
          language
        }
      }).catch(() => null);
      ensureOperationRun(operationRun);
      let discordMessage;
      try {
        discordMessage = await sendDiscordMessage(settings, buildDiscordRegistrationMessage(settings, language), memberRegisterChannelId);
      } catch (error) {
        const errorMessage = normalizeText(error.message || 'Discord push failed', 240);
        await updateSettingsLogStore((store) => {
          const nextSettings = getDiscordSettings(store);
          updateDiscordStatus(nextSettings, settings.targetId, {
            lastPushError: errorMessage
          });
          appendLog(store, req, 'discord_member_registration_card_failed', errorMessage, {
            metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', channelId: memberRegisterChannelId }
          });
        }, 'discord_member_registration_card_failed');
        await finishRun(operationRun, {
          status: 'failed',
          errorSummary: errorMessage,
          retryable: true,
          metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', channelId: memberRegisterChannelId, language }
        });
        throw error;
      }
      let trackingWriteError = null;
      try {
        await updateSettingsLogStore((store) => {
          const nextSettings = getDiscordSettings(store);
          updateDiscordStatus(nextSettings, settings.targetId, {
            lastMemberRegisterPushAt: pushedAt,
            lastMemberRegisterMessageId: normalizeText(discordMessage?.id, 80),
            lastMemberRegisterLanguage: language,
            lastPushError: ''
          });
          appendLog(store, req, 'discord_member_registration_card_push', 'Pushed Discord member registration card', {
            metadata: { messageId: discordMessage?.id || '', channelId: memberRegisterChannelId, targetId: settings.targetId || '', targetName: settings.targetName || '' }
          });
          return {
            upserts: discordCardRefUpserts(
              discordRegistrationRefKind,
              discordTargetRefTargetType,
              settings.targetId || memberRegisterChannelId,
              memberRegisterChannelId,
              discordMessage,
              settings,
              {
                store,
                source: 'discord_member_registration_card_push'
              }
            )
          };
        }, 'discord_member_registration_card_push');
      } catch (error) {
        trackingWriteError = error;
      }
      if (trackingWriteError) {
        let recoveredMessageRefCount = 0;
        let messageRefWriteError = null;
        const sentMessageId = normalizeText(discordMessage?.id, 80);
        const recoveryRefUpserts = discordCardRefUpserts(
          discordRegistrationRefKind,
          discordTargetRefTargetType,
          settings.targetId || memberRegisterChannelId,
          memberRegisterChannelId,
          discordMessage,
          settings,
          {
            source: 'discord_member_registration_card_push_recovery',
            metadata: { language, trackingWriteFailed: true }
          }
        );
        try {
          recoveredMessageRefCount = await persistMessageRefs(
            recoveryRefUpserts.integrationMessageRefs || [],
            'discord_member_registration_card_push_message_ref_recovery'
          );
        } catch (refError) {
          messageRefWriteError = refError;
        }
        await finishRun(operationRun, {
          status: 'failed',
          messageId: sentMessageId,
          channelId: normalizeText(discordMessage?.channel_id || memberRegisterChannelId, discordIdMax),
          errorSummary: normalizeText(trackingWriteError.message || trackingWriteError, 500),
          retryable: true,
          metadata: {
            targetId: settings.targetId || '',
            targetName: settings.targetName || '',
            channelId: memberRegisterChannelId,
            language,
            externalActionSucceeded: true,
            trackingWriteFailed: true,
            trackingWriteError: normalizeText(trackingWriteError.message || trackingWriteError, 240),
            messageRefRecovered: recoveredMessageRefCount > 0,
            messageRefWriteFailed: Boolean(messageRefWriteError),
            messageRefWriteError: normalizeText(messageRefWriteError?.message || '', 240)
          }
        });
        throw directWriteUnavailable('Discord 成员报名卡片状态记录', trackingWriteError);
      }
      await finishRun(operationRun, {
        status: 'succeeded',
        messageId: normalizeText(discordMessage?.id, 80),
        channelId: normalizeText(discordMessage?.channel_id || memberRegisterChannelId, discordIdMax),
        metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', language }
      });
      const store = await readSettingsRuntimeStore();
      const messageId = normalizeText(discordMessage?.id, 80);
      const messageUrl = settings.guildId && memberRegisterChannelId && messageId
        ? `https://discord.com/channels/${settings.guildId}/${memberRegisterChannelId}/${messageId}`
        : '';
      send(res, {
        discord: toDiscordSettingsPayload(store),
        message: {
          id: messageId,
          url: messageUrl
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/member-ranking-card/preview', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readRankingStore({ reference: 'wechatRanking', scopeMembersToRows: true });
      const language = normalizeCardLanguage(req.body?.language);
      send(res, {
        language,
        preview: buildDiscordRankingMessage(snapshot, { language })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/member-ranking-card', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readRankingStore({ reference: 'wechatRanking', scopeMembersToRows: true });
      const settings = getDiscordSettingsForTarget(getDiscordSettings(snapshot), req.body?.targetId);
      const channelId = normalizeText(settings.memberRankingChannelId, discordIdMax);
      if (!getDiscordBotToken(settings) || !channelId) {
        fail(res, 400, 'Discord Bot Token or member ranking Channel ID is not configured.');
        return;
      }
      const language = normalizeCardLanguage(req.body?.language);
      const metric = normalizeRankingMetric(req.body?.metric || defaultRankingMetric).metric;
      const pushedAt = nowIso();
      const operationRun = await createRun({
        type: 'discord_member_ranking_card_push',
        platform: 'discord',
        source: 'manual',
        status: 'running',
        targetType: 'member_ranking_card',
        targetId: settings.targetId || channelId,
        channelId,
        dedupeKey: `discord:member-ranking-card:push:${channelId}:${pushedAt}`,
        createdBy: actorUserId(req),
        metadata: {
          targetId: settings.targetId || '',
          targetName: settings.targetName || '',
          metric,
          language
        }
      }).catch(() => null);
      ensureOperationRun(operationRun);
      let discordMessage;
      try {
        discordMessage = await sendDiscordMessage(settings, buildDiscordRankingMessage(snapshot, { language, metric }), channelId);
      } catch (error) {
        const errorMessage = normalizeText(error.message || 'Discord push failed', 240);
        await updateSettingsLogStore((store) => {
          const nextSettings = getDiscordSettings(store);
          updateDiscordStatus(nextSettings, settings.targetId, {
            lastPushError: errorMessage
          });
          appendLog(store, req, 'discord_member_ranking_card_failed', errorMessage, {
            metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', channelId }
          });
        }, 'discord_member_ranking_card_failed');
        await finishRun(operationRun, {
          status: 'failed',
          errorSummary: errorMessage,
          retryable: true,
          metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', channelId, metric, language }
        });
        throw error;
      }
      let trackingWriteError = null;
      try {
        await updateSettingsLogStore((store) => {
          const nextSettings = getDiscordSettings(store);
          updateDiscordStatus(nextSettings, settings.targetId, {
            lastMemberRankingPushAt: pushedAt,
            lastMemberRankingMessageId: normalizeText(discordMessage?.id, 80),
            lastMemberRankingLanguage: language,
            lastMemberRankingMetric: metric,
            lastMemberRankingRefreshAt: pushedAt,
            lastMemberRankingRefreshError: '',
            lastPushError: ''
          });
          appendLog(store, req, 'discord_member_ranking_card_push', 'Pushed Discord member ranking card', {
            metadata: { messageId: discordMessage?.id || '', channelId, targetId: settings.targetId || '', targetName: settings.targetName || '', metric, language }
          });
          return {
            upserts: discordCardRefUpserts(
              discordRankingRefKind,
              discordTargetRefTargetType,
              settings.targetId || channelId,
              channelId,
              discordMessage,
              settings,
              {
                store,
                source: 'discord_member_ranking_card_push',
                metadata: { metric, language }
              }
            )
          };
        }, 'discord_member_ranking_card_push');
      } catch (error) {
        trackingWriteError = error;
      }
      if (trackingWriteError) {
        let recoveredMessageRefCount = 0;
        let messageRefWriteError = null;
        const sentMessageId = normalizeText(discordMessage?.id, 80);
        const recoveryRefUpserts = discordCardRefUpserts(
          discordRankingRefKind,
          discordTargetRefTargetType,
          settings.targetId || channelId,
          channelId,
          discordMessage,
          settings,
          {
            source: 'discord_member_ranking_card_push_recovery',
            metadata: { metric, language, trackingWriteFailed: true }
          }
        );
        try {
          recoveredMessageRefCount = await persistMessageRefs(
            recoveryRefUpserts.integrationMessageRefs || [],
            'discord_member_ranking_card_push_message_ref_recovery'
          );
        } catch (refError) {
          messageRefWriteError = refError;
        }
        await finishRun(operationRun, {
          status: 'failed',
          messageId: sentMessageId,
          channelId: normalizeText(discordMessage?.channel_id || channelId, discordIdMax),
          errorSummary: normalizeText(trackingWriteError.message || trackingWriteError, 500),
          retryable: true,
          metadata: {
            targetId: settings.targetId || '',
            targetName: settings.targetName || '',
            channelId,
            metric,
            language,
            externalActionSucceeded: true,
            trackingWriteFailed: true,
            trackingWriteError: normalizeText(trackingWriteError.message || trackingWriteError, 240),
            messageRefRecovered: recoveredMessageRefCount > 0,
            messageRefWriteFailed: Boolean(messageRefWriteError),
            messageRefWriteError: normalizeText(messageRefWriteError?.message || '', 240)
          }
        });
        throw directWriteUnavailable('Discord 排行卡状态记录', trackingWriteError);
      }
      await finishRun(operationRun, {
        status: 'succeeded',
        messageId: normalizeText(discordMessage?.id, 80),
        channelId: normalizeText(discordMessage?.channel_id || channelId, discordIdMax),
        metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', metric, language }
      });
      const store = await readSettingsRuntimeStore();
      const messageId = normalizeText(discordMessage?.id, 80);
      const messageUrl = settings.guildId && channelId && messageId
        ? `https://discord.com/channels/${settings.guildId}/${channelId}/${messageId}`
        : '';
      send(res, {
        discord: toDiscordSettingsPayload(store),
        message: { id: messageId, url: messageUrl }
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/member-ranking-card/refresh', requireDiscordEdit, async (req, res, next) => {
    try {
      const refresh = await refreshDiscordRankingCard({
        targetId: normalizeText(req.body?.targetId, 80),
        silent: false
      });
      const store = await readSettingsRuntimeStore();
      send(res, {
        discord: toDiscordSettingsPayload(store),
        refresh: toMemberRankingRefreshResult(refresh)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/map-card/preview', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readWipeStore({ includeUploads: true, includeSettings: true });
      const language = normalizeCardLanguage(req.body?.language);
      send(res, {
        language,
        preview: await buildDiscordMapCard(snapshot, req, { language })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord/map-card', requireDiscordEdit, async (req, res, next) => {
    try {
      const snapshot = await readWipeStore({ includeUploads: true, includeSettings: true });
      const settings = getDiscordSettingsForTarget(getDiscordSettings(snapshot), req.body?.targetId);
      const channelId = normalizeText(settings.mapChannelId, discordIdMax);
      if (!getDiscordBotToken(settings) || !channelId) {
        fail(res, 400, 'Discord Bot Token or map Channel ID is not configured.');
        return;
      }
      const language = normalizeCardLanguage(req.body?.language);
      const pushedAt = nowIso();
      const operationRun = await createRun({
        type: 'discord_map_card_push',
        platform: 'discord',
        source: 'manual',
        status: 'running',
        targetType: 'map_card',
        targetId: settings.targetId || channelId,
        channelId,
        dedupeKey: `discord:map-card:push:${channelId}:${pushedAt}`,
        createdBy: actorUserId(req),
        metadata: {
          targetId: settings.targetId || '',
          targetName: settings.targetName || '',
          language
        }
      }).catch(() => null);
      ensureOperationRun(operationRun);
      let discordMessage;
      try {
        discordMessage = await sendDiscordMessage(settings, await buildDiscordMapCard(snapshot, req, { language }), channelId);
      } catch (error) {
        const errorMessage = normalizeText(error.message || 'Discord push failed', 240);
        let trackingWriteError = null;
        try {
          await updateSettingsLogStore((store) => {
            const nextSettings = getDiscordSettings(store);
            updateDiscordStatus(nextSettings, settings.targetId, {
              lastPushError: errorMessage
            });
            appendLog(store, req, 'discord_map_card_failed', errorMessage, {
              metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', channelId }
            });
          }, 'discord_map_card_failed');
        } catch (writeError) {
          trackingWriteError = writeError;
        }
        await finishRun(operationRun, {
          status: 'failed',
          errorSummary: trackingWriteError
            ? normalizeText(`${errorMessage}; ${trackingWriteError.message || trackingWriteError}`, 500)
            : errorMessage,
          retryable: true,
          metadata: {
            targetId: settings.targetId || '',
            targetName: settings.targetName || '',
            channelId,
            language,
            externalActionSucceeded: false,
            trackingWriteFailed: Boolean(trackingWriteError),
            trackingWriteError: normalizeText(trackingWriteError?.message || '', 240)
          }
        });
        throw error;
      }
      let trackingWriteError = null;
      try {
        await updateSettingsLogStore((store) => {
          const nextSettings = getDiscordSettings(store);
          updateDiscordStatus(nextSettings, settings.targetId, {
            lastMapPushAt: pushedAt,
            lastMapMessageId: normalizeText(discordMessage?.id, 80),
            lastMapLanguage: language,
            lastPushError: ''
          });
          appendLog(store, req, 'discord_map_card_push', 'Pushed Discord map card', {
            metadata: { messageId: discordMessage?.id || '', channelId, targetId: settings.targetId || '', targetName: settings.targetName || '' }
          });
          return {
            upserts: discordCardRefUpserts(
              discordMapRefKind,
              discordTargetRefTargetType,
              settings.targetId || channelId,
              channelId,
              discordMessage,
              settings,
              {
                store,
                source: 'discord_map_card_push',
                metadata: { language }
              }
            )
          };
        }, 'discord_map_card_push');
      } catch (error) {
        trackingWriteError = error;
      }
      if (trackingWriteError) {
        let recoveredMessageRefCount = 0;
        let messageRefWriteError = null;
        const sentMessageId = normalizeText(discordMessage?.id, 80);
        const recoveryRefUpserts = discordCardRefUpserts(
          discordMapRefKind,
          discordTargetRefTargetType,
          settings.targetId || channelId,
          channelId,
          discordMessage,
          settings,
          {
            source: 'discord_map_card_push_recovery',
            metadata: { language, trackingWriteFailed: true }
          }
        );
        try {
          recoveredMessageRefCount = await persistMessageRefs(
            recoveryRefUpserts.integrationMessageRefs || [],
            'discord_map_card_push_message_ref_recovery'
          );
        } catch (refError) {
          messageRefWriteError = refError;
        }
        await finishRun(operationRun, {
          status: 'failed',
          messageId: sentMessageId,
          channelId: normalizeText(discordMessage?.channel_id || channelId, discordIdMax),
          errorSummary: normalizeText(trackingWriteError.message || trackingWriteError, 500),
          retryable: true,
          metadata: {
            targetId: settings.targetId || '',
            targetName: settings.targetName || '',
            channelId,
            language,
            externalActionSucceeded: true,
            trackingWriteFailed: true,
            trackingWriteError: normalizeText(trackingWriteError.message || trackingWriteError, 240),
            messageRefRecovered: recoveredMessageRefCount > 0,
            messageRefWriteFailed: Boolean(messageRefWriteError),
            messageRefWriteError: normalizeText(messageRefWriteError?.message || '', 240)
          }
        });
        throw directWriteUnavailable('Discord 地图卡片状态记录', trackingWriteError);
      }
      await finishRun(operationRun, {
        status: 'succeeded',
        messageId: normalizeText(discordMessage?.id, 80),
        channelId: normalizeText(discordMessage?.channel_id || channelId, discordIdMax),
        metadata: { targetId: settings.targetId || '', targetName: settings.targetName || '', language }
      });
      const store = await readSettingsRuntimeStore();
      const messageId = normalizeText(discordMessage?.id, 80);
      const messageUrl = settings.guildId && channelId && messageId
        ? `https://discord.com/channels/${settings.guildId}/${channelId}/${messageId}`
        : '';
      send(res, {
        discord: toDiscordSettingsPayload(store),
        message: { id: messageId, url: messageUrl }
      });
    } catch (error) {
      next(error);
    }
  });
}
