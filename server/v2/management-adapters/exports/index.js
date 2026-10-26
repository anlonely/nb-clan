import { deploymentText } from '../../../branding.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromiumExecutablePath, chromiumLaunchArgs, withChromiumSlot } from '../../../chromium-runtime.js';
import { launchOwnedChromium } from './launch.js';

const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const error = (errorCode, status = 503) => Object.assign(new Error(errorCode), { errorCode, code: errorCode, status, retryable: status === 503 });
const bounded = (value, fallback, min, max, name) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new TypeError(`Invalid ${name}`);
  return n;
};

export function managedExportLaunchArgs({ platform = process.platform, containerMode = process.env.NB_MANAGED_EXPORT_CONTAINER_MODE } = {}) {
  const args = chromiumLaunchArgs();
  // This explicit image setting uses the hardened container as the process boundary:
  // its no-new-privileges/capability policy prevents Chromium's namespace sandbox.
  // Only the offline, script-disabled export renderer uses this compatibility mode.
  if (platform === 'linux' && containerMode === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  return [...new Set(args)];
}

/** No import/factory I/O. The host owns this instance and must await stop before closing its DB.
 * launch is a trusted test/host seam; it does not replace the global Chromium slot.
 */
export function createManagedExportRenderer(options = {}) {
  const limits = Object.freeze({
    concurrency: bounded(options.concurrency, 1, 1, 4, 'concurrency'),
    maxQueue: bounded(options.maxQueue, 2, 0, 16, 'maxQueue'),
    timeoutMs: bounded(options.timeoutMs, 20000, 50, 60000, 'timeoutMs'),
    launchTimeoutMs: bounded(options.launchTimeoutMs, 10000, 50, 30000, 'launchTimeoutMs'),
    cleanupGraceMs: bounded(options.cleanupGraceMs, 1000, 20, 5000, 'cleanupGraceMs'),
    maxHtmlBytes: bounded(options.maxHtmlBytes, 512 * 1024, 128, 2 * 1024 * 1024, 'maxHtmlBytes'),
    maxOutputBytes: bounded(options.maxOutputBytes, 8 * 1024 * 1024, 128, 16 * 1024 * 1024, 'maxOutputBytes'),
    width: bounded(options.width, 1440, 320, 1920, 'width'),
    viewportHeight: bounded(options.viewportHeight, 1000, 200, 2000, 'viewportHeight'),
    maxWidth: bounded(options.maxWidth, 1920, 320, 4096, 'maxWidth'),
    maxHeight: bounded(options.maxHeight, 24000, 200, 40000, 'maxHeight'),
    maxPixels: bounded(options.maxPixels, 32_000_000, 64000, 64_000_000, 'maxPixels'),
    maxDomNodes: bounded(options.maxDomNodes, 15000, 10, 50000, 'maxDomNodes'),
    maxPdfPages: bounded(options.maxPdfPages, 32, 1, 64, 'maxPdfPages')
  });
  if (limits.width > limits.maxWidth || limits.viewportHeight > limits.maxHeight) throw new TypeError('Viewport exceeds document limits');
  const launch = options.launch ?? launchOwnedChromium;
  if (typeof launch !== 'function') throw new TypeError('Invalid launch');
  const queue = [], active = new Set();
  let stopped = false, stoppingPromise;
  let completed = 0, failed = 0, blockedRequests = 0;
  const cleanupFailures = [];

  function check(job) {
    if (job.controller.signal.aborted) throw job.controller.signal.reason;
  }
  function cancel(job, reason) {
    if (!job.controller.signal.aborted) job.controller.abort(reason);
  }
  async function closeBrowser(job) {
    if (!job.browser && !job.child) return;
    if (job.closing) return job.closing;
    job.closing = (async () => {
      const browser = job.browser, child = job.child ?? browser?.process?.();
      // Install exit observer before asking Chrome to close. A timeout is never a release of ownership.
      const exited = job.childExited ?? (child && child.exitCode === null && child.signalCode === null
        ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve());
      const force = setTimeout(() => { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, limits.cleanupGraceMs);
      try {
        const closing = Promise.resolve().then(() => browser ? browser.close() : child?.kill('SIGTERM'));
        // A broken CDP close can hang; process exit is the authoritative completion signal.
        if (child) {
          closing.catch(() => {});
          await exited;
          browser?.disconnect?.();
        } else {
          await closing;
        }
      } finally { clearTimeout(force); }
    })();
    return job.closing;
  }
  async function render(job) {
    let directory, cdp;
    const onAbort = () => { closeBrowser(job).catch(e => cleanupFailures.push(e)); };
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      check(job);
      directory = await mkdtemp(path.join(tmpdir(), 'nb-managed-export-'));
      check(job);
      const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'UTC' };
      if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      // Await the actual launch promise even after abort: a late browser remains owned and is closed below.
      const launchTimer = setTimeout(() => cancel(job, error('EXPORT_TIMEOUT')), Math.min(limits.launchTimeoutMs, limits.timeoutMs));
      try { job.browser = await launch({
        executablePath: chromiumExecutablePath(),
        args: [...managedExportLaunchArgs(), '--disable-background-networking', '--disable-component-update',
          '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check',
          '--host-resolver-rules=MAP * ~NOTFOUND', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
        headless: true, pipe: true, userDataDir: directory, env,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        timeout: Math.min(limits.launchTimeoutMs, limits.timeoutMs), protocolTimeout: limits.timeoutMs,
        signal: job.controller.signal, maxTransportBytes: limits.maxOutputBytes * 2 + 2 * 1024 * 1024,
        defaultViewport: { width: limits.width, height: limits.viewportHeight, deviceScaleFactor: 1 }
      }, (child, exited) => {
        job.child = child; job.childExited = exited;
        if (job.controller.signal.aborted) onAbort();
      }); } finally { clearTimeout(launchTimer); }
      check(job);
      const context = await job.browser.createBrowserContext();
      check(job);
      const page = await context.newPage();
      await page.setJavaScriptEnabled(false);
      await page.setBypassCSP(false);
      await page.setRequestInterception(true);
      page.on('request', request => {
        blockedRequests++;
        request.abort('blockedbyclient').catch(() => {});
      });
      cdp = await page.createCDPSession();
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', { urls: ['*'] });
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
      await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' });
      const { frameTree } = await cdp.send('Page.getFrameTree');
      // CDP sets the document directly, without navigation or document.write/evaluate.
      await cdp.send('Page.setDocumentContent', {
        frameId: frameTree.frame.id,
        html: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${job.html}`
      });
      check(job);
      const counters = await cdp.send('Memory.getDOMCounters');
      if (counters.nodes > limits.maxDomNodes) throw error('EXPORT_DOM_LIMIT', 422);
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 0 || size.height < 0 ||
          size.width > limits.maxWidth || size.height > limits.maxHeight || size.width * size.height > limits.maxPixels)
        throw error('EXPORT_PAGE_LIMIT', 422);
      let bytes;
      if (job.format === 'png') {
        const response = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.max(1, Math.ceil(size.width)), height: Math.max(1, Math.ceil(size.height)), scale: 1 } });
        if (response.data.length > Math.ceil(limits.maxOutputBytes / 3) * 4 + 4) throw error('EXPORT_OUTPUT_LIMIT', 422);
        bytes = Buffer.from(response.data, 'base64');
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw error('EXPORT_INVALID_OUTPUT');
      } else {
        const leaderboard = job.layout === 'leaderboard';
        const margin = leaderboard ? 12 / 25.4 : 0.25;
        const { stream } = await cdp.send('Page.printToPDF', { transferMode: 'ReturnAsStream', printBackground: true,
          paperWidth: 11.69, paperHeight: 8.27, marginTop: margin, marginBottom: margin, marginLeft: margin, marginRight: margin,
          displayHeaderFooter: !leaderboard, headerTemplate: '<div></div>',
          footerTemplate: deploymentText("<div style=\"font:9px Arial,sans-serif;color:#65748b;width:100%;margin:0 11mm;display:flex;justify-content:space-between\"><span>Clan Portal</span><span><span class=\"pageNumber\"></span> / <span class=\"totalPages\"></span></span></div>"),
          preferCSSPageSize: true, generateTaggedPDF: false, pageRanges: `1-${limits.maxPdfPages + 1}` });
        if (!stream) throw error('EXPORT_INVALID_OUTPUT');
        const chunks = []; let length = 0;
        try {
          while (true) {
            check(job);
            const chunk = await cdp.send('IO.read', { handle: stream, size: 65536 });
            const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
            length += data.length;
            if (length > limits.maxOutputBytes) throw error('EXPORT_OUTPUT_LIMIT', 422);
            chunks.push(data);
            if (chunk.eof) break;
          }
        } finally { await cdp.send('IO.close', { handle: stream }).catch(() => {}); }
        bytes = Buffer.concat(chunks, length);
        const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
        if (bytes.subarray(0, 5).toString() !== '%PDF-' || !pages) throw error('EXPORT_INVALID_OUTPUT');
        if (pages > limits.maxPdfPages) throw error('EXPORT_PAGE_LIMIT', 422);
      }
      if (bytes.length > limits.maxOutputBytes) throw error('EXPORT_OUTPUT_LIMIT', 422);
      check(job);
      return bytes;
    } finally {
      job.html = null;
      // Browser close destroys all contexts, pages and CDP sessions, including ones created during cancellation.
      try { await closeBrowser(job); }
      catch (e) { cleanupFailures.push(e); throw e; }
      finally {
        job.controller.signal.removeEventListener('abort', onAbort);
        if (directory) {
          try { await rm(directory, { recursive: true, force: true }); }
          catch (e) { cleanupFailures.push(e); throw e; }
        }
      }
    }
  }
  function pump() {
    while (!stopped && active.size < limits.concurrency && queue.length) {
      const job = queue.shift();
      if (job.controller.signal.aborted) continue;
      active.add(job);
      job.work = (async () => {
        try {
          const result = await withChromiumSlot(() => render(job), { busyCode: 'EXPORT_GLOBAL_BUSY', busyMessage: 'EXPORT_GLOBAL_BUSY' });
          check(job); completed++; job.resolve(result);
        } catch (e) {
          failed++;
          job.reject(job.controller.signal.aborted ? job.controller.signal.reason : e.errorCode ? e : error(e.code === 'EXPORT_GLOBAL_BUSY' ? e.code : 'EXPORT_RENDER_FAILED'));
        } finally { clearTimeout(job.timer); active.delete(job); pump(); }
      })();
    }
  }
  function renderBinary(html, format, renderOptions = {}) {
    if (stopped) return Promise.reject(error('EXPORT_RENDERER_STOPPED'));
    if (typeof html !== 'string' || !['pdf', 'png'].includes(format)) return Promise.reject(error('EXPORT_INVALID_INPUT', 422));
    if (!renderOptions || typeof renderOptions !== 'object' || Array.isArray(renderOptions)) return Promise.reject(error('EXPORT_INVALID_INPUT', 422));
    const layout = renderOptions.layout ?? 'default';
    if (!['default', 'leaderboard'].includes(layout)) return Promise.reject(error('EXPORT_INVALID_INPUT', 422));
    if (Buffer.byteLength(html, 'utf8') > limits.maxHtmlBytes) return Promise.reject(error('EXPORT_HTML_LIMIT', 422));
    if (active.size >= limits.concurrency && queue.length >= limits.maxQueue) return Promise.reject(error('EXPORT_CAPACITY'));
    const job = { html, format, layout, controller: new AbortController() };
    const promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    job.timer = setTimeout(() => {
      cancel(job, error('EXPORT_TIMEOUT'));
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); job.html = null; failed++; job.reject(job.controller.signal.reason); }
    }, limits.timeoutMs);
    queue.push(job); pump(); return promise;
  }
  function stop() {
    if (stoppingPromise) return stoppingPromise;
    stopped = true;
    for (const job of queue.splice(0)) {
      clearTimeout(job.timer); job.html = null; cancel(job, error('EXPORT_RENDERER_STOPPED')); failed++; job.reject(job.controller.signal.reason);
    }
    const jobs = [...active];
    for (const job of jobs) cancel(job, error('EXPORT_RENDERER_STOPPED'));
    stoppingPromise = (async () => {
      await Promise.all(jobs.map(job => job.work));
      if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Export renderer cleanup failed');
    })();
    return stoppingPromise;
  }
  return Object.freeze({ renderBinary, stop, diagnostics: () => ({ stopped, active: active.size, queued: queue.length,
    completed, failed, blockedRequests, limits }) });
}
