import { validGrant } from '../identity/permissions.js';
import { collections } from '../notifications/repository.js';
import { openWipeIpCommand } from '../discord-open-wipe/renderer.js';
import { need } from './model.js';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const text = (value, max = 200) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
const iso = value => {
  if (value == null || value === '') return null;
  const at = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : null;
const statuses = new Set(['queued', 'running', 'published', 'failed', 'unknown', 'cancelled']);
const responses = Object.freeze({ on_time: 'accepted', absent: 'declined', late: 'late', late_8h: 'late', late_16h: 'late', delayed_8h: 'late', delayed_16h: 'late' });
const profile = id => snowflake(id) ? `https://discord.com/users/${id}` : null;

function input(query = {}, allowed) {
  need(query && typeof query === 'object' && !Array.isArray(query), 'BOT_INPUT_INVALID');
  need(Object.keys(query).every(key => allowed.includes(key)), 'BOT_INPUT_INVALID');
  for (const value of Object.values(query)) need(typeof value === 'string' && value.length <= 200, 'BOT_INPUT_INVALID');
  const page = query.page === undefined ? 1 : Number(query.page), pageSize = query.pageSize === undefined ? 25 : Number(query.pageSize);
  need(Number.isSafeInteger(page) && page >= 1 && page <= 1000000 && Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 100, 'BOT_INPUT_INVALID');
  return { ...query, page, pageSize, q: (query.q || '').trim().toLocaleLowerCase() };
}

function context(service, actor) {
  const current = service.actor(actor, 'discord');
  const config = service.config('discord');
  return { service, actor: current, config, db: service.repo.db, readAt: new Date(service.now()).toISOString(),
    guilds: service.guildCatalog('discord', config).items, channels: service.channelCatalogs('discord', config) };
}

// The platform read grant owns this new read-only view. Existing target denies
// still narrow it; viewing a roster never confers Discord publishing authority.
function visible(ctx, card) {
  if (!card || !snowflake(card.guildId) || !snowflake(card.channelId)) return false;
  const ids = new Set([card.targetId, card.baseTargetId, card.guildId]);
  return !ctx.actor.grants?.some(grant => validGrant(grant) && grant.effect === 'deny' && grant.capability === 'platforms.read' &&
    grant.scope.type === 'platformTargets' && grant.scope.ids.some(id => ids.has(id)));
}

function readCard(ctx, id) {
  need(typeof id === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(id), 'RESOURCE_NOT_FOUND', 404);
  const row = ctx.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='open-wipe-card' AND platform='discord' AND id=?").get(id);
  const card = row && JSON.parse(row.payload);
  need(card?.id === id && visible(ctx, card), 'RESOURCE_NOT_FOUND', 404);
  return card;
}

function notificationRows(ctx, name, card) {
  return ctx.db.prepare(`SELECT payload_json FROM json_records WHERE collection=?
    AND json_extract(payload_json,'$.resource.kind')='discordOpenWipe' AND json_extract(payload_json,'$.resource.id')=?`)
    .all(collections[name], card.id).map(row => JSON.parse(row.payload_json));
}

function signups(ctx, card) {
  const rows = ctx.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='open-wipe-signup' AND platform='discord' AND json_extract(payload,'$.cardId')=?")
    .all(card.id).map(row => JSON.parse(row.payload));
  // Defensive deduplication keeps one current response per Discord identity,
  // matching the writer's cardId + discordId key without exposing raw records.
  const latest = new Map();
  for (const row of rows) if (snowflake(row.discordId) && Object.hasOwn(responses, row.response)) {
    const previous = latest.get(row.discordId);
    if (!previous || (iso(row.updatedAt) || '') > (iso(previous.updatedAt) || '') ||
      row.updatedAt === previous.updatedAt && (row.revision || 0) > (previous.revision || 0)) latest.set(row.discordId, row);
  }
  return [...latest.values()].map(row => ({ discordId: row.discordId, name: text(row.name, 80) || row.discordId,
    response: responses[row.response], originalResponse: row.response, updatedAt: iso(row.updatedAt), profileUrl: profile(row.discordId) }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.discordId.localeCompare(b.discordId));
}

function counts(rows) {
  const value = { accepted: 0, declined: 0, late: 0, total: rows.length };
  for (const row of rows) value[row.response]++;
  return value;
}

function publication(ctx, card) {
  const delivery = notificationRows(ctx, 'deliveries', card).find(row => row.id === card.deliveryId && row.targetId === card.targetId &&
    row.target?.platform === 'discord' && row.target.guildId === card.guildId && row.target.channelId === card.channelId);
  const references = notificationRows(ctx, 'messageRefs', card).filter(row => delivery && row.deliveryId === delivery.id && row.targetId === card.targetId &&
    row.platform === 'discord' && row.guildId === card.guildId && row.channelId === card.channelId && snowflake(row.messageId));
  const reference = references.length === 1 ? references[0] : null;
  const state = { queued: 'queued', retry_wait: 'queued', sending: 'running', running: 'running', sent: 'published', failed: 'failed', cancelled: 'cancelled' }[delivery?.status] || 'unknown';
  const status = state === 'published' && !reference ? 'unknown' : state;
  const edits = notificationRows(ctx, 'messageOperations', card).filter(row => row.kind === 'edit' && row.deliveryId === delivery?.id &&
    row.targetId === card.targetId && row.messageRefId === reference?.id)
    .sort((a, b) => (iso(b.createdAt) || '').localeCompare(iso(a.createdAt) || '') || (iso(b.updatedAt) || '').localeCompare(iso(a.updatedAt) || '') || b.id.localeCompare(a.id));
  const edit = edits[0];
  return { publication: { status, messageId: reference?.messageId || null,
    messageUrl: reference && reference.state !== 'deleted' ? `https://discord.com/channels/${card.guildId}/${card.channelId}/${reference.messageId}` : null,
    updatedAt: iso(delivery?.updatedAt || delivery?.sentAt || delivery?.createdAt), errorCode: code(delivery?.lastErrorCode) },
    update: edit ? { status: ['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'skipped'].includes(edit.status) ? edit.status : 'unknown',
      updatedAt: iso(edit.updatedAt), errorCode: code(edit.lastErrorCode) } : null };
}

function item(ctx, card, rows = signups(ctx, card)) {
  const target = ctx.config.targets?.find(row => row.id === card.baseTargetId && row.guildId === card.guildId);
  const creatorId = snowflake(card.creator?.externalId) ? card.creator.externalId : null;
  return { id: card.id, server: { id: text(String(card.server?.id || card.settings?.serverId || ''), 160), name: text(card.settings?.serverName || card.server?.name) },
    guild: { id: card.guildId, name: text(ctx.guilds.find(row => row.id === card.guildId)?.label || target?.name) || card.guildId },
    channel: { id: card.channelId, name: text(ctx.channels.find(row => row.guildId === card.guildId)?.items.find(row => row.id === card.channelId)?.label) || card.channelId },
    creator: { discordId: creatorId, name: null, profileUrl: profile(creatorId) },
    wipeAt: iso(card.settings?.wipeAt), timeZone: text(card.settings?.timeZone, 80) || 'UTC', createdAt: iso(card.createdAt), updatedAt: iso(card.updatedAt),
    counts: counts(rows), ...publication(ctx, card) };
}

function pageResult(rows, query) {
  return { items: rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: rows.length,
    page: query.page, pageSize: query.pageSize, pages: Math.ceil(rows.length / query.pageSize) };
}

export function listOpenSignups(service, actor, query) {
  const ctx = context(service, actor), q = input(query, ['q', 'guildId', 'serverId', 'status', 'from', 'to', 'sort', 'order', 'page', 'pageSize']);
  need(!q.guildId || snowflake(q.guildId), 'BOT_INPUT_INVALID');
  need(!q.status || statuses.has(q.status), 'BOT_INPUT_INVALID');
  need(!q.sort || ['wipeAt', 'createdAt'].includes(q.sort), 'BOT_INPUT_INVALID');
  need(!q.order || ['asc', 'desc'].includes(q.order), 'BOT_INPUT_INVALID');
  for (const key of ['from', 'to']) need(!q[key] || /^\d{4}-\d{2}-\d{2}T/.test(q[key]) && iso(q[key]), 'BOT_INPUT_INVALID');
  need(!q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), 'BOT_INPUT_INVALID');
  const cards = ctx.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='open-wipe-card' AND platform='discord'").all()
    .map(row => JSON.parse(row.payload)).filter(card => visible(ctx, card));
  const all = cards.map(card => item(ctx, card));
  const choices = key => [...new Map(all.map(row => [row[key].id, row[key]])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const rows = all.filter(row => (!q.guildId || row.guild.id === q.guildId) && (!q.serverId || row.server.id === q.serverId) &&
    (!q.status || row.publication.status === q.status) && (!q.from || row.wipeAt && Date.parse(row.wipeAt) >= Date.parse(q.from)) &&
    (!q.to || row.wipeAt && Date.parse(row.wipeAt) < Date.parse(q.to)) && (!q.q || [row.server.name, row.guild.name, row.channel.name,
      row.creator.discordId, row.id].some(value => String(value || '').toLocaleLowerCase().includes(q.q))));
  const field = q.sort || 'wipeAt', direction = q.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => direction * ((a[field] || '').localeCompare(b[field] || '') || a.id.localeCompare(b.id)));
  return { ...pageResult(rows, q), filters: { servers: choices('server'), guilds: choices('guild') }, readAt: ctx.readAt };
}

export function openSignupDetail(service, actor, id) {
  const ctx = context(service, actor), card = readCard(ctx, id), command = openWipeIpCommand({ ...card.settings, resolvedIp: card.resolvedIp });
  return { ...item(ctx, card), settings: { wipeAtLocal: text(card.settings?.wipeAtLocal, 40), adaptiveDisplay: card.settings?.adaptiveDisplay !== false,
    autoConnect: card.settings?.autoConnect !== false, directConnect: text(card.settings?.directConnect, 500),
    notes: typeof card.settings?.notes === 'string' ? card.settings.notes.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').slice(0, 4000) : '' },
    resolvedIp: command ? { command } : null, readAt: ctx.readAt };
}

export function openSignupRoster(service, actor, id, query) {
  const ctx = context(service, actor), card = readCard(ctx, id), q = input(query, ['response', 'q', 'page', 'pageSize']);
  need(!q.response || ['accepted', 'declined', 'late'].includes(q.response), 'BOT_INPUT_INVALID');
  const rows = signups(ctx, card), matching = rows.filter(row => (!q.response || row.response === q.response) &&
    (!q.q || `${row.name} ${row.discordId}`.toLocaleLowerCase().includes(q.q)));
  return { ...pageResult(matching, q), counts: counts(rows), readAt: ctx.readAt };
}
