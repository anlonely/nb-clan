import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { normalizePermissionRoles } from './permissions.js';
import { ensureSqliteStore, readStoreFromSqlite, sqliteRepositoryStatus, writeSqliteStoreMirror, writeSqliteStorePatch } from './storage/repository.js';
import {
  secureSqliteFilePermissions,
  sqliteEnabled,
  sqliteFilePath,
  sqlitePrimaryMode,
  storageMode
} from './storage/sqlite.js';

const scryptAsync = promisify(crypto.scrypt);
const SECURE_DIRECTORY_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

process.umask(0o077);

export const DATA_DIR = process.env.NB_DATA_DIR || path.join(process.cwd(), 'data');
export const STORE_FILE = path.join(DATA_DIR, 'store.json');
export const ROOT_CREDENTIALS_FILE = path.join(DATA_DIR, 'root-credentials.txt');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session-secret.txt');

let writeQueue = Promise.resolve();
let storeCache = null;
let storeCacheSignature = '';
let writeQueuePending = 0;
let writeQueueRunning = 0;
let dataDirPromise = null;
let dataPermissionsPromise = null;
let dataDirVerifiedAt = 0;

const RUSTPLUS_RELAY_COLLECTIONS_READY_KEY = 'rustplusRelayCollectionsReady';
const RUSTPLUS_RELAY_COLLECTIONS = {
  clients: 'rustplusRelayClients',
  servers: 'rustplusRelayServers',
  chatMessages: 'rustplusRelayChatMessages',
  inviteRecords: 'rustplusRelayInviteRecords',
  steamProfiles: 'rustplusRelaySteamProfiles'
};
const RUSTPLUS_RELAY_ARRAY_KEYS = new Set(Object.keys(RUSTPLUS_RELAY_COLLECTIONS));
const RUSTPLUS_RELAY_COLLECTION_NAMES = new Set(Object.values(RUSTPLUS_RELAY_COLLECTIONS));

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const STORE_TIMING_KEY_LIMIT = 200;
const DEFAULT_STORE_SLOW_READ_MS = 100;
const DEFAULT_STORE_SLOW_WRITE_MS = 250;
const DEFAULT_STORE_SLOW_CLONE_MS = 100;

const storeMetrics = {
  reads: createTimingBucket(),
  writes: createTimingBucket(),
  clones: createTimingBucket(),
  noOpWrites: 0,
  jsonWrites: 0,
  sqliteWrites: 0,
  queueDepth: 0,
  queuePending: 0,
  queueRunning: 0,
  lastError: ''
};

function updateWriteQueueMetrics() {
  storeMetrics.queuePending = writeQueuePending;
  storeMetrics.queueRunning = writeQueueRunning;
  storeMetrics.queueDepth = writeQueuePending + writeQueueRunning;
}

function createTimingBucket() {
  return {
    total: 0,
    slow: 0,
    totalMs: 0,
    maxMs: 0,
    last: null,
    recent: [],
    byName: {},
    byCaller: {}
  };
}

function timingNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function storeTimingSlowMs(name) {
  const key = String(name || '');
  if (key.includes('write')) {
    return timingNumber(process.env.NB_STORE_SLOW_WRITE_MS, DEFAULT_STORE_SLOW_WRITE_MS);
  }
  if (key.includes('clone')) {
    return timingNumber(process.env.NB_STORE_SLOW_CLONE_MS, DEFAULT_STORE_SLOW_CLONE_MS);
  }
  return timingNumber(process.env.NB_STORE_SLOW_READ_MS, DEFAULT_STORE_SLOW_READ_MS);
}

function timingAggregateKey(map, key) {
  const normalized = normalizeText(key, 240) || 'unknown';
  if (map[normalized] || Object.keys(map).length < STORE_TIMING_KEY_LIMIT) return normalized;
  return '__other__';
}

function recordTimingAggregate(map, key, elapsedMs, slow, details = {}) {
  const aggregateKey = timingAggregateKey(map, key);
  map[aggregateKey] ||= {
    total: 0,
    slow: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    lastAt: '',
    lastName: ''
  };
  const item = map[aggregateKey];
  item.total += 1;
  item.totalMs += elapsedMs;
  item.maxMs = Math.max(item.maxMs, elapsedMs);
  item.lastMs = elapsedMs;
  item.lastAt = nowIso();
  if (details.name) item.lastName = normalizeText(details.name, 120);
  if (slow) item.slow += 1;
}

function recordTiming(bucket, name, elapsedMs, details = {}) {
  const slow = elapsedMs >= storeTimingSlowMs(name);
  bucket.total += 1;
  bucket.totalMs += elapsedMs;
  bucket.maxMs = Math.max(bucket.maxMs, elapsedMs);
  if (slow) bucket.slow += 1;
  bucket.last = {
    name,
    ms: Number(elapsedMs.toFixed(3)),
    at: nowIso(),
    slow,
    ...details
  };
  bucket.recent.push(bucket.last);
  if (bucket.recent.length > 20) bucket.recent.shift();
  recordTimingAggregate(bucket.byName, name, elapsedMs, slow);
  if (details.caller) {
    recordTimingAggregate(bucket.byCaller, details.caller, elapsedMs, slow, { name });
  }
}

function updateStoreCaller() {
  const stack = new Error().stack || '';
  const frame = stack
    .split('\n')
    .slice(2)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .find((line) => line && !line.includes('/server/store.js') && !line.startsWith('node:internal'));
  return normalizeText(frame || 'unknown', 240);
}

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function normalizeText(value, maxLength = 200) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

export function generatePassword(length = 18) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return value;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  const [scheme, salt, storedHash] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !salt || !storedHash) return false;
  const key = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(storedHash, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

async function ensureDataDir() {
  const verifyIntervalMs = process.env.NODE_TEST_CONTEXT ? 0 : 60_000;
  if (dataDirPromise && Date.now() - dataDirVerifiedAt >= verifyIntervalMs) {
    try {
      await fs.access(DATA_DIR);
      dataDirVerifiedAt = Date.now();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      dataDirPromise = null;
      dataPermissionsPromise = null;
    }
  }
  if (!dataDirPromise) {
    dataDirPromise = (async () => {
      const normalizedDataDir = path.resolve(DATA_DIR);
      if (normalizedDataDir === path.parse(normalizedDataDir).root) {
        throw new Error('NB_DATA_DIR must not be the filesystem root');
      }
      await fs.mkdir(DATA_DIR, { recursive: true, mode: SECURE_DIRECTORY_MODE });
      await fs.chmod(DATA_DIR, SECURE_DIRECTORY_MODE);
      dataDirVerifiedAt = Date.now();
    })().catch((error) => {
      dataDirPromise = null;
      throw error;
    });
  }
  await dataDirPromise;
}

async function chmodIfExists(file, mode) {
  try {
    await fs.chmod(file, mode);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function secureBackupTree(target) {
  let entries;
  try {
    await fs.chmod(target, SECURE_DIRECTORY_MODE);
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await secureBackupTree(entryPath);
      continue;
    }
    if (entry.isFile()) await fs.chmod(entryPath, SECURE_FILE_MODE);
  }
}

async function ensureExistingDataPermissions() {
  if (!dataPermissionsPromise) {
    dataPermissionsPromise = Promise.all([
      chmodIfExists(STORE_FILE, SECURE_FILE_MODE),
      chmodIfExists(ROOT_CREDENTIALS_FILE, SECURE_FILE_MODE),
      chmodIfExists(SESSION_SECRET_FILE, SECURE_FILE_MODE),
      secureSqliteFilePermissions(sqliteFilePath()),
      secureBackupTree(path.join(DATA_DIR, 'backups'))
    ]).catch((error) => {
      dataPermissionsPromise = null;
      throw error;
    });
  }
  await dataPermissionsPromise;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function createEmptyStore(rootUser) {
  const createdAt = nowIso();
  return {
    version: 2,
    createdAt,
    updatedAt: createdAt,
    users: [rootUser],
    members: [],
    squads: [],
    squadMembers: [],
    wipes: [],
    wipeParticipants: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    wipeSettlements: [],
    discordAttendanceResponses: [],
    wechatUsers: [],
    wechatSessions: [],
    joinApplications: [],
    memberBindRequests: [],
    discordMemberApplications: [],
    wechatNotifications: [],
    uploads: [],
    logs: [],
    operationRuns: [],
    integrationEvents: [],
    integrationMessageRefs: [],
    sessions: [],
    permissionRoles: [],
    syncState: {},
    syncJobs: [],
    syncAutoRules: defaultSyncAutoRules(createdAt),
    accountAlertDismissals: [],
    rustplusRelay: {
      clients: [],
      servers: [],
      chatMessages: [],
      inviteRecords: [],
      steamProfiles: []
    },
    settings: {
      publicApi: {
        tokenHash: '',
        tokenUpdatedAt: ''
      },
      rustplusRelay: {
        tokenHash: '',
        tokenUpdatedAt: '',
        lastReceivedAt: '',
        lastError: '',
        lastDiscordPushAt: '',
        lastDiscordPushError: '',
        lastDiscordMessageId: '',
	        discordForwarding: {
	          enabled: false,
	          routes: [],
	          clientId: '',
          serverKey: '',
          serverId: '',
          serverName: '',
          targetId: '',
          targetName: '',
          guildId: '',
          channelId: '',
          updatedAt: '',
          lastForwardedAt: '',
          lastForwardError: '',
          lastForwardMessageId: ''
        }
      },
      battlemetrics: {
        apiKey: '',
        apiKeys: [],
        apiKeyUpdatedAt: '',
        lastSyncAt: '',
        lastSyncError: ''
      },
      steamWebApi: {
        apiKey: '',
        apiKeyUpdatedAt: ''
      },
      discord: {
        botToken: '',
        publicKey: '',
        guildId: '',
        channelId: '',
        targets: [],
        memberRegisterChannelId: '',
        memberReviewChannelId: '',
        mapChannelId: '',
        applicationId: '',
        commandHint: '/wipe',
        memberRegisterRoleId: '',
        memberManageRoleId: '',
        memberRegisterSquadName: '57',
        memberRegisterRoleSquadRules: [],
        templateTitle: '🚨 {serverName} WIPE 🚨',
        templateBody: 'A new wipe is almost here!',
        updatedAt: '',
        lastPushAt: '',
        lastPushError: '',
        lastMessageId: '',
        lastMemberRegisterPushAt: '',
        lastMemberRegisterMessageId: '',
        lastMapPushAt: '',
        lastMapMessageId: '',
        lastMapLanguage: '',
        lastCommandRegisterAt: '',
        lastCommandRegisterError: '',
        wipeAttendanceCommandId: ''
      },
      kook: {
        botToken: '',
        verifyToken: '',
        encryptKey: '',
        guildId: '',
        channelId: '',
        memberRegisterChannelId: '',
        kdaQueryChannelId: '',
        memberRankingChannelId: '',
        enabledCommandIds: [],
        updatedAt: '',
        lastPushAt: '',
        lastPushError: '',
        lastMemberRankingPushAt: '',
        lastMemberRankingMessageId: '',
        lastMemberRankingLanguage: '',
        lastMemberRankingMetric: '',
        lastMemberRankingRefreshAt: '',
        lastMemberRankingRefreshError: ''
      },
      discordKookBridge: {
        enabled: false,
        translationApiKey: '',
        translationApiKeyUpdatedAt: '',
        translationBaseUrl: '',
        translationModel: '',
        pollIntervalMs: 0,
        lastDiscordMessageId: '',
        lastKookMessageId: '',
        lastSyncAt: '',
        lastSyncError: '',
        lastForwardedAt: '',
        lastForwardedDiscordMessageId: '',
        lastForwardedKookMessageId: '',
        recentMessageIds: [],
        routes: []
      },
      wechat: {
        subscriptionTemplates: {
          joinReviewResult: '',
          adminJoinReview: '',
          wipeSignupStatus: '',
          wipeOpen: '',
          wipeReminder: ''
        }
      },
      thirdPartyLogin: {
        steam: {
          enabled: true,
          updatedAt: ''
        },
        discord: {
          enabled: false,
          updatedAt: ''
        },
        wechat: {
          enabled: false,
          updatedAt: ''
        }
      },
      vitalServers: {
        overrides: []
      },
      system: {
        proxy: {
          url: '',
          scope: 'global',
          updatedAt: ''
        },
        teamLogoUrl: '',
        teamLogoUpdatedAt: ''
      },
      accountRisk: {
        squadFilter: '',
        rules: [],
        configured: false
      }
    }
  };
}

function defaultSyncAutoRules(createdAt = nowIso()) {
  return [
    {
      id: 'auto_rule_kda_current_wipe',
      name: 'KDA 自动同步',
      type: 'kda',
      enabled: true,
      intervalMinutes: 60,
      scope: 'current_wipe',
      notes: '同步当前进行中档期的 KDA 数据',
      createdAt,
      updatedAt: createdAt
    },
    {
      id: 'auto_rule_battlemetrics_playtime',
      name: 'BM 在线时间自动同步',
      type: 'battlemetrics_playtime',
      enabled: true,
      intervalMinutes: 60,
      scope: 'current_wipe',
      notes: '同步当前参考档期成员的 BattleMetrics 在线时间',
      createdAt,
      updatedAt: createdAt
    },
    {
      id: 'auto_rule_member_profile',
      name: '成员资料自动同步',
      type: 'member_profile',
      enabled: true,
      intervalMinutes: 1440,
      scope: 'all_members',
      notes: '同步成员 Steam 资料、头像、游戏时长和库存公开状态',
      createdAt,
      updatedAt: createdAt
    }
  ];
}

export async function ensureStore() {
  await ensureDataDir();
  await ensureExistingDataPermissions();
  if (sqlitePrimaryMode() && storeCache) return;
  if (sqlitePrimaryMode()) {
    const sqliteStore = await readStoreFromSqlite();
    if (sqliteStore) {
      storeCache = normalizeStore(sqliteStore);
      storeCacheSignature = `sqlite:${storeCache.updatedAt || ''}`;
      return;
    }
  }
  if (await fileExists(STORE_FILE)) {
    if (sqliteEnabled() && !storeCache) {
      const raw = await fs.readFile(STORE_FILE, 'utf8');
      const store = normalizeStore(JSON.parse(raw));
      await ensureSqliteStore(store);
    }
    return;
  }

  const rootPassword = process.env.NB_ROOT_PASSWORD || generatePassword();
  const createdAt = nowIso();
  const rootUser = {
    id: 'user_root',
    username: 'root',
    role: 'admin',
    passwordHash: await hashPassword(rootPassword),
    boundSteamId: '',
    steamNickname: '',
    createdAt,
    updatedAt: createdAt,
    createdBy: 'system'
  };

  const store = createEmptyStore(rootUser);
  await fs.writeFile(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECURE_FILE_MODE
  });
  await ensureSqliteStore(store);

  const credentialText = [
    'NB Clan 成员查询系统 root 初始账号',
    `username=root`,
    `password=${rootPassword}`,
    `createdAt=${createdAt}`,
    '',
    'V2 所有者可在“系统 / 账号管理”中修改管理员密码；修改后需要重新登录。'
  ].join('\n');
  try {
    await fs.writeFile(ROOT_CREDENTIALS_FILE, credentialText, {
      encoding: 'utf8',
      flag: 'wx',
      mode: SECURE_FILE_MODE
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await chmodIfExists(ROOT_CREDENTIALS_FILE, SECURE_FILE_MODE);
}

function removeMuggleSpecialty(value) {
  const rawItems = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(rawItems
    .map((item) => String(item || '').trim())
    .filter((item) => item && item !== 'muggle'))];
}

function normalizeWipeParticipantStatus(value) {
  const raw = normalizeText(value, 40).toLowerCase() || 'on_time';
  if (raw === 'active') return 'on_time';
  if (raw === 'late' || raw === 'bench' || raw === 'left' || raw === 'unavailable') return 'join_16h';
  if (raw === 'skip' || raw === 'unsure') return 'not_attending';
  if (['on_time', 'join_8h', 'join_16h', 'not_attending'].includes(raw)) return raw;
  return raw;
}

function recordStoreNotAttendingMigration(store, { memberId = '', wipeId = '', at = nowIso() } = {}) {
  const member = (store.members || []).find((item) => item.id === memberId);
  if (!member || !wipeId) return;
  const history = Array.isArray(member.notAttendingHistory) ? member.notAttendingHistory : [];
  if (!history.some((item) => item?.wipeId === wipeId)) {
    member.notAttendingCount = Math.max(0, Number(member.notAttendingCount || 0)) + 1;
    history.unshift({ wipeId, at, source: 'migration' });
  }
  member.notAttendingHistory = history.slice(0, 20);
  member.lastNotAttendingAt ||= at;
  member.lastNotAttendingWipeId ||= wipeId;
}

function normalizeStore(store) {
  store.users ||= [];
  store.members ||= [];
  for (const member of store.members) {
    member.wechatUserId ||= '';
    member.specialty = removeMuggleSpecialty(member.specialty);
    member.vitalVipType ||= 'none';
    member.vitalVipPurchasedAt ||= '';
    member.vitalVipExpiresAt ||= '';
    member.rustinityVipType ||= 'none';
    member.rustinityVipPurchasedAt ||= '';
    member.rustinityVipExpiresAt ||= '';
    member.atlasVipType ||= 'none';
    member.atlasVipPurchasedAt ||= '';
    member.atlasVipExpiresAt ||= '';
    member.notAttendingCount = Math.max(0, Number(member.notAttendingCount || 0));
    member.lastNotAttendingAt ||= '';
    member.lastNotAttendingWipeId ||= '';
    member.notAttendingHistory = Array.isArray(member.notAttendingHistory) ? member.notAttendingHistory : [];
  }
  store.squads ||= [];
  store.squadMembers ||= [];
  store.wipes ||= [];
  store.wipeParticipants ||= [];
  const mutableWipeIds = new Set(store.wipes
    .filter((wipe) => wipe && wipe.status !== 'closed')
    .map((wipe) => wipe.id)
    .filter(Boolean));
  for (const participant of store.wipeParticipants) {
    participant.status = normalizeWipeParticipantStatus(participant.status);
    if (participant.status === 'not_attending' && mutableWipeIds.has(participant.wipeId)) {
      recordStoreNotAttendingMigration(store, {
        memberId: participant.memberId,
        wipeId: participant.wipeId,
        at: participant.updatedAt || participant.createdAt || nowIso()
      });
    }
  }
  store.kdaRows ||= [];
  store.kdaSnapshots ||= [];
  store.memberProfiles ||= [];
  store.wipeSettlements ||= [];
  store.discordAttendanceResponses ||= [];
  store.wechatUsers ||= [];
  store.wechatSessions ||= [];
  store.joinApplications ||= [];
  for (const application of store.joinApplications) {
    if (Object.hasOwn(application, 'specialty')) application.specialty = removeMuggleSpecialty(application.specialty);
    if (Object.hasOwn(application, 'specialties')) application.specialties = removeMuggleSpecialty(application.specialties);
  }
  store.memberBindRequests ||= [];
  store.discordMemberApplications ||= [];
  for (const application of store.discordMemberApplications) {
    if (Object.hasOwn(application, 'specialty')) application.specialty = removeMuggleSpecialty(application.specialty);
    if (Object.hasOwn(application, 'specialties')) application.specialties = removeMuggleSpecialty(application.specialties);
  }
  store.wechatNotifications ||= [];
  for (const user of store.wechatUsers) {
    user.subscriptionPreferences ||= {};
  }
  store.uploads ||= [];
  store.logs ||= [];
  store.operationRuns ||= [];
  store.integrationEvents ||= [];
  store.integrationMessageRefs ||= [];
  store.sessions ||= [];
  store.permissionRoles = normalizePermissionRoles(store.permissionRoles || [], nowIso());
  store.syncState ||= {};
  store.syncJobs ||= [];
  store.syncAutoRules ||= defaultSyncAutoRules(store.createdAt || nowIso());
  store.accountAlertDismissals ||= [];
  store.rustplusRelay ||= {};
  store.rustplusRelay.clients ||= [];
  store.rustplusRelay.servers ||= [];
  store.rustplusRelay.chatMessages ||= [];
  store.rustplusRelay.inviteRecords ||= [];
  store.rustplusRelay.steamProfiles ||= [];
  store.settings ||= {};
  store.settings.publicApi ||= {};
  store.settings.publicApi.tokenHash ||= '';
  store.settings.publicApi.tokenUpdatedAt ||= '';
  store.settings.rustplusRelay ||= {};
  store.settings.rustplusRelay.tokenHash ||= '';
  store.settings.rustplusRelay.tokenUpdatedAt ||= '';
  store.settings.rustplusRelay.lastReceivedAt ||= '';
  store.settings.rustplusRelay.lastError ||= '';
  store.settings.rustplusRelay.lastDiscordPushAt ||= '';
  store.settings.rustplusRelay.lastDiscordPushError ||= '';
  store.settings.rustplusRelay.lastDiscordMessageId ||= '';
  store.settings.rustplusRelay.discordForwarding ||= {};
  store.settings.rustplusRelay.discordForwarding.enabled = Boolean(store.settings.rustplusRelay.discordForwarding.enabled);
  store.settings.rustplusRelay.discordForwarding.clientId ||= '';
  store.settings.rustplusRelay.discordForwarding.serverKey ||= '';
  store.settings.rustplusRelay.discordForwarding.serverId ||= '';
  store.settings.rustplusRelay.discordForwarding.serverName ||= '';
  store.settings.rustplusRelay.discordForwarding.targetId ||= '';
  store.settings.rustplusRelay.discordForwarding.targetName ||= '';
  store.settings.rustplusRelay.discordForwarding.guildId ||= '';
  store.settings.rustplusRelay.discordForwarding.channelId ||= '';
  store.settings.rustplusRelay.discordForwarding.updatedAt ||= '';
  store.settings.rustplusRelay.discordForwarding.lastForwardedAt ||= '';
  store.settings.rustplusRelay.discordForwarding.lastForwardError ||= '';
  store.settings.rustplusRelay.discordForwarding.lastForwardMessageId ||= '';
  store.settings.battlemetrics ||= {};
  store.settings.battlemetrics.apiKey ||= '';
  store.settings.battlemetrics.apiKeys ||= [];
  store.settings.battlemetrics.apiKeyUpdatedAt ||= '';
  store.settings.battlemetrics.lastSyncAt ||= '';
  store.settings.battlemetrics.lastSyncError ||= '';
  store.settings.steamWebApi ||= {};
  store.settings.steamWebApi.apiKey ||= '';
  store.settings.steamWebApi.apiKeyUpdatedAt ||= '';
  store.settings.discord ||= {};
  store.settings.discord.botToken ||= '';
  store.settings.discord.publicKey ||= '';
  store.settings.discord.guildId ||= '';
  store.settings.discord.channelId ||= '';
  store.settings.discord.targets ||= [];
  store.settings.discord.memberRegisterChannelId ||= '';
  store.settings.discord.memberReviewChannelId ||= '';
  store.settings.discord.mapChannelId ||= '';
  store.settings.discord.kdaQueryChannelId ||= '';
  store.settings.discord.memberRankingChannelId ||= '';
  store.settings.discord.applicationId ||= '';
  store.settings.discord.memberRegisterRoleId ||= '';
  store.settings.discord.memberManageRoleId ||= '';
  store.settings.discord.memberRegisterSquadName ||= '57';
  store.settings.discord.memberRegisterRoleSquadRules ||= [];
  if (!store.settings.discord.commandHint || ['/开荒报名', '/wipe-attendance'].includes(store.settings.discord.commandHint)) {
    store.settings.discord.commandHint = '/wipe';
  }
  store.settings.discord.templateTitle ||= '🚨 {serverName} WIPE 🚨';
  store.settings.discord.templateBody ||= 'A new wipe is almost here!';
  store.settings.discord.updatedAt ||= '';
  store.settings.discord.lastPushAt ||= '';
  store.settings.discord.lastPushError ||= '';
  store.settings.discord.lastMessageId ||= '';
  store.settings.discord.lastMemberRegisterPushAt ||= '';
  store.settings.discord.lastMemberRegisterMessageId ||= '';
  store.settings.discord.lastMemberRankingPushAt ||= '';
  store.settings.discord.lastMemberRankingMessageId ||= '';
  store.settings.discord.lastMemberRankingRefreshAt ||= '';
  store.settings.discord.lastMemberRankingRefreshError ||= '';
  store.settings.discord.lastMapPushAt ||= '';
  store.settings.discord.lastMapMessageId ||= '';
  store.settings.discord.lastMapLanguage ||= '';
  store.settings.discord.lastCommandRegisterAt ||= '';
  store.settings.discord.lastCommandRegisterError ||= '';
  store.settings.discord.wipeAttendanceCommandId ||= '';
  store.settings.discord.kdaCommandId ||= '';
  store.settings.kook ||= {};
  store.settings.kook.botToken ||= '';
  store.settings.kook.verifyToken ||= '';
  store.settings.kook.encryptKey ||= '';
  store.settings.kook.guildId ||= '';
  store.settings.kook.channelId ||= '';
  store.settings.kook.memberRegisterChannelId ||= '';
  store.settings.kook.kdaQueryChannelId ||= '';
  store.settings.kook.memberRankingChannelId ||= '';
  store.settings.kook.updatedAt ||= '';
  store.settings.kook.lastPushAt ||= '';
  store.settings.kook.lastPushError ||= '';
  store.settings.kook.lastMemberRankingPushAt ||= '';
  store.settings.kook.lastMemberRankingMessageId ||= '';
  store.settings.kook.lastMemberRankingLanguage ||= '';
  store.settings.kook.lastMemberRankingMetric ||= '';
  store.settings.kook.lastMemberRankingRefreshAt ||= '';
  store.settings.kook.lastMemberRankingRefreshError ||= '';
  store.settings.discordKookBridge ||= {};
  store.settings.discordKookBridge.enabled = Boolean(store.settings.discordKookBridge.enabled);
  store.settings.discordKookBridge.translationApiKey ||= '';
  store.settings.discordKookBridge.translationApiKeyUpdatedAt ||= '';
  store.settings.discordKookBridge.translationBaseUrl ||= '';
  store.settings.discordKookBridge.translationModel ||= '';
  store.settings.discordKookBridge.pollIntervalMs = Number(store.settings.discordKookBridge.pollIntervalMs || 0);
  store.settings.discordKookBridge.lastDiscordMessageId ||= '';
  store.settings.discordKookBridge.lastKookMessageId ||= '';
  store.settings.discordKookBridge.lastSyncAt ||= '';
  store.settings.discordKookBridge.lastSyncError ||= '';
  store.settings.discordKookBridge.lastForwardedAt ||= '';
  store.settings.discordKookBridge.lastForwardedDiscordMessageId ||= '';
  store.settings.discordKookBridge.lastForwardedKookMessageId ||= '';
  store.settings.discordKookBridge.recentMessageIds ||= [];
  store.settings.discordKookBridge.routes ||= [];
  store.settings.wechat ||= {};
  store.settings.wechat.subscriptionTemplates ||= {};
  store.settings.wechat.subscriptionTemplates.joinReviewResult ||= '';
  store.settings.wechat.subscriptionTemplates.adminJoinReview ||= '';
  store.settings.wechat.subscriptionTemplates.wipeSignupStatus ||= '';
  store.settings.wechat.subscriptionTemplates.wipeOpen ||= '';
  store.settings.wechat.subscriptionTemplates.wipeReminder ||= '';
  store.settings.thirdPartyLogin ||= {};
  store.settings.thirdPartyLogin.steam ||= {};
  store.settings.thirdPartyLogin.steam.enabled ??= true;
  store.settings.thirdPartyLogin.steam.updatedAt ||= '';
  store.settings.thirdPartyLogin.discord ||= {};
  store.settings.thirdPartyLogin.discord.enabled ??= false;
  store.settings.thirdPartyLogin.discord.updatedAt ||= '';
  store.settings.thirdPartyLogin.wechat ||= {};
  store.settings.thirdPartyLogin.wechat.enabled ??= false;
  store.settings.thirdPartyLogin.wechat.updatedAt ||= '';
  store.settings.system ||= {};
  store.settings.system.proxy ||= {};
  store.settings.system.proxy.url ||= '';
  store.settings.system.proxy.scope ||= 'global';
  store.settings.system.proxy.updatedAt ||= '';
  store.settings.system.teamLogoUrl ||= '';
  store.settings.system.teamLogoUpdatedAt ||= '';
  store.settings.accountRisk ||= {};
  store.settings.accountRisk.squadFilter ||= '';
  store.settings.accountRisk.rules ||= [];
  store.settings.accountRisk.configured ||= false;
  store.version ||= 1;
  return store;
}

async function storeFileSignature() {
  const stat = await fs.stat(STORE_FILE);
  return `${stat.mtimeMs}:${stat.size}`;
}

async function loadStoreFromDisk() {
  if (sqlitePrimaryMode()) {
    const sqliteStore = await readStoreFromSqlite();
    if (sqliteStore) {
      storeCache = normalizeStore(sqliteStore);
      storeCacheSignature = `sqlite:${storeCache.updatedAt || ''}`;
      return storeCache;
    }
  }
  const raw = await fs.readFile(STORE_FILE, 'utf8');
  storeCache = normalizeStore(JSON.parse(raw));
  storeCacheSignature = await storeFileSignature();
  await ensureSqliteStore(storeCache);
  return storeCache;
}

function cloneStore(store, details = {}) {
  const start = performance.now();
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(store)
      : JSON.parse(JSON.stringify(store));
  } finally {
    recordTiming(storeMetrics.clones, 'clone_store', performance.now() - start, details);
  }
}

function semanticStoreSignature(store) {
  const { updatedAt, ...semanticStore } = store || {};
  return JSON.stringify(semanticStore);
}

function sqlitePatchSignature(value) {
  return JSON.stringify(value ?? null);
}

function rustplusRelayScalarValue(store = {}) {
  const relay = store.rustplusRelay;
  if (!relay || typeof relay !== 'object') return relay || {};
  return Object.fromEntries(
    Object.entries(relay).filter(([key]) => !RUSTPLUS_RELAY_ARRAY_KEYS.has(key))
  );
}

function sqliteScalarPatchValue(store, key) {
  if (key === 'rustplusRelay') return rustplusRelayScalarValue(store);
  return store?.[key] || {};
}

function sqliteRecordId(collection, item, index = 0) {
  if (!item || typeof item !== 'object') return '';
  if (item.id || item.key) return String(item.id || item.key);
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.servers && item.serverKey) return String(item.serverKey);
  if (collection === RUSTPLUS_RELAY_COLLECTIONS.steamProfiles && (item.steamId || item.steam_id)) {
    return String(item.steamId || item.steam_id);
  }
  return '';
}

function sqliteCollectionRecordsFromStore(store = {}) {
  const collections = {};
  for (const [key, value] of Object.entries(store || {})) {
    if (Array.isArray(value)) collections[key] = value;
  }
  const relay = store.rustplusRelay || {};
  for (const [key, collection] of Object.entries(RUSTPLUS_RELAY_COLLECTIONS)) {
    collections[collection] = Array.isArray(relay[key]) ? relay[key] : [];
  }
  return collections;
}

function sqliteCollectionNeedsReplace(collection, beforeRecords = [], afterRecords = []) {
  return [...beforeRecords, ...afterRecords].some((item, index) => !sqliteRecordId(collection, item, index));
}

function sqliteStorePatchFromDiff(previousStore = {}, nextStore = {}) {
  const beforeCollections = sqliteCollectionRecordsFromStore(previousStore);
  const afterCollections = sqliteCollectionRecordsFromStore(nextStore);
  const collectionNames = [...new Set([
    ...Object.keys(beforeCollections),
    ...Object.keys(afterCollections)
  ])];
  const upserts = {};
  const deletes = {};
  const replaces = {};
  const positions = {};
  let rustplusRelayCollectionChanged = false;

  for (const collection of collectionNames) {
    const beforeRecords = beforeCollections[collection] || [];
    const afterRecords = afterCollections[collection] || [];
    if (sqliteCollectionNeedsReplace(collection, beforeRecords, afterRecords)) {
      if (sqlitePatchSignature(beforeRecords) !== sqlitePatchSignature(afterRecords)) {
        replaces[collection] = afterRecords;
        if (RUSTPLUS_RELAY_COLLECTION_NAMES.has(collection)) rustplusRelayCollectionChanged = true;
      }
      continue;
    }

    const beforeMap = new Map(beforeRecords.map((item, index) => [
      sqliteRecordId(collection, item, index),
      sqlitePatchSignature(item)
    ]));
    const afterIds = new Set();
    afterRecords.forEach((item, index) => {
      const id = sqliteRecordId(collection, item, index);
      if (!id) return;
      afterIds.add(id);
      if (beforeMap.get(id) === sqlitePatchSignature(item)) return;
      upserts[collection] ||= [];
      upserts[collection].push(item);
      positions[collection] ||= {};
      positions[collection][id] = index;
      if (RUSTPLUS_RELAY_COLLECTION_NAMES.has(collection)) rustplusRelayCollectionChanged = true;
    });

    for (const id of beforeMap.keys()) {
      if (afterIds.has(id)) continue;
      deletes[collection] ||= [];
      deletes[collection].push(id);
      if (RUSTPLUS_RELAY_COLLECTION_NAMES.has(collection)) rustplusRelayCollectionChanged = true;
    }
  }

  const scalars = {};
  for (const key of ['settings', 'syncState', 'rustplusRelay']) {
    const beforeValue = sqliteScalarPatchValue(previousStore, key);
    const afterValue = sqliteScalarPatchValue(nextStore, key);
    if (sqlitePatchSignature(beforeValue) !== sqlitePatchSignature(afterValue)) {
      scalars[key] = afterValue;
    }
  }
  if (rustplusRelayCollectionChanged) {
    scalars[RUSTPLUS_RELAY_COLLECTIONS_READY_KEY] = {
      ready: true,
      updatedAt: nextStore.updatedAt || nowIso()
    };
  }

  return { upserts, deletes, replaces, positions, scalars };
}

function sqliteStorePatchHasChanges(patch = {}) {
  return ['upserts', 'deletes', 'replaces', 'scalars'].some((key) => (
    Object.values(patch[key] || {}).some((value) => (
      Array.isArray(value) ? value.length > 0 : value !== undefined
    ))
  ));
}

async function readStoreCache() {
  await ensureStore();
  if (storeCache) {
    if (sqlitePrimaryMode()) return storeCache;
    const signature = await storeFileSignature();
    if (signature === storeCacheSignature) return storeCache;
  }
  return loadStoreFromDisk();
}

export async function readStore() {
  const start = performance.now();
  const caller = updateStoreCaller();
  const timingDetails = { caller };
  try {
    return cloneStore(await readStoreCache(), timingDetails);
  } catch (error) {
    storeMetrics.lastError = error?.message || String(error);
    throw error;
  } finally {
    recordTiming(storeMetrics.reads, 'read_store', performance.now() - start, timingDetails);
  }
}

async function writeStore(store, previousSemanticSignature = '', options = {}) {
  const start = performance.now();
  const timingDetails = options.caller ? { caller: normalizeText(options.caller, 240) } : {};
  await ensureDataDir();
  normalizeStore(store);
  if (sqlitePrimaryMode()) {
    let patch = sqliteStorePatchFromDiff(options.previousStore || {}, store);
    if (!sqliteStorePatchHasChanges(patch)) {
      storeCache = store;
      storeCacheSignature ||= `sqlite:${store.updatedAt || ''}`;
      storeMetrics.noOpWrites += 1;
      recordTiming(storeMetrics.writes, 'write_store_noop', performance.now() - start, timingDetails);
      return false;
    }
    store.updatedAt = nowIso();
    patch = sqliteStorePatchFromDiff(options.previousStore || {}, store);
    await writeSqliteStorePatch({
      ...patch,
      reason: 'sqlite_primary_patch'
    });
    storeMetrics.sqliteWrites += 1;
    storeCache = store;
    storeCacheSignature = `sqlite:${store.updatedAt}`;
    recordTiming(storeMetrics.writes, 'write_store_sqlite_patch', performance.now() - start, timingDetails);
    return true;
  }
  if (previousSemanticSignature && semanticStoreSignature(store) === previousSemanticSignature) {
    storeCache = store;
    storeCacheSignature = await storeFileSignature();
    storeMetrics.noOpWrites += 1;
    recordTiming(storeMetrics.writes, 'write_store_noop', performance.now() - start, timingDetails);
    return false;
  }
  store.updatedAt = nowIso();
  const tempFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: 'utf8',
    mode: SECURE_FILE_MODE
  });
  await fs.rename(tempFile, STORE_FILE);
  storeMetrics.jsonWrites += 1;
  if (sqliteEnabled()) {
    await writeSqliteStoreMirror(store, { reason: 'json_store_write' });
    storeMetrics.sqliteWrites += 1;
  }
  storeCache = store;
  storeCacheSignature = await storeFileSignature();
  recordTiming(storeMetrics.writes, 'write_store_json', performance.now() - start, timingDetails);
  return true;
}

export function updateStore(mutator) {
  const caller = updateStoreCaller();
  return runStoreWriteTask(async () => {
    const cachedStore = await readStoreCache();
    const previousSemanticSignature = sqlitePrimaryMode() ? '' : semanticStoreSignature(cachedStore);
    const store = cloneStore(cachedStore, { caller });
    const result = await mutator(store);
    await writeStore(store, previousSemanticSignature, { caller, previousStore: cachedStore });
    return result;
  });
}

export function runStoreWriteTask(task) {
  writeQueuePending += 1;
  updateWriteQueueMetrics();
  const run = writeQueue.then(async () => {
    writeQueuePending = Math.max(0, writeQueuePending - 1);
    writeQueueRunning += 1;
    updateWriteQueueMetrics();
    try {
      return await task();
    } catch (error) {
      storeMetrics.lastError = error?.message || String(error);
      throw error;
    } finally {
      writeQueueRunning = Math.max(0, writeQueueRunning - 1);
      updateWriteQueueMetrics();
    }
  });
  writeQueue = run.catch(() => {});
  return run;
}

export async function drainStoreWrites() {
  await writeQueue;
}

export async function patchStoreCache(mutator, options = {}) {
  if (!sqlitePrimaryMode()) return null;
  if (!storeCache && !options.load) return null;
  const cachedStore = options.load ? await readStoreCache() : storeCache;
  if (!cachedStore) return null;
  const result = await mutator(cachedStore);
  normalizeStore(cachedStore);
  cachedStore.updatedAt = nowIso();
  storeCache = cachedStore;
  storeCacheSignature = `sqlite:${cachedStore.updatedAt}`;
  return result;
}

function publicTimingBucket(bucket) {
  const publicAggregate = (items = {}) => Object.fromEntries(
    Object.entries(items).map(([key, value]) => [
      key,
      {
        total: value.total,
        slow: value.slow,
        avgMs: value.total ? Number((value.totalMs / value.total).toFixed(3)) : 0,
        maxMs: Number(value.maxMs.toFixed(3)),
        lastMs: Number(value.lastMs.toFixed(3)),
        lastAt: value.lastAt || '',
        lastName: value.lastName || ''
      }
    ])
  );
  return {
    total: bucket.total,
    slow: bucket.slow,
    avgMs: bucket.total ? Number((bucket.totalMs / bucket.total).toFixed(3)) : 0,
    maxMs: Number(bucket.maxMs.toFixed(3)),
    last: bucket.last,
    recent: bucket.recent,
    byName: publicAggregate(bucket.byName),
    byCaller: publicAggregate(bucket.byCaller)
  };
}

async function safeStoreFileStatus() {
  try {
    const stat = await fs.stat(STORE_FILE);
    return {
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs
    };
  } catch {
    return {
      exists: false,
      sizeBytes: 0,
      mtimeMs: 0
    };
  }
}

export async function storeRuntimeStatus(options = {}) {
  const memory = process.memoryUsage();
  const eventLoop = {
    minMs: Number((eventLoopDelay.min / 1e6).toFixed(3)),
    maxMs: Number((eventLoopDelay.max / 1e6).toFixed(3)),
    meanMs: Number((eventLoopDelay.mean / 1e6).toFixed(3)),
    p95Ms: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(3)),
    p99Ms: Number((eventLoopDelay.percentile(99) / 1e6).toFixed(3))
  };
  return {
    mode: storageMode(),
    file: await safeStoreFileStatus(),
    cacheLoaded: Boolean(storeCache),
    metrics: {
      reads: publicTimingBucket(storeMetrics.reads),
      writes: publicTimingBucket(storeMetrics.writes),
      clones: publicTimingBucket(storeMetrics.clones),
      noOpWrites: storeMetrics.noOpWrites,
      jsonWrites: storeMetrics.jsonWrites,
      sqliteWrites: storeMetrics.sqliteWrites,
      queueDepth: storeMetrics.queueDepth,
      queuePending: storeMetrics.queuePending,
      queueRunning: storeMetrics.queueRunning,
      lastError: storeMetrics.lastError
    },
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers
    },
    eventLoop,
    sqlite: await sqliteRepositoryStatus({
      includeSummary: options.sqliteSummary !== false
    })
  };
}

export async function getSessionSecret() {
  await ensureDataDir();
  try {
    const value = await fs.readFile(SESSION_SECRET_FILE, 'utf8');
    if (value.trim().length >= 32) {
      await fs.chmod(SESSION_SECRET_FILE, SECURE_FILE_MODE);
      return value.trim();
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // Fall through and create a new secret.
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  try {
    await fs.writeFile(SESSION_SECRET_FILE, `${secret}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: SECURE_FILE_MODE
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const winner = (await fs.readFile(SESSION_SECRET_FILE, 'utf8')).trim();
    if (winner.length >= 32) {
      await fs.chmod(SESSION_SECRET_FILE, SECURE_FILE_MODE);
      return winner;
    }
    const tempFile = `${SESSION_SECRET_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempFile, `${secret}\n`, {
        encoding: 'utf8',
        mode: SECURE_FILE_MODE
      });
      await fs.rename(tempFile, SESSION_SECRET_FILE);
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => {});
    }
  }
  await fs.chmod(SESSION_SECRET_FILE, SECURE_FILE_MODE);
  return secret;
}
