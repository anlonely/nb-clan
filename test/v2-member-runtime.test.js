import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { saveBrowserEvidence } from './support/v2-member-space/evidence.mjs';
import { root, optionsFrom, runtimeEnvironment, validateRuntimeEnvironment } from './support/v2-member-space/config.mjs';
import { controlledProviders } from './support/v2-member-space/fixtures.mjs';

test('G05 runtime whitelists environment and cannot inherit production credentials, paths, proxy or Node preload', () => {
  const runDir = path.join(root, 'work/g05/runtime-safety-test');
  const env = runtimeEnvironment(runDir, {}, { PATH: '/usr/bin', HOME: '/secret', NB_SQLITE_FILE: '/production/live.sqlite',
    NB_DATA_DIR: '/production', NB_DISCORD_BOT_TOKEN: 'secret', HTTPS_PROXY: 'http://remote', NODE_OPTIONS: '--import=unsafe.mjs' });
  assert.equal(env.NB_SQLITE_FILE, path.join(runDir, 'data/nb-clan.sqlite'));
  assert.equal(env.NB_DISABLE_BACKGROUND_JOBS, '1'); assert.equal(env.NB_DISABLE_EXTERNAL_VITAL, '1'); assert.equal(env.NB_DISABLE_EXTERNAL_ATLAS, '1');
  assert.equal(env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS, '0');
  assert.equal(env.HOME, undefined); assert.equal(env.NB_DISCORD_BOT_TOKEN, undefined); assert.equal(env.HTTPS_PROXY, undefined);
  assert.match(env.NODE_OPTIONS, /v2-baseline\/loopback-only.mjs$/); assert.doesNotThrow(() => validateRuntimeEnvironment(env));
  assert.throws(() => validateRuntimeEnvironment({ ...env, HTTPS_PROXY: 'http://remote' }), /Unexpected inherited/);
  assert.throws(() => validateRuntimeEnvironment({ ...env, NB_DISABLE_BACKGROUND_JOBS: '0' }), /Unsafe/);
  assert.throws(() => runtimeEnvironment('/isolated-forbidden-production-data'), /Isolated/);
});
test('G05 runtime refuses arbitrary flags and ports and has an explicit static mode', () => {
  assert.deepEqual(optionsFrom([]), { port: 4315, mode: 'dev' });
  assert.deepEqual(optionsFrom(['--port','0','--static']), { port: 0, mode: 'static' });
  for (const args of [['--port','80'], ['--port','65536'], ['--port','abc'], ['--host','0.0.0.0'], ['--env','production']]) assert.throws(() => optionsFrom(args));
});
test('controlled OAuth tickets are provider-bound and one-use, roles can fail closed', async () => {
  const fixture = controlledProviders('http://127.0.0.1:4315');
  const code = fixture.ticket('discord', 'alpha');
  const user = await fixture.providers.discord.exchange(code);
  assert.equal(user.id, 'discord_g05_alpha');
  await assert.rejects(fixture.providers.discord.exchange(code), { errorCode: 'AUTH_INVALID_CALLBACK' });
  const wrong = fixture.ticket('discord', 'beta');
  await assert.rejects(fixture.providers.kook.exchange(wrong), { errorCode: 'AUTH_INVALID_CALLBACK' });
  const denied = await fixture.providers.discord.roles('discord_g05_denied', 'g05_fixture_guild'); assert.deepEqual(denied.roleIds, []);
  fixture.unavailable.add('alpha');
  await assert.rejects(fixture.providers.discord.roles(user.id, 'g05_fixture_guild'), { errorCode: 'ELIGIBILITY_UNAVAILABLE' });
  assert.throws(() => fixture.ticket('discord', 'unknown'), { errorCode: 'AUTH_INVALID_CALLBACK' });
});

test('the actual inherited loopback guard rejects non-loopback and Unix-socket egress before connecting', () => {
  const env = runtimeEnvironment(path.join(root, 'work/g05/runtime-guard-test'));
  const script = `import assert from 'node:assert/strict'; import net from 'node:net';
    for (const options of [{ host: '192.0.2.1', port: 443 }, { path: '/tmp/g05-not-a-real-socket' }])
      assert.throws(() => net.connect(options), { code: 'G01_EGRESS_BLOCKED' });`;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, stdio: 'pipe' }));
});

test('browser evidence accepts only bounded PNG/JSON basenames and preserves existing files', async () => {
  await mkdir(path.join(root, 'work/g05'), { recursive: true });
  const directory = await mkdtemp(path.join(root, 'work/g05/runtime-evidence-test-'));
  try {
    const original = { checks: ['passed'], viewport: { width: 1440 } };
    const saved = await saveBrowserEvidence(directory, { name: 'browser-check.json', json: original });
    assert.equal(saved.replayed, false); assert.deepEqual(JSON.parse(await readFile(saved.file)), original);
    assert.equal((await saveBrowserEvidence(directory, { name: 'browser-check.json', json: original })).replayed, true);
    await assert.rejects(saveBrowserEvidence(directory, { name: 'browser-check.json', json: {} }), { errorCode: 'EVIDENCE_NAME_CONFLICT' });
    for (const name of ['../outside.png', '/tmp/out.json', '..json', 'nested/test.png', '.hidden.json', 'file.js', 'a..b.png'])
      await assert.rejects(saveBrowserEvidence(directory, { name, json: {} }), { errorCode: 'EVIDENCE_NAME_INVALID' });
    await assert.rejects(saveBrowserEvidence(directory, { name: 'invalid.png', base64: Buffer.from('not png').toString('base64') }), { errorCode: 'EVIDENCE_PNG_INVALID' });
    await assert.rejects(saveBrowserEvidence(directory, { name: 'invalid.json', base64: '____' }), { errorCode: 'EVIDENCE_PAYLOAD_INVALID' });
    await assert.rejects(saveBrowserEvidence(directory, { name: 'invalid.json', base64: Buffer.from('not json').toString('base64') }), { errorCode: 'EVIDENCE_JSON_INVALID' });
    await assert.rejects(saveBrowserEvidence(directory, { name: 'large.json', json: 'x'.repeat(3*1024*1024) }), { errorCode: 'EVIDENCE_TOO_LARGE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
