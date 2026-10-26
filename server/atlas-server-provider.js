import dgram from 'node:dgram';

const ATLAS_SERVERS_URL = 'https://services.atlasrust.com/api/public/servers';
const ATLAS_CACHE_TTL_MS = 60_000;
const ATLAS_TIMEOUT_MS = 8_000;
const ATLAS_A2S_TIMEOUT_MS = 2_500;
const A2S_INFO_REQUEST = Buffer.from('\u00ff\u00ff\u00ff\u00ffTSource Engine Query\u0000', 'latin1');

let cachedCatalog = null;
let cacheExpiresAt = 0;
let inFlightRequest = null;
const currentWipeCache = new Map();
const currentWipeRequests = new Map();

function normalizedIso(value) {
  const milliseconds = Date.parse(value || '');
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '';
}

export function parseAtlasServerCatalog(payload = {}) {
  return (Array.isArray(payload?.servers) ? payload.servers : [])
    .map((server) => {
      const alias = String(server?.alias || '').trim().toLowerCase();
      if (!alias) return null;
      return {
        id: String(server.id || ''),
        name: String(server.name || '').trim(),
        alias,
        region: String(server.region || '').trim().toUpperCase(),
        nextWipeAt: normalizedIso(server?.map_voting?.wipe_timestamp)
      };
    })
    .filter(Boolean);
}

export async function fetchAtlasServerCatalog({ fresh = false, fetchImpl = fetch } = {}) {
  const now = Date.now();
  if (!fresh && cachedCatalog && cacheExpiresAt > now) return cachedCatalog;
  if (!fresh && inFlightRequest) return inFlightRequest;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ATLAS_TIMEOUT_MS);
    try {
      const response = await fetchImpl(ATLAS_SERVERS_URL, {
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          origin: 'https://atlasrust.com',
          referer: 'https://atlasrust.com/',
          'user-agent': 'Mozilla/5.0 (compatible; NB-Clan-Wipe-Schedule/1.0)'
        }
      });
      if (!response.ok) throw Object.assign(new Error(`Atlas servers HTTP ${response.status}`), { status: response.status });
      const catalog = parseAtlasServerCatalog(await response.json());
      if (!catalog.length) throw new Error('Atlas server catalog is empty');
      cachedCatalog = catalog;
      cacheExpiresAt = Date.now() + ATLAS_CACHE_TTL_MS;
      return catalog;
    } finally {
      clearTimeout(timeout);
      inFlightRequest = null;
    }
  })();

  inFlightRequest = request;
  return request;
}

export function atlasServerForPreset(server, catalog = []) {
  const alias = String(server?.atlasAlias || '').trim().toLowerCase();
  if (!alias) return null;
  const matched = (Array.isArray(catalog) ? catalog : []).find((entry) => entry.alias === alias) || null;
  if (!matched) return null;
  if (server.atlasId && matched.id !== String(server.atlasId)) return null;
  if (server.atlasRegion && matched.region !== String(server.atlasRegion).toUpperCase()) return null;
  return matched;
}

function a2sString(buffer, cursor) {
  const end = buffer.indexOf(0, cursor.offset);
  if (end < 0) throw new Error('Invalid A2S string');
  const value = buffer.toString('utf8', cursor.offset, end);
  cursor.offset = end + 1;
  return value;
}

function requireA2sBytes(buffer, cursor, count) {
  if (cursor.offset + count > buffer.length) throw new Error('Truncated A2S response');
}

export function parseAtlasA2SInfoResponse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readInt32LE(0) !== -1 || buffer[4] !== 0x49) {
    throw new Error('Invalid A2S_INFO response');
  }
  const cursor = { offset: 5 };
  requireA2sBytes(buffer, cursor, 1);
  const protocol = buffer[cursor.offset++];
  const name = a2sString(buffer, cursor);
  const map = a2sString(buffer, cursor);
  const folder = a2sString(buffer, cursor);
  const game = a2sString(buffer, cursor);
  requireA2sBytes(buffer, cursor, 7);
  const appId = buffer.readUInt16LE(cursor.offset);
  cursor.offset += 2;
  const players = buffer[cursor.offset++];
  const maxPlayers = buffer[cursor.offset++];
  cursor.offset += 5;
  const version = a2sString(buffer, cursor);
  let keywords = '', gameId;
  if (cursor.offset < buffer.length) {
    const extraDataFlags = buffer[cursor.offset++];
    if (extraDataFlags & 0x80) {
      requireA2sBytes(buffer, cursor, 2);
      cursor.offset += 2;
    }
    if (extraDataFlags & 0x10) {
      requireA2sBytes(buffer, cursor, 8);
      cursor.offset += 8;
    }
    if (extraDataFlags & 0x40) {
      requireA2sBytes(buffer, cursor, 2);
      cursor.offset += 2;
      a2sString(buffer, cursor);
    }
    if (extraDataFlags & 0x20) keywords = a2sString(buffer, cursor);
    if (extraDataFlags & 0x01) {
      requireA2sBytes(buffer, cursor, 8);
      gameId = Number(buffer.readBigUInt64LE(cursor.offset) & 0xffffffn);
      cursor.offset += 8;
    }
  }
  return { protocol, name, map, folder, game, appId, players, maxPlayers, version, keywords, ...(gameId === undefined ? {} : { gameId }) };
}

export function atlasCurrentWipeAtFromKeywords(keywords, now = new Date()) {
  const match = String(keywords || '').match(/(?:^|,)born(\d{9,13})(?=,|$)/);
  if (!match) return '';
  const numeric = Number(match[1]);
  const milliseconds = match[1].length >= 13 ? numeric : numeric * 1000;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const oldestAllowedMs = nowMs - 180 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds > nowMs + 5 * 60 * 1000 || milliseconds < oldestAllowedMs) return '';
  return new Date(milliseconds).toISOString();
}

function requestAtlasA2SInfo(host, port, timeoutMs = ATLAS_A2S_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let challenged = false;
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Atlas A2S query timed out')), timeoutMs);
    socket.once('error', (error) => finish(error));
    socket.on('message', (message) => {
      try {
        if (message.length < 5 || message.readInt32LE(0) !== -1) throw new Error('Unsupported split A2S response');
        if (message[4] === 0x41 && message.length >= 9 && !challenged) {
          challenged = true;
          socket.send(Buffer.concat([A2S_INFO_REQUEST, message.subarray(5, 9)]), port, host);
          return;
        }
        finish(null, message);
      } catch (error) {
        finish(error);
      }
    });
    socket.send(A2S_INFO_REQUEST, port, host, (error) => {
      if (error) finish(error);
    });
  });
}

export async function fetchAtlasServerCurrentWipe(server, { fresh = false } = {}) {
  const host = String(server?.atlasAlias || '').trim().toLowerCase();
  const port = Number(server?.atlasQueryPort || 0);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('Atlas A2S host and query port are required');
  }
  const key = `${host}:${port}`;
  const now = Date.now();
  const cached = currentWipeCache.get(key);
  if (!fresh && cached?.expiresAt > now) return cached.value;
  if (!fresh && currentWipeRequests.has(key)) return currentWipeRequests.get(key);

  const request = (async () => {
    try {
      const info = parseAtlasA2SInfoResponse(await requestAtlasA2SInfo(host, port));
      const observedAt = new Date().toISOString();
      const value = {
        currentWipeAt: atlasCurrentWipeAtFromKeywords(info.keywords, new Date(observedAt)),
        currentWipeSource: 'atlas_a2s',
        observedAt,
        serverName: info.name
      };
      if (!value.currentWipeAt) throw new Error('Atlas A2S response has no valid born timestamp');
      currentWipeCache.set(key, { value, expiresAt: Date.now() + ATLAS_CACHE_TTL_MS });
      return value;
    } finally {
      currentWipeRequests.delete(key);
    }
  })();
  currentWipeRequests.set(key, request);
  return request;
}
