import { parseSteamIdentifier } from '../discord-steam-links/interaction-input.js';
import { isSteamIndividualId64 as steamId64 } from '../management-adapters/source-host/steam.js';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const clean = (value, limit = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const stamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const fail = reason => Object.assign(new Error('STEAM_LINKS_PROVIDER_UNAVAILABLE'), { reason });
const sourceStatus = error => error?.errorCode === 'SOURCE_NO_MATCH' ? 'not_found' : 'unavailable';

/** Read-only adapter. Steam credentials, source policy and proxy routing remain
 * owned by the existing source host. Guild membership uses one fixed Discord
 * API route and never follows a URL supplied by a member or by an upstream page. */
export function createDiscordSteamProvider({ getSourceHost, readCredentials, fetchImpl,
  readBattlemetricsProfile, now = () => Date.now(), timeoutMs = 10000, maxMemberPages = 100 } = {}) {
  if (typeof getSourceHost !== 'function' || typeof readCredentials !== 'function' || typeof fetchImpl !== 'function' ||
    !Number.isInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000 ||
    !Number.isInteger(maxMemberPages) || maxMemberPages < 1 || maxMemberPages > 100) throw fail('configuration');
  const active = new Set();
  let stopped = false;
  const fetchedAt = () => new Date(now()).toISOString();
  async function bounded(signal, work) {
    if (stopped || signal?.aborted || active.size >= 12) throw fail('unavailable');
    const controller = new AbortController(); active.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(fail('timeout')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    try {
      const result = await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]);
      if (controller.signal.aborted || stopped) throw fail('timeout');
      return result;
    } finally {
      controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
      clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller);
    }
  }
  function observedSteam(raw, steamId) {
    if (!raw || raw.steamId !== steamId) throw fail('invalid_source');
    // Existing Steam risk collection treats a lone zero as unknown: Steam may
    // hide playtime while returning the owned game with zero minutes.
    const rustMinutes = finite(raw.playtimeMinutes) > 0 ? raw.playtimeMinutes : null;
    return { status: raw.profilePublic === false ? 'private' : 'ok', steamId,
      displayName: clean(raw.name), fetchedAt: fetchedAt(), enrichment: { steam: {
        status: raw.profilePublic === false ? 'private' : 'ok', source: 'Steam', fetchedAt: fetchedAt(),
        profilePublic: typeof raw.profilePublic === 'boolean' ? raw.profilePublic : null,
        accountCreatedAt: stamp(raw.createdAt), rustMinutes,
        rustStatus: rustMinutes !== null ? 'ok' : raw.profilePublic === false ? 'private' : 'unknown'
      } } };
  }
  async function summary(steamId, signal) {
    const host = getSourceHost();
    if (typeof host?.readers?.stats?.summary !== 'function') throw fail('configuration');
    return observedSteam(await host.readers.stats.summary(steamId, { signal }), steamId);
  }
  async function resolveIdentifier(raw, { signal } = {}) {
    const parsed = parseSteamIdentifier(raw);
    if (!parsed || parsed.kind === 'steamid' && !steamId64(parsed.steamId)) return { status: 'invalid' };
    try {
      return await bounded(signal, async ownedSignal => {
        const steamId = parsed.kind === 'steamid' ? parsed.steamId :
          await getSourceHost()?.readers?.stats?.resolveVanity?.(parsed.vanity, { signal: ownedSignal });
        if (!steamId64(steamId)) throw fail('invalid_source');
        const profile = await summary(steamId, ownedSignal);
        return { status: 'ok', steamId, profile };
      });
    } catch (error) { return { status: sourceStatus(error) }; }
  }
  async function bans(steamId, signal) {
    const result = { source: 'Steam', fetchedAt: fetchedAt() };
    try {
      const raw = await getSourceHost()?.readers?.readSteamRisk?.(steamId, { signal });
      if (!raw || raw.steamId !== steamId) throw fail('invalid_source');
      const values = { vacBanned: typeof raw.vacBanned === 'boolean' ? raw.vacBanned : null,
        communityBanned: typeof raw.communityBanned === 'boolean' ? raw.communityBanned : null,
        numberOfVacBans: count(raw.numberOfVacBans), numberOfGameBans: count(raw.numberOfGameBans) };
      return { ...result, status: Object.values(values).every(value => value !== null) ? 'ok' : 'partial', ...values };
    } catch { return { ...result, status: 'unavailable' }; }
  }
  async function battlemetrics(steamId, signal) {
    const empty = { status: 'unavailable', source: 'BattleMetrics', fetchedAt: null };
    if (typeof readBattlemetricsProfile !== 'function') return empty;
    try {
      const raw = await readBattlemetricsProfile(steamId, { signal });
      if (!raw) return { ...empty, status: 'unknown' };
      const from = stamp(raw.battlemetricsRangeStartAt), to = stamp(raw.battlemetricsRangeStopAt),
        observedAt = stamp(raw.battlemetricsSyncedAt), seconds = finite(raw.battlemetricsServerPlayTimeSeconds);
      // Only a completed, identity-matched collection with its actual server and
      // time window may become a number. Legacy totals lack that evidence.
      if (raw.steamId !== steamId || !/^\d{1,30}$/.test(raw.battlemetricsPlayerId || '') ||
        !/^\d{1,30}$/.test(raw.battlemetricsServerId || '') || !clean(raw.battlemetricsWipeId) ||
        raw.battlemetricsSessionTruncated !== false || seconds === null || !from || !to || !observedAt ||
        Date.parse(from) > Date.parse(to) || Date.parse(observedAt) > now() + 60000) return { ...empty, status: 'unknown' };
      return { status: 'ok', source: 'BattleMetrics', fetchedAt: observedAt, trackedSeconds: seconds,
        playerId: raw.battlemetricsPlayerId, serverId: raw.battlemetricsServerId,
        wipeId: clean(raw.battlemetricsWipeId), from, to };
    } catch { return empty; }
  }
  async function readProfile(steamId, { signal } = {}) {
    if (!steamId64(steamId)) return { status: 'invalid', steamId };
    try {
      return await bounded(signal, async ownedSignal => {
        const [profile, banData, bmData] = await Promise.all([
          summary(steamId, ownedSignal), bans(steamId, ownedSignal), battlemetrics(steamId, ownedSignal)
        ]);
        return { ...profile, enrichment: { ...profile.enrichment, bans: banData, battlemetrics: bmData } };
      });
    } catch (error) { return { status: sourceStatus(error), steamId, fetchedAt: fetchedAt() }; }
  }
  function botToken() {
    const credentials = readCredentials();
    const token = credentials?.botToken;
    if (credentials?.then || typeof token !== 'string' || !token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) throw fail('configuration');
    return token;
  }
  async function pageJson(response, signal) {
    const reader = response.body?.getReader?.();
    if (!reader) throw fail('invalid_source');
    const chunks = []; let bytes = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw fail('timeout');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw fail('invalid_source');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  }
  async function listGuildMembers(guildId, { signal } = {}) {
    if (!snowflake(guildId)) return { status: 'error', complete: false, reason: 'invalid_guild' };
    try {
      return await bounded(signal, async ownedSignal => {
        const token = botToken(), members = [];
        let after = null;
        for (let page = 0; page < maxMemberPages; page++) {
          if (ownedSignal.aborted) throw fail('timeout');
          if (botToken() !== token) throw fail('credentials_changed');
          const url = `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000${after ? `&after=${after}` : ''}`;
          const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bot ${token}`, accept: 'application/json' },
            signal: ownedSignal, redirect: 'manual' });
          try {
            if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== 'https://discord.com') throw fail('invalid_source');
            if ([401, 403].includes(response.status)) throw fail('member_access_denied');
            if (response.status === 429) throw fail('rate_limited');
            if (response.status !== 200) throw fail('upstream');
            const rows = await pageJson(response, ownedSignal);
            if (botToken() !== token) throw fail('credentials_changed');
            if (!Array.isArray(rows) || rows.length > 1000) throw fail('invalid_source');
            for (const row of rows) {
              const user = row?.user;
              if (!snowflake(user?.id) || after && BigInt(user.id) <= BigInt(after) ||
                user.bot !== undefined && typeof user.bot !== 'boolean' || typeof user.username !== 'string') throw fail('invalid_source');
              after = user.id;
              members.push({ discordId: user.id, displayName: clean(row.nick || user.global_name || user.username), bot: user.bot === true });
            }
            if (rows.length < 1000) return { status: 'ok', complete: true, members, fetchedAt: fetchedAt() };
          } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
        }
        throw fail('member_page_limit');
      });
    } catch (error) {
      // No partial member rows, HTTP bodies, credential values, arbitrary URLs or
      // upstream error messages are exposed to the command or to Discord.
      return { status: 'unavailable', complete: false, reason: ['member_access_denied', 'member_page_limit', 'rate_limited', 'timeout'].includes(error?.reason) ? error.reason : 'member_fetch_failed' };
    }
  }
  return Object.freeze({ resolveIdentifier, readProfile, listGuildMembers,
    stop() { stopped = true; for (const controller of active) controller.abort(); } });
}
