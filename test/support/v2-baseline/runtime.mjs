import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { build } from 'vite';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runDir = process.env.G01_RUN_DIR;
assert.ok(runDir?.startsWith(path.join(root, 'work/v2-g01/run-')));
assert.equal(process.env.NB_DATA_DIR, path.join(runDir, 'data'));
assert.equal(process.env.NB_DISABLE_BACKGROUND_JOBS, '1');
// Prove that the guard is loaded; this must fail before any socket is opened.
const net = await import('node:net');
assert.throws(() => net.connect({ host: 'example.invalid', port: 443 }), { code: 'G01_EGRESS_BLOCKED' });
const outDir = path.join(runDir, 'dist');
await build({ root, configFile: path.join(root, 'vite.config.js'), envDir: runDir, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
const assets = [];
for (const file of await files(outDir)) {
  const bytes = await readFile(file);
  assets.push({ file: path.relative(outDir, file), bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const { ensureStore, updateStore, drainStoreWrites } = await import('../../../server/store.js');
const { closeSqliteDatabases } = await import('../../../server/storage/sqlite.js');
await ensureStore();
const fixture = JSON.parse(await readFile(path.join(runDir, 's1.json')));
await updateStore(store => {
  Object.assign(store, fixture);
  store.syncAutoRules = []; // No provider configuration copied; default settings have no credentials.
});
const { createApiRouter, stopBackgroundJobs } = await import('../../../server/api.js');
const app = express();
app.use('/api', createApiRouter());
app.use(express.static(outDir));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(outDir, 'index.html')));
const server = createServer(app);
let browser;
const result = { label: 'G01 current-code smoke, not V2 acceptance', egressGuard: 'verified', assets, requests: [], pages: [], browserErrors: [] };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'root', password: process.env.NB_ROOT_PASSWORD }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const route of ['/api/auth/me', '/api/members?limit=50&offset=0', '/api/wipes']) {
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      const response = await fetch(`${origin}${route}`, { headers: { Cookie: cookie } });
      const body = await response.text();
      result.requests.push({ route, sample: i + 1, status: response.status, bytes: Buffer.byteLength(body), elapsedMs: +(performance.now() - start).toFixed(3) });
      assert.equal(response.status, 200);
      const payload = JSON.parse(body);
      if (route.includes('/members?')) assert.equal(payload.members.length, 50);
      if (route === '/api/wipes') assert.equal(payload.wipes.length, 20);
    }
  }
  browser = await puppeteer.launch({ executablePath: chromiumExecutablePath(), headless: true, userDataDir: path.join(runDir, 'chrome-profile'), args: ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync'] });
  result.browserVersion = await browser.version();
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => request.url().startsWith(origin + '/') || /^(data|blob):/.test(request.url()) ? request.continue() : request.abort());
  page.on('pageerror', error => result.browserErrors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '登录')?.click());
  await page.waitForSelector('input[type="password"]');
  await page.screenshot({ path: path.join(runDir, 'login-1440.png') });
  result.pages.push({ name: 'login-1440', text: await page.$eval('body', el => el.innerText) });
  const equal = cookie.indexOf('=');
  await browser.setCookie({ name: cookie.slice(0, equal), value: cookie.slice(equal + 1), domain: '127.0.0.1', path: '/', httpOnly: true });
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.nav-item');
  result.nav = await page.$$eval('.nav-item', els => els.map(e => e.innerText));
  // Source navigation order verified in Dashboard.jsx; use observed labels in the report.
  for (const [name, index] of [['members', 1], ['server', 5], ['sync', 14]]) {
    const buttons = await page.$$('.nav-item');
    await buttons[index].click();
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
    await page.screenshot({ path: path.join(runDir, `${name}-1440.png`) });
    result.pages.push({ name: `${name}-1440`, navLabel: result.nav[index], text: await page.$eval('body', el => el.innerText), width: await page.$eval('body', el => el.scrollWidth) });
  }
  // Changing isMobile on an existing page may reload it. Use a separate mobile page
  // and explicitly select the measured view, so screenshots cannot be mislabelled.
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await mobile.setRequestInterception(true);
  mobile.on('request', request => request.url().startsWith(origin + '/') || /^(data|blob):/.test(request.url()) ? request.continue() : request.abort());
  mobile.on('pageerror', error => result.browserErrors.push(error.message));
  await mobile.goto(origin, { waitUntil: 'networkidle0' });
  await mobile.waitForSelector('.nav-item');
  const mobileButtons = await mobile.$$('.nav-item');
  await mobileButtons[14].click();
  await mobile.waitForNetworkIdle({ idleTime: 500, timeout: 15000 });
  assert.match(await mobile.$eval('.nav-item.active', el => el.innerText), /同步中心/);
  await mobile.screenshot({ path: path.join(runDir, 'sync-390.png') });
  await mobile.screenshot({ path: path.join(runDir, 'sync-390-full.png'), fullPage: true });
  result.pages.push({ name: 'sync-390', width: await mobile.$eval('body', el => el.scrollWidth), text: await mobile.$eval('body', el => el.innerText) });
  result.resourceEntries = await page.evaluate(() => performance.getEntriesByType('resource').map(e => ({ name: new URL(e.name).pathname, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize })));
} finally {
  await browser?.close();
  stopBackgroundJobs();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await drainStoreWrites();
  await closeSqliteDatabases();
  await writeFile(path.join(runDir, 'runtime.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify({ requests: result.requests.length, pages: result.pages.map(p => p.name), browserErrors: result.browserErrors }));
