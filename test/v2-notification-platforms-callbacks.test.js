import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackFixture, replyText, privateButtons, confirmPayload } from './support/v2-notification-platforms/fixture.mjs';
import { createNotificationCallbackHandler, notificationMemberUrl } from '../server/v2/notification-platforms/callbacks.js';

test('Discord late choices and saved receipts use the invoking locale and native local times', async t => {
  const cases = [
    ['en-GB', 'Choose your arrival time', 'Response saved.', 'View schedule and response'],
    ['zh-TW', '请选择预计到场时间', '回复已保存。', '查看当前安排与回复'],
    ['ru', 'Выберите время прибытия', 'Ответ сохранён.', 'Расписание и ответ'],
    ['tr', 'Varış saatinizi seçin', 'Yanıt kaydedildi.', 'Takvim ve yanıtı görüntüle'],
    ['th', 'เลือกเวลาที่จะมาถึง', 'บันทึกคำตอบแล้ว', 'ดูกำหนดการและคำตอบ'],
    ['ko', '도착 시간을 선택하세요', '응답이 저장되었습니다.', '일정 및 응답 보기'],
    ['de', 'Choose your arrival time', 'Response saved.', 'View schedule and response'],
    [undefined, 'Choose your arrival time', 'Response saved.', 'View schedule and response'],
  ];
  for (const [locale, prompt, saved, view] of cases) {
    const f = await callbackFixture(t);
    await f.handler('discord')(f.envelope('discord', 'late', {locale, guild_locale:'zh-CN'}), f.io);
    const reply = f.privateReplies.at(-1);
    assert.ok(replyText(reply).startsWith(prompt));
    assert.ok(replyText(reply).includes('<t:1789056000:F>'));
    assert.doesNotMatch(replyText(reply), /UTC\+8/);
    const button = privateButtons(reply).find(b => b.value?.startsWith('nblate:'));
    assert.doesNotMatch(button.label, /<t:/);
    await f.handler('discord')(f.envelope('discord', null, {locale, interactionId:'locale-confirm', payload:confirmPayload(button)}), f.io);
    const result = f.privateReplies.at(-1);
    assert.ok(replyText(result).startsWith(saved));
    assert.ok(replyText(result).includes('<t:1789056000:F>'));
    assert.equal(privateButtons(result)[0].label, view);
    assert.equal(f.signup().expectedArrivalAt, '2026-09-10T16:00:00.000Z');
    assert.equal(f.signup().signupRevision, 1);
    assert.deepEqual(f.acks, [{type:5,data:{flags:64}}, {type:5,data:{flags:64}}]);
    assert.deepEqual(result.payload.allowed_mentions.parse, []);
  }
});

test('Discord registration and action errors localize without writes; KOOK stays Chinese', async t => {
  const f = await callbackFixture(t);
  await f.handler('discord')(f.envelope('discord', 'register', {locale:'ko'}), f.io);
  assert.match(replyText(f.privateReplies.at(-1)), /Discord로 로그인/);
  assert.equal(privateButtons(f.privateReplies.at(-1))[0].label, '웹사이트에서 등록');
  await f.handler('discord')(f.envelope('discord', 'bad-token', {locale:'en-US'}), f.io);
  assert.match(replyText(f.privateReplies.at(-1)), /^Could not process this action: PLATFORM_ACTION_REFERENCE_INVALID/);
  await f.handler('kook')(f.envelope('kook', 'bad-token', {locale:'en-US'}), f.io);
  assert.match(replyText(f.privateReplies.at(-1)), /^无法处理本次操作/);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

for(const platform of ['discord','kook']) {
  test(`${platform}: ACK precedes real G03 eligibility; returned Promise tracks final private G04 result`,async t=>{
    const f=await callbackFixture(t);let release;
    f.state.wait=new Promise(resolve=>{release=resolve;});let completed=false;
    const pending=f.handler(platform)(f.envelope(platform),f.io).then(()=>{completed=true;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.acks.length,1);assert.equal(completed,false);assert.equal(f.scheduling.repo.all('signups').length,0);
    assert.ok(f.state.events.indexOf('ack')<f.state.events.indexOf(`roles:${platform}`));
    if(platform==='discord')assert.deepEqual(f.acks[0],{type:5,data:{flags:64}});
    else {assert.deepEqual(f.acks[0],{});assert.match(replyText(f.privateReplies[0]),/正在处理报名/);}
    release();await pending;
    assert.equal(completed,true);assert.equal(f.signup().signupRevision,1);assert.match(replyText(f.privateReplies.at(-1)),/回复已保存/);
    for(const r of f.privateReplies) {
      if(platform==='discord') {assert.equal(r.payload.flags,undefined);assert.deepEqual(r.payload.allowed_mentions.parse,[]);}
      else assert.equal(r.payload.temp_target_id,f.profile.id);
    }
    assert.equal(f.scheduling.repo.all('outbox').filter(e=>e.type==='signup.changed').length,1);
  });

  test(`${platform}: an old card saves the reply and later schedule edits preserve it`,async t=>{
    const f=await callbackFixture(t);f.reschedule();
    await f.handler(platform)(f.envelope(platform),f.io);
    assert.equal(f.scheduling.repo.all('signups').length,1);
    assert.match(replyText(f.privateReplies.at(-1)),/回复已保存/);
    assert.equal(f.signup().needsReconfirmation,false);
    const latest=f.scheduling.wipe(f.wipe.id);
    f.scheduling.updateWipe(f.operator,f.wipe.id,{expectedRevision:latest.revision,musterAt:'2026-09-10T08:45:00.000Z'},{operationId:'reschedule-again'});
    assert.equal(f.signup().needsReconfirmation,false);
    assert.equal(f.scheduling.summary(f.operator,f.wipe.id).counts.confirmedAttending,1);
  });

  test(`${platform}: late choices carry shown absolute time and G04 context across database reopen`,async t=>{
    const f=await callbackFixture(t);
    await f.handler(platform)(f.envelope(platform,'late'),f.io);
    const reply=f.privateReplies.at(-1),button=privateButtons(reply).find(b=>b.value?.startsWith('nblate:'));
    if (platform === 'discord') {
      assert.equal(button.label, '开荒 +8 小时');
      assert.match(replyText(reply), new RegExp(`开荒 \\+8 小时：<t:${Date.parse('2026-09-10T16:00:00.000Z') / 1000}:F>`));
      assert.doesNotMatch(replyText(reply), /UTC\+8/u);
    } else assert.match(button.label,/开荒 \+8 小时 · 2026-09-11 00:00 \(UTC\+8\)/);
    const payload=confirmPayload(button);f.restart();
    await f.handler(platform)(f.envelope(platform,null,{interactionId:'late-confirm',payload}),f.io);
    assert.equal(f.signup().response,'attending_later');assert.equal(f.signup().expectedArrivalAt,'2026-09-10T16:00:00.000Z');
    assert.equal(f.signup().confirmedContentRevision,1);assert.match(replyText(f.privateReplies.at(-1)),/回复已保存/);
    if (platform === 'discord') assert.match(replyText(f.privateReplies.at(-1)), new RegExp(`预计到场：<t:${Date.parse('2026-09-10T16:00:00.000Z') / 1000}:F>`));
    else assert.match(replyText(f.privateReplies.at(-1)), /预计到场：2026-09-11 00:00 \(UTC\+8\)/u);
    f.state.now+=600_000;
    await f.handler(platform)(f.envelope(platform,null,{interactionId:'late-confirm',payload}),f.io);
    assert.match(replyText(f.privateReplies.at(-1)),/原操作回执/);assert.equal(f.signup().signupRevision,1);
  });
}

test('Discord 8h and 16h card buttons save exact arrival times through the real callback', async t => {
  for (const [token, arrival] of [['join-8h','2026-09-10T16:00:00.000Z'],['join-16h','2026-09-11T00:00:00.000Z']]) {
    const f = await callbackFixture(t);
    await f.handler('discord')(f.envelope('discord',token),f.io);
    assert.equal(f.signup().response,'attending_later');
    assert.equal(f.signup().expectedArrivalAt,arrival);
    assert.match(replyText(f.privateReplies.at(-1)),/回复已保存/);
    assert.match(replyText(f.privateReplies.at(-1)), new RegExp(`预计到场：<t:${Date.parse(arrival) / 1000}:F>`));
    assert.doesNotMatch(replyText(f.privateReplies.at(-1)), /UTC\+8/u);
  }
});

test('Discord direct connect button responds privately without changing signup', async t => {
  const f = await callbackFixture(t);
  await f.handler('discord')(f.envelope('discord','connect'),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/client\.connect example\.test:28015/u);
  assert.equal(f.scheduling.repo.all('signups').length,0);
  assert.equal(f.privateReplies.length,1);
});

test('Discord register button privately opens the current website onboarding', async t => {
  const f = await callbackFixture(t);
  await f.handler('discord')(f.envelope('discord','register'),f.io);
  const reply = f.privateReplies.at(-1).payload;
  assert.match(reply.content,/Discord 登录并验证 Steam/u);
  assert.match(reply.components[0].components[0].url,/\/api\/v2\/auth\/discord\/start\?returnTo=%2Fapp%2Fme/u);
  assert.equal(f.scheduling.repo.all('signups').length,0);
});

test('unregistered Discord users receive a private registration link for every signup choice', async t => {
  for (const action of ['on-time', 'late', 'join-8h', 'join-16h', 'absent']) {
    await t.test(action, async subtest => {
      const f = await callbackFixture(subtest);
      const mapping = f.identity.identity('discord', f.profile.id);
      f.identity.repo.remove('identities', mapping.id);
      await f.handler('discord')(f.envelope('discord', action, {locale:'en-US'}), f.io);
      const reply = f.privateReplies.at(-1).payload;
      assert.match(reply.content, /complete member registration/u);
      assert.deepEqual(reply.allowed_mentions.parse, []);
      assert.equal(reply.components[0].components[0].url,
        'http://127.0.0.1:4316/api/v2/auth/discord/start?returnTo=%2Fapp%2Fme');
      assert.equal(f.scheduling.repo.all('signups').length, 0);
    });
  }
});

test('both platforms race against the same real signup slot; replay returns original receipt plus current facts',async t=>{
  const f=await callbackFixture(t);
  await Promise.all([f.handler('discord')(f.envelope('discord'),f.io),f.handler('kook')(f.envelope('kook','absent'),f.io)]);
  assert.equal(f.scheduling.repo.all('signups').length,1);assert.equal(f.signup().signupRevision,2);
  assert.equal(f.privateReplies.filter(r=>replyText(r).includes('回复已保存。')).length,2);
  assert.equal(f.privateReplies.filter(r=>replyText(r).startsWith('请确认本次回复')).length,0);
  const winner=f.privateReplies.find(r=>replyText(r).includes('回复已保存。')).platform;
  f.scheduling.saveSignup(f.identity.actorForAccount(f.actor.id),f.wipe.id,f.actor.memberId,{response:null,expectedArrivalAt:null,timeZone:'UTC',
    expectedSignupRevision:2,confirmedContentRevision:1},{operationId:'web-withdraw',source:'web'});
  f.state.now=Date.parse(f.wipe.signupClosesAt);f.restart();
  await f.handler(winner)(f.envelope(winner,winner==='discord'?'on-time':'absent'),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/原操作回执/);
  assert.match(replyText(f.privateReplies.at(-1)),/当前报名状态：未回复/);
  assert.equal(f.scheduling.repo.all('outbox').filter(e=>e.type==='signup.changed').length,3);
});

test('current G03 denial is checked on replay and a role lookup cannot preserve a revoked identity',async t=>{
  const f=await callbackFixture(t);
  await f.handler('discord')(f.envelope('discord'),f.io);
  f.state.roles=[];
  await f.handler('discord')(f.envelope('discord'),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/ELIGIBILITY_DENIED/);
  assert.equal(f.scheduling.repo.all('signups')[0].signupRevision,1);
});

test('verified actor/provider binding protects private confirmations',async t=>{
  const f=await callbackFixture(t);
  await f.handler('discord')(f.envelope('discord','late'),f.io);
  const payload=confirmPayload(privateButtons(f.privateReplies.at(-1)).find(b=>b.value));
  await f.handler('kook')(f.envelope('kook',null,{interactionId:'wrong-provider',payload}),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/SIGNUP_CONFIRMATION_INVALID/);
  assert.equal(f.scheduling.repo.all('signups').length,0);
});

test('unverified, wrong-channel and unaccepted references never reach identity or signup writes',async t=>{
  const f=await callbackFixture(t);
  await assert.rejects(f.handler('discord',{verify(){throw new Error('signature rejected');}})(f.envelope('discord'),f.io),/signature rejected/);
  assert.equal(f.acks.length,0);assert.equal(f.state.events.some(e=>e.startsWith('roles:')),false);
  await f.handler('discord')(f.envelope('discord','on-time',{channelId:'wrong-channel'}),f.io);
  await f.handler('discord')(f.envelope('discord','unaccepted-preview'),f.io);
  assert.equal(f.state.events.some(e=>e.startsWith('roles:')),false);assert.equal(f.scheduling.repo.all('signups').length,0);
  assert.match(replyText(f.privateReplies.at(-1)),/PLATFORM_ACTION_REFERENCE_INVALID/);
});

test('unsigned second body and public claimed wipe/version are ignored in favor of verified reference',async t=>{
  const f=await callbackFixture(t),envelope=f.envelope('discord','on-time',{payload:{kind:'public',wipeId:'wrong',contentRevision:999,action:'not_attending'}});
  envelope.body={provider:'kook',externalId:'wrong',payload:{kind:'confirm',contextToken:'attacker'}};
  await f.handler('discord')(envelope,f.io);
  assert.equal(f.signup().response,'attending_on_time');assert.equal(f.signup().confirmedContentRevision,1);
});

test('cancelled schedule rejects old buttons, and lost private response rejects the tracked Promise without resubmission',async t=>{
  const f=await callbackFixture(t);
  const lost={...f.transport,async respondPrivate(){throw new Error('secret-token must never escape');}};
  await assert.rejects(f.handler('discord',{transport:lost})(f.envelope('discord'),f.io),e=>e.errorCode==='PRIVATE_RESPONSE_UNKNOWN'&&!e.message.includes('secret-token'));
  assert.equal(f.signup().signupRevision,1);
  await f.handler('discord')(f.envelope('discord'),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/原操作回执/);
  const current=f.scheduling.wipe(f.wipe.id);
  f.scheduling.transition(f.operator,f.wipe.id,'cancel',{expectedRevision:current.revision,reason:'fixture-cancel'},{operationId:'cancel'});
  await f.handler('discord')(f.envelope('discord','absent',{interactionId:'late-old-click'}),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/WIPE_IMMUTABLE/);assert.equal(f.signup().signupRevision,1);
});

test('factories require isolated injection; private URL maps the current real G05 route and rejects dangerous origins',()=>{
  assert.throws(()=>createNotificationCallbackHandler({platform:'discord'}),/ISOLATED_TRANSPORT_REQUIRED/);
  assert.equal(notificationMemberUrl('https://example.test','a b'),'https://example.test/app/wipes/a%20b?tab=plan#signup');
  for(const origin of ['javascript:alert(1)','https://user:pass@example.test','https://example.test/extra','https://example.test/'])
    assert.throws(()=>notificationMemberUrl(origin,'wipe'));
});

test('late click against closed schedule offers only the real website view, never an active confirmation button',async t=>{
  const f=await callbackFixture(t);
  f.state.now=Date.parse(f.wipe.signupClosesAt);
  await f.handler('kook')(f.envelope('kook','late'),f.io);
  assert.match(replyText(f.privateReplies.at(-1)),/当前不可报名/);
  assert.ok(privateButtons(f.privateReplies.at(-1)).every(b=>b.url));assert.equal(f.scheduling.repo.all('signups').length,0);
});

test('confirmation displays the scheduled wipe in Shanghai time and offers late arrival choices', async t => {
  const f = await callbackFixture(t);
  const wipe = f.scheduling.wipe(f.wipe.id);
  f.scheduling.updateWipe(f.operator, f.wipe.id, {
    expectedRevision: wipe.revision, serverScheduledWipeAt: '2026-09-24T21:00:00.000Z'
  }, { operationId: 'fixture-server-wipe' });
  await f.handler('kook')(f.envelope('kook', 'late'), f.io);
  const reply = f.privateReplies.at(-1), body = replyText(reply);
  assert.match(body, /服务器计划清档：2026-09-25 05:00 \(UTC\+8\)/);
  assert.match(body, /当前报名状态：未回复/);
  const lateButtons = privateButtons(reply).filter(button => button.value?.startsWith('nblate:'));
  assert.deepEqual(lateButtons.map(button => button.label), [
    '开荒 +8 小时 · 2026-09-25 13:00 (UTC+8)',
    '开荒 +16 小时 · 2026-09-25 21:00 (UTC+8)'
  ]);
});

test('Discord confirmation shows localized wipe and arrival timestamps in the body, not button labels', async t => {
  const f = await callbackFixture(t), scheduled = '2026-09-24T21:00:00.000Z';
  const wipe = f.scheduling.wipe(f.wipe.id);
  f.scheduling.updateWipe(f.operator, f.wipe.id, {
    expectedRevision: wipe.revision, serverScheduledWipeAt: scheduled
  }, { operationId: 'fixture-discord-server-wipe' });
  await f.handler('discord')(f.envelope('discord', 'late'), f.io);
  const reply = f.privateReplies.at(-1), body = replyText(reply), start = Date.parse(scheduled) / 1000;
  assert.match(body, new RegExp(`服务器计划清档：<t:${start}:F>`));
  for (const hours of [8, 16]) assert.match(body, new RegExp(`开荒 \\+${hours} 小时：<t:${start + hours * 3600}:F>`));
  assert.doesNotMatch(body, /UTC\+8|2026-09-25/u);
  const lateButtons = privateButtons(reply).filter(button => button.value?.startsWith('nblate:'));
  assert.deepEqual(lateButtons.map(button => button.label), ['开荒 +8 小时', '开荒 +16 小时']);
  assert.deepEqual(lateButtons.map(button => Number(button.value.split(':').at(-1))), [(start + 8 * 3600) * 1000, (start + 16 * 3600) * 1000]);
});
