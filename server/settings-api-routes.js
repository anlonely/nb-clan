import { appendLog } from './audit-logs.js';
import {
  readSettingsRuntimeStore,
  updateSettingsLogStore
} from './settings-store.js';
import {
  createId,
  hashPassword,
  normalizeText,
  nowIso
} from './store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function fail(res, status, error) {
  res.status(status).json({ ok: false, error });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerSettingsApiRoutes requires ${name}`);
  }
  return value;
}

function requiredFiniteNumber(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`registerSettingsApiRoutes requires ${name}`);
  }
  return number;
}

export function registerSettingsApiRoutes(router, {
  requireModuleView,
  requireModuleEdit,
  rootOnly,
  publicApiSettings,
  publicApiSettingsPayload,
  battlemetricsSettings,
  battlemetricsSettingsPayload,
  normalizeBattlemetricsApiKeys,
  steamWebApiSettings,
  steamWebApiSettingsPayload,
  battlemetricsQueueSnapshot,
  apiDocumentationMarkdown,
  publicApiTokenMinLength,
  publicApiTokenMaxLength,
  battlemetricsApiKeyMinLength,
  battlemetricsApiKeyMaxLength,
  steamWebApiKeyMinLength,
  steamWebApiKeyMaxLength
} = {}) {
  const requireApiView = requiredDependency('requireModuleView', requireModuleView)('api');
  const requireApiEdit = requiredDependency('requireModuleEdit', requireModuleEdit)('api');
  const enforceRootOnly = requiredDependency('rootOnly', rootOnly);
  const getPublicApiSettings = requiredDependency('publicApiSettings', publicApiSettings);
  const toPublicApiSettings = requiredDependency('publicApiSettingsPayload', publicApiSettingsPayload);
  const getBattlemetricsSettings = requiredDependency('battlemetricsSettings', battlemetricsSettings);
  const toBattlemetricsSettings = requiredDependency('battlemetricsSettingsPayload', battlemetricsSettingsPayload);
  const normalizeBattlemetricsKeys = requiredDependency('normalizeBattlemetricsApiKeys', normalizeBattlemetricsApiKeys);
  const getSteamWebApiSettings = requiredDependency('steamWebApiSettings', steamWebApiSettings);
  const toSteamWebApiSettings = requiredDependency('steamWebApiSettingsPayload', steamWebApiSettingsPayload);
  const queueSnapshot = requiredDependency('battlemetricsQueueSnapshot', battlemetricsQueueSnapshot);
  const buildApiDocumentationMarkdown = requiredDependency('apiDocumentationMarkdown', apiDocumentationMarkdown);
  const publicApiTokenMin = requiredFiniteNumber('publicApiTokenMinLength', publicApiTokenMinLength);
  const publicApiTokenMax = requiredFiniteNumber('publicApiTokenMaxLength', publicApiTokenMaxLength);
  const battlemetricsApiKeyMin = requiredFiniteNumber('battlemetricsApiKeyMinLength', battlemetricsApiKeyMinLength);
  const battlemetricsApiKeyMax = requiredFiniteNumber('battlemetricsApiKeyMaxLength', battlemetricsApiKeyMaxLength);
  const steamWebApiKeyMin = requiredFiniteNumber('steamWebApiKeyMinLength', steamWebApiKeyMinLength);
  const steamWebApiKeyMax = requiredFiniteNumber('steamWebApiKeyMaxLength', steamWebApiKeyMaxLength);

  router.get('/settings/battlemetrics/queue', requireApiView, async (_req, res, next) => {
    try {
      sendOk(res, { battlemetricsQueue: queueSnapshot() });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/api-doc', requireApiView, async (req, res, next) => {
    try {
      const markdown = buildApiDocumentationMarkdown(req);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="NB-Clan-API.md"');
      res.send(markdown);
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/public-api', requireApiView, async (_req, res, next) => {
    try {
      const store = await readSettingsRuntimeStore();
      sendOk(res, { publicApi: toPublicApiSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/public-api', requireApiEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      const token = String(req.body?.token || '').trim();
      if (token.length < publicApiTokenMin || token.length > publicApiTokenMax) {
        fail(res, 400, `Token 长度需要在 ${publicApiTokenMin}-${publicApiTokenMax} 位之间`);
        return;
      }
      const tokenHash = await hashPassword(token);
      await updateSettingsLogStore((store) => {
        const settings = getPublicApiSettings(store);
        settings.tokenHash = tokenHash;
        settings.tokenUpdatedAt = nowIso();
        appendLog(store, req, 'public_api_token_edit', '更新公开 API Token');
      }, 'public_api_token_update');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { publicApi: toPublicApiSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/settings/public-api', requireApiEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      await updateSettingsLogStore((store) => {
        const settings = getPublicApiSettings(store);
        settings.tokenHash = '';
        settings.tokenUpdatedAt = '';
        appendLog(store, req, 'public_api_token_edit', '清空公开 API Token');
      }, 'public_api_token_clear');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { publicApi: toPublicApiSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/battlemetrics', requireApiEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      const apiKey = String(req.body?.apiKey || '').trim();
      const label = normalizeText(req.body?.label, 80);
      if (apiKey.length < battlemetricsApiKeyMin || apiKey.length > battlemetricsApiKeyMax) {
        fail(res, 400, `BattleMetrics API Key 长度需要在 ${battlemetricsApiKeyMin}-${battlemetricsApiKeyMax} 位之间`);
        return;
      }
      await updateSettingsLogStore((store) => {
        const settings = getBattlemetricsSettings(store);
        const now = nowIso();
        const keys = normalizeBattlemetricsKeys(settings);
        const existing = keys.find((item) => item.apiKey === apiKey);
        if (existing) {
          existing.label = label || existing.label;
          existing.updatedAt = now;
        } else {
          keys.push({
            id: createId('bm_key'),
            label: label || `Token ${keys.length + 1}`,
            apiKey,
            createdAt: now,
            updatedAt: now
          });
        }
        settings.apiKeys = keys;
        settings.apiKey = keys[0]?.apiKey || '';
        settings.apiKeyUpdatedAt = now;
        settings.lastSyncError = '';
        appendLog(store, req, 'battlemetrics_api_key_edit', '更新 BattleMetrics API Key');
      }, 'battlemetrics_api_key_update');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { battlemetrics: toBattlemetricsSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/settings/battlemetrics', requireApiEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      const keyId = normalizeText(req.body?.id, 80);
      await updateSettingsLogStore((store) => {
        const settings = getBattlemetricsSettings(store);
        if (keyId) {
          settings.apiKeys = normalizeBattlemetricsKeys(settings).filter((item) => item.id !== keyId);
          settings.apiKey = settings.apiKeys[0]?.apiKey || '';
          settings.apiKeyUpdatedAt = settings.apiKeys[0]?.updatedAt || '';
        } else {
          settings.apiKeys = [];
          settings.apiKey = '';
          settings.apiKeyUpdatedAt = '';
          settings.lastSyncAt = '';
        }
        settings.lastSyncError = '';
        appendLog(store, req, 'battlemetrics_api_key_edit', keyId ? '删除 BattleMetrics API Key' : '清空 BattleMetrics API Key');
      }, 'battlemetrics_api_key_delete');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { battlemetrics: toBattlemetricsSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/settings/steam-web-api', requireApiEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      const apiKey = normalizeText(req.body?.apiKey, steamWebApiKeyMax);
      if (apiKey.length < steamWebApiKeyMin || apiKey.length > steamWebApiKeyMax) {
        fail(res, 400, `Steam Web API Key 长度需要在 ${steamWebApiKeyMin}-${steamWebApiKeyMax} 位之间`);
        return;
      }
      await updateSettingsLogStore((store) => {
        const settings = getSteamWebApiSettings(store);
        settings.apiKey = apiKey;
        settings.apiKeyUpdatedAt = nowIso();
        appendLog(store, req, 'steam_web_api_key_edit', '更新 Steam Web API Key');
      }, 'steam_web_api_key_update');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { steamWebApi: toSteamWebApiSettings(store) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/settings/steam-web-api', requireApiEdit, async (req, res, next) => {
    try {
      if (!enforceRootOnly(req, res)) return;
      await updateSettingsLogStore((store) => {
        const settings = getSteamWebApiSettings(store);
        settings.apiKey = '';
        settings.apiKeyUpdatedAt = '';
        appendLog(store, req, 'steam_web_api_key_edit', '清空 Steam Web API Key');
      }, 'steam_web_api_key_clear');
      const store = await readSettingsRuntimeStore();
      sendOk(res, { steamWebApi: toSteamWebApiSettings(store) });
    } catch (error) {
      next(error);
    }
  });
}
