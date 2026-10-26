import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/v2/platform-admin/index.jsx', import.meta.url), 'utf8');
const start = source.indexOf(' async function receipt(){');
const end = source.indexOf('\n const renderTools=', start);
assert.ok(start >= 0 && end > start, 'Use the actual platform page receipt callback');
const receiptSource = source.slice(start, end);

function fixture() {
  const state = { message: null, result: null, retryCount: 0, toasts: [], requests: [] };
  const operation = { current: { id: 'original-operation', path: '/api/v2/platform-admin/discord/actions/card_refresh' } };
  const dirty = { current: false };
  let response = { data: { status: 'queued', result: { state: 'queued', reference: 'original-message-operation' } } };
  const values = {
    operation, dirty,
    client: { request: async path => { state.requests.push(path); return response; } },
    setResult: value => { state.result = value; }, setMessage: value => { state.message = value; },
    notifySuccess: (text, options) => state.toasts.push({ text, ...options }),
    query: { retry: async () => { state.retryCount++; } },
    terminalFailure: { failed: '操作失败，输入已保留，可修改后重新执行。', cancelled: '操作已取消，输入已保留。', skipped: '操作已跳过，未执行变更，输入已保留。' },
    setDraft: () => assert.fail('Card receipt must not replace configuration'),
    displayStatus: value => ({ queued: '已排队', running: '正在处理' })[value] || value,
  };
  const receipt = new Function(...Object.keys(values), `${receiptSource}; return receipt;`)(...Object.values(values));
  return { state, operation, receipt, respond: value => { response = { data: value }; } };
}

test('queued and running card receipts retain recovery; a confirmed success clears the old queued notice', async () => {
  const f = fixture();
  await f.receipt();
  assert.ok(f.operation.current);
  assert.ok(f.state.message);
  f.respond({ status: 'running', result: { state: 'running', reference: 'original-message-operation' } });
  await f.receipt();
  assert.ok(f.operation.current);
  assert.equal(f.state.retryCount, 0);
  f.respond({ status: 'succeeded', result: { state: 'succeeded', reference: 'original-message-operation' } });
  await f.receipt();
  assert.equal(f.operation.current, null);
  assert.equal(f.state.message, null);
  assert.equal(f.state.result.status, 'succeeded');
  assert.equal(f.state.result.result.reference, 'original-message-operation');
  assert.deepEqual(f.state.toasts, [{ text: '操作成功', id: 'original-operation' }]);
  assert.equal(f.state.retryCount, 1);
  assert.ok(f.state.requests.every(path => path === '/api/v2/platform-admin/operations/original-operation'));
});

test('a completed reconciliation with an unknown delivery keeps its explicit warning', async () => {
  const f = fixture();
  f.respond({ status: 'succeeded', result: { state: 'unknown', reference: 'original-message-operation' } });
  await f.receipt();
  assert.equal(f.operation.current, null);
  assert.equal(f.state.message.text, '对账已完成，投递结果仍未知；不会自动重发。');
  assert.equal(f.state.toasts.length, 0);
});

test('a failed card receipt replaces the queued notice with its terminal failure', async () => {
  const f = fixture();
  await f.receipt();
  f.respond({ status: 'failed', result: { state: 'failed', reference: 'original-message-operation' } });
  await f.receipt();
  assert.equal(f.operation.current, null);
  assert.equal(f.state.message.text, '操作失败，输入已保留，可修改后重新执行。');
  assert.equal(f.state.message.error, true);
  assert.equal(f.state.toasts.length, 0);
});

test('pending receipt status remains raw and is translated using the language at render time', async () => {
  const f = fixture();
  await f.receipt();
  assert.equal(f.state.message.status, 'queued');
  const titleStart = source.indexOf('{message&&<Notice');
  const expressionStart = source.indexOf('title={', titleStart) + 'title={'.length;
  const expressionEnd = source.indexOf('}/>', expressionStart);
  assert.ok(titleStart >= 0 && expressionEnd > expressionStart);
  const renderNoticeTitle = new Function('message', 't', 'displayStatus', `return ${source.slice(expressionStart, expressionEnd)};`);
  let english = false;
  const t = (_key, values) => `${english ? 'Receipt status' : '回执状态'}: ${values.value0}`;
  const displayStatus = value => value === 'queued' ? english ? 'Queued' : '已排队' : value;
  assert.equal(renderNoticeTitle(f.state.message, t, displayStatus), '回执状态: 已排队');
  english = true;
  assert.equal(renderNoticeTitle(f.state.message, t, displayStatus), 'Receipt status: Queued');
});
