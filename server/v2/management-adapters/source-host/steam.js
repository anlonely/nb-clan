import { need, text } from '../../stats/model.js';
export const isSteamIndividualId64 = id => typeof id === 'string' && /^\d{17}$/.test(id) &&
  BigInt(id) > 76561197960265728n && BigInt(id) <= 76561202255233023n;
export const steamId = id => { need(isSteamIndividualId64(id), 'INVALID_DATA'); return id; };
const finite = v => v != null && typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
function publicRustMinutes(html) {
  // A public Steam profile may expose Rust hours in its favorite-game showcase
  // even when GetOwnedGames returns zero. Read only that Steam-owned card.
  const start = typeof html === 'string' ? html.indexOf('favoritegame_showcase') : -1;
  if (start < 0) return null;
  const card = html.slice(start, start + 3000);
  const game = card.search(/href="https:\/\/steamcommunity\.com\/app\/252490\/?"/i);
  const stats = card.indexOf('class="showcase_stats_row"');
  if (game < 0 || stats < game) return null;
  const match = card.slice(stats, stats + 900).match(/<div class="value">\s*([\d,]+(?:\.\d+)?)\s*<\/div>\s*<div class="label">\s*Hours played\s*<\/div>/i);
  if (!match) return null;
  const hours = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(hours) && hours >= 0 && hours <= 200000 ? Math.round(hours * 60) : null;
}
export function createSteamReaders({ network, allowed }) {
  const requireSteam = () => need(allowed('steam'), 'SOURCE_NOT_CONFIGURED', 503);
  const json = (path, query, options = {}) => { requireSteam(); return network.json('steam', path, { query, requireKey: true, signal: options.signal, expectedCredentialsHash: options.expectedCredentialsHash }); };
  const ownedGames = async (id, options) => {
    const raw = await json('/IPlayerService/GetOwnedGames/v0001/', { steamid: steamId(id), include_appinfo: 0, include_played_free_games: 1, 'appids_filter[0]': 252490 }, options);
    const games = raw.response?.games;
    // Absence is unknown; an empty returned game list is not proof of 0 Rust lifetime hours.
    return Array.isArray(games) ? games.find(g => g.appid === 252490) || null : null;
  };
  const optionalDetail = async (read, options) => {
    try { return await read(); }
    catch (error) {
      // Official statistics remain available when optional profile/game details fail.
      // Cancellation and credential changes still fence the entire observation.
      if (options?.signal?.aborted || ['SOURCE_TIMEOUT','CREDENTIALS_CHANGED'].includes(error?.errorCode)) throw error;
      if (!['SOURCE_NO_MATCH','CREDENTIALS_INVALID','SOURCE_UNAVAILABLE','PROXY_UNAVAILABLE','RATE_LIMITED'].includes(error?.errorCode)) throw error;
      return null;
    }
  };
  const optionalGames = (id, options) => optionalDetail(() => ownedGames(id, options), options);
  const optionalPublicHours = async (id, options) => {
    try { return publicRustMinutes(await network.html('community', `/profiles/${steamId(id)}/?l=english`, options)); }
    catch (error) {
      if (options?.signal?.aborted || network.stopped || error?.errorCode === 'CREDENTIALS_CHANGED') throw error;
      return null;
    }
  };
  const playerSummary = async (id, options = {}) => {
    const raw = await json('/ISteamUser/GetPlayerSummaries/v0002/', { steamids: steamId(id) }, options);
    const player = raw.response?.players?.find(p => p.steamid === id); need(player, 'SOURCE_NO_MATCH', 404);
    const createdAt = Number.isSafeInteger(player.timecreated) && player.timecreated > 0 && player.timecreated * 1000 <= Date.now() + 86400000
      ? new Date(player.timecreated * 1000).toISOString() : null;
    return { name: text(player.personaname, 120), avatar: text(player.avatarfull, 500), createdAt,
      profilePublic: typeof player.communityvisibilitystate === 'number' ? player.communityvisibilitystate === 3 : null };
  };
  const summary = async (id, options = {}) => {
    const player = await playerSummary(id, options);
    const games = await optionalGames(id, options);
    return { steamId: id, name: player.name, avatar: player.avatar, createdAt: player.createdAt,
      profileUrl: `https://steamcommunity.com/profiles/${id}`, profilePublic: player.profilePublic,
      playtimeMinutes: finite(games?.playtime_forever) };
  };
  const official = async (id, options = {}) => {
    const raw = await json('/ISteamUserStats/GetUserStatsForGame/v0002/', { steamid: steamId(id), appid: 252490 }, options);
    need(raw.playerstats && Array.isArray(raw.playerstats.stats) && raw.playerstats.stats.length > 0 && raw.playerstats.stats.length <= 2000, 'SOURCE_NO_MATCH', 404);
    need(String(raw.playerstats.steamID) === id, 'INVALID_DATA');
    const stats = {};
    for (const row of raw.playerstats.stats) if (typeof row.name === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(row.name) && finite(row.value) !== null) stats[row.name] = row.value;
    const [games, player] = await Promise.all([optionalGames(id, options), optionalDetail(() => playerSummary(id, options), options)]);
    const ownedMinutes = finite(games?.playtime_forever);
    const conflictingZero = ownedMinutes === 0 && Object.values(stats).some(value => value > 0);
    const visibleMinutes = ownedMinutes === null || conflictingZero ? await optionalPublicHours(id, options) : null;
    // A zero-hour game with recorded Rust activity is a conflicting observation,
    // not proof that the player has never played.
    const minutesPlayed = visibleMinutes ?? (conflictingZero ? null : ownedMinutes);
    return { raw_stats: stats, minutes_played: minutesPlayed, steamProfile: player };
  };
  const resolveVanity = async (vanity, options = {}) => {
    need(/^[A-Za-z0-9_-]{1,64}$/.test(vanity), 'INVALID_DATA');
    const raw = await json('/ISteamUser/ResolveVanityURL/v0001/', { vanityurl: vanity }, options);
    need(raw.response?.success === 1, 'SOURCE_NO_MATCH', 404); return steamId(raw.response.steamid);
  };
  // Explicit separate capability, used by the opt-in complete member risk collector.
  const risk = async (id, options = {}) => {
    need(allowed('steamRisk'), 'SOURCE_NOT_CONFIGURED', 503);
    const raw = await json('/ISteamUser/GetPlayerBans/v1/', { steamids: steamId(id) }, options);
    const row = raw.players?.find(p => p.SteamId === id); need(row, 'SOURCE_NO_MATCH', 404);
    return { steamId: id, vacBanned: typeof row.VACBanned === 'boolean' ? row.VACBanned : null, communityBanned: typeof row.CommunityBanned === 'boolean' ? row.CommunityBanned : null, numberOfVacBans: finite(row.NumberOfVACBans), numberOfGameBans: finite(row.NumberOfGameBans), daysSinceLastBan: finite(row.DaysSinceLastBan), economyBan: row.EconomyBan ? text(row.EconomyBan, 80) : null };
  };
  return { summary, official, resolveVanity, risk };
}
