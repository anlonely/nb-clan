import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import { launchOwnedChromium } from '../server/v2/management-adapters/exports/launch.js';
import { createManagedExportRenderer, managedExportLaunchArgs } from '../server/v2/management-adapters/exports/index.js';
import { createExportRenderer, exportDocument } from '../server/v2/stats/exports.js';
import { __chromiumRuntimeForTests as slots, chromiumLaunchArgs, chromiumExecutablePath } from '../server/chromium-runtime.js';
import { fixture as statsFixture } from './support/v2-stats/fixture.mjs';

const evidence = new URL('../output/test-results/g07-managed-exports/', import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const rejected = promise => promise.then(() => { throw new Error('Expected rejection'); }, e => e);
const code = (e, expected) => assert.equal(e.errorCode, expected);
const fixture = {
  wipe: { id: 'managed-local', title: 'Clan Portal · 本地导出验证' }, sourceId: 'local-fixture', metricVersion: 'v1',
  revision: 7, dataRevision: 2, countScope: 'all',
  items: [{ memberId: 'local-1', displayName: '成员 Alpha', status: 'observed', values: {
    kills: 12, deaths: 3, assists: 6, kd: 4, kda: 6, t3Kills: 2, rockets: 8,
    sulfur: 2000, metalOre: 3000, building: 80, onlineSeconds: 3600, playTimeSeconds: 7200
  } }]
};
function recorder({ capture = false, beforeReturn, stalledClose = false } = {}) {
  const records = [];
  const launch = async options => {
    let child;
    const browser = await launchOwnedChromium(options, process => { child = process; });
    browser.process = () => child;
    const record = { pid: browser.process().pid, directory: options.userDataDir, options, dom: '' };
    records.push(record);
    const createContext = browser.createBrowserContext.bind(browser);
    browser.createBrowserContext = async (...args) => {
      const context = await createContext(...args), newPage = context.newPage.bind(context);
      context.newPage = async (...pageArgs) => {
        const page = await newPage(...pageArgs), createSession = page.createCDPSession.bind(page);
        page.createCDPSession = async () => {
          const session = await createSession(), send = session.send.bind(session);
          session.send = (method, params) => {
            if (method === 'Page.printToPDF') record.print = params;
            return send(method, params);
          };
          return session;
        };
        return page;
      };
      return context;
    };
    const close = browser.close.bind(browser);
    browser.close = async () => {
      if (stalledClose) return new Promise(() => {});
      if (capture) {
        try {
          const page = (await browser.pages()).at(-1);
          const session = await page.createCDPSession();
          const { root } = await session.send('DOM.getDocument');
          record.dom = (await session.send('DOM.getOuterHTML', { nodeId: root.nodeId })).outerHTML;
        } catch { /* A cancellation can already have destroyed CDP. */ }
      }
      await close();
    };
    if (beforeReturn) await beforeReturn(browser, record);
    return browser;
  };
  return { records, launch };
}
async function cleaned(records) {
  for (const record of records) {
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(record.directory), { code: 'ENOENT' });
  }
  assert.equal(slots.activeJobs(), 0);
}

test('factory is lazy; input/config limits and idempotent stop need no Chromium', async () => {
  let launches = 0;
  const r = createManagedExportRenderer({ launch: async () => { launches++; } });
  assert.equal(launches, 0);
  code(await rejected(r.renderBinary(null, 'png')), 'EXPORT_INVALID_INPUT');
  code(await rejected(r.renderBinary('x', 'svg')), 'EXPORT_INVALID_INPUT');
  for (const options of [null, 'leaderboard', { layout: 'unknown' }]) {
    code(await rejected(r.renderBinary('x', 'pdf', options)), 'EXPORT_INVALID_INPUT');
  }
  code(await rejected(r.renderBinary('你'.repeat(200000), 'png')), 'EXPORT_HTML_LIMIT');
  for (const options of [{ concurrency: 0 }, { maxQueue: 17 }, { timeoutMs: Infinity }, { maxPixels: -1 }, { maxWidth: 320 }]) {
    assert.throws(() => createManagedExportRenderer(options), TypeError);
  }
  const stopping = r.stop(); assert.equal(r.stop(), stopping); await stopping;
  code(await rejected(r.renderBinary('x', 'png')), 'EXPORT_RENDERER_STOPPED');
  assert.equal(launches, 0);
});

test('container compatibility is explicit and confined to the managed export process', () => {
  const baseline = chromiumLaunchArgs();
  for (const containerMode of [undefined, '', '0', 'false', 'true']) {
    assert.deepEqual(managedExportLaunchArgs({ platform: 'linux', containerMode: containerMode ?? '' }), baseline);
  }
  assert.deepEqual(managedExportLaunchArgs({ platform: 'darwin', containerMode: '1' }), baseline);
  const compatible = managedExportLaunchArgs({ platform: 'linux', containerMode: '1' });
  assert.deepEqual(compatible, [...new Set([...baseline, '--no-sandbox', '--disable-setuid-sandbox'])]);
  assert.equal(compatible.filter(arg => arg === '--no-sandbox').length, 1);
  assert.equal(compatible.filter(arg => arg === '--disable-setuid-sandbox').length, 1);
  assert.deepEqual(chromiumLaunchArgs(), baseline);
});

test('real PNG/PDF integrate with stats renderer; processes/profiles are isolated and removed', async t => {
  const observed = recorder({ capture: true });
  const r = createManagedExportRenderer({ launch: observed.launch }); t.after(() => r.stop());
  const renderer = createExportRenderer({ renderBinary: r.renderBinary });
  await mkdir(evidence, { recursive: true });
  for (const format of ['png', 'pdf']) {
    const result = await renderer(fixture, { format, ranking: 'kills', language: 'zh', timeZone: 'Asia/Shanghai' });
    const bytes = Buffer.from(result.base64, 'base64');
    assert.ok(bytes.length > 1000);
    assert.equal(result.mime, format === 'png' ? 'image/png' : 'application/pdf');
    if (format === 'png') {
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(bytes.readUInt32BE(16), 1440); assert.ok(bytes.readUInt32BE(20) <= 24000);
    } else assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    await writeFile(new URL(`stats.${format}`, evidence), bytes);
    await cleaned(observed.records);
  }
  assert.equal(new Set(observed.records.map(r => r.pid)).size, 2);
  assert.equal(new Set(observed.records.map(r => r.directory)).size, 2);
  for (const record of observed.records) {
    assert.equal(record.options.executablePath, chromiumExecutablePath());
    for (const arg of chromiumLaunchArgs()) assert.ok(record.options.args.includes(arg));
    assert.equal(record.options.pipe, true);
    assert.deepEqual(Object.keys(record.options.env).sort(), ['LANG', 'PATH', 'TZ']);
    assert.match(record.dom, /Clan Portal/);
    assert.doesNotMatch(record.dom, /NB Clan/);
  }
  assert.equal(observed.records[1].print.displayHeaderFooter, false);
  assert.equal(observed.records[1].print.marginTop, 12 / 25.4);
  assert.match(observed.records[1].print.footerTemplate, /Clan Portal/);
});

test('CSP and disabled JS block script/events/frames/images/styles/fetch; escaped fields remain text', async t => {
  let hits = 0;
  const trap = http.createServer((req, res) => { hits++; res.end('EXTERNAL_CONTENT'); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => trap.close(resolve)));
  const url = `http://127.0.0.1:${trap.address().port}/must-never-load`;
  const observed = recorder({ capture: true });
  const r = createManagedExportRenderer({ launch: observed.launch }); t.after(() => r.stop());
  const attack = `<script>document.body.setAttribute('data-executed','yes');fetch('${url}')</script>`;
  const html = `<body onload="this.setAttribute('data-event-executed','yes')"><h1>Isolation check</h1>${attack}<img src="${url}"><iframe src="${url}"></iframe><link rel="stylesheet" href="${url}"><style>@import url('${url}');body{background-image:url('${url}')}</style><object data="${url}"></object><img src="https://never.invalid/image"><img src="file:///etc/passwd"><p>Safe visible text</p></body>`;
  await writeFile(new URL('isolation.png', evidence), await r.renderBinary(html, 'png'));
  assert.equal(hits, 0);
  assert.doesNotMatch(observed.records[0].dom, /<body[^>]*data-(?:event-)?executed=/);
  assert.match(observed.records[0].dom, /script-src 'none'/);
  const escaped = exportDocument({ ...fixture, wipe: { ...fixture.wipe, title: attack }, items: [{ ...fixture.items[0], displayName: '<img src=x onerror=alert(1)>' }] }, { language: 'en' });
  assert.ok(escaped.html.includes('&lt;script&gt;')); assert.ok(!escaped.html.includes(attack));
  await r.renderBinary(escaped.html, 'png');
  assert.doesNotMatch(observed.records[1].dom, /<script>/);
  assert.doesNotMatch(observed.records[1].dom, /Isolation check/);
  assert.equal(hits, 0);
  await cleaned(observed.records);
});

test('layout, DOM, binary size and PDF page limits reject real Chromium output', async t => {
  for (const [options, html, format, expected] of [
    [{}, '<div style="width:5000px">wide</div>', 'png', 'EXPORT_PAGE_LIMIT'],
    [{ maxDomNodes: 30 }, '<p>x</p>'.repeat(40), 'png', 'EXPORT_DOM_LIMIT'],
    [{ maxOutputBytes: 128 }, '<h1>output bound</h1>', 'png', 'EXPORT_OUTPUT_LIMIT'],
    [{ maxOutputBytes: 128 }, '<h1>output bound</h1>', 'pdf', 'EXPORT_OUTPUT_LIMIT'],
    [{ maxPdfPages: 1 }, '<p>one</p><p style="break-before:page">two</p><p style="break-before:page">three</p>', 'pdf', 'EXPORT_PAGE_LIMIT']
  ]) {
    const observed = recorder(); const r = createManagedExportRenderer({ ...options, launch: observed.launch });
    t.after(() => r.stop());
    code(await rejected(r.renderBinary(html, format)), expected);
    await r.stop(); await cleaned(observed.records);
  }
});

test('stop cancels queue; late launch retains global slot until actual browser exit', async t => {
  const ready = deferred(), release = deferred();
  const observed = recorder({ beforeReturn: async () => { ready.resolve(); await release.promise; } });
  // Deliberately ignore AbortSignal to exercise a late-launch implementation.
  const r = createManagedExportRenderer({ maxQueue: 1, launch: opts => observed.launch({ ...opts, signal: undefined }) });
  t.after(async () => { release.resolve(); await r.stop(); });
  const first = rejected(r.renderBinary('<h1>first</h1>', 'png')); await ready.promise;
  const second = rejected(r.renderBinary('<h1>queued</h1>', 'png'));
  code(await rejected(r.renderBinary('over capacity', 'png')), 'EXPORT_CAPACITY');
  assert.equal(slots.activeJobs(), 1);
  const other = createManagedExportRenderer(); t.after(() => other.stop());
  code(await rejected(other.renderBinary('other owner', 'png')), 'EXPORT_GLOBAL_BUSY');
  let finished = false;
  const stop = r.stop().then(() => { finished = true; });
  code(await second, 'EXPORT_RENDERER_STOPPED');
  await delay(60); assert.equal(finished, false); assert.equal(slots.activeJobs(), 1);
  release.resolve(); await stop;
  code(await first, 'EXPORT_RENDERER_STOPPED');
  await cleaned(observed.records);
});

test('deadline includes launch and queue; timeout cannot release a late browser early', async t => {
  const ready = deferred(), release = deferred();
  const observed = recorder({ beforeReturn: async () => { ready.resolve(); await release.promise; } });
  const r = createManagedExportRenderer({ timeoutMs: 1500, launch: opts => observed.launch({ ...opts, signal: undefined, timeout: 10000 }) });
  t.after(async () => { release.resolve(); await r.stop(); });
  const first = rejected(r.renderBinary('timeout', 'png')); await ready.promise;
  const second = rejected(r.renderBinary('queued timeout', 'png'));
  code(await second, 'EXPORT_TIMEOUT');
  assert.equal(slots.activeJobs(), 1); assert.equal(r.diagnostics().active, 1);
  release.resolve(); code(await first, 'EXPORT_TIMEOUT');
  await r.stop(); await cleaned(observed.records);
});

test('in-flight stop interrupts CDP and waits for process exit', async t => {
  const entered = deferred(), release = deferred();
  const observed = recorder();
  const r = createManagedExportRenderer({ launch: async opts => {
    const browser = await observed.launch(opts);
    const create = browser.createBrowserContext.bind(browser);
    browser.createBrowserContext = async () => { entered.resolve(); await release.promise; return create(); };
    return browser;
  } });
  t.after(async () => { release.resolve(); await r.stop(); });
  const work = rejected(r.renderBinary('in flight', 'png')); await entered.promise;
  const stopping = r.stop(); await delay(50); release.resolve();
  await stopping; code(await work, 'EXPORT_RENDERER_STOPPED'); await cleaned(observed.records);
});

test('launch rejection removes temporary profile and releases global slot', async () => {
  let directory;
  const r = createManagedExportRenderer({ launch: async opts => { directory = opts.userDataDir; throw new Error('launch failed'); } });
  code(await rejected(r.renderBinary('failure', 'png')), 'EXPORT_RENDER_FAILED');
  await r.stop(); await assert.rejects(access(directory), { code: 'ENOENT' });
  assert.equal(slots.activeJobs(), 0);
});

test('real process exits before slot release when Chrome dies before Browser connection', async t => {
  const records = [];
  const r = createManagedExportRenderer({ launch: (opts, observe) => launchOwnedChromium(opts, (child, exited) => {
    records.push({ pid: child.pid, directory: opts.userDataDir });
    observe(child, exited); child.kill('SIGKILL');
  }) });
  t.after(() => r.stop());
  code(await rejected(r.renderBinary('connection failure', 'png')), 'EXPORT_RENDER_FAILED');
  await r.stop(); await cleaned(records);
});

test('launch deadline kills a stopped pre-connection Chrome and awaits close', { skip: process.platform === 'win32' }, async t => {
  const records = [];
  const r = createManagedExportRenderer({ launchTimeoutMs: 150, timeoutMs: 5000, cleanupGraceMs: 50,
    launch: (opts, observe) => launchOwnedChromium({ ...opts, timeout: 5000 }, (child, exited) => {
      records.push({ pid: child.pid, directory: opts.userDataDir });
      observe(child, exited); child.kill('SIGSTOP');
    }) });
  t.after(() => r.stop());
  code(await rejected(r.renderBinary('stopped startup', 'png')), 'EXPORT_TIMEOUT');
  await r.stop(); await cleaned(records);
});

test('stalled browser.close falls back to kill and still waits for real process exit', async t => {
  const observed = recorder({ stalledClose: true });
  const r = createManagedExportRenderer({ cleanupGraceMs: 50, launch: observed.launch }); t.after(() => r.stop());
  const bytes = await r.renderBinary('<h1>force cleanup</h1>', 'png'); assert.ok(bytes.length > 1000);
  await r.stop(); await cleaned(observed.records);
});

test('real stats jobs persist binary results and shutdown failure before DB close', async t => {
  const entered = deferred(), release = deferred(); let hold = false;
  const observed = recorder({ beforeReturn: async () => { if (hold) { entered.resolve(); await release.promise; } } });
  const r = createManagedExportRenderer({ launch: opts => observed.launch({ ...opts, signal: undefined }) });
  const f = statsFixture(':memory:', { renderBinary: r.renderBinary });
  t.after(async () => { release.resolve(); await r.stop(); f.db.close(); });
  const query = { wipeId: 'g07_active', sourceId: 'vital', metricVersion: 'nb-kda-1', ranking: 'kills', language: 'zh', timeZone: 'Asia/Shanghai' };
  const results = [];
  for (const format of ['pdf', 'png']) {
    const op = f.service.createJob(f.admin(), 'export', { ...query, format }, `managed-${format}`);
    await f.service.runJob(op.jobId);
    const job = f.service.readJob(f.admin(), op.jobId);
    assert.equal(job.status, 'succeeded', JSON.stringify(job.result)); assert.ok(Buffer.from(job.result.base64, 'base64').length > 1000);
    results.push({ format, status: job.status, mime: job.result.mime, sha256: job.result.sha256 });
  }
  hold = true;
  const op = f.service.createJob(f.admin(), 'export', { ...query, format: 'png' }, 'managed-stop');
  const running = f.service.runJob(op.jobId); await entered.promise;
  const stopping = r.stop(); release.resolve(); await stopping; await running;
  const failed = f.service.readJob(f.admin(), op.jobId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.result.errorCode, 'EXPORT_RENDERER_STOPPED');
  assert.equal(f.sourceCalls(), 0);
  await cleaned(observed.records);
  await writeFile(new URL('jobs.json', evidence), JSON.stringify({ results, shutdown: { status: failed.status, errorCode: failed.result.errorCode, dbOpenUntilSettled: true }, externalSourceCalls: f.sourceCalls(), remainingSlots: slots.activeJobs() }, null, 2) + '\n');
});
