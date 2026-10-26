import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, runtimeEnvironment } from './support/v2-member-space/config.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('actual isolated static runtime serves SPA deep links and the referenced built JS asset under a dot-directory worktree', { timeout: 30_000 }, async t => {
  const dist = path.join(root, 'dist');
  const expectedHtml = await readFile(path.join(dist, 'index.html')).catch(error => {
    if (error.code === 'ENOENT') throw new Error('Missing dist/index.html: run npm run build, or use node scripts/test.mjs integration to build production assets first.');
    throw error;
  });
  const latestFile = path.join(root, 'work/g05/runtime-latest.json');
  const previousLatest = await readFile(latestFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  await mkdir(path.join(root, 'work/g05'), { recursive: true });
  const runDir = await mkdtemp(path.join(root, 'work/g05/runtime-static-test-'));
  const child = spawn(process.execPath, ['test/support/v2-member-space/runtime.mjs'], {
    cwd: root, env: runtimeEnvironment(runDir, { port: 0, mode: 'static' }), stdio: ['ignore','pipe','pipe']
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  let stdout = '', stderr = '', stopTimer;
  const report = { startedAt: new Date().toISOString(), scope: 'Real static runtime on an isolated temporary port and SQLite', checks: [], passed: false };
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Isolated static runtime did not become ready')), 15_000);
      child.stdout.on('data', bytes => {
        stdout += bytes;
        for (const line of stdout.split('\n')) {
          try { const data = JSON.parse(line); if (data.ready && data.origin) { clearTimeout(timeout); resolve(data); return; } } catch {}
        }
      });
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Isolated runtime exited ${code}: ${stderr}`)); });
    });
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(new URL(ready.origin).port, '4315');
    report.origin = ready.origin;
    for (const route of [`/app/wipes/${ready.nextWipeId}?tab=plan`, '/login?returnTo=%2Fapp%2Fhome', '/auth/continue']) {
      const response = await fetch(`${ready.origin}${route}`), bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(sha(bytes), sha(expectedHtml), route);
      report.checks.push({ route, status: response.status, htmlSha256: sha(bytes) });
    }
    const asset = expectedHtml.toString().match(/<script\b[^>]*\bsrc="([^"]+)"/)[1];
    assert.match(asset, /^\/assets\/[^/]+\.js$/);
    const response = await fetch(`${ready.origin}${asset}`), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status,200); assert.match(response.headers.get('content-type'), /javascript/);
    assert.equal(sha(bytes), sha(await readFile(path.join(dist, asset.slice(1)))));
    report.checks.push({ route: asset, status: response.status, sha256: sha(bytes) }); report.passed = true;
  } catch (error) { report.failure = { message: error.message }; throw error; }
  finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(runDir, 'static-route-check.json'), JSON.stringify(report,null,2));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); stopTimer = setTimeout(() => child.kill('SIGKILL'), 5000); stopTimer.unref();
    }
    await exited; clearTimeout(stopTimer);
    // Restore only our own temporary pointer. A concurrently started user runtime wins.
    const current = await readFile(latestFile).then(bytes => JSON.parse(bytes)).catch(() => null);
    if (current?.runDir === runDir) {
      if (previousLatest) await writeFile(latestFile, previousLatest, { mode: 0o600 });
      else await unlink(latestFile);
    }
    console.log(`G05_STATIC_ROUTE_EVIDENCE=${path.join(runDir, 'static-route-check.json')}`);
  }
});
