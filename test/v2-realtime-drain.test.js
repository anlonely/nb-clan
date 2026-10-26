import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRealtimeStreamOwner } from '../server/v2/realtime/stream.js';

test('stream owner drains initial authorization and never opens a late stream after shutdown', async () => {
  const owner = createRealtimeStreamOwner();
  let release, entered, accesses = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const res = { end() { this.ended = true; } };
  const opening = owner.open({ req: new EventEmitter(), res, scopeId: 'isolated',
    service: { access() { accesses++; } },
    authenticate: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await ready;
  let drained = false;
  const stop = owner.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release({ actor: { id: 'local', permissionVersion: 1 } });
  await Promise.all([opening, stop]);
  assert.equal(accesses, 0);
  assert.equal(owner.size, 0);
  assert.equal(res.ended, true);
});

test('disconnected pending handshake remains part of shutdown drain', async () => {
  const owner = createRealtimeStreamOwner(), req = new EventEmitter();
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const opening = owner.open({ req, res: { end() {} }, service: { access() { assert.fail('late database access'); } },
    authenticate: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await ready;
  req.destroyed = true;
  req.emit('close');
  let drained = false;
  const stop = owner.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release({ actor: { id: 'local', permissionVersion: 1 } });
  await Promise.all([opening, stop]);
  assert.equal(owner.size, 0);
});
