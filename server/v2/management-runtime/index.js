import { createHexQuery } from '../hex-query/index.js';
import { createRelayAdmin, createRelayAdminRouter } from '../relay-admin/index.js';
import { createVipNotifications } from '../vip-notifications/index.js';
import { createMemberFollowups } from '../member-followups/index.js';
import express from 'express';
import { IdentityError } from '../identity/errors.js';
import { MemberAdminService } from '../member-admin/service.js';
import { createMemberAdminRouter } from '../member-admin/routes.js';
import { StatsService } from '../stats/service.js';
import { createExportRenderer } from '../stats/exports.js';
import { createStatsRouter } from '../stats/routes.js';
import { SyncCenterService } from '../sync-center/service.js';
import { createSyncCenterWorker } from '../sync-center/worker.js';
import { createSyncCenterRouter } from '../sync-center/routes.js';
import { createSqliteSyncAuthority } from '../sync-center/authority.js';
import { createManagementWrites } from './cache.js';
import { RealtimeRepository } from '../realtime/repository.js';
import { createRealtimeRouter } from '../realtime/routes.js';
import { createRealtimeStreamOwner } from '../realtime/stream.js';
import { PlatformAdminService } from '../platform-admin/service.js';
import { createPlatformAdminRouter } from '../platform-admin/routes.js';
import { createPublicElectriciansRouter } from '../platform-admin/public-electricians.js';
import { PlatformAdminRepository } from '../platform-admin/repository.js';
import { createElectricianAvatars, storedSteamAvatar } from '../platform-admin/electrician-avatars.js';
import { readElectricianRoster, resolveElectricianRoster } from '../platform-admin/electrician-roster.js';
import { createPublishedPlatformAdapters } from '../platform-admin/published-services.js';
import { createManagedSystem } from './system.js';
import { systemIdentityWriteCompatibilityGuard } from '../system-admin/routes.js';
import { createLegacyManagementAuthority } from './legacy-authority.js';
import { createPlatformConfigReaders } from '../management-adapters/platform-config/index.js';
import { createSourceWindow } from '../management-adapters/source-window/index.js';
import { createManagementSourceAdapters, createStatsSyncBridge } from '../management-adapters/sources/index.js';
import { createMemberManagementAdapters, createMemberContextInvalidator, createMemberServiceBridges,
  createRealtimeMemberAdapter, createMemberAdapterObservationRouter } from '../management-adapters/members/index.js';
import { RealtimeService } from '../realtime/service.js';
import { createMemberOutboxConsumer } from './member-outbox.js';
import { createManagedExportRenderer } from '../management-adapters/exports/index.js';
import { createPlatformHost } from '../management-adapters/platforms/index.js';
import { createSourceHost } from '../management-adapters/source-host/index.js';
import { MemberInboxService, createMemberInboxRouter } from '../member-inbox/index.js';
import { createPlatformMediaOwner } from '../platform-media/index.js';
import { createPlatformAdminExtras } from '../platform-admin-extras/index.js';
import { createSourceAdmin, createSourceAdminRouter } from '../source-admin/index.js';

const SCHEDULING_ADVANCE_INTERVAL_MS = 15_000;

/** Explicit lifecycle owner. Schema migration and external adapters are host responsibilities. */
export function createManagementRuntime({ getIdentity, runStoreWriteTask, patchStoreCache,
  memberAdapters = () => ({}), statsOptions = () => ({}), syncOptions = () => ({}),
  realtimeOptions = () => ({}), platformAdapters = () => ({}), systemOptions, sourceOptions, memberOptions, getAuthContexts, getScheduling,
  platformHostOptions, sourceHostOptions, sourceAdminOptions, relayAdminOptions, invalidateRelayAuthCache, memberFollowupOptions, vipNotificationOptions, hexQueryOptions, memberInboxOptions, platformMediaOptions, adminExtrasOptions, publishCatalogEvent, getMemberSpace, getNotificationSystem, sharedBattlemetricsQueue,
  invalidateAuthContexts, invalidateProxySettings, publishDomainEvent, electricianAvatarOptions, intervalMs = 1000 }) {
  if (typeof getIdentity !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 60000) {
    throw new TypeError('Invalid management runtime configuration');
  }
  const systems = new Map();
  const nextSchedulingAdvance = new WeakMap();
  const binaryExports = createManagedExportRenderer();
  const operations = new Set();
  const statsRecovery = new WeakMap(), statsJobs = new WeakMap();
  let stopping = false, stopped = false, timer, starting, ticking, stoppingPromise;
  let lastErrorCode = null;
  const accepting = () => { if (stopping || stopped) throw new IdentityError('MANAGEMENT_RUNTIME_STOPPED', 503); };
  const electricianAvatars = createElectricianAvatars({ ...electricianAvatarOptions, readCachedAvatar: async steamId => {
    accepting();
    const identity = await getIdentity();
    accepting();
    return storedSteamAvatar(identity.repo.db, steamId);
  } });
  const runOperation = fn => {
    accepting();
    const work = Promise.resolve().then(fn);
    operations.add(work);
    work.then(() => operations.delete(work), () => operations.delete(work));
    return work;
  };
  function recoverStats(stats) {
    if (!statsRecovery.has(stats)) {
      const recovery = Promise.resolve().then(() => runStoreWriteTask(() => stats.recoverJobs()));
      statsRecovery.set(stats, recovery);
      recovery.catch(() => statsRecovery.delete(stats));
    }
    return statsRecovery.get(stats);
  }
  function runStats(stats, id) {
    accepting();
    if (!statsJobs.has(stats)) statsJobs.set(stats, new Map());
    const jobs = statsJobs.get(stats);
    if (jobs.has(id)) return jobs.get(id);
    const work = recoverStats(stats).then(() => { accepting(); return stats.runJob(id); })
      .finally(() => jobs.delete(id));
    jobs.set(id, work);
    return work;
  }
  function getSystem(identity) {
    accepting();
    if (!identity?.repo?.db) throw new IdentityError('MANAGEMENT_IDENTITY_REQUIRED', 503);
    if (systems.has(identity)) return systems.get(identity);
    const writes = createManagementWrites({ identity, runStoreWriteTask, patchStoreCache });
    const legacyAuthority = createLegacyManagementAuthority(identity);
    if (sourceOptions && sourceHostOptions) throw new IdentityError('SOURCE_OWNER_AMBIGUOUS', 503);
    let service;
    const options = syncOptions(identity);
    const hexConfig = hexQueryOptions?.(identity);
    const sourceHostConfig = sourceHostOptions?.(identity);
    if (hexConfig && (!sourceHostConfig || sourceHostConfig.readHexCard || options.providers?.hexaytron_profile)) throw new IdentityError('HEX_SOURCE_OWNER_AMBIGUOUS', 503);
    const hexQuery = hexConfig ? createHexQuery({ ...hexConfig, identity, notifications: getNotificationSystem?.(identity),
      getSyncService: () => service, runStoreWriteTask }) : null;
    let sourceHost;
    const sourceWindows = sourceHostConfig ? createSourceWindow({ identity,
      readSourceConfig: input => sourceHost.readSourceConfig(input) }) : null;
    sourceHost = sourceHostConfig ? createSourceHost({ ...sourceHostConfig,
      ...(hexQuery ? { readHexCard: hexQuery.readHexCard } : {}),
      sharedBattlemetricsQueue: sourceHostConfig.sharedBattlemetricsQueue || sharedBattlemetricsQueue,
      readSettings: () => identity.repo.scalar('settings') || {},
      readWipe: id => identity.repo.get('schedulingWipes', id),
      readKookContext: memberId => {
        const policy = identity.repo.all('policies').find(row => row.provider === 'kook') || null;
        const links = identity.repo.db.prepare("SELECT i.payload_json FROM json_records a JOIN json_records i ON i.collection='v2Identities' AND json_extract(i.payload_json,'$.accountId')=a.id AND json_extract(i.payload_json,'$.provider')='kook' WHERE a.collection='v2Accounts' AND json_extract(a.payload_json,'$.memberId')=? LIMIT 2").all(memberId);
        const config = identity.repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_admin_records'").get()
          ? identity.repo.db.prepare("SELECT json_extract(payload,'$.revision') revision FROM platform_admin_records WHERE kind='config' AND id='kook'").get() : null;
        return { policy, externalId: links.length === 1 ? JSON.parse(links[0].payload_json).externalId : '', mappingRevision: config?.revision || 0 };
      },
      readDiscordContext: memberId => {
        const policy = identity.repo.all('policies').find(row => row.provider === 'discord') || null;
        const links = identity.repo.db.prepare("SELECT i.payload_json FROM json_records a JOIN json_records i ON i.collection='v2Identities' AND json_extract(i.payload_json,'$.accountId')=a.id AND json_extract(i.payload_json,'$.provider')='discord' WHERE a.collection='v2Accounts' AND json_extract(a.payload_json,'$.memberId')=? LIMIT 2").all(memberId);
        return { policy, externalId: links.length === 1 ? JSON.parse(links[0].payload_json).externalId : '' };
      },
      readKookRoles: (externalId, guildId, { admissionRoleIds, signal }) => identity.providers?.kook?.roles(externalId, guildId, { includeCommunity: true, admissionRoleIds, signal }),
      readWindow: sourceWindows.readWindow }) : null;
    const sourceConfig = sourceHost ? { ...sourceHost, captureSourceWindow: sourceWindows.captureSourceWindow } : sourceOptions?.(identity);
    const sources = sourceConfig ? createManagementSourceAdapters({ ...sourceConfig, identity,
      runWrite: runStoreWriteTask, authorizeStatsWrite: legacyAuthority.authorizeStatsWrite,
      patchCache: async records => {
        await patchStoreCache(store => {
          for (const { collection, id, record } of records) {
            if (!['members', 'squadMembers', 'memberProfiles', 'kdaRows', 'kdaSnapshots', 'users', 'wechatUsers', 'v2Wipes'].includes(collection)) throw new Error('Unexpected source cache collection');
            const rows = store[collection] ||= [], index = rows.findIndex(row => row.id === id);
            if (!record) { if (index >= 0) rows.splice(index, 1); }
            else if (index >= 0) rows[index] = record; else rows.push(record);
          }
        });
        await publishDomainEvent?.(identity);
      } }) : null;
    const originalAuthority = sources?.authority || createSqliteSyncAuthority({ ...options.authority, identity, serializeWrite: runStoreWriteTask });
    service = new SyncCenterService({ db: identity.repo.db, identity, authority: originalAuthority });
    if (memberFollowupOptions && (!memberOptions || !sourceConfig?.readSourceConfig)) throw new IdentityError('FOLLOWUP_HOST_REQUIRED', 503);
    const followupConfig = memberFollowupOptions?.(identity);
    const followups = followupConfig ? createMemberFollowups({ ...followupConfig, identity,
      syncService: service, readSourceConfig: followupConfig.readSourceConfig ?? sourceConfig.readSourceConfig }) : null;
    const workerOptions = { providers: { ...sources?.providers, ...options.providers } };
    const worker = followups ? followups.startWorker(workerOptions) : createSyncCenterWorker(service, workerOptions);
    // Followups first installs its own original writer fence. Hex is the final outer
    // wrapper: later writes to the proxy would otherwise replace the captured writer.
    if (hexQuery) {
      service.authority = hexQuery.wrapAuthority(service.authority);
      if (sources) sources.authority = service.authority;
    }
    let platformHost;
    const hostConfig = platformHostOptions?.(identity);
    const memberConfig = memberOptions?.(identity);
    const memberBundle = memberConfig ? createMemberManagementAdapters({ ...memberConfig, identity,
      syncService: service, runStoreWriteTask, patchStoreCache, isTrustedRoot: legacyAuthority.isTrustedRoot,
      contexts: createMemberContextInvalidator({ authContexts: getAuthContexts?.(identity),
        invalidatePlatformSessions: hostConfig ? event => {
          if (!platformHost) throw new IdentityError('PLATFORM_INVALIDATOR_BINDING_REQUIRED', 503);
          platformHost.invalidatePlatformSessions(event);
        } : memberConfig.invalidatePlatformSessions }),
      publishDomainEvent: () => publishDomainEvent?.(identity) }) : null;
    const members = new MemberAdminService(identity, { ...memberBundle?.adapters, ...memberAdapters(identity, { service }) });
    const memberWrite = memberBundle?.writeDomain || writes.member;
    const memberBridges = memberBundle ? createMemberServiceBridges({ memberService: members, writeDomain: memberWrite }) : null;
    const memberOutbox = memberBundle ? createMemberOutboxConsumer({ identity, members, bundle: memberBundle, runWrite: runStoreWriteTask, consumeFollowups: followups ? seq => followups.consume(seq) : undefined }) : null;
    const stats = new StatsService(identity, { authorizeWrite: legacyAuthority.authorizeStatsWrite,
      renderExport: createExportRenderer({ renderBinary: binaryExports.renderBinary }),
      ...(sources ? { providers: sources.statsProviders, ...createStatsSyncBridge({ identity, syncService: service,
        readSourceConfig: sourceConfig.readSourceConfig, readVitalWipes: sourceConfig.readers?.stats?.vitalWipes,
        bindVitalWipe: sources.bindVitalWipe }) } : {}),
      ...statsOptions(identity, { service }), writeCurrent: writes.stats });
    const realtime = { authorizeLegacyAction: legacyAuthority.authorizeRealtimeAction,
      ...realtimeOptions(identity, { members, writes }),
      repository: new RealtimeRepository(identity.repo.db), streamOwner: createRealtimeStreamOwner(),
      writeCommand: runStoreWriteTask };
    if (memberBundle) realtime.members = createRealtimeMemberAdapter({ memberService: members,
      realtimeService: new RealtimeService(identity, realtime), writeDomain: memberWrite });
    const scheduling = getScheduling?.(identity);
    const published = createPublishedPlatformAdapters({ identity, scheduling, stats, sync: service,
      executeStatsJob: id => runStats(stats, id), write: runStoreWriteTask });
    const platforms = { service: new PlatformAdminService({ identity, electricianAvatars,
      adapters: { ...published.platform, ...memberBridges?.platform, ...platformAdapters(identity, { members, stats, sync: service, writes }) } }), runOperation };
    const administration = systemOptions ? createManagedSystem({ identity, runStoreWriteTask, patchStoreCache,
      invalidateAuthContexts, invalidateProxySettings, publishDomainEvent, options: systemOptions(identity) }) : null;
    const inboxConfig = memberInboxOptions?.(identity), mediaConfig = platformMediaOptions?.(identity);
    const configuredApps = [hostConfig?.wechat?.appId, inboxConfig?.appId, mediaConfig?.appId].filter(Boolean);
    if (new Set(configuredApps).size > 1) throw new IdentityError('PLATFORM_CONFIG_APP_MISMATCH', 503);
    const configReaders = configuredApps.length ? createPlatformConfigReaders({ platformService: platforms.service,
      identity, appId: configuredApps[0] }) : null;
    const inbox = inboxConfig ? new MemberInboxService({ ...inboxConfig, identity, readConfig: configReaders.readInbox,
      runStoreWriteTask: fn => runOperation(() => runStoreWriteTask(fn)), patchStoreCache }) : null;
    const media = mediaConfig ? createPlatformMediaOwner({ ...mediaConfig, identity, readConfig: configReaders.readMedia, memberSpace: getMemberSpace?.(identity),
      runStoreWriteTask, patchStoreCache }) : null;
    const vipConfig = vipNotificationOptions?.(identity);
    const vipNotifications = vipConfig ? createVipNotifications({ ...vipConfig, identity, notifications: getNotificationSystem?.(identity), runStoreWriteTask }) : null;
    const extrasConfig = adminExtrasOptions?.(identity), catalogEvents = new Set();
    const extras = extrasConfig ? createPlatformAdminExtras({ ...extrasConfig, identity, members, scheduling, stats,
      system: administration?.service, isTrustedRoot: legacyAuthority.isTrustedRoot,
      runStoreWriteTask: fn => runOperation(() => runStoreWriteTask(fn)),
      patchCache: ({ vitalServers }) => patchStoreCache(store => { (store.settings ||= {}).vitalServers = vitalServers; }),
      publishEvents: async events => {
        for (const event of events) if (!catalogEvents.has(event.id)) {
          if (!publishCatalogEvent) throw new IdentityError('CATALOG_EVENT_OWNER_REQUIRED', 503);
          await publishCatalogEvent(identity);
          catalogEvents.add(event.id);
          if (catalogEvents.size > 1000) catalogEvents.delete(catalogEvents.values().next().value);
        }
      } }) : null;
    if (hostConfig) {
      platformHost = createPlatformHost({ ...hostConfig,
        ...(hostConfig.wechat ? { wechat: { ...hostConfig.wechat, readConfig: configReaders.readMini } } : {}), identity, scheduling, memberSpace: getMemberSpace?.(identity),
        members, memberBundle, stats, sync: service, platformService: platforms.service, runStoreWriteTask, patchStoreCache,
        assertInvalidationReady: () => Boolean(platformHost), replayMemberOutbox: () => memberOutbox.drainAll(),
        notifications: getNotificationSystem?.(identity)?.service, system: administration?.service, inbox, media, adminExtras: extras,
        executeStatsJob: id => runStats(stats, id) });
      platforms.runOperation = fn => runOperation(() => platformHost.runOperation(fn));
    }
    for (const method of ['save', 'secrets']) {
      const command = platforms.service[method].bind(platforms.service);
      platforms.service[method] = (...args) => runOperation(() => runStoreWriteTask(() => {
        const result = command(...args);
        if (args[1] === 'wechat') {
          const eventId = `platform-config:wechat:${result.revision}`;
          platformHost?.invalidatePlatformSessions({ id: eventId, reason: 'platform_configuration_changed',
            appId: hostConfig.wechat?.appId });
        }
        return result;
      }));
    }
    const saveSteamLogin = platforms.service.saveSteamLogin.bind(platforms.service);
    platforms.service.saveSteamLogin = (...args) => runOperation(() => runStoreWriteTask(async () => {
      const result = saveSteamLogin(...args);
      await patchStoreCache(store => { store.settings = structuredClone(identity.repo.scalar('settings')); });
      return result;
    }));
    const relayAdmin = relayAdminOptions ? createRelayAdmin({ ...relayAdminOptions(identity), identity, invalidateRelayAuthCache, patchStoreCache }) : null;
    const relayAdminRouter = relayAdmin ? createRelayAdminRouter({service:relayAdmin}) : null;
    const sourceAdmin = sourceAdminOptions ? createSourceAdmin({ ...sourceAdminOptions(identity), identity, patchStoreCache }) : null;
    const sourceAdminRouter = sourceAdmin ? createSourceAdminRouter({ service: sourceAdmin }) : null;
    const system = { hexQuery, relayAdmin, relayAdminRouter, vipNotifications, sourceAdmin, sourceAdminRouter, followups, identity, scheduling, service, worker, members, memberBundle, memberBridges, memberWrite, memberOutbox, sources,
      stats, writes, realtime, platforms, platformHost, sourceHost, inbox, media, extras, administration, recovered: false };
    nextSchedulingAdvance.set(system, 0);
    systems.set(identity, system);
    return system;
  }
  const router = express.Router();
  router.use(async (req,res,next) => {
    if (!/^\/(member-admin|relay-admin|source-admin|sync-center|realtime|platform-admin|system-admin)(?:\/|$)/.test(req.path)) return next();
    try {
      const {actor}=await req.v2Identity.authenticate();
      if (!['owner','admin'].includes(actor.roleId)) return res.status(403).json({error:{errorCode:'ACCESS_DENIED'},meta:{schemaVersion:1}});
      next();
    } catch(error) { next(error); }
  });
  if (relayAdminOptions) router.use((req,res,next) => {
    if (!/^\/relay-admin(?:\/|$)/.test(req.path)) return next();
    try { return getSystem(req.v2Identity.service).relayAdminRouter(req,res,next); } catch(error) { next(error); }
  });
  if (sourceAdminOptions) router.use((req, res, next) => {
    if (!/^\/source-admin(?:\/|$)/.test(req.path)) return next();
    try { return getSystem(req.v2Identity.service).sourceAdminRouter(req, res, next); }
    catch (error) { next(error); }
  });
  if (platformHostOptions) router.use((req, res, next) => {
    if (!/^\/wechat-link(?:\/|$)/.test(req.path)) return next();
    try {
      const host = getSystem(req.v2Identity.service).platformHost;
      if (!host?.wechatLinkRouter) throw new IdentityError('PLATFORM_HOST_UNAVAILABLE', 503);
      return host.wechatLinkRouter(req, res, next);
    } catch (error) { next(error); }
  });
  if (memberInboxOptions) router.use(createMemberInboxRouter({ getService: identity => getSystem(identity).inbox }));
  router.use(createMemberAdminRouter({ getService: identity => getSystem(identity).members,
    writeDomain: (write, context) => getSystem(context.identity).memberWrite(write, context) }));
  if (memberOptions) router.use(createMemberAdapterObservationRouter({ getRuntime: identity => getSystem(identity).memberBundle }));
  router.use(createStatsRouter({}, { getService: identity => getSystem(identity).stats }));
  router.use(createSyncCenterRouter({ getSystem: req => getSystem(req.v2Identity.service) }));
  router.use(createRealtimeRouter(identity => getSystem(identity).realtime));
  router.use(createPlatformAdminRouter({ getSystem: req => getSystem(req.v2Identity.service).platforms }));
  if (systemOptions) router.use((req, res, next) => {
    if (!/^\/system-admin(?:\/|$)/.test(req.path)) return next();
    try { getSystem(req.v2Identity.service).administration.router(req, res, next); }
    catch (error) { next(error); }
  });
  function tick() {
    if (stopping || stopped) return Promise.resolve();
    if (ticking) return ticking;
    ticking = (async () => {
      for (const system of systems.values()) {
        if (stopping) break;
        const now = Date.now();
        if (typeof system.scheduling?.advanceDueWipes === 'function' && now >= nextSchedulingAdvance.get(system)) {
          nextSchedulingAdvance.set(system, now + SCHEDULING_ADVANCE_INTERVAL_MS);
          await runStoreWriteTask(() => system.scheduling.advanceDueWipes());
        }
        await system.memberOutbox?.drain();
        await system.vipNotifications?.tick({limit:50});
        if (!system.recovered) {
          await recoverStats(system.stats);
          system.recovered = true;
        }
        await system.service.tick();
        await system.worker.step();
        if (stopping) break;
        await runStoreWriteTask(() => system.realtime.repository.pruneEvents());
        const job = system.identity.repo.db.prepare("SELECT id FROM v2_stats_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
        if (job) await runStats(system.stats, job.id);
      }
    })().finally(() => { ticking = null; });
    return ticking;
  }
  function start() {
    accepting();
    if (starting) return starting;
    starting = (async () => {
      const identity = await getIdentity();
      accepting();
      const system = getSystem(identity);
      system.sourceAdmin?.start();
      system.relayAdmin?.start();
      if (system.extras) while ((await system.extras.service.recover()).pending) accepting();
      await system.platformHost?.start();
      accepting();
      system.administration?.owner.start();
      timer = setInterval(() => { tick().catch(() => { lastErrorCode = 'MANAGEMENT_TICK_FAILED'; }); }, intervalMs);
      timer.unref();
    })().catch(error => { starting = null; throw error; });
    return starting;
  }
  function stop() {
    if (stoppingPromise) return stoppingPromise;
    stopping = true;
    clearInterval(timer);
    const binaryStopped = binaryExports.stop();
    stoppingPromise = (async () => {
      await starting?.catch(() => {});
      const sourceAdminStops = await Promise.allSettled([...systems.values()].flatMap(system => [system.sourceAdmin?.stop(),system.relayAdmin?.stop()]));
      const results = [...sourceAdminStops, ...await Promise.allSettled([binaryStopped, electricianAvatars.stop(), ...[...systems.values()].flatMap(system => [
        system.followups ? system.followups.stop() : system.worker.stop(), system.hexQuery?.stop(), system.realtime.streamOwner.stop(), system.administration?.owner.stop(), system.platformHost?.stop(), system.sourceHost?.stop(), system.media?.stop()
      ])])];
      await ticking?.catch(() => {});
      await Promise.allSettled([...operations]);
      results.push(...await Promise.allSettled([...systems.values()].map(system => system.vipNotifications?.stop())));
      stopped = true;
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Management runtime shutdown failed');
    })();
    return stoppingPromise;
  }
  async function authorizePublicToken(token) {
    accepting();
    const identity = await getIdentity(), service = getSystem(identity).administration?.service;
    if (!service) throw new IdentityError('PUBLIC_QUERY_UNAVAILABLE', 503);
    const encoded = service.repo.settings().publicApi?.tokenHash;
    if (!await service.verifyPublicToken(token)) throw new IdentityError('PUBLIC_TOKEN_INVALID', 401);
    return () => {
      accepting();
      if (!encoded || service.repo.settings().publicApi?.tokenHash !== encoded) throw new IdentityError('PUBLIC_TOKEN_INVALID', 401);
    };
  }
  const platformRouter = face => async (req, res, next) => {
    const prefix = face === 'miniRouter' ? '/mini-program' : face === 'mediaRouter' ? '/platform-media' : '/wechat';
    if (!platformHostOptions || !(req.path === prefix || req.path.startsWith(prefix + '/'))) return next();
    try {
      const system = getSystem(await getIdentity());
      if (!system.platformHost) throw new IdentityError('PLATFORM_HOST_UNAVAILABLE', 503);
      if (!system.platformHost[face]) throw new IdentityError('PLATFORM_MEDIA_UNAVAILABLE', 503);
      return system.platformHost[face](req, res, error => {
        if (error) return next(error);
        return res.status(face === 'legacyRouter' ? 410 : 404).json({ error: {
          errorCode: face === 'legacyRouter' ? 'CLIENT_UPGRADE_REQUIRED' : 'PLATFORM_ROUTE_NOT_FOUND'
        } });
      });
    } catch (error) { return res.status(error.status || 503).json({ error: { errorCode: error.errorCode || 'PLATFORM_HOST_UNAVAILABLE' } }); }
  };
  const beforeIdentityRouter = createPublicElectriciansRouter({ avatars: electricianAvatars, readConfig: async platform => {
    accepting();
    const identity = await getIdentity();
    accepting();
    const repo = new PlatformAdminRepository(identity.repo.db);
    const shared = repo.get('electrician-roster', 'shared'), roster = readElectricianRoster(repo);
    return { config: repo.get('config', platform),
      roster: shared || roster.entries.length ? resolveElectricianRoster(repo, identity) : null,
      rosterRevision: roster.revision, rosterSource: shared ? 'shared' : 'legacy-kook' };
  } });
  if (systemOptions) beforeIdentityRouter.use(systemIdentityWriteCompatibilityGuard);
  return { router, getSystem, start, tick, stop,
    onboardingRouter: async (req, res, next) => {
      if (!(req.path === '/wechat-onboarding' || req.path.startsWith('/wechat-onboarding/'))) return next();
      return res.status(410).json({error:{errorCode:'REGISTRATION_REVIEW_RETIRED'}});
    },
    miniRouter: platformRouter('miniRouter'), legacyPlatformRouter: platformRouter('legacyRouter'),
    mediaRouter: platformRouter('mediaRouter'),
    legacyPlatformSettingsGuard: (req, res, next) => {
      if (!platformHostOptions || !/^\/settings\/(?:discord|kook|discord-kook-bridge)(?:\/|$)/.test(req.path)) return next();
      return res.status(410).json({ error: { errorCode: 'LEGACY_PLATFORM_SETTINGS_RETIRED' },
        replacement: '/api/v2/platform-admin' });
    },
    authorizePublicToken, runOperation,
    beforeIdentityRouter,
    diagnostics: () => ({ stopping, stopped, instances: systems.size, timerActive: Boolean(timer) && !stopping,
      tickActive: Boolean(ticking), binaryExports: binaryExports.diagnostics(), lastErrorCode }) };
}
