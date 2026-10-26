import { need, hash, identifier } from '../notifications/shared.js';
import { parseHexaytronMessageProfile } from '../management-adapters/sources/hexaytron.js';
export const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
export const COMMAND_TEMPLATE = '/player identifier:{steamId}';
export const SERVER_KEYS = ['atlas', 'vital', 'rustinity', 'building', 'aimtrain', 'official'];
export const sync = value => { need(!value?.then, 'HEX_SYNC_READER_REQUIRED', 503); return value; };
export function configuration(raw) {
  if (raw?.enabled !== true) return { enabled: false };
  need(identifier(raw.revision) && identifier(raw.targetId) && snowflake(raw.guildId) && snowflake(raw.channelId) &&
    snowflake(raw.senderBotId) && snowflake(raw.replyBotId) && snowflake(raw.replyApplicationId) &&
    identifier(raw.transportKey) && raw.commandTemplate === COMMAND_TEMPLATE, 'SOURCE_NOT_CONFIGURED', 503);
  const timeoutMs = raw.timeoutMs ?? 10000, intervalMs = raw.intervalMs ?? 750, messageLimit = raw.messageLimit ?? 20;
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000 &&
    Number.isSafeInteger(intervalMs) && intervalMs >= 250 && intervalMs <= 5000 && intervalMs < timeoutMs &&
    Number.isSafeInteger(messageLimit) && messageLimit >= 1 && messageLimit <= 50, 'SOURCE_NOT_CONFIGURED', 503);
  return { enabled: true, revision: raw.revision, targetId: raw.targetId, guildId: raw.guildId, channelId: raw.channelId,
    senderBotId: raw.senderBotId, replyBotId: raw.replyBotId, replyApplicationId: raw.replyApplicationId,
    transportKey: raw.transportKey, commandTemplate: COMMAND_TEMPLATE, timeoutMs, intervalMs, messageLimit };
}
export function commandPayload(steamId) {
  need(/^7656119\d{10}$/.test(steamId), 'INVALID_DATA', 422);
  const payload = { content: COMMAND_TEMPLATE.replace('{steamId}', steamId), embeds: [], components: [],
    allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
  return { payload, payloadHash: hash(payload) };
}
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}
/** The legacy parser accepts any data and labels it with the supplied Steam ID.
 * Strict independent identity/provenance/completeness checks MUST run first. */
export function parseFreshCard(message, { config, steamId, requestMessageId, notBefore, now }) {
  if (!message || JSON.stringify(message).length > 100000 || !snowflake(message.id) || !snowflake(requestMessageId) ||
    BigInt(message.id) <= BigInt(requestMessageId) || message.channel_id !== config.channelId ||
    message.guild_id != null && message.guild_id !== config.guildId || message.author?.id !== config.replyBotId ||
    message.author?.bot !== true || message.webhook_id != null ||
    message.application_id != null && message.application_id !== config.replyApplicationId ||
    message.application?.id != null && message.application.id !== config.replyApplicationId ||
    message.message_reference?.message_id != null && message.message_reference.message_id !== requestMessageId ||
    message.message_reference?.channel_id != null && message.message_reference.channel_id !== config.channelId) return null;
  const sentAt = Date.parse(message.timestamp);
  if (!Number.isFinite(sentAt) || sentAt < notBefore || sentAt > now + 1000) return null;
  const ids = [...new Set(strings({ content: message.content, embeds: message.embeds, components: message.components,
    attachments: message.attachments }).join('\n').match(/(?<!\d)7656119\d{10}(?!\d)/g) || [])];
  if (ids.length !== 1 || ids[0] !== steamId) return null;
  const parsed = parseHexaytronMessageProfile(message, steamId);
  if (!parsed || parsed.steamId !== steamId || parsed.sourceMessageId !== message.id ||
    !Number.isFinite(parsed.rustHours) || parsed.rustHours < 0 || !Number.isFinite(parsed.firstSeenDaysAgo) || parsed.firstSeenDaysAgo < 0 ||
    parsed.servers.length !== SERVER_KEYS.length || !SERVER_KEYS.every(key => parsed.servers.some(s => s.key === key && Number.isFinite(s.hours) && s.hours >= 0))) return null;
  return parsed;
}
export const collectorProjection = (parsed, observedAt) => ({ servers: parsed.servers, rustHours: parsed.rustHours,
  rustMinutes: parsed.rustMinutes, firstSeenDaysAgo: parsed.firstSeenDaysAgo, sourceMessageId: parsed.sourceMessageId, fetchedAt: observedAt });
