import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND,
  DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND,
  DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE,
  DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE,
  INTEGRATION_MESSAGE_REF_HISTORY_LIMIT,
  KOOK_MEMBER_RANKING_MESSAGE_REF_KIND,
  KOOK_TARGET_MESSAGE_REF_TARGET_TYPE,
  WECHAT_SUBSCRIBE_MESSAGE_REF_KIND,
  WECHAT_SUBSCRIBE_MESSAGE_REF_TARGET_TYPE,
  discordCardMessageRefRecord,
  discordMemberReviewMessageRefRecord,
  discordMemberReviewStoredMessageRefs,
  integrationMessageRefId,
  platformCardMessageRefRecord,
  recordDiscordMemberReviewMessageRefs,
  upsertIntegrationMessageRefsInStore
} from '../server/integration-message-refs.js';

test('integration message ref ids normalize stable platform, kind, target, channel, and message parts', () => {
  const longTarget = 'target_'.repeat(40);
  const id = integrationMessageRefId(' discord ', ' member_review_card ', longTarget, ' channel_1 ', ' message_1 ');
  const parts = id.split(':');

  assert.equal(parts[0], 'discord');
  assert.equal(parts[1], 'member_review_card');
  assert.equal(parts[2].length, 160);
  assert.equal(parts[3], 'channel_1');
  assert.equal(parts[4], 'message_1');
});

test('discord member review message refs reject incomplete records and normalize metadata', () => {
  assert.equal(discordMemberReviewMessageRefRecord('', 'channel_1', 'message_1'), null);
  assert.equal(discordMemberReviewMessageRefRecord('application_1', '', 'message_1'), null);
  assert.equal(discordMemberReviewMessageRefRecord('application_1', 'channel_1', ''), null);

  const record = discordMemberReviewMessageRefRecord(' application_1 ', ' channel_1 ', ' message_1 ', '', {
    timestamp: '2026-07-07T00:00:00.000Z',
    source: '',
    action: 'updated',
    discordTargetId: 'target_1',
    discordTargetName: ' NB Discord '
  });

  assert.equal(record.id, 'discord:member_review_card:application_1:channel_1:message_1');
  assert.equal(record.platform, 'discord');
  assert.equal(record.kind, DISCORD_MEMBER_REVIEW_MESSAGE_REF_KIND);
  assert.equal(record.targetType, DISCORD_MEMBER_REVIEW_MESSAGE_REF_TARGET_TYPE);
  assert.equal(record.status, 'active');
  assert.equal(record.source, 'discord_member_review_card');
  assert.equal(record.firstSeenAt, '2026-07-07T00:00:00.000Z');
  assert.deepEqual(record.metadata, {
    action: 'updated',
    targetId: 'target_1',
    targetName: 'NB Discord'
  });
});

test('discord card message refs normalize reusable persistent card targets', () => {
  assert.equal(discordCardMessageRefRecord('', 'discord_target', 'target_1', 'channel_1', 'message_1'), null);
  assert.equal(discordCardMessageRefRecord('member_registration_card', '', 'target_1', 'channel_1', 'message_1'), null);
  assert.equal(discordCardMessageRefRecord('member_registration_card', 'discord_target', '', 'channel_1', 'message_1'), null);

  const record = discordCardMessageRefRecord(
    DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND,
    DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE,
    ' target_1 ',
    ' channel_1 ',
    ' message_1 ',
    '',
    {
      timestamp: '2026-07-08T00:00:00.000Z',
      source: 'discord_member_registration_card_push',
      action: 'push',
      discordTargetId: 'target_1',
      discordTargetName: ' NB Default ',
      metadata: { language: 'en' }
    }
  );

  assert.equal(record.id, 'discord:member_registration_card:target_1:channel_1:message_1');
  assert.equal(record.platform, 'discord');
  assert.equal(record.kind, DISCORD_MEMBER_REGISTRATION_MESSAGE_REF_KIND);
  assert.equal(record.targetType, DISCORD_TARGET_MESSAGE_REF_TARGET_TYPE);
  assert.equal(record.status, 'active');
  assert.equal(record.firstSeenAt, '2026-07-08T00:00:00.000Z');
  assert.deepEqual(record.metadata, {
    action: 'push',
    targetId: 'target_1',
    targetName: 'NB Default',
    language: 'en'
  });
});

test('platform card message refs normalize KOOK reusable persistent card targets', () => {
  assert.equal(platformCardMessageRefRecord('', 'member_ranking_card', 'kook_target', 'target_1', 'channel_1', 'message_1'), null);
  assert.equal(platformCardMessageRefRecord('kook', '', 'kook_target', 'target_1', 'channel_1', 'message_1'), null);
  assert.equal(platformCardMessageRefRecord('kook', 'member_ranking_card', 'kook_target', '', 'channel_1', 'message_1'), null);

  const record = platformCardMessageRefRecord(
    ' kook ',
    KOOK_MEMBER_RANKING_MESSAGE_REF_KIND,
    KOOK_TARGET_MESSAGE_REF_TARGET_TYPE,
    ' kook_ranking_channel_123 ',
    ' kook_ranking_channel_123 ',
    ' kook_message_1 ',
    '',
    {
      timestamp: '2026-07-08T01:00:00.000Z',
      source: 'kook_member_ranking_card_push',
      action: 'created',
      kookTargetId: 'kook_ranking_channel_123',
      metadata: { language: 'zh', metric: 'sulfur' }
    }
  );

  assert.equal(record.id, 'kook:member_ranking_card:kook_ranking_channel_123:kook_ranking_channel_123:kook_message_1');
  assert.equal(record.platform, 'kook');
  assert.equal(record.kind, KOOK_MEMBER_RANKING_MESSAGE_REF_KIND);
  assert.equal(record.targetType, KOOK_TARGET_MESSAGE_REF_TARGET_TYPE);
  assert.equal(record.status, 'active');
  assert.equal(record.source, 'kook_member_ranking_card_push');
  assert.deepEqual(record.metadata, {
    action: 'created',
    targetId: 'kook_ranking_channel_123',
    targetName: '',
    language: 'zh',
    metric: 'sulfur'
  });
});

test('platform card message refs normalize WeChat subscribe message targets', () => {
  const record = platformCardMessageRefRecord(
    ' wechat ',
    WECHAT_SUBSCRIBE_MESSAGE_REF_KIND,
    WECHAT_SUBSCRIBE_MESSAGE_REF_TARGET_TYPE,
    ' wipe_application_1 ',
    ' wechat_user_1 ',
    ' operation_run_1_1 ',
    'refused',
    {
      timestamp: '2026-07-09T01:00:00.000Z',
      source: 'wechat_subscribe_message_push',
      action: 'send',
      metadata: { templateKey: 'wipeOpen', applicationId: 'wipe_application_1' }
    }
  );

  assert.equal(record.id, 'wechat:subscribe_message:wipe_application_1:wechat_user_1:operation_run_1_1');
  assert.equal(record.platform, 'wechat');
  assert.equal(record.kind, WECHAT_SUBSCRIBE_MESSAGE_REF_KIND);
  assert.equal(record.targetType, WECHAT_SUBSCRIBE_MESSAGE_REF_TARGET_TYPE);
  assert.equal(record.targetId, 'wipe_application_1');
  assert.equal(record.channelId, 'wechat_user_1');
  assert.equal(record.messageId, 'operation_run_1_1');
  assert.equal(record.status, 'refused');
  assert.equal(record.source, 'wechat_subscribe_message_push');
  assert.deepEqual(record.metadata, {
    action: 'send',
    targetId: '',
    targetName: '',
    templateKey: 'wipeOpen',
    applicationId: 'wipe_application_1'
  });
});

test('discord member review refs preserve first seen time and keep uneditable refs queryable', () => {
  const store = {
    integrationMessageRefs: [
      discordMemberReviewMessageRefRecord('application_1', 'channel_1', 'existing_message', 'active', {
        timestamp: '2026-01-01T00:00:00.000Z',
        source: 'seed'
      })
    ]
  };

  recordDiscordMemberReviewMessageRefs(store, 'application_1', {
    action: 'sync',
    editedMessages: [
      { channelId: 'channel_1', messageId: 'existing_message' }
    ],
    discordMessage: {
      channel_id: 'channel_1',
      id: 'new_message'
    },
    missingRefs: [
      { channelId: 'channel_1', messageId: 'missing_message', source: 'stored_missing' }
    ],
    uneditableRefs: [
      { channelId: 'channel_1', messageId: 'uneditable_message' }
    ],
    deletedRefs: [
      { channelId: 'channel_1', messageId: 'deleted_message' }
    ]
  }, {
    targetId: 'discord_target_1',
    targetName: 'NB Review',
    memberReviewChannelId: 'channel_1'
  }, {
    action: 'updated',
    source: 'review_card_update'
  });

  const existing = store.integrationMessageRefs.find((ref) => ref.messageId === 'existing_message');
  assert.equal(existing.firstSeenAt, '2026-01-01T00:00:00.000Z');
  assert.equal(existing.source, 'review_card_update');
  assert.equal(existing.metadata.action, 'updated');

  const activeMessageIds = discordMemberReviewStoredMessageRefs(store, 'application_1')
    .map((ref) => ref.messageId)
    .sort();
  assert.deepEqual(activeMessageIds, ['existing_message', 'new_message', 'uneditable_message']);
  assert.equal(store.integrationMessageRefs.some((ref) => ref.messageId === 'missing_message' && ref.status === 'missing'), true);
  assert.equal(store.integrationMessageRefs.some((ref) => ref.messageId === 'deleted_message' && ref.status === 'deleted'), true);
});

test('integration message ref upsert skips invalid records and caps history size', () => {
  const store = { integrationMessageRefs: [] };
  for (let index = 0; index < INTEGRATION_MESSAGE_REF_HISTORY_LIMIT; index += 1) {
    store.integrationMessageRefs.push({
      id: `seed_${index}`,
      platform: 'discord',
      kind: 'member_review_card',
      targetType: 'discord_member_application',
      targetId: 'application_1',
      channelId: 'channel_1',
      messageId: `message_${index}`,
      status: 'active'
    });
  }

  upsertIntegrationMessageRefsInStore(store, [
    null,
    {},
    {
      id: 'new_ref',
      platform: 'discord',
      kind: 'member_review_card',
      targetType: 'discord_member_application',
      targetId: 'application_1',
      channelId: 'channel_1',
      messageId: 'new_message',
      status: 'active'
    }
  ]);

  assert.equal(store.integrationMessageRefs.length, INTEGRATION_MESSAGE_REF_HISTORY_LIMIT);
  assert.equal(store.integrationMessageRefs[0].id, 'new_ref');
  assert.equal(store.integrationMessageRefs.some((ref) => ref.id === `seed_${INTEGRATION_MESSAGE_REF_HISTORY_LIMIT - 1}`), false);
});
