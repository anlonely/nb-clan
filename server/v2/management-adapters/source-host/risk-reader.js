import { hash, need, text, stamp } from '../../stats/model.js';
import { steamId } from './steam.js';
import { RISK_FIELDS, RISK_ERRORS } from './risk-model.js';
const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
export function createRiskReader({ network, steam, inventory }) {
  return ({ member, config, signal }) => network.tracked(async ownedSignal => {
    const id = steamId(member.steamId), entries = {};
    const read = (source, path, query) => network.json(source, path, { signal: ownedSignal, query, requireKey: source === 'steam', expectedCredentialsHash: config.credentialBindings[source] });
    const capture = async (source, enabled, fn) => {
      const requested = source === 'profile' || config.requiredSources.includes(source);
      if (!requested) return entries[source] = { status: 'not_required', fields: {}, error: null, checkedAt: null };
      try {
        need(enabled, 'SOURCE_NOT_CONFIGURED', 503);
        const fields = await fn();
        const valid = Object.fromEntries(Object.entries(fields).filter(([key, value]) => RISK_FIELDS[source].includes(key) && value !== null && value !== undefined));
        const expected = config.required.filter(f => RISK_FIELDS[source].includes(f));
        entries[source] = { status: expected.every(f => Object.hasOwn(valid, f)) ? 'observed' : Object.keys(valid).length ? 'partial' : 'unavailable', fields: valid,
          error: expected.every(f => Object.hasOwn(valid, f)) ? null : source === 'inventory' && valid.inventoryPublic === true && config.required.includes('inventoryValue') ? 'SOURCE_PRICE_UNAVAILABLE' : 'SOURCE_MISSING_FIELDS', checkedAt: new Date().toISOString() };
        if (source === 'inventory' && fields.enrichmentError === 'RATE_LIMITED') Object.assign(entries[source], {error:'RATE_LIMITED', retryAfterMs:Math.min(3600000, Math.max(1000, Number(fields.retryAfterMs) || 60000))});
      } catch (error) {
        need(!ownedSignal.aborted, 'SOURCE_TIMEOUT', 503);
        const code = RISK_ERRORS.includes(error?.errorCode) ? error.errorCode : 'SOURCE_UNAVAILABLE';
        entries[source] = { status: code === 'SOURCE_PRIVATE' ? 'private' : 'unavailable', fields: {}, error: code,
          checkedAt: new Date().toISOString(), ...(code === 'RATE_LIMITED' ? { retryAfterMs: Math.min(3600000, Math.max(1000, Number(error.retryAfterMs) || 60000)) } : {}) };
      }
    };
    await Promise.all([
      capture('profile', config.riskCapabilities.steam, async () => {
        const raw = await read('steam', '/ISteamUser/GetPlayerSummaries/v0002/', { steamids: id });
        need(Array.isArray(raw.response?.players) && raw.response.players.length === 1 && raw.response.players[0].steamid === id, 'SOURCE_IDENTITY_MISMATCH', 503);
        const p = raw.response.players[0]; return { displayName: text(p.personaname, 120) || null, avatar: text(p.avatarfull, 500) || null,
          profileUrl: `https://steamcommunity.com/profiles/${id}`, profilePublic: [1,2,3].includes(p.communityvisibilitystate) ? p.communityvisibilitystate === 3 : null };
      }),
      capture('playtime', config.riskCapabilities.steam, async () => {
        const raw = await read('steam', '/IPlayerService/GetOwnedGames/v0001/', { steamid: id, include_played_free_games: 1, 'appids_filter[0]': 252490 });
        need(Array.isArray(raw.response?.games) && raw.response.games.length <= 100, 'SOURCE_MISSING_FIELDS', 503);
        const games = raw.response.games.filter(g => g.appid === 252490); need(games.length === 1 && count(games[0].playtime_forever) !== null, 'SOURCE_MISSING_FIELDS', 503);
        // Steam can return zero when the owner hides playtime while leaving game
        // ownership visible. Zero alone cannot prove that Rust was never played.
        const minutes = games[0].playtime_forever;
        return minutes > 0
          ? { playTimeMinutes: minutes, playTimeKnown: true, playTimeVisibility: 'public' }
          : { playTimeKnown: false, playTimeVisibility: 'unknown' };
      }),
      capture('inventory', config.riskCapabilities.inventory, async () => {
        const result = await inventory(id, { signal: ownedSignal, riskRead: true, inventoryOnly: true, skipEnrichment: !config.required.includes('inventoryValue'), expectedCredentialsHash: config.credentialBindings.community });
        need(result.inventoryAvailable, result.explicitPrivate ? 'SOURCE_PRIVATE' : 'SOURCE_UNAVAILABLE', 503);
        const total = result.totalSummary;
        return { enrichmentError: result.enrichmentError, retryAfterMs: result.retryAfterMs, inventoryPublic: true, inventoryVisibility: 'public', inventoryValue: total?.currency === 'USD' ? numeric(total?.totalValue) : null, inventoryCurrency: total?.currency === 'USD' && numeric(total?.totalValue) !== null ? 'USD' : null };
      }),
      capture('bans', config.riskCapabilities.steam && config.riskCapabilities.steamRisk, async () => {
        const row = await steam.risk(id, { signal: ownedSignal, expectedCredentialsHash: config.credentialBindings.steam });
        need(row.steamId === id, 'SOURCE_IDENTITY_MISMATCH', 503);
        const vacCount = count(row.numberOfVacBans), gameCount = count(row.numberOfGameBans), economy = ['none','banned','probation'].includes(row.economyBan) ? row.economyBan : null;
        return { vacBanned: vacCount > 0 ? true : row.vacBanned, numberOfVacBans: vacCount, numberOfGameBans: gameCount, daysSinceLastBan: count(row.daysSinceLastBan),
          communityBanned: row.communityBanned, economyBan: economy, economyRestricted: economy === null ? null : economy !== 'none' };
      }),
      capture('restriction', config.riskCapabilities.steamRisk, async () => {
        const raw = await read('community', '/broadcast/getbroadcastmpd/', { steamid: id });
        need(['user_restricted','ready','unavailable'].includes(raw.success) && !raw.error, 'SOURCE_INVALID_DATA', 503);
        return { accountRestricted: raw.success === 'unavailable' ? null : raw.success === 'user_restricted', accountRestrictionStatus: raw.success,
          accountRestrictionRetryMs: numeric(raw.retry), accountRestrictionEresult: count(raw.eresult) };
      }),
      capture('official', config.riskCapabilities.steam, async () => {
        const raw = await read('steam', '/ISteamUserStats/GetUserStatsForGame/v0002/', { steamid: id, appid: 252490 });
        need(String(raw.playerstats?.steamID) === id, 'SOURCE_IDENTITY_MISMATCH', 503);
        const rows = raw.playerstats.stats; need(Array.isArray(rows) && rows.length <= 2000, 'SOURCE_INVALID_DATA', 503);
        const values = new Map(); for (const r of rows) { need(!values.has(r.name), 'SOURCE_INVALID_DATA', 503); values.set(r.name, numeric(r.value)); }
        const kills = values.get('kill_player'), deaths = values.get('deaths');
        return { 'officialKda.kills': kills, 'officialKda.deaths': deaths,
          'officialKda.kd': kills != null && deaths != null ? Math.round(kills / Math.max(1, deaths) * 100) / 100 : null, 'officialKda.rockets': values.get('rocket_fired') };
      })
    ]);
    need(!ownedSignal.aborted, 'SOURCE_TIMEOUT', 503);
    return entries;
  }, signal, 3);
}
