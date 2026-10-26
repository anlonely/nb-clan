import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';

// Isolated test/browser seed only; no transport or production environment.
export function seedOpenSignup(f, { id = 'open-medium', guildId = '1153571748147634236', channelId = '1482399564274204774',
  baseTargetId = 'personal', serverId = '19', serverName = 'Vital Rust 2X EU Medium', status = 'sent', reference = true,
  wipeAt = '2026-10-15T16:00:00.000Z', responses = ['on_time', 'absent', 'late_8h'], creator = true } = {}) {
  const at = '2026-10-14T12:00:00.000Z', targetId = `open-target-${id}`, resource = { kind: 'discordOpenWipe', id };
  const put = (collection, value) => upsertSqliteCollectionRecord(f.db, collection, value.id, value);
  const card = { id, guildId, channelId, baseTargetId, targetId, server: { id: serverId, name: serverName },
    settings: { serverName, serverId, wipeAt, wipeAtLocal: '2026-10-15T17:00', timeZone: 'Europe/London', adaptiveDisplay: true,
      autoConnect: true, directConnect: 'client.connect eu-medium.vitalrust.com:28014', notes: 'Isolated test' },
    ...(creator ? { creator: { externalId: '1167000000000000000' } } : {}), publisher: { externalId: '1168000000000000000', discordPermissions: '8', discordRoleIds: ['secret-role'] },
    publicToken: 'DO_NOT_EXPOSE_PUBLIC_TOKEN', resolvedIp: '168.100.161.200', deliveryId: `delivery-${id}`,
    createdAt: Date.parse(at), updatedAt: Date.parse(at), revision: 1 };
  f.service.repo.put('open-wipe-card', id, 'discord', 'fixture', Date.parse(at), card);
  responses.forEach((response, index) => f.service.repo.put('open-wipe-signup', `${id}-${index}`, 'discord', 'fixture', Date.parse(at), {
    id: `${id}-${index}`, cardId: id, discordId: `117700000000000000${index}`, name: `Discord-only user ${index}`, response, revision: 1, updatedAt: at
  }));
  put('v2NotificationDeliveries', { id: card.deliveryId, resource, targetId, target: { id: targetId, platform: 'discord', guildId, channelId },
    status, createdAt: at, updatedAt: at, payload: { content: 'DO_NOT_EXPOSE_DELIVERY_BODY' }, lastErrorCode: status === 'failed' ? 'PLATFORM_SEND_DENIED' : null });
  if (reference) put('v2NotificationMessageRefs', { id: `ref-${id}`, resource, deliveryId: card.deliveryId, targetId,
    platform: 'discord', guildId, channelId, messageId: '1559929737403568278', state: 'active', updatedAt: at });
  return { card, resource, put };
}
