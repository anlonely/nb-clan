import { normalizeText, nowIso } from './store.js';

const DISCORD_ID_MAX_LENGTH = 32;

export const INTEGRATION_MESSAGE_REF_ACTIVE_STATUS = 'active';
export const INTEGRATION_MESSAGE_REF_INACTIVE_STATUSES = new Set(['missing', 'deleted']);
export const INTEGRATION_MESSAGE_REF_HISTORY_LIMIT = 5000;
export const DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND = 'member_review_card';
export const DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE = 'discord_member_application';
export const DISCORD_WIPE_ATTENDANCE_MESSAGE_REF_KIND = 'wipe_attendance_card';
export const DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND = 'member_registration_card';
export const DISCORD_MEMBER_RANKING_MESSAGE_REF_KIND = 'member_ranking_card';
export const DISCORD_MAP_MESSAGE_REF_KIND = 'map_card';
export const DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE = 'discord_target';
export const DISCORD_KOOK_BRIDGE_MESSAGE_REF_KIND = 'discord_kook_bridge_message';
export const DISCORD_KOOK_BRIDGE_MESSAGE_REF_TARGET_TYPE = 'discord_kook_bridge_route';
export const RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_KIND = 'rustplus_relay_chat_forward';
export const RUSTPLUS_RELAY_CHAT_FORWARD_MESSAGE_REF_TARGET_TYPE = 'rustplus_relay_chat_message';
export const KOOK_MEMBER_RANKING_MESSAGE_REF_KIND = 'member_ranking_card';
export const KOOK_TARGET_MESSAGE_REF_TARGET_TYPE = 'kook_target';
export const WECHAT_SUBSCRIBE_MESSAGE_REF_KIND = 'subscribe_message';
export const WECHAT_SUBSCRIBE_MESSAGE_REF_TARGET_TYPE = 'wechat_subscribe_message';

export function integrationMessageRefId(platform, kind, targetId, channelId, messageId) {
  return [
    normalizeText(platform, 40),
    normalizeText(kind, 80),
    normalizeText(targetId, 160),
    normalizeText(channelId, 80),
    normalizeText(messageId, 80)
  ].join(':');
}

export function upsertIntegrationMessageRefsInStore(store, refs = []) {
  store.integrationMessageRefs ||= [];
  for (const ref of refs) {
    if (!ref?.id) continue;
    const index = store.integrationMessageRefs.findIndex((item) => item.id === ref.id);
    if (index >= 0) {
      store.integrationMessageRefs[index] = {
        ...store.integrationMessageRefs[index],
        ...ref,
        firstSeenAt: store.integrationMessageRefs[index].firstSeenAt || ref.firstSeenAt || ref.createdAt || nowIso()
      };
    } else {
      store.integrationMessageRefs.unshift(ref);
    }
  }
  store.integrationMessageRefs = store.integrationMessageRefs.slice(0, INTEGRATION_MESSAGE_REF_HISTORY_LIMIT);
}

export function discordMemberReviewMessageRefRecord(applicationId, channelId, messageId, status = INTEGRATION_MESSAGE_REF_ACTIVE_STATUS, options = {}) {
  const normalizedApplicationId = normalizeText(applicationId, 120);
  const normalizedChannelId = normalizeText(channelId, DISCORD_ID_MAX_LENGTH);
  const normalizedMessageId = normalizeText(messageId, 80);
  if (!normalizedApplicationId || !normalizedChannelId || !normalizedMessageId) return null;
  const timestamp = normalizeText(options.timestamp || nowIso(), 80);
  return {
    id: integrationMessageRefId('discord', DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND, normalizedApplicationId, normalizedChannelId, normalizedMessageId),
    platform: 'discord',
    kind: DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND,
    targetType: DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE,
    targetId: normalizedApplicationId,
    channelId: normalizedChannelId,
    messageId: normalizedMessageId,
    source: normalizeText(options.source, 80) || 'discord_member_review_card',
    status: normalizeText(status, 40) || INTEGRATION_MESSAGE_REF_ACTIVE_STATUS,
    firstSeenAt: normalizeText(options.firstSeenAt, 80) || timestamp,
    lastSeenAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      action: normalizeText(options.action, 40),
      targetId: normalizeText(options.discordTargetId, 80),
      targetName: normalizeText(options.discordTargetName, 120)
    }
  };
}

export function platformCardMessageRefRecord(platform, kind, targetType, targetId, channelId, messageId, status = INTEGRATION_MESSAGE_REF_ACTIVE_STATUS, options = {}) {
  const normalizedPlatform = normalizeText(platform, 40);
  const normalizedKind = normalizeText(kind, 80);
  const normalizedTargetType = normalizeText(targetType, 120);
  const normalizedTargetId = normalizeText(targetId, 160);
  const normalizedChannelId = normalizeText(channelId, 120);
  const normalizedMessageId = normalizeText(messageId, 120);
  if (!normalizedPlatform || !normalizedKind || !normalizedTargetType || !normalizedTargetId || !normalizedChannelId || !normalizedMessageId) return null;
  const timestamp = normalizeText(options.timestamp || nowIso(), 80);
  return {
    id: integrationMessageRefId(normalizedPlatform, normalizedKind, normalizedTargetId, normalizedChannelId, normalizedMessageId),
    platform: normalizedPlatform,
    kind: normalizedKind,
    targetType: normalizedTargetType,
    targetId: normalizedTargetId,
    channelId: normalizedChannelId,
    messageId: normalizedMessageId,
    source: normalizeText(options.source, 80) || normalizedKind,
    status: normalizeText(status, 40) || INTEGRATION_MESSAGE_REF_ACTIVE_STATUS,
    firstSeenAt: normalizeText(options.firstSeenAt, 80) || timestamp,
    lastSeenAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      action: normalizeText(options.action, 40),
      targetId: normalizeText(options.targetId || options.discordTargetId || options.kookTargetId, 120),
      targetName: normalizeText(options.targetName || options.discordTargetName || options.kookTargetName, 120),
      ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {})
    }
  };
}

export function discordCardMessageRefRecord(kind, targetType, targetId, channelId, messageId, status = INTEGRATION_MESSAGE_REF_ACTIVE_STATUS, options = {}) {
  return platformCardMessageRefRecord('discord', kind, targetType, targetId, channelId, messageId, status, options);
}

export function discordMemberReviewStoredMessageRefs(store, applicationId) {
  const normalizedApplicationId = normalizeText(applicationId, 120);
  if (!normalizedApplicationId) return [];
  return (store.integrationMessageRefs || [])
    .filter((ref) => (
      ref.platform === 'discord' &&
      ref.kind === DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND &&
      ref.targetType === DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE &&
      ref.targetId === normalizedApplicationId &&
      !INTEGRATION_MESSAGE_REF_INACTIVE_STATUSES.has(normalizeText(ref.status, 40))
    ));
}

export function recordDiscordMemberReviewMessageRefs(store, applicationId, upsertResult = {}, settings = {}, options = {}) {
  const timestamp = nowIso();
  const records = [];
  const activeMessages = [
    ...(Array.isArray(upsertResult.editedMessages) ? upsertResult.editedMessages : []),
    upsertResult.discordMessage ? {
      channelId: upsertResult.discordMessage.channel_id || settings.memberReviewChannelId,
      messageId: upsertResult.discordMessage.id
    } : null
  ].filter(Boolean);
  for (const message of activeMessages) {
    const record = discordMemberReviewMessageRefRecord(applicationId, message.channelId, message.messageId, INTEGRATION_MESSAGE_REF_ACTIVE_STATUS, {
      timestamp,
      source: options.source || 'sync',
      action: options.action || upsertResult.action || '',
      discordTargetId: settings.targetId || '',
      discordTargetName: settings.targetName || ''
    });
    if (record) records.push(record);
  }
  for (const ref of Array.isArray(upsertResult.missingRefs) ? upsertResult.missingRefs : []) {
    const record = discordMemberReviewMessageRefRecord(applicationId, ref.channelId, ref.messageId, 'missing', {
      timestamp,
      source: ref.source || 'missing',
      action: options.action || upsertResult.action || '',
      discordTargetId: settings.targetId || '',
      discordTargetName: settings.targetName || ''
    });
    if (record) records.push(record);
  }
  for (const ref of Array.isArray(upsertResult.uneditableRefs) ? upsertResult.uneditableRefs : []) {
    const record = discordMemberReviewMessageRefRecord(applicationId, ref.channelId, ref.messageId, 'uneditable', {
      timestamp,
      source: ref.source || 'uneditable',
      action: options.action || upsertResult.action || '',
      discordTargetId: settings.targetId || '',
      discordTargetName: settings.targetName || ''
    });
    if (record) records.push(record);
  }
  for (const ref of Array.isArray(upsertResult.deletedRefs) ? upsertResult.deletedRefs : []) {
    const record = discordMemberReviewMessageRefRecord(applicationId, ref.channelId, ref.messageId, 'deleted', {
      timestamp,
      source: ref.source || 'deleted',
      action: options.action || upsertResult.action || '',
      discordTargetId: settings.targetId || '',
      discordTargetName: settings.targetName || ''
    });
    if (record) records.push(record);
  }
  upsertIntegrationMessageRefsInStore(store, records);
}
