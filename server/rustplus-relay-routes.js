import { appendLogDirect } from './audit-logs.js';
import { normalizeText } from './store.js';

const DISCORD_ID_MAX_LENGTH = 32;
const KOOK_ID_MAX_LENGTH = 80;
const KOOK_PIPE_ACCESS_TOKEN_MIN_LENGTH = 8;
const KOOK_PIPE_ACCESS_TOKEN_MAX_LENGTH = 4096;
const KOOK_PIPE_TEMPLATE_ID_MAX_LENGTH = 80;

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function sendFail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerRustplusRelayRoutes requires ${name}`);
  }
  return value;
}

function nonNegativeInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.min(numeric, max);
}

function queryHasAnyKey(query = {}, keys = []) {
  return keys.some((key) => Object.hasOwn(query || {}, key));
}

function relayCollectionScopeFromQuery(query = {}, { offsetKeys = [], limitKeys = [] } = {}) {
  const hasLimit = queryHasAnyKey(query, limitKeys);
  const firstValue = (keys) => {
    for (const key of keys) {
      if (Object.hasOwn(query || {}, key)) return query[key];
    }
    return undefined;
  };
  return {
    clientId: normalizeText(query.clientId || query.client_id, 80),
    serverKey: normalizeText(query.serverKey || query.server_key, 180),
    hasLimit,
    offset: nonNegativeInteger(firstValue(offsetKeys), 0),
    limit: hasLimit ? nonNegativeInteger(firstValue(limitKeys), 0, 1000) : undefined
  };
}

export function registerRustplusRelayReadRoutes(router, {
  requireAuth,
  requireAnyModuleView,
  readRustplusRelaySettingsRuntimeStore,
  readRustplusRelayRuntimeStore,
  rustplusRelaySettingsPayload,
  rustplusRelayScopeAccess,
  publicRustplusRelayApiState,
  publicRustplusRelayApiPart,
  openRustplusRelayEventStream,
  enrichRustplusRelayStateWithMemberOnline,
  scopedRustplusRelayState
} = {}) {
  const ensureAuth = requiredDependency('requireAuth', requireAuth);
  const requireView = requiredDependency('requireAnyModuleView', requireAnyModuleView);
  const readSettingsStore = requiredDependency('readRustplusRelaySettingsRuntimeStore', readRustplusRelaySettingsRuntimeStore);
  const readRuntimeStore = requiredDependency('readRustplusRelayRuntimeStore', readRustplusRelayRuntimeStore);
  const settingsPayload = requiredDependency('rustplusRelaySettingsPayload', rustplusRelaySettingsPayload);
  const scopeAccess = requiredDependency('rustplusRelayScopeAccess', rustplusRelayScopeAccess);
  const publicApiState = requiredDependency('publicRustplusRelayApiState', publicRustplusRelayApiState);
  const publicApiPart = requiredDependency('publicRustplusRelayApiPart', publicRustplusRelayApiPart);
  const openEventStream = requiredDependency('openRustplusRelayEventStream', openRustplusRelayEventStream);
  const enrichState = requiredDependency('enrichRustplusRelayStateWithMemberOnline', enrichRustplusRelayStateWithMemberOnline);
  const scopedState = requiredDependency('scopedRustplusRelayState', scopedRustplusRelayState);

  router.get('/settings/rustplus-relay', requireView(['api', 'rustTools']), async (_req, res, next) => {
    try {
      const store = await readSettingsStore();
      sendOk(res, { rustplusRelay: settingsPayload(store) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rustplus-relay', ensureAuth, async (req, res, next) => {
    try {
      const store = await readRuntimeStore();
      const scope = scopeAccess(store, req.user, req.query?.scope);
      if (!scope) {
        sendFail(res, 403, '无权查看该模块');
        return;
      }
      sendOk(res, { relay: publicApiState(store, req.query || {}, { scope }) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rustplus-relay/summary', ensureAuth, async (req, res, next) => {
    try {
      const store = await readRuntimeStore();
      const scope = scopeAccess(store, req.user, req.query?.scope);
      if (!scope) {
        sendFail(res, 403, '无权查看该模块');
        return;
      }
      const relay = publicApiState(store, req.query || {}, { scope });
      sendOk(res, { relay: publicApiPart(relay, 'summary') });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rustplus-relay/members', ensureAuth, async (req, res, next) => {
    try {
      const store = await readRuntimeStore({
        collections: {
          chatMessages: false,
          inviteRecords: false
        }
      });
      const scope = scopeAccess(store, req.user, 'info');
      if (!scope) {
        sendFail(res, 403, '无权查看该模块');
        return;
      }
      const relay = publicApiState(store, { ...(req.query || {}), includeInviteRecords: '0' }, { scope });
      sendOk(res, { relay: publicApiPart(relay, 'members') });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rustplus-relay/chats', ensureAuth, async (req, res, next) => {
    try {
      const store = await readRuntimeStore({
        collections: {
          chatMessages: relayCollectionScopeFromQuery(req.query || {}, {
            offsetKeys: ['chatOffset', 'chat_offset'],
            limitKeys: ['chatLimit', 'chat_limit']
          }),
          inviteRecords: false
        }
      });
      const scope = scopeAccess(store, req.user, 'chat');
      if (!scope) {
        sendFail(res, 403, '无权查看该模块');
        return;
      }
      const relay = publicApiState(store, { ...(req.query || {}), includeInviteRecords: '0' }, { scope });
      sendOk(res, { relay: publicApiPart(relay, 'chats') });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rustplus-relay/invites', ensureAuth, async (req, res, next) => {
    try {
      const store = await readRuntimeStore({
        collections: {
          chatMessages: false,
          inviteRecords: relayCollectionScopeFromQuery(req.query || {}, {
            offsetKeys: ['inviteRecordOffset', 'invite_record_offset', 'inviteOffset', 'invite_offset'],
            limitKeys: ['inviteRecordLimit', 'invite_record_limit', 'inviteLimit', 'invite_limit']
          })
        }
      });
      const scope = scopeAccess(store, req.user, 'info');
      if (!scope) {
        sendFail(res, 403, '无权查看该模块');
        return;
      }
      const relay = publicApiState(store, { ...(req.query || {}), includeInviteRecords: '1' }, { scope });
      sendOk(res, { relay: publicApiPart(relay, 'invites') });
    } catch (error) {
      next(error);
    }
  });

  router.get('/rustplus-relay/events', ensureAuth, async (req, res, next) => {
    try {
      const store = await readRuntimeStore();
      const scope = scopeAccess(store, req.user, req.query?.scope);
      if (!scope) {
        sendFail(res, 403, '无权查看该模块');
        return;
      }
      const unsubscribe = openEventStream(
        res,
        publicApiState(store, req.query || {}, { scope }),
        (payload) => ({
          ...payload,
          relay: scopedState(enrichState(store, payload.relay || {}), scope)
        })
      );
      req.on('close', unsubscribe);
    } catch (error) {
      next(error);
    }
  });
}

export function registerRustplusRelayWriteRoutes(router, {
  requireAnyModuleEdit,
  readRustplusRelaySettingsRuntimeStore,
  readRustplusRelayRuntimeStore,
  saveRustplusRelayToken,
  clearRustplusRelayToken,
  clearRustplusRelayChatMessages,
  resetRustplusRelayData,
  saveRustplusRelayDiscordForwarding,
  rustplusRelaySettings,
  rustplusRelaySettingsPayload,
  publicRustplusRelayState,
  publicRustplusRelayApiState,
  publicRustplusRelayApiPart,
  discordSettings,
  discordSettingsForTarget,
  discordBotToken,
  sendDiscordChannelMessage,
  buildRustplusRelayDiscordMessage,
  markRustplusRelayDiscordPush,
  isDiscordSnowflake,
  resetRustplusRelayAuthCache
} = {}) {
  const requireEdit = requiredDependency('requireAnyModuleEdit', requireAnyModuleEdit);
  const readSettingsStore = requiredDependency('readRustplusRelaySettingsRuntimeStore', readRustplusRelaySettingsRuntimeStore);
  const readRuntimeStore = requiredDependency('readRustplusRelayRuntimeStore', readRustplusRelayRuntimeStore);
  const saveToken = requiredDependency('saveRustplusRelayToken', saveRustplusRelayToken);
  const clearToken = requiredDependency('clearRustplusRelayToken', clearRustplusRelayToken);
  const clearChatMessages = requiredDependency('clearRustplusRelayChatMessages', clearRustplusRelayChatMessages);
  const resetRelayData = requiredDependency('resetRustplusRelayData', resetRustplusRelayData);
  const saveForwarding = requiredDependency('saveRustplusRelayDiscordForwarding', saveRustplusRelayDiscordForwarding);
  const relaySettings = requiredDependency('rustplusRelaySettings', rustplusRelaySettings);
  const settingsPayload = requiredDependency('rustplusRelaySettingsPayload', rustplusRelaySettingsPayload);
  const publicState = requiredDependency('publicRustplusRelayState', publicRustplusRelayState);
  const publicApiState = requiredDependency('publicRustplusRelayApiState', publicRustplusRelayApiState);
  const publicApiPart = requiredDependency('publicRustplusRelayApiPart', publicRustplusRelayApiPart);
  const getDiscordSettings = requiredDependency('discordSettings', discordSettings);
  const settingsForTarget = requiredDependency('discordSettingsForTarget', discordSettingsForTarget);
  const botToken = requiredDependency('discordBotToken', discordBotToken);
  const sendDiscordMessage = requiredDependency('sendDiscordChannelMessage', sendDiscordChannelMessage);
  const buildDiscordMessage = requiredDependency('buildRustplusRelayDiscordMessage', buildRustplusRelayDiscordMessage);
  const markDiscordPush = requiredDependency('markRustplusRelayDiscordPush', markRustplusRelayDiscordPush);
  const snowflakeValid = requiredDependency('isDiscordSnowflake', isDiscordSnowflake);
  const resetAuthCache = typeof resetRustplusRelayAuthCache === 'function' ? resetRustplusRelayAuthCache : () => {};

  router.put('/settings/rustplus-relay', requireEdit(['api', 'rustTools']), async (req, res, next) => {
    try {
      const rustplusRelay = await saveToken(req.body?.token || '');
      resetAuthCache();
      await appendLogDirect(req, 'rustplus_relay_token_edit', 'Updated Rust+ relay token');
      sendOk(res, { rustplusRelay });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/settings/rustplus-relay', requireEdit(['api', 'rustTools']), async (req, res, next) => {
    try {
      const rustplusRelay = await clearToken();
      resetAuthCache();
      await appendLogDirect(req, 'rustplus_relay_token_edit', 'Cleared Rust+ relay token');
      sendOk(res, { rustplusRelay });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/rustplus-relay/chats', requireEdit(['rustClanChat', 'rustTools']), async (req, res, next) => {
    try {
      await clearChatMessages();
      await appendLogDirect(req, 'rustplus_relay_chat_clear', 'Cleared Rust+ clan chat records');
      const store = await readRuntimeStore();
      const relay = publicApiState(store, req.query || {}, { scope: 'chat' });
      sendOk(res, { relay: publicApiPart(relay, 'chats') });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/rustplus-relay', requireEdit(['rustClanInfo', 'rustTools']), async (req, res, next) => {
    try {
      await resetRelayData();
      await appendLogDirect(req, 'rustplus_relay_data_reset', 'Reset Rust+ clan relay data');
      const store = await readRuntimeStore();
      const relay = publicApiState(store, req.query || {}, { scope: 'info' });
      sendOk(res, { relay: publicApiPart(relay, 'members') });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/rustplus-relay/discord-forwarding', requireEdit(['rustClanChat', 'rustTools']), async (req, res, next) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const snapshot = await readSettingsStore({ includeCounts: false });
      const previousForwarding = relaySettings(snapshot).discordForwarding || {};
      const previousRoutes = Array.isArray(previousForwarding.routes) ? previousForwarding.routes : [];
      const previousRouteFor = (route = {}) => previousRoutes.find((item) => (
        item.id === route.id ||
          (route.serverKey && item.serverKey === route.serverKey) ||
          (route.platform === 'kook' && route.kookChannelId && item.kookChannelId === route.kookChannelId)
      )) || {};
      const rawRoutes = Array.isArray(req.body?.routes) ? req.body.routes : [{
        enabled: true,
        platform: req.body?.platform,
        clientId: req.body?.clientId,
        serverKey: req.body?.serverKey,
        serverId: req.body?.serverId,
        serverName: req.body?.serverName,
        targetId: req.body?.targetId,
        targetName: req.body?.targetName,
        guildId: req.body?.guildId,
        channelId: req.body?.channelId,
        kookAccessToken: req.body?.kookAccessToken,
        kookChannelId: req.body?.kookChannelId,
        kookTemplateId: req.body?.kookTemplateId,
        clearKookAccessToken: req.body?.clearKookAccessToken
      }];
      const routes = rawRoutes.map((route) => ({
        ...route,
        platform: normalizeText(route?.platform, 20).toLowerCase() === 'kook' ? 'kook' : 'discord',
        guildId: normalizeText(route?.guildId, DISCORD_ID_MAX_LENGTH),
        channelId: normalizeText(route?.channelId, DISCORD_ID_MAX_LENGTH),
        kookAccessToken: normalizeText(route?.kookAccessToken, KOOK_PIPE_ACCESS_TOKEN_MAX_LENGTH),
        kookAccessTokenConfigured: Boolean(route?.kookAccessTokenConfigured),
        clearKookAccessToken: Boolean(route?.clearKookAccessToken),
        kookChannelId: normalizeText(route?.kookChannelId, KOOK_ID_MAX_LENGTH),
        kookTemplateId: normalizeText(route?.kookTemplateId, KOOK_PIPE_TEMPLATE_ID_MAX_LENGTH),
        serverKey: normalizeText(route?.serverKey, 180)
      }));
      const activeRoutes = routes.filter((route) => (
        route.enabled !== false &&
        (route.platform === 'kook'
          ? (route.kookAccessToken || route.kookAccessTokenConfigured || route.kookChannelId || route.kookTemplateId || route.serverKey)
          : (route.guildId || route.channelId || route.targetId || route.serverKey))
      ));
      if (enabled && !activeRoutes.length) {
        sendFail(res, 400, 'At least one third-party forwarding target is required.');
        return;
      }
      for (const route of activeRoutes) {
        if (route.platform === 'kook') {
          const previousRoute = previousRouteFor(route);
          const effectiveAccessToken = route.clearKookAccessToken ? '' : (route.kookAccessToken || previousRoute.kookAccessToken || '');
          if (!effectiveAccessToken || !route.kookChannelId) {
            sendFail(res, 400, 'KOOK Access Token and Channel ID are required.');
            return;
          }
          if (effectiveAccessToken.length < KOOK_PIPE_ACCESS_TOKEN_MIN_LENGTH || effectiveAccessToken.length > KOOK_PIPE_ACCESS_TOKEN_MAX_LENGTH) {
            sendFail(res, 400, `KOOK Access Token length must be between ${KOOK_PIPE_ACCESS_TOKEN_MIN_LENGTH} and ${KOOK_PIPE_ACCESS_TOKEN_MAX_LENGTH} characters.`);
            return;
          }
          if (!/^\d{6,32}$/.test(route.kookChannelId)) {
            sendFail(res, 400, 'KOOK Channel ID is invalid.');
            return;
          }
          continue;
        }
        if (!route.guildId || !route.channelId) {
          sendFail(res, 400, 'Discord Guild ID and Channel ID are required.');
          return;
        }
        if (!snowflakeValid(route.guildId) || !snowflakeValid(route.channelId)) {
          sendFail(res, 400, 'Discord Guild ID or Channel ID is invalid.');
          return;
        }
      }
      const rustplusRelay = await saveForwarding({
        enabled,
        routes
      });
      await appendLogDirect(req, 'rustplus_relay_discord_forwarding_edit', enabled ? 'Enabled Rust+ clan chat third-party forwarding' : 'Disabled Rust+ clan chat third-party forwarding', {
        metadata: {
          routeCount: activeRoutes.length,
          platforms: activeRoutes.map((route) => route.platform || 'discord').join(', '),
          channelIds: activeRoutes.map((route) => normalizeText(route.platform === 'kook' ? route.kookChannelId : route.channelId, KOOK_ID_MAX_LENGTH)).join(', '),
          guildIds: activeRoutes.map((route) => normalizeText(route.guildId, DISCORD_ID_MAX_LENGTH)).join(', ')
        }
      });
      const store = await readRuntimeStore();
      sendOk(res, {
        rustplusRelay,
        relay: publicApiState(store, req.body || {}, { scope: 'chat' })
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/rustplus-relay/discord', requireEdit(['rustClanChat', 'rustTools']), async (req, res, next) => {
    try {
      const snapshot = await readRuntimeStore();
      const relayState = publicState(snapshot, req.body || {});
      if (!relayState.server) {
        sendFail(res, 404, 'Rust+ relay server data does not exist.');
        return;
      }
      const settings = settingsForTarget(getDiscordSettings(snapshot), req.body?.targetId);
      const channelId = normalizeText(req.body?.channelId, DISCORD_ID_MAX_LENGTH) || settings.channelId;
      if (!botToken(settings) || !channelId) {
        sendFail(res, 400, 'Discord Bot Token or Channel ID is not configured.');
        return;
      }
      const message = buildDiscordMessage(relayState, {
        title: normalizeText(req.body?.title, 120)
      });
      let discordMessage;
      try {
        discordMessage = await sendDiscordMessage(settings, message, channelId);
      } catch (error) {
        await markDiscordPush({}, error).catch(() => {});
        throw error;
      }
      try {
        await markDiscordPush(discordMessage);
      } catch (error) {
        const messageId = normalizeText(discordMessage?.id, 80);
        throw Object.assign(
          new Error(`Rust+ Discord 推送已发送${messageId ? `（messageId: ${messageId}）` : ''}，但本地追踪写入失败，请勿重复点击，稍后刷新确认。`),
          {
            status: 503,
            code: 'rustplus_relay_discord_push_tracking_failed',
            skipApiErrorLog: true,
            cause: error,
            messageId,
            channelId
          }
        );
      }
      await appendLogDirect(req, 'rustplus_relay_discord_push', 'Pushed Rust+ relay summary to Discord', {
        metadata: {
          messageId: discordMessage?.id || '',
          channelId,
          targetId: settings.targetId || '',
          targetName: settings.targetName || '',
          serverKey: relayState.selected?.serverKey || ''
        }
      });
      const store = await readRuntimeStore();
      const messageId = normalizeText(discordMessage?.id, 80);
      const messageUrl = settings.guildId && channelId && messageId
        ? `https://discord.com/channels/${settings.guildId}/${channelId}/${messageId}`
        : '';
      sendOk(res, {
        rustplusRelay: settingsPayload(store),
        relay: publicApiState(store, req.body || {}),
        message: {
          id: messageId,
          url: messageUrl
        }
      });
    } catch (error) {
      next(error);
    }
  });
}
