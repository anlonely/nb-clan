import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationInput, buildReconcileInput, createNotificationForm, deliveryLabels, deliveryNeedsPolling,
  intentNeedsPolling, notificationFingerprint, pollDelay, previewInvalidReason, publishIntentInput } from '../src/v2/admin/notification-model.js';

const now = Date.parse('2026-09-08T00:00:00.000Z');
const wipe = { id: 'wipe-one', revision: 4, contentRevision: 3, timeZone: 'Asia/Shanghai', audience: { squadIds: ['squad-one'], memberIds: ['member-one'], includeUnassigned: true } };
const target = { id: 'discord-one', enabled: true, platform: 'discord', configurationRevision: 1, languages: ['zh-CN', 'en'], roleOptions: [{ id: 'role-one', label: 'Member' }], capabilities: { preview: true, send: true, mentionRoles: true, mentionEveryone: false } };
const options = { targets: [target], templates: [{ id: 'wipe-notification', revision: 1, languages: ['zh-CN','en'], purposes: ['signup_open','reminder'] }], allowedPurposes: ['signup_open','reminder'] };
const selectedForm = () => ({ ...createNotificationForm(wipe, options), targets: [{ targetId: 'discord-one', language: 'zh-CN', mentionMode: 'none', roleIds: [] }] });
const build = (form, config = options, extra = {}) => buildNotificationInput(form, wipe, config, { now, ...extra });
const unknown = { id: 'delivery-one', intentId: 'intent-one', wipeId: wipe.id, revision: 2, targetId: target.id, platform: 'discord', language: 'zh-CN', status: 'delivery_unknown', actions: { repeat: true, reconcile: true, lookup: true, retry: false } };
const repeatInstance = 'b22e1b78-d9bf-4f54-b3ce-0a98138f7f29';
const preview = input => ({ id: 'preview-one', wipeId: wipe.id, contentHash: 'hash', revision: 1, contentRevision: wipe.contentRevision, wipeRevision: wipe.revision, rosterRevision: 5, expiresAt: '2026-09-08T00:10:00.000Z', purpose: input.purpose, purposeInstance: input.purposeInstance, targets: [{ target, selection: input.targets[0] }] });

test('notification starts without targets; every explicitly added target defaults to no mention', () => {
  const form = createNotificationForm(wipe, options);
  assert.deepEqual(form.targets, []); assert.equal(form.purposeInstance, 'primary');
  assert.equal(form.duplicateRiskAcknowledged, false); assert.equal(form.repeatOfIntentId, null);
  const input = build(selectedForm());
  assert.deepEqual(input.targets, [{ targetId: target.id, language: 'zh-CN', mentionMode: 'none', roleIds: [] }]);
  assert.equal(input.templateRevision, 1); assert.equal(input.schedule, null);
  assert.equal(input.expectedContentRevision, 3); assert.equal(input.reason, null);
  form.audience.squadIds.push('outside'); assert.deepEqual(wipe.audience.squadIds, ['squad-one']);
});

test('targets and languages use current authorized options and reject duplicate combinations', () => {
  assert.throws(() => build({ ...selectedForm(), targets: [] }), /请选择/);
  assert.throws(() => build(selectedForm(), { ...options, targets: [{ ...target, enabled: false }] }), /停用/);
  assert.throws(() => build(selectedForm(), { ...options, targets: [{ ...target, capabilities: { ...target.capabilities, preview: false } }] }), /预览权限/);
  assert.throws(() => build({ ...selectedForm(), targets: [{ ...selectedForm().targets[0], language: 'ja' }] }), /不支持/);
  assert.throws(() => build({ ...selectedForm(), targets: [...selectedForm().targets, ...selectedForm().targets] }), /重复/);
  assert.equal(build({ ...selectedForm(), targets: [...selectedForm().targets, { ...selectedForm().targets[0], language: 'en' }] }).targets.length, 2);
});

test('no template or unsupported purpose cannot silently fall back', () => {
  assert.throws(() => build(selectedForm(), { ...options, templates: [] }), /正式通知模板/);
  assert.throws(() => build({ ...selectedForm(), purpose: 'result' }), /不允许/);
  assert.throws(() => build(selectedForm(), { ...options, templates: [{ ...options.templates[0], languages: ['en'] }] }), /不支持/);
});

test('mentions enforce current role allowlist and capability, and none never retains role IDs', () => {
  const form = selectedForm(), selection = form.targets[0];
  assert.throws(() => build({ ...form, targets: [{ ...selection, mentionMode: 'everyone' }] }), /提醒全员/);
  assert.throws(() => build({ ...form, targets: [{ ...selection, roleIds: ['role-one'] }] }), /不能附带角色/);
  assert.throws(() => build({ ...form, targets: [{ ...selection, mentionMode: 'roles', roleIds: ['outside'] }] }), /允许列表/);
  assert.throws(() => build({ ...form, targets: [{ ...selection, mentionMode: 'roles', roleIds: [] }] }), /允许列表/);
  assert.deepEqual(build({ ...form, targets: [{ ...selection, mentionMode: 'roles', roleIds: ['role-one','role-one'] }] }).targets[0].roleIds, ['role-one']);
  assert.throws(() => build({ ...form, targets: [{ ...selection, mentionMode: 'roles', roleIds: ['role-one'] }] }, { ...options, targets: [{ ...target, capabilities: { ...target.capabilities, mentionRoles: false } }] }), /权限/);
});

test('audience cannot expand beyond authoritative wipe scope', () => {
  assert.throws(() => build({ ...selectedForm(), audience: { ...wipe.audience, memberIds: ['outside'] } }), /不能超出/);
  assert.throws(() => build({ ...selectedForm(), audience: { ...wipe.audience, squadIds: ['outside'] } }), /不能超出/);
  assert.throws(() => buildNotificationInput(selectedForm(), { ...wipe, audience: { ...wipe.audience, includeUnassigned: false } }, options, { now }), /不能超出/);
  assert.deepEqual(build({ ...selectedForm(), audience: { squadIds: ['squad-one'], memberIds: [], includeUnassigned: false } }).audience, { squadIds: ['squad-one'], memberIds: [], includeUnassigned: false });
});

test('schedule resolves explicit IANA local time and enforces due and expiry bounds', () => {
  const scheduled = { ...selectedForm(), scheduleMode: 'scheduled', dueAtLocal: '2026-09-08T09:00', expiresAtLocal: '2026-09-08T10:00' };
  assert.deepEqual(build(scheduled).schedule, { dueAt: '2026-09-08T01:00:00.000Z', expiresAt: '2026-09-08T02:00:00.000Z' });
  assert.throws(() => build({ ...scheduled, dueAtLocal: '2026-09-08T07:00' }), /发送时间/);
  assert.throws(() => build({ ...scheduled, expiresAtLocal: '2026-09-08T08:59' }), /失效时间/);
  assert.throws(() => build({ ...scheduled, dueAtLocal: '' }), /TIME_INPUT_INVALID/);
});

test('scheduled DST overlap demands explicit offset, rather than guessing', () => {
  const newYork = { ...wipe, timeZone: 'America/New_York' }, form = { ...selectedForm(), scheduleMode: 'scheduled', dueAtLocal: '2026-11-01T01:20', expiresAtLocal: '2026-11-01T01:40' };
  assert.throws(() => buildNotificationInput(form, newYork, options, { now }), /TIME_AMBIGUOUS/);
  assert.equal(buildNotificationInput({ ...form, utcOffset: '-05:00' }, newYork, options, { now }).schedule.dueAt, '2026-11-01T06:20:00.000Z');
});

test('unknown repeat requires explicit risk acknowledgement and new stable intent instance', () => {
  const form = createNotificationForm(wipe, options, { delivery: unknown, intent: { purpose: 'reminder' }, purposeInstance: repeatInstance });
  assert.equal(form.duplicateRiskAcknowledged, false); assert.equal(form.purposeInstance, repeatInstance);
  assert.equal(form.targets[0].mentionMode, 'none'); assert.equal(form.repeatOfIntentId, unknown.intentId);
  assert.throws(() => build(form, options, { repeatDelivery: unknown }), /原因/);
  const justified = { ...form, reason: '已联系频道管理员核实，仍决定再次通知。' };
  assert.throws(() => build(justified, options, { repeatDelivery: unknown }), /明确确认/);
  const acknowledged = { ...justified, duplicateRiskAcknowledged: true };
  assert.equal(build(acknowledged, options, { repeatDelivery: unknown }).duplicateRiskAcknowledged, true);
  assert.throws(() => build({ ...acknowledged, purposeInstance: 'primary' }, options, { repeatDelivery: unknown }), /独立/);
  assert.throws(() => build({ ...acknowledged, targets: [{ ...form.targets[0], language: 'en' }] }, options, { repeatDelivery: unknown }), /原目标/);
  assert.throws(() => build(acknowledged, options, { repeatDelivery: { ...unknown, actions: { repeat: false } } }), /不允许再次通知/);
  assert.equal(unknown.status, 'delivery_unknown');
});

test('ordinary notifications reject hidden repeat parameters', () => {
  assert.throws(() => build({ ...selectedForm(), duplicateRiskAcknowledged: true }), /普通通知/);
  assert.throws(() => build({ ...selectedForm(), repeatOfIntentId: 'another' }), /普通通知/);
  assert.throws(() => build({ ...selectedForm(), purposeInstance: repeatInstance }), /普通通知/);
});

test('preview is invalid after expiry, wipe revision, options revision, permission or user selection changes', () => {
  const input = build(selectedForm()), current = preview(input), valid = { now, previewInput: input };
  assert.equal(previewInvalidReason(current, input, wipe, options, valid), null);
  assert.match(previewInvalidReason(current, input, wipe, options, { ...valid, now: now + 600_000 }), /过期/);
  assert.match(previewInvalidReason(current, input, { ...wipe, revision: 5 }, options, valid), /安排已经更新/);
  assert.match(previewInvalidReason(current, input, wipe, { ...options, targets: [{ ...target, configurationRevision: 2 }] }, valid), /配置或权限/);
  assert.match(previewInvalidReason(current, input, wipe, { ...options, targets: [] }, valid), /配置或权限/);
  assert.match(previewInvalidReason(current, { ...input, purpose: 'reminder' }, wipe, options, valid), /选项已变更/);
  assert.match(previewInvalidReason(current, null, wipe, options, valid), /选项已变更/);
  assert.match(previewInvalidReason(null, input, wipe, options, valid), /先生成/);
});

test('publish command uses the stored preview ID and hash with no synthesized payload', () => {
  const input = build(selectedForm());
  assert.deepEqual(publishIntentInput(preview(input)), { previewId: 'preview-one', contentHash: 'hash', expectedContentRevision: 3, purpose: 'signup_open', purposeInstance: 'primary' });
  assert.equal(notificationFingerprint({ b: 2, a: { z: 1 } }), notificationFingerprint({ a: { z: 1 }, b: 2 }));
  assert.notEqual(notificationFingerprint({ targets: ['a','b'] }), notificationFingerprint({ targets: ['b','a'] }));
});

test('queued and 202 persistence facts are distinguished from sent, with unknown eligible only for read polling', () => {
  assert.equal(deliveryLabels.queued, '已加入投递队列'); assert.equal(deliveryLabels.sent, '已发送');
  assert.equal(deliveryNeedsPolling(unknown), true);
  assert.equal(deliveryNeedsPolling({ status: 'sent' }), false);
  assert.equal(deliveryNeedsPolling({ status: 'sent' }, [{ status: 'running', kind: 'edit' }]), true);
  assert.equal(intentNeedsPolling({ counts: { queued: 0, sending: 0, retry_wait: 0, delivery_unknown: 1 } }), true);
  assert.equal(intentNeedsPolling({ counts: { queued: 0, sending: 0, retry_wait: 0, delivery_unknown: 0 } }), false);
  assert.deepEqual([0,1,2,3,4,100].map(pollDelay), [3000,6000,12000,24000,30000,30000]);
});

test('lookup requests do not invent evidence or a message reference', () => {
  assert.deepEqual(buildReconcileInput(unknown, { decision: 'request_lookup', reason: '检查丢失的发送回执' }), { expectedRevision: 2, decision: 'request_lookup', reason: '检查丢失的发送回执', evidence: '', messageRef: null });
  assert.throws(() => buildReconcileInput({ ...unknown, actions: { ...unknown.actions, lookup: false } }, { decision: 'request_lookup', reason: '核实' }), /权限/);
  assert.throws(() => buildReconcileInput({ ...unknown, status: 'sent' }, { decision: 'request_lookup', reason: '核实' }), /只有/);
});

test('manual not-sent needs evidence before transitioning to an explicitly retryable fact', () => {
  assert.throws(() => buildReconcileInput(unknown, { decision: 'confirmed_not_sent', reason: '核实' }), /证据/);
  assert.throws(() => buildReconcileInput(unknown, { decision: 'confirmed_not_sent', evidence: '平台确认' }), /原因/);
  assert.deepEqual(buildReconcileInput(unknown, { decision: 'confirmed_not_sent', reason: '已核实', evidence: '平台工单确认该请求未创建消息。' }), { expectedRevision: 2, decision: 'confirmed_not_sent', reason: '已核实', evidence: '平台工单确认该请求未创建消息。', messageRef: null });
});

test('manual sent needs matching platform and concrete reference, and preserves nullable platform URL', () => {
  const form = { decision: 'confirmed_sent', reason: '已检查平台记录', evidence: '频道管理员提供该条消息 ID。' };
  assert.throws(() => buildReconcileInput(unknown, form), /消息 ID/);
  const ref = { platform: 'discord', guildId: 'guild-one', channelId: 'channel-one', messageId: 'message-one', messageUrl: null };
  assert.equal(buildReconcileInput(unknown, { ...form, messageRef: ref }).messageRef.messageUrl, null);
  assert.throws(() => buildReconcileInput(unknown, { ...form, messageRef: { ...ref, platform: 'kook' } }), /匹配目标/);
  assert.throws(() => buildReconcileInput(unknown, { ...form, messageRef: { ...ref, messageUrl: 'javascript:alert(1)' } }), /HTTPS/);
  assert.throws(() => buildReconcileInput({ ...unknown, actions: { ...unknown.actions, reconcile: false } }, { ...form, messageRef: ref }), /权限/);
});

test('all-member notification keeps the dynamic audience and cannot widen a restricted wipe', () => {
  const all = {...wipe,audience:{allMembers:true,squadIds:[],memberIds:[],includeUnassigned:true}};
  const form = {...createNotificationForm(all,options),targets:selectedForm().targets};
  assert.equal(buildNotificationInput(form,all,options,{now}).audience.allMembers,true);
  assert.throws(()=>build(form),/不能超出/);
});
