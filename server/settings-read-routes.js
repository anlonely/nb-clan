import {
  readSettingsPermissionRuntimeStore,
  readSettingsRuntimeStore
} from './settings-store.js';

function sendOk(res, data = {}) {
  res.json({ ok: true, ...data });
}

function requiredDependency(name, value) {
  if (typeof value !== 'function') {
    throw new TypeError(`registerSettingsReadRoutes requires ${name}`);
  }
  return value;
}

export function registerSettingsReadRoutes(router, {
  requireAuth,
  requireModuleView,
  requireAnyModuleView,
  canViewModuleInStore,
  isRootUser,
  publicApiSettingsPayload,
  rustplusRelaySettingsPayload,
  battlemetricsSettingsPayload,
  steamWebApiSettingsPayload,
  battlemetricsQueueSnapshot,
  discordSettingsPayload,
  kookSettingsPayload,
  systemBrandingPayload,
  systemSettingsPayload,
  publicThirdPartyLoginSettings
} = {}) {
  const requireLogin = requiredDependency('requireAuth', requireAuth);
  const requireSystemView = requiredDependency('requireModuleView', requireModuleView)('system');
  const requireSettingsApiView = requiredDependency('requireAnyModuleView', requireAnyModuleView)(['api', 'discordBot', 'kookBot']);
  const canViewModule = requiredDependency('canViewModuleInStore', canViewModuleInStore);
  const checkRoot = requiredDependency('isRootUser', isRootUser);
  const toPublicApiSettings = requiredDependency('publicApiSettingsPayload', publicApiSettingsPayload);
  const toRustplusRelaySettings = requiredDependency('rustplusRelaySettingsPayload', rustplusRelaySettingsPayload);
  const toBattlemetricsSettings = requiredDependency('battlemetricsSettingsPayload', battlemetricsSettingsPayload);
  const toSteamWebApiSettings = requiredDependency('steamWebApiSettingsPayload', steamWebApiSettingsPayload);
  const queueSnapshot = requiredDependency('battlemetricsQueueSnapshot', battlemetricsQueueSnapshot);
  const toDiscordSettings = requiredDependency('discordSettingsPayload', discordSettingsPayload);
  const toKookSettings = requiredDependency('kookSettingsPayload', kookSettingsPayload);
  const toSystemBranding = requiredDependency('systemBrandingPayload', systemBrandingPayload);
  const toSystemSettings = requiredDependency('systemSettingsPayload', systemSettingsPayload);
  const toThirdPartyLoginSettings = requiredDependency('publicThirdPartyLoginSettings', publicThirdPartyLoginSettings);

  router.get('/settings/api', requireSettingsApiView, async (req, res, next) => {
    try {
      const store = await readSettingsPermissionRuntimeStore();
      const canViewApi = canViewModule(store, req.user, 'api');
      const canViewDiscord = canViewModule(store, req.user, 'discordBot');
      const canViewKook = canViewModule(store, req.user, 'kookBot');
      const payload = {};
      if (canViewApi) {
        payload.publicApi = toPublicApiSettings(store);
        payload.rustplusRelay = toRustplusRelaySettings(store);
        payload.battlemetrics = toBattlemetricsSettings(store);
        payload.steamWebApi = toSteamWebApiSettings(store);
        payload.battlemetricsQueue = queueSnapshot();
      }
      if (canViewDiscord) {
        payload.discord = toDiscordSettings(store);
      }
      if (canViewKook) {
        payload.kook = toKookSettings(store);
      }
      sendOk(res, payload);
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/branding', requireLogin, async (_req, res, next) => {
    try {
      const store = await readSettingsRuntimeStore();
      sendOk(res, { system: toSystemBranding(store) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/system', requireSystemView, async (req, res, next) => {
    try {
      const store = await readSettingsRuntimeStore();
      const root = checkRoot(req.user);
      sendOk(res, { system: await toSystemSettings(store, { includeSensitive: root, includeStorage: true }) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/settings/third-party-login', requireSystemView, async (req, res, next) => {
    try {
      const store = await readSettingsPermissionRuntimeStore();
      sendOk(res, { thirdPartyLogin: toThirdPartyLoginSettings(store, req.user) });
    } catch (error) {
      next(error);
    }
  });
}
