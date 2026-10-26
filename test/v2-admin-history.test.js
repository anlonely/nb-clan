import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { historyActionLabel, historyEventView, historyFailure, historyPagination, historyPerson, initialHistoryPage, safeHistoryText } from '../src/v2/admin/history-model.js';

const event = () => ({ id: 'private-event-id', type: 'signup.changed', action: 'signup.delegate', occurredAt: '2026-09-08T00:00:00.000Z',
  source: 'kook', wipeRevision: 3, contentRevision: 2, actor: { isSelf: false, label: '当前队长', labelSource: 'current' },
  subject: { label: '当前成员', labelSource: 'current' }, reason: '确认参加', changedFields: ['response','confirmedContentRevision'], state: null,
  signup: { response: 'attending_later', expectedArrivalAt: '2026-09-08T10:00:00.000Z', timeZone: 'Asia/Shanghai', signupRevision: 4, confirmedContentRevision: 2 } });

test('current names are explicitly marked and never reconstructed for redacted people', () => {
  assert.deepEqual(historyPerson({ isSelf: true, label: '当前姓名', labelSource: 'current' }), { text: '本人 · 当前姓名', current: true });
  assert.deepEqual(historyPerson({ isSelf: false, label: '隐藏名称', labelSource: 'redacted' }), { text: '其他操作人', current: false });
  assert.deepEqual(historyPerson({ isSelf: true, label: null, labelSource: 'redacted' }), { text: '本人', current: false });
  assert.deepEqual(historyPerson({ label: '禁止显示', labelSource: 'redacted' }, { subject: true }), { text: '成员', current: false });
  assert.deepEqual(historyPerson({ label: null, labelSource: 'current' }, { subject: true }), { text: '成员', current: false });
});

test('history projection exposes only explicit safe fields, not IDs or private event payload', () => {
  const original = { ...event(), actorAccountId: 'private-account', memberId: 'private-member', operationId: 'private-operation',
    before: { contextToken: 'private-token' }, after: { audience: { memberIds: ['private-member'] } },
    changedFields: ['response', 'actorAccountId', 'contextToken', 'memberId', 'audience', 'response'] };
  const view = historyEventView(original), rendered = JSON.stringify(view);
  for (const forbidden of ['private-event-id','private-account','private-member','private-operation','private-token','actorAccountId','contextToken']) assert.equal(rendered.includes(forbidden), false);
  assert.deepEqual(view.changedFields, ['报名回复','报名受众']);
  assert.equal(view.action, '代填报名'); assert.equal(view.source, 'KOOK');
  assert.deepEqual(view.actor, { text: '当前队长', current: true });
  assert.equal(view.occurredAt, original.occurredAt); assert.equal(view.signup.signupRevision, '4');
});

test('event time and scalar values remain original facts without guessing absent history', () => {
  const view = historyEventView({ ...event(), subject: null, reason: null, state: { lifecycle: 'ended', outcome: 'aborted', signupWindow: 'closed', startMode: null, archiveRevision: null }, signup: null });
  assert.deepEqual(view.state, [['档期状态','已结束'],['结束结果','异常中止'],['报名窗口','报名关闭'],['开始方式','未记录'],['归档版本','未记录']]);
  assert.equal(view.signup, null); assert.equal(view.subject, null); assert.equal(view.reason, null);
  const absent = historyEventView({ ...event(), signup: { response: null, expectedArrivalAt: null, timeZone: null, signupRevision: 0, confirmedContentRevision: null } });
  assert.equal(absent.signup.response, '未记录'); assert.equal(absent.signup.expectedArrivalAt, null); assert.equal(absent.signup.confirmedContentRevision, '未记录');
});

test('known actions translate to concrete Chinese and unknown action keys are not displayed verbatim', () => {
  for (const [action,label] of [['wipe.publish','发布安排'],['wipe.reopen-signup','开放或延长报名'],['wipe.revise-archive','修订归档'],['wipe.confirm-server-start','确认服务器已开服']])
    assert.equal(historyEventView({ ...event(), action }).action, label);
  assert.equal(historyEventView({ ...event(), action: 'private-custom-key' }).action, '报名变更');
  assert.equal(historyEventView({ ...event(), type: 'wipe.changed', action: 'unknown', source: 'unknown' }).source, '其他来源');
  assert.deepEqual(historyEventView({ ...event(), changedFields: ['private-field'] }).changedFields, []);
  assert.equal(historyActionLabel('wipe.create',{lifecycle:'scheduled',signupWindow:'open'}),'创建并开放报名');
  assert.equal(historyActionLabel('wipe.create',{lifecycle:'draft'}),'创建草稿');
});

test('reason is bounded plain text and controls are removed without interpreting HTML', () => {
  const reason = '<img src=x onerror=alert(1)>\u0000\u202e安全原因';
  const view = historyEventView({ ...event(), reason });
  assert.equal(view.reason, '<img src=x onerror=alert(1)>安全原因');
  assert.equal(safeHistoryText('x'.repeat(800)).length, 500);
  assert.equal(safeHistoryText({ html: '<script>' }), '');
});

test('history page stack supports next, previous, and cursor expiry resets the entire snapshot chain', () => {
  const initial = initialHistoryPage(), second = historyPagination(initial, { type: 'next', cursor: 'cursor-2' }), third = historyPagination(second, { type: 'next', cursor: 'cursor-3' });
  assert.deepEqual(third, { cursor: 'cursor-3', previous: ['', 'cursor-2'], resetNotice: false });
  assert.deepEqual(historyPagination(third, { type: 'previous' }), second);
  assert.deepEqual(historyPagination(second, { type: 'previous' }), initial);
  const expired = historyPagination(third, { type: 'expired' });
  assert.deepEqual(expired, { cursor: '', previous: [], resetNotice: true });
  assert.equal(historyPagination(expired, { type: 'previous' }), expired);
  assert.equal(historyPagination(initial, { type: 'next', cursor: null }), initial);
  assert.equal(historyPagination(second, { type: 'next', cursor: 'cursor-2' }), second);
});

test('access errors hide cached events instead of showing unauthorized stale history', () => {
  for (const status of [401,403,404]) assert.equal(historyFailure({ status }).hideData, true);
  assert.match(historyFailure({ status: 403 }).title, /没有查看.*权限/);
  assert.equal(historyFailure({ errorCode: 'CURSOR_EXPIRED' }).hideData, true);
  assert.equal(historyFailure({ status: 503 }), null);
});

test('rendered history treats reason and labels as text and never emits private identities or event payload', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/v2/admin/history.jsx', import.meta.url))], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react'], logLevel: 'silent',
    define: { 'globalThis.navigator': JSON.stringify({ language: 'zh-CN', languages: ['zh-CN'] }) } });
  const module = { exports: {} };
  Function('require','module','exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const markup = renderToStaticMarkup(createElement(module.exports.HistoryEvent, { zone: 'Asia/Shanghai', event: { ...event(),
    actor: { isSelf: false, labelSource: 'current', label: '<script>姓名</script>' },
    reason: '<img src=x onerror=alert(1)>', operationId: 'private-operation-id', before: { privateToken: 'private-token' } } }));
  assert.equal(markup.includes('<script>'), false); assert.equal(markup.includes('<img '), false);
  assert.match(markup, /&lt;script&gt;姓名&lt;\/script&gt;/); assert.match(markup, /当前显示名/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(markup.includes('private-operation-id'), false); assert.equal(markup.includes('private-event-id'), false);
  assert.equal(markup.includes('private-token'), false); assert.match(markup, /2026\/09\/08 08:00/);
  assert.equal(markup.includes('报名版本'), false); assert.equal(markup.includes('提交时档期版本'), false);
});
