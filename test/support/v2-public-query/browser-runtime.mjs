import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import '../results.mjs';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import puppeteer from 'puppeteer-core';
import { fixture, httpFixture, steam, secrets } from './fixture.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), run = process.env.G07_PUBLIC_QUERY_RUN;
assert.ok(run?.startsWith(root + '/test/support/v2-public-query/.runtime/run-'));
assert.deepEqual(Object.keys(process.env).filter(k => !['PATH', 'LANG', 'TZ', 'NODE_ENV', 'NB_DISABLE_BACKGROUND_JOBS',
  'NB_DISABLE_EXTERNAL_VITAL', 'NB_DISABLE_EXTERNAL_ATLAS', 'G07_PUBLIC_QUERY_RUN', 'NODE_OPTIONS', '__CF_USER_TEXT_ENCODING'].includes(k)), []);
const evidence = path.join(root, 'output/test-results/g07-public-query'), dbFile = path.join(run, 'data.sqlite');
await assert.rejects(access(dbFile));
const report = { environmentKeys: Object.keys(process.env), database: dbFile, viewport: { width: 1440, height: 1050 },
  realEntry: 'src/v2/main.jsx', authentication: 'real G03 session and CSRF; constructed isolated accounts',
  capabilitiesRoute: 'agreed fixture seam; coordinator integrates main route', externalAdapters: false,
  browserErrors: [], blockedRemote: [], cases: [] };
const browser = await puppeteer.launch({ executablePath: chromiumExecutablePath(),
  headless: true, userDataDir: path.join(run, 'chrome'), args: ['--disable-background-networking', '--no-first-run', '--disable-sync'] });
const renderBinary = async (html, format) => {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith('data:') ? request.continue() : request.abort());
    await page.setViewport(report.viewport); await page.setContent(html);
    return format === 'pdf' ? await page.pdf({ format: 'A3', landscape: true, printBackground: true }) : await page.screenshot({ fullPage: true, type: 'png' });
  } finally { await page.close(); }
};
const f = fixture({ file: dbFile, renderBinary }), h = await httpFixture(f, { worker: true });
const dependencyRoot = decodeURIComponent(new URL('../../../node_modules', import.meta.url).pathname);
const config = { root, configFile: false, envFile: false, envDir: false, plugins: [react()],
  cacheDir: path.join(run, 'vite-cache'), resolve: { alias: [
    { find: /^(react(?:-dom)?)(\/.*)?$/, replacement: dependencyRoot + '/$1$2' },
    { find: 'lucide-react', replacement: dependencyRoot + '/lucide-react/dist/esm/lucide-react.js' }] } };
const vite = await createViteServer({ ...config, server: { middlewareMode: true, hmr: { server: h.server },
  watch: { ignored: ['**/.git/**', '**/output/test-results/**', '**/.runtime/**', '**/work/**'] },
  fs: { strict: true, allow: [root, dependencyRoot], deny: ['.env', '.env.*', '**/*.sqlite', '**/*.sqlite-*', '**/.git/**', '**/work/**'] } }, appType: 'custom' });
h.app.use(vite.middlewares);
h.app.use(async (req, res, next) => {
  try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, await readFile(path.join(root, 'test/support/v2-public-query/index.html'), 'utf8'))); }
  catch (error) { next(error); }
});
report.origin = h.origin;
const clean = value => { const text = JSON.stringify(value); for (const secret of secrets) assert.ok(!text.includes(secret), secret); };
async function open(account) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  await page.setViewport(report.viewport); await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().startsWith(h.origin + '/') || request.url().startsWith('data:')) request.continue();
    else { report.blockedRemote.push(request.url()); request.abort(); }
  });
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(`${h.origin}/__fixture/login/${account}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stats-query-form');
  await page.waitForFunction(() => document.querySelector('[aria-label="查询来源"]').value !== '');
  return { context, page };
}
async function typeSteam(page) {
  await page.type('input[placeholder]', steam);
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
}
async function submit(page, text) {
  await page.click('button[type="submit"]');
  await page.waitForFunction(expected => document.querySelector('.stats-job')?.innerText.includes(expected), { timeout: 30000 }, text);
  clean(await page.$eval('.stats-job', e => e.innerText));
}
try {
  await build({ ...config, logLevel: 'warn', build: { outDir: path.join(run, 'build'), emptyOutDir: true,
    rollupOptions: { input: path.join(root, 'test/support/v2-public-query/index.html') } } });
  report.build = 'passed';
  {
    const { page, context } = await open('query_only');
    assert.equal(await page.$eval('[aria-label="查询来源"]', e => e.value), 'member');
    await typeSteam(page);
    const options = await page.$$eval('[aria-label="查询来源"] option', nodes => nodes.map(e => ({ sourceId: e.value, disabled: e.disabled })));
    assert.ok(options.filter(o => o.sourceId !== 'member').every(o => o.disabled));
    await submit(page, '查看 Steam 公开主页');
    const text = await page.$eval('.stats-job', e => e.innerText);
    assert.ok(!text.includes('所属队伍')); assert.ok(!text.includes('当前档期')); assert.ok(!text.includes('成员状态'));
    await page.screenshot({ path: path.join(evidence, 'desktop-member.png'), fullPage: true });
    // Accessible text selection is resolved from the rendered production button.
    await page.evaluate(() => [...document.querySelectorAll('button')].find(e => e.textContent === '导出查询图片').click());
    await page.waitForSelector('a[href$="/file"]', { timeout: 30000 });
    const file = await page.$eval('a[href$="/file"]', async e => {
      const response = await fetch(e.href), bytes = new Uint8Array(await response.arrayBuffer());
      return { url: e.href, status: response.status, type: response.headers.get('content-type'),
        base64: btoa(Array.from(bytes, n => String.fromCharCode(n)).join('')) };
    });
    const bytes = Buffer.from(file.base64, 'base64'); assert.equal(file.status, 200);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(path.join(evidence, 'public-query-export.png'), bytes);
    report.cases.push({ account: 'query_only', defaultSource: 'member', options, resultText: text,
      export: { status: file.status, type: file.type, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
    await context.close();
  }
  {
    const { page, context } = await open('catalog_only');
    assert.equal(await page.$eval('[aria-label="查询来源"]', e => e.value), 'catalog');
    assert.equal(await page.$('input[placeholder]'), null);
    await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    await submit(page, 'vital 隔离目录');
    await page.select('[aria-label="目录来源"]', 'moose');
    await submit(page, 'moose 隔离目录');
    await page.screenshot({ path: path.join(evidence, 'desktop-catalog.png'), fullPage: true });
    await page.select('[aria-label="查询来源"]', 'vital'); await page.type('input[placeholder]', steam);
    await page.waitForFunction(() => document.body.innerText.includes('当前来源不可执行'));
    assert.equal(await page.$eval('button[type="submit"]', e => e.disabled), true);
    report.cases.push({ account: 'catalog_only', defaultSource: 'catalog', catalogProviders: ['vital', 'moose'], playerSubmitDisabled: true });
    await context.close();
  }
  {
    const { page, context } = await open('inventory_only');
    assert.equal(await page.$eval('[aria-label="查询来源"]', e => e.value), 'inventory');
    await typeSteam(page); await submit(page, '隔离库存物品');
    report.cases.push({ account: 'inventory_only', defaultSource: 'inventory', querySucceeded: true });
    await context.close();
  }
  assert.deepEqual(report.browserErrors, []);
  report.providerCalls = f.calls;
  assert.ok(!f.calls.some(c => c.sourceId === 'vital' || c.sourceId === 'moose' || c.sourceId === 'member'));
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; }
finally {
  await browser.close(); await vite.close(); await h.close(); f.db.close();
  assert.throws(() => f.db.prepare('SELECT 1'), /not open|closed/);
  report.closed = { browser: !browser.connected, server: !h.server.listening, database: true };
  await writeFile(path.join(evidence, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
