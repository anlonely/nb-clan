import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { createWechatLinkFlow, validWechatLinkCode, validWechatLinkQrPayload, wechatLinkExpired, WECHAT_LINK_LOGIN_URL } from '../src/v2/wechat-link-flow.js';
import { workspaceAuthReturnTo } from '../src/v2/router.js';
import { safeAuthReturnTo } from '../src/v2/auth-flow.js';

const NOW = Date.parse('2026-09-24T04:00:00Z');
const challenge = (extra = {}) => ({ linkId: 'link-1', status: 'awaiting_confirmation', expiresAt: new Date(NOW + 300000).toISOString(), profile: { nickName: '测试微信' }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, request) {
  let generation = 0;
  const changes = [], client = { request, getGeneration: () => generation };
  const flow = createWechatLinkFlow({ client, now: () => NOW, onChange: state => changes.push(state) });
  t.after(() => flow.dispose());
  return { flow, changes, changeAccount: () => generation++ };
}

test('wechat linking keeps the KOOK login return target and validates short codes', () => {
  assert.equal(WECHAT_LINK_LOGIN_URL, '/api/v2/auth/kook/start?returnTo=%2Fapp%2Fwechat-link');
  assert.equal(safeAuthReturnTo('/app/wechat-link'), '/app/wechat-link');
  assert.equal(workspaceAuthReturnTo('/app/wechat-link'), '/app/wechat-link');
  assert.equal(validWechatLinkCode('1234 5678'), true);
  for (const code of ['123', '123456789', '1234567a', '１２３４５６７８']) assert.equal(validWechatLinkCode(code), false);
});

test('claim submits once and waits for mini confirmation before reporting success', async t => {
  const pending = deferred(), calls = [];
  const { flow } = fixture(t, (path, options) => { calls.push({ path, options }); return pending.promise; });
  const first = flow.claim('1234 5678'); const duplicate = flow.claim('12345678');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].options.body, { code: '12345678' });
  assert.equal(calls[0].path, '/api/v2/wechat-link/claim');
  pending.resolve({ data: challenge() }); await Promise.all([first, duplicate]);
  assert.equal(flow.getState().challenge.status, 'awaiting_confirmation');
  assert.equal(flow.getState().busy, false);
});

test('reset discards a late claim and cancels its request', async t => {
  const pending = deferred(); let signal;
  const { flow, changes } = fixture(t, (_path, options) => { signal = options.signal; return pending.promise; });
  const first = flow.claim('12345678'); flow.reset(); const count = changes.length;
  pending.resolve({ data: challenge() }); await first;
  assert.equal(signal.aborted, true); assert.equal(changes.length, count); assert.equal(flow.getState().challenge, null);
});

test('polls do not overlap and only server confirmed linked status completes the flow', async t => {
  const pending = deferred(), calls = [];
  const { flow } = fixture(t, async path => { calls.push(path); return path.endsWith('/claim') ? { data: challenge() } : pending.promise; });
  await flow.claim('12345678'); const poll = flow.poll(); await flow.poll();
  assert.equal(calls.length, 2); assert.equal(flow.getState().challenge.status, 'awaiting_confirmation');
  pending.resolve({ data: challenge({ status: 'linked' }) }); await poll;
  assert.equal(flow.getState().challenge.status, 'linked'); await flow.poll(); assert.equal(calls.length, 2);
});

test('a changed account cannot adopt a late target or successful poll', async t => {
  const pending = deferred();
  const { flow, changeAccount, changes } = fixture(t, () => pending.promise);
  const first = flow.claim('12345678'); changeAccount(); const count = changes.length;
  pending.resolve({ data: challenge({ status: 'linked' }) }); await first;
  assert.equal(changes.length, count); assert.equal(flow.getState().challenge, null);
});

test('expired challenges stop polling and invalid QR payloads cannot become visible', async t => {
  const calls = [];
  const { flow } = fixture(t, async path => { calls.push(path); return { data: challenge(path.endsWith('/qr') ? { status: 'pending', qrPayload: 'https://external.example/ticket' } : { expiresAt: new Date(NOW - 1).toISOString() }) }; });
  await flow.claim('12345678'); assert.equal(wechatLinkExpired(flow.getState().challenge, NOW), true);
  await flow.poll(); assert.equal(calls.length, 1);
  flow.reset(); await flow.qr(); assert.equal(flow.getState().error.errorCode, 'INVALID_RESPONSE'); assert.equal(flow.getState().challenge, null);
});

test('a server revoked challenge stops displaying a locally unexpired QR', async t => {
  const { flow } = fixture(t, async path => {
    if (path.endsWith('/qr')) return { data: challenge({ status: 'pending', qrPayload: `nbclan:wechat-link:${'b'.repeat(43)}` }) };
    throw Object.assign(new Error('expired'), { errorCode: 'WECHAT_LINK_EXPIRED' });
  });
  await flow.qr(); await flow.poll(); assert.equal(flow.getState().challenge.status, 'expired');
});

test('QR generation happens locally for an opaque one-time challenge', async () => {
  const payload = `nbclan:wechat-link:${'a'.repeat(43)}`;
  assert.equal(validWechatLinkQrPayload(payload), true);
  assert.equal(validWechatLinkQrPayload('nbclan:wechat-link:short'), false);
  assert.match(await QRCode.toDataURL(payload), /^data:image\/png;base64,/);
  const source = await readFile(new URL('../src/v2/wechat-link.jsx', import.meta.url), 'utf8');
  assert.match(source, /import\('qrcode'\)/); assert.doesNotMatch(source, /https?:\/\/.*(?:qr|chart)/i);
});
