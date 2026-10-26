import fs from 'node:fs';
import { assertLocalMode } from '../../local-mode.js';
import { createCandidateNotificationOwner, canonicalNotificationCatalog } from '../candidate-host/notifications.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createManagementRuntime } from '../management-runtime/index.js';
import { createProductionNotificationOwner } from './notifications.js';
import { createDiscordSteamProvider } from './discord-steam-provider.js';
import { createProductionNetwork } from './network.js';
import { createLocalSystemStorage } from '../system-admin/storage.js';
import { createCanonicalSourcePolicy } from '../management-adapters/source-policy/index.js';
import { createNativePlatformMetadata } from '../management-adapters/platform-native/index.js';
import { createCandidateProviders as createProviderOwner } from '../candidate-host/providers.js';
import { openProxyWebSocket } from '../source-providers/proxy-websocket.js';
import { IdentityError } from '../identity/errors.js';
import { publicOrigin as validateOrigin } from '../identity/providers.js';
import { VITAL_RUST_2X_SERVERS } from '../../vital-server-catalog.js';
import { createProductionWipeCatalog } from './wipe-catalog.js';
import { createProductionRelayIngress } from './relay.js';
import { createRustgoWebApiClient } from '../relay-admin/web-api-client.js';
import { createProductionRustgoWebApi } from './rustgo-web-api.js';
import { createProductionWechat, productionWechatSecretStatus } from './wechat.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (condition, code) => { if (!condition) throw new IdentityError(code, 503); };

/** The production composition owns the original API identity, scheduling and write queue.
 * Schema changes belong exclusively to the explicit maintenance command. */
export function createProductionComposition({ dataDirectory, databaseFile, publicOrigin, env = process.env }) {
  need(validateOrigin(publicOrigin) === publicOrigin, 'PRODUCTION_ORIGIN_REQUIRED');
  const localMode = assertLocalMode(env);
  const managedDirectory = path.join(dataDirectory, 'managed');
  fs.mkdirSync(managedDirectory, { recursive: true, mode: 0o700 });
  let identityRef, management, notifications, providerOwner, sourcePolicy, metadata, serializeWrite, steamLinksProvider;
  let acceptingRelay = false;
  let rustgoWebApi;
  const settings = () => identityRef?.repo.scalar('settings') || {};
  const network = createProductionNetwork({ readSettings: settings, env });
  const rustgoClient = createRustgoWebApiClient({ fetchImpl: (url, options) => network.serviceFetch('rustgo', url, options) });
  const wechatOwners = new WeakMap();
  const wechatFor = identity => {
    if (!wechatOwners.has(identity)) wechatOwners.set(identity, createProductionWechat({ identity, env, fetchImpl: network.fetchImpl }));
    return wechatOwners.get(identity);
  };
  function credentials(platform) {
    const saved = settings()[platform] || {}, prefix = platform.toUpperCase();
    return { botToken: saved.botToken || env[`NB_${prefix}_BOT_TOKEN`] || '',
      verifyToken: saved.verifyToken || env[`NB_${prefix}_VERIFY_TOKEN`] || '',
      encryptKey: saved.encryptKey || env[`NB_${prefix}_ENCRYPT_KEY`] || '',
      publicKey: saved.publicKey || env[`NB_${prefix}_PUBLIC_KEY`] || '',
      applicationId: saved.applicationId || env[`NB_${prefix}_APPLICATION_ID`] || '' };
  }
  const nativeCredentials = () => {
    const proxyEnabled = settings().system?.proxy?.enabled !== false;
    return {
      steamApiKey: env.NB_STEAM_WEB_API_KEY || env.STEAM_WEB_API_KEY || env.STEAM_API_KEY || '',
      battlemetricsApiKey: env.NB_BATTLEMETRICS_API_KEY || '', discordBotToken: credentials('discord').botToken,
      kookBotToken: credentials('kook').botToken,
      proxyUrl: proxyEnabled ? env.NB_PROXY_URL || '' : '', kdaProxyUrl: proxyEnabled ? env.NB_KDA_PROXY_URL || '' : '',
      battlemetricsProxyUrl: proxyEnabled ? env.NB_BATTLEMETRICS_PROXY_URL || '' : '', discordProxyUrl: proxyEnabled ? env.NB_DISCORD_PROXY_URL || '' : ''
    };
  };
  const platformService = () => management.getSystem(identityRef).platforms.service;
  const readCatalog = () => VITAL_RUST_2X_SERVERS.map(server => ({ ...server, serverProfileId: server.id }));
  const wipeCatalog = createProductionWipeCatalog({ readSettings: settings, env,
    fetchImpl: (url, options) => network.serviceFetch('global', url, options) });
  const control = () => identityRef.repo.scalar('v2ProductionCollection') || { enabled: false };
  function providersFor(identity) {
    if (providerOwner) return providerOwner;
    const capabilities = { steam: true, battlemetrics: true, vital: true, memberRisk: true, kookMemberSync: true,
      steamRisk: true, inventory: true, inventoryEnrichment: true, discordMembershipAudit: true,
      moose: true, scmm: true, rusthelp: true, storeCatalog: true, dlcCatalog: true };
    let chromium;
    try { const executablePath = fs.realpathSync(env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser');
      chromium = { executablePath, allowedExecutablePaths: [executablePath] }; } catch { /* unavailable is surfaced by the provider owner */ }
    const readConfiguration = () => ({ enabled: true, revision: hash(settings().accountRisk || {}), proxyUrl: network.proxyFor('kda') });
    providerOwner = createProviderOwner({ identity,
      sources: { capabilities, readCredentials: nativeCredentials, readProxyUrl: network.proxyFor, fetchImpl: network.fetchImpl, proxyFetch: network.proxyFetch },
      binding: { enabled: true, capabilities: { moose: true, inventory: true }, readConfiguration,
        readInventoryConfiguration: () => ({ enabled: true, revision: hash(settings().accountRisk || {}), prices: true, rusthelp: true, entitlements: false }),
        fetchImpl: network.fetchImpl, proxyFetch: network.proxyFetch, proxyWebSocket: openProxyWebSocket,
        ...(chromium ? { chromium } : {}), limits: { maxSessions: 2 } } });
    return providerOwner;
  }
  function policyFor(identity) {
    return sourcePolicy ||= createCanonicalSourcePolicy({ identity, getSystem: () => management.getSystem(identity),
      readControl: control, sourceBindings: providersFor(identity).sourceOptions });
  }
  const metadataFor = () => metadata ||= createNativePlatformMetadata({ getPlatformService: platformService,
    readCredentials: ({ platform }) => { const c = credentials(platform); return { botToken: c.botToken,
      revision: hash(c), transportKey: `production-${platform}` }; },
    // Match the community identity provider's native connection; source proxies belong to collectors.
    fetchImpl: network.fetchImpl });
  const vault = { statusSync({ db, platform }) {
    need(db === identityRef.repo.db, 'PRODUCTION_WRITE_OWNER_MISMATCH');
    return platform === 'wechat' ? productionWechatSecretStatus({ identity: identityRef, env }) : {};
  }, writeSync({ db, platform, values }) {
    need(db === identityRef.repo.db, 'PRODUCTION_WRITE_OWNER_MISMATCH');
    const current = settings();
    const key = platform === 'bridge' ? 'discordKookBridge' : platform;
    const next = { ...current, [key]: { ...current[key] } };
    for (const [name, value] of Object.entries(values)) {
      if (name.startsWith('route:')) {
        const id = name.slice(6, -':kookAccessToken'.length), routes = next[key].routes || [];
        need(routes.some(route => route.id === id), 'PRODUCTION_SECRET_ROUTE_REQUIRED');
        next[key].routes = routes.map(route => route.id === id ? { ...route, kookAccessToken: value } : route);
      } else next[key][name] = value;
    }
    identityRef.repo.setScalar('settings', next);
  } };
  const factories = {
    notificationRuntimeFactory: deps => notifications = localMode ? {
      ...createCandidateNotificationOwner({ ...deps, publicOrigin, getPlatformService: platformService }),
      catalog: canonicalNotificationCatalog(platformService)
    } : createProductionNotificationOwner({ ...deps, publicOrigin,
      // The configured KOOK webhook URL uses compress=0; keep native verification
      // aligned with the original wire bytes before any legacy event parsing.
      kookCompression: 'none',
      readServerCatalog: wipeCatalog.read, prepareServerCatalog: wipeCatalog.prepare,
      getPlatformService: platformService, readCredentials: credentials,
      steamLinksProvider: steamLinksProvider ||= createDiscordSteamProvider({
        getSourceHost: () => management.getSystem(identityRef).sourceHost,
        readCredentials: () => credentials('discord'),
        fetchImpl: (url, options) => network.serviceFetch('discord', url, options),
        readBattlemetricsProfile: steamId => {
          const matches = identityRef.repo.find('memberProfiles', 'steamId', steamId, 2);
          if (matches.length !== 1) return null;
          const profile = matches[0], member = identityRef.repo.get('members', profile.memberId);
          if (!member || member.steamId !== steamId || profile.steamId !== steamId) return null;
          // Project only the observed game statistics. Website identities,
          // contact details and moderation notes never reach this bot module.
          return Object.fromEntries(['steamId', 'battlemetricsPlayerId', 'battlemetricsServerId', 'battlemetricsWipeId',
            'battlemetricsServerPlayTimeSeconds', 'battlemetricsSyncedAt', 'battlemetricsRangeStartAt',
            'battlemetricsRangeStopAt', 'battlemetricsSessionTruncated'].map(key => [key, profile[key]]));
        }
      }),
      fetchImpl: (url, options) => network.serviceFetch('global', url, options),
      getCardViewHandler: identity => proof => management.getSystem(identity).platformHost.viewDiscordCard(proof),
      getCommunityHandler: (identity, platform) => proof => management.getSystem(identity).platformHost.community[platform].handleVerified(proof) }),
    managementRuntimeFactory: deps => {
      serializeWrite = deps.runStoreWriteTask;
      return management = createManagementRuntime({ ...deps, intervalMs: 1000,
      electricianAvatarOptions: { fetchImpl: (url, options) => network.serviceFetch('steam', url, options) },
      memberOptions: () => ({}),
      sourceHostOptions: identity => ({ ...providersFor(identity).sourceOptions,
        readCredentials: policyFor(identity).readCredentials, readDiscordSettings: policyFor(identity).readDiscordSettings }),
      sourceAdminOptions: identity => ({ readRuntimeStatus: policyFor(identity).readRuntimeStatus }),
      memberFollowupOptions: identity => ({ readPolicy: policyFor(identity).readPolicy, readPrincipal: policyFor(identity).readPrincipal,
        readSourceConfig: policyFor(identity).readFollowupSourceConfig }),
      relayAdminOptions: () => ({ webApiOptions: { runStoreWriteTask: deps.runStoreWriteTask,
        discoverServers: config => rustgoClient.listServers(config),
        readStatus: () => rustgoWebApi?.status() || { state: 'unavailable' } } }),
      realtimeOptions: () => ({ sourceReset: ({ apply }) => apply() }),
      adminExtrasOptions: () => ({ readCatalog }),
      platformMediaOptions: identity => wechatFor(identity).mediaOptions,
      platformHostOptions: identity => ({ ...(wechatFor(identity).miniOptions ? { wechat: wechatFor(identity).miniOptions } : {}),
        g06: { platforms: notifications.getSystem(identity).service.platforms,
        targets: () => notifications.catalog.listTargets() } }),
      platformAdapters: () => ({ vault, platform: metadataFor().platformMetadata }),
      systemOptions: identity => ({ storage: createLocalSystemStorage({ db: identity.repo.db,
        directory: managedDirectory, databaseFile }),
        probe: async ({ service, signal }) => {
          const started = Date.now();
          try {
            const response = await network.serviceFetch(service, 'https://example.com/', { signal });
            await response.body?.cancel?.();
            return { status: 'reachable', httpStatus: response.status, durationMs: Date.now() - started };
          } catch {
            return { status: 'unreachable', durationMs: Date.now() - started };
          }
        } }) });
    }
  };
  async function start(api) {
    identityRef = await api.v2Runtime.getIdentity();
    const system = management.getSystem(identityRef), notification = notifications.getSystem(identityRef);
    need(system.identity === identityRef && system.scheduling === notification.service.scheduling &&
      api.v2Runtime.getMemberSpace(identityRef).scheduling === system.scheduling, 'PRODUCTION_SHARED_OWNER_MISMATCH');
    if (control().enabled) policyFor(identityRef).readPrincipal();
    await api.v2Runtime.start();
    acceptingRelay = true;
    rustgoWebApi = createProductionRustgoWebApi({ identity: identityRef, repository: system.realtime.repository,
      configuration: system.relayAdmin.webApi, client: rustgoClient, ingestRelay,
      runOperation: fn => management.runOperation(fn), serializeWrite: fn => serializeWrite(fn) });
    rustgoWebApi.start();
  }
  const ingestRelay = createProductionRelayIngress({
    getRepository: () => management.getSystem(identityRef).realtime.repository,
    runOperation: fn => management.runOperation(fn),
    serializeWrite: fn => serializeWrite(fn),
    isAccepting: () => acceptingRelay && typeof serializeWrite === 'function'
  });
  async function stop() {
    acceptingRelay = false;
    await rustgoWebApi?.stop();
    await Promise.all([metadata?.stop(), providerOwner?.stop(), steamLinksProvider?.stop()]);
    network.stop();
  }
  return { factories, start, stop, ingestRelay, diagnostics: () => ({ mode: 'production', owners: Boolean(management && notifications),
    legacyBackgroundDisabled: env.NB_DISABLE_BACKGROUND_JOBS === '1', collectionEnabled: Boolean(identityRef && control().enabled) }) };
}
