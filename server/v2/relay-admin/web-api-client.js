import { need, RelayAdminError } from './model.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const clean = value => typeof value === 'string' ? value.trim() : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeRustgoConnection(input = {}) {
  for (const key of ['baseUrl', 'tenantId', 'apiKey']) need(input[key] === undefined || typeof input[key] === 'string', 'WEB_API_INVALID_CONNECTION');
  let baseUrl = clean(input.baseUrl);
  const tenantId = clean(input.tenantId), apiKey = clean(input.apiKey);
  need(!tenantId || identifier(tenantId), 'WEB_API_INVALID_TENANT');
  need(apiKey.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(apiKey), 'WEB_API_INVALID_KEY');
  if (baseUrl) {
    let url;
    try { url = new URL(baseUrl); } catch { throw new RelayAdminError('WEB_API_INVALID_URL'); }
    const host = url.hostname.toLowerCase(), loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
    need(url.protocol === 'https:' || url.protocol === 'http:' && loopback, 'WEB_API_HTTPS_REQUIRED');
    need(!url.username && !url.password && !url.search && !url.hash && baseUrl.length <= 1024 &&
      !['0.0.0.0', '[::]', 'metadata.google.internal'].includes(host) && !host.startsWith('169.254.') &&
      !/^\[(fe[89ab]|ff)/i.test(host) && !/%|\\/.test(url.pathname), 'WEB_API_INVALID_URL');
    let pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname) pathname = '/api/v1';
    else if (!pathname.endsWith('/v1')) pathname += '/v1';
    baseUrl = url.origin + pathname;
  }
  return { baseUrl, tenantId, apiKey };
}

// Fixed read-only paths, bounded responses and no redirects. Never return the
// upstream body/error text, which can contain credentials or private metadata.
export function createRustgoWebApiClient({ fetchImpl = globalThis.fetch, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, now = Date.now } = {}) {
  async function get(config, path, { signal } = {}) {
    const connection = normalizeRustgoConnection(config);
    need(connection.baseUrl && connection.apiKey, 'WEB_API_CONNECTION_REQUIRED');
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(connection.baseUrl + path, {
        method: 'GET', redirect: 'error', signal: requestSignal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${connection.apiKey}`,
          ...(connection.tenantId ? { 'X-Tenant-ID': connection.tenantId } : {}) }
      });
      if (!response.ok) {
        await response.body?.cancel?.();
        throw new RelayAdminError(({ 401: 'WEB_API_UNAUTHORIZED', 403: 'WEB_API_FORBIDDEN', 404: 'WEB_API_NOT_FOUND', 429: 'WEB_API_RATE_LIMITED' })[response.status] || 'WEB_API_UPSTREAM_ERROR', 502);
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel?.();
        throw new RelayAdminError('WEB_API_RESPONSE_TOO_LARGE', 502);
      }
      const reader = response.body?.getReader();
      need(reader, 'WEB_API_INVALID_RESPONSE', 502);
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          need(bytes <= maxBytes, 'WEB_API_RESPONSE_TOO_LARGE', 502);
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new RelayAdminError('WEB_API_INVALID_RESPONSE', 502); }
      need(object(data), 'WEB_API_INVALID_RESPONSE', 502);
      return data;
    } catch (error) {
      if (error instanceof RelayAdminError) throw error;
      throw new RelayAdminError(requestSignal.aborted ? 'WEB_API_REQUEST_ABORTED' : 'WEB_API_UNREACHABLE', 502);
    }
  }
  async function listServers(config, options) {
    const data = await get(config, '/dashboard/overview', options);
    need(Array.isArray(data.servers) && data.servers.length <= 500, 'WEB_API_INVALID_RESPONSE', 502);
    const items = data.servers.filter(row => row?.monitoring?.state === 'running').map(row => {
      const server = row.server;
      need(identifier(server?.id) && typeof server.name === 'string', 'WEB_API_INVALID_RESPONSE', 502);
      const targetVersion = row.monitoring.policy?.targetVersion;
      return { id: server.id, name: server.name.slice(0, 200), state: 'running',
        primaryPairingId: clean(row.monitoring.primaryPairingId),
        clanAvailable: row.monitoring.channels?.clan === 'healthy',
        targetVersion: Number.isSafeInteger(targetVersion) && targetVersion >= 0 ? targetVersion : null };
    });
    return { items, checkedAt: new Date(now()).toISOString() };
  }
  const serverPath = id => { need(identifier(id), 'WEB_API_INVALID_SERVER'); return `/servers/${encodeURIComponent(id)}`; };
  return {
    listServers,
    readClan(config, id, options) { return get(config, serverPath(id) + '/clan', options); },
    readInvites(config, id, { until, cursor, signal } = {}) {
      need(Number.isFinite(Date.parse(until)), 'WEB_API_INVALID_INVITE_WINDOW');
      const query = new URLSearchParams({ limit: '200', until, ...(cursor ? { cursor } : {}) });
      return get(config, serverPath(id) + '/clan/invites?' + query, { signal });
    },
    readChat(config, id, { from, until, cursor, signal } = {}) {
      need(Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(until)), 'WEB_API_INVALID_CHAT_WINDOW');
      const query = new URLSearchParams({ channel: 'clan', direction: 'inbound', limit: '200', from, until, ...(cursor ? { cursor } : {}) });
      return get(config, serverPath(id) + '/chat/messages?' + query, { signal });
    }
  };
}
