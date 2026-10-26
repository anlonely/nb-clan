import './support/export-concurrency-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { launchOwnedChromium } from '../server/v2/management-adapters/exports/launch.js';
import { createManagedExportRenderer } from '../server/v2/management-adapters/exports/index.js';
import { __chromiumRuntimeForTests as slots } from '../server/chromium-runtime.js';

test('two simultaneous real exports have separate process/profile/context/DOM and share the global bound', async t => {
  assert.equal(slots.maxConcurrency, 2, 'Run using test/support/v2-managed-exports/test.mjs');
  let release, ready;
  const gate = new Promise(r => { release = r; }), entered = new Promise(r => { ready = r; });
  const records = [];
  const owner = createManagedExportRenderer({ concurrency: 2, maxQueue: 0, launch: async options => {
    let child;
    const browser = await launchOwnedChromium(options, process => { child = process; });
    browser.process = () => child;
    const record = { pid: browser.process().pid, directory: options.userDataDir };
    records.push(record);
    const close = browser.close.bind(browser);
    browser.close = async () => {
      const contexts = browser.browserContexts();
      record.privateContextCount = contexts.filter(c => c !== browser.defaultBrowserContext()).length;
      const page = (await browser.pages()).at(-1), cdp = await page.createCDPSession();
      const { root } = await cdp.send('DOM.getDocument');
      record.dom = (await cdp.send('DOM.getOuterHTML', { nodeId: root.nodeId })).outerHTML;
      await close();
    };
    if (records.length === 2) ready();
    await gate; return browser;
  } });
  t.after(async () => { release(); await owner.stop(); });
  const first = owner.renderBinary('<h1>private-alpha-only</h1>', 'png');
  const second = owner.renderBinary('<h1>private-beta-only</h1>', 'pdf');
  const settled = Promise.allSettled([first, second]);
  await entered;
  assert.equal(slots.activeJobs(), 2); assert.equal(owner.diagnostics().active, 2);
  await assert.rejects(owner.renderBinary('third', 'png'), { errorCode: 'EXPORT_CAPACITY' });
  const other = createManagedExportRenderer(); t.after(() => other.stop());
  await assert.rejects(other.renderBinary('global third', 'png'), { errorCode: 'EXPORT_GLOBAL_BUSY' });
  release();
  for (const result of await settled) { assert.equal(result.status, 'fulfilled'); assert.ok(result.value.length > 1000); }
  await owner.stop(); assert.equal(slots.activeJobs(), 0);
  assert.equal(new Set(records.map(r => r.pid)).size, 2);
  assert.equal(new Set(records.map(r => r.directory)).size, 2);
  assert.equal(records.filter(r => r.dom.includes('private-alpha-only')).length, 1);
  assert.equal(records.filter(r => r.dom.includes('private-beta-only')).length, 1);
  for (const r of records) {
    assert.equal(r.privateContextCount, 1);
    assert.ok(!(r.dom.includes('private-alpha-only') && r.dom.includes('private-beta-only')));
    assert.throws(() => process.kill(r.pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(r.directory), { code: 'ENOENT' });
  }
});
