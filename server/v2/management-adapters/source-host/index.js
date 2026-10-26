import { need, text, stamp } from '../../stats/model.js';
import { createSourceConfiguration } from './config.js';
import { createSourceNetwork } from './network.js';
import { createRiskReader } from './risk-reader.js';
import { createSteamReaders, steamId } from './steam.js';
import { createInventoryReader } from './inventory.js';
import { createDiscordMembershipReader } from './discord-membership.js';
import { mooseCatalog } from './moose-catalog.js';
export { TRUSTED_ORIGINS } from './network.js';

/** Explicit construction only. Reads no environment/files, installs no schema and starts no loop. */
export function createSourceHost(options) {
  const { sharedBattlemetricsQueue, capabilities = {}, readHexCard, mooseEngine, memberLookup } = options;
  const effective = { ...capabilities, hexaytron: false };
  const configuration = createSourceConfiguration({ ...options, capabilities: effective });
  const network = createSourceNetwork({ ...options, credentials: configuration.credentials });
  const steam = createSteamReaders({ network, allowed: configuration.enabled });
  const inventory = createInventoryReader({ network, allowed: configuration.enabled, enrichment: options.inventoryEnrichment });
  const opts = input => ({ ...input, signal: input?.signal });
  const requireVital = () => need(configuration.enabled('vital'), 'SOURCE_NOT_CONFIGURED', 503);
  const vital = async (input, options = {}) => {
    requireVital();
    need(Array.isArray(input.playerIds) && input.playerIds.length > 0 && input.playerIds.length <= 10 && input.playerIds.every(x => /^7656119\d{10}$/.test(x)), 'INVALID_DATA');
    need(/^\d{1,8}$/.test(String(input.serverId)) && typeof input.wipeId === 'string' && input.wipeId.length <= 120, 'INVALID_DATA');
    need(Array.isArray(input.includes) && input.includes.length > 0 && input.includes.length <= 256 && input.includes.every(x => /^[A-Za-z0-9_.:-]{1,120}$/.test(x)), 'INVALID_DATA');
    const raw = await network.json('vital', '/players/overview', { ...opts(options), method: 'POST', body: { playerIds: input.playerIds, serverId: Number(input.serverId), wipeId: input.wipeId, includes: input.includes } });
    need(Array.isArray(raw.data) && raw.data.length <= 10, 'SOURCE_INVALID_DATA', 503); return raw.data;
  };
  const moose = async (kind, input, options = {}) => {
    need(configuration.enabled('moose') && typeof mooseEngine === 'function', 'SOURCE_NOT_CONFIGURED', 503);
    const catalog = mooseCatalog(); need(catalog.servers.some(s => s.id === input.serverId), 'INVALID_DATA');
    if (kind === 'player') {
      steamId(input.steamId); need(typeof input.period === 'string' && input.period.length > 0 && input.period.length <= 120, 'INVALID_DATA');
      need(Array.isArray(input.categoryIds) && input.categoryIds.length <= 12 && input.categoryIds.every(id => id === 'all' || catalog.categories.some(c => c.id === id)), 'INVALID_DATA');
    }
    return network.tracked(async signal => {
      // The injected browser engine must intercept ALL navigation/subrequests with this
      // request hook (or implement equivalent exact-origin gating), close its own page
      // on abort, and settle only after that page's I/O has drained. No legacy browser wrapper.
      const result = await mooseEngine({ kind, ...input }, { signal, origin: network.origin('moose'), request: (path, input = {}) => network.json('moose', path, { ...input, signal }) });
      need(result && JSON.stringify(result).length <= 250000, 'SOURCE_RESPONSE_TOO_LARGE', 503);
      if (kind === 'player') need(result.identity?.steamId === input.steamId && Array.isArray(result.categories), 'SOURCE_INVALID_DATA', 503);
      else need(Array.isArray(result.periods) && result.periods.length <= 100, 'SOURCE_PAGE_LIMIT', 503);
      return result;
    }, opts(options).signal);
  };
  const readers = {
    memberRisk: createRiskReader({ network, steam, inventory }),
    discordMembership: createDiscordMembershipReader(network),
    kookMember: async ({ config, signal }) => {
      need(config.enabled && config.externalId && typeof options.readKookRoles === 'function', 'SOURCE_NOT_CONFIGURED', 503);
      let result;
      try { result = await network.tracked(ownedSignal => options.readKookRoles(config.externalId, config.guildId,
        { admissionRoleIds: config.expectedRoleIds, signal: ownedSignal }), signal, 3); }
      catch (error) {
        if (error?.errorCode === 'ELIGIBILITY_DENIED') return { status: 'not_in_guild', externalId: config.externalId,
          guildId: config.guildId, roleIds: [], community: { available: true, roles: [] } };
        throw error;
      }
      need(result?.externalId === config.externalId && result.guildId === config.guildId &&
        Array.isArray(result.roleIds) && result.roleIds.length <= 500 && result.roleIds.every(id => typeof id === 'string' && id.length <= 80), 'SOURCE_INVALID_DATA', 503);
      const roleIds = [...new Set(result.roleIds)];
      const community = result.community?.available === true && Array.isArray(result.community.roles) &&
        result.community.roles.length <= 500 && result.community.roles.every(role =>
          typeof role.id === 'string' && role.id.length <= 80 && typeof role.name === 'string' && role.name.length <= 100)
        ? { available: true, roles: result.community.roles.map(role => ({ id: role.id, name: role.name })) }
        : { available: false, roles: [] };
      const actual = new Set(roleIds), matched = config.matchMode === 'all'
        ? config.expectedRoleIds.every(id => actual.has(id)) : config.expectedRoleIds.some(id => actual.has(id));
      return { status: matched ? 'valid' : 'missing_role', externalId: config.externalId,
        guildId: config.guildId, roleIds, community };
    },
    battlemetricsGet: (path, input = {}) => {
      need(configuration.enabled('battlemetrics') && sharedBattlemetricsQueue?.enqueue && sharedBattlemetricsQueue?.waitTurn, 'SOURCE_NOT_CONFIGURED', 503);
      // Sources adapter already enqueued/waited. This layer performs ONE request, no queue.
      return network.response('battlemetrics', path, opts(input));
    },
    steamProfile: ({ member, signal }) => steam.summary(member.steamId, { signal }),
    readSteamRisk: (id, options) => steam.risk(id, opts(options)),
    hexaytronMessage: async input => {
      const { member, signal } = input;
      need(configuration.enabled('hexaytron'), 'SOURCE_NOT_CONFIGURED', 503);
      return network.tracked(async ownedSignal => {
        // Trusted collector context includes the original operationId and claim heartbeat.
        // Existing-card readers remain compatible. An optional Hex query domain owns
        // persistent command admission; this host itself never sends a command.
        const card = await readHexCard({ ...input, steamId: steamId(member.steamId) }, { signal: ownedSignal });
        if (!card) return null;
        need(card.steamId === member.steamId && card.message && stamp(card.observedAt) && JSON.stringify(card).length <= 100000, 'SOURCE_INVALID_DATA', 503);
        return { steamId: member.steamId, message: card.message, observedAt: stamp(card.observedAt) };
      }, signal);
    },
    stats: {
      official: (id, options) => steam.official(id, opts(options)),
      summary: (id, options) => steam.summary(id, opts(options)),
      inventory: (id, options) => inventory(id, opts(options)),
      resolveVanity: (value, options) => steam.resolveVanity(value, opts(options)),
      vital,
      vitalServers: async options => {
        requireVital(); const raw = await network.json('vital', '/servers', opts(options));
        need(Array.isArray(raw.data) && raw.data.length <= 100, 'SOURCE_PAGE_LIMIT', 503);
        // Same parser fields as rust-kda-provider.parseVitalServerCatalog, without env import.
        return raw.data.filter(s => /^\d{1,8}$/.test(String(s.id))).map(s => ({ id: String(s.id), name: text(s.displayName, 120), battlemetricsId: text(String(s.battlemetricsServerId || '')) }));
      },
      vitalWipes: async (id, options) => {
        requireVital(); need(/^\d{1,8}$/.test(String(id)), 'INVALID_DATA');
        const raw = await network.json('vital', `/servers/${id}/wipes`, opts(options));
        need(Array.isArray(raw.data) && raw.data.length <= 100, 'SOURCE_PAGE_LIMIT', 503); return raw.data;
      },
      mooseCatalog: (options = {}) => { need(!options.signal?.aborted, 'SOURCE_TIMEOUT', 503); need(configuration.enabled('moose') && typeof mooseEngine === 'function', 'SOURCE_NOT_CONFIGURED', 503); return mooseCatalog(); },
      moosePeriods: (id, options) => moose('periods', { serverId: id }, options),
      moose: (input, options) => moose('player', input, options),
      ...(typeof memberLookup === 'function' ? { memberLookup } : {})
    }
  };
  return {
    readSourceConfig: configuration.readSourceConfig, readers, battlemetricsQueue: sharedBattlemetricsQueue,
    stop: () => network.stop(), get activeIO() { return network.active; }
  };
}
