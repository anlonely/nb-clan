import { projectInventoryQuery, projectMooseQuery, requiresProjection } from '../source-providers/projection.js';
import { need, text, stamp, parseSteamInput } from './model.js';
import { VITAL_STAT_PATHS, vitalValue, vitalNumber, vitalBuildingCount, vitalPlayTimeSeconds, vitalCategories, vitalWipeCatalog } from './vital.js';
const value = (object, path) => {
  let current = object;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (current && Object.hasOwn(current, parts.slice(i).join('.'))) return current[parts.slice(i).join('.')];
    current = current?.[parts[i]];
  }
  return current ?? null;
};
const recoverableInventoryErrors = new Set([
  'RATE_LIMITED', 'SOURCE_UNAVAILABLE', 'PROXY_UNAVAILABLE', 'SOURCE_NO_MATCH',
  'SOURCE_PRIVATE', 'SOURCE_PAGE_LIMIT', 'SOURCE_RESPONSE_TOO_LARGE', 'SOURCE_TIMEOUT'
]);
function fields(object, prefix = '', depth = 0) {
  if (depth > 5 || !object || typeof object !== 'object') return [];
  return Object.entries(object).flatMap(([key, v]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return [{
      name,
      value: v,
      status: 'observed'
    }];
    return fields(v, name, depth + 1);
  }).slice(0, 200);
}
/** Explicit read-only provider bridge. Caller supplies source functions, credentials stay inside closures.
 * Never pass old rustKdaQueryPayload/cacheOfficialKdaQueryResult: those mutate memberProfiles.
 */
export function createStatsProviders({
  resolveVanity,
  official,
  inventory,
  vital,
  moose,
  summary,
  memberLookup,
  vitalServers,
  vitalWipes,
  mooseCatalog,
  moosePeriods
} = {}) {
  const resolve = async (input, options) => {
    need(!options.signal?.aborted, 'SOURCE_TIMEOUT', 503);
    const parsed = parseSteamInput(input.steamInput);
    if (parsed.steamId) return parsed.steamId;
    need(resolveVanity, 'VANITY_RESOLVER_REQUIRED', 503);
    const id = await resolveVanity(parsed.vanity, options);
    need(/^7656119\d{10}$/.test(id), 'STEAM_NOT_FOUND', 404);
    return id;
  };
  const wrapped = fn => async (input, options = {}) => {
    const steamId = await resolve(input, options);
    need(!options.signal?.aborted, 'SOURCE_TIMEOUT', 503);
    return fn({
      ...input,
      steamId
    }, options);
  };
  return {
    official: wrapped(async (input, options) => {
      need(official, 'SOURCE_UNAVAILABLE', 503);
      let raw;
      try {
        raw = await official(input.steamId, options);
      } catch (error) {
        if (error?.errorCode !== 'SOURCE_NO_MATCH') throw error;
        return { steamId: input.steamId, status: 'unavailable', rows: [], fields: [] };
      }
      const stats = raw.raw_stats || raw.stats || {},
        s = raw.summary || {};
      return {
        steamId: input.steamId,
        displayName: raw.steamProfile?.name,
        steamProfile: raw.steamProfile,
        status: raw.error || raw.is_private ? 'private' : 'fresh',
        rows: [{
          id: 'official:' + input.steamId,
          steamId: input.steamId,
          sourceId: 'official',
          serverId: 'official-lifetime',
          providerWipeId: 'lifetime',
          kills: value(stats, 'kill_player'),
          deaths: value(stats, 'deaths'),
          assists: null,
          capabilities: {
            assists: false
          },
          rockets: value(stats, 'rocket_fired'),
          sulfur: value(stats, 'harvest.sulfur_ore'),
          metalOre: value(stats, 'harvest.metal_ore'),
          building: value(stats, 'placed_blocks'),
          steamTotalSeconds: raw.minutes_played == null ? null : raw.minutes_played * 60,
          kd: s.kdRatio ?? raw.kdr,
          capturedAt: new Date().toISOString(),
          coverage: 'lifetime'
        }],
        fields: fields({
          summary: s,
          resources: raw.resources,
          building: raw.building,
          misc: raw.misc,
          rawStats: stats
        })
      };
    }),
    vital: wrapped(async (input, options) => {
      need(vital && /^\d{1,8}$/.test(input.serverId), 'VITAL_SERVER_REQUIRED');
      const includes = [...VITAL_STAT_PATHS, 'combat', 'raiding', 'farming', 'building', 'general', 'pve'];
      const result = await vital({
        playerIds: [input.steamId],
        serverId: input.serverId,
        wipeId: input.providerWipeId,
        includes
      }, options);
      const rows = Array.isArray(result) ? result : result?.data;
      need(Array.isArray(rows) && rows.length <= 10, 'SOURCE_INVALID_DATA', 503);
      const matches = rows.filter(p => String(p?.context?.userId) === input.steamId);
      need(matches.length <= 1, 'SOURCE_INVALID_DATA', 503);
      const raw = matches[0];
      if (!raw) return { steamId: input.steamId, serverId: input.serverId,
        providerWipeId: input.providerWipeId, status: 'unavailable', rows: [], fields: [], categories: [] };
      const stats = raw.statistics || {};
      const categories = vitalCategories(stats);
      return {
        steamId: input.steamId,
        displayName: raw.player?.name,
        serverId: input.serverId,
        providerWipeId: input.providerWipeId,
        status: 'fresh',
        rows: [{
          id: 'vital:' + input.steamId,
          sourceId: 'vital',
          steamId: input.steamId,
          serverId: input.serverId,
          providerWipeId: input.providerWipeId,
          kills: vitalNumber(vitalValue(stats, 'combat.kills')),
          deaths: vitalNumber(vitalValue(stats, 'combat.deaths')),
          assists: null,
          capabilities: {
            assists: false
          },
          t3Kills: vitalNumber(vitalValue(stats, 'combat.killsT3')),
          rockets: vitalNumber(vitalValue(stats, 'raiding.rockets')),
          sulfur: vitalNumber(vitalValue(stats, 'farming.gathered.sulfur.ore')),
          metalOre: vitalNumber(vitalValue(stats, 'farming.gathered.metal.ore')),
          building: vitalBuildingCount(stats),
          playTimeSeconds: vitalPlayTimeSeconds(raw),
          categories,
          capturedAt: stamp(raw.capturedAt) || new Date().toISOString(),
          coverage: input.providerWipeId ? 'wipe' : 'all_provider_wipes'
        }],
        fields: categories.flatMap(category => category.fields),
        categories
      };
    }),
    moose: wrapped(async (input, options) => {
      need(moose && input.serverId && input.providerWipeId, 'MOOSE_CONTEXT_REQUIRED');
      let playerName = text(input.playerName, 120);
      if (!playerName && summary) {
        const p = await summary(input.steamId, options);
        playerName = text(p?.name, 120);
      }
      const raw = await moose({
        steamId: input.steamId,
        serverId: input.serverId,
        period: input.providerWipeId,
        categoryIds: input.categoryIds || [],
        playerName
      }, options);
      if (requiresProjection(moose,raw)) return projectMooseQuery(raw,input);
      return {
        steamId: input.steamId,
        displayName: raw.identity?.playerName,
        status: raw.matchedCategories ? 'fresh' : 'unavailable',
        rows: [],
        fields: (raw.categories || []).flatMap(c => (c.fields || []).map(f => ({
          name: `${c.category?.name || c.category?.id} · ${f.labelZh || f.label || f.id}`,
          value: c.selectedMatch?.values?.[f.id] ?? null,
          status: c.selectedMatch ? 'observed' : 'not_found'
        })))
      };
    }),
    inventory: wrapped(async (input, options) => {
      need(inventory, 'SOURCE_UNAVAILABLE', 503);
      // Leave time inside the 15-second query job for a profile-only result.
      const timeout = AbortSignal.timeout(12000);
      const inventorySignal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const [inventoryRead, profileRead] = await Promise.allSettled([
        inventory(input.steamId, { ...options, signal: inventorySignal, includeStoreCatalog: false }),
        summary ? summary(input.steamId, options) : Promise.resolve(null)
      ]);
      need(!options.signal?.aborted, 'SOURCE_TIMEOUT', 503);
      const profile = profileRead.status === 'fulfilled' ? profileRead.value : null;
      need(!profile || profile.steamId === input.steamId, 'SOURCE_IDENTITY_MISMATCH', 503);
      if (inventoryRead.status === 'fulfilled') return projectInventoryQuery(inventoryRead.value,input.steamId,Date.now(),profile);
      const error = inventoryRead.reason;
      if (!profile || !recoverableInventoryErrors.has(error?.errorCode)) throw error;
      return {
        steamId: input.steamId, displayName: profile.name, steamProfile: profile,
        status: 'partial', inventory: { status: 'unavailable', currency: null, total: null, items: [] },
        errors: [{ sourceId: error.sourceId || 'community', errorCode: error.errorCode,
          retryAfterMs: error.retryAfterMs, retryAfterKnown: error.retryAfterKnown === true }]
      };
    }),
    ...(typeof memberLookup === 'function' ? { member: wrapped((input, options) => memberLookup(input.steamId, options)) } : {}),
    catalog: async (input, options) => {
      const provider = input.provider || 'vital';
      if (provider === 'moose') {
        need(mooseCatalog, 'SOURCE_UNAVAILABLE', 503);
        const raw = input.serverId ? (need(moosePeriods, 'SOURCE_UNAVAILABLE', 503), await moosePeriods(input.serverId, options)) : await mooseCatalog(options);
        return {
          items: [...(raw.servers || []).map(i => ({
            id: i.id,
            name: i.name,
            serverId: i.id
          })), ...(raw.periods || []).map(i => ({
            id: i.id || i.name,
            name: i.name,
            serverId: input.serverId,
            providerWipeId: i.id || i.name
          })), ...(raw.categories || []).map(i => ({
            id: i.id,
            name: i.name,
            category: i.id
          }))]
        };
      }
      need(vitalServers, 'SOURCE_UNAVAILABLE', 503);
      const raw = input.serverId ? (need(vitalWipes, 'SOURCE_UNAVAILABLE', 503), await vitalWipes(input.serverId, options)) : await vitalServers(options);
      const rows = Array.isArray(raw) ? raw : raw.data || raw.servers || [];
      return {
        items: input.serverId ? vitalWipeCatalog(rows, input.serverId) : rows.map(i => ({
          id: String(i.id || i.wipeId || i.serverId),
          name: i.name || i.displayName || String(i.id),
          serverId: String(i.serverId || input.serverId || i.id),
          providerWipeId: input.serverId ? String(i.id || i.wipeId) : ''
        }))
      };
    }
  };
}
