import { fixture as memberFixture } from '../v2-member-admin/fixtures.mjs';
import { MemberAdminService } from '../../../server/v2/member-admin/service.js';
import { createMemberManagementAdapters, createMemberContextInvalidator } from '../../../server/v2/management-adapters/members/index.js';
import { createMemberOutboxConsumer } from '../../../server/v2/management-runtime/member-outbox.js';
import { AuthContexts } from '../../../server/v2/identity/contexts.js';
import { MEMBER_GRANTS, grant } from '../../../server/v2/identity/permissions.js';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { MemberSpaceService } from '../../../server/v2/member-space/service.js';
import { StatsService } from '../../../server/v2/stats/service.js';
import { installStatsSchema } from '../../../server/v2/stats/repository.js';
import { createExportRenderer } from '../../../server/v2/stats/exports.js';
import { SyncCenterService } from '../../../server/v2/sync-center/service.js';
import { installSyncCenterSchema } from '../../../server/v2/sync-center/repository.js';
import { createSqliteSyncAuthority } from '../../../server/v2/sync-center/authority.js';
import { PlatformAdminService } from '../../../server/v2/platform-admin/service.js';
import { installPlatformAdminSchema } from '../../../server/v2/platform-admin/repository.js';
import { createPlatformHost } from '../../../server/v2/management-adapters/platforms/index.js';
import { createNotificationPlatforms } from '../../../server/v2/notification-platforms/platforms.js';
import { createIsolatedNotificationTransport } from '../../../server/v2/notification-platforms/isolated-transport.js';
import { createNotificationSystem, installNotificationSchema } from '../../../server/v2/notifications/index.js';
import { need } from '../../../server/v2/platform-admin/model.js';

export function fixture({ filename = ':memory:', options = {}, external = true, scopeContract = false } = {}) {
  const f = memberFixture(filename, { scopeContract }), { identity, db, ir, sr, now } = f;
  ir.put('accounts', { ...ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  installPlatformAdminSchema(db); installStatsSchema(db); installSyncCenterSchema(db); installNotificationSchema(db);
  const cache = {}, queueLog = []; let tail = Promise.resolve(), inQueue = false;
  const runStoreWriteTask = fn => {
    // Catch accidental reentry, including a source service owning this queue.
    // Async callers may legitimately enqueue while another task is awaiting;
    // the tests additionally use timeouts and inspect the queue call counts.
    queueLog.push('enqueue');
    const work = tail.then(async () => { inQueue = true; queueLog.push('enter'); try { return await fn(); } finally { inQueue = false; queueLog.push('leave'); } });
    tail = work.catch(() => {}); return work;
  };
  const patchStoreCache = fn => { need(inQueue, 'FIXTURE_CACHE_OUTSIDE_QUEUE', 503); fn(cache); };
  for (const id of ['member', 'leader']) {
    const a = ir.get('accounts', id);
    ir.put('accounts', { ...a, grants: [...a.grants, ...MEMBER_GRANTS,
      ...['signups.delegate', 'signups.read', 'wipes.read', 'sync.read', 'sync.manage'].map(cap => grant(cap, { type: 'squads', ids: ['s1'] }))] });
  }
  const scheduling = new SchedulingService(sr, identity, { now }), memberSpace = new MemberSpaceService(identity);
  sr.put('wipes', { id: 'host-wipe', title: '隔离测试档期', lifecycle: 'active', revision: 1, contentRevision: 1,
    signupOpensAt: new Date(now() - 3600000).toISOString(), signupWindow: 'open', timeZone: 'Asia/Shanghai', musterAt: new Date(now() + 3600000).toISOString(),
    signupClosesAt: new Date(now() + 7200000).toISOString(), serverProfileId: 'host-server', serverSnapshot: { name: '构造服务器' },
    audience: { squadIds: ['s1'], memberIds: [], includeUnassigned: false } });
  sr.put('wipes', { ...sr.get('wipes', 'host-wipe'), id: 'other-wipe', audience: { squadIds: ['s2'], memberIds: [], includeUnassigned: false } });
  const sync = new SyncCenterService({ identity, db, now, authority: createSqliteSyncAuthority({ identity, serializeWrite: runStoreWriteTask }) });
  let host, invalidatorBound = true;
  const authContexts = new AuthContexts({ now });
  const contexts = createMemberContextInvalidator({ authContexts, invalidatePlatformSessions: event => {
    need(host && invalidatorBound, 'PLATFORM_INVALIDATOR_BINDING_REQUIRED', 503); host.invalidatePlatformSessions(event);
  } });
  const memberBundle = createMemberManagementAdapters({ identity, contexts, syncService: sync,
    isTrustedRoot: actor => actor.id === 'root', runStoreWriteTask, patchStoreCache });
  const members = new MemberAdminService(identity, memberBundle.adapters);
  const outbox = createMemberOutboxConsumer({ identity, members, bundle: memberBundle, runWrite: runStoreWriteTask });
  const stats = new StatsService(identity, { now, renderExport: createExportRenderer(), providers: {
    official: async ({ steamId }) => ({ steamId, displayName: '构造来源响应', rows: [], fields: [] })
  } });
  const platformService = new PlatformAdminService({ identity, now });
  const transport = createIsolatedNotificationTransport({ now }), platforms = createNotificationPlatforms({ transport, now });
  const targets = () => ['discord', 'kook'].flatMap(platform => platformService.config(platform).targets.map(target =>
    ({ ...target, platform, runtimeMode: 'isolated', transportKey: `${platform}-isolated`, configurationRevision: 1 })));
  const catalog = { listTargets: targets, getTarget: id => targets().find(t => t.id === id),
    listOptions: kind => ({ items: kind === 'servers' ? [{ id: 'host-server', label: '构造服务器', serverSnapshot: { name: '构造服务器' } }] : [], nextCursor: null }) };
  const notification = createNotificationSystem({ identity, scheduling, catalog, templates: [], renderer: () => ({}), platforms,
    publicOrigin: 'http://127.0.0.1', now, options: { runtimeMode: 'isolated' } });
  const proofCodes = new Map(), sourcePages = new Map(), externalCalls = [];
  for (const id of ['admin', 'member', 'leader', 'other']) {
    ir.put('identities', { id: `host-wx-${id}`, provider: 'wechat:host_app', externalId: `openid-${id}`, accountId: id, revision: 1, verifiedAt: new Date(now()).toISOString() });
  }
  const params = { identity, scheduling, memberSpace, members, memberBundle, stats, sync, platformService, runStoreWriteTask, patchStoreCache,
    replayMemberOutbox: () => outbox.drain(), assertInvalidationReady: () => invalidatorBound && Boolean(host), now,
    notifications: notification.service, executeStatsJob: id => stats.runJob(id),
    wechat: { appId: 'host_app', legacyAppId: options.legacyWechatAppId, readConfig: () => platformService.config('wechat'), evidenceLevel: 'isolated',
      ...(external ? { exchangeCode: async ({ code, appId }) => { need(!inQueue, 'FIXTURE_EXTERNAL_INSIDE_QUEUE', 503);
        externalCalls.push('exchange'); const id = proofCodes.get(code); need(id, 'MINI_AUTH_INVALID', 401);
        return { appId, openid: `openid-${id}`, verified: true }; } } : {}) },
    ...(external ? { g06: { platforms, targets }, forwarding: { source: {
      read: async ({ platform, channelId }) => { externalCalls.push('source'); return sourcePages.get(`${platform}:${channelId}`) || { verified: true, items: [], nextCursor: null }; },
      reset: async () => ({ reference: 'isolated-reset' }) } } } : {}), ...options };
  host = createPlatformHost(params);
  function config() {
    platformService.save(f.actor('admin'), 'wechat', { expectedRevision: 0, config: { enabled: true, appId: 'host_app', minClientVersion: 1 } }, { operationId: 'host-config-wechat' });
    for (const platform of ['discord', 'kook']) platformService.save(f.actor('admin'), platform,
      { expectedRevision: 0, config: { enabled: true, targets: [{ id: `${platform}-target`, name: '隔离频道', guildId: '100000000000000001', channelId: platform === 'discord' ? '200000000000000001' : '200000000000000002', enabled: true, enabledCommandIds: ['vip', 'map', 'ranking'] }], commands: [] } },
      { operationId: `host-config-${platform}` });
    platformService.save(f.actor('admin'), 'bridge', { expectedRevision: 0, config: { enabled: true, routes: [{ id: 'route-one', name: '隔离转发', enabled: true,
      discordGuildId: '100000000000000001', kookGuildId: '100000000000000001', discordChannelId: '200000000000000001', kookChannelId: '200000000000000002', direction: 'discord_to_kook', translate: false, languages: ['zh'], includeAttachments: false }] } }, { operationId: 'host-config-bridge' });
  }
  let codeSequence = 0;
  return { ...f, ...params, host, contexts, authContexts, transport, externalCalls, sourcePages, proofCodes, queueLog, cache, outbox,
    async start() { await runStoreWriteTask(config); await host.start(); },
    async login(account = 'member') { const code = `code-${++codeSequence}`; proofCodes.set(code, account); return host.mini.login({ code }); },
    command: (token, command, input = {}, operationId = `host-operation-${++codeSequence}`) => host.mini.command({ token, operationId }, command, input),
    setInvalidatorBound: value => { invalidatorBound = value; },
    async close() { await host.stop(); await notification.worker.stop(); await tail; db.close(); }
  };
}
