import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/guides/tutorial-video.js', import.meta.url), 'utf8');
const origin = 'https://nb.example.test';
const workerUrl = `${origin}/guides/tutorial-media-sw.js?v=media-cache-3`;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function browser({ dialog = false, visible = true, connection = {}, supported = true,
  registration = 'resolve', controlled = false } = {}) {
  const posts = [], assignments = [], registrations = [], timers = new Map();
  const documentListeners = new Map(), workerListeners = new Map(), observers = [];
  let now = 0, timerId = 0, completeRegistration;
  const add = (listeners, name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
  };
  const emit = (listeners, name) => { for (const fn of [...(listeners.get(name) || [])]) fn(); };
  const worker = { scriptURL: workerUrl, postMessage(message) { posts.push(JSON.parse(JSON.stringify(message))); } };
  const serviceWorker = {
    controller: controlled ? worker : null,
    register(url, options) {
      registrations.push({ url, options: JSON.parse(JSON.stringify(options)) });
      if (registration === 'reject') return Promise.reject(new Error('registration unavailable'));
      if (registration === 'pending') return new Promise(resolve => { completeRegistration = resolve; });
      return Promise.resolve({});
    },
    addEventListener: (name, callback) => add(workerListeners, name, callback),
    removeEventListener: (name, callback) => workerListeners.get(name)?.delete(callback),
  };
  const dialogElement = dialog ? { open: false } : null;
  let src = '';
  const video = {
    dataset: { tutorialSrc: '/guides/current-tutorial.mp4?v=test' },
    closest: name => name === 'dialog' ? dialogElement : null,
    get src() { return src; },
    set src(value) {
      src = new URL(value, origin).href;
      assignments.push({ src, controlled: serviceWorker.controller?.scriptURL === workerUrl });
    },
  };
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    querySelectorAll: () => [video],
    addEventListener: (name, callback) => add(documentListeners, name, callback),
  };
  const navigator = { connection, ...(supported ? { serviceWorker } : {}) };
  vm.runInNewContext(source, {
    URL, location: { origin }, navigator, document,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { observers.push({ target, callback: this.callback }); }
    },
  }, { filename: 'tutorial-video.js' });
  return {
    posts, assignments, registrations, video, connection,
    async settle() { await flush(); },
    async takeControl(scriptURL = workerUrl) {
      serviceWorker.controller = scriptURL === workerUrl ? worker : { scriptURL };
      emit(workerListeners, 'controllerchange');
      await flush();
    },
    async open(value = true) {
      dialogElement.open = value;
      for (const observer of observers) if (observer.target === dialogElement) observer.callback();
      await flush();
    },
    async visibility(value) {
      document.visibilityState = value ? 'visible' : 'hidden';
      emit(documentListeners, 'visibilitychange');
      await flush();
    },
    async resolveRegistration() { completeRegistration?.({}); await flush(); },
    async advance(ms) {
      const until = now + ms;
      await flush();
      while (true) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        timers.delete(id); now = timer.at; timer.callback();
        await flush();
      }
      now = until;
    },
  };
}

test('public guide pages work without bundled community videos or screenshots', () => {
  for (const file of ['kook-steam-binding.html', 'electricians.html', 'kook-steam-binding-en.html', 'discord-steam-binding.html']) {
    const html = readFileSync(new URL(`../public/guides/${file}`, import.meta.url), 'utf8');
    assert.match(html, /<h[12]/);
    assert.doesNotMatch(html, /(?:src|poster|data-tutorial-src)="[^"]+\.(?:mp4|jpg|png)/);
    assert.doesNotMatch(html, /nb\.anlonely\.me/);
  }
});

test('binding guide waits for this worker before assigning src, then warms only its own video', async () => {
  const page = browser();
  await page.settle();
  assert.equal(page.registrations.length, 1);
  assert.equal(page.registrations[0].url, workerUrl);
  assert.equal(page.registrations[0].options.scope, '/guides/');
  assert.equal(page.assignments.length, 0);
  await page.takeControl(`${origin}/some-other-worker.js`);
  assert.equal(page.assignments.length, 0, 'an unrelated controller must not start media loading');
  await page.takeControl();
  assert.deepEqual(page.assignments, [{ src: `${origin}/guides/current-tutorial.mp4?v=test`, controlled: true }]);
  assert.deepEqual(page.posts, [{ type: 'CACHE_TUTORIAL', url: page.video.src }]);
  await page.visibility(false);
  await page.visibility(true);
  assert.equal(page.posts.length, 1, 'returning to the guide must not prefetch again');
});

test('electrician list does not warm a closed dialog, and repeated opens warm only once', async () => {
  const page = browser({ dialog: true, controlled: true });
  await page.settle();
  assert.equal(page.posts.length, 0);
  await page.visibility(false);
  await page.visibility(true);
  assert.equal(page.posts.length, 0);
  await page.open();
  assert.deepEqual(page.posts, [{ type: 'CACHE_TUTORIAL', url: page.video.src }]);
  await page.open(false);
  await page.open();
  await page.open();
  assert.equal(page.posts.length, 1);
});

test('opening the dialog while worker setup is pending still warms after control arrives', async () => {
  const page = browser({ dialog: true });
  await page.open();
  assert.equal(page.assignments.length, 0);
  assert.equal(page.posts.length, 0);
  await page.takeControl();
  assert.equal(page.assignments.length, 1);
  assert.equal(page.assignments[0].controlled, true);
  assert.equal(page.posts.length, 1);
});

test('saveData and slow cellular connections suppress warming without disabling native playback', async () => {
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }, { effectiveType: 'slow-2g' }]) {
    const page = browser({ controlled: true, connection, dialog: true });
    await page.settle();
    await page.open();
    assert.equal(page.posts.length, 0, JSON.stringify(connection));
    assert.equal(page.video.src, `${origin}/guides/current-tutorial.mp4?v=test`);
    assert.equal(page.assignments.length, 1);
  }
});

test('a hidden binding page waits until it becomes visible to warm', async () => {
  const page = browser({ controlled: true, visible: false });
  await page.settle();
  assert.equal(page.posts.length, 0);
  await page.visibility(true);
  assert.equal(page.posts.length, 1);
});

test('missing service workers or registration rejection restore native src', async () => {
  for (const options of [{ supported: false }, { registration: 'reject' }]) {
    const page = browser(options);
    await page.settle();
    assert.equal(page.video.src, `${origin}/guides/current-tutorial.mp4?v=test`);
    assert.equal(page.assignments.length, 1);
    assert.equal(page.posts.length, 0);
  }
});

test('a hanging registration restores native src after the bounded fallback timeout', async () => {
  const page = browser({ registration: 'pending' });
  await page.advance(2999);
  assert.equal(page.assignments.length, 0);
  await page.advance(1);
  assert.equal(page.assignments.length, 1);
  assert.equal(page.assignments[0].controlled, false);
  assert.equal(page.video.src, `${origin}/guides/current-tutorial.mp4?v=test`);
  await page.resolveRegistration();
  await page.takeControl();
  assert.equal(page.assignments.length, 1, 'late setup must not reload the active native player');
  assert.equal(page.posts.length, 0);
});

test('successful registration without control also restores native playback after its timeout', async () => {
  const page = browser();
  await page.settle();
  await page.advance(2499);
  assert.equal(page.assignments.length, 0);
  await page.advance(1);
  assert.equal(page.video.src, `${origin}/guides/current-tutorial.mp4?v=test`);
  assert.equal(page.posts.length, 0);
  await page.takeControl();
  await page.advance(500);
  assert.equal(page.assignments.length, 1);
  assert.equal(page.posts.length, 0);
});


test('legacy English electrician guide keeps links usable by redirecting to the unified language-aware page',()=>{
 const html=readFileSync(new URL('../public/guides/electricians-en.html',import.meta.url),'utf8');
 assert.match(html,/src="\/guides\/electricians-redirect\.js/);
 assert.doesNotMatch(html,/<script>[^<]/);
 const script=readFileSync(new URL('../public/guides/electricians-redirect.js',import.meta.url),'utf8');
 for (const search of ['?platform=discord&guildId=1554983512321425488&channelId=1554985842970468423', '?target=1554983512321425488-1554985842970468423', '?platform=kook&guildId=8900601550851301&channelId=1630990274298012&lang=zh-CN']) {
  let redirected;
  vm.runInNewContext(script, {URLSearchParams, location: {search, hash:'#tutorial', replace: value => {redirected=value;}}});
  const url=new URL(redirected,origin), original=new URLSearchParams(search);
  assert.equal(url.pathname,'/guides/electricians.html'); assert.equal(url.hash,'#tutorial'); assert.equal(url.searchParams.get('lang'),original.get('lang'));
  for (const key of ['platform','guildId','channelId','target']) assert.deepEqual(url.searchParams.getAll(key),original.getAll(key));
 }
 const unified=readFileSync(new URL('../public/guides/electricians.html',import.meta.url),'utf8');
 assert.match(unified,/id="show-tutorial"/);assert.match(unified,/id="show-tutorial-en"/);
});
