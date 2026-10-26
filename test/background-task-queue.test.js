import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backgroundTaskQueueSnapshot,
  drainBackgroundTaskQueues,
  drainBackgroundTaskQueuesForTests,
  queueBackgroundTask,
  resumeBackgroundTaskQueuesForTests
} from '../server/background-task-queue.js';

test('background task queue respects disable flag, force, ordering, and metrics', async () => {
  const previousDisabled = process.env.NB_DISABLE_BACKGROUND_JOBS;
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';

  try {
    const beforeSnapshot = backgroundTaskQueueSnapshot();
    const completedBefore = beforeSnapshot.queues.sync.completed;
    let disabledTaskRan = false;
    const disabledResult = await queueBackgroundTask('disabled-task', async () => {
      disabledTaskRan = true;
    });
    assert.equal(disabledResult, null);
    assert.equal(disabledTaskRan, false);

    const order = [];
    let releaseFirstTask;
    let markFirstTaskStarted;
    const firstTaskStarted = new Promise((resolve) => {
      markFirstTaskStarted = resolve;
    });
    const firstTaskRelease = new Promise((resolve) => {
      releaseFirstTask = resolve;
    });
    const first = queueBackgroundTask('first-sync-task', async () => {
      order.push('first-start');
      markFirstTaskStarted();
      await firstTaskRelease;
      order.push('first-end');
      return 'first';
    }, 0, { force: true, queue: 'sync' });
    const second = queueBackgroundTask('second-sync-task', async () => {
      order.push('second');
      return 'second';
    }, 0, { force: true, queue: 'sync' });

    const queuedSnapshot = backgroundTaskQueueSnapshot();
    assert.equal(queuedSnapshot.queues.sync.pending >= 1, true);
    assert.equal(queuedSnapshot.totalPending >= 1, true);
    await firstTaskStarted;
    const runningSnapshot = backgroundTaskQueueSnapshot();
    assert.equal(runningSnapshot.queues.sync.running, 1);
    assert.equal(runningSnapshot.queues.sync.oldestRunningMs >= 0, true);
    assert.equal(Boolean(runningSnapshot.queues.sync.lastStartedAt), true);

    releaseFirstTask();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);

    const drainedSnapshot = backgroundTaskQueueSnapshot();
    assert.equal(drainedSnapshot.queues.sync.pending, 0);
    assert.equal(drainedSnapshot.queues.sync.running, 0);
    assert.equal(drainedSnapshot.queues.sync.completed >= completedBefore + 2, true);
    assert.equal(Boolean(drainedSnapshot.queues.sync.lastFinishedAt), true);
    const drainResult = await drainBackgroundTaskQueuesForTests();
    assert.equal(drainResult.totalPending, 0);
    assert.equal(drainResult.totalRunning, 0);
  } finally {
    if (previousDisabled === undefined) delete process.env.NB_DISABLE_BACKGROUND_JOBS;
    else process.env.NB_DISABLE_BACKGROUND_JOBS = previousDisabled;
  }
});

test('background task timeout releases the serial queue for following work', async () => {
  await drainBackgroundTaskQueuesForTests();
  const before = backgroundTaskQueueSnapshot().queues.interaction;
  const order = [];

  const stalled = queueBackgroundTask('stalled-interaction-task', async () => {
    order.push('stalled-start');
    await new Promise(() => {});
  }, 0, {
    force: true,
    queue: 'interaction',
    timeoutMs: 25,
    deadlineMs: 250
  });
  const following = queueBackgroundTask('following-interaction-task', async () => {
    order.push('following');
    return 'following-result';
  }, 0, {
    force: true,
    queue: 'interaction',
    timeoutMs: 100,
    deadlineMs: 250
  });

  await assert.rejects(stalled, (error) => error?.code === 'BACKGROUND_TASK_TIMEOUT');
  assert.equal(await following, 'following-result');
  assert.deepEqual(order, ['stalled-start', 'following']);

  const after = await drainBackgroundTaskQueuesForTests();
  assert.equal(after.queues.interaction.timedOut >= before.timedOut + 1, true);
  assert.equal(after.queues.interaction.running, 0);
});

test('background task queue expires stale pending work and enforces a pending bound', async () => {
  await drainBackgroundTaskQueuesForTests();
  const before = backgroundTaskQueueSnapshot().queues.sync;
  let releaseBlocker;
  const blockerStarted = Promise.withResolvers();
  const blockerRelease = new Promise((resolve) => {
    releaseBlocker = resolve;
  });
  const blocker = queueBackgroundTask('bounded-queue-blocker', async () => {
    blockerStarted.resolve();
    await blockerRelease;
  }, 0, {
    force: true,
    queue: 'sync',
    timeoutMs: 500,
    deadlineMs: 1000
  });
  await blockerStarted.promise;

  const expired = queueBackgroundTask('bounded-queue-expired', async () => 'should-not-run', 0, {
    force: true,
    queue: 'sync',
    timeoutMs: 100,
    deadlineMs: 20,
    maxPending: 2
  });
  const retained = queueBackgroundTask('bounded-queue-retained', async () => 'retained', 0, {
    force: true,
    queue: 'sync',
    timeoutMs: 100,
    deadlineMs: 500,
    maxPending: 2
  });
  const overflow = queueBackgroundTask('bounded-queue-overflow', async () => 'overflow', 0, {
    force: true,
    queue: 'sync',
    timeoutMs: 100,
    deadlineMs: 500,
    maxPending: 2
  });

  await assert.rejects(overflow, (error) => (
    error?.code === 'BACKGROUND_TASK_QUEUE_FULL' && error?.maxPending === 2
  ));
  await assert.rejects(expired, (error) => error?.code === 'BACKGROUND_TASK_DEADLINE_EXCEEDED');
  const pendingAfterExpiry = backgroundTaskQueueSnapshot().queues.sync.pending;
  assert.equal(pendingAfterExpiry, 1);

  releaseBlocker();
  await blocker;
  assert.equal(await retained, 'retained');
  const after = await drainBackgroundTaskQueuesForTests();
  assert.equal(after.queues.sync.rejected >= before.rejected + 1, true);
  assert.equal(after.queues.sync.expired >= before.expired + 1, true);
  assert.equal(after.queues.sync.maxObservedPending >= 2, true);
});

test('background task queue deduplicates and merges pending work by explicit key', async () => {
  await drainBackgroundTaskQueuesForTests();
  let releaseBlocker;
  const blockerStarted = Promise.withResolvers();
  const blocker = queueBackgroundTask('keyed-queue-blocker', async () => {
    blockerStarted.resolve();
    await new Promise((resolve) => {
      releaseBlocker = resolve;
    });
  }, 0, {
    force: true,
    queue: 'member_profile',
    timeoutMs: 500,
    deadlineMs: 1000
  });
  await blockerStarted.promise;

  const calls = [];
  const first = queueBackgroundTask('keyed-first', async () => {
    calls.push('first');
    return 'first';
  }, 0, {
    force: true,
    queue: 'member_profile',
    key: 'member:42',
    timeoutMs: 100,
    deadlineMs: 500
  });
  const duplicate = queueBackgroundTask('keyed-duplicate', async () => {
    calls.push('duplicate');
    return 'duplicate';
  }, 0, {
    force: true,
    queue: 'member_profile',
    key: 'member:42',
    timeoutMs: 100,
    deadlineMs: 500
  });
  assert.equal(duplicate, first);

  const merged = queueBackgroundTask('keyed-merged', async () => {
    calls.push('merged');
    return 'merged';
  }, 0, {
    force: true,
    queue: 'member_profile',
    key: 'member:42',
    merge: 'replace',
    timeoutMs: 100,
    deadlineMs: 500
  });
  assert.equal(merged, first);

  releaseBlocker();
  await blocker;
  assert.equal(await first, 'merged');
  assert.deepEqual(calls, ['merged']);

  const snapshot = await drainBackgroundTaskQueuesForTests();
  assert.equal(snapshot.queues.member_profile.deduplicated >= 2, true);
  assert.equal(snapshot.queues.member_profile.merged >= 1, true);
  assert.equal(snapshot.queues.member_profile.keyedPending, 0);
});

test('shutdown drain waits for acknowledged background work and seals new enqueue attempts', async () => {
  await drainBackgroundTaskQueuesForTests();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const task = queueBackgroundTask('shutdown-interaction-task', async () => {
    started.resolve();
    await release.promise;
    return 'persisted';
  }, 0, {
    force: true,
    queue: 'interaction',
    timeoutMs: 1000,
    deadlineMs: 2000
  });
  await started.promise;

  let drained = false;
  const drain = drainBackgroundTaskQueues({ timeoutMs: 1000, stopAccepting: true })
    .then((snapshot) => {
      drained = true;
      return snapshot;
    });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drained, false);

  release.resolve();
  assert.equal(await task, 'persisted');
  const snapshot = await drain;
  assert.equal(snapshot.totalPending, 0);
  assert.equal(snapshot.totalRunning, 0);
  assert.equal(snapshot.accepting, false);
  await assert.rejects(
    queueBackgroundTask('late-shutdown-task', async () => null, 0, { force: true }),
    (error) => error?.code === 'BACKGROUND_TASK_SHUTTING_DOWN'
  );
  resumeBackgroundTaskQueuesForTests();
  assert.equal(backgroundTaskQueueSnapshot().accepting, true);
});
