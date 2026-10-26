import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import '../results.mjs';
import puppeteer from 'puppeteer-core';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin = process.argv[2];
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const out = 'output/test-results/g07-stats';
await mkdir(out, {
  recursive: true
});
const browser = await puppeteer.launch({
  executablePath: chromiumExecutablePath(),
  headless: true,
  args: ['--disable-background-networking', '--no-first-run']
});
const page = await browser.newPage();
const errors = [],
  requests = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => {
  if (r.url().includes('/api/')) requests.push({
    url: new URL(r.url()).pathname,
    status: r.status()
  });
});
await page.setViewport({
  width: 1440,
  height: 1000
});
await page.setRequestInterception(true);
page.on('request', r => r.url().startsWith(origin) || r.url().startsWith('data:') || r.url().startsWith('blob:') ? r.continue() : r.abort());
async function click(label) {
  await page.waitForFunction(t => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === t), {}, label);
  await page.evaluate(t => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === t).click(), label);
}
async function waitText(text) {
  await page.waitForFunction(t => document.body.innerText.includes(t), {}, text);
}
async function shot(name) {
  await page.screenshot({
    path: `${out}/${name}-1440.png`,
    fullPage: true
  });
}
try {
  await page.goto(origin + '/__fixture/login/admin', {
    waitUntil: 'domcontentloaded'
  });
  await waitText('战绩与历史');
  await waitText('周队');
  await shot('stats');
  await page.setOfflineMode(true);
  await click('重新读取');
  await waitText('显示上次读取的数据');
  await shot('offline');
  await page.setOfflineMode(false);
  await click('重新读取');
  await page.waitForFunction(() => !document.body.innerText.includes('显示上次读取的数据'));
  await click('导入战绩');
  await page.type('dialog textarea', 'steamId,kills,deaths,assists\n76561198000000501,12,3,5');
  await click('校验并预览');
  await waitText('校验通过');
  await shot('import-preview');
  await click('确认导入 1 条');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  await page.goto(origin + '/admin/stats?wipe=g07_active&source=manual_import', {
    waitUntil: 'domcontentloaded'
  });
  await waitText('阿北');
  await page.waitForFunction(() => document.querySelector('.stats-table')?.innerText.includes('5.67'));
  await shot('imported');
  await page.goto(origin + '/admin/stats?wipe=g07_history&source=vital', {
    waitUntil: 'domcontentloaded'
  });
  await click('保存快照修订');
  await page.type('dialog textarea[aria-label="操作原因"]', '隔离验收：保留原快照并记录缺数');
  await click('确认保存');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  await page.goto(origin + '/admin/stats?wipe=g07_history&source=vital&revision=1', {
    waitUntil: 'domcontentloaded'
  });
  await waitText('隔离验收：保留原快照');
  await shot('history-revision');
  await click('隐藏档案');
  await page.type('dialog textarea[aria-label="操作原因"]', '隔离验收隐藏旧档');
  await click('确认保存');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  await waitText('恢复档案');
  await shot('history-hidden');
  await click('恢复档案');
  await page.type('dialog textarea[aria-label="操作原因"]', '隔离验收恢复旧档');
  await click('确认保存');
  await page.waitForFunction(() => !document.querySelector('dialog'));
  await page.goto(origin + '/admin/stats/query', {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForSelector('input[placeholder^="7656119"]');
  await page.type('input[placeholder^="7656119"]', '76561198000000501');
  await click('开始查询');
  await waitText('构造玩家');
  await shot('query-official');
  await click('导出查询图片');
  await waitText('下载 stats-query-');
  await shot('query-image');
  await page.select('.stats-query-form select', 'inventory');
  await click('开始查询');
  await waitText('构造皮肤');
  await shot('inventory');
  await page.goto(origin + '/admin/stats?wipe=g07_history&source=vital&revision=1', {
    waitUntil: 'domcontentloaded'
  });
  await click('导出当前范围');
  await click('生成导出');
  await waitText('下载 stats-');
  await shot('export');
  const file = await page.$eval('dialog a[href$="/file"]', a => a.href);
  const csv = await page.evaluate(async u => await (await fetch(u)).text(), file);
  assert.ok(csv.includes('vital'));
  await writeFile(out + '/browser-export.csv', csv);
  await page.select('dialog select', 'pdf');
  await click('生成导出');
  await page.waitForFunction(() => document.querySelector('dialog a[href$="/file"]')?.textContent.includes('.pdf'));
  const pdfUrl = await page.$eval('dialog a[href$="/file"]', a => a.href);
  const pdf = await page.evaluate(async u => Array.from(new Uint8Array(await (await fetch(u)).arrayBuffer())), pdfUrl);
  assert.equal(Buffer.from(pdf).subarray(0, 4).toString(), '%PDF');
  await writeFile(out + '/browser-export.pdf', Buffer.from(pdf));
  await shot('export-pdf');
  const context = await browser.createBrowserContext(),
    member = await context.newPage();
  await member.setViewport({
    width: 1440,
    height: 1000
  });
  await member.goto(origin + '/__fixture/login/alpha', {
    waitUntil: 'domcontentloaded'
  });
  await member.goto(origin + '/admin/stats?wipe=g07_active&source=manual_import', {
    waitUntil: 'domcontentloaded'
  });
  await member.waitForFunction(() => document.body.innerText.includes('阿北'));
  await member.waitForSelector('.stats-table tbody');
  assert.equal(await member.$eval('.stats-table tbody', e => e.querySelectorAll('tr').length), 1);
  assert.equal(await member.evaluate(() => document.body.innerText.includes('导入战绩')), false);
  await member.screenshot({
    path: out + '/member-scope-1440.png',
    fullPage: true
  });
  await member.goto(origin + '/admin/stats/query', {
    waitUntil: 'domcontentloaded'
  });
  await member.waitForSelector('input[placeholder^="7656119"]');
  await member.type('input[placeholder^="7656119"]', '76561198000000501');
  await member.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '开始查询').click());
  await member.waitForFunction(() => document.body.innerText.includes('当前账号没有这项操作的权限'));
  await member.screenshot({
    path: out + '/permission-denied-1440.png',
    fullPage: true
  });
  await context.close();
  assert.deepEqual(errors, []);
  await writeFile(out + '/browser.json', JSON.stringify({
    viewport: {
      width: 1440,
      height: 1000
    },
    origin,
    browser: await browser.version(),
    errors,
    requests,
    checks: ['admin list', 'CSV import preview and actual SQLite write', 'derived KDA 5.67', 'immutable revision', 'hide and restore', 'official job', 'inventory job', 'CSV download', 'member scope 1 row'],
    externalRequests: 'blocked'
  }, null, 2));
  console.log(JSON.stringify({
    passed: true,
    errors,
    screenshots: 12
  }));
} catch (e) {
  await shot('failure');
  console.error(await page.evaluate(() => document.body.innerText));
  throw e;
} finally {
  await browser.close();
}
