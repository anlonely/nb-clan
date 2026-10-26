import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackFixture, replyText } from './support/v2-notification-platforms/fixture.mjs';
import { nativeEnvelopes } from './support/v2-notification-platforms/native-envelopes.mjs';

const domainCommand = 'client.connect eu-medium.vitalrust.com:28014';
const address = '168.100.161.200';
const ipCommand = `client.connect ${address}:28014`;
const cases = [
  ['zh-CN', '服务器直连', '备用直连', '复制其中一条命令后在 Rust 控制台执行。'],
  ['en-US', 'Direct connect', 'Alternative direct connect', 'Copy either command and run it in the Rust console.'],
  ['ru', 'Прямое подключение', 'Альтернативное подключение', 'Скопируйте одну из команд и выполните её в консоли Rust.'],
  ['tr', 'Doğrudan bağlan', 'Alternatif bağlantı', 'Komutlardan birini kopyalayıp Rust konsolunda çalıştırın.'],
  ['th', 'เชื่อมต่อโดยตรง', 'การเชื่อมต่อสำรอง', 'คัดลอกคำสั่งใดคำสั่งหนึ่งแล้วรันในคอนโซล Rust'],
  ['ko', '직접 연결', '대체 연결', '명령어 중 하나를 복사한 후 Rust 콘솔에서 실행하세요.'],
  ['de', 'Direct connect', 'Alternative direct connect', 'Copy either command and run it in the Rust console.'],
  [undefined, 'Direct connect', 'Alternative direct connect', 'Copy either command and run it in the Rust console.'],
  ['<@everyone>', 'Direct connect', 'Alternative direct connect', 'Copy either command and run it in the Rust console.'],
];

async function fixture(t, options = {}) {
  const command = Object.hasOwn(options, 'command') ? options.command : domainCommand;
  const ip = Object.hasOwn(options, 'ip') ? options.ip : address;
  const f = await callbackFixture(t);
  f.references.set('connect', { ...f.references.get('connect'), directConnect: command, directConnectIp: ip });
  const native = nativeEnvelopes({ now: () => f.state.now });
  const before = {
    signups: f.scheduling.repo.all('signups'),
    outbox: f.scheduling.repo.all('outbox'),
    receipts: f.scheduling.repo.all('receipts'),
  };
  const handler = f.handler('discord', { verify: native.verifiers.discord });
  return { f, native, handler, assertReadOnly() {
    assert.deepEqual(f.scheduling.repo.all('signups'), before.signups);
    assert.deepEqual(f.scheduling.repo.all('outbox'), before.outbox);
    assert.deepEqual(f.scheduling.repo.all('receipts'), before.receipts);
    assert.equal(f.state.events.some(event => event.startsWith('roles:')), false);
  } };
}

function assertPrivateReply(f) {
  assert.deepEqual(f.acks, [{ type: 5, data: { flags: 64 } }]);
  assert.equal(f.privateReplies.length, 1);
  const reply = f.privateReplies[0];
  assert.equal(reply.platform, 'discord');
  assert.equal(reply.externalId, f.profile.id);
  assert.deepEqual(reply.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.deepEqual(reply.payload.components, []);
  assert.ok(f.state.events.indexOf('ack') < f.state.events.indexOf('private:discord'));
  return replyText(reply);
}

test('signed Discord copy-connect uses the invoking locale for both commands without signup writes', async t => {
  for (const [locale, directLabel, alternativeLabel, instruction] of cases) {
    await t.test(String(locale), async subtest => {
      const { f, native, handler, assertReadOnly } = await fixture(subtest);
      // A differing guild locale must never override the signed user's setting.
      await handler(native.discord('connect', { locale, guild_locale: locale === 'zh-CN' ? 'en-US' : 'zh-CN' }), f.io);
      const body = assertPrivateReply(f);
      const separator = locale === 'zh-CN' ? '：' : ': ';
      assert.equal(body, `${directLabel}${separator}\`${domainCommand}\`\n${alternativeLabel}${separator}\`${ipCommand}\`\n${instruction}`);
      assertReadOnly();
    });
  }
});

test('signed copy-connect rejects invalid IPv4 alternatives and keeps the usable domain command', async t => {
  for (const ip of [null, '', undefined, '168.100.161.200`\n@everyone', '168.100.161.200;quit',
    'alternative.example.test', '168.100.161.999', '::1', '[2001:db8::1]', 168100161200]) {
    await t.test(String(ip), async subtest => {
      const { f, native, handler, assertReadOnly } = await fixture(subtest, { ip });
      await handler(native.discord('connect', { locale: 'en-US', guild_locale: 'zh-CN' }), f.io);
      const body = assertPrivateReply(f);
      assert.equal(body, `Direct connect: \`${domainCommand}\`\nCopy and run it in the Rust console.`);
      assert.doesNotMatch(body, /Alternative direct connect|@everyone|;quit/);
      assertReadOnly();
    });
  }
});

test('signed copy-connect does not add an alternative for an already numeric IP command', async t => {
  for (const command of [`client.connect ${address}:28014`, 'connect 216.39.240.89:28010', 'client.connect [2001:db8::1]:28014']) {
    await t.test(command, async subtest => {
      const { f, native, handler, assertReadOnly } = await fixture(subtest, { command });
      await handler(native.discord('connect', { locale: 'en-US' }), f.io);
      assert.equal(assertPrivateReply(f), `Direct connect: \`${command}\`\nCopy and run it in the Rust console.`);
      assertReadOnly();
    });
  }
});

test('signed copy-connect cannot turn an invalid domain command into a valid IP alternative', async t => {
  for (const command of ['', 'client.connect eu-medium.vitalrust.com:0', 'client.connect eu-medium.vitalrust.com:65536',
    'client.connect eu-medium.vitalrust.com:28014;quit', 'client.connect bad_host.test:28014',
    'client.connect eu-medium.vitalrust.com:28014`\n@everyone']) {
    await t.test(command || 'empty command', async subtest => {
      const { f, native, handler, assertReadOnly } = await fixture(subtest, { command });
      await handler(native.discord('connect', { locale: 'en-US', guild_locale: 'zh-CN' }), f.io);
      assert.equal(assertPrivateReply(f), 'No direct-connect address is available for this wipe.');
      assertReadOnly();
    });
  }
});

test('tampering with the invoking locale after signing never acknowledges or replies', async t => {
  const { f, native, handler, assertReadOnly } = await fixture(t);
  const signed = native.discord('connect', { locale: 'zh-CN', guild_locale: 'en-US' });
  const event = JSON.parse(signed.rawBody.toString('utf8'));
  event.locale = 'en-US';
  await assert.rejects(handler({ ...signed, rawBody: Buffer.from(JSON.stringify(event)) }, f.io));
  assert.deepEqual(f.acks, []);
  assert.deepEqual(f.privateReplies, []);
  assertReadOnly();
});
