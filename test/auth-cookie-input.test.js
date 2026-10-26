import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('legacy session middleware ignores malformed cookies without blocking V2 authentication', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nb-auth-cookie-'));
  const previous = Object.fromEntries(['NB_DATA_DIR', 'NB_STORAGE_MODE', 'NB_ROOT_PASSWORD'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { NB_DATA_DIR: directory, NB_STORAGE_MODE: 'json', NB_ROOT_PASSWORD: 'CookieRegression123!' });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  });
  const { ensureStore } = await import('../server/store.js');
  const { attachUser, createSession, destroySession } = await import('../server/auth.js');
  await ensureStore();
  const token = await createSession('user_root');
  const attach = async cookie => {
    const req = { headers: { cookie } };
    await new Promise((resolve, reject) => attachUser(req, {}, error => error ? reject(error) : resolve()));
    return req;
  };

  for (const value of [
    'theme=%', 'theme=%E0%A4%A', '%=invalid', 'nb_session=%', 'nb_session=%E0%A4%A',
    `nb_session=sess_test.${encodeURIComponent('é'.repeat(43))}`,
    `nb_session=${token}.extra`, `nb_session=${token}; nb_session=invalid`,
    `nb_session=invalid; nb_session=${token}`
  ]) {
    const req = await attach(value);
    assert.equal(req.user, undefined, 'malformed or ambiguous cookies cannot authenticate');
    await assert.doesNotReject(() => destroySession({ headers: { cookie: value } }));
  }

  for (const unrelated of ['theme=%', 'theme=%E0%A4%A', '%=invalid']) {
    const req = await attach(`${unrelated}; nb_session=${encodeURIComponent(token)}`);
    assert.equal(req.user.id, 'user_root', 'an unrelated cookie cannot invalidate a valid session');
  }
  await destroySession({ headers: { cookie: `nb_session=${encodeURIComponent(token)}; theme=%` } });
  assert.equal((await attach(`nb_session=${token}`)).user, undefined, 'valid logout still revokes the session');
});
