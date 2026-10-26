import {
  assertExternalProviderAvailable,
  recordExternalProviderFailure,
  recordExternalProviderSuccess
} from './external-provider-health.js';

const STEAM_ID64_BASE = 76561197960265728n;
const STEAM_ID64_RE = /(?:^|[^\d])(7656\d{13})(?:$|[^\d])/;
const STEAM_LEGACY_RE = /^STEAM_[0-5]:([01]):(\d+)$/i;
const STEAM_ACCOUNT_RE = /^\[U:1:(\d+)]$/i;
const VANITY_RE = /steamcommunity\.com\/id\/([^/?#\s]+)/i;
const STEAM_BROADCAST_TIMEOUT_MS = 4500;
const STEAM_WEB_API_TIMEOUT_MS = 6000;
const STEAM_PLAYER_BANS_BATCH_SIZE = 100;
const STEAM_WEB_API_BASE_URL = String(process.env.NB_STEAM_WEB_API_BASE_URL || 'https://api.steampowered.com').replace(/\/+$/, '');

function numberFromEnv(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export const STEAM_BROADCAST_REQUEST_INTERVAL_MS = Math.max(
  0,
  numberFromEnv(process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS, 3000)
);

export const STEAM_WEB_API_REQUEST_INTERVAL_MS = Math.max(
  0,
  numberFromEnv(process.env.NB_STEAM_WEB_API_REQUEST_INTERVAL_MS, 1000)
);

export const STEAM_WEB_API_DAILY_LIMIT = Math.max(
  1,
  numberFromEnv(process.env.NB_STEAM_WEB_API_DAILY_LIMIT, 100000)
);

let steamBroadcastQueue = Promise.resolve();
let lastSteamBroadcastRequestAt = 0;
let steamWebApiQueue = Promise.resolve();
let lastSteamWebApiRequestAt = 0;
let steamWebApiUsageDay = '';
let steamWebApiUsageCount = 0;

function toSteamId64(accountId) {
  return (STEAM_ID64_BASE + BigInt(accountId)).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSteamId64(value) {
  return /^7656\d{13}$/.test(String(value || ''));
}

function steamWebApiKey() {
  return String(process.env.NB_STEAM_WEB_API_KEY || process.env.STEAM_WEB_API_KEY || process.env.STEAM_API_KEY || '').trim();
}

function steamProviderScope(kind, id = '') {
  const normalizedKind = String(kind || 'global').trim().slice(0, 80) || 'global';
  const normalizedId = String(id || 'global').trim().slice(0, 160) || 'global';
  return `${normalizedKind}:${normalizedId}`;
}

function steamHttpError(label, status) {
  return Object.assign(new Error(`${label} HTTP ${status}`), { status });
}

function steamAbortError(label) {
  return Object.assign(new Error(`${label} timeout`), { status: 504, name: 'AbortError' });
}

function uniqueSteamIds(steamIds) {
  return [...new Set((Array.isArray(steamIds) ? steamIds : [steamIds])
    .map((steamId) => String(steamId || '').trim())
    .filter(isSteamId64))];
}

function steamWebApiDay() {
  return new Date().toISOString().slice(0, 10);
}

function reserveSteamWebApiCall() {
  const day = steamWebApiDay();
  if (steamWebApiUsageDay !== day) {
    steamWebApiUsageDay = day;
    steamWebApiUsageCount = 0;
  }
  if (steamWebApiUsageCount >= STEAM_WEB_API_DAILY_LIMIT) {
    throw Object.assign(new Error('Steam Web API daily limit reached'), { status: 429 });
  }
  steamWebApiUsageCount += 1;
}

function queueSteamWebApiRequest(task) {
  const run = steamWebApiQueue.then(async () => {
    const elapsedMs = lastSteamWebApiRequestAt ? Date.now() - lastSteamWebApiRequestAt : Infinity;
    const waitMs = Math.max(0, STEAM_WEB_API_REQUEST_INTERVAL_MS - elapsedMs);
    if (waitMs > 0) await sleep(waitMs);
    reserveSteamWebApiCall();
    lastSteamWebApiRequestAt = Date.now();
    return task();
  });
  steamWebApiQueue = run.catch(() => {});
  return run;
}

function normalizeRawInput(input) {
  return String(input || '').trim().slice(0, 500);
}

export function parseSteamInput(input) {
  const rawInput = normalizeRawInput(input);
  if (!rawInput) {
    return { ok: false, rawInput, message: 'Steam ID 必填' };
  }

  const legacyMatch = rawInput.match(STEAM_LEGACY_RE);
  if (legacyMatch) {
    const y = BigInt(legacyMatch[1]);
    const z = BigInt(legacyMatch[2]);
    return {
      ok: true,
      rawInput,
      steamId: toSteamId64(z * 2n + y),
      kind: 'steam2'
    };
  }

  const accountMatch = rawInput.match(STEAM_ACCOUNT_RE);
  if (accountMatch) {
    return {
      ok: true,
      rawInput,
      steamId: toSteamId64(accountMatch[1]),
      kind: 'steam3'
    };
  }

  const steamId64Match = rawInput.match(STEAM_ID64_RE);
  if (steamId64Match) {
    return {
      ok: true,
      rawInput,
      steamId: steamId64Match[1],
      kind: rawInput.includes('steamcommunity.com/profiles/') ? 'profile_url' : 'steamid64'
    };
  }

  const numericAccountId = rawInput.match(/^\d{7,10}$/);
  if (numericAccountId) {
    return {
      ok: true,
      rawInput,
      steamId: toSteamId64(rawInput),
      kind: 'account_id'
    };
  }

  const vanity = rawInput.match(VANITY_RE);
  if (vanity) {
    return {
      ok: false,
      rawInput,
      kind: 'vanity_url',
      vanity: decodeURIComponent(vanity[1]),
      message: '自定义 Steam 资料页需要在线解析'
    };
  }

  return {
    ok: false,
    rawInput,
    message: '无法识别 SteamID，请输入 SteamID64、STEAM_X:Y:Z、[U:1:accountid] 或 Steam 资料页'
  };
}

function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.*?)]]><\\/${tag}>|<${tag}>(.*?)<\\/${tag}>`, 'i'));
  return match ? (match[1] || match[2] || '').trim() : '';
}

async function fetchProfileXml(url) {
  const urlText = String(url || '');
  const steamId = urlText.match(/\/profiles\/(\d+)/)?.[1] || '';
  const vanity = urlText.match(/\/id\/([^/?#]+)/)?.[1] || '';
  const scope = steamProviderScope('profile_xml', steamId || vanity || 'unknown');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    assertExternalProviderAvailable('steam_profile', scope);
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      recordExternalProviderFailure('steam_profile', steamHttpError('Steam profile', response.status), scope);
      return null;
    }
    const xml = await response.text();
    recordExternalProviderSuccess('steam_profile', scope);
    return xml;
  } catch (error) {
    if (!error?.circuitOpen) {
      recordExternalProviderFailure(
        'steam_profile',
        error?.name === 'AbortError' ? steamAbortError('Steam profile') : error,
        scope
      );
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function finiteNumberOrDefault(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function parseSteamBroadcastPayload(steamId, payload = {}) {
  const success = String(payload?.success || '').trim().toLowerCase();
  return {
    steamId: String(steamId || ''),
    success,
    restricted: success === 'user_restricted',
    retryMs: finiteNumberOrDefault(payload?.retry, 0),
    broadcastId: finiteNumberOrDefault(payload?.broadcastid ?? payload?.broadcastId, 0),
    eresult: finiteNumberOrDefault(payload?.eresult, 0),
    error: ''
  };
}

function finiteNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function booleanFromSteam(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return fallback;
}

export function parseSteamPlayerBanRecord(record = {}) {
  const steamId = String(record?.SteamId || record?.steamId || record?.steamid || '').trim();
  const numberOfVacBans = finiteNonNegativeInteger(record?.NumberOfVACBans ?? record?.numberOfVacBans);
  const numberOfGameBans = finiteNonNegativeInteger(record?.NumberOfGameBans ?? record?.numberOfGameBans);
  const daysSinceLastBan = finiteNonNegativeInteger(record?.DaysSinceLastBan ?? record?.daysSinceLastBan);
  const economyBan = String(record?.EconomyBan ?? record?.economyBan ?? 'none').trim().toLowerCase() || 'none';
  return {
    steamId,
    vacBanned: booleanFromSteam(record?.VACBanned ?? record?.vacBanned, numberOfVacBans > 0),
    numberOfVacBans,
    numberOfGameBans,
    daysSinceLastBan,
    communityBanned: booleanFromSteam(record?.CommunityBanned ?? record?.communityBanned),
    economyBan,
    economyRestricted: Boolean(economyBan && economyBan !== 'none'),
    error: ''
  };
}

export function parseSteamPlayerBansPayload(payload = {}) {
  const players = Array.isArray(payload?.players) ? payload.players : [];
  return new Map(players
    .map(parseSteamPlayerBanRecord)
    .filter((record) => isSteamId64(record.steamId))
    .map((record) => [record.steamId, record]));
}

function queueSteamBroadcastRequest(task) {
  const run = steamBroadcastQueue.then(async () => {
    const elapsedMs = lastSteamBroadcastRequestAt ? Date.now() - lastSteamBroadcastRequestAt : Infinity;
    const waitMs = Math.max(0, STEAM_BROADCAST_REQUEST_INTERVAL_MS - elapsedMs);
    if (waitMs > 0) await sleep(waitMs);
    lastSteamBroadcastRequestAt = Date.now();
    return task();
  });
  steamBroadcastQueue = run.catch(() => {});
  return run;
}

export async function fetchSteamBroadcastRestriction(steamId) {
  if (!isSteamId64(steamId)) return null;
  const scope = steamProviderScope('broadcast', steamId);
  return queueSteamBroadcastRequest(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STEAM_BROADCAST_TIMEOUT_MS);
    try {
      assertExternalProviderAvailable('steam_broadcast', scope);
      const response = await fetch(`https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${encodeURIComponent(steamId)}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        recordExternalProviderFailure('steam_broadcast', steamHttpError('Steam broadcast', response.status), scope);
        return {
          ...parseSteamBroadcastPayload(steamId, {}),
          error: `Steam broadcast HTTP ${response.status}`
        };
      }
      const payload = parseSteamBroadcastPayload(steamId, await response.json());
      recordExternalProviderSuccess('steam_broadcast', scope);
      return payload;
    } catch (error) {
      if (!error?.circuitOpen) {
        recordExternalProviderFailure(
          'steam_broadcast',
          error?.name === 'AbortError' ? steamAbortError('Steam broadcast') : error,
          scope
        );
      }
      return {
        ...parseSteamBroadcastPayload(steamId, {}),
        error: error?.name === 'AbortError' ? 'Steam broadcast timeout' : String(error?.message || 'Steam broadcast unavailable').slice(0, 240)
      };
    } finally {
      clearTimeout(timeout);
    }
  });
}

async function fetchSteamPlayerBansBatch(steamIds, apiKey) {
  const url = new URL('/ISteamUser/GetPlayerBans/v1/', STEAM_WEB_API_BASE_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('steamids', steamIds.join(','));
  const scope = steamProviderScope('player_bans', steamIds.length > 1 ? `batch:${steamIds.length}` : steamIds[0]);
  assertExternalProviderAvailable('steam_web_api', scope);
  return queueSteamWebApiRequest(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STEAM_WEB_API_TIMEOUT_MS);
    try {
      assertExternalProviderAvailable('steam_web_api', scope);
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' }
      });
      if (!response.ok) {
        throw steamHttpError('Steam Web API', response.status);
      }
      const bans = parseSteamPlayerBansPayload(await response.json());
      recordExternalProviderSuccess('steam_web_api', scope);
      return bans;
    } catch (error) {
      const normalizedError = error?.name === 'AbortError' ? steamAbortError('Steam Web API') : error;
      if (!normalizedError?.circuitOpen) recordExternalProviderFailure('steam_web_api', normalizedError, scope);
      throw normalizedError;
    } finally {
      clearTimeout(timeout);
    }
  });
}

export async function fetchSteamPlayerBans(steamIds, options = {}) {
  const ids = uniqueSteamIds(steamIds);
  if (!ids.length) return { bansBySteamId: new Map(), error: '', skipped: true };
  const apiKey = String(options.apiKey || steamWebApiKey()).trim();
  if (!apiKey) {
    return { bansBySteamId: new Map(), error: 'Steam Web API key not configured', skipped: true };
  }
  const bansBySteamId = new Map();
  for (let index = 0; index < ids.length; index += STEAM_PLAYER_BANS_BATCH_SIZE) {
    const batch = ids.slice(index, index + STEAM_PLAYER_BANS_BATCH_SIZE);
    const batchResult = await fetchSteamPlayerBansBatch(batch, apiKey);
    for (const [steamId, record] of batchResult.entries()) bansBySteamId.set(steamId, record);
  }
  return { bansBySteamId, error: '', skipped: false };
}

export async function resolveSteamInput(input) {
  const parsed = parseSteamInput(input);
  if (parsed.ok) return parsed;

  if (parsed.kind !== 'vanity_url' || !parsed.vanity) return parsed;

  const xml = await fetchProfileXml(`https://steamcommunity.com/id/${encodeURIComponent(parsed.vanity)}?xml=1`);
  const steamId = xml ? readXmlTag(xml, 'steamID64') : '';
  if (!steamId || !isSteamId64(steamId)) {
    return {
      ok: false,
      rawInput: parsed.rawInput,
      kind: 'vanity_url',
      message: '无法在线解析这个自定义 Steam 资料页，请改用 SteamID64'
    };
  }

  return {
    ok: true,
    rawInput: parsed.rawInput,
    steamId,
    kind: 'vanity_url'
  };
}

export async function fetchSteamProfile(steamId) {
  if (!isSteamId64(steamId)) return null;
  const xml = await fetchProfileXml(`https://steamcommunity.com/profiles/${steamId}?xml=1`);
  if (!xml) return null;

  const steamID64 = readXmlTag(xml, 'steamID64') || String(steamId);
  const privacyState = readXmlTag(xml, 'privacyState');
  const visibilityState = readXmlTag(xml, 'visibilityState');
  const profilePublic = privacyState
    ? privacyState.toLowerCase() !== 'private'
    : (visibilityState ? visibilityState !== '1' : null);
  return {
    steamId: steamID64,
    nickname: readXmlTag(xml, 'steamID'),
    avatar: readXmlTag(xml, 'avatarFull') || readXmlTag(xml, 'avatarMedium'),
    profileUrl: `https://steamcommunity.com/profiles/${steamID64}`,
    privacyState,
    visibilityState,
    profilePublic
  };
}

export function memberDisplayName(member) {
  return member.customName || member.steamNickname || `Steam ${String(member.steamId).slice(-6)}`;
}
