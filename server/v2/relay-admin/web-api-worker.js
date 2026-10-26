import { createHash } from 'node:crypto';
import { createRustgoWebApiClient } from './web-api-client.js';
import { RelayAdminError, need } from './model.js';

export const rustgoSourceId = config => 'rustgo-web-' + createHash('sha256').update(JSON.stringify([config.baseUrl, config.tenantId || '', config.apiKey || ''])).digest('hex').slice(0, 20);
const iso = value => new Date(value).toISOString();
const millis = value => typeof value === 'string' ? Date.parse(value) : NaN;
const errorCode = error => /^WEB_API_[A-Z_]+$/.test(error?.errorCode) ? error.errorCode : 'WEB_API_SYNC_FAILED';
const enabled = config => Boolean(config.apiKey && config.baseUrl && config.serverIds?.length && (config.infoEnabled || config.chatEnabled));

/** A single process owner. Pagination checkpoints are persisted only after the
 * canonical relay store acknowledges all messages in that page. */
export function createRustgoWebApiWorker({ readConfig, readProgress, writeProgress, ingest, invalidateSource,
  client = createRustgoWebApiClient(), now = Date.now, intervalMs = 10000, maxPages = 5 } = {}) {
  let started = false, stopped = false, timer, active, controller;
  let status = { state: 'disabled', servers: [] };
  const check = config => {
    need(!stopped && readConfig().revision === config.revision, 'WEB_API_CONFIG_CHANGED', 409);
    return true;
  };
  const persist = async (progress, config) => { check(config); await writeProgress(structuredClone(progress), () => check(config)); };
  async function run() {
    const config = readConfig(), sourceId = rustgoSourceId(config);
    const previous = readProgress() || {};
    const progress = previous.sourceId === sourceId ? structuredClone(previous) : { sourceId, servers: {} };
    progress.servers ||= {};
    const guard = () => check(config);
    // Expire retained rosters when their source/selection/information switch changes.
    for (const [id, entry] of Object.entries(previous.servers || {})) {
      if (entry.infoActive && (previous.sourceId !== sourceId || !config.infoEnabled || !config.serverIds.includes(id))) {
        await invalidateSource(previous.sourceId, id, guard);
        if (previous.sourceId === sourceId) progress.servers[id].infoActive = false;
      }
    }
    for (const id of Object.keys(progress.servers)) if (!config.serverIds.includes(id)) delete progress.servers[id];
    if (!enabled(config)) {
      if (JSON.stringify(previous) !== JSON.stringify(progress)) await persist(progress, config);
      status = { state: 'disabled', servers: [] }; return;
    }
    controller = new AbortController();
    const signal = controller.signal, attempt = iso(now());
    status = { ...status, state: 'syncing', lastAttemptAt: attempt, errorCode: null };
    const listing = await client.listServers(config, { signal }); check(config);
    const available = new Map(listing.items.map(server => [server.id, server]));
    const results = [];
    for (const id of config.serverIds) {
      check(config);
      const server = available.get(id), entry = progress.servers[id] ||= {};
      const result = { id, name: server?.name || entry.name || id, state: 'idle' };
      if (server) entry.name = server.name;
      try {
        if (!server || !server.clanAvailable || server.targetVersion === null) {
          if (entry.infoActive) await invalidateSource(sourceId, id, guard);
          entry.infoActive = false;
          result.errorCode = server ? 'WEB_API_CLAN_UNAVAILABLE' : 'WEB_API_SERVER_NOT_RUNNING';
          result.state = 'unavailable'; results.push(result); continue;
        }
        const targetChanged = entry.targetVersion !== undefined && entry.targetVersion !== server.targetVersion;
        if (targetChanged && entry.infoActive) { await invalidateSource(sourceId, id, guard); entry.infoActive = false; }
        if (entry.targetVersion !== server.targetVersion) {
          entry.targetVersion = server.targetVersion;
          entry.since = null; entry.window = null;
          entry.inviteWindow = null;
          entry.targetStartedAt = targetChanged ? attempt : null;
        }
        const common = { clientId: sourceId, clientName: 'rust-go Web', serverId: id, serverName: server.name };
        const confirmSource = async () => {
          const latest = await client.listServers(config, { signal }); check(config);
          const current = latest.items.find(row => row.id === id);
          need(current?.clanAvailable && current.targetVersion === server.targetVersion &&
            current.primaryPairingId === server.primaryPairingId, 'WEB_API_SOURCE_CHANGED', 409);
        };
        if (config.infoEnabled) {
          const clan = await client.readClan(config, id, { signal }); check(config);
          const observed = millis(clan.observedAt), expiry = millis(clan.staleAfter);
          if (clan.state !== 'observed' || clan.rustServerId !== id || clan.channel !== 'clan' ||
            !Number.isFinite(observed) || observed > now() + 5000 || !Number.isFinite(expiry) || expiry <= now() ||
            !Array.isArray(clan.members) || clan.members.length > 500) {
            await invalidateSource(sourceId, id, guard); entry.infoActive = false;
            result.errorCode = 'WEB_API_CLAN_UNAVAILABLE'; result.state = 'unavailable';
            results.push(result); continue;
          } else {
            await confirmSource();
            await ingest({ ...common, type: 'clan_snapshot', capturedAt: clan.observedAt, expiresAt: clan.staleAfter,
              clanId: String(clan.clanId || ''), clanName: clan.name, announcement: clan.motd,
              memberLimit: clan.maxMemberCount, members: clan.members.map(member => ({
                steamId: member.steamId, displayName: member.name, avatar: member.avatarUrl, role: member.role,
                online: member.online === true, lastSeenAt: member.lastSeenAt, gameClanName: clan.name
              })) }, { assertCredentialsCurrent: guard });
            entry.infoActive = true; result.infoState = 'ok';
          }
          // Invitation history is sorted by invitation time, not update time.
          // Revisit older pages so a previous pending invitation can become accepted.
          entry.inviteWindow ||= { until: attempt, cursor: null };
          for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
            const window = entry.inviteWindow;
            const page = await client.readInvites(config, id, { ...window, signal }); check(config);
            need(Array.isArray(page.items) && page.items.length <= 200 && typeof page.hasMore === 'boolean', 'WEB_API_INVALID_RESPONSE', 502);
            if (page.hasMore) need(typeof page.nextCursor === 'string' && page.nextCursor.length <= 4096 && page.nextCursor && page.nextCursor !== window.cursor, 'WEB_API_INVALID_CURSOR', 502);
            await confirmSource();
            for (const invite of [...page.items].reverse()) {
              const firstSeen = millis(invite.firstSeenAt), sent = millis(invite.invitedAt),
                changed = millis(invite.updatedAt || invite.lastObservedAt), accepted = millis(invite.acceptedAt);
              need(typeof invite.id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(invite.id) &&
                /^\d{17}$/.test(invite.inviteeSteamId || '') &&
                ['pending', 'accepted'].includes(invite.status) && Number.isFinite(firstSeen) &&
                (!invite.invitedAt || Number.isFinite(sent)) && (!invite.acceptedAt || Number.isFinite(accepted)) &&
                Number.isFinite(changed), 'WEB_API_INVALID_RESPONSE', 502);
              if ((Number.isFinite(sent) ? sent : firstSeen) > millis(window.until) || changed > now() + 5000) continue;
              await ingest({ ...common, type: 'clan_invite_record', invite: {
                webApiInviteId: invite.id, inviterSteamId: invite.inviterSteamId, inviterName: invite.inviterName,
                inviteeSteamId: invite.inviteeSteamId, inviteeName: invite.inviteeName, status: invite.status,
                sentAt: invite.invitedAt || null, firstSeenAt: invite.firstSeenAt,
                acceptedAt: invite.acceptedAt || null, occurredAt: iso(changed)
              } }, { assertCredentialsCurrent: guard });
            }
            entry.inviteWindow = page.hasMore ? { ...window, cursor: page.nextCursor } : null;
            await persist(progress, config);
            if (!entry.inviteWindow) break;
          }
          result.inviteState = entry.inviteWindow ? 'syncing' : 'ok';
        }
        if (config.chatEnabled) {
          const baseline = Math.max(millis(config.chatStartAt) || 0, millis(config.serverActivatedAt?.[id]) || 0,
            millis(entry.targetStartedAt) || 0, millis(config.updatedAt) && !config.chatStartAt ? millis(config.updatedAt) : 0);
          need(baseline > 0, 'WEB_API_CHAT_BOUNDARY_REQUIRED');
          if (entry.chatBaseline !== baseline) { entry.chatBaseline = baseline; entry.since = iso(baseline); entry.window = null; }
          if (!entry.window) entry.window = { from: iso(Math.max(baseline, (millis(entry.since) || baseline) - 60000)), until: attempt, cursor: null };
          if (millis(entry.window.until) >= millis(entry.window.from)) {
            for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
              const window = entry.window;
              const page = await client.readChat(config, id, { ...window, signal }); check(config);
              need(Array.isArray(page.items) && page.items.length <= 200 && typeof page.hasMore === 'boolean', 'WEB_API_INVALID_RESPONSE', 502);
              if (page.hasMore) need(typeof page.nextCursor === 'string' && page.nextCursor.length <= 4096 && page.nextCursor && page.nextCursor !== window.cursor, 'WEB_API_INVALID_CURSOR', 502);
              await confirmSource();
              for (const message of [...page.items].reverse()) {
                const time = millis(message.messageTime);
                if (message.rustServerId !== id || message.channel !== 'clan' || message.direction !== 'inbound' ||
                  message.targetVersion !== server.targetVersion || !Number.isFinite(time) || time < millis(window.from) || time > millis(window.until)) continue;
                need(typeof message.id === 'string' && message.id && message.id.length <= 200 && typeof message.message === 'string', 'WEB_API_INVALID_RESPONSE', 502);
                await ingest({ ...common, type: 'clan_chat_message', messageId: message.id,
                  steamId: message.authorSteamId, displayName: message.authorName || message.authorSteamId || 'Rust 玩家',
                  message: message.message, sentAt: message.messageTime, channel: 'clan' }, { assertCredentialsCurrent: guard });
              }
              if (page.hasMore) entry.window.cursor = page.nextCursor;
              else { entry.since = window.until; entry.window = null; }
              await persist(progress, config);
              if (!entry.window) break;
            }
          } else entry.window = null;
          result.chatState = entry.window ? 'syncing' : 'ok';
        }
        if (!result.errorCode) { result.state = result.chatState === 'syncing' || result.inviteState === 'syncing' ? 'syncing' : 'ok'; result.lastSuccessAt = iso(now()); }
      } catch (error) {
        check(config);
        result.state = 'error'; result.errorCode = errorCode(error);
      }
      results.push(result);
    }
    await persist(progress, config);
    const failed = results.find(row => row.errorCode);
    status = { state: failed ? 'error' : results.some(row => row.state === 'syncing') ? 'syncing' : 'ok',
      lastAttemptAt: attempt, lastSuccessAt: failed ? status.lastSuccessAt : iso(now()),
      errorCode: failed?.errorCode || null, servers: results };
  }
  function tick() {
    if (active || stopped) return active || Promise.resolve();
    active = Promise.resolve().then(run).catch(error => {
      if (error?.errorCode !== 'WEB_API_CONFIG_CHANGED' && !stopped) status = { ...status, state: 'error', errorCode: errorCode(error) };
    }).finally(() => { active = null; controller = null; });
    return active;
  }
  function schedule() {
    if (stopped) return;
    const delay = status.errorCode === 'WEB_API_RATE_LIMITED' ? Math.max(intervalMs, 60000) : status.state === 'error' ? Math.max(intervalMs, 30000) : intervalMs;
    timer = setTimeout(() => { tick().finally(schedule); }, delay); timer.unref?.();
  }
  return {
    tick,
    start() { need(!started, 'WEB_API_ALREADY_STARTED', 503); started = true; tick().finally(schedule); },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await active; },
    status() { return structuredClone(status); }
  };
}
