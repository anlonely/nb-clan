import crypto from 'node:crypto';
import { discordTimestamp } from './v2/notification-platforms/discord-time.js';
import { decodeRealtimeName } from './v2/realtime/names.js';
import { fetchSteamProfile } from './steam.js';
import { createId, hashPassword, normalizeText, nowIso, patchStoreCache, readStore, runStoreWriteTask, updateStore, verifyPassword } from './store.js';
import {
  countSqliteRecordsByJsonField,
  getSqliteCollection,
  getSqliteRecordCounts,
  getSqliteRecordsByIds,
  getSqliteRecordsByJsonField,
  getSqliteRecordsByJsonFields,
  getSqliteScalar,
  writeSqliteStorePatch
} from './storage/repository.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';

export const RUSTPLUS_RELAY_ENDPOINT = '/api/integrations/rustplus/relay';
export const RUSTPLUS_RELAY_STREAM_ENDPOINT = '/api/integrations/rustplus/stream';
export const RUSTPLUS_RELAY_STATE_ENDPOINT = '/api/rustplus-relay';
export const RUSTPLUS_RELAY_SSE_ENDPOINT = '/api/rustplus-relay/events';
export const RUSTPLUS_RELAY_DISCORD_ENDPOINT = '/api/rustplus-relay/discord';
export const RUSTPLUS_RELAY_TOKEN_MIN_LENGTH = 16;
export const RUSTPLUS_RELAY_TOKEN_MAX_LENGTH = 256;

const RUSTPLUS_RELAY_DEFAULT_CHAT_STORAGE_BYTES_LIMIT = 5 * 1024 * 1024 * 1024;
const RUSTPLUS_RELAY_MAX_CHAT_STORAGE_BYTES_LIMIT = 20 * 1024 * 1024 * 1024;
export const RUSTPLUS_RELAY_CHAT_STORAGE_BYTES_LIMIT = Math.max(
  1024 * 1024,
  normalizePositiveInteger(
    process.env.NB_RUSTPLUS_RELAY_CHAT_STORAGE_BYTES_LIMIT,
    RUSTPLUS_RELAY_DEFAULT_CHAT_STORAGE_BYTES_LIMIT,
    RUSTPLUS_RELAY_MAX_CHAT_STORAGE_BYTES_LIMIT
  )
);
const RUSTPLUS_RELAY_CHAT_COUNT_LIMIT = Math.max(0, Number(process.env.NB_RUSTPLUS_RELAY_CHAT_LIMIT || 0) || 0);
const RUSTPLUS_RELAY_SNAPSHOT_MEMBER_LIMIT = 500;
const RUSTPLUS_RELAY_SNAPSHOT_INVITE_LIMIT = 250;
const RUSTPLUS_RELAY_STEAM_PROFILE_CACHE_LIMIT = 1000;
const RUSTPLUS_RELAY_STEAM_PROFILE_BACKFILL_BATCH_LIMIT = 80;
const RUSTPLUS_RELAY_STEAM_PROFILE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RUSTPLUS_RELAY_STEAM_PROFILE_RETRY_MS = 6 * 60 * 60 * 1000;
const RUSTPLUS_RELAY_INVITE_RECORD_LIMIT = 5000;
const RUSTPLUS_RELAY_PUBLIC_CHAT_INITIAL_LIMIT = 200;
const RUSTPLUS_RELAY_PUBLIC_CHAT_MAX_LIMIT = 500;
const RUSTPLUS_RELAY_DISCORD_CHAT_LIMIT = 10;
const RUSTPLUS_RELAY_DISCORD_CHAT_SEPARATOR = '--------------------';
const RUSTPLUS_RELAY_REASONABLE_TIME_MIN_MS = Date.UTC(2020, 0, 1);
const RUSTPLUS_RELAY_REASONABLE_TIME_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;
const RUSTPLUS_RELAY_SNAPSHOT_WRITE_MIN_INTERVAL_MS = Math.max(1000, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_SNAPSHOT_WRITE_MIN_INTERVAL_MS,
  30_000,
  60_000
));
const RUSTPLUS_RELAY_INVITE_RECORD_WRITE_DEDUPE_MS = Math.max(1000, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_INVITE_RECORD_WRITE_DEDUPE_MS,
  60_000,
  10 * 60_000
));
const RUSTPLUS_RELAY_CHAT_MESSAGE_WRITE_DEDUPE_MS = Math.max(1000, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_CHAT_MESSAGE_WRITE_DEDUPE_MS,
  60_000,
  10 * 60_000
));
const RUSTPLUS_RELAY_MEMBER_DELTA_WRITE_DEDUPE_MS = Math.max(1000, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_MEMBER_DELTA_WRITE_DEDUPE_MS,
  30_000,
  5 * 60_000
));
const RUSTPLUS_RELAY_MEMBER_ONLINE_TIME_BUCKET_MINUTES = Math.max(1, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_MEMBER_ONLINE_TIME_BUCKET_MINUTES,
  15,
  120
));
const RUSTPLUS_RELAY_MEMBER_ONLINE_STALE_MS = Math.max(60_000, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_MEMBER_ONLINE_STALE_MS,
  30 * 60_000,
  7 * 24 * 60 * 60 * 1000
));
const RUSTPLUS_RELAY_WRITE_DEDUPE_CACHE_LIMIT = Math.max(1000, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_WRITE_DEDUPE_CACHE_LIMIT,
  20_000,
  100_000
));
const RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
  5000,
  30_000
);
export const RUSTPLUS_RELAY_MAX_PAYLOAD_BYTES = Math.max(16 * 1024, normalizePositiveInteger(
  process.env.NB_RUSTPLUS_RELAY_MAX_PAYLOAD_BYTES,
  256 * 1024,
  1024 * 1024
));
const RUSTPLUS_RELAY_COLLECTIONS = {
  clients: 'rustplusRelayClients',
  servers: 'rustplusRelayServers',
  chatMessages: 'rustplusRelayChatMessages',
  inviteRecords: 'rustplusRelayInviteRecords',
  steamProfiles: 'rustplusRelaySteamProfiles'
};
const RUSTPLUS_RELAY_COLLECTIONS_READY_KEY = 'rustplusRelayCollectionsReady';
const RUSTPLUS_RELAY_COLLECTIONS_READY = Symbol('rustplusRelayCollectionsReady');
const RUSTPLUS_RELAY_COLLECTION_PAGE_INFO = Symbol('rustplusRelayCollectionPageInfo');

const relaySubscribers = new Set();
const relayWriteDedupe = new Map();
let lastRustplusRelayPublicState = null;
let relayWriteDedupeSeedPromise = null;
const pendingRelayChatMessages = new Map();
const pendingRelayChatFlushWaiters = new Map();
let pendingRelayChatLatestReceivedAt = '';
let pendingRelayChatFlushTimer = null;
let pendingRelayChatFlushPromise = null;
const pendingRelaySteamProfileBackfills = new Set();

function rustplusRelayReadUnavailableError(label, cause) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'rustplus_relay_read_unavailable',
    skipApiErrorLog: true,
    cause
  });
}

/**
 * @typedef {Object} RustplusRelayClient
 * @property {string} id Stable rust-go client identifier.
 * @property {string} name Human-readable client or clan name.
 */

/**
 * @typedef {Object} RustplusRelayServer
 * @property {string} id Server identifier reported by the client.
 * @property {string} key Compound client/server key used by this store.
 * @property {string} name Human-readable server name.
 */

/**
 * @typedef {Object} RustplusRelayMember
 * @property {string} steamId SteamID64 when available.
 * @property {string} displayName Player display name.
 * @property {boolean} online Current online state reported by rust-go.
 * @property {string} role Optional clan role.
 * @property {string} joinedAt Optional clan join timestamp.
 * @property {string} lastSeenAt Optional last seen timestamp.
 */

/**
 * @typedef {Object} RustplusRelayInvite
 * @property {string} steamId SteamID64 when available.
 * @property {string} displayName Invitee display name.
 * @property {string} invitedBy Inviter display name or SteamID.
 * @property {string} status Invite status.
 * @property {string} sentAt Invite timestamp.
 */

/**
 * @typedef {Object} RustplusRelaySnapshot
 * @property {'clan_snapshot'} type Relay event type.
 * @property {RustplusRelayClient} client Source rust-go client.
 * @property {RustplusRelayServer} server Source Rust server.
 * @property {string} capturedAt Client capture time or receive time.
 * @property {RustplusRelayMember[]} members Clan members from the snapshot.
 * @property {RustplusRelayInvite[]} invites Pending invitations from the snapshot.
 * @property {{memberCount:number,onlineCount:number,offlineCount:number,inviteCount:number}} summary Snapshot counts.
 */

/**
 * @typedef {Object} RustplusRelayChatMessage
 * @property {'clan_chat_message'} type Relay event type.
 * @property {string} id Stable dedupe identifier.
 * @property {RustplusRelayClient} client Source rust-go client.
 * @property {RustplusRelayServer} server Source Rust server.
 * @property {string} steamId Sender SteamID64 when available.
 * @property {string} displayName Sender display name.
 * @property {string} message Original chat text.
 * @property {string} translatedMessage Translated chat text. Discord pushes prefer this.
 * @property {string} channel Chat channel.
 * @property {string} sentAt Client message timestamp.
 * @property {string} receivedAt Server receive timestamp.
 */

/**
 * @typedef {Object} RustplusRelayInviteRecord
 * @property {'clan_invite_record'} type Relay event type.
 * @property {string} id Stable dedupe identifier.
 * @property {RustplusRelayClient} client Source rust-go client.
 * @property {RustplusRelayServer} server Source Rust server.
 * @property {string} steamId Invitee SteamID64 when available.
 * @property {string} displayName Invitee display name.
 * @property {string} inviterSteamId Inviter SteamID64 when available.
 * @property {string} inviterName Inviter display name.
 * @property {string} status Invite status.
 * @property {string} sentAt Invite timestamp.
 * @property {string} acceptedAt Accepted timestamp.
 * @property {string} receivedAt Server receive timestamp.
 */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstObject(...values) {
  return values.map(asObject).find((value) => Object.keys(value).length) || {};
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function normalizeIdentifier(value, maxLength = 120) {
  return normalizeText(value, maxLength).replace(/\s+/g, '_');
}

function normalizeRelayText(value, maxLength = 500) {
  return normalizeText(value, maxLength);
}

function normalizeRelayName(value, maxLength = 120) {
  return decodeRealtimeName(normalizeRelayText(value, maxLength));
}

function normalizeRelayScalarText(value, maxLength = 500) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  const text = normalizeRelayText(value, maxLength);
  return text === '[object Object]' ? '' : text;
}

function relayObjectPlaceholder(value) {
  const text = String(value || '').trim();
  return text === '[object Object]' || text === '[object_Object]';
}

function relayLongLikeText(value, maxLength = 120) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return normalizeRelayScalarText(value, maxLength);
  if (Array.isArray(value)) return '';

  try {
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
      const text = normalizeRelayScalarText(value.toString(), maxLength);
      if (text && !relayObjectPlaceholder(text)) return text;
    }
  } catch {}

  const low = Number(value.low);
  const high = Number(value.high);
  if (Number.isFinite(low) && Number.isFinite(high)) {
    try {
      const lo = BigInt(low >>> 0);
      const hi = BigInt(high >>> 0);
      const unsigned = value.unsigned !== false;
      const combined = (hi << 32n) | lo;
      const text = String(unsigned ? combined : BigInt.asIntN(64, combined));
      return normalizeRelayScalarText(text, maxLength);
    } catch {}
  }
  return '';
}

function firstRelayScalarText(values = [], maxLength = 120) {
  for (const value of values) {
    const text = relayLongLikeText(value, maxLength);
    if (text && !relayObjectPlaceholder(text)) return text;
  }
  return '';
}

function firstRelayIdentifier(values = [], maxLength = 120) {
  return normalizeIdentifier(firstRelayScalarText(values, maxLength), maxLength);
}

function normalizePositiveInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, max);
}

function formatStorageLimitLabel(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
  return `${formatted} ${units[unitIndex]}`;
}

function estimateJsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value || null), 'utf8');
}

function normalizeOptionalMinutes(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.round(number);
  }
  return null;
}

function splitRelayTextList(...values) {
  return values
    .flatMap((value) => Array.isArray(value) ? value : String(value || '').split(/[,\n/]+/))
    .map((value) => normalizeRelayText(value, 140))
    .filter(Boolean);
}

function uniqueRelayTexts(values = []) {
  return [...new Set(values.map((value) => normalizeRelayText(value, 140)).filter(Boolean))];
}

function latestIsoTimestamp(...values) {
  let latest = '';
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const normalized = normalizeIsoTimestamp(value || '');
    const time = Date.parse(normalized || '');
    if (Number.isFinite(time) && time > latestTime) {
      latest = normalized;
      latestTime = time;
    }
  }
  return latest;
}

function normalizeIsoTimestamp(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') {
    const text = relayLongLikeText(value, 80);
    return text ? normalizeIsoTimestamp(text, fallback) : fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
  }
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(raw)) {
    return normalizeIsoTimestamp(numeric, fallback);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function relayTimestampIsReasonable(value, nowMs = Date.now()) {
  const time = Date.parse(value || '');
  return Number.isFinite(time)
    && time >= RUSTPLUS_RELAY_REASONABLE_TIME_MIN_MS
    && time <= nowMs + RUSTPLUS_RELAY_REASONABLE_TIME_FUTURE_MS;
}

function normalizeReasonableIsoTimestamp(value, fallback = '') {
  const normalized = normalizeIsoTimestamp(value, '');
  return relayTimestampIsReasonable(normalized) ? normalized : fallback;
}

function firstReasonableIsoTimestamp(values = [], fallback = '') {
  for (const value of values) {
    const normalized = normalizeReasonableIsoTimestamp(value, '');
    if (normalized) return normalized;
  }
  return fallback;
}

function eventTypeForPayload(input = {}) {
  const payload = asObject(input.payload || input.data);
  const rawType = normalizeText(
    input.type ||
      input.event ||
      input.kind ||
      input.eventType ||
      input.messageType ||
      payload.type ||
      payload.event ||
      payload.kind ||
      payload.eventType,
    80
  ).toLowerCase();
  const type = ['relay_event', 'relayevent'].includes(rawType)
    ? normalizeText(payload.type || payload.event || payload.kind || payload.eventType, 80).toLowerCase()
    : rawType;
  if (['clan_snapshot', 'clan_info', 'clanchanged', 'snapshot', 'clan'].includes(type)) return 'clan_snapshot';
  if (['clan_chat_message', 'clan_chat', 'clanmessage', 'chat_message', 'chat', 'message'].includes(type)) return 'clan_chat_message';
  if (['clan_invite_record', 'clan_invite', 'claninviterecord', 'invite_record', 'invite'].includes(type)) return 'clan_invite_record';
  if (['member_online', 'memberonline', 'player_online', 'playeronline', 'online'].includes(type)) return 'member_online';
  if (['member_offline', 'memberoffline', 'player_offline', 'playeroffline', 'offline'].includes(type)) return 'member_offline';
  if (['member_joined', 'member_join', 'memberjoined', 'memberjoin', 'player_joined', 'playerjoined', 'joined', 'join'].includes(type)) return 'member_joined';
  if (['member_left', 'member_leave', 'memberleft', 'memberleave', 'player_left', 'playerleft', 'left', 'leave'].includes(type)) return 'member_left';
  return '';
}

function payloadBody(input = {}) {
  return asObject(input.payload || input.data || input);
}

function normalizeRelayClient(input = {}, source = {}) {
  const client = firstObject(input.client, source.client, input.rustplusClient, source.rustplusClient, input.source, source.source);
  const rawId = firstRelayIdentifier([
    input.clientId,
    input.client_id,
    source.clientId,
    source.client_id,
    client.clientId,
    client.id,
    client.name,
    input.clientName,
    input.client_name,
    source.clientName,
    source.client_name,
    source.clanId,
    source.teamId
  ], 80);
  const fallbackId = firstRelayIdentifier([
    input.clientName,
    input.client_name,
    source.clientName,
    source.client_name,
    client.name,
    source.clanName,
    source.teamName
  ], 80);
  const id = rawId && !relayObjectPlaceholder(rawId)
    ? rawId
    : ((fallbackId && !relayObjectPlaceholder(fallbackId)) ? fallbackId : 'default');
  const name = firstRelayScalarText([
    input.clientName,
    input.client_name,
    source.clientName,
    source.client_name,
    client.name,
    source.clanName,
    source.teamName,
    id
  ], 100) || id;
  return { id, name };
}

function normalizeRelayServer(input = {}, source = {}, client = { id: 'default' }) {
  const server = firstObject(input.server, source.server, input.rustServer, source.rustServer);
  const name = firstRelayScalarText([
    input.serverName,
    input.server_name,
    source.serverName,
    source.server_name,
    server.name,
    server.serverName
  ], 140);
  const id = firstRelayIdentifier([
    input.serverId,
    input.server_id,
    source.serverId,
    source.server_id,
    server.serverId,
    server.id,
    server.battlemetricsId,
    name
  ], 120) || 'default';
  const key = `${client.id}:${id}`;
  return {
    id,
    key,
    name: name || id
  };
}

function steamIdFromValue(value) {
  const raw = relayLongLikeText(value, 80);
  return /^\d{17}$/.test(raw) ? raw : '';
}

function isSteamIdText(value) {
  return Boolean(steamIdFromValue(value));
}

function relaySteamProfileUrl(steamId = '') {
  const normalizedSteamId = steamIdFromValue(steamId);
  return normalizedSteamId ? `https://steamcommunity.com/profiles/${normalizedSteamId}` : '';
}

function normalizeRelaySteamProfileRecord(record = {}) {
  const steamId = steamIdFromValue(record.steamId || record.steamID64 || record.steamid || '');
  if (!steamId) return null;
  return {
    steamId,
    steamNickname: normalizeRelayName(record.steamNickname || record.nickname || record.displayName || record.name || '', 120),
    avatar: normalizeRelayText(record.avatar || record.avatarFull || record.avatarMedium || '', 500),
    profileUrl: normalizeRelayText(record.profileUrl || '', 500) || relaySteamProfileUrl(steamId),
    fetchedAt: normalizeIsoTimestamp(record.fetchedAt || record.updatedAt || record.createdAt || ''),
    failedAt: normalizeIsoTimestamp(record.failedAt || ''),
    lastError: normalizeRelayText(record.lastError || '', 240)
  };
}

function compactRelaySteamProfiles(records = []) {
  const profilesBySteamId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const profile = normalizeRelaySteamProfileRecord(record);
    if (!profile) continue;
    const previous = profilesBySteamId.get(profile.steamId);
    const profileTime = Date.parse(profile.fetchedAt || profile.failedAt || '') || 0;
    const previousTime = Date.parse(previous?.fetchedAt || previous?.failedAt || '') || 0;
    if (!previous || profileTime >= previousTime) profilesBySteamId.set(profile.steamId, profile);
  }
  return [...profilesBySteamId.values()]
    .sort((left, right) => (
      (Date.parse(right.fetchedAt || right.failedAt || '') || 0) -
      (Date.parse(left.fetchedAt || left.failedAt || '') || 0)
    ))
    .slice(0, RUSTPLUS_RELAY_STEAM_PROFILE_CACHE_LIMIT);
}

function relaySteamProfileNeedsRefresh(profile = {}, nowMs = Date.now()) {
  const fetchedAt = Date.parse(profile.fetchedAt || '');
  if (Number.isFinite(fetchedAt) && fetchedAt > 0) {
    return nowMs - fetchedAt > RUSTPLUS_RELAY_STEAM_PROFILE_REFRESH_MS;
  }
  const failedAt = Date.parse(profile.failedAt || '');
  if (Number.isFinite(failedAt) && failedAt > 0) {
    return nowMs - failedAt > RUSTPLUS_RELAY_STEAM_PROFILE_RETRY_MS;
  }
  return true;
}

function nonSteamRelayScalarText(value, maxLength = 120) {
  const text = normalizeRelayScalarText(value, maxLength);
  return text && !isSteamIdText(text) ? text : '';
}

function steamIdFromRecord(record = {}) {
  return steamIdFromValue(
    record.steamId ||
      record.steam_id ||
      record.steamID ||
      record.playerSteamId ||
      record.player_steam_id ||
      record.userId ||
      record.playerId ||
      record.id
  );
}

function normalizedSteamIdSet(values = []) {
  return new Set(values.map((item) => steamIdFromRecord(asObject(item)) || steamIdFromValue(item)).filter(Boolean));
}

function normalizeRelayMember(record = {}, context = {}) {
  const member = asObject(record);
  const steamId = steamIdFromRecord(member);
  const status = normalizeRelayText(member.status || member.state || '', 40).toLowerCase();
  const online = context.offlineSteamIds?.has(steamId)
    ? false
    : Boolean(
      member.online ||
      member.isOnline ||
      member.connected ||
      status === 'online' ||
      context.onlineSteamIds?.has(steamId)
    );
  const lastSeenAt = normalizeIsoTimestamp(member.lastSeenAt || member.last_seen_at || member.lastSeen || '');
  const lastOfflineAt = normalizeIsoTimestamp(
    member.lastOfflineAt ||
      member.last_offline_at ||
      member.offlineAt ||
      member.offline_at ||
      member.disconnectedAt ||
      member.disconnected_at ||
      ''
  );
  const explicitLastOnlineAt = normalizeIsoTimestamp(
    member.lastOnlineAt ||
      member.last_online_at ||
      member.onlineSince ||
      member.online_since ||
      member.onlineAt ||
      member.online_at ||
      member.connectedAt ||
      member.connected_at ||
      ''
  );
  const lastOnlineAt = explicitLastOnlineAt || (online ? lastSeenAt : '');
  return {
    steamId,
    displayName: normalizeRelayName(
      member.displayName ||
        member.name ||
        member.username ||
        member.steamName ||
        member.steamNickname ||
        member.nickname ||
        steamId,
      120
    ) || steamId,
    online,
    role: normalizeRelayText(member.role || member.rank || '', 80),
    squadId: normalizeRelayText(member.squadId || member.squad_id || member.squad?.id || '', 80),
    squadName: normalizeRelayText(member.squadName || member.squad_name || member.squad?.name || member.squad || '', 120),
    gameClanName: normalizeRelayText(
      member.gameClanName ||
        member.game_clan_name ||
        member.clanName ||
        member.clan_name ||
        member.teamName ||
        member.team_name ||
        context.clanName ||
        '',
      140
    ),
    avatar: normalizeRelayText(member.avatar || member.avatarUrl || member.avatar_url || member.steamAvatar || member.steam_avatar || '', 500),
    profileUrl: normalizeRelayText(member.profileUrl || member.profile_url || member.steamProfileUrl || member.steam_profile_url || '', 500),
    joinedAt: normalizeIsoTimestamp(member.joinedAt || member.joined_at || ''),
    lastSeenAt,
    lastOnlineAt,
    lastOnlineAtSource: explicitLastOnlineAt ? 'explicit' : (online && lastSeenAt ? 'lastSeen' : ''),
    lastOfflineAt,
    onlineTimeMinutes: normalizeOptionalMinutes(
      member.onlineTimeMinutes,
      member.online_time_minutes,
      member.totalOnlineMinutes,
      member.total_online_minutes,
      member.playTimeMinutes,
      member.play_time_minutes,
      Number.isFinite(Number(member.onlineTimeSeconds)) ? Number(member.onlineTimeSeconds) / 60 : '',
      Number.isFinite(Number(member.online_time_seconds)) ? Number(member.online_time_seconds) / 60 : '',
      Number.isFinite(Number(member.totalOnlineSeconds)) ? Number(member.totalOnlineSeconds) / 60 : '',
      Number.isFinite(Number(member.total_online_seconds)) ? Number(member.total_online_seconds) / 60 : ''
    )
  };
}

function normalizeRelayInvite(record = {}) {
  const invite = asObject(record);
  const invitee = firstObject(invite.invitee, invite.target, invite.player, invite.user);
  const inviter = firstObject(invite.inviter, invite.recruiter, invite.invitedBy);
  const steamId = steamIdFromValue(
    invite.inviteeSteamId ||
      invite.invitee_steam_id ||
      invite.targetSteamId ||
      invite.target_steam_id ||
      invite.steamId ||
      invite.steam_id ||
      invite.steamID ||
      invitee.steamId ||
      invitee.steam_id ||
      invitee.steamID ||
      invitee.id ||
      invite.invitee
  ) || steamIdFromRecord(invite);
  const inviterSteamId = steamIdFromValue(
    invite.inviterSteamId ||
      invite.inviter_steam_id ||
      invite.recruiterSteamId ||
      invite.recruiter_steam_id ||
      invite.invitedBySteamId ||
      invite.invited_by_steam_id ||
      inviter.steamId ||
      inviter.steam_id ||
      inviter.steamID ||
      inviter.id ||
      invite.inviter ||
      invite.recruiter ||
      invite.invitedBy
  );
  const inviterName = normalizeRelayName(
    invite.inviterName ||
      invite.inviter_name ||
      invite.recruiterName ||
      invite.recruiter_name ||
      inviter.displayName ||
      inviter.name ||
      inviter.username ||
      nonSteamRelayScalarText(invite.inviter, 120) ||
      nonSteamRelayScalarText(invite.recruiter, 120) ||
      nonSteamRelayScalarText(invite.invitedBy, 120) ||
      '',
    120
  );
  const inviteeName = normalizeRelayName(
    invite.inviteeName ||
      invite.invitee_name ||
      invite.displayName ||
      invite.display_name ||
      invite.name ||
      invite.username ||
      invite.steamName ||
      invite.steamNickname ||
      invitee.displayName ||
      invitee.name ||
      invitee.username ||
      steamId,
    120
  ) || steamId;
  const status = normalizeRelayText(invite.status || invite.state || 'pending', 40).toLowerCase() || 'pending';
  const sentAt = firstReasonableIsoTimestamp([
    invite.invitedAtIso,
    invite.invited_at_iso,
    invite.inviteTime,
    invite.invite_time,
    invite.invitedAt,
    invite.invited_at,
    invite.sentAt,
    invite.sent_at,
    invite.createdAt,
    invite.created_at,
    invite.timestamp
  ]);
  const acceptedAt = firstReasonableIsoTimestamp([
    invite.acceptedAtIso,
    invite.accepted_at_iso,
    invite.acceptedAt,
    invite.accepted_at
  ]);
  const invitedBy = inviterName || inviterSteamId || nonSteamRelayScalarText(invite.invitedBy, 120) || '';
  return {
    steamId,
    inviteeSteamId: steamId,
    displayName: inviteeName,
    inviteeName,
    inviterSteamId,
    inviterName,
    invitedBy: normalizeRelayText(invitedBy, 120),
    status,
    statusLabel: normalizeRelayText(invite.statusLabel || invite.status_label || '', 80),
    sentAt,
    acceptedAt
  };
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function hashRelayId(...parts) {
  return crypto.createHash('sha1').update(parts.map((part) => String(part || '')).join('\u0000')).digest('hex');
}

function normalizeClanInfo(source = {}, body = {}, client = {}) {
  const id = firstRelayScalarText([
    source.clanId,
    source.clan_id,
    source.teamId,
    source.team_id,
    body.clanId,
    body.clan_id,
    client.id
  ], 80);
  const name = firstRelayScalarText([
    source.clanName,
    source.clan_name,
    source.teamName,
    source.team_name,
    source.name,
    body.clanName,
    body.clan_name,
    client.name
  ], 140);
  const memberLimit = normalizePositiveInteger(
    source.memberLimit ||
      source.member_limit ||
      source.maxMembers ||
      source.max_members ||
      source.capacity ||
      source.memberCap ||
      source.member_cap ||
      body.memberLimit ||
      body.member_limit,
    40,
    500
  ) || 40;
  const announcement = normalizeRelayText(
    source.announcement ||
      source.notice ||
      source.motd ||
      source.description ||
      source.messageOfTheDay ||
      source.message_of_the_day ||
      body.announcement ||
      body.notice,
    1000
  );
  return { id, name, memberLimit, announcement };
}

function normalizeSnapshotPayload(input, receivedAt) {
  const body = payloadBody(input);
  const source = firstObject(input.snapshot, body.snapshot, body.clanSnapshot, body.clan, body);
  const client = normalizeRelayClient(input, source);
  const server = normalizeRelayServer(input, source, client);
  const clan = normalizeClanInfo(source, body, client);
  const onlineSteamIds = normalizedSteamIdSet(firstArray(source.onlineSteamIds, source.onlinePlayers, source.online, body.onlinePlayers));
  const offlineSteamIds = normalizedSteamIdSet(firstArray(source.offlineSteamIds, source.offlinePlayers, source.offline, body.offlinePlayers));
  const members = uniqueBy(
    firstArray(source.members, source.clanMembers, source.players, source.teammates, source.teamMembers)
      .map((member) => normalizeRelayMember(member, { onlineSteamIds, offlineSteamIds, clanName: clan.name }))
      .filter((member) => member.steamId || member.displayName),
    (member) => member.steamId || member.displayName
  ).slice(0, RUSTPLUS_RELAY_SNAPSHOT_MEMBER_LIMIT);
  const invites = uniqueBy(
    firstArray(source.invites, source.invitations, source.pendingInvites, source.pending_invitations)
      .map(normalizeRelayInvite)
      .filter((invite) => invite.steamId || invite.displayName),
    (invite) => invite.steamId || invite.displayName
  ).slice(0, RUSTPLUS_RELAY_SNAPSHOT_INVITE_LIMIT);
  const onlineCount = members.filter((member) => member.online).length;
  return {
    type: 'clan_snapshot',
    client,
    server,
    capturedAt: normalizeIsoTimestamp(source.capturedAt || source.timestamp || source.createdAt || body.capturedAt || '', receivedAt),
    ...(source.expiresAt || body.expiresAt ? { expiresAt: normalizeIsoTimestamp(source.expiresAt || body.expiresAt) } : {}),
    clan,
    members,
    invites,
    summary: {
      memberCount: members.length,
      onlineCount,
      offlineCount: Math.max(0, members.length - onlineCount),
      inviteCount: invites.length
    }
  };
}

function normalizeChatPayload(input, receivedAt) {
  const body = payloadBody(input);
  const source = firstObject(input.message, body.message, body.chatMessage, body.chat, body);
  const client = normalizeRelayClient(input, source);
  const server = normalizeRelayServer(input, source, client);
  const sender = firstObject(source.sender, source.player, source.author, source.user);
  const steamId = steamIdFromRecord(source) || steamIdFromRecord(sender);
  const message = normalizeRelayText(
    source.message ||
      source.text ||
      source.body ||
      source.content ||
      source.originalMessage ||
      source.original_text,
    2000
  );
  const translatedMessage = normalizeRelayText(
    source.translatedMessage ||
      source.translated_message ||
      source.translatedText ||
      source.translated_text ||
      source.translation,
    2000
  );
  const sentAt = normalizeIsoTimestamp(source.sentAt || source.timestamp || source.createdAt || body.sentAt || '', receivedAt);
  const externalId = normalizeIdentifier(source.id || source.messageId || source.message_id || body.messageId || '', 120);
  const id = externalId
    ? `chat_${hashRelayId(client.id, server.id, externalId).slice(0, 32)}`
    : `chat_${hashRelayId(client.id, server.id, sentAt, steamId, message, translatedMessage).slice(0, 32)}`;
  return {
    type: 'clan_chat_message',
    id,
    client,
    server,
    steamId,
    displayName: normalizeRelayName(
      source.displayName ||
        source.senderName ||
        source.authorName ||
        source.name ||
        sender.displayName ||
        sender.name ||
        sender.username ||
        steamId,
      120
    ) || steamId,
    avatar: normalizeRelayText(source.avatar || source.avatarUrl || source.avatar_url || sender.avatar || sender.avatarUrl || '', 500),
    profileUrl: normalizeRelayText(source.profileUrl || source.profile_url || sender.profileUrl || sender.profile_url || '', 500),
    message: message || translatedMessage,
    translatedMessage,
    channel: normalizeRelayText(source.channel || source.channelName || 'clan', 80) || 'clan',
    sentAt,
    receivedAt
  };
}

function normalizeInviteRecordPayload(input, receivedAt) {
  const body = payloadBody(input);
  const source = firstObject(input.invite, input.inviteRecord, input.record, body.invite, body.inviteRecord, body.record, body);
  const client = normalizeRelayClient(input, source);
  const server = normalizeRelayServer(input, source, client);
  const invite = normalizeRelayInvite(source);
  const timeKey = invite.sentAt || invite.acceptedAt || receivedAt;
  const inviteeKey = invite.steamId || invite.displayName || '';
  const inviterKey = invite.inviterSteamId || invite.inviterName || invite.invitedBy || '';
  // Only the Web API adapter opts into upstream record identity. Legacy push
  // clients retain their existing invitation key and timestamp semantics.
  const webApi = Object.hasOwn(source, 'webApiInviteId');
  const firstSeenAt = webApi ? firstReasonableIsoTimestamp([source.firstSeenAt]) : '';
  if (webApi && (typeof source.webApiInviteId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(source.webApiInviteId) || !invite.sentAt && !firstSeenAt)) {
    throw Object.assign(new Error('Invalid Web API invite record'), { status: 400 });
  }
  return {
    type: 'clan_invite_record',
    id: `invite_${(webApi ? hashRelayId(client.id, server.id, 'web-api-invite', source.webApiInviteId) :
      hashRelayId(client.id, server.id, inviteeKey, inviterKey, timeKey)).slice(0, 32)}`,
    client,
    server,
    ...invite,
    ...(webApi ? { firstSeenAt,
      occurredAt: firstReasonableIsoTimestamp([source.occurredAt, source.updatedAt, source.lastObservedAt], invite.acceptedAt || invite.sentAt || firstSeenAt),
      resetCutoffAt: invite.sentAt || firstSeenAt } : {}),
    externalId: webApi ? source.webApiInviteId : normalizeIdentifier(source.id || source.inviteId || source.invite_id || body.inviteId || '', 120),
    receivedAt
  };
}

function normalizeMemberDeltaPayload(input, receivedAt, type) {
  const body = payloadBody(input);
  const source = firstObject(input.member, input.player, input.user, body.member, body.player, body.user, body);
  const client = normalizeRelayClient(input, source);
  const server = normalizeRelayServer(input, source, client);
  const occurredAt = normalizeIsoTimestamp(
    source.occurredAt ||
      source.occurred_at ||
      source.timestamp ||
      source.createdAt ||
      source.updatedAt ||
      body.occurredAt ||
      body.timestamp ||
      '',
    receivedAt
  );
  const member = normalizeRelayMember(source);
  if (type === 'member_online') {
    member.online = true;
    member.lastSeenAt = member.lastSeenAt || occurredAt;
    member.lastOnlineAt = member.lastOnlineAt || occurredAt;
    member.lastOfflineAt = member.lastOfflineAt || '';
  } else if (type === 'member_offline') {
    member.online = false;
    member.lastSeenAt = member.lastSeenAt || occurredAt;
    member.lastOfflineAt = member.lastOfflineAt || occurredAt;
  } else if (type === 'member_left') {
    member.online = false;
    member.lastSeenAt = member.lastSeenAt || occurredAt;
    member.lastOfflineAt = member.lastOfflineAt || occurredAt;
  }
  return {
    type,
    client,
    server,
    member,
    occurredAt,
    receivedAt
  };
}

/**
 * Normalize a rust-go relay payload into the store contract.
 *
 * @param {object} input Raw rust-go payload.
 * @param {{receivedAt?: string}} options Normalization options.
 * @returns {RustplusRelaySnapshot|RustplusRelayChatMessage|RustplusRelayInviteRecord}
 */
export function normalizeRustplusRelayPayload(input = {}, options = {}) {
  const receivedAt = normalizeIsoTimestamp(options.receivedAt || '', nowIso());
  const type = eventTypeForPayload(input);
  if (type === 'clan_snapshot') return normalizeSnapshotPayload(input, receivedAt);
  if (type === 'clan_chat_message') {
    const normalized = normalizeChatPayload(input, receivedAt);
    if (!normalized.message && !normalized.translatedMessage) {
      throw Object.assign(new Error('Relay chat message is empty'), { status: 400 });
    }
    return normalized;
  }
  if (type === 'clan_invite_record') {
    const normalized = normalizeInviteRecordPayload(input, receivedAt);
    if (!normalized.steamId && !normalized.displayName) {
      throw Object.assign(new Error('Relay invite record is empty'), { status: 400 });
    }
    return normalized;
  }
  if (['member_online', 'member_offline', 'member_joined', 'member_left'].includes(type)) {
    const normalized = normalizeMemberDeltaPayload(input, receivedAt, type);
    if (!normalized.member.steamId && !normalized.member.displayName) {
      throw Object.assign(new Error('Relay member event is empty'), { status: 400 });
    }
    return normalized;
  }
  throw Object.assign(new Error('Unsupported Rust+ relay payload type'), { status: 400 });
}

export function rustplusRelaySettings(store = {}) {
  store.settings ||= {};
  store.settings.rustplusRelay ||= {};
  const settings = store.settings.rustplusRelay;
  settings.tokenHash ||= '';
  settings.tokenUpdatedAt ||= '';
  settings.lastReceivedAt ||= '';
  settings.lastError ||= '';
  settings.lastDiscordPushAt ||= '';
  settings.lastDiscordPushError ||= '';
  settings.lastDiscordMessageId ||= '';
  settings.discordForwarding = normalizeRustplusRelayDiscordForwarding(settings.discordForwarding);
  return settings;
}

function normalizeRustplusRelayDiscordForwardRoute(input = {}, index = 0) {
  const route = asObject(input);
  const platform = normalizeRelayText(route.platform || route.forwardPlatform || route.forward_platform || '', 20).toLowerCase() === 'kook'
    ? 'kook'
    : 'discord';
  const clientId = normalizeIdentifier(route.clientId || route.client_id || '', 80);
  const serverKey = normalizeIdentifier(route.serverKey || route.server_key || '', 180);
  const serverId = normalizeIdentifier(route.serverId || route.server_id || '', 120);
  const targetId = normalizeRelayText(route.targetId || route.target_id || '', 80);
  const channelId = normalizeRelayText(route.channelId || route.channel_id || '', 32);
  const kookChannelId = normalizeRelayText(route.kookChannelId || route.kook_channel_id || '', 80);
  const kookTemplateId = normalizeRelayText(route.kookTemplateId || route.kook_template_id || route.templateId || route.template_id || '', 80);
  const kookAccessToken = normalizeRelayText(route.kookAccessToken || route.kook_access_token || route.accessToken || route.access_token || '', 4096);
  const id = normalizeIdentifier(
    route.id ||
      route.routeId ||
      route.route_id ||
      serverKey ||
      [platform, clientId, serverId, targetId, channelId || kookChannelId, index].filter(Boolean).join(':'),
    220
  ) || `route_${index + 1}`;
  return {
    id,
    platform,
    enabled: route.enabled !== false,
    clientId,
    serverKey,
    serverId,
    serverName: normalizeRelayText(route.serverName || route.server_name || '', 140),
    targetId,
    targetName: normalizeRelayText(route.targetName || route.target_name || '', 80),
    guildId: normalizeRelayText(route.guildId || route.guild_id || '', 32),
    channelId,
    kookChannelId,
    kookTemplateId,
    kookAccessToken,
    kookAccessTokenConfigured: Boolean(route.kookAccessTokenConfigured || route.kook_access_token_configured || kookAccessToken),
    clearKookAccessToken: Boolean(route.clearKookAccessToken || route.clear_kook_access_token),
    updatedAt: normalizeIsoTimestamp(route.updatedAt || route.updated_at || ''),
    lastForwardedAt: normalizeIsoTimestamp(route.lastForwardedAt || route.last_forwarded_at || ''),
    lastForwardError: normalizeRelayText(route.lastForwardError || route.last_forward_error || '', 240),
    lastForwardMessageId: normalizeRelayText(route.lastForwardMessageId || route.last_forward_message_id || '', 80)
  };
}

function legacyRustplusRelayDiscordForwardRoute(config = {}) {
  const route = normalizeRustplusRelayDiscordForwardRoute(config, 0);
  return route.serverKey || route.channelId || route.targetId || route.guildId || route.kookChannelId || route.kookTemplateId || route.kookAccessToken ? route : null;
}

export function normalizeRustplusRelayDiscordForwarding(input = {}) {
  const config = asObject(input);
  const rawRoutes = Array.isArray(config.routes) ? config.routes : [];
  const routes = rawRoutes
    .map((route, index) => normalizeRustplusRelayDiscordForwardRoute(route, index))
    .filter((route) => route.serverKey || route.channelId || route.targetId || route.guildId || route.kookChannelId || route.kookTemplateId || route.kookAccessToken);
  const legacyRoute = routes.length ? null : legacyRustplusRelayDiscordForwardRoute(config);
  const normalizedRoutes = routes.length ? routes : (legacyRoute ? [legacyRoute] : []);
  const primaryRoute = normalizedRoutes[0] || {};
  return {
    enabled: Boolean(config.enabled),
    routes: normalizedRoutes,
    clientId: primaryRoute.clientId || '',
    serverKey: primaryRoute.serverKey || '',
    serverId: primaryRoute.serverId || '',
    serverName: primaryRoute.serverName || '',
    targetId: primaryRoute.targetId || '',
    targetName: primaryRoute.targetName || '',
    guildId: primaryRoute.guildId || '',
    channelId: primaryRoute.channelId || '',
    updatedAt: normalizeIsoTimestamp(config.updatedAt || config.updated_at || ''),
    lastForwardedAt: normalizeIsoTimestamp(config.lastForwardedAt || config.last_forwarded_at || ''),
    lastForwardError: normalizeRelayText(config.lastForwardError || config.last_forward_error || '', 240),
    lastForwardMessageId: normalizeRelayText(config.lastForwardMessageId || config.last_forward_message_id || '', 80)
  };
}

function publicRustplusRelayDiscordForwardRoute(route = {}) {
  const hasKookAccessToken = Boolean(route.kookAccessToken);
  const { kookAccessToken, clearKookAccessToken, ...publicRoute } = route;
  return {
    ...publicRoute,
    kookAccessToken: '',
    kookAccessTokenConfigured: Boolean(route.kookAccessTokenConfigured || hasKookAccessToken),
    clearKookAccessToken: false
  };
}

function publicRustplusRelayDiscordForwarding(config = {}) {
  return {
    ...config,
    routes: Array.isArray(config.routes) ? config.routes.map(publicRustplusRelayDiscordForwardRoute) : [],
    ...(config.kookAccessToken ? { kookAccessToken: '', kookAccessTokenConfigured: true } : {})
  };
}

export function ensureRustplusRelayStore(store = {}) {
  store.rustplusRelay ||= {};
  const relay = store.rustplusRelay;
  relay.clients ||= [];
  relay.servers ||= [];
  relay.chatMessages ||= [];
  relay.inviteRecords ||= [];
  relay.steamProfiles ||= [];
  compactRustplusRelayStore(relay);
  return relay;
}

function rustplusRelayCollectionRecords(relay = {}) {
  return {
    [RUSTPLUS_RELAY_COLLECTIONS.clients]: Array.isArray(relay.clients) ? relay.clients : [],
    [RUSTPLUS_RELAY_COLLECTIONS.servers]: Array.isArray(relay.servers) ? relay.servers : [],
    [RUSTPLUS_RELAY_COLLECTIONS.chatMessages]: trimRelayChatMessages(Array.isArray(relay.chatMessages) ? relay.chatMessages : []),
    [RUSTPLUS_RELAY_COLLECTIONS.inviteRecords]: trimRelayInviteRecords(Array.isArray(relay.inviteRecords) ? relay.inviteRecords : []),
    [RUSTPLUS_RELAY_COLLECTIONS.steamProfiles]: compactRelaySteamProfiles(relay.steamProfiles)
  };
}

function rustplusRelayCollectionRecordId(collection, record = {}, index = 0) {
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.clients) return record.id || relayEffectiveClientId(record);
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.servers) return record.key || relayNormalizedServerKey(record);
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.chatMessages) return record.id || relayChatMessageDedupeKey(record);
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.inviteRecords) return record.id || relayInviteRecordDedupeKey(record);
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.steamProfiles) return record.steamId || steamIdFromValue(record.steam_id);
  return record.id || record.key || String(index);
}

function rustplusRelayCollectionsReady(value = null) {
  return Boolean(value === true || value?.ready);
}

function rustplusRelayFromSqliteCollections(baseRelay = {}, collections = {}, ready = false) {
  const relay = { ...(baseRelay || {}) };
  if (ready) {
    relay.clients = collections[RUSTPLUS_RELAY_COLLECTIONS.clients] || [];
    relay.servers = collections[RUSTPLUS_RELAY_COLLECTIONS.servers] || [];
    relay.chatMessages = trimRelayChatMessages(collections[RUSTPLUS_RELAY_COLLECTIONS.chatMessages] || []);
    relay.inviteRecords = trimRelayInviteRecords(collections[RUSTPLUS_RELAY_COLLECTIONS.inviteRecords] || []);
    relay.steamProfiles = compactRelaySteamProfiles(collections[RUSTPLUS_RELAY_COLLECTIONS.steamProfiles] || []);
  }
  return compactRustplusRelayStore(relay);
}

function rustplusRelayCollectionSignatures(relay = {}) {
  const signatures = {};
  for (const [collection, records] of Object.entries(rustplusRelayCollectionRecords(relay))) {
    signatures[collection] = new Map();
    records.forEach((record, index) => {
      const id = rustplusRelayCollectionRecordId(collection, record, index);
      if (!id) return;
      signatures[collection].set(String(id), JSON.stringify(record));
    });
  }
  return signatures;
}

function rustplusRelayPatchFromDiff(previousSignatures = {}, relay = {}) {
  const upserts = {};
  const deletes = {};
  for (const [collection, records] of Object.entries(rustplusRelayCollectionRecords(relay))) {
    const previous = previousSignatures[collection] || new Map();
    const seen = new Set();
    for (const [index, record] of records.entries()) {
      const id = rustplusRelayCollectionRecordId(collection, record, index);
      if (!id) continue;
      const key = String(id);
      seen.add(key);
      const signature = JSON.stringify(record);
      if (previous.get(key) !== signature) {
        upserts[collection] ||= [];
        upserts[collection].push({ ...record, id: key });
      }
    }
    for (const key of previous.keys()) {
      if (seen.has(key)) continue;
      deletes[collection] ||= [];
      deletes[collection].push(key);
    }
  }
  return { upserts, deletes };
}

function relaySteamIdsForScopedIdentity(relay = {}) {
  return uniqueRelayTexts([
    ...(relay.servers || []).flatMap((server) => (server.snapshot?.members || []).map((member) => member.steamId)),
    ...(relay.chatMessages || []).map((message) => message.steamId),
    ...(relay.inviteRecords || []).flatMap((record) => [
      record.steamId,
      record.inviteeSteamId,
      record.inviterSteamId
    ]),
    ...(relay.steamProfiles || []).map((profile) => profile.steamId)
  ].map(steamIdFromValue).filter(Boolean));
}

async function readRustplusRelayScopedIdentityStore(relay = {}) {
  const steamIds = relaySteamIdsForScopedIdentity(relay);
  const members = steamIds.length
    ? await getSqliteRecordsByJsonField('members', 'steamId', steamIds, { limit: 0 })
    : [];
  const memberIds = uniqueRelayTexts(members.map((member) => normalizeRelayText(member.id, 120)).filter(Boolean));
  const squadMembers = memberIds.length
    ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
    : [];
  const squadIds = uniqueRelayTexts(squadMembers.map((item) => normalizeRelayText(item.squadId, 120)).filter(Boolean));
  const squads = squadIds.length ? await getSqliteRecordsByIds('squads', squadIds, { limit: 0 }) : [];
  return { members, squads, squadMembers };
}

function normalizeRustplusRelayRuntimeCollectionScope(scope = null) {
  if (scope === false) return { disabled: true };
  if (!scope || typeof scope !== 'object') return { all: true };
  const hasLimit = Boolean(scope.hasLimit);
  const offset = hasLimit ? normalizePositiveInteger(scope.offset, 0, Number.MAX_SAFE_INTEGER) : 0;
  const limit = hasLimit ? normalizePositiveInteger(scope.limit, 0, 1000) : 0;
  return {
    all: !hasLimit,
    disabled: hasLimit && limit <= 0,
    clientId: normalizeIdentifier(scope.clientId || scope.client_id || '', 80),
    serverKey: normalizeIdentifier(scope.serverKey || scope.server_key || '', 180),
    offset,
    limit,
    readLimit: hasLimit && limit > 0 ? limit + 1 : 0
  };
}

function relayNonNegativeCountOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function relayCollectionCountValue(counts, key) {
  if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
    return relayNonNegativeCountOrNull(counts[key]);
  }
  return relayNonNegativeCountOrNull(counts);
}

async function readRustplusRelayCollectionForRuntime(collection, scope = null) {
  const normalized = normalizeRustplusRelayRuntimeCollectionScope(scope);
  if (normalized.disabled) return { records: [], pageInfo: normalized };
  const queryOptions = normalized.all
    ? { limit: 0 }
    : { limit: normalized.readLimit, offset: normalized.offset };
  const filters = {};
  if (normalized.clientId) filters.clientId = normalized.clientId;
  if (normalized.serverKey) filters.serverKey = normalized.serverKey;
  const records = Object.keys(filters).length
    ? await getSqliteRecordsByJsonFields(collection, filters, queryOptions)
    : await getSqliteCollection(collection, queryOptions);
  let total = null;
  if (!normalized.all) {
    if (normalized.serverKey) {
      total = relayCollectionCountValue(
        await countSqliteRecordsByJsonField(collection, 'serverKey', [normalized.serverKey]),
        normalized.serverKey
      );
    } else if (normalized.clientId) {
      total = relayCollectionCountValue(
        await countSqliteRecordsByJsonField(collection, 'clientId', [normalized.clientId]),
        normalized.clientId
      );
    } else {
      const counts = await getSqliteRecordCounts();
      total = relayCollectionCountValue(counts, collection);
    }
  }
  return {
    records,
    pageInfo: {
      ...normalized,
      total: relayNonNegativeCountOrNull(total)
    }
  };
}

function rustplusRelayRuntimeCollectionScopes(options = {}) {
  const collections = options.collections && typeof options.collections === 'object' ? options.collections : {};
  return {
    chatMessages: Object.hasOwn(collections, 'chatMessages') ? collections.chatMessages : null,
    inviteRecords: Object.hasOwn(collections, 'inviteRecords') ? collections.inviteRecords : null
  };
}

export async function readRustplusRelayRuntimeStore(options = {}) {
  if (!sqliteEnabled()) return readStore();
  try {
    const collectionScopes = rustplusRelayRuntimeCollectionScopes(options);
    const [
      rustplusRelay,
      settings,
      relayCollectionsReady,
      relayClients,
      relayServers,
      relayChatMessagesResult,
      relayInviteRecordsResult,
      relaySteamProfiles
    ] = await Promise.all([
      getSqliteScalar('rustplusRelay'),
      getSqliteScalar('settings'),
      getSqliteScalar(RUSTPLUS_RELAY_COLLECTIONS_READY_KEY),
      getSqliteCollection(RUSTPLUS_RELAY_COLLECTIONS.clients, { limit: 0 }),
      getSqliteCollection(RUSTPLUS_RELAY_COLLECTIONS.servers, { limit: 0 }),
      readRustplusRelayCollectionForRuntime(RUSTPLUS_RELAY_COLLECTIONS.chatMessages, collectionScopes.chatMessages),
      readRustplusRelayCollectionForRuntime(RUSTPLUS_RELAY_COLLECTIONS.inviteRecords, collectionScopes.inviteRecords),
      getSqliteCollection(RUSTPLUS_RELAY_COLLECTIONS.steamProfiles, { limit: 0 })
    ]);
    const relayCollections = {
      [RUSTPLUS_RELAY_COLLECTIONS.clients]: relayClients,
      [RUSTPLUS_RELAY_COLLECTIONS.servers]: relayServers,
      [RUSTPLUS_RELAY_COLLECTIONS.chatMessages]: relayChatMessagesResult.records,
      [RUSTPLUS_RELAY_COLLECTIONS.inviteRecords]: relayInviteRecordsResult.records,
      [RUSTPLUS_RELAY_COLLECTIONS.steamProfiles]: relaySteamProfiles
    };
    const collectionsReady = rustplusRelayCollectionsReady(relayCollectionsReady);
    if (!rustplusRelay && !settings && !collectionsReady) {
      const store = {
        rustplusRelay: rustplusRelayFromSqliteCollections({}, {}, false),
        settings: {},
        members: [],
        squads: [],
        squadMembers: [],
        permissionRoles: [],
        memberProfiles: [],
        wipes: [],
        wipeParticipants: []
      };
      Object.defineProperty(store, RUSTPLUS_RELAY_COLLECTIONS_READY, {
        value: false,
        enumerable: false
      });
      return store;
    }
    const relay = rustplusRelayFromSqliteCollections(rustplusRelay || {}, relayCollections, collectionsReady);
    const { members, squads, squadMembers } = await readRustplusRelayScopedIdentityStore(relay);
    const store = {
      rustplusRelay: relay,
      settings: settings || {},
      members,
      squads,
      squadMembers,
      permissionRoles: [],
      memberProfiles: [],
      wipes: [],
      wipeParticipants: []
    };
    Object.defineProperty(store, RUSTPLUS_RELAY_COLLECTIONS_READY, {
      value: collectionsReady,
      enumerable: false
    });
    Object.defineProperty(store, RUSTPLUS_RELAY_COLLECTION_PAGE_INFO, {
      value: {
        chatMessages: relayChatMessagesResult.pageInfo,
        inviteRecords: relayInviteRecordsResult.pageInfo
      },
      enumerable: false
    });
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite rustplus runtime store fallback:', error?.message || error);
    if (sqlitePrimaryMode()) throw rustplusRelayReadUnavailableError('Rust+运行数据读取', error);
    return readStore();
  }
}

function rustplusRelayCountValue(counts = {}, key, fallback) {
  const value = Number(counts?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function rustplusRelayCountsFromSqliteRecordCounts(recordCounts = {}) {
  return {
    clients: Number(recordCounts[RUSTPLUS_RELAY_COLLECTIONS.clients] || 0),
    servers: Number(recordCounts[RUSTPLUS_RELAY_COLLECTIONS.servers] || 0),
    chatMessages: Number(recordCounts[RUSTPLUS_RELAY_COLLECTIONS.chatMessages] || 0),
    inviteRecords: Number(recordCounts[RUSTPLUS_RELAY_COLLECTIONS.inviteRecords] || 0),
    steamProfiles: Number(recordCounts[RUSTPLUS_RELAY_COLLECTIONS.steamProfiles] || 0)
  };
}

export async function readRustplusRelaySettingsRuntimeStore(options = {}) {
  const includeCounts = options.includeCounts !== false;
  if (!sqliteEnabled()) return readStore();
  try {
    if (!includeCounts) {
      const settings = await getSqliteScalar('settings');
      return { settings: settings || {} };
    }
    const [
      settings,
      rustplusRelay,
      relayCollectionsReady,
      recordCounts
    ] = await Promise.all([
      getSqliteScalar('settings'),
      getSqliteScalar('rustplusRelay'),
      getSqliteScalar(RUSTPLUS_RELAY_COLLECTIONS_READY_KEY),
      getSqliteRecordCounts()
    ]);
    const collectionsReady = rustplusRelayCollectionsReady(relayCollectionsReady);
    const store = {
      settings: settings || {},
      rustplusRelay: rustplusRelay || {}
    };
    if (collectionsReady) {
      store.rustplusRelayCounts = rustplusRelayCountsFromSqliteRecordCounts(recordCounts || {});
    }
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite rustplus settings store fallback:', error?.message || error);
    if (sqlitePrimaryMode()) throw rustplusRelayReadUnavailableError('Rust+配置读取', error);
    return readStore();
  }
}

async function updateRustplusRelayRuntimeStore(mutator, reason = 'rustplus_relay_update') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const store = await readRustplusRelayRuntimeStore();
    const relay = ensureRustplusRelayStore(store);
    const collectionsReady = Boolean(store[RUSTPLUS_RELAY_COLLECTIONS_READY]);
    const previousRelaySignatures = collectionsReady ? rustplusRelayCollectionSignatures(relay) : {};
    const result = await mutator(store);
    compactRustplusRelayStore(store.rustplusRelay || {});
    const relayPatch = rustplusRelayPatchFromDiff(previousRelaySignatures, store.rustplusRelay || {});
    const updatedAt = nowIso();
    await writeSqliteStorePatch({
      reason,
      scalars: {
        settings: store.settings || {},
        [RUSTPLUS_RELAY_COLLECTIONS_READY_KEY]: { ready: true, updatedAt }
      },
      upserts: relayPatch.upserts,
      deletes: relayPatch.deletes
    });
    await patchStoreCache((cachedStore) => {
      cachedStore.rustplusRelay = store.rustplusRelay || {};
      cachedStore.settings = store.settings || {};
    });
    return result;
  });
}

async function updateRustplusRelaySettingsStore(mutator, reason = 'rustplus_relay_settings_update', options = {}) {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const store = await readRustplusRelaySettingsRuntimeStore({ includeCounts: options.includeCounts !== false });
    const result = await mutator(store);
    await writeSqliteStorePatch({
      reason,
      scalars: {
        settings: store.settings || {}
      }
    });
    await patchStoreCache((cachedStore) => {
      cachedStore.settings = store.settings || {};
    });
    return result;
  });
}

export function rustplusRelaySettingsPayload(store = {}) {
  const settings = rustplusRelaySettings(store);
  const relay = ensureRustplusRelayStore(store);
  const counts = store.rustplusRelayCounts || {};
  return {
    enabled: Boolean(settings.tokenHash),
    endpoint: RUSTPLUS_RELAY_ENDPOINT,
    streamEndpoint: RUSTPLUS_RELAY_STREAM_ENDPOINT,
    stateEndpoint: RUSTPLUS_RELAY_STATE_ENDPOINT,
    sseEndpoint: RUSTPLUS_RELAY_SSE_ENDPOINT,
    discordEndpoint: RUSTPLUS_RELAY_DISCORD_ENDPOINT,
    tokenUpdatedAt: settings.tokenUpdatedAt || '',
    lastReceivedAt: settings.lastReceivedAt || '',
    lastError: settings.lastError || '',
    lastDiscordPushAt: settings.lastDiscordPushAt || '',
    lastDiscordPushError: settings.lastDiscordPushError || '',
    lastDiscordMessageId: settings.lastDiscordMessageId || '',
    discordForwarding: publicRustplusRelayDiscordForwarding(settings.discordForwarding),
    clientCount: rustplusRelayCountValue(counts, 'clients', relay.clients.length),
    serverCount: rustplusRelayCountValue(counts, 'servers', relay.servers.length),
    chatCount: rustplusRelayCountValue(counts, 'chatMessages', relay.chatMessages.length),
    inviteRecordCount: rustplusRelayCountValue(counts, 'inviteRecords', relay.inviteRecords.length),
    steamProfileCount: rustplusRelayCountValue(counts, 'steamProfiles', relay.steamProfiles.length),
    chatLimit: RUSTPLUS_RELAY_CHAT_COUNT_LIMIT,
    chatStorageLimitBytes: RUSTPLUS_RELAY_CHAT_STORAGE_BYTES_LIMIT,
    chatStorageLimitLabel: formatStorageLimitLabel(RUSTPLUS_RELAY_CHAT_STORAGE_BYTES_LIMIT)
  };
}

export async function saveRustplusRelayToken(token) {
  const normalizedToken = String(token || '').trim();
  if (normalizedToken.length < RUSTPLUS_RELAY_TOKEN_MIN_LENGTH || normalizedToken.length > RUSTPLUS_RELAY_TOKEN_MAX_LENGTH) {
    throw Object.assign(new Error(`Token length must be between ${RUSTPLUS_RELAY_TOKEN_MIN_LENGTH}-${RUSTPLUS_RELAY_TOKEN_MAX_LENGTH} characters.`), { status: 400 });
  }
  const tokenHash = await hashPassword(normalizedToken);
  return updateRustplusRelaySettingsStore((store) => {
    const settings = rustplusRelaySettings(store);
    settings.tokenHash = tokenHash;
    settings.tokenUpdatedAt = nowIso();
    settings.lastError = '';
    return rustplusRelaySettingsPayload(store);
  }, 'rustplus_relay_token_save');
}

export async function saveRustplusRelayDiscordForwarding(input = {}) {
  const next = normalizeRustplusRelayDiscordForwarding({
    ...input,
    updatedAt: nowIso()
  });
  return updateRustplusRelaySettingsStore((store) => {
    const settings = rustplusRelaySettings(store);
    const previousRoutes = Array.isArray(settings.discordForwarding.routes) ? settings.discordForwarding.routes : [];
    const routes = next.routes.map((route) => {
      const previous = previousRoutes.find((item) => (
        item.id === route.id ||
          (route.serverKey && item.serverKey === route.serverKey) ||
          (route.platform === 'kook' && route.kookChannelId && item.kookChannelId === route.kookChannelId)
      ));
      const kookAccessToken = route.platform !== 'kook'
        ? ''
        : route.clearKookAccessToken
        ? ''
        : (route.kookAccessToken || (route.platform === 'kook' ? previous?.kookAccessToken || '' : ''));
      return {
        ...previous,
        ...route,
        kookAccessToken,
        kookAccessTokenConfigured: Boolean(kookAccessToken),
        clearKookAccessToken: false,
        updatedAt: next.updatedAt,
        lastForwardError: route.enabled ? previous?.lastForwardError || '' : ''
      };
    });
    settings.discordForwarding = {
      ...settings.discordForwarding,
      ...next,
      routes,
      lastForwardError: next.enabled ? settings.discordForwarding.lastForwardError || '' : ''
    };
    return rustplusRelaySettingsPayload(store);
  }, 'rustplus_relay_discord_forwarding_save');
}

export async function clearRustplusRelayToken() {
  return updateRustplusRelaySettingsStore((store) => {
    const settings = rustplusRelaySettings(store);
    settings.tokenHash = '';
    settings.tokenUpdatedAt = '';
    return rustplusRelaySettingsPayload(store);
  }, 'rustplus_relay_token_clear');
}

export function readRustplusRelayToken(req) {
  const authorization = String(req.headers.authorization || '').trim();
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer.trim();
  return String(req.headers['x-nb-relay-token'] || '').trim();
}

export async function validateRustplusRelayToken(req, store) {
  const settings = rustplusRelaySettings(store);
  return validateRustplusRelayTokenHash(req, settings.tokenHash);
}

export async function validateRustplusRelayTokenHash(req, tokenHash = '') {
  if (!tokenHash) {
    throw Object.assign(new Error('Rust+ relay token is not configured'), { status: 403 });
  }
  const token = readRustplusRelayToken(req);
  if (!token || !(await verifyPassword(token, tokenHash))) {
    throw Object.assign(new Error('Rust+ relay token is invalid'), { status: 401 });
  }
}

function upsertRelayClient(relay, client, receivedAt) {
  const existing = relay.clients.find((item) => item.id === client.id);
  if (existing) {
    existing.name = client.name || existing.name || client.id;
    existing.lastSeenAt = receivedAt;
    return existing;
  }
  const record = {
    id: client.id,
    name: client.name || client.id,
    createdAt: receivedAt,
    lastSeenAt: receivedAt
  };
  relay.clients.unshift(record);
  return record;
}

function upsertRelayServer(relay, server, client, receivedAt) {
  const existing = relay.servers.find((item) => item.key === server.key);
  if (existing) {
    existing.name = server.name || existing.name || server.id;
    existing.serverId = server.id;
    existing.clientId = client.id;
    existing.clientName = client.name;
    existing.lastSeenAt = receivedAt;
    return existing;
  }
  const record = {
    key: server.key,
    serverId: server.id,
    name: server.name || server.id,
    clientId: client.id,
    clientName: client.name,
    createdAt: receivedAt,
    lastSeenAt: receivedAt,
    lastSnapshotAt: '',
    snapshot: null
  };
  relay.servers.unshift(record);
  return record;
}

function relayNormalizedServerKey(record = {}) {
  const clientId = relayEffectiveClientId(record);
  const serverId = firstRelayIdentifier([
    record.server?.id,
    record.serverId,
    record.id && !String(record.id).includes(':') ? record.id : '',
    record.serverName,
    record.name
  ], 120) || 'default';
  return `${clientId}:${serverId}`;
}

function relayRecordSortTime(record = {}) {
  return Date.parse(
    record.lastSnapshotAt ||
      record.snapshot?.capturedAt ||
      record.lastSeenAt ||
      record.receivedAt ||
      record.updatedAt ||
      record.createdAt ||
      ''
  ) || 0;
}

function compactRustplusRelayStore(relay = {}) {
  if (!relay || typeof relay !== 'object') return relay;
  const clientsById = new Map();
  for (const client of Array.isArray(relay.clients) ? relay.clients : []) {
    const id = relayEffectiveClientId(client);
    if (!id) continue;
    const record = {
      ...client,
      id,
      name: firstRelayScalarText([client.name, client.clientName, id], 100) || id
    };
    const previous = clientsById.get(id);
    if (!previous) {
      clientsById.set(id, record);
      continue;
    }
    previous.name = previous.name || record.name || id;
    previous.createdAt = previous.createdAt || record.createdAt || '';
    previous.lastSeenAt = latestIsoTimestamp(previous.lastSeenAt, record.lastSeenAt) || previous.lastSeenAt || record.lastSeenAt || '';
  }
  relay.clients = [...clientsById.values()];

  const serversByKey = new Map();
  for (const server of Array.isArray(relay.servers) ? relay.servers : []) {
    const clientId = relayEffectiveClientId(server);
    const serverId = firstRelayIdentifier([server.serverId, server.server?.id, server.name], 120) || 'default';
    const key = `${clientId}:${serverId}`;
    const record = {
      ...server,
      key,
      serverId,
      clientId,
      clientName: firstRelayScalarText([server.clientName, server.client?.name, clientId], 100) || clientId
    };
    const previous = serversByKey.get(key);
    if (!previous || relayRecordSortTime(record) >= relayRecordSortTime(previous)) {
      serversByKey.set(key, { ...previous, ...record });
    }
  }
  relay.servers = [...serversByKey.values()];

  relay.chatMessages = (Array.isArray(relay.chatMessages) ? relay.chatMessages : []).map((message) => ({
    ...message,
    clientId: relayEffectiveClientId(message),
    serverKey: relayNormalizedServerKey(message)
  }));
  relay.inviteRecords = (Array.isArray(relay.inviteRecords) ? relay.inviteRecords : []).map((record) => ({
    ...record,
    clientId: relayEffectiveClientId(record),
    serverKey: relayNormalizedServerKey(record)
  }));
  relay.steamProfiles = compactRelaySteamProfiles(relay.steamProfiles);
  return relay;
}

function publicRelayClient(client = {}) {
  const clientId = relayEffectiveClientId(client);
  const name = firstRelayScalarText([client.name, client.clientName, clientId], 100) || clientId;
  return {
    id: clientId,
    name,
    createdAt: client.createdAt || '',
    lastSeenAt: client.lastSeenAt || ''
  };
}

function publicRelayServer(server = {}) {
  const snapshot = server.snapshot || null;
  const clientId = relayEffectiveClientId(server);
  const clientName = firstRelayScalarText([server.clientName, server.client?.name, clientId], 100) || clientId;
  return {
    key: server.key || '',
    serverId: server.serverId || '',
    name: server.name || server.serverId || '',
    clientId,
    clientName,
    createdAt: server.createdAt || '',
    lastSeenAt: server.lastSeenAt || '',
    lastSnapshotAt: server.lastSnapshotAt || '',
    clan: snapshot?.clan || { id: '', name: '', memberLimit: 40, announcement: '' },
    summary: snapshot?.summary || { memberCount: 0, onlineCount: 0, offlineCount: 0, inviteCount: 0 }
  };
}

function relayEffectiveClientId(record = {}) {
  const explicit = firstRelayIdentifier([
    record.client?.id,
    record.clientId,
    record.id
  ], 80);
  if (explicit && !relayObjectPlaceholder(explicit) && explicit !== 'default') return explicit;
  const fallback = firstRelayIdentifier([
    record.client?.name,
    record.clientName,
    record.name
  ], 80);
  if (fallback && !relayObjectPlaceholder(fallback)) return fallback;
  return explicit || 'default';
}

function relayRecordsMatchClient(record = {}, clientId = '') {
  if (!clientId) return true;
  const requested = normalizeIdentifier(clientId, 80);
  if (!requested) return true;
  return relayEffectiveClientId(record) === requested || normalizeIdentifier(record.clientId || record.id || '', 80) === requested;
}

function publicRelayClients(clients = []) {
  const byId = new Map();
  for (const client of clients) {
    const publicClient = publicRelayClient(client);
    if (!publicClient.id) continue;
    const existing = byId.get(publicClient.id);
    if (!existing) {
      byId.set(publicClient.id, publicClient);
      continue;
    }
    existing.name = existing.name || publicClient.name || publicClient.id;
    existing.createdAt = existing.createdAt || publicClient.createdAt || '';
    existing.lastSeenAt = latestIsoTimestamp(existing.lastSeenAt, publicClient.lastSeenAt) || existing.lastSeenAt || publicClient.lastSeenAt || '';
  }
  return [...byId.values()].sort((left, right) => (Date.parse(right.lastSeenAt || '') || 0) - (Date.parse(left.lastSeenAt || '') || 0));
}

function relayServerSnapshotGroupKey(server = {}, options = {}) {
  const snapshot = server.snapshot || {};
  if (!snapshot || (!snapshot.capturedAt && !snapshot.clan && !Array.isArray(snapshot.members))) return server.key || '';
  const includeClient = options.includeClient !== false;
  const clientKey = includeClient ? normalizeRelayText(server.clientName || server.clientId || '', 100).toLowerCase() : '';
  const serverName = normalizeRelayText(server.name || server.serverName || server.serverId || '', 140).toLowerCase();
  const clanName = normalizeRelayText(snapshot.clan?.name || '', 140).toLowerCase();
  return [clientKey, serverName, clanName].filter(Boolean).join('|') || server.key || '';
}

function relayServerSnapshotSortTime(server = {}) {
  return Date.parse(server.lastSnapshotAt || server.snapshot?.capturedAt || server.lastSeenAt || server.createdAt || '') || 0;
}

function latestRelayServerRecords(records = [], options = {}) {
  const latestByGroup = new Map();
  for (const server of records) {
    const groupKey = relayServerSnapshotGroupKey(server, options);
    if (!groupKey) continue;
    const existing = latestByGroup.get(groupKey);
    if (!existing || relayServerSnapshotSortTime(server) > relayServerSnapshotSortTime(existing)) {
      latestByGroup.set(groupKey, server);
    }
  }
  return records.filter((server) => latestByGroup.get(relayServerSnapshotGroupKey(server, options)) === server);
}

function relayDisplayNameFromParts(values = [], steamId = '') {
  const normalizedSteamId = steamIdFromValue(steamId);
  const names = values
    .map((value) => decodeRealtimeName(normalizeRelayScalarText(value, 120)))
    .filter(Boolean)
    .filter((value) => value !== normalizedSteamId && !isSteamIdText(value));
  return names[0] || normalizedSteamId || '';
}

function relayIdentityForSteamId(steamId, fallback = {}, storeMemberForSteamId = () => ({})) {
  const normalizedSteamId = steamIdFromValue(steamId);
  const storeMember = storeMemberForSteamId(normalizedSteamId);
  const systemMember = storeMember.member || null;
  const relaySteamProfile = typeof fallback.steamProfile === 'function'
    ? fallback.steamProfile(normalizedSteamId)
    : (fallback.steamProfile || null);
  const customName = normalizeRelayName(systemMember?.customName || fallback.customName || '', 120);
  const steamNickname = normalizeRelayName(systemMember?.steamNickname || relaySteamProfile?.steamNickname || fallback.steamNickname || '', 120);
  const fallbackName = normalizeRelayName(fallback.displayName || fallback.name || fallback.fallbackName || '', 120);
  const displayName = relayDisplayNameFromParts([customName, steamNickname, fallbackName], normalizedSteamId);
  const systemMemberId = systemMember?.id || '';
  return {
    steamId: normalizedSteamId,
    memberId: systemMemberId || fallback.memberId || '',
    authorizedMember: Boolean(systemMemberId),
    unauthorizedMember: Boolean(normalizedSteamId && !systemMemberId),
    customName,
    steamNickname,
    displayName,
    avatar: systemMember?.avatar || relaySteamProfile?.avatar || fallback.avatar || '',
    profileUrl: relaySteamProfile?.profileUrl || fallback.profileUrl || relaySteamProfileUrl(normalizedSteamId),
    squadId: storeMember.squadId || fallback.squadId || '',
    squadName: storeMember.squadName || fallback.squadName || '',
    vitalVipType: systemMember?.vitalVipType || fallback.vitalVipType || '',
    vitalVipPurchasedAt: systemMember?.vitalVipPurchasedAt || fallback.vitalVipPurchasedAt || '',
    vitalVipExpiresAt: systemMember?.vitalVipExpiresAt || fallback.vitalVipExpiresAt || ''
  };
}

function publicRelayChatMessage(message = {}, storeMemberForSteamId = () => ({}), steamProfileForSteamId = () => null) {
  const steamId = message.steamId || '';
  const storeMember = storeMemberForSteamId(steamId);
  const systemMember = storeMember.member || null;
  const relaySteamProfile = steamProfileForSteamId(steamId);
  const systemCustomName = systemMember?.customName || '';
  const relayDisplayName = message.displayName || message.name || steamId || '';
  const systemSteamNickname = systemMember?.steamNickname || relaySteamProfile?.steamNickname || '';
  const displayName = relayDisplayNameFromParts([systemCustomName, systemSteamNickname, relayDisplayName], steamId) || steamId || '';
  return {
    id: message.id || '',
    clientId: message.client?.id || message.clientId || '',
    clientName: message.client?.name || message.clientName || '',
    serverKey: message.server?.key || message.serverKey || '',
    serverId: message.server?.id || message.serverId || '',
    serverName: message.server?.name || message.serverName || '',
    steamId,
    memberId: systemMember?.id || message.memberId || '',
    customName: systemCustomName || message.customName || '',
    steamNickname: systemSteamNickname || (systemCustomName ? relayDisplayName : (message.steamNickname || '')),
    displayName,
    avatar: systemMember?.avatar || relaySteamProfile?.avatar || message.avatar || '',
    profileUrl: relaySteamProfile?.profileUrl || message.profileUrl || relaySteamProfileUrl(steamId),
    message: message.message || '',
    translatedMessage: message.translatedMessage || '',
    channel: message.channel || 'clan',
    sentAt: message.sentAt || '',
    receivedAt: message.receivedAt || ''
  };
}

function publicRelayInviteRecord(record = {}, storeMemberForSteamId = () => ({}), steamProfileForSteamId = () => null) {
  const steamId = record.steamId || record.inviteeSteamId || '';
  const relayDisplayName = record.displayName || record.inviteeName || steamId || '';
  const inviteeIdentity = relayIdentityForSteamId(steamId, {
    customName: record.customName || '',
    steamNickname: record.steamNickname || '',
    displayName: relayDisplayName,
    memberId: record.memberId || '',
    avatar: record.avatar || '',
    steamProfile: steamProfileForSteamId
  }, storeMemberForSteamId);
  const inviterSteamId = record.inviterSteamId || '';
  const persistedInvitedBy = nonSteamRelayScalarText(record.invitedBy, 120);
  const inviterFallbackName = relayDisplayNameFromParts([record.inviterName, persistedInvitedBy], inviterSteamId) || inviterSteamId || '';
  const inviterIdentity = relayIdentityForSteamId(inviterSteamId, {
    displayName: inviterFallbackName,
    avatar: record.inviterAvatar || '',
    steamProfile: steamProfileForSteamId
  }, storeMemberForSteamId);
  const displayName = inviteeIdentity.displayName || relayDisplayName || steamId || '';
  const inviterName = inviterIdentity.displayName || inviterFallbackName || '';
  const sentAt = firstReasonableIsoTimestamp([
    record.sentAt,
    record.invitedAtIso,
    record.invited_at_iso,
    record.inviteTime,
    record.invite_time,
    record.invitedAt,
    record.invited_at,
    record.acceptedAt,
    record.accepted_at,
    record.receivedAt,
    record.received_at
  ]);
  return {
    id: record.id || '',
    clientId: record.client?.id || record.clientId || '',
    clientName: record.client?.name || record.clientName || '',
    serverKey: record.server?.key || record.serverKey || '',
    serverId: record.server?.id || record.serverId || '',
    serverName: record.server?.name || record.serverName || '',
    steamId,
    inviteeSteamId: steamId,
    inviteeName: displayName,
    inviteeDisplayName: displayName,
    inviteeMemberId: inviteeIdentity.memberId,
    inviteeCustomName: inviteeIdentity.customName,
    inviteeSteamNickname: inviteeIdentity.steamNickname,
    inviteeAvatar: inviteeIdentity.avatar,
    displayName,
    memberId: inviteeIdentity.memberId || record.memberId || '',
    customName: inviteeIdentity.customName || record.customName || '',
    steamNickname: inviteeIdentity.steamNickname || (inviteeIdentity.customName ? relayDisplayName : (record.steamNickname || '')),
    avatar: inviteeIdentity.avatar || record.avatar || '',
    inviterSteamId,
    inviterName,
    inviterDisplayName: inviterName,
    inviterMemberId: inviterIdentity.memberId,
    inviterCustomName: inviterIdentity.customName,
    inviterSteamNickname: inviterIdentity.steamNickname,
    inviterAvatar: inviterIdentity.avatar,
    invitedBy: persistedInvitedBy || inviterName,
    status: record.status || 'pending',
    statusLabel: record.statusLabel || '',
    sentAt,
    acceptedAt: normalizeReasonableIsoTimestamp(record.acceptedAt || record.accepted_at || ''),
    receivedAt: record.receivedAt || '',
    gameClanName: record.gameClanName || ''
  };
}

function relayMemberStoreLookup(store = {}) {
  const activeSquads = (store.squads || []).filter((squad) => !squad.archivedAt);
  const squadsById = new Map(activeSquads.map((squad) => [squad.id, squad]));
  const membersBySteamId = new Map((store.members || []).map((member) => [member.steamId, member]));
  const squadByMemberId = new Map((store.squadMembers || []).map((item) => [item.memberId, item]));
  return (steamId) => {
    const member = steamId ? membersBySteamId.get(steamId) : null;
    const squadLink = member ? squadByMemberId.get(member.id) : null;
    const squad = squadLink ? squadsById.get(squadLink.squadId) : null;
    return {
      member,
      squadId: squad?.id || '',
      squadName: squad?.name || ''
    };
  };
}

function relaySteamProfileLookup(relay = {}) {
  const profilesBySteamId = new Map(compactRelaySteamProfiles(relay.steamProfiles)
    .map((profile) => [profile.steamId, profile]));
  return (steamId) => profilesBySteamId.get(steamIdFromValue(steamId)) || null;
}

function relayMemberPresenceObservedAt(member = {}, snapshotAt = '') {
  return latestIsoTimestamp(member.lastSeenAt, member.lastOnlineAt, member.lastOfflineAt, snapshotAt);
}

function relayMemberOnlineExpired(member = {}, snapshotAt = '', nowMs = Date.now()) {
  if (!member.online) return false;
  const observedAt = relayMemberPresenceObservedAt(member, snapshotAt);
  const observedMs = Date.parse(observedAt || '');
  return !Number.isFinite(observedMs) || nowMs - observedMs > RUSTPLUS_RELAY_MEMBER_ONLINE_STALE_MS;
}

function relayMemberSource(serverRecord = {}, member = {}, storeMemberForSteamId = () => ({}), steamProfileForSteamId = () => null, nowMs = Date.now()) {
  const snapshot = serverRecord.snapshot || {};
  const clan = snapshot.clan || {};
  const relayDisplayName = member.displayName || member.steamNickname || member.steamId || '';
  const identity = relayIdentityForSteamId(member.steamId || '', {
    customName: member.customName || '',
    steamNickname: member.steamNickname || '',
    displayName: relayDisplayName,
    memberId: member.memberId || '',
    avatar: member.avatar || '',
    profileUrl: member.profileUrl || '',
    steamProfile: steamProfileForSteamId,
    squadId: member.squadId || '',
    squadName: member.squadName || ''
  }, storeMemberForSteamId);
  const gameClanName = member.gameClanName || clan.name || '';
  const lastSeenAt = member.lastSeenAt || '';
  const lastOnlineAt = member.lastOnlineAt || (member.online ? lastSeenAt : '');
  const lastOfflineAt = member.lastOfflineAt || '';
  const clientId = relayEffectiveClientId(serverRecord);
  const relaySnapshotAt = latestIsoTimestamp(serverRecord.lastSnapshotAt, snapshot.capturedAt, serverRecord.lastSeenAt, serverRecord.createdAt);
  const relayPresenceSnapshotAt = latestIsoTimestamp(serverRecord.lastSnapshotAt, snapshot.capturedAt);
  const relayPresenceAt = relayMemberPresenceObservedAt({ ...member, lastSeenAt, lastOnlineAt, lastOfflineAt }, relayPresenceSnapshotAt);
  const presenceExpired = relayMemberOnlineExpired({ ...member, lastSeenAt, lastOnlineAt, lastOfflineAt }, relayPresenceSnapshotAt, nowMs);
  return {
    ...member,
    id: identity.memberId || member.id || '',
    memberId: identity.memberId || member.memberId || '',
    authorizedMember: identity.authorizedMember,
    unauthorizedMember: identity.unauthorizedMember,
    customName: identity.customName || member.customName || '',
    steamNickname: identity.steamNickname || (identity.customName ? relayDisplayName : (member.steamNickname || '')),
    displayName: identity.displayName || relayDisplayName || member.steamId || '',
    avatar: identity.avatar || member.avatar || '',
    profileUrl: identity.profileUrl || member.profileUrl || '',
    vitalVipType: identity.vitalVipType || member.vitalVipType || '',
    vitalVipPurchasedAt: identity.vitalVipPurchasedAt || member.vitalVipPurchasedAt || '',
    vitalVipExpiresAt: identity.vitalVipExpiresAt || member.vitalVipExpiresAt || '',
    squadId: member.squadId || identity.squadId || '',
    squadName: member.squadName || identity.squadName || '',
    gameClanName,
    gameClanNames: uniqueRelayTexts(splitRelayTextList(member.gameClanNames, gameClanName)),
    serverKey: serverRecord.key || '',
    serverId: serverRecord.serverId || '',
    serverName: serverRecord.name || serverRecord.serverId || '',
    serverNames: uniqueRelayTexts(splitRelayTextList(member.serverNames, serverRecord.name || serverRecord.serverId || '')),
    clientId,
    clientName: firstRelayScalarText([serverRecord.clientName, clientId], 100) || clientId,
    relaySnapshotAt,
    relayPresenceAt,
    presenceExpired,
    stale: presenceExpired,
    online: Boolean(member.online) && !presenceExpired,
    lastSeenAt,
    lastOnlineAt,
    lastOfflineAt
  };
}

function relayMemberPresenceSortTime(member = {}) {
  return Date.parse(
    member.relayPresenceAt ||
      member.relaySnapshotAt ||
      member.lastSeenAt ||
      member.lastOnlineAt ||
      member.lastOfflineAt ||
      ''
  ) || 0;
}

function relayMemberPresenceEventTime(member = {}) {
  return Date.parse(latestIsoTimestamp(member.lastOnlineAt, member.lastOfflineAt, member.lastSeenAt, member.relayPresenceAt) || '') || 0;
}

function relayMemberHasExplicitOffline(member = {}) {
  const offlineMs = Date.parse(member.lastOfflineAt || '') || 0;
  const onlineMs = Date.parse(member.lastOnlineAt || '') || 0;
  return offlineMs > 0 && offlineMs >= onlineMs;
}

function mergeRelayMembers(members = []) {
  const byMember = new Map();
  for (const member of members) {
    const key = member.steamId || `name:${String(member.displayName || '').toLowerCase()}`;
    if (!key) continue;
    const existing = byMember.get(key);
    if (!existing) {
      byMember.set(key, {
        ...member,
        gameClanNames: uniqueRelayTexts(splitRelayTextList(member.gameClanNames, member.gameClanName)),
        serverNames: uniqueRelayTexts(splitRelayTextList(member.serverNames, member.serverName)),
        serverKeys: uniqueRelayTexts([member.serverKey]),
        clientIds: uniqueRelayTexts([member.clientId])
      });
      continue;
    }
    existing.displayName = existing.displayName || member.displayName || existing.steamId;
    existing.memberId = existing.memberId || member.memberId || '';
    existing.authorizedMember = Boolean(existing.authorizedMember || member.authorizedMember || existing.memberId);
    existing.unauthorizedMember = Boolean(!existing.authorizedMember && (existing.unauthorizedMember || member.unauthorizedMember));
    const existingPresenceTime = relayMemberPresenceSortTime(existing);
    const memberPresenceTime = relayMemberPresenceSortTime(member);
    if (memberPresenceTime > existingPresenceTime) {
      existing.online = Boolean(member.online);
      existing.lastOnlineAtSource = member.lastOnlineAtSource || existing.lastOnlineAtSource || '';
    } else if (memberPresenceTime === existingPresenceTime) {
      const existingEventTime = relayMemberPresenceEventTime(existing);
      const memberEventTime = relayMemberPresenceEventTime(member);
      if (memberEventTime > existingEventTime) {
        existing.online = Boolean(member.online);
        existing.lastOnlineAtSource = member.lastOnlineAtSource || existing.lastOnlineAtSource || '';
      } else if (memberEventTime === existingEventTime) {
        existing.online = relayMemberHasExplicitOffline(existing) || relayMemberHasExplicitOffline(member)
          ? false
          : Boolean(existing.online || member.online);
      }
    }
    existing.role = existing.role || member.role || '';
    existing.avatar = existing.avatar || member.avatar || '';
    existing.profileUrl = existing.profileUrl || member.profileUrl || '';
    existing.vitalVipType = existing.vitalVipType || member.vitalVipType || '';
    existing.vitalVipPurchasedAt = existing.vitalVipPurchasedAt || member.vitalVipPurchasedAt || '';
    existing.vitalVipExpiresAt = existing.vitalVipExpiresAt || member.vitalVipExpiresAt || '';
    existing.squadId = existing.squadId || member.squadId || '';
    existing.squadName = existing.squadName || member.squadName || '';
    existing.gameClanNames = uniqueRelayTexts([
      ...splitRelayTextList(existing.gameClanNames, existing.gameClanName),
      ...splitRelayTextList(member.gameClanNames, member.gameClanName)
    ]);
    existing.gameClanName = existing.gameClanNames.join(', ');
    existing.serverNames = uniqueRelayTexts([
      ...splitRelayTextList(existing.serverNames, existing.serverName),
      ...splitRelayTextList(member.serverNames, member.serverName)
    ]);
    existing.serverName = existing.serverNames.join(', ');
    existing.serverKeys = uniqueRelayTexts([...(existing.serverKeys || []), member.serverKey]);
    existing.clientIds = uniqueRelayTexts([...(existing.clientIds || []), member.clientId]);
    existing.relaySnapshotAt = latestIsoTimestamp(existing.relaySnapshotAt, member.relaySnapshotAt) || existing.relaySnapshotAt || member.relaySnapshotAt || '';
    existing.relayPresenceAt = latestIsoTimestamp(existing.relayPresenceAt, member.relayPresenceAt) || existing.relayPresenceAt || member.relayPresenceAt || '';
    existing.presenceExpired = Boolean(existing.presenceExpired && member.presenceExpired);
    existing.joinedAt = latestIsoTimestamp(existing.joinedAt, member.joinedAt) || existing.joinedAt || member.joinedAt || '';
    existing.lastSeenAt = latestIsoTimestamp(existing.lastSeenAt, member.lastSeenAt) || existing.lastSeenAt || member.lastSeenAt || '';
    existing.lastOnlineAt = latestIsoTimestamp(existing.lastOnlineAt, member.lastOnlineAt) || existing.lastOnlineAt || member.lastOnlineAt || '';
    existing.lastOfflineAt = latestIsoTimestamp(existing.lastOfflineAt, member.lastOfflineAt) || existing.lastOfflineAt || member.lastOfflineAt || '';
    existing.onlineTimeMinutes = Math.max(Number(existing.onlineTimeMinutes || 0), Number(member.onlineTimeMinutes || 0)) || null;
  }
  return [...byMember.values()].sort((left, right) => {
    if (left.online !== right.online) return left.online ? -1 : 1;
    return String(left.displayName || left.steamId || '').localeCompare(String(right.displayName || right.steamId || ''), 'zh-Hans-CN');
  });
}

function mergeRelayInvites(serverRecords = []) {
  return uniqueBy(
    serverRecords.flatMap((server) => (server.snapshot?.invites || []).map((invite) => ({
      ...invite,
      serverKey: server.key || '',
      serverId: server.serverId || '',
      serverName: server.name || server.serverId || '',
      gameClanName: server.snapshot?.clan?.name || ''
    }))),
    (invite) => [invite.steamId || invite.displayName, invite.serverKey].filter(Boolean).join(':')
  );
}

function relayUnknownSteamIdsForBackfill(relayState = {}) {
  return [...new Set((relayState.members || [])
    .filter((member) => member?.unauthorizedMember && member.steamId)
    .map((member) => steamIdFromValue(member.steamId))
    .filter(Boolean))];
}

function relaySteamProfileBackfillTargetsForStore(store = {}, steamIds = [], nowMs = Date.now()) {
  const relay = ensureRustplusRelayStore(store);
  const requestedSteamIds = [...new Set((Array.isArray(steamIds) ? steamIds : [steamIds])
    .map(steamIdFromValue)
    .filter(Boolean))];
  const systemSteamIds = new Set((store.members || []).map((member) => steamIdFromValue(member.steamId)).filter(Boolean));
  const profilesBySteamId = new Map(compactRelaySteamProfiles(relay.steamProfiles).map((profile) => [profile.steamId, profile]));
  const targets = requestedSteamIds
    .filter((steamId) => !systemSteamIds.has(steamId))
    .filter((steamId) => relaySteamProfileNeedsRefresh(profilesBySteamId.get(steamId), nowMs))
    .slice(0, RUSTPLUS_RELAY_STEAM_PROFILE_BACKFILL_BATCH_LIMIT);
  return { requestedSteamIds, targets, profilesBySteamId };
}

async function fetchRelaySteamProfileRecord(steamId, previous = {}) {
  const fetchedAt = nowIso();
  try {
    const profile = await fetchSteamProfile(steamId);
    if (!profile) {
      return {
        fetched: false,
        record: normalizeRelaySteamProfileRecord({
          ...previous,
          steamId,
          profileUrl: previous.profileUrl || relaySteamProfileUrl(steamId),
          failedAt: fetchedAt,
          lastError: 'Steam profile fetch returned no data'
        })
      };
    }
    return {
      fetched: true,
      record: normalizeRelaySteamProfileRecord({
        steamId,
        steamNickname: profile.nickname || previous.steamNickname || '',
        avatar: profile.avatar || previous.avatar || '',
        profileUrl: profile.profileUrl || previous.profileUrl || relaySteamProfileUrl(steamId),
        fetchedAt,
        failedAt: '',
        lastError: ''
      })
    };
  } catch (error) {
    return {
      fetched: false,
      record: normalizeRelaySteamProfileRecord({
        ...previous,
        steamId,
        profileUrl: previous.profileUrl || relaySteamProfileUrl(steamId),
        failedAt: fetchedAt,
        lastError: error?.message || 'Steam profile fetch failed'
      })
    };
  }
}

function upsertRelaySteamProfileRecord(profilesBySteamId, record = {}) {
  const profile = normalizeRelaySteamProfileRecord(record);
  if (!profile) return false;
  const previous = profilesBySteamId.get(profile.steamId);
  const profileTime = Date.parse(profile.fetchedAt || profile.failedAt || '') || 0;
  const previousTime = Date.parse(previous?.fetchedAt || previous?.failedAt || '') || 0;
  if (previous && previousTime > profileTime) return false;
  profilesBySteamId.set(profile.steamId, profile);
  return true;
}

export async function refreshRustplusRelaySteamProfilesInStore(store = {}, steamIds = []) {
  const { requestedSteamIds, targets, profilesBySteamId } = relaySteamProfileBackfillTargetsForStore(store, steamIds);
  if (!requestedSteamIds.length) return { requested: 0, fetched: 0, updated: 0, skipped: 0 };
  if (!targets.length) {
    return { requested: requestedSteamIds.length, fetched: 0, updated: 0, skipped: requestedSteamIds.length };
  }

  let fetched = 0;
  let updated = 0;
  for (const steamId of targets) {
    const previous = profilesBySteamId.get(steamId) || {};
    const { record, fetched: profileFetched } = await fetchRelaySteamProfileRecord(steamId, previous);
    if (upsertRelaySteamProfileRecord(profilesBySteamId, record)) {
      fetched += profileFetched ? 1 : 0;
      updated += 1;
    }
  }

  const relay = ensureRustplusRelayStore(store);
  relay.steamProfiles = compactRelaySteamProfiles([...profilesBySteamId.values()]);
  return {
    requested: requestedSteamIds.length,
    fetched,
    updated,
    skipped: requestedSteamIds.length - targets.length
  };
}

export async function backfillRustplusRelaySteamProfiles(steamIds = []) {
  const initialStore = await readRustplusRelayRuntimeStore();
  const { requestedSteamIds, targets, profilesBySteamId } = relaySteamProfileBackfillTargetsForStore(initialStore, steamIds);
  if (!requestedSteamIds.length) {
    return { requested: 0, fetched: 0, updated: 0, skipped: 0, relay: publicRustplusRelayState(initialStore) };
  }
  if (!targets.length) {
    return {
      requested: requestedSteamIds.length,
      fetched: 0,
      updated: 0,
      skipped: requestedSteamIds.length,
      relay: publicRustplusRelayState(initialStore)
    };
  }

  const fetchedRecords = [];
  for (const steamId of targets) {
    fetchedRecords.push({
      steamId,
      ...(await fetchRelaySteamProfileRecord(steamId, profilesBySteamId.get(steamId) || {}))
    });
  }

  let result = {
    requested: requestedSteamIds.length,
    fetched: fetchedRecords.filter((item) => item.fetched).length,
    updated: 0,
    skipped: requestedSteamIds.length - fetchedRecords.length
  };
  const relayState = await updateRustplusRelayRuntimeStore((store) => {
    const relay = ensureRustplusRelayStore(store);
    const latestSystemSteamIds = new Set((store.members || []).map((member) => steamIdFromValue(member.steamId)).filter(Boolean));
    const nextProfilesBySteamId = new Map(compactRelaySteamProfiles(relay.steamProfiles).map((profile) => [profile.steamId, profile]));
    for (const item of fetchedRecords) {
      if (!item.record || latestSystemSteamIds.has(item.steamId)) continue;
      if (upsertRelaySteamProfileRecord(nextProfilesBySteamId, item.record)) result.updated += 1;
    }
    relay.steamProfiles = compactRelaySteamProfiles([...nextProfilesBySteamId.values()]);
    return publicRustplusRelayState(store);
  }, 'rustplus_relay_steam_profile_backfill');
  if (result.updated > 0) {
    lastRustplusRelayPublicState = relayState;
    broadcastRustplusRelayUpdate({
      event: {
        type: 'steam_profile_backfill',
        receivedAt: nowIso(),
        updated: result.updated,
        fetched: result.fetched
      },
      relay: relayState
    });
  }
  return { ...result, relay: relayState };
}

export function queueRustplusRelaySteamProfileBackfill(relayState = {}) {
  if (process.env.NB_DISABLE_BACKGROUND_JOBS === '1') return;
  const steamIds = relayUnknownSteamIdsForBackfill(relayState)
    .filter((steamId) => !pendingRelaySteamProfileBackfills.has(steamId));
  if (!steamIds.length) return;
  for (const steamId of steamIds) pendingRelaySteamProfileBackfills.add(steamId);
  const timer = setTimeout(() => {
    backfillRustplusRelaySteamProfiles(steamIds)
      .catch((error) => {
        console.error('[nb-clan] Rust+ relay Steam profile backfill failed', error);
      })
      .finally(() => {
        for (const steamId of steamIds) pendingRelaySteamProfileBackfills.delete(steamId);
      });
  }, 0);
  timer.unref?.();
}

function aggregateRelayClan(serverRecords = []) {
  const snapshots = serverRecords.map((server) => server.snapshot).filter(Boolean);
  const clans = snapshots.map((snapshot) => snapshot.clan || {}).filter((clan) => clan.name || clan.id);
  const names = uniqueRelayTexts(clans.map((clan) => clan.name));
  const ids = uniqueRelayTexts(clans.map((clan) => clan.id));
  const announcements = uniqueRelayTexts(clans.map((clan) => clan.announcement));
  const memberLimit = clans.reduce((total, clan) => total + (Number(clan.memberLimit || 0) || 0), 0);
  return {
    id: ids.join(', '),
    name: names.join(' / '),
    names,
    count: names.length,
    memberLimit: memberLimit || (names.length ? names.length * 40 : 40),
    announcement: announcements.join('\n\n')
  };
}

export function publicRustplusRelayState(store = {}, filters = {}) {
  const relay = ensureRustplusRelayStore(store);
  const requestedClientId = normalizeIdentifier(filters.clientId || filters.client_id || '', 80);
  const requestedServerKey = normalizeIdentifier(filters.serverKey || filters.server_key || '', 180);
  const chatOffset = normalizePositiveInteger(filters.chatOffset || filters.chat_offset, 0, Number.MAX_SAFE_INTEGER);
  const hasChatLimit = Object.hasOwn(filters, 'chatLimit') || Object.hasOwn(filters, 'chat_limit');
  const chatLimit = normalizePositiveInteger(
    filters.chatLimit || filters.chat_limit,
    hasChatLimit ? 0 : RUSTPLUS_RELAY_PUBLIC_CHAT_INITIAL_LIMIT,
    RUSTPLUS_RELAY_PUBLIC_CHAT_MAX_LIMIT
  );
  const hasInviteRecordsFlag = Object.hasOwn(filters, 'includeInviteRecords') || Object.hasOwn(filters, 'include_invite_records');
  const includeInviteRecords = hasInviteRecordsFlag
    ? ['1', 'true', 'yes'].includes(String(filters.includeInviteRecords || filters.include_invite_records || '').toLowerCase())
    : true;
  const inviteRecordOffset = normalizePositiveInteger(
    filters.inviteRecordOffset || filters.invite_record_offset || filters.inviteOffset || filters.invite_offset,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const hasInviteRecordLimit = (
    Object.hasOwn(filters, 'inviteRecordLimit') ||
    Object.hasOwn(filters, 'invite_record_limit') ||
    Object.hasOwn(filters, 'inviteLimit') ||
    Object.hasOwn(filters, 'invite_limit')
  );
  const inviteRecordLimit = normalizePositiveInteger(
    filters.inviteRecordLimit || filters.invite_record_limit || filters.inviteLimit || filters.invite_limit,
    hasInviteRecordLimit ? 0 : RUSTPLUS_RELAY_INVITE_RECORD_LIMIT,
    RUSTPLUS_RELAY_INVITE_RECORD_LIMIT
  );
  const collectionPageInfo = store[RUSTPLUS_RELAY_COLLECTION_PAGE_INFO] || {};
  const chatPageInfo = collectionPageInfo.chatMessages || {};
  const inviteRecordPageInfo = collectionPageInfo.inviteRecords || {};
  const activeServerRecords = latestRelayServerRecords(relay.servers, {
    includeClient: Boolean(requestedClientId || requestedServerKey)
  });
  const clients = publicRelayClients(relay.clients);
  const allServers = activeServerRecords.map(publicRelayServer);
  const selectedClientId = requestedClientId;
  const servers = selectedClientId ? allServers.filter((server) => relayRecordsMatchClient(server, selectedClientId)) : allServers;
  const selectedServerKey = requestedServerKey;
  const serverRecord = activeServerRecords.find((server) => server.key === selectedServerKey) || null;
  const serverRecords = activeServerRecords
    .filter((server) => relayRecordsMatchClient(server, selectedClientId))
    .filter((server) => !selectedServerKey || server.key === selectedServerKey);
  const memberForSteamId = relayMemberStoreLookup(store);
  const steamProfileForSteamId = relaySteamProfileLookup(relay);
  const filteredChatMessages = relay.chatMessages
    .filter((message) => relayRecordsMatchClient(message.client || message, selectedClientId))
    .filter((message) => !selectedServerKey || (message.server?.key || message.serverKey) === selectedServerKey);
  const filteredInviteRecords = relay.inviteRecords
    .filter((record) => relayRecordsMatchClient(record.client || record, selectedClientId))
    .filter((record) => !selectedServerKey || (record.server?.key || record.serverKey) === selectedServerKey);
  const chatLocalOffset = chatPageInfo.all === false || chatPageInfo.disabled
    ? Math.max(0, chatOffset - Number(chatPageInfo.offset || 0))
    : chatOffset;
  const visibleChatMessages = filteredChatMessages.slice(chatLocalOffset, chatLocalOffset + chatLimit);
  const chatPageHasMore = chatPageInfo.all === false
    ? filteredChatMessages.length > chatLocalOffset + visibleChatMessages.length
    : chatOffset + visibleChatMessages.length < filteredChatMessages.length;
  const chatPageInfoTotal = relayNonNegativeCountOrNull(chatPageInfo.total);
  const chatPageTotal = chatPageInfoTotal !== null
    ? chatPageInfoTotal
    : (chatPageInfo.all === false
    ? chatOffset + visibleChatMessages.length + (chatPageHasMore ? 1 : 0)
      : filteredChatMessages.length);
  const inviteRecordLocalOffset = inviteRecordPageInfo.all === false || inviteRecordPageInfo.disabled
    ? Math.max(0, inviteRecordOffset - Number(inviteRecordPageInfo.offset || 0))
    : inviteRecordOffset;
  const visibleInviteRecords = includeInviteRecords
    ? filteredInviteRecords.slice(inviteRecordLocalOffset, inviteRecordLocalOffset + inviteRecordLimit)
    : [];
  const inviteRecordPageHasMore = includeInviteRecords && (inviteRecordPageInfo.all === false
    ? filteredInviteRecords.length > inviteRecordLocalOffset + visibleInviteRecords.length
    : inviteRecordOffset + visibleInviteRecords.length < filteredInviteRecords.length);
  const inviteRecordPageInfoTotal = relayNonNegativeCountOrNull(inviteRecordPageInfo.total);
  const inviteRecordPageTotal = inviteRecordPageInfoTotal !== null
    ? inviteRecordPageInfoTotal
    : (inviteRecordPageInfo.all === false
    ? inviteRecordOffset + visibleInviteRecords.length + (inviteRecordPageHasMore ? 1 : 0)
      : filteredInviteRecords.length);
  const chatMessages = visibleChatMessages
    .map((message) => publicRelayChatMessage(message, memberForSteamId, steamProfileForSteamId));
  const inviteRecords = visibleInviteRecords.map((record) => publicRelayInviteRecord(record, memberForSteamId, steamProfileForSteamId));
  const snapshot = serverRecord?.snapshot || null;
  const members = mergeRelayMembers(serverRecords.flatMap((server) => (
    (server.snapshot?.members || []).map((member) => relayMemberSource(server, member, memberForSteamId, steamProfileForSteamId))
  )));
  const invites = mergeRelayInvites(serverRecords);
  const clan = selectedServerKey
    ? snapshot?.clan || { id: '', name: '', memberLimit: 40, announcement: '', names: [], count: 0 }
    : aggregateRelayClan(serverRecords);
  return {
    settings: rustplusRelaySettingsPayload(store),
    clients,
    servers,
    selected: {
      clientId: selectedClientId,
      serverKey: selectedServerKey,
      serverId: serverRecord?.serverId || '',
      serverName: serverRecord?.name || ''
    },
    server: serverRecord ? {
      ...publicRelayServer(serverRecord),
      capturedAt: snapshot?.capturedAt || '',
      clan: snapshot?.clan || { id: '', name: '', memberLimit: 40, announcement: '' },
      members,
      invites,
      inviteRecords
    } : null,
    clan,
    members,
    invites,
    inviteRecords,
    inviteRecordsIncluded: includeInviteRecords,
    chatMessages,
    chatPage: {
      offset: chatOffset,
      limit: chatLimit,
      count: chatMessages.length,
      total: chatPageTotal,
      hasMore: Boolean(chatPageHasMore),
      nextOffset: chatOffset + chatMessages.length
    },
    summary: {
      memberCount: members.length,
      onlineCount: members.filter((member) => member.online).length,
      offlineCount: members.filter((member) => !member.online).length,
      staleCount: members.filter((member) => member.presenceExpired).length,
      inviteCount: invites.length,
      inviteRecordCount: inviteRecordPageTotal,
      chatCount: chatPageTotal
    }
  };
}

function trimRelayChatMessages(messages = []) {
  let items = [...messages].sort((left, right) => Date.parse(right.receivedAt || right.sentAt || '') - Date.parse(left.receivedAt || left.sentAt || ''));
  if (RUSTPLUS_RELAY_CHAT_COUNT_LIMIT > 0) {
    items = items.slice(0, RUSTPLUS_RELAY_CHAT_COUNT_LIMIT);
  }
  let totalBytes = 0;
  const retained = [];
  for (const item of items) {
    const bytes = estimateJsonByteLength(item);
    if (retained.length && totalBytes + bytes > RUSTPLUS_RELAY_CHAT_STORAGE_BYTES_LIMIT) break;
    retained.push(item);
    totalBytes += bytes;
  }
  return retained;
}

function relayChatStorageRecord(message = {}) {
  return {
    ...message,
    clientId: message.client?.id || message.clientId || '',
    clientName: message.client?.name || message.clientName || '',
    serverKey: message.server?.key || message.serverKey || '',
    serverId: message.server?.id || message.serverId || '',
    serverName: message.server?.name || message.serverName || ''
  };
}

function insertChatMessages(relay, messages = []) {
  const nextMessages = [];
  let inserted = 0;
  const incomingIds = new Set();
  for (const message of messages) {
    const record = relayChatStorageRecord(message);
    if (!record.id || incomingIds.has(record.id)) continue;
    incomingIds.add(record.id);
    if (!relay.chatMessages.some((item) => item.id === record.id)) inserted += 1;
    nextMessages.push(record);
  }
  if (!nextMessages.length) return { inserted: 0 };
  relay.chatMessages = trimRelayChatMessages([
    ...nextMessages,
    ...relay.chatMessages.filter((item) => !incomingIds.has(item.id))
  ]);
  return { inserted };
}

function insertChatMessage(relay, message) {
  return insertChatMessages(relay, [message]).inserted > 0;
}

function relayInviteRecordDedupeKey(record = {}) {
  const serverKey = record.server?.key || record.serverKey || '';
  const externalId = record.externalId || '';
  if (externalId) return [serverKey, externalId].join(':');
  const inviteeKey = record.steamId || record.inviteeSteamId || record.displayName || record.inviteeName || '';
  const inviterKey = record.inviterSteamId || record.inviterName || record.invitedBy || '';
  const timeKey = firstReasonableIsoTimestamp([
    record.sentAt,
    record.invitedAtIso,
    record.inviteTime,
    record.invitedAt,
    record.acceptedAt
  ]);
  if (!timeKey) return [serverKey, inviteeKey, inviterKey].join(':') || record.id || '';
  return [serverKey, inviteeKey, inviterKey, timeKey].join(':');
}

function relayInviteRecordSortTime(record = {}) {
  const time = firstReasonableIsoTimestamp([
    record.sentAt,
    record.invitedAtIso,
    record.inviteTime,
    record.invitedAt,
    record.acceptedAt,
    record.receivedAt
  ]);
  return Date.parse(time || '') || 0;
}

function trimRelayInviteRecords(records = []) {
  return [...records]
    .sort((left, right) => relayInviteRecordSortTime(right) - relayInviteRecordSortTime(left))
    .slice(0, RUSTPLUS_RELAY_INVITE_RECORD_LIMIT);
}

function insertInviteRecord(relay, record) {
  const storageRecord = {
    ...record,
    clientId: record.client.id,
    clientName: record.client.name,
    serverKey: record.server.key,
    serverId: record.server.id,
    serverName: record.server.name
  };
  const key = relayInviteRecordDedupeKey(storageRecord);
  const exists = relay.inviteRecords.some((item) => item.id === storageRecord.id || relayInviteRecordDedupeKey(item) === key);
  relay.inviteRecords = trimRelayInviteRecords([
    storageRecord,
    ...relay.inviteRecords.filter((item) => item.id !== storageRecord.id && relayInviteRecordDedupeKey(item) !== key)
  ]);
  return !exists;
}

function relayPersistCacheTime(value = '') {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function compactRelayMemberSignature(member = {}) {
  return {
    steamId: member.steamId || '',
    displayName: member.displayName || '',
    online: Boolean(member.online),
    role: member.role || '',
    joinedAt: member.joinedAt || ''
  };
}

function compactRelayInviteSignature(invite = {}) {
  return {
    steamId: invite.steamId || '',
    displayName: invite.displayName || '',
    invitedBy: invite.invitedBy || '',
    inviterSteamId: invite.inviterSteamId || '',
    inviterName: invite.inviterName || '',
    status: invite.status || '',
    sentAt: invite.sentAt || '',
    acceptedAt: invite.acceptedAt || ''
  };
}

function relaySnapshotContentSignature(snapshot = {}) {
  const members = (Array.isArray(snapshot.members) ? snapshot.members : [])
    .map(compactRelayMemberSignature)
    .sort((left, right) => (
      `${left.steamId}:${left.displayName}`.localeCompare(`${right.steamId}:${right.displayName}`)
    ));
  const invites = (Array.isArray(snapshot.invites) ? snapshot.invites : [])
    .map(compactRelayInviteSignature)
    .sort((left, right) => (
      `${left.steamId}:${left.displayName}:${left.inviterSteamId}:${left.inviterName}`.localeCompare(
        `${right.steamId}:${right.displayName}:${right.inviterSteamId}:${right.inviterName}`
      )
    ));
  return JSON.stringify({
    clientId: snapshot.client?.id || '',
    serverId: snapshot.server?.id || '',
    clan: {
      id: snapshot.clan?.id || '',
      name: snapshot.clan?.name || '',
      memberLimit: snapshot.clan?.memberLimit || 0,
      announcement: snapshot.clan?.announcement || ''
    },
    members,
    invites
  });
}

function relayInviteRecordContentSignature(record = {}) {
  return JSON.stringify({
    key: relayInviteRecordDedupeKey(record),
    status: record.status || '',
    sentAt: record.sentAt || '',
    acceptedAt: record.acceptedAt || '',
    displayName: record.displayName || '',
    inviterName: record.inviterName || record.invitedBy || ''
  });
}

function relayChatMessageDedupeKey(record = {}) {
  const serverKey = record.server?.key || record.serverKey || '';
  const sentAt = record.sentAt && record.sentAt !== record.receivedAt ? record.sentAt : '';
  return [
    serverKey,
    record.steamId || record.displayName || '',
    record.channel || '',
    sentAt,
    record.message || '',
    record.translatedMessage || ''
  ].join(':');
}

function relayChatMessageContentSignature(record = {}) {
  return JSON.stringify({
    key: relayChatMessageDedupeKey(record),
    message: record.message || '',
    translatedMessage: record.translatedMessage || '',
    sentAt: record.sentAt && record.sentAt !== record.receivedAt ? record.sentAt : '',
    displayName: record.displayName || ''
  });
}

function relayWriteDedupeDecision(normalized = {}, receivedAt = '') {
  const nowMs = relayPersistCacheTime(receivedAt);
  if (normalized.type === 'clan_snapshot') {
    const key = relaySnapshotDedupeKey(normalized);
    const signature = relaySnapshotContentSignature(normalized);
    const previous = relayWriteDedupe.get(key);
    const unchanged = relayDedupeSignatureMatches(previous, signature);
    return {
      key,
      signature,
      nowMs,
      skipped: unchanged,
      pendingWrite: unchanged ? previous?.pendingWrite || null : null,
      reason: 'unchanged_snapshot'
    };
  }
  if (normalized.type === 'clan_chat_message') {
    const key = `chat:${relayChatMessageDedupeKey(normalized)}`;
    const signature = relayChatMessageContentSignature(normalized);
    const previous = relayWriteDedupe.get(key);
    const duplicate = relayDedupeSignatureMatches(previous, signature, nowMs, RUSTPLUS_RELAY_CHAT_MESSAGE_WRITE_DEDUPE_MS);
    return {
      key,
      signature,
      nowMs,
      skipped: duplicate,
      pendingWrite: duplicate ? previous?.pendingWrite || null : null,
      reason: 'duplicate_chat_message'
    };
  }
  if (normalized.type === 'clan_invite_record') {
    const key = `invite:${relayInviteRecordDedupeKey(normalized)}`;
    const signature = relayInviteRecordContentSignature(normalized);
    const previous = relayWriteDedupe.get(key);
    const duplicate = relayDedupeSignatureMatches(previous, signature);
    return {
      key,
      signature,
      nowMs,
      skipped: duplicate,
      pendingWrite: duplicate ? previous?.pendingWrite || null : null,
      reason: 'duplicate_invite_record'
    };
  }
  if (['member_online', 'member_offline', 'member_joined', 'member_left'].includes(normalized.type)) {
    const key = `member:${normalized.client?.id || ''}:${normalized.server?.key || ''}:${memberDeltaKey(normalized.member)}`;
    const signature = relayMemberDeltaContentSignature(normalized);
    const previous = relayWriteDedupe.get(key);
    const duplicate = relayDedupeSignatureMatches(previous, signature, nowMs, RUSTPLUS_RELAY_MEMBER_DELTA_WRITE_DEDUPE_MS);
    return {
      key,
      signature,
      nowMs,
      skipped: duplicate,
      pendingWrite: duplicate ? previous?.pendingWrite || null : null,
      reason: 'duplicate_member_delta'
    };
  }
  return null;
}

function relayMemberDeltaContentSignature(normalized = {}) {
  const member = normalized.member || {};
  return JSON.stringify({
    type: normalized.type || '',
    clientId: normalized.client?.id || '',
    serverKey: normalized.server?.key || '',
    steamId: member.steamId || '',
    displayName: member.displayName || '',
    online: Boolean(member.online),
    role: member.role || '',
    squadId: member.squadId || '',
    squadName: member.squadName || '',
    gameClanName: member.gameClanName || '',
    avatar: member.avatar || '',
    profileUrl: member.profileUrl || '',
    joinedAt: member.joinedAt || '',
    onlineTimeBucket: relayMemberOnlineTimeBucket(member.onlineTimeMinutes)
  });
}

function relayMemberOnlineTimeBucket(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.floor(minutes / RUSTPLUS_RELAY_MEMBER_ONLINE_TIME_BUCKET_MINUTES);
}

function relayMemberStoredSignature(member = {}) {
  return JSON.stringify({
    key: memberDeltaKey(member),
    steamId: member.steamId || '',
    displayName: member.displayName || '',
    online: Boolean(member.online),
    role: member.role || '',
    squadId: member.squadId || '',
    squadName: member.squadName || '',
    gameClanName: member.gameClanName || '',
    avatar: member.avatar || '',
    profileUrl: member.profileUrl || '',
    joinedAt: member.joinedAt || '',
    onlineTimeBucket: relayMemberOnlineTimeBucket(member.onlineTimeMinutes)
  });
}

function relayMemberDeltaTypesIncludes(type = '') {
  return ['member_online', 'member_offline', 'member_joined', 'member_left'].includes(type);
}

function relayServerRecordForDelta(store = {}, normalized = {}) {
  const relay = store.rustplusRelay || {};
  const serverKey = normalized.server?.key || '';
  if (!serverKey) return null;
  return (Array.isArray(relay.servers) ? relay.servers : []).find((server) => server?.key === serverKey) || null;
}

function relayMemberRecordForDelta(store = {}, normalized = {}) {
  const server = relayServerRecordForDelta(store, normalized);
  const members = Array.isArray(server?.snapshot?.members) ? server.snapshot.members : [];
  const key = memberDeltaKey(normalized.member);
  if (!key) return null;
  return members.find((member) => memberDeltaKey(member) === key) || null;
}

function relayMemberDeltaNextSignature(existing = {}, normalized = {}) {
  const next = mergeRelayMemberDelta(existing, normalized.member || {});
  if (normalized.type === 'member_online') {
    next.online = true;
  } else if (['member_offline', 'member_left'].includes(normalized.type)) {
    next.online = false;
  }
  return relayMemberStoredSignature(next);
}

function relayMemberDeltaWouldChangeStore(store = {}, normalized = {}) {
  if (!relayMemberDeltaTypesIncludes(normalized.type)) return true;
  const existing = relayMemberRecordForDelta(store, normalized);
  if (normalized.type === 'member_left') return Boolean(existing);
  if (!existing) return true;
  return relayMemberStoredSignature(existing) !== relayMemberDeltaNextSignature(existing, normalized);
}

function relayDedupeSignatureMatches(previous = null, signature = '', nowMs = 0, windowMs = 0) {
  if (!previous || previous.signature !== signature) return false;
  if (!windowMs) return true;
  const persistedAt = Number(previous.persistedAt) || 0;
  if (!Number.isFinite(persistedAt)) return true;
  return nowMs - persistedAt <= windowMs;
}

function relaySnapshotDedupeKey(normalized = {}) {
  return `snapshot:${normalized.client?.id || ''}:${normalized.server?.id || ''}`;
}

function rememberRelayWrite(decision = null) {
  if (!decision?.key) return;
  relayWriteDedupe.set(decision.key, {
    signature: decision.signature,
    persistedAt: decision.nowMs
  });
  if (relayWriteDedupe.size > RUSTPLUS_RELAY_WRITE_DEDUPE_CACHE_LIMIT) {
    const cutoff = Date.now() - Math.max(
      RUSTPLUS_RELAY_CHAT_MESSAGE_WRITE_DEDUPE_MS,
      RUSTPLUS_RELAY_MEMBER_DELTA_WRITE_DEDUPE_MS,
      RUSTPLUS_RELAY_INVITE_RECORD_WRITE_DEDUPE_MS,
      RUSTPLUS_RELAY_SNAPSHOT_WRITE_MIN_INTERVAL_MS
    ) * 2;
    for (const [key, item] of relayWriteDedupe.entries()) {
      if ((item.persistedAt || 0) < cutoff) relayWriteDedupe.delete(key);
    }
  }
}

function persistRelayWrite(decision = null, task) {
  if (!decision?.key) return Promise.resolve().then(task);
  let pendingWrite;
  pendingWrite = Promise.resolve().then(task).then(
    (result) => {
      if (relayWriteDedupe.get(decision.key)?.pendingWrite === pendingWrite) {
        rememberRelayWrite(decision);
      }
      return result;
    },
    (error) => {
      if (relayWriteDedupe.get(decision.key)?.pendingWrite === pendingWrite) {
        relayWriteDedupe.delete(decision.key);
      }
      throw error;
    }
  );
  relayWriteDedupe.set(decision.key, {
    signature: decision.signature,
    persistedAt: decision.nowMs,
    pendingWrite
  });
  return pendingWrite;
}

function rememberSeededRelayWrite(key = '', signature = '', persistedAt = Number.POSITIVE_INFINITY) {
  if (!key || !signature) return;
  relayWriteDedupe.set(key, {
    signature,
    persistedAt
  });
}

function relaySnapshotLikeFromServerRecord(server = {}) {
  const snapshot = server.snapshot || {};
  return {
    ...snapshot,
    client: { id: server.clientId || '' },
    server: { id: server.serverId || '', key: server.key || '' }
  };
}

function seedRelayWriteDedupeFromStoreSnapshot(store = {}) {
  const relay = ensureRustplusRelayStore(store);
  for (const server of relay.servers || []) {
    if (server?.snapshot) {
      const snapshot = relaySnapshotLikeFromServerRecord(server);
      rememberSeededRelayWrite(relaySnapshotDedupeKey(snapshot), relaySnapshotContentSignature(snapshot));
    }
  }
  for (const message of relay.chatMessages || []) {
    rememberSeededRelayWrite(
      `chat:${relayChatMessageDedupeKey(message)}`,
      relayChatMessageContentSignature(message),
      relayPersistCacheTime(message.receivedAt || message.sentAt)
    );
  }
  for (const record of relay.inviteRecords || []) {
    rememberSeededRelayWrite(`invite:${relayInviteRecordDedupeKey(record)}`, relayInviteRecordContentSignature(record));
  }
  lastRustplusRelayPublicState = publicRustplusRelayState(store);
}

async function seedRelayWriteDedupeFromStore() {
  if (!relayWriteDedupeSeedPromise) {
    relayWriteDedupeSeedPromise = (async () => {
      const store = await readRustplusRelayRuntimeStore();
      seedRelayWriteDedupeFromStoreSnapshot(store);
    })().catch((error) => {
      relayWriteDedupeSeedPromise = null;
      throw error;
    });
  }
  return relayWriteDedupeSeedPromise;
}

function clearRelayChatFlushTimer() {
  if (!pendingRelayChatFlushTimer) return;
  clearTimeout(pendingRelayChatFlushTimer);
  pendingRelayChatFlushTimer = null;
}

function discardPendingRelayChatMessages(message = 'Rust+ relay chat queue was cleared') {
  clearRelayChatFlushTimer();
  pendingRelayChatMessages.clear();
  pendingRelayChatLatestReceivedAt = '';
  const error = Object.assign(new Error(message), { status: 503 });
  for (const waiters of pendingRelayChatFlushWaiters.values()) {
    for (const waiter of waiters) waiter.reject(error);
  }
  pendingRelayChatFlushWaiters.clear();
}

async function flushPendingRelayChatMessages() {
  clearRelayChatFlushTimer();
  if (pendingRelayChatFlushPromise) return pendingRelayChatFlushPromise;
  const messages = [...pendingRelayChatMessages.values()];
  const waiters = messages.flatMap((message) => pendingRelayChatFlushWaiters.get(message.id) || []);
  const latestReceivedAt = pendingRelayChatLatestReceivedAt;
  for (const message of messages) {
    pendingRelayChatMessages.delete(message.id);
    pendingRelayChatFlushWaiters.delete(message.id);
  }
  pendingRelayChatLatestReceivedAt = '';
  if (!messages.length) return null;
  pendingRelayChatFlushPromise = updateRustplusRelayRuntimeStore((store) => {
    const relay = ensureRustplusRelayStore(store);
    const settings = rustplusRelaySettings(store);
    for (const message of messages) {
      upsertRelayClient(relay, message.client, message.receivedAt || latestReceivedAt || nowIso());
      upsertRelayServer(relay, message.server, message.client, message.receivedAt || latestReceivedAt || nowIso());
    }
    insertChatMessages(relay, messages);
    settings.lastReceivedAt = latestReceivedAt || settings.lastReceivedAt || nowIso();
    settings.lastError = '';
    return publicRustplusRelayState(store);
  }, 'rustplus_relay_chat_flush').then((relayState) => {
    lastRustplusRelayPublicState = relayState;
    broadcastRustplusRelayUpdate({
      event: {
        type: 'clan_chat_batch',
        receivedAt: latestReceivedAt || nowIso(),
        inserted: messages.length,
        chatMessageIds: messages.map((message) => message.id).filter(Boolean)
      },
      relay: relayState
    });
    for (const waiter of waiters) waiter.resolve(relayState);
    return relayState;
  }).catch((error) => {
    for (const waiter of waiters) waiter.reject(error);
    throw error;
  }).finally(() => {
    pendingRelayChatFlushPromise = null;
    if (pendingRelayChatMessages.size) {
      scheduleRelayChatFlush();
    }
  });
  return pendingRelayChatFlushPromise;
}

function scheduleRelayChatFlush() {
  if (pendingRelayChatFlushTimer || pendingRelayChatFlushPromise) return null;
  if (RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS <= 0) {
    return flushPendingRelayChatMessages();
  }
  pendingRelayChatFlushTimer = setTimeout(() => {
    flushPendingRelayChatMessages().catch(() => {});
  }, RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS);
  pendingRelayChatFlushTimer.unref?.();
  return null;
}

function queueRelayChatMessage(normalized = {}, receivedAt = '') {
  const record = relayChatStorageRecord(normalized);
  if (!record.id) return null;
  pendingRelayChatMessages.set(record.id, record);
  pendingRelayChatLatestReceivedAt = latestIsoTimestamp(pendingRelayChatLatestReceivedAt, receivedAt) || receivedAt || pendingRelayChatLatestReceivedAt;
  const persisted = new Promise((resolve, reject) => {
    const waiters = pendingRelayChatFlushWaiters.get(record.id) || [];
    waiters.push({ resolve, reject });
    pendingRelayChatFlushWaiters.set(record.id, waiters);
  });
  const scheduledFlush = scheduleRelayChatFlush();
  scheduledFlush?.catch(() => {});
  return persisted;
}

function skippedRelayPayload(normalized = {}, receivedAt = '', reason = '') {
  return {
    event: {
      type: normalized.type,
      clientId: normalized.client?.id || '',
      serverKey: normalized.server?.key || '',
      receivedAt,
      skipped: true,
      skipReason: reason || undefined,
      inserted: ['clan_chat_message', 'clan_invite_record'].includes(normalized.type) ? false : undefined,
      chatMessageId: normalized.type === 'clan_chat_message' ? normalized.id : undefined,
      inviteRecordId: normalized.type === 'clan_invite_record' ? normalized.id : undefined
    },
    relay: lastRustplusRelayPublicState
  };
}

function relaySnapshotFreshnessIso(normalized = {}, receivedAt = '') {
  return latestIsoTimestamp(normalized.capturedAt, receivedAt) || normalizeIsoTimestamp(receivedAt || '', nowIso());
}

function relaySnapshotFreshnessNeedsTouch(store = {}, normalized = {}, receivedAt = '') {
  const relay = store.rustplusRelay || {};
  const serverKey = normalized.server?.key || '';
  const server = (Array.isArray(relay.servers) ? relay.servers : []).find((item) => item?.key === serverKey);
  if (!server) return true;
  const incomingMs = Date.parse(relaySnapshotFreshnessIso(normalized, receivedAt) || '') || 0;
  const currentMs = Date.parse(server.lastSnapshotAt || server.snapshot?.capturedAt || '') || 0;
  if (!currentMs || !incomingMs) return true;
  return incomingMs - currentMs >= RUSTPLUS_RELAY_SNAPSHOT_WRITE_MIN_INTERVAL_MS;
}

async function touchUnchangedRelaySnapshot(normalized = {}, receivedAt = '', reason = 'unchanged_snapshot') {
  const existingStore = await readRustplusRelayRuntimeStore();
  if (!relaySnapshotFreshnessNeedsTouch(existingStore, normalized, receivedAt) && lastRustplusRelayPublicState) {
    return skippedRelayPayload(normalized, receivedAt, reason);
  }

  const relayState = await updateRustplusRelayRuntimeStore((store) => {
    const relay = ensureRustplusRelayStore(store);
    const settings = rustplusRelaySettings(store);
    upsertRelayClient(relay, normalized.client, receivedAt);
    const server = upsertRelayServer(relay, normalized.server, normalized.client, receivedAt);
    const freshnessAt = relaySnapshotFreshnessIso(normalized, receivedAt);
    if (server.snapshot) {
      server.snapshot.capturedAt = latestIsoTimestamp(server.snapshot.capturedAt, normalized.capturedAt) || server.snapshot.capturedAt || normalized.capturedAt || freshnessAt;
      refreshRelaySnapshotSummary(server.snapshot);
    } else {
      server.snapshot = {
        type: normalized.type,
        capturedAt: normalized.capturedAt || freshnessAt,
        clan: normalized.clan,
        members: normalized.members,
        invites: normalized.invites,
        summary: normalized.summary
      };
    }
    server.lastSnapshotAt = freshnessAt;
    settings.lastReceivedAt = receivedAt;
    settings.lastError = '';
    return publicRustplusRelayState(store);
  }, 'rustplus_relay_unchanged_snapshot_touch');
  lastRustplusRelayPublicState = relayState;
  const payload = {
    event: {
      type: normalized.type,
      clientId: normalized.client?.id || '',
      serverKey: normalized.server?.key || '',
      receivedAt,
      skipped: true,
      skipReason: reason,
      touched: true
    },
    relay: relayState
  };
  broadcastRustplusRelayUpdate(payload);
  queueRustplusRelaySteamProfileBackfill(relayState);
  return payload;
}

function memberDeltaKey(member = {}) {
  return member.steamId || normalizeRelayText(member.displayName || '', 120).toLowerCase();
}

function refreshRelaySnapshotSummary(snapshot = {}) {
  const members = Array.isArray(snapshot.members) ? snapshot.members : [];
  const invites = Array.isArray(snapshot.invites) ? snapshot.invites : [];
  const onlineCount = members.filter((member) => member.online).length;
  snapshot.summary = {
    ...(snapshot.summary || {}),
    memberCount: members.length,
    onlineCount,
    offlineCount: Math.max(0, members.length - onlineCount),
    inviteCount: invites.length
  };
}

function ensureRelayServerSnapshot(server = {}, normalized = {}, receivedAt = '') {
  const snapshot = server.snapshot || {};
  snapshot.type = 'clan_snapshot';
  snapshot.capturedAt = normalized.occurredAt || snapshot.capturedAt || receivedAt;
  snapshot.clan ||= { id: '', name: '', memberLimit: 40, announcement: '' };
  snapshot.members = Array.isArray(snapshot.members) ? snapshot.members : [];
  snapshot.invites = Array.isArray(snapshot.invites) ? snapshot.invites : [];
  refreshRelaySnapshotSummary(snapshot);
  server.snapshot = snapshot;
  return snapshot;
}

function mergeRelayMemberDelta(existing = {}, incoming = {}) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'online') {
      merged.online = Boolean(value);
      continue;
    }
    if (key === 'onlineTimeMinutes') {
      if (Number.isFinite(Number(value))) merged.onlineTimeMinutes = value;
      continue;
    }
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

function applyRelayMemberDelta(server, normalized, receivedAt) {
  const snapshot = ensureRelayServerSnapshot(server, normalized, receivedAt);
  const key = memberDeltaKey(normalized.member);
  if (!key) return false;
  const index = snapshot.members.findIndex((member) => memberDeltaKey(member) === key);
  if (normalized.type === 'member_left') {
    if (index < 0) return false;
    snapshot.members.splice(index, 1);
    snapshot.capturedAt = normalized.occurredAt || receivedAt;
    refreshRelaySnapshotSummary(snapshot);
    server.lastSnapshotAt = snapshot.capturedAt;
    return true;
  }
  const existing = index >= 0 ? snapshot.members[index] : {};
  const beforeSignature = index >= 0 ? relayMemberStoredSignature(existing) : '';
  const next = mergeRelayMemberDelta(existing, normalized.member);
  if (normalized.type === 'member_online') {
    next.online = true;
    next.lastSeenAt = normalized.member?.lastSeenAt || normalized.occurredAt || next.lastSeenAt || receivedAt;
    next.lastOnlineAt = normalized.member?.lastOnlineAt || normalized.occurredAt || next.lastOnlineAt || receivedAt;
    next.lastOfflineAt = '';
  } else if (normalized.type === 'member_offline') {
    next.online = false;
    next.lastSeenAt = normalized.occurredAt || next.lastSeenAt || receivedAt;
    next.lastOfflineAt = normalized.occurredAt || next.lastOfflineAt || receivedAt;
  } else if (normalized.type === 'member_joined') {
    next.joinedAt = next.joinedAt || normalized.occurredAt || receivedAt;
  }
  if (index >= 0 && beforeSignature === relayMemberStoredSignature(next)) {
    return false;
  }
  if (index >= 0) {
    snapshot.members[index] = next;
  } else {
    snapshot.members.unshift(next);
    snapshot.members = snapshot.members.slice(0, RUSTPLUS_RELAY_SNAPSHOT_MEMBER_LIMIT);
  }
  snapshot.capturedAt = normalized.occurredAt || receivedAt;
  refreshRelaySnapshotSummary(snapshot);
  server.lastSnapshotAt = snapshot.capturedAt;
  return true;
}

export async function ingestRustplusRelayPayload(input = {}) {
  const receivedAt = nowIso();
  const payloadBytes = estimateJsonByteLength(input);
  if (payloadBytes > RUSTPLUS_RELAY_MAX_PAYLOAD_BYTES) {
    throw Object.assign(new Error(`Rust+ relay payload exceeds ${RUSTPLUS_RELAY_MAX_PAYLOAD_BYTES} bytes.`), { status: 413 });
  }
  const normalized = normalizeRustplusRelayPayload(input, { receivedAt });
  await seedRelayWriteDedupeFromStore();
  const dedupeDecision = relayWriteDedupeDecision(normalized, receivedAt);
  if (dedupeDecision?.skipped && lastRustplusRelayPublicState) {
    if (dedupeDecision.pendingWrite) await dedupeDecision.pendingWrite;
    if (normalized.type === 'clan_snapshot') {
      const payload = await touchUnchangedRelaySnapshot(normalized, receivedAt, dedupeDecision.reason);
      rememberRelayWrite(dedupeDecision);
      return payload;
    }
    const payload = skippedRelayPayload(normalized, receivedAt, dedupeDecision.reason);
    queueRustplusRelaySteamProfileBackfill(payload.relay);
    return payload;
  }
  return persistRelayWrite(dedupeDecision, async () => {
    if (relayMemberDeltaTypesIncludes(normalized.type)) {
      const store = await readRustplusRelayRuntimeStore();
      if (!lastRustplusRelayPublicState) {
        lastRustplusRelayPublicState = publicRustplusRelayState(store);
      }
      if (!relayMemberDeltaWouldChangeStore(store, normalized)) {
        const payload = skippedRelayPayload(normalized, receivedAt, 'unchanged_member_delta');
        queueRustplusRelaySteamProfileBackfill(payload.relay);
        return payload;
      }
    }
    if (normalized.type === 'clan_chat_message') {
      await queueRelayChatMessage(normalized, receivedAt);
      const payload = {
        event: {
          type: normalized.type,
          clientId: normalized.client.id,
          serverKey: normalized.server.key,
          receivedAt,
          inserted: true,
          chatMessageId: normalized.id
        },
        relay: lastRustplusRelayPublicState,
        chatMessage: relayChatStorageRecord(normalized)
      };
      broadcastRustplusRelayUpdate(payload);
      return payload;
    }
    const relayState = await updateRustplusRelayRuntimeStore((store) => {
      const relay = ensureRustplusRelayStore(store);
      const settings = rustplusRelaySettings(store);
      upsertRelayClient(relay, normalized.client, receivedAt);
      const server = upsertRelayServer(relay, normalized.server, normalized.client, receivedAt);
      if (normalized.type === 'clan_snapshot') {
        server.snapshot = {
          type: normalized.type,
          capturedAt: normalized.capturedAt,
          clan: normalized.clan,
          members: normalized.members,
          invites: normalized.invites,
          summary: normalized.summary
        };
        server.lastSnapshotAt = normalized.capturedAt || receivedAt;
      } else if (normalized.type === 'clan_invite_record') {
        normalized.inserted = insertInviteRecord(relay, normalized);
      } else if (['member_online', 'member_offline', 'member_joined', 'member_left'].includes(normalized.type)) {
        normalized.applied = applyRelayMemberDelta(server, normalized, receivedAt);
      }
      settings.lastReceivedAt = receivedAt;
      settings.lastError = '';
      return publicRustplusRelayState(store);
    }, `rustplus_relay_${normalized.type || 'event'}`);
    lastRustplusRelayPublicState = relayState;
    const payload = {
      event: {
        type: normalized.type,
        clientId: normalized.client.id,
        serverKey: normalized.server.key,
        receivedAt,
        inserted: ['clan_chat_message', 'clan_invite_record'].includes(normalized.type) ? Boolean(normalized.inserted) : undefined,
        applied: ['member_online', 'member_offline', 'member_joined', 'member_left'].includes(normalized.type) ? Boolean(normalized.applied) : undefined,
        memberSteamId: normalized.member?.steamId || undefined,
        chatMessageId: normalized.type === 'clan_chat_message' ? normalized.id : undefined,
        inviteRecordId: normalized.type === 'clan_invite_record' ? normalized.id : undefined
      },
      relay: relayState
    };
    broadcastRustplusRelayUpdate(payload);
    queueRustplusRelaySteamProfileBackfill(relayState);
    return payload;
  });
}

function clearRustplusRelayRuntimeCache() {
  discardPendingRelayChatMessages('Rust+ relay runtime was reset before chat persistence completed');
  relayWriteDedupe.clear();
  relayWriteDedupeSeedPromise = null;
  lastRustplusRelayPublicState = null;
}

export async function clearRustplusRelayChatMessages() {
  const relayState = await updateRustplusRelayRuntimeStore((store) => {
    const relay = ensureRustplusRelayStore(store);
    relay.chatMessages = [];
    const settings = rustplusRelaySettings(store);
    settings.lastReceivedAt = settings.lastReceivedAt || '';
    return publicRustplusRelayState(store, { chatLimit: 0, includeInviteRecords: '0' });
  }, 'rustplus_relay_chat_clear');
  discardPendingRelayChatMessages('Rust+ relay chat records were cleared before persistence completed');
  lastRustplusRelayPublicState = relayState;
  broadcastRustplusRelayUpdate({
    event: {
      type: 'chat_records_cleared',
      receivedAt: nowIso()
    },
    relay: relayState
  });
  return relayState;
}

export async function resetRustplusRelayData() {
  const relayState = await updateRustplusRelayRuntimeStore((store) => {
    const relay = ensureRustplusRelayStore(store);
    relay.clients = [];
    relay.servers = [];
    relay.chatMessages = [];
    relay.inviteRecords = [];
    relay.steamProfiles = [];
    const settings = rustplusRelaySettings(store);
    settings.lastReceivedAt = '';
    settings.lastError = '';
    return publicRustplusRelayState(store, { chatLimit: 0, includeInviteRecords: '0' });
  }, 'rustplus_relay_data_reset');
  clearRustplusRelayRuntimeCache();
  lastRustplusRelayPublicState = relayState;
  broadcastRustplusRelayUpdate({
    event: {
      type: 'relay_data_reset',
      receivedAt: nowIso()
    },
    relay: relayState
  });
  return relayState;
}

export function recordRustplusRelayError(message) {
  const errorMessage = normalizeRelayText(message, 240);
  return updateRustplusRelaySettingsStore((store) => {
    const settings = rustplusRelaySettings(store);
    settings.lastError = errorMessage;
  }, 'rustplus_relay_error', { includeCounts: false });
}

function writeRelaySse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function openRustplusRelayEventStream(res, initialPayload, mapPayload = (payload) => payload) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  writeRelaySse(res, 'relay_state', initialPayload);
  const subscriber = (payload) => writeRelaySse(res, 'relay_update', mapPayload(payload));
  relaySubscribers.add(subscriber);
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25_000);
  heartbeat.unref?.();
  return () => {
    clearInterval(heartbeat);
    relaySubscribers.delete(subscriber);
    res.end();
  };
}

export function broadcastRustplusRelayUpdate(payload) {
  for (const subscriber of relaySubscribers) {
    try {
      subscriber(payload);
    } catch {
      relaySubscribers.delete(subscriber);
    }
  }
}

function discordChatLine(message = {}) {
  const text = normalizeRelayText(message.translatedMessage || message.message, 240);
  const name = normalizeRelayText(message.displayName || message.steamId || 'Unknown', 80);
  const time = discordTimestamp(message.sentAt) || discordTimestamp(message.receivedAt) || '—';
  return `${time} **${name}**: ${text || '-'}`;
}

export function buildRustplusRelayChatDiscordMessage(message = {}, relayState = {}) {
  const text = normalizeRelayText(message.translatedMessage || message.message, 2000) || '-';
  const name = normalizeRelayText(message.displayName || message.steamId || 'Unknown', 80);
  const time = discordTimestamp(message.sentAt) || discordTimestamp(message.receivedAt) || discordTimestamp(nowIso());
  return {
    allowed_mentions: { parse: [] },
    content: `${time}\n${name}：${text}\n${RUSTPLUS_RELAY_DISCORD_CHAT_SEPARATOR}`.slice(0, 2000)
  };
}

export function buildRustplusRelayDiscordMessage(relayState = {}, options = {}) {
  const server = relayState.server || {};
  const summary = relayState.summary || {};
  const chatMessages = (relayState.chatMessages || []).slice(0, RUSTPLUS_RELAY_DISCORD_CHAT_LIMIT);
  const chatDescription = chatMessages.length
    ? chatMessages.map(discordChatLine).join('\n').slice(0, 3800)
    : 'No recent clan chat messages.';
  const title = normalizeRelayText(options.title, 120) || `Rust+ Relay - ${server.name || relayState.selected?.serverName || 'Server'}`;
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title,
        description: chatDescription,
        color: 0x2563eb,
        fields: [
          {
            name: 'Source',
            value: [
              `Client: ${server.clientName || relayState.selected?.clientId || '-'}`,
              `Server: ${server.name || relayState.selected?.serverName || '-'}`
            ].join('\n'),
            inline: true
          },
          {
            name: 'Status',
            value: [
              `Members: ${summary.memberCount || 0}`,
              `Online: ${summary.onlineCount || 0}`,
              `Offline: ${summary.offlineCount || 0}`,
              `Invites: ${summary.inviteCount || 0}`
            ].join('\n'),
            inline: true
          }
        ],
        timestamp: nowIso()
      }
    ]
  };
}

export async function markRustplusRelayDiscordPush(result = {}, error = null) {
  return updateRustplusRelaySettingsStore((store) => {
    const settings = rustplusRelaySettings(store);
    if (error) {
      settings.lastDiscordPushError = normalizeRelayText(error.message || error, 240);
      return rustplusRelaySettingsPayload(store);
    }
    settings.lastDiscordPushAt = nowIso();
    settings.lastDiscordPushError = '';
    settings.lastDiscordMessageId = normalizeRelayText(result?.id, 80);
    return rustplusRelaySettingsPayload(store);
  }, 'rustplus_relay_discord_push_mark');
}

export async function markRustplusRelayDiscordForward(result = {}, error = null, routeId = '') {
  return updateRustplusRelaySettingsStore((store) => {
    const settings = rustplusRelaySettings(store);
    const forwarding = settings.discordForwarding;
    const route = routeId && Array.isArray(forwarding.routes)
      ? forwarding.routes.find((item) => item.id === routeId || item.serverKey === routeId)
      : null;
    if (error) {
      forwarding.lastForwardError = normalizeRelayText(error.message || error, 240);
      if (route) route.lastForwardError = forwarding.lastForwardError;
      return rustplusRelaySettingsPayload(store);
    }
    forwarding.lastForwardedAt = nowIso();
    forwarding.lastForwardError = '';
    forwarding.lastForwardMessageId = normalizeRelayText(result?.id, 80);
    if (route) {
      route.lastForwardedAt = forwarding.lastForwardedAt;
      route.lastForwardError = '';
      route.lastForwardMessageId = forwarding.lastForwardMessageId;
    }
    return rustplusRelaySettingsPayload(store);
  }, 'rustplus_relay_discord_forward_mark');
}
