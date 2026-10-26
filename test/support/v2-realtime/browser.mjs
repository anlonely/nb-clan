import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import '../results.mjs';
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const runtime = JSON.parse(await readFile(process.argv[2], 'utf8')),
  origin = runtime.origin,
  out = 'output/test-results/g07-realtime',
  results = [],
  errors = [],
  external = [];
const browser = await puppeteer.launch({
  executablePath: chromiumExecutablePath(),
  headless: true,
  args: ['--disable-background-networking', '--no-first-run', '--disable-sync']
});
const page = await browser.newPage();
await page.setViewport({
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1
});
await page.setRequestInterception(true);
let delayAlpha=false;
page.on('request', r => {
  if(delayAlpha && r.url().includes('/realtime/alpha/chats')){setTimeout(()=>r.continue().catch(()=>{}),900);return;}
  if (r.url().startsWith(origin) || r.url().startsWith('data:') || r.url().startsWith('blob:')) r.continue();else {
    external.push(r.url());
    r.abort();
  }
});
page.on('pageerror', e => errors.push(e.message));
const wait = async text => page.waitForFunction(t => document.body.innerText.includes(t), {
  timeout: 12000
}, text);
const click = async text => {
  await page.waitForFunction(t => [...document.querySelectorAll('button,a')].some(e => e.textContent.trim() === t || e.getAttribute('aria-label') === t), {
    timeout: 12000
  }, text);
  await page.evaluate(t => {
    const b = [...document.querySelectorAll('button,a')].find(e => e.textContent.trim() === t || e.getAttribute('aria-label') === t);
    if (!b) throw new Error('button not found: ' + t);
    b.click();
  }, text);
};
const shot = async name => {
  await page.screenshot({
    path: `${out}/${name}-1440.png`,
    fullPage: false
  });
};
const control = async data => {
  const r = await fetch(origin + '/__fixture/control', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-fixture-key': runtime.fixtureKey
    },
    body: JSON.stringify(data)
  });
  assert.equal(r.status, 200);
};
try {
  await page.goto(origin + '/__fixture/login/admin');
  await wait('当前战队成员');
  await shot('info');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  results.push('1440 info current roster, clan, source timestamps and squad summary');
  await page.evaluate(() => [...document.querySelectorAll('.rt-person')][0].click());
  await wait('实时成员详情');
  await shot('profile');
  await click('关闭对话框');
  results.push('member profile details');
  await page.type('input[aria-label="搜索邀请记录"]', 'accepted');
  await wait('accepted 32');
  await shot('invites');
  results.push('invites search and status counts');
  await click('导入成员');
  await page.waitForSelector('select[aria-label="导入到队伍"]');
  await page.select('select[aria-label="导入到队伍"]', 'g05_squad');
  await click('确认操作');
  await wait('成员导入服务尚未接线');
  await shot('import-unavailable');
  await click('取消');
  results.push('missing member adapter visibly fails without creating members');
  await page.goto(origin + '/admin/realtime/chat?scope=alpha');
  await wait('开始接收');
  await click('开始接收');
  await wait('实时接收中');
  await wait('守住北门 125');
  await click('加载更早历史');
  await wait('历史 100 条');
  await control({
    action: 'chat',
    n: 88001
  });
  await wait('查看最新消息（1）');
  assert.equal(await page.evaluate(() => document.body.innerText.includes('守住北门 88001')), false);
  await shot('history-live-pending');
  await click('查看最新消息（1）');
  await wait('守住北门 88001');
  results.push('history paging while new live message is buffered then shown without duplicates');
  assert.equal(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-message-id]')].map(e => e.dataset.messageId);
    return ids.length === new Set(ids).size;
  }), true);
  await click('暂停接收');
  await control({
    action: 'chat',
    n: 88002
  });
  await click('开始接收');
  await wait('守住北门 88002');
  results.push('pause and persisted cursor recovery');
  await page.setOfflineMode(true);
  await wait('网络已断开');
  await shot('offline');
  await control({
    action: 'chat',
    n: 88003
  });
  await page.setOfflineMode(false);
  await wait('守住北门 88003');
  await shot('chat-recovered');
  results.push('offline reconnect and missing event replay');
  await page.select('select[aria-label="来源账号 / 服务器"]', 'beta');
  await wait('开始接收');
  await click('开始接收');
  await wait('另一队成员');
  assert.equal(await page.evaluate(() => document.body.innerText.includes('守住北门 88003')), false);
  await shot('switch-server');
  results.push('server switch clears previous chat');
  delayAlpha=true;
  await page.select('select[aria-label="来源账号 / 服务器"]','alpha');
  await click('开始接收');
  await page.select('select[aria-label="来源账号 / 服务器"]','beta');
  await click('开始接收');
  await wait('另一队成员');
  await new Promise(r=>setTimeout(r,1100));
  assert.equal(await page.evaluate(()=>document.body.innerText.includes('守住北门 88003')),false);
  delayAlpha=false;
  results.push('delayed alpha history response cannot overwrite beta after rapid server switch');
  await page.select('select[aria-label="来源账号 / 服务器"]', 'alpha');
  await wait('开始接收');
  await click('开始接收');
  await wait('守住北门 88003');
  await click('清空本地聊天历史');
  await page.type('input[aria-label="操作原因"]', '浏览器隔离验收');
  await click('确认操作');
  await wait('审计与操作回执已保存');
  await wait('当前来源没有聊天记录');
  await shot('clear-complete');
  results.push('CSRF protected clear command, server audit receipt and connected UI reset');
  await control({
    action: 'stale'
  });
  await page.goto(origin + '/admin/realtime/info?scope=alpha');
  await wait('名单已过期');
  await shot('stale');
  results.push('stale observation shows unknown presence');
  await click('重置当前来源');
  await page.type('input[aria-label="操作原因"]','隔离来源重置验收');
  await click('确认操作');
  await wait('来源不可用');
  await shot('reset-complete');
  results.push('scoped source reset through explicit SQLite adapter');
  await page.goto(origin + '/admin/realtime/info?scope=empty');
  await wait('来源不可用');
  await shot('unavailable');
  results.push('unreported source unavailable');
  await page.goto(origin + '/__fixture/login/alpha');
  await wait('当前战队成员');
  assert.equal(await page.evaluate(() => document.body.innerText.includes('清空本地聊天历史')), false);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('select option')].some(o => o.value === 'beta')), false);
  await shot('member-permissions');
  await page.goto(origin + '/admin/realtime/chat?scope=alpha');
  await click('开始接收');
  await wait('实时接收中');
  await control({
    action: 'revoke',
    id: 'alpha'
  });
  await wait('构造管理员登录');
  await shot('revoked');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-message-id]').length), 0);
  results.push('real G03 revoke terminates SSE and clears UI/query identity');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(`${out}/browser.json`, JSON.stringify({
    passed: true,
    viewport: {
      width: 1440,
      height: 1000
    },
    results,
    pageErrors: errors,
    externalRequests: external,
    origin
  }, null, 2));
  console.log(JSON.stringify({
    passed: true,
    results
  }));
} catch (e) {
  await shot('failure');
  console.error(await page.evaluate(() => document.body.innerText));
  throw e;
} finally {
  await browser.close();
}
