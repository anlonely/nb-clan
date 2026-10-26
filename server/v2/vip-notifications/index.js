import { authorize, can } from '../identity/permissions.js';
import { IdentityError } from '../identity/errors.js';
import { need, hash, identifier, stamp, languages, page } from '../notifications/shared.js';
import { VipNotificationRepository } from './repository.js';
import { VIP_SOURCES, SCAN_INTERVAL_MS, vipSnapshot } from './model.js';
import { preferredVipLanguage, renderVip } from './renderer.js';
export { installVipNotificationsSchema } from './repository.js';

const sync = value => { need(!value?.then, 'VIP_SYNC_READER_REQUIRED', 503); return value; };
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const active = actor => actor?.status === 'active' && !actor.restricted;

/** Persistent finite input scan; all outbound work remains in the original notification core. */
export function createVipNotifications({ identity, notifications, readPolicy, readPrincipal, readSourceConfig, readDmTarget,
  runStoreWriteTask, now = identity?.now || Date.now }) {
  const service = notifications?.service;
  need(service?.identity === identity && service.repo.db === identity?.repo?.db && notifications.worker &&
    [readPolicy, readPrincipal, readSourceConfig, readDmTarget, runStoreWriteTask, now].every(f => typeof f === 'function'), 'VIP_NOTIFICATION_HOST_REQUIRED', 503);
  const core = service.repo, repo = new VipNotificationRepository(core), db = core.db;
  let accepting = true, pending = null, stopping;
  function clock() { const value = Number(now()); need(Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()), 'VIP_CLOCK_INVALID', 503); return value; }
  function policy() {
    const raw = sync(readPolicy());
    need(raw && typeof raw.enabled === 'boolean' && identifier(raw.revision) && typeof raw.legacySchedulerDisabled === 'boolean', 'VIP_POLICY_INVALID', 503);
    const sources = {};
    for (const source of VIP_SOURCES) {
      const input = raw.sources?.[source] || { enabled: source === 'vital', revision: 'legacy-default' };
      need(typeof input.enabled === 'boolean' && identifier(input.revision), 'VIP_POLICY_INVALID', 503);
      sources[source] = { enabled: input.enabled, revision: input.revision };
    }
    return { enabled: raw.enabled, revision: raw.revision, legacySchedulerDisabled: raw.legacySchedulerDisabled, sources };
  }
  function principal() {
    const value = sync(readPrincipal());
    need(identifier(value?.accountId) && Number.isSafeInteger(value.permissionVersion) && value.permissionVersion > 0, 'VIP_PRINCIPAL_REQUIRED', 503);
    const actor = identity.actorForAccount(value.accountId);
    need(active(actor) && actor.permissionVersion === value.permissionVersion, 'VIP_PRINCIPAL_CHANGED', 403);
    return { actor, pin: { accountId: actor.id, permissionVersion: actor.permissionVersion, scopeDigest: identity.scopeDigest(actor) } };
  }
  function sourceConfig(source) {
    const c = sync(readSourceConfig({ source, db }));
    need(c?.source === source && c.enabled === true && identifier(c.revision) && identifier(c.transportKey) && snowflake(c.botUserId), 'VIP_SOURCE_NOT_CONFIGURED', 409);
    need(c.templateRevision === 1, 'VIP_TEMPLATE_UNSUPPORTED', 422);
    return { source, enabled: true, revision: c.revision, transportKey: c.transportKey, botUserId: c.botUserId, templateRevision: 1 };
  }
  function member(id) {
    const m = repo.get('members', id);
    need(m && !m.deletedAt && !m.deleted && /^7656119\d{10}$/.test(m.steamId || ''), 'VIP_MEMBER_UNAVAILABLE', 409);
    return m;
  }
  function recipient(m) {
    need(snowflake(m.discordId), 'VIP_DISCORD_IDENTITY_REQUIRED', 409);
    const mappings = identity.repo.all('identities').filter(i => i.provider === 'discord' && i.externalId === m.discordId);
    need(mappings.length === 1, 'VIP_DISCORD_IDENTITY_REQUIRED', 409);
    const mapping = mappings[0], actor = identity.actorForAccount(mapping.accountId);
    identity.assertMemberParticipation(actor);
    need(active(actor) && actor.memberId === m.id, 'VIP_RECIPIENT_MEMBERSHIP_CHANGED', 403);
    const aliases = identity.aliases('discord', m.discordId, m.steamId);
    need(aliases.member?.id === m.id, 'VIP_RECIPIENT_IDENTITY_CHANGED', 403);
    const evidence = identity.repo.all('eligibility').filter(e => e.provider === 'discord' && e.externalId === m.discordId &&
      e.policyId === identity.policy('discord').id);
    need(evidence.length === 1, 'VIP_DISCORD_ELIGIBILITY_UNVERIFIED', 409);
    const currentPolicy = identity.assertEvidence(evidence[0], 'discord', m.discordId);
    return { actor, externalId: m.discordId, pin: { accountId: actor.id, permissionVersion: actor.permissionVersion,
      scopeDigest: identity.scopeDigest(actor), mappingId: mapping.id, mappingRevision: mapping.revision || 1,
      externalId: mapping.externalId, steamId: m.steamId, policyHash: hash(currentPolicy) } };
  }
  function targetFor(m, r, config, at) {
    const record = sync(readDmTarget({ source: config.source, memberId: m.id, accountId: r.actor.id, externalId: r.externalId }));
    const channel = record?.channel, ids = channel?.recipients?.map(u => u.id);
    need(record?.verified === true && record.botUserId === config.botUserId && record.transportKey === config.transportKey &&
      identifier(record.targetId) && record.targetId.length <= 160 && Number.isSafeInteger(record.configurationRevision) && record.configurationRevision > 0 &&
      identifier(record.revision) && channel?.type === 1 && channel.guild_id == null && snowflake(channel.id) &&
      Array.isArray(ids) && ids.length === 1 && ids[0] === r.externalId, 'VIP_DM_TARGET_UNVERIFIED', 409);
    const checked = Date.parse(record.verifiedAt), expires = Date.parse(record.expiresAt);
    need(Number.isFinite(checked) && checked <= at && at - checked <= 300000 && Number.isFinite(expires) && expires > at &&
      expires <= checked + 300000, 'VIP_DM_PROOF_EXPIRED', 409);
    need(Array.isArray(record.languages) && record.languages.length > 0 && record.languages.every(v => languages.includes(v)), 'LANGUAGE_UNSUPPORTED', 422);
    const target = { id: record.targetId, kind: 'directMessage', platform: 'discord', guildId: null, channelId: channel.id,
      channelType: 1, recipientId: r.externalId, recipientIds: [r.externalId], transportKey: config.transportKey,
      label: 'Discord 私信', enabled: true, runtimeMode: 'isolated', configurationRevision: record.configurationRevision,
      languages: [...record.languages], proofRevision: record.revision, botUserId: config.botUserId };
    return target;
  }
  function authorizeMember(actor, m) {
    const resource = { kind: 'member', id: m.id }, relations = identity.relations();
    authorize(actor, 'members.read', resource, relations);
    // VIP dates are private fields in the original MemberAdminService.memberDTO.
    need(['members.basic_edit', 'members.review'].some(cap => can(actor, cap, resource, relations)), 'VIP_PRIVATE_READ_REQUIRED', 403);
  }
  function eventFor(row) {
    const event = repo.event(row.event?.id);
    need(row.resource?.kind === 'vipExpiry' && event && row.resource.id === event.memberId && event.hash === row.event.hash &&
      row.binding?.eventId === event.id && row.binding.eventHash === event.hash && row.purpose === 'vip.expiring' &&
      row.createdByAccountId === event.principal.accountId && row.language === event.language &&
      hash(row.target) === event.targetHash && row.payloadHash === event.payloadHash && hash(row.payload) === event.payloadHash,
    'VIP_NOTIFICATION_EVENT_MISMATCH', 503);
    return event;
  }
  const domain = {
    executionContext(row, { mode = 'send', actorAccountId = row.createdByAccountId } = {}) {
      need(accepting, 'VIP_NOTIFICATION_STOPPED', 503);
      const event = eventFor(row), at = clock(), p = policy(), pin = principal(), m = member(event.memberId);
      need(p.enabled && p.legacySchedulerDisabled && p.sources[event.source].enabled && hash(p) === event.policyHash, 'VIP_POLICY_CHANGED', 409);
      need(hash(pin.pin) === hash(event.principal), 'VIP_PRINCIPAL_CHANGED', 403);
      authorizeMember(pin.actor, m);
      const actor = identity.actorForAccount(actorAccountId); authorizeMember(actor, m);
      const receiver = recipient(m);
      need(hash(receiver.pin) === hash(event.recipient), 'VIP_RECIPIENT_IDENTITY_CHANGED', 403);
      const config = sourceConfig(event.source);
      need(hash(config) === event.configHash, 'VIP_SOURCE_CONFIGURATION_CHANGED', 409);
      const target = targetFor(m, receiver, config, at);
      need(hash(target) === event.targetHash, 'VIP_DM_TARGET_CHANGED', 409);
      service.requireTarget(pin.actor, 'send', target.id);
      service.requireTarget(actor, ['lookup', 'lookup_completion'].includes(mode) ? 'reconcile' : 'send', target.id);
      need(target.languages.includes(event.language), 'LANGUAGE_UNSUPPORTED', 422);
      const vip = vipSnapshot(m, event.source, at);
      need(vip.fingerprint === event.vip.fingerprint && vip.periodKey === event.vip.periodKey, 'VIP_TERM_CHANGED', 409);
      need(!vip.legacySent, 'VIP_LEGACY_ALREADY_SENT', 409);
      need(!repo.legacyFence(m.id, vip), 'VIP_LEGACY_ATTEMPT_UNRESOLVED', 409);
      if (['send', 'edit'].includes(mode) || mode === 'completion') need(vip.due, 'VIP_WINDOW_CLOSED', 409);
      return { actor, target, member: m, vip, event };
    },
    visible(actor, row) {
      const event = eventFor(row), m = member(event.memberId); authorizeMember(actor, m);
      const r = recipient(m);
      need(hash(r.pin) === hash(event.recipient), 'RESOURCE_NOT_FOUND', 404);
      return ['preview', 'send', 'reconcile'].some(cap => service.permitted(actor, cap, row.targetId));
    },
    renderEdit(row) {
      const { member: m, vip, event } = this.executionContext(row, { mode: 'edit' });
      return renderVip(m, vip, event.language);
    },
    validateInboxReference() { throw new IdentityError('VIP_INBOX_UNSUPPORTED', 422); }
  };
  service.registerBusinessDomain('vipExpiry', domain);

  function cancelObsolete(m, source, vip, p, at) {
    for (const d of core.forResource('deliveries', { kind: 'vipExpiry', id: m.id })) {
      const event = repo.event(d.event?.id);
      if (!event || event.source !== source || p.enabled && p.legacySchedulerDisabled && p.sources[source].enabled &&
        event.vip.fingerprint === vip.fingerprint && vip.due && !vip.legacySent) continue;
      if (['queued', 'retry_wait'].includes(d.status) && d.knownNotSent === true) {
        d.status = 'cancelled'; d.cancelRequested = true; d.nextAttemptAt = null; d.lastErrorCode = 'VIP_REMINDER_OBSOLETE';
        service.changed(d, 'delivery.vip_cancelled');
      } else if (d.status === 'sending' && !d.cancelRequested) {
        d.cancelRequested = true; service.changed(d, 'delivery.vip_cancel_requested');
      }
    }
  }
  function processMember(m, p, maintenance, at, counts) {
    for (const source of VIP_SOURCES) {
      const vip = vipSnapshot(m, source, at);
      // The legacy sender cannot prove non-delivery even when it marked an error retryable.
      // Preserve observed periods before its bounded operation history is trimmed.
      const legacyFence = repo.legacyFence(m.id, vip, true);
      cancelObsolete(m, source, vip, p, at);
      let outcome = { status: 'skipped', reason: !p.enabled ? 'VIP_NOTIFICATIONS_DISABLED' : !p.legacySchedulerDisabled ? 'VIP_LEGACY_OWNER_ACTIVE' :
        !p.sources[source].enabled ? 'VIP_SOURCE_DISABLED' : !vip.due ? 'VIP_OUTSIDE_WINDOW' : vip.legacySent ? 'VIP_LEGACY_ALREADY_SENT' :
        legacyFence ? 'VIP_LEGACY_ATTEMPT_UNRESOLVED' : null };
      if (!outcome.reason) {
        try {
          outcome = repo.unit(() => {
          need(vip.purchasedAt && vip.expiresAt >= vip.purchasedAt, 'VIP_DATES_INVALID', 409);
          authorizeMember(maintenance.actor, m);
          const receiver = recipient(m), config = sourceConfig(source), target = targetFor(m, receiver, config, at);
          service.requireTarget(maintenance.actor, 'send', target.id);
          const existing = repo.event(vip.periodKey);
          if (existing) {
            const receipt = core.get('consumedEvents', `vip-expiry:${existing.id}`);
            const intent = receipt && core.get('intents', receipt.intentId);
            need(receipt?.eventHash === existing.hash && intent?.resource?.kind === 'vipExpiry' && intent.resource.id === m.id &&
              intent.purposeInstance === vip.periodKey, 'VIP_NOTIFICATION_RECEIPT_MISSING', 503);
            return { status: 'covered', intentId: receipt.intentId };
          } else {
            const language = preferredVipLanguage(db, receiver.externalId);
            need(target.languages.includes(language), 'LANGUAGE_UNSUPPORTED', 422);
            const rendered = renderVip(m, vip, language);
            const event = repo.putEvent({ id: vip.periodKey, source, memberId: m.id,
              vip: { source, type: vip.type, purchasedAt: vip.purchasedAt, expiresAt: vip.expiresAt, fingerprint: vip.fingerprint, periodKey: vip.periodKey },
              principal: maintenance.pin, recipient: receiver.pin, policyHash: hash(p), configHash: hash(config),
              targetHash: hash(target), language, payloadHash: rendered.payloadHash, createdAt: new Date(at).toISOString() });
            const resource = { kind: 'vipExpiry', id: m.id };
            const result = service.createBusinessIntent({ resource, unitKey: vip.periodKey, purpose: 'vip.expiring', language,
              createdByAccountId: maintenance.actor.id, target, ...rendered,
              event: { id: event.id, hash: event.hash }, binding: { eventId: event.id, eventHash: event.hash } });
            core.put('consumedEvents', { id: `vip-expiry:${event.id}`, resource, wipeId: null, eventHash: event.hash,
              intentId: result.intentId, type: 'vipExpiry.consumed', consumedAt: new Date(at).toISOString() });
            return { status: 'queued', intentId: result.intentId };
          }
          });
        } catch (error) {
          if (!(error instanceof IdentityError) || ![401, 403, 404, 409, 422].includes(error.status)) throw error;
          outcome = { status: 'skipped', reason: error.errorCode };
        }
      }
      repo.observe(m.id, source, { ...outcome, expiresAt: vip.expiresAt, checkedAt: new Date(at).toISOString() });
      counts[outcome.status]++;
    }
  }
  function scanPage(limit) {
    need(accepting, 'VIP_NOTIFICATION_STOPPED', 503);
    const at = clock(), p = policy(), maintenance = p.enabled && p.legacySchedulerDisabled ? principal() : null;
    let scan = repo.scan();
    if (scan) need(at >= scan.lastAt, 'VIP_CLOCK_REGRESSED', 409);
    if (scan?.completed && scan.policyHash === hash(p) && at < scan.nextAt) return { ...scan, scanned: 0, queued: 0, covered: 0, skipped: 0, waiting: true };
    if (!scan || scan.completed || scan.policyHash !== hash(p)) scan = { generation: (scan?.generation || 0) + 1,
      cursor: '', highWater: repo.highWater(), policyHash: hash(p), startedAt: at, lastAt: at, completed: false, nextAt: null };
    const members = repo.members(scan.cursor, scan.highWater, limit), counts = { scanned: members.length, queued: 0, covered: 0, skipped: 0 };
    for (const m of members) processMember(m, p, maintenance, at, counts);
    scan.cursor = members.at(-1)?.id || scan.cursor; scan.lastAt = at;
    scan.completed = !repo.members(scan.cursor, scan.highWater, 1).length;
    if (scan.completed) scan.nextAt = at + SCAN_INTERVAL_MS;
    repo.saveScan(scan); return { ...scan, ...counts, waiting: false };
  }
  function tick({ limit = 50 } = {}) {
    need(accepting, 'VIP_NOTIFICATION_STOPPED', 503);
    need(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'VIP_SCAN_LIMIT_INVALID', 422);
    need(!db.isTransaction, 'VIP_SCAN_OUTSIDE_TRANSACTION_REQUIRED', 503);
    if (pending) return pending;
    pending = runStoreWriteTask(() => core.transaction(() => scanPage(limit))).finally(() => { pending = null; });
    return pending;
  }
  function listIntents(actor, memberId, query = {}) {
    actor = service.actor(actor); authorizeMember(actor, member(memberId));
    const resource = { kind: 'vipExpiry', id: memberId }, ds = core.forResource('deliveries', resource).filter(d => service.isVisibleDelivery(actor, d));
    const rows = core.forResource('intents', resource).filter(i => ds.some(d => d.intentId === i.id));
    const result = page(rows, query); return { ...result, items: result.items.map(i => service.intentDTO(actor, i)) };
  }
  function stop() {
    if (stopping) return stopping; accepting = false;
    stopping = (async () => { await Promise.allSettled(pending ? [pending] : []); await notifications.worker.stop(); })(); return stopping;
  }
  return { tick, stop, listIntents, scanState: () => repo.scan() };
}
