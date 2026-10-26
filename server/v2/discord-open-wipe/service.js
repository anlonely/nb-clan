import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { runStoreWriteTask as defaultWriteTask } from '../../store.js';
import { IdentityError } from '../identity/errors.js';
import { can } from '../identity/permissions.js';
import { hash } from '../notifications/shared.js';
import { PlatformAdminRepository } from '../platform-admin/repository.js';
import { resolveNewwipeTarget } from '../platform-admin/newwipe-permissions.js';
import { resolveServerConnectIp } from '../platform-admin/server-connect-card.js';
import { assertOpenWipeProof } from './proof.js';
import { defaultsForServer, listOpenWipeServers, normalizeOpenWipeSettings, normalizeOpenWipeConnect } from './catalog.js';
import { createSettingsModal, createPreviewPayload, text } from './interaction-ui.js';
import { openWipeResponses, renderOpenWipeCard, openWipeCopyPayload, openWipeSignupReply } from './renderer.js';

const digest = value => createHash('sha256').update(value).digest('hex');
export const openWipeTargetId = (id, channelId) => `open_wipe_${digest(`${id}\0${channelId}`).slice(0, 24)}`;
const need = (condition, code, status = 409) => { if (!condition) throw new IdentityError(code, status); };
const resource = id => ({ kind: 'discordOpenWipe', id });
const kinds = { draft: 'open-wipe-draft', card: 'open-wipe-card', signup: 'open-wipe-signup', token: 'open-wipe-token', receipt: 'open-wipe-receipt' };
const pending = new Set(['queued', 'running', 'unknown', 'result_unknown']);
const uncertain = new Set(['unknown', 'result_unknown']);
const safeName = proof => String(proof.externalDisplayName || proof.externalId).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
const principal = proof => ({ provider: 'discord', guildId: proof.guildId, channelId: proof.channelId,
  externalId: proof.externalId, discordRoleIds: [...(proof.discordRoleIds || [])], discordPermissions: proof.discordPermissions || '0' });
const privateText = content => ({ content, components: [], allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } });

/** An independent Discord-only aggregate. It deliberately does not create a
 * scheduling Wipe or reuse a community signup target, so publishing here cannot
 * activate the main guild's automatic Wipe announcements. */
export function createDiscordOpenWipeService({ notifications, platformService, catalog = notifications?.catalog,
  now = Date.now, resolveIp = resolveServerConnectIp, runStoreWriteTask = defaultWriteTask } = {}) {
  need(notifications?.repo?.db && platformService?.identity === notifications.identity,
    'OPEN_WIPE_OWNER_REQUIRED', 503);
  const service = notifications, repo = new PlatformAdminRepository(service.repo.db);
  const transaction = work => service.repo.transaction(work);
  const write = work => runStoreWriteTask(() => transaction(work));
  const get = (kind, id) => repo.get(kinds[kind], id);
  const put = (kind, value, actor = value.ownerId || value.publisher?.externalId || 'system') =>
    repo.put(kinds[kind], value.id, 'discord', actor, now(), value);
  const rows = kind => repo.list(kinds[kind], 'discord', { limit: 10000 });
  const roster = id => rows('signup').filter(row => row.cardId === id).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.discordId.localeCompare(b.discordId));
  const config = () => platformService.config('discord');
  function configured(proof, publisher = true) {
    const base = resolveNewwipeTarget(config(), proof, { requirePublisher: publisher });
    const target = service.target(openWipeTargetId(base.id, proof.channelId));
    need(target?.enabled && target.platform === 'discord' && target.guildId === proof.guildId && target.channelId === proof.channelId,
      'PLATFORM_CHANNEL_DENIED', 403);
    return { base, target };
  }
  function recordFor(delivery) {
    need(delivery.resource?.kind === 'discordOpenWipe', 'RESOURCE_NOT_FOUND', 404);
    const card = get('card', delivery.resource.id);
    need(card && card.id === delivery.resource.id && (!card.deliveryId || card.deliveryId === delivery.id), 'RESOURCE_NOT_FOUND', 404);
    return card;
  }
  function cardContext(card, publisher = true) {
    const context = configured(card.publisher, publisher);
    need(context.target.id === card.targetId && context.base.id === card.baseTargetId && context.target.guildId === card.guildId &&
      context.target.channelId === card.channelId, 'PLATFORM_CHANNEL_DENIED', 403);
    return context;
  }
  function activeReference(card, { allowFailed = false } = {}) {
    const delivery = service.repo.get('deliveries', card.deliveryId);
    need(delivery?.status === 'sent' && delivery.resource?.kind === 'discordOpenWipe' && delivery.resource.id === card.id,
      'MESSAGE_REFERENCE_REQUIRED', 409);
    const matching = service.repo.forResource('messageRefs', resource(card.id)).filter(ref => ref.deliveryId === delivery.id && ref.platform === 'discord' &&
      ref.guildId === card.guildId && ref.channelId === card.channelId && ref.targetId === card.targetId);
    need(!matching.some(ref => ref.state === 'update_unknown'), 'CARD_EDIT_RECONCILIATION_REQUIRED', 409);
    const refs = matching.filter(ref => ref.state === 'active' || allowFailed && ref.state === 'update_failed');
    need(refs.length === 1, 'MESSAGE_REFERENCE_REQUIRED', 409);
    return { delivery, ref: refs[0] };
  }
  function tokenFor(type, properties) {
    const token = randomBytes(32).toString('base64url');
    put('token', { id: digest(token), type, createdAt: now(), ...properties });
    return token;
  }
  function tokenContext(proof) {
    const token = typeof proof.payload.token === 'string' && get('token', digest(proof.payload.token));
    need(token && token.guildId === proof.guildId && token.channelId === proof.channelId,
      'OPEN_WIPE_TOKEN_INVALID', 404);
    if (token.ownerId) need(token.ownerId === proof.externalId, 'OPEN_WIPE_TOKEN_INVALID', 404);
    need(!token.expiresAt || token.expiresAt > now(), 'OPEN_WIPE_FORM_EXPIRED', 410);
    if (token.type === 'draft') {
      if (['publish', 'settings', 'server', 'edit_details', 'select_server'].includes(proof.payload.action))
        need(proof.originEphemeral === true, 'MESSAGE_REFERENCE_REQUIRED', 409);
      const draft = get('draft', token.draftId);
      need(draft?.ownerId === proof.externalId && draft.guildId === proof.guildId && draft.channelId === proof.channelId,
        'OPEN_WIPE_TOKEN_INVALID', 404);
      if (draft.cardId) {
        const card = get('card', draft.cardId);
        need(card, 'RESOURCE_NOT_FOUND', 404);
        const { ref } = activeReference(card, { allowFailed: true });
        need(ref.id === draft.messageRefId && ref.messageId === draft.originMessageId, 'MESSAGE_REFERENCE_REQUIRED', 409);
      }
      return { token, draft };
    }
    const card = get('card', token.cardId);
    need(card, 'RESOURCE_NOT_FOUND', 404);
    cardContext(card, false);
    const { delivery, ref } = activeReference(card, { allowFailed: true });
    if (token.type === 'public') need(proof.originMessageId === ref.messageId && proof.originEphemeral !== true,
      'MESSAGE_REFERENCE_REQUIRED', 409);
    else need(token.type === 'private' && token.messageRefId === ref.id && token.originMessageId === ref.messageId && proof.originEphemeral === true,
      'MESSAGE_REFERENCE_REQUIRED', 409);
    return { token, card, delivery, ref };
  }
  function snapshot(card) { return { contentRevision: card.revision, rosterRevision: card.rosterRevision || 0 }; }
  function rendered(card, { token = card.publicToken, locale, privateView = false } = {}) {
    return renderOpenWipeCard({ settings: { ...card.settings, resolvedIp: card.resolvedIp || null }, signups: roster(card.id), token,
      locale, privateView, publisherLocale: card.locale });
  }
  function queueEdit(card, reasonCode) {
    const { delivery, ref } = activeReference(card, { allowFailed: true });
    const operations = service.repo.forResource('messageOperations', resource(card.id));
    if (operations.some(op => pending.has(op.status))) return null;
    const payload = rendered(card), payloadHash = hash(payload);
    if (payloadHash === (ref.payloadHash || delivery.payloadHash)) return null;
    const failed = ref.lastMessageOperationId && service.repo.get('messageOperations', ref.lastMessageOperationId);
    if (failed?.status === 'failed' && failed.payloadHash === payloadHash) return null;
    return service.queueMessageOperation(delivery, 'edit', { messageRefId: ref.id, actorAccountId: null, reasonCode });
  }
  const domain = {
    visible(actor, delivery) {
      try {
        const card = recordFor(delivery), current = service.identity.actorForAccount(actor.id);
        return can(current, 'notifications.send', { kind: 'platformTarget', id: card.targetId }, service.identity.relations());
      } catch { return false; }
    },
    executionContext(delivery, { mode = 'send', actorAccountId } = {}) {
      const card = recordFor(delivery), context = cardContext(card);
      if (actorAccountId) {
        const actor = service.identity.actorForAccount(actorAccountId);
        need(can(actor, mode.startsWith('lookup') ? 'notifications.reconcile' : 'notifications.send',
          { kind: 'platformTarget', id: card.targetId }, service.identity.relations()), 'ACCESS_DENIED', 403);
      }
      need(delivery.target?.guildId === card.guildId && delivery.target?.channelId === card.channelId &&
        delivery.target?.id === card.targetId, 'PLATFORM_CHANNEL_DENIED', 403);
      if (mode === 'send') need(delivery.snapshot?.contentRevision === card.revision && delivery.payloadHash === hash(rendered(card)), 'PREVIEW_STALE', 409);
      return context;
    },
    renderEdit(delivery) {
      const card = recordFor(delivery); domain.executionContext(delivery, { mode: 'edit' });
      const payload = rendered(card);
      return { payload, payloadHash: hash(payload), snapshot: snapshot(card), actionReferenceIds: [] };
    },
    validateInboxReference() { need(false, 'DELIVERY_REFERENCE_REQUIRED', 422); },
    refresh: () => refresh(),
  };
  service.registerBusinessDomain('discordOpenWipe', domain);

  function newDraft(proof, card = null) {
    const { base, target } = configured(proof);
    const existing = card ? activeReference(card, { allowFailed: true }) : null;
    const draft = { id: randomUUID(), ownerId: proof.externalId, guildId: proof.guildId, channelId: proof.channelId,
      baseTargetId: base.id, targetId: target.id, publisher: principal(proof), locale: proof.locale || 'en',
      settings: card ? structuredClone(card.settings) : null, server: card ? structuredClone(card.server) : null,
      manualDate: Boolean(card), manualDirect: card?.manualDirect || false, cardId: card?.id || null,
      baseRevision: card?.revision || null, messageRefId: existing?.ref.id || null, originMessageId: existing?.ref.messageId || null,
      createdAt: now(), updatedAt: now(), expiresAt: now() + 15 * 60_000 };
    draft.token = tokenFor('draft', { draftId: draft.id, ownerId: draft.ownerId, guildId: draft.guildId,
      channelId: draft.channelId, expiresAt: draft.expiresAt });
    return put('draft', draft);
  }
  function preview(draft) {
    const existing = draft.cardId && get('card', draft.cardId);
    const settings = { ...(draft.settings || { serverName: '', adaptiveDisplay: true }),
      ...(existing?.settings.directConnect === draft.settings?.directConnect && existing?.resolvedIp ? { resolvedIp: existing.resolvedIp } : {}) };
    const canPublish = Boolean(settings.wipeAt && Date.parse(settings.wipeAt) > now());
    return createPreviewPayload({ token: draft.token, locale: draft.locale, canPublish,
      servers: listOpenWipeServers(catalog, { now }), settings, editing: Boolean(draft.cardId),
      cardPayload: renderOpenWipeCard({ settings, token: draft.token, locale: draft.locale, privateView: true,
        publisherLocale: draft.locale, signups: draft.cardId ? roster(draft.cardId) : [] }) });
  }
  function prepareInput(values) {
    const { serverId, ...input } = values;
    return input;
  }
  function updateFromServer(proof, draft, values) {
    const server = defaultsForServer(catalog, values.serverId, { now });
    const input = prepareInput(values);
    const sameServer = draft.server?.id === server.id;
    if (sameServer && draft.manualDate && draft.settings) Object.assign(input, {
      wipeAtLocal: draft.settings.wipeAtLocal, timeZone: draft.settings.timeZone, utcOffset: draft.settings.utcOffset });
    let settings;
    try { settings = normalizeOpenWipeSettings(input, server, { now }); }
    catch (error) {
      if (error.errorCode !== 'OPEN_WIPE_TIME_REQUIRED') throw error;
      const notes = String(input.notes || '').trim();
      need(notes.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes), 'OPEN_WIPE_NOTES_INVALID', 422);
      settings = { serverId: server.id, serverName: server.label, timeZone: server.timeZone,
        directConnect: normalizeOpenWipeConnect(input.directConnect || '') || (input.autoConnect !== false ? server.directConnect : ''),
        autoConnect: input.autoConnect !== false, adaptiveDisplay: input.adaptiveDisplay !== false, notes,
        wipeAt: null, wipeAtLocal: '', utcOffset: '' };
    }
    return { ...draft, server, settings, manualDate: sameServer && draft.manualDate,
      manualDirect: Boolean(values.directConnect?.trim()), updatedAt: now(), publisher: principal(proof) };
  }
  function draftForAction(proof, context) {
    configured(proof);
    if (context.draft) return context.draft;
    need(context.card, 'RESOURCE_NOT_FOUND', 404);
    return newDraft(proof, context.card);
  }
  function privateView(card, proof) {
    const { ref } = activeReference(card, { allowFailed: true });
    const token = tokenFor('private', { cardId: card.id, ownerId: proof.externalId, guildId: card.guildId, channelId: card.channelId,
      messageRefId: ref.id, originMessageId: ref.messageId, expiresAt: now() + 15 * 60_000 });
    return rendered(card, { token, locale: proof.locale, privateView: true });
  }
  function receiptKey(proof) { return digest([proof.guildId, proof.externalId, proof.interactionId].join('\0')); }
  function previous(proof) {
    const receipt = get('receipt', receiptKey(proof));
    if (!receipt) return null;
    need(receipt.inputHash === hash(proof.payload), 'IDEMPOTENCY_CONFLICT', 409);
    return receipt.result;
  }
  function remember(proof, result) {
    put('receipt', { id: receiptKey(proof), ownerId: proof.externalId, inputHash: hash(proof.payload), result });
    return result;
  }
  function publicationStatus(card, locale) {
    const delivery = card && service.repo.get('deliveries', card.deliveryId);
    need(delivery, 'OPEN_WIPE_DELIVERY_REQUIRED', 503);
    if (delivery.status === 'sent') return privateText(text(locale, 'alreadyPublished'));
    if (delivery.status === 'delivery_unknown') return privateText(text(locale, 'deliveryUnknown'));
    if (['failed', 'cancelled'].includes(delivery.status)) return privateText(text(locale, 'deliveryFailed'));
    return privateText(text(locale, 'queued'));
  }
  function submit(proof, context) {
    const draft = context.draft;
    need(draft, 'OPEN_WIPE_TOKEN_INVALID', 404);
    configured(proof);
    if (draft.publishedCardId) {
      const existing = get('card', draft.publishedCardId);
      return publicationStatus(existing, proof.locale);
    }
    need(draft.settings?.wipeAt && Date.parse(draft.settings.wipeAt) > now(), 'OPEN_WIPE_TIME_REQUIRED', 422);
    if (draft.cardId) {
      const card = get('card', draft.cardId);
      need(card && card.revision === draft.baseRevision, 'REVISION_CONFLICT', 409);
      need(!service.repo.forResource('messageOperations', resource(card.id)).some(op => uncertain.has(op.status)), 'CARD_EDIT_RECONCILIATION_REQUIRED', 409);
      const next = { ...card, settings: draft.settings, server: draft.server, manualDirect: draft.manualDirect,
        publisher: principal(proof), revision: card.revision + 1, updatedAt: now(), resolvedIp: card.settings.directConnect === draft.settings.directConnect ? card.resolvedIp : null };
      put('card', next); queueEdit(next, 'OPEN_WIPE_SETTINGS_CHANGED');
      put('draft', { ...draft, publishedCardId: next.id, updatedAt: now() });
      return privateText(text(proof.locale, 'updateQueued'));
    }
    const { base, target } = configured(proof), id = randomUUID();
    const card = { id, settings: draft.settings, server: draft.server, manualDirect: draft.manualDirect, publisher: principal(proof),
      creator: principal(proof), locale: draft.locale, guildId: proof.guildId, channelId: proof.channelId,
      baseTargetId: base.id, targetId: target.id, revision: 1, rosterRevision: 0, resolvedIp: null, createdAt: now(), updatedAt: now(), deliveryId: null };
    card.publicToken = tokenFor('public', { cardId: id, guildId: card.guildId, channelId: card.channelId });
    put('card', card);
    const payload = rendered(card);
    const admitted = service.createBusinessIntent({ resource: resource(id), purpose: 'open_wipe.publish', unitKey: draft.id,
      createdByAccountId: null, language: card.settings.adaptiveDisplay === false ? normalizedLocale(card.locale) : 'en', target,
      payload, payloadHash: hash(payload), snapshot: snapshot(card), binding: { publisherId: card.publisher.externalId, draftId: draft.id },
      event: { id: proof.interactionId, type: 'discord.open_wipe.publish', actorDiscordId: proof.externalId } });
    card.deliveryId = admitted.deliveryId || service.repo.forResource('deliveries', resource(id)).find(row => row.intentId === admitted.intentId)?.id;
    need(card.deliveryId, 'OPEN_WIPE_DELIVERY_REQUIRED', 503);
    put('card', card); put('draft', { ...draft, publishedCardId: card.id, updatedAt: now() });
    return publicationStatus(card, proof.locale);
  }
  function signup(proof, context) {
    need(context.card, 'OPEN_WIPE_TOKEN_INVALID', 404);
    configured(proof, false);
    const card = get('card', context.card.id), response = openWipeResponses[proof.payload.action];
    const id = digest(`${card.id}\0${proof.externalId}`), old = get('signup', id), name = safeName(proof);
    if (old?.response !== response || old?.name !== name) {
      put('signup', { id, cardId: card.id, discordId: proof.externalId, name, response, revision: (old?.revision || 0) + 1,
        updatedAt: new Date(now()).toISOString() }, proof.externalId);
      card.rosterRevision++; put('card', card); queueEdit(card, 'OPEN_WIPE_SIGNUP_CHANGED');
    }
    return openWipeSignupReply(card.settings, response, proof.locale);
  }
  function handleVerified(proof) {
    assertOpenWipeProof(proof);
    need(typeof proof.interactionId === 'string' && proof.interactionId, 'PLATFORM_AUTH_INVALID', 401);
    const action = proof.payload.action;
    if (['open', 'settings', 'server', 'edit_details'].includes(action)) return transaction(() => {
      configured(proof);
      const old = previous(proof); if (old) return old;
      const context = action === 'open' ? null : tokenContext(proof);
      const draft = action === 'open' ? newDraft(proof) : draftForAction(proof, context);
      if (action === 'edit_details') need(draft.server, 'OPEN_WIPE_SERVER_INVALID', 422);
      const result = action === 'edit_details' ? createSettingsModal({ token: draft.token, serverName: draft.settings?.serverName, settings: draft.settings || {}, locale: proof.locale }) :
        { type: 4, data: { ...preview(draft), flags: 32768 | 64 } };
      return remember(proof, result);
    });
    return (async () => {
      // Verify scope and ownership before an optional provider read, then repeat
      // inside the write transaction after all asynchronous work has finished.
      configured(proof, !['language', 'copy', ...Object.keys(openWipeResponses)].includes(action));
      tokenContext(proof);
      if (['create_submit', 'select_server'].includes(action)) await catalog.prepareOptions?.('servers');
      return write(() => {
        configured(proof, !['language', 'copy', ...Object.keys(openWipeResponses)].includes(action));
        const old = previous(proof); if (old) return old;
        const context = tokenContext(proof);
        let result;
        if (['create_submit', 'select_server'].includes(action)) {
          need(context.draft && !context.draft.publishedCardId, 'OPEN_WIPE_ALREADY_PUBLISHED', 409);
          const saved = context.draft.settings;
          const values = action === 'select_server' ? {
            serverId: proof.payload.values.serverId,
            autoConnect: saved?.autoConnect !== false, adaptiveDisplay: saved?.adaptiveDisplay !== false,
            notes: saved?.notes || '',
            directConnect: context.draft.manualDirect ? saved?.directConnect || '' : '',
          } : proof.payload.values;
          const next = updateFromServer(proof, context.draft, values);
          put('draft', next); result = preview(next);
        } else if (action === 'settings_submit') {
          const draft = context.draft;
          need(draft?.server && !draft.publishedCardId, 'OPEN_WIPE_SERVER_INVALID', 422);
          const input = { ...proof.payload.values };
          if (input.wipeAtLocal === draft.settings?.wipeAtLocal && input.timeZone === draft.settings?.timeZone && draft.settings.utcOffset) input.utcOffset = draft.settings.utcOffset;
          const settings = normalizeOpenWipeSettings(input, draft.server, { now });
          const next = { ...draft, settings, manualDate: true, manualDirect: settings.directConnect !== draft.server.directConnect,
            publisher: principal(proof), updatedAt: now() };
          put('draft', next);
          // Saving settings on an existing public card applies to that card;
          // unpublished drafts remain private until Publish is clicked.
          result = next.cardId ? submit(proof, { draft: next }) : preview(next);
        } else if (action === 'publish') result = submit(proof, context);
        else if (openWipeResponses[action]) result = signup(proof, context);
        else if (action === 'language') {
          need(context.card, 'OPEN_WIPE_TOKEN_INVALID', 404); result = privateView(context.card, proof);
        } else if (action === 'copy') {
          need(context.card, 'OPEN_WIPE_TOKEN_INVALID', 404); result = openWipeCopyPayload({ ...context.card.settings, resolvedIp: context.card.resolvedIp }, proof.locale);
        } else need(false, 'PLATFORM_PAYLOAD_INVALID', 422);
        return remember(proof, result);
      });
    })();
  }
  let nextRefreshAt = 0;
  async function refresh() {
    if (now() < nextRefreshAt) return;
    nextRefreshAt = now() + 5000;
    for (const saved of rows('card')) {
      if (!saved.deliveryId || service.repo.get('deliveries', saved.deliveryId)?.status !== 'sent') continue;
      try {
        cardContext(saved);
        const operations = service.repo.forResource('messageOperations', resource(saved.id));
        if (operations.some(op => pending.has(op.status))) continue;
        const command = saved.settings.directConnect;
        let ip = saved.resolvedIp || null, checked = false;
        if (command && !saved.resolvedIp && (!saved.ipCheckedAt || saved.ipCheckedAt + 300000 <= now())) {
          checked = true;
          try { const result = await resolveIp(command); ip = isIP(result) === 4 ? result : null; } catch { ip = null; }
        }
        if (!checked) {
          const { delivery, ref } = activeReference(saved, { allowFailed: true });
          if (hash(rendered(saved)) === (ref.payloadHash || delivery.payloadHash)) continue;
        }
        await write(() => {
          const current = get('card', saved.id);
          if (!current || current.revision !== saved.revision || current.settings.directConnect !== command) return;
          cardContext(current);
          const updated = { ...current, ...(checked ? { resolvedIp: ip, ipCheckedAt: now() } : {}) };
          if (checked) put('card', updated);
          queueEdit(updated, checked && ip !== current.resolvedIp ? 'OPEN_WIPE_CONNECT_RESOLVED' : 'OPEN_WIPE_CONTENT_CHANGED');
        });
      } catch (error) { if (!error.errorCode) throw error; }
    }
  }
  return { handleVerified, domain, refresh };
}

function normalizedLocale(locale) {
  if (typeof locale !== 'string') return 'en';
  const prefix = locale.toLowerCase().split('-')[0];
  return prefix === 'zh' ? 'zh-CN' : ['ru', 'tr', 'th', 'ko'].includes(prefix) ? prefix : 'en';
}
