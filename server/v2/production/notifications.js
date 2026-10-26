import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { createNotificationRuntime } from '../notification-runtime/index.js';
import { createDiscordVerifier, createKookVerifier } from '../notification-platforms/verifiers.js';
import { managedDiscordInteraction } from '../notification-platforms/native-interactions.js';
import { createProductionNotificationTransport } from './notification-transport.js';
import { SERVER_CONNECT_COMMAND_ID, serverConnectTargetId } from '../platform-admin/server-connect-card.js';
import { ELECTRICIAN_COMMAND_ID, electricianTargetId } from '../platform-admin/electrician-card.js';
import { WELCOME_GUIDE_COMMAND_ID, welcomeGuideTargetId } from '../platform-admin/welcome-guide-card.js';
import { createDiscordOpenWipeService, openWipeTargetId } from '../discord-open-wipe/service.js';
import { createDiscordSteamLinksService } from '../discord-steam-links/service.js';
import { createDiscordSteamMemberTeamSync } from '../discord-steam-links/member-team-sync.js';
import { createDiscordSteamMemberTeamWriter } from '../discord-steam-links/member-team-writer.js';
import { runStoreWriteTask as defaultWriteTask, patchStoreCache as defaultPatchCache } from '../../store.js';

const fail = code => { throw new IdentityError(code, 503); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One production notification/scheduling owner, using the canonical platform configuration.
 * readCredentials(platform) is a synchronous trusted reader, never an HTTP DTO:
 * discord: botToken; kook: botToken, verifyToken, optional encryptKey.
 * Discord publicKey/applicationId come from PlatformAdminService.config(), with
 * credential-reader fallback for a host that keeps verification configuration in its vault.
 */
export function createProductionNotificationOwner({ getIdentity, getPlatformService, publicOrigin, readCredentials,
  fetchImpl, getCommunityHandler, getCardViewHandler, intervalMs = 1000, now = Date.now, kookCompression = 'deflate', readServerCatalog, prepareServerCatalog,
  steamLinksProvider, runStoreWriteTask = defaultWriteTask, patchStoreCache = defaultPatchCache, scheduledActorAccountId = null } = {}) {
  if (typeof getPlatformService !== 'function' || typeof readCredentials !== 'function' ||
      !['none', 'deflate'].includes(kookCompression)) fail('NOTIFICATION_SETUP_REQUIRED');
  const service = () => {
    const value = getPlatformService();
    if (!value?.identity || typeof value.config !== 'function') fail('NOTIFICATION_PLATFORM_OWNER_REQUIRED');
    return value;
  };
  const credentials = platform => {
    const value = readCredentials(platform);
    if (!value || typeof value !== 'object' || typeof value.then === 'function') fail('NOTIFICATION_CREDENTIALS_REQUIRED');
    return value;
  };
  function targets() {
    const owner = service(), result = [];
    for (const platform of ['discord', 'kook']) {
      const config = owner.config(platform);
      const guildNames = new Map((owner.guildCatalog?.(platform, config)?.items || []).map(item => [item.id, item.label]));
      const channelNames = new Map((owner.channelCatalogs?.(platform, config) || []).map(catalog =>
        [catalog.guildId, new Map((catalog.items || []).map(item => [item.id, item.label]))]));
      const wipeCommand = platform === 'discord' ? (config.commands || []).find(command => command.id === 'wipe' && command.type === 'event_command' && command.enabled) : null;
      const signupCommandId = platform === 'discord' ? 'wipe' : 'signup_card';
      const signupCardEnabled = platform === 'discord' ? Boolean(wipeCommand) : (config.commands || []).some(command =>
        command.id === 'signup_card' && command.type === 'persistent_card' && command.enabled);
      const serverConnectEnabled = (config.commands || []).some(command =>
        command.id === SERVER_CONNECT_COMMAND_ID && command.type === 'persistent_card' && command.enabled);
      const electricianEnabled = (config.commands || []).some(command =>
        command.id === ELECTRICIAN_COMMAND_ID && command.type === 'persistent_card' && command.enabled);
      const guideEnabled = (config.commands || []).some(command =>
        command.id === WELCOME_GUIDE_COMMAND_ID && command.type === 'persistent_card' && command.enabled);
      const openWipeEnabled = platform === 'discord' && (config.commands || []).some(command =>
        command.id === 'newwipe' && command.type === 'event_command' && command.enabled);
      for (const target of config.targets || []) if (target.guildId) {
        const base = { id: target.id, platform, guildId: target.guildId, channelId: target.channelId,
          label: target.name || target.id, guildLabel: guildNames.get(target.guildId) || target.name || target.guildId,
          channelLabel: channelNames.get(target.guildId)?.get(target.channelId) || target.channelId,
          enabled: config.enabled === true && target.enabled === true,
          configurationRevision: config.revision, languages: platform === 'discord' ? ['en', 'zh-CN', 'ru', 'tr', 'th', 'ko'] : ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'], roleOptions: [],
          runtimeMode: 'production', transportKey: `production:${platform}:${target.id}`,
          ...(platform === 'discord' ? { signupMode: target.enabledCommandIds?.includes('wipe') && wipeCommand?.signupMode === 'discord_only' ? 'discord_only' : 'member_required' } : {}) };
        if (target.channelId) result.push(base);
        if (openWipeEnabled && target.enabledCommandIds?.includes('newwipe')) {
          for (const channelId of new Set(target.newwipeChannelIds?.length ? target.newwipeChannelIds : [target.channelId].filter(Boolean))) {
            const id = openWipeTargetId(target.id, channelId);
            result.push({ ...base, id, channelId, label: `${base.label} · Open wipe`,
              channelLabel: channelNames.get(target.guildId)?.get(channelId) || channelId,
              transportKey: `production:discord:${id}` });
          }
        }
        if (signupCardEnabled && target.enabledCommandIds?.includes(signupCommandId) && target.signupCardChannelId) {
          const id = `signup_card_${hash(`${platform}:${target.id}`).slice(0, 24)}`;
          result.push({ ...base, id, channelId: target.signupCardChannelId, label: `${base.label} · 报名卡片`,
            channelLabel: channelNames.get(target.guildId)?.get(target.signupCardChannelId) || target.signupCardChannelId,
            transportKey: `production:${platform}:${id}` });
        }
        if (serverConnectEnabled && target.enabledCommandIds?.includes(SERVER_CONNECT_COMMAND_ID) && target.serverConnectChannelId) {
          const id = serverConnectTargetId(target.id, platform);
          result.push({ ...base, id, channelId: target.serverConnectChannelId, label: `${base.label} · ${platform === 'discord' ? 'Server Direct Connect' : '服务器直连'}`,
            channelLabel: channelNames.get(target.guildId)?.get(target.serverConnectChannelId) || target.serverConnectChannelId,
            transportKey: `production:${platform}:${id}` });
        }
        if (electricianEnabled && target.enabledCommandIds?.includes(ELECTRICIAN_COMMAND_ID) && target.electricianChannelId) {
          const id = electricianTargetId(target.id, platform);
          result.push({ ...base, id, channelId: target.electricianChannelId, label: `${base.label} · ${platform === 'discord' ? 'Electricians · Steam IDs' : '电工 ID'}`,
            channelLabel: channelNames.get(target.guildId)?.get(target.electricianChannelId) || target.electricianChannelId,
            transportKey: `production:${platform}:${id}` });
        }
        if (guideEnabled && target.enabledCommandIds?.includes(WELCOME_GUIDE_COMMAND_ID) && target.welcomeGuideChannelId) {
          const id = welcomeGuideTargetId(target.id, platform);
          result.push({ ...base, id, channelId: target.welcomeGuideChannelId, label: `${base.label} · ${platform === 'discord' ? 'Wipe Guide' : '开荒须知'}`,
            channelLabel: channelNames.get(target.guildId)?.get(target.welcomeGuideChannelId) || target.welcomeGuideChannelId,
            transportKey: `production:${platform}:${id}` });
        }
      }
    }
    if (result.length > 1000 || new Set(result.map(target => target.id)).size !== result.length) fail('NOTIFICATION_TARGET_ID_CONFLICT');
    return result;
  }
  const catalog = {
    prepareOptions: kind => kind === 'servers' ? prepareServerCatalog?.() : undefined,
    listTargets: targets,
    getTarget: id => targets().find(target => target.id === id) || null,
    listOptions(kind, { q = '' } = {}) {
      const identity = service().identity, collection = { members: 'members', squads: 'squads' }[kind];
      if (!collection && kind !== 'servers') fail('NOTIFICATION_CATALOG_KIND_INVALID');
      const rows = kind === 'servers' ? readServerCatalog?.() || [] : identity.repo.all(collection);
      if (!Array.isArray(rows) || rows.length > 10000) fail('NOTIFICATION_CATALOG_TOO_LARGE');
      const memberships = kind === 'members' ? identity.repo.all('squadMembers') : [];
      const items = rows.map(row => ({ id: row.id, label: row.displayName || row.name || row.customName || row.label || row.id,
        ...(kind === 'servers' ? { serverSnapshot: structuredClone(row.serverSnapshot || { name: row.name || row.label || row.id, connectCommand: row.directConnect || '' }),
          serverScheduleSource: structuredClone(row.serverScheduleSource ?? null) } : {}),
        ...(kind === 'members' ? { squadIds: memberships.filter(item => item.memberId === row.id).map(item => item.squadId) } : {}) }));
      return { items: items.filter(item => item.label.toLowerCase().includes(String(q).slice(0, 200).toLowerCase())), nextCursor: null };
    }
  };
  const verifierCache = new Map();
  function verifierFor(platform) {
    const config = service().config(platform), secrets = credentials(platform);
    if (config.enabled !== true) fail('PLATFORM_AUTH_INVALID');
    const input = platform === 'discord' ? { publicKey: config.publicKey || secrets.publicKey,
      applicationId: config.applicationId || secrets.applicationId || null } : {
      verifyToken: secrets.verifyToken, encryptKey: secrets.encryptKey || null, compression: kookCompression };
    const digest = hash(input); let cached = verifierCache.get(platform);
    if (cached?.digest !== digest) {
      cached = { digest, verify: (platform === 'discord' ? createDiscordVerifier : createKookVerifier)({ ...input, now }) };
      verifierCache.set(platform, cached);
    }
    return cached.verify;
  }
  const verifiers = Object.fromEntries(['discord', 'kook'].map(platform => [platform, envelope => verifierFor(platform)(envelope)]));
  const transport = createProductionNotificationTransport({ readCredentials: credentials, fetchImpl,
    validateTarget(target) {
      const current = catalog.getTarget(target.id);
      if (!current?.enabled || ['platform', 'guildId', 'channelId', 'configurationRevision', 'runtimeMode', 'transportKey']
        .some(key => target[key] !== current[key])) fail('NOTIFICATION_TARGET_CHANGED');
    } });
  let openWipe, steamLinks;
  const runtime = createNotificationRuntime({ getIdentity, publicOrigin, catalog, transport, verifiers, getCommunityHandler, getCardViewHandler,
    initializeSystem(system, identity) {
      if (steamLinksProvider) steamLinks = createDiscordSteamLinksService({ db: identity.repo.db,
        readConfig: () => service().config('discord'), provider: steamLinksProvider, now,
        syncMemberTeam: createDiscordSteamMemberTeamSync({ identity, now }),
        runStoreWriteTask: createDiscordSteamMemberTeamWriter({ identity, runStoreWriteTask, patchStoreCache }) });
      if (system.service.repo.scalar('v2NotificationOpenWipeSchemaVersion') === 1) {
        // Management creates its own notification domains during startup. Read
        // its configuration lazily to avoid re-entering that construction.
        openWipe = createDiscordOpenWipeService({ notifications: system.service,
          platformService: { identity, config: platform => service().config(platform) }, catalog, now });
      }
    },
    getOpenWipeHandler: () => openWipe?.handleVerified,
    getSteamLinksHandler: () => steamLinks?.handleVerified,
    bindSteamLinksMessage: (proof, payload, messageId) => steamLinks?.bindPrivateMessage(proof, payload, messageId),
    intervalMs, now, scheduledActorAccountId, runtimeMode: 'production' });
  return Object.freeze({ ...runtime, catalog,
    ownsDiscordInteraction: event => managedDiscordInteraction(event, service().config('discord')),
    async start() {
      // Validate the same persisted configuration before admitting background work.
      // A card must not be sent with an unconfigured callback verifier.
      runtime.getSystem(await getIdentity());
      catalog.listTargets();
      for (const platform of ['discord', 'kook']) if (service().config(platform).enabled === true) {
        const token = credentials(platform).botToken;
        if (typeof token !== 'string' || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) fail('NOTIFICATION_CREDENTIALS_REQUIRED');
        verifierFor(platform);
      }
      return runtime.start();
    }
  });
}
