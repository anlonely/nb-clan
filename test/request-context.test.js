import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getIp,
  rateLimitKeyPart,
  webOrWechatActorRateLimitKey,
  wechatActorInputRateLimitKey,
  wechatActorRateLimitKey,
  wechatRequestInputRateLimitKey,
  trustProxySetting
} from '../server/request-context.js';

test('request context helpers preserve IP and rate-limit key semantics', () => {
  const previousTrustProxy = process.env.NB_TRUST_PROXY;
  try {
    delete process.env.NB_TRUST_PROXY;
    assert.equal(getIp({
      headers: { 'x-forwarded-for': '203.0.113.8, 198.51.100.1' },
      ip: '198.51.100.2',
      socket: { remoteAddress: '127.0.0.1' }
    }), '127.0.0.1');

    process.env.NB_TRUST_PROXY = '1';
    assert.equal(getIp({
      headers: { 'x-forwarded-for': '203.0.113.8, 198.51.100.1' },
      ip: '198.51.100.2',
      socket: { remoteAddress: '127.0.0.1' }
    }), '198.51.100.2');
    assert.deepEqual(trustProxySetting(), ['loopback']);

    process.env.NB_TRUST_PROXY = '0';
    assert.equal(trustProxySetting(), null);
    assert.equal(getIp({
      ip: '198.51.100.2',
      socket: { remoteAddress: '127.0.0.1' }
    }), '127.0.0.1');

    process.env.NB_TRUST_PROXY = 'loopback, 10.0.0.0/8';
    assert.deepEqual(trustProxySetting(), ['loopback', '10.0.0.0/8']);
    assert.equal(getIp({
      ip: '198.51.100.2',
      socket: { remoteAddress: '127.0.0.1' }
    }), '198.51.100.2');

    process.env.NB_TRUST_PROXY = 'loopback,uniquelocal';
    assert.throws(() => trustProxySetting(), /explicit proxy IP\/CIDR/);

    assert.equal(rateLimitKeyPart('  User   Name  '), 'user name');
    assert.equal(rateLimitKeyPart(''), 'unknown');
    assert.equal(wechatActorRateLimitKey({
      wechatUser: { id: 'WX_User_1' },
      wechatSessionId: 'wechat_session_fallback',
      socket: { remoteAddress: '127.0.0.1' }
    }), 'wechat:wx_user_1');
    assert.equal(webOrWechatActorRateLimitKey({
      user: { id: 'User_Root' },
      wechatUser: { id: 'WX_User_1' },
      socket: { remoteAddress: '127.0.0.1' }
    }), 'actor:user_root');
    assert.equal(wechatRequestInputRateLimitKey({
      body: { steamInput: ' 76561198000000001 ' },
      query: { q: 'ignored' }
    }), 'input:76561198000000001');
    assert.equal(wechatActorInputRateLimitKey({
      wechatSessionId: 'Session A',
      body: { steamId: '76561198000000002' },
      socket: { remoteAddress: '127.0.0.1' }
    }), 'wechat:session a:input:76561198000000002');
  } finally {
    if (previousTrustProxy === undefined) delete process.env.NB_TRUST_PROXY;
    else process.env.NB_TRUST_PROXY = previousTrustProxy;
  }
});
