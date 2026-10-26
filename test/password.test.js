import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../server/store.js';

test('hashes and verifies passwords without storing plaintext', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});
