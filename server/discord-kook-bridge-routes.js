import {
  appendLog,
  appendLogDirect,
  requestActorUserId
} from './audit-logs.js';
import {
  readSettingsRuntimeStore,
  updateSettingsLogStore
} from './settings-store.js';
import { normalizeText, nowIso } from './store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerDiscordKookBridgeRoutes requires ${name}`);
  }
  return value;
}

export function registerDiscordKookBridgeRoutes(router, {
  requireModuleView,
  requireModuleEdit,
  discordKookBridgeSettings,
  normalizeDiscordKookBridgeInput,
  resetDiscordKookBridgeRouteCursors,
  discordKookBridgePayload,
  refreshDiscordKookBridgeScheduleCache,
  runDiscordKookBridgeSync,
  canEditBridgeCredentials,
  routeIdMaxLength = 80
} = {}) {
  const requireBridgeView = requiredDependency('requireModuleView', requireModuleView)('discordKookSync');
  const requireBridgeEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('discordKookSync');
  const bridgeSettings = requiredDependency('discordKookBridgeSettings', discordKookBridgeSettings);
  const normalizeBridgeInput = requiredDependency('normalizeDiscordKookBridgeInput', normalizeDiscordKookBridgeInput);
  const resetRouteCursors = requiredDependency('resetDiscordKookBridgeRouteCursors', resetDiscordKookBridgeRouteCursors);
  const bridgePayload = requiredDependency('discordKookBridgePayload', discordKookBridgePayload);
  const refreshScheduleCache = requiredDependency('refreshDiscordKookBridgeScheduleCache', refreshDiscordKookBridgeScheduleCache);
  const runBridgeSync = requiredDependency('runDiscordKookBridgeSync', runDiscordKookBridgeSync);
  const canEditCredentials = requiredDependency('canEditBridgeCredentials', canEditBridgeCredentials);

  router.get('/settings/discord-kook-bridge', requireBridgeView, async (_req, res, next) => {
    try {
      const store = await readSettingsRuntimeStore();
      sendOk(res, { bridge: bridgePayload(store) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/discord-kook-bridge', requireBridgeEdit, async (req, res, next) => {
    try {
      let bridge = null;
      let scheduleSettings = null;
      await updateSettingsLogStore((store) => {
        const settings = bridgeSettings(store);
        const credentialEditor = Boolean(canEditCredentials(req));
        const requestedBody = { ...(req.body || {}) };
        if (!credentialEditor) {
          if (normalizeText(requestedBody.translationApiKey, 4096) || requestedBody.clearTranslationApiKey) {
            throw Object.assign(new Error('只有 root 可以修改翻译 API 凭据'), { status: 403 });
          }
          delete requestedBody.translationApiKey;
          delete requestedBody.clearTranslationApiKey;
          delete requestedBody.translationBaseUrl;
        }
        const nextSettings = normalizeBridgeInput(requestedBody, settings);
        settings.enabled = nextSettings.enabled;
        if (nextSettings.translationApiKey) {
          settings.translationApiKey = nextSettings.translationApiKey;
          settings.translationApiKeyUpdatedAt = nowIso();
        } else if (nextSettings.clearTranslationApiKey) {
          settings.translationApiKey = '';
          settings.translationApiKeyUpdatedAt = '';
        }
        settings.translationBaseUrl = nextSettings.translationBaseUrl;
        settings.translationModel = nextSettings.translationModel;
        settings.pollIntervalMs = nextSettings.pollIntervalMs;
        settings.routes = nextSettings.routes.map((route) => ({
          ...route,
          updatedAt: nowIso()
        }));
        if (requestedBody.resetCursors) {
          for (const route of settings.routes) {
            resetRouteCursors(route);
          }
        } else if (Array.isArray(requestedBody.resetRouteIds) && requestedBody.resetRouteIds.length) {
          const resetRouteIds = new Set(requestedBody.resetRouteIds.map((id) => normalizeText(id, routeIdMaxLength)).filter(Boolean));
          for (const route of settings.routes) {
            if (!resetRouteIds.has(route.id)) continue;
            resetRouteCursors(route);
          }
        }
        settings.updatedAt = nowIso();
        settings.lastSyncError = '';
        scheduleSettings = settings;
        appendLog(store, req, 'discord_kook_bridge_settings_edit', 'Updated Discord-KOOK bridge settings', {
          metadata: {
            enabled: settings.enabled,
            routeCount: settings.routes.length,
            enabledRouteCount: settings.routes.filter((route) => route.enabled).length,
            resetCursors: Boolean(requestedBody.resetCursors),
            credentialsEdited: credentialEditor && Boolean(
              normalizeText(requestedBody.translationApiKey, 4096) ||
              requestedBody.clearTranslationApiKey ||
              Object.hasOwn(requestedBody, 'translationBaseUrl')
            )
          }
        });
        bridge = bridgePayload(store);
      }, 'discord_kook_bridge_settings_update');
      if (scheduleSettings) refreshScheduleCache(scheduleSettings);
      sendOk(res, { bridge });
    } catch (error) {
      next(error);
    }
  });

  router.post('/settings/discord-kook-bridge/sync', requireBridgeEdit, async (req, res, next) => {
    try {
      const result = await runBridgeSync({
        manual: true,
        routeId: req.body?.routeId,
        createdBy: requestActorUserId(req)
      });
      const { operationRun: _operationRun, ...logResult } = result || {};
      await appendLogDirect(req, 'discord_kook_bridge_manual_sync', 'Ran Discord-KOOK bridge sync', {
        metadata: logResult
      });
      const store = await readSettingsRuntimeStore();
      sendOk(res, { result, bridge: bridgePayload(store) });
    } catch (error) {
      next(error);
    }
  });
}
