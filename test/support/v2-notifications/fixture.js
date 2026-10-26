import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { CAPABILITIES, grant } from '../../../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { installNotificationSchema, createNotificationSystem } from '../../../server/v2/notifications/index.js';

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const fixtureHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const languages = ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'];
export const purposes = ['signup_open', 'reminder', 'schedule_changed', 'signup_closed', 'cancelled', 'result'];
export const fixtureTemplates = [{ id: 'wipe-notification', revision: 1, label: '隔离档期模板', languages, purposes }];

/** Pure C renderer substitute: intentionally labelled as a fixture payload, never a native platform card. */
export function fixtureRenderer(input) {
  const { snapshot, selection, mode } = input;
  const enabled = ['scheduled', 'active'].includes(snapshot.lifecycle) && snapshot.effectiveSignupWindow === 'open';
  const actions = input.actionRefs.map(ref => ({ label: ref.action, url: null, action: ref.action, disabled: !enabled }));
  actions.push({ label: '查看档期', url: snapshot.memberUrl, action: null, disabled: false });
  const rendered = {
    title: snapshot.title,
    body: `${snapshot.description}\n${snapshot.serverLabel}`,
    fields: [
      { label: '集合时间', value: snapshot.musterAt || '待确认' },
      { label: '报名截止', value: snapshot.signupClosesAt || '待确认' },
      { label: '统计快照', value: JSON.stringify(canonical(snapshot.counts)) }
    ],
    actions, footer: `${snapshot.evaluatedAt} · ${selection.language}`, countScope: snapshot.countScope
  };
  const payload = {
    fixtureProtocol: 'g06-parallel/1', platform: input.target.platform, mode,
    rendered: clone(rendered), actionRefs: clone(input.actionRefs),
    snapshot: clone(snapshot), selection: {
      language: selection.language, mentionMode: mode === 'edit' ? 'none' : selection.mentionMode,
      roleIds: mode === 'edit' ? [] : clone(selection.roleIds)
    }
  };
  return { rendered, payload, payloadHash: fixtureHash(payload), warnings: [] };
}

/** Controlled adapter driver. Presets use the frozen C adapter results, not real network responses. */
export function createFixtureTransport() {
  const calls = [], messages = new Map(), queues = new Map();
  let messageNumber = 0;
  const driver = {
    runtimeMode: 'isolated', calls, messages,
    enqueue(operation, ...outcomes) {
      const queue = queues.get(operation) || [];
      queue.push(...outcomes); queues.set(operation, queue); return driver;
    },
    clearCalls() { calls.length = 0; },
    messageRef(target, messageId = `fixture-message-${++messageNumber}`) {
      return { platform: target.platform, guildId: target.guildId, channelId: target.channelId, messageId, messageUrl: null };
    },
    saveMessage(target, payload, messageRef = driver.messageRef(target)) {
      messages.set(messageRef.messageId, { target: clone(target), payload: clone(payload), messageRef: clone(messageRef) });
      return clone(messageRef);
    },
    async perform(operation, args) {
      const call = {
        operation, target: clone(args.target), payload: args.payload ? clone(args.payload) : null,
        payloadHash: args.payloadHash ?? null, messageRef: args.messageRef ? clone(args.messageRef) : null,
        messageRefs: args.messageRefs ? clone(args.messageRefs) : [],
        attemptId: args.attemptId ?? null, operationKey: args.operationKey ?? null,
        // Keep AbortSignal by reference: fault tests must observe the worker's actual signal.
        context: { ...args.context }
      };
      calls.push(call);
      const targetQueue = queues.get(`${operation}:${args.target.id}`);
      const queue = targetQueue?.length ? targetQueue : queues.get(operation);
      if (queue?.length) {
        const preset = queue.shift();
        if (preset instanceof Error) throw preset;
        const result = typeof preset === 'function' ? await preset(call, driver) : clone(preset);
        if (operation === 'send' && result.outcome === 'sent') driver.saveMessage(args.target, args.payload, result.messageRef);
        if (operation === 'edit' && result.outcome === 'updated' && messages.has(args.messageRef.messageId)) {
          messages.get(args.messageRef.messageId).payload = clone(args.payload);
        }
        if (operation === 'delete' && ['updated', 'deleted'].includes(result.outcome)) messages.delete(args.messageRef.messageId);
        return result;
      }
      if (operation === 'send') return { outcome: 'sent', messageRef: driver.saveMessage(args.target, args.payload), providerRequestId: null };
      if (operation === 'edit') {
        const stored = messages.get(args.messageRef.messageId);
        if (!stored) return { outcome: 'deleted', errorCode: 'MESSAGE_DELETED' };
        stored.payload = clone(args.payload); return { outcome: 'updated', providerRequestId: null };
      }
      if (operation === 'delete') {
        return messages.delete(args.messageRef.messageId) ? { outcome: 'updated', providerRequestId: null }
          : { outcome: 'deleted', errorCode: 'MESSAGE_DELETED' };
      }
      return { outcome: 'unknown', errorCode: 'LOOKUP_UNSUPPORTED' };
    }
  };
  return driver;
}

export function createFixturePlatforms(transport) {
  return Object.fromEntries(['discord', 'kook'].map(platform => [platform, {
    send: args => transport.perform('send', args),
    edit: args => transport.perform('edit', args),
    remove: args => transport.perform('delete', args),
    lookup: args => transport.perform('lookup', args)
  }]));
}

function createCatalog(identity) {
  const targets = new Map(['discord', 'kook'].map(platform => {
    const target = {
      id: `${platform}-1`, platform, guildId: `fixture-${platform}`, channelId: `fixture-${platform}-channel`,
      label: `${platform} 隔离频道`, guildLabel: `${platform} 隔离服务器`, channelLabel: '档期通知',
      enabled: true, configurationRevision: 1, languages: clone(languages),
      roleOptions: [{ id: 'role-1', label: '一队' }, { id: 'role-2', label: '二队' }],
      capabilities: { preview: true, send: true, mentionRoles: true, mentionEveryone: true },
      runtimeMode: 'isolated', transportKey: `isolated-${platform}-fixture`
    };
    return [target.id, target];
  }));
  return {
    targets,
    listTargets: () => [...targets.values()].map(clone),
    getTarget: id => targets.has(id) ? clone(targets.get(id)) : null,
    setTarget(id, patch) { targets.set(id, { ...targets.get(id), ...clone(patch) }); },
    listOptions(kind, { q = '', limit = 20, cursor = null } = {}) {
      const rows = kind === 'servers' ? [{ id: 'server1', label: '隔离服务器', serverSnapshot: { name: '隔离服务器' }, serverScheduleSource: null }]
        : kind === 'squads' ? identity.repo.all('squads').map(s => ({ id: s.id, label: s.name || s.id }))
          : identity.repo.all('members').map(m => ({ id: m.id, label: m.displayName,
            squadIds: identity.repo.all('squadMembers').filter(s => s.memberId === m.id && !s.validTo).map(s => s.squadId) }));
      const filtered = rows.filter(row => row.label.includes(q)).sort((a, b) => a.id.localeCompare(b.id));
      const offset = cursor ? Math.max(0, filtered.findIndex(row => row.id === cursor) + 1) : 0;
      const items = filtered.slice(offset, offset + limit);
      return { items, nextCursor: filtered.length > offset + limit ? items.at(-1).id : null };
    }
  };
}

/** New isolated SQLite, explicit schemas, real G03/G04 services; no env, timers, sockets or credentials. */
export function createFixture(opts = {}) {
  if (opts.filename && opts.filename !== ':memory:' && existsSync(opts.filename)) {
    throw new Error('Notification fixture requires a new SQLite path');
  }
  const db = new DatabaseSync(opts.filename || ':memory:');
  installIdentitySchema(db); installSchedulingSchema(db);
  const ir = new IdentityRepository(db), sr = new SchedulingRepository(db);
  ir.setScalar('v2IdentityMigration', { sourceHash: 'isolated-notification-fixture', fixture: true });
  sr.setScalar('v2SchedulingMigration', { sourceHash: 'isolated-notification-fixture', fixture: true });
  installNotificationSchema(db);
  const clock = {
    now: opts.now ?? Date.parse('2030-09-08T10:00:00Z'),
    advance(ms) { this.now += ms; return this.now; },
    set(value) { this.now = typeof value === 'number' ? value : Date.parse(value); return this.now; }
  };
  const identity = fixtureIdentity(ir, { scopeContract: opts.scopeContract === true, now: () => clock.now });
  ir.put('squads', { id: 'sq1', name: '第一小队' }); ir.put('squads', { id: 'sq2', name: '第二小队' });
  for (const [id, squadId] of [['m1', 'sq1'], ['m2', 'sq1'], ['m3', 'sq2'], ['m4', null]]) {
    ir.put('members', { id, memberStatus: 'active', steamId: `fixture-steam-${id}`, displayName: `Private member ${id}` });
    if (squadId) ir.put('squadMembers', { id, memberId: id, squadId });
    ir.put('accounts', { id: `a-${id}`, memberId: id, status: 'active', revision: 1, permissionVersion: 1, grants: [] });
    ir.put('bindings', { id, memberId: id, accountId: `a-${id}`, steamId: `fixture-steam-${id}`, status: 'verified' });
  }
  ir.put('accounts', { id: 'admin', memberId: null, status: 'active',
    ...(opts.adminRole !== false ? { roleId: 'admin', adminAssignedByOwner: true } : {}), revision: 1, permissionVersion: 1,
    grants: CAPABILITIES.map(capability => grant(capability, { type: 'all' })) });
  ir.put('accounts', { id: 'limited', memberId: null, status: 'active', revision: 1, permissionVersion: 1, grants: [
    ...['wipes.read', 'signups.read', 'members.read', 'squads.read'].map(capability => grant(capability, { type: 'squads', ids: ['sq1'] })),
    ...['notifications.preview', 'notifications.send', 'notifications.reconcile'].map(capability => grant(capability, { type: 'platformTargets', ids: ['discord-1'] }))
  ] });
  const scheduling = new SchedulingService(sr, identity, { now: () => clock.now });
  const actor = (id = 'admin') => identity.actorForAccount(id);
  const operation = (prefix = 'fixture') => ({ operationId: `${prefix}:${randomUUID()}` });
  const draft = scheduling.createWipe(actor(), {
    title: '隔离通知档期', description: '仅供本地可靠性验证', serverProfileId: 'server1', serverSnapshot: { name: '隔离服务器' },
    timeZone: 'Asia/Shanghai', musterAt: '2030-09-08T12:00:00Z', serverScheduledWipeAt: '2030-09-08T11:00:00Z',
    signupOpensAt: '2030-09-08T09:00:00Z', signupClosesAt: '2030-09-08T13:00:00Z', autoStart: true,
    audience: { squadIds: ['sq1'], memberIds: [], includeUnassigned: false }, ...opts.wipeInput
  }, operation('create-wipe')).current;
  const wipe = scheduling.transition(actor(), draft.id, 'publish', { expectedRevision: draft.revision }, operation('publish-wipe')).current;
  const catalog = opts.catalog || createCatalog(identity), transport = opts.transport || createFixtureTransport();
  const renderer = opts.renderer || fixtureRenderer, templates = opts.templates || clone(fixtureTemplates);
  const platforms = opts.platforms || createFixturePlatforms(transport);
  const system = createNotificationSystem({ identity, scheduling, catalog, renderer, templates, platforms,
    publicOrigin: opts.publicOrigin || 'http://127.0.0.1:4319', now: () => clock.now,
    options: { runtimeMode: 'isolated', previewTtlMs: 600_000, leaseMs: 30_000, maxAttempts: 5,
      resolveConnectIp: async () => null, ...opts.options } });
  let closed = false;
  return {
    db, identity, scheduling, system, actor, wipe, clock, transport, catalog, renderer, templates, platforms, operation,
    input: (overrides = {}) => ({ expectedContentRevision: wipe.contentRevision, templateId: 'wipe-notification', templateRevision: 1,
      purpose: 'signup_open', purposeInstance: 'primary', repeatOfIntentId: null, reason: null, duplicateRiskAcknowledged: false,
      targets: [{ targetId: 'discord-1', language: 'zh-CN', mentionMode: 'none', roleIds: [] }],
      audience: clone(wipe.audience), schedule: null, ...clone(overrides) }),
    signup: (overrides = {}) => ({ response: 'attending_on_time', expectedArrivalAt: null, timeZone: 'Asia/Shanghai',
      expectedSignupRevision: 0, confirmedContentRevision: wipe.contentRevision, ...overrides }),
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
