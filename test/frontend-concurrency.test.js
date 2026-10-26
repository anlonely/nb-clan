import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { api } from '../src/shared/api.js';
import { createLatestRequestController } from '../src/shared/request-control.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('latest request controller aborts stale work and stays disposed until reactivated', () => {
  const control = createLatestRequestController();
  const first = control.begin();
  const second = control.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(control.isCurrent(first), false);
  assert.equal(control.isCurrent(second), true);

  control.dispose();
  assert.equal(second.signal.aborted, true);
  assert.equal(control.isCurrent(second), false);

  const disposedRequest = control.begin();
  assert.equal(disposedRequest.signal.aborted, true);

  control.activate();
  const activeRequest = control.begin();
  assert.equal(activeRequest.signal.aborted, false);
  assert.equal(control.isCurrent(activeRequest), true);
});

test('api forwards AbortSignal to fetch', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedSignal = null;
  globalThis.fetch = async (_path, options) => {
    receivedSignal = options.signal;
    return {
      ok: true,
      headers: { get: () => null },
      json: async () => ({ ok: true })
    };
  };

  try {
    await api('/api/test', { signal: controller.signal });
    assert.equal(receivedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('frontend race and recovery controls remain connected to the affected views', async () => {
  const [serverView, membersView, kdaViews, wechatView, lazyViews, recoverableLazy, main, legacyMain, loadingState] = await Promise.all([
    readFile(path.join(repoRoot, 'src/views/server/ServerView.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/views/members/MembersView.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/views/kda/KdaHistoryViews.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/views/wechat/WechatMiniProgramView.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/app/lazyViews.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/shared/ui/RecoverableLazy.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/main.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/legacy-main.jsx'), 'utf8'),
    readFile(path.join(repoRoot, 'src/shared/ui/PageLoadingState.jsx'), 'utf8')
  ]);

  assert.equal(
    serverView.match(/disabled=\{!canUseSelfSignup \|\| Boolean\(signupLoading\)\}/g)?.length,
    4,
    'all signup choices must share one pending lock'
  );
  assert.match(serverView, /while \(queue\.pending && signupActiveRef\.current\)/);
  assert.match(serverView, /queue\.pending = \{/);

  assert.match(membersView, /onlinePollRequestControlRef\.current\.dispose\(\)/);
  assert.match(membersView, /profilePollRequestControlRef\.current\.dispose\(\)/);
  assert.match(kdaViews, /syncPollRequestControlRef\.current\.dispose\(\)/);
  assert.match(kdaViews, /const requestControl = loadRequestControlRef\.current;[\s\S]{0,100}requestControl\.begin\(\)/);
  assert.match(kdaViews, /requestKey !== kdaFilterRequestKey\(filtersRef\.current\)/);
  assert.match(wechatView, /const requestControl = dataRequestControlRef\.current;[\s\S]{0,100}requestControl\.begin\(\)/);
  assert.match(wechatView, /loadMoreRequestControlRef\.current\.cancel\(\)/);
  assert.match(wechatView, /dataConditionsKeyRef\.current !== requestConditionsKey/);
  assert.match(wechatView, /\/api\/wechat\/admin\/join-applications/);
  assert.match(wechatView, /\/api\/third-party\/admin\/discord-member-applications/);
  assert.doesNotMatch(wechatView, /member-bind-requests/);
  assert.doesNotMatch(wechatView, /bindRequests|bindCounts|bindPending/);

  assert.match(lazyViews, /createRecoverableLazy/);
  assert.match(main, /import\(['"]\.\/legacy-main\.jsx['"]\)/);
  assert.match(main, /import\(['"]\.\/v2\/main\.jsx['"]\)/);
  assert.match(legacyMain, /import Dashboard from ['"]\.\/app\/Dashboard\.jsx['"]/);
  assert.doesNotMatch(legacyMain, /createRecoverableLazy\(\(\) => import\(['"]\.\/app\/Dashboard\.jsx['"]\)\)/);
  assert.match(recoverableLazy, /lazyViewForAttempt\(0\)/);
  assert.match(recoverableLazy, /lazyViews\.set\(attempt, React\.lazy/);
  assert.doesNotMatch(recoverableLazy, /useMemo\(\(\) => React\.lazy/);
  assert.match(recoverableLazy, /window\.location\.reload\(\)/);
  assert.doesNotMatch(loadingState, /dotlottie|\.lottie|\.wasm/i);
});
