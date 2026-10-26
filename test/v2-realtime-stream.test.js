import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fixture } from './support/v2-realtime/fixture.mjs';
import { createRealtimeStreamOwner } from '../server/v2/realtime/stream.js';
const response = ({
  slow = false
} = {}) => ({
  frames: [],
  writableLength: 0,
  status() {
    return this;
  },
  set() {
    return this;
  },
  flushHeaders() {},
  write(f) {
    this.frames.push(f);
    return !slow;
  },
  end() {
    this.ended = true;
  },
  destroy() {
    this.destroyed = true;
  }
});
test('SSE resumes persisted chat cursor and immediate G03 revoke ends connection', async t => {
  const f = fixture();
  t.after(() => f.db.close());
  const owner = createRealtimeStreamOwner(),
    res = response(),
    req = new EventEmitter(),
    actor = f.actor('admin'),
    session = await authenticatedSession(f.identity, actor.id),
    cursor = f.service.page(actor, 'alpha').tailCursor;
  f.chat('alpha', 9999);
  await owner.open({
    req,
    res,
    service: f.service,
    authenticate: async () => f.identity.session(session.token),
    scopeId: 'alpha',
    cursor
  });
  assert.ok(res.frames.some(s => s.includes('9999')));
  assert.equal(owner.size, 1);
  f.identity.revokeAccountScope(actor.id, 'test');
  assert.equal(owner.size, 0);
  assert.ok(res.frames.at(-1).includes('authorization-revoked'));
  owner.stop();
});
test('slow client closed immediately without unbounded userland queue; owner stop drains listeners', async t => {
  const f = fixture();
  t.after(() => f.db.close());
  const owner = createRealtimeStreamOwner(),
    res = response({
      slow: true
    }),
    cursor = f.service.page(f.actor('admin'), 'alpha').tailCursor;
  f.chat('alpha', 9900);
  await owner.open({
    req: new EventEmitter(),
    res,
    service: f.service,
    authenticate: async () => ({
      actor: f.actor('admin')
    }),
    scopeId: 'alpha',
    cursor
  });
  assert.equal(res.destroyed, true);
  assert.equal(owner.size, 0);
  assert.equal(f.repo.listeners.size, 0);
  assert.equal(f.identity.listeners.size, 0);
  owner.stop();
});
test('wrong-scope and stale cursor request reset, never replays another scope', async t => {
  const f = fixture();
  t.after(() => f.db.close());
  const owner = createRealtimeStreamOwner(),
    res = response();
  await owner.open({
    req: new EventEmitter(),
    res,
    service: f.service,
    authenticate: async () => ({
      actor: f.actor('admin')
    }),
    scopeId: 'beta',
    cursor: f.service.page(f.actor('admin'), 'alpha').tailCursor
  });
  assert.ok(res.frames[0].includes('reset_required'));
  assert.equal(res.frames.join('').includes('Hold the north gate'), false);
  assert.equal(owner.size, 0);
  owner.stop();
});
test('session expiry at pump fails before writing new payload', async t => {
  const f = fixture();
  t.after(() => f.db.close());
  const owner = createRealtimeStreamOwner(),
    res = response(),
    actor = f.actor('admin'),
    session = await authenticatedSession(f.identity, actor.id);
  await owner.open({
    req: new EventEmitter(),
    res,
    service: f.service,
    authenticate: async () => f.identity.session(session.token),
    scopeId: 'alpha',
    cursor: f.service.page(actor, 'alpha').tailCursor
  });
  f.advance(40 * 86400000);
  f.chat('alpha', 9800);
  await new Promise(r => setImmediate(r));
  assert.equal(res.frames.join('').includes('9800'), false);
  assert.ok(res.frames.at(-1).includes('authorization-revoked'));
  owner.stop();
});

test('a stream opened without a cursor retains its initial watermark and receives later messages', async t => {
  const f=fixture();t.after(()=>f.db.close());const owner=createRealtimeStreamOwner(),res=response();
  await owner.open({req:new EventEmitter(),res,service:f.service,authenticate:async()=>({actor:f.actor('admin')}),scopeId:'alpha'});
  f.chat('alpha',989898);
  for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
  await owner.stop();assert.ok(res.frames.some(frame=>frame.includes('989898')));
});

test('temporary backpressure drains before freshly authorized continuation',async t=>{
 const f=fixture();t.after(()=>f.db.close());const owner=createRealtimeStreamOwner(),res=Object.assign(new EventEmitter(),response());let hold=true,auths=0;
 res.write=function(frame){this.frames.push(frame);return !(hold&&frame.includes('event: realtime'));};
 await owner.open({req:new EventEmitter(),res,service:f.service,scopeId:'alpha',authenticate:async()=>{auths++;return {actor:f.actor('admin')};}});
 f.chat('alpha',989891);for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));
 assert.equal(res.ended,undefined);assert.equal(res.listenerCount('drain'),1);const before=auths;
 f.chat('alpha',989892);hold=false;res.emit('drain');for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.ok(auths>before);assert.ok(res.frames.some(frame=>frame.includes('989892')));await owner.stop();assert.equal(res.listenerCount('drain'),0);
});
test('revoke during drain cannot write the remaining private batch',async t=>{
 const f=fixture();t.after(()=>f.db.close());const owner=createRealtimeStreamOwner(),res=Object.assign(new EventEmitter(),response());let hold=true;
 res.write=function(frame){this.frames.push(frame);return !(hold&&frame.includes('event: realtime'));};
 await owner.open({req:new EventEmitter(),res,service:f.service,scopeId:'alpha',authenticate:async()=>({actor:f.actor('admin')})});
 f.chat('alpha',989893);for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));f.chat('alpha',989894);
 const account=f.ir.get('accounts',f.actor('admin').id);f.ir.put('accounts',{...account,roleId:'member',adminAssignedByOwner:false,permissionVersion:account.permissionVersion+1});
 hold=false;res.emit('drain');for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));
 assert.equal(res.frames.some(frame=>frame.includes('989894')),false);assert.ok(res.frames.some(frame=>frame.includes('authorization-revoked')));await owner.stop();
});
test('a client that never drains is bounded and stopping releases its waiter',async t=>{
 const f=fixture();t.after(()=>f.db.close());const owner=createRealtimeStreamOwner({drainTimeoutMs:20}),res=Object.assign(new EventEmitter(),response({slow:true}));
 await owner.open({req:new EventEmitter(),res,service:f.service,scopeId:'alpha',authenticate:async()=>({actor:f.actor('admin')})});
 assert.equal(res.destroyed,true);assert.equal(owner.size,0);assert.equal(res.listenerCount('drain'),0);await owner.stop();
});
test('owner stop releases an outstanding drain before its deadline',async t=>{
 const f=fixture();t.after(()=>f.db.close());const owner=createRealtimeStreamOwner({drainTimeoutMs:10000}),res=Object.assign(new EventEmitter(),response({slow:true}));
 const opening=owner.open({req:new EventEmitter(),res,service:f.service,scopeId:'alpha',authenticate:async()=>({actor:f.actor('admin')})});
 for(let i=0;i<5&&!res.listenerCount('drain');i++)await new Promise(r=>setImmediate(r));assert.equal(res.listenerCount('drain'),1);
 await owner.stop();await opening;assert.equal(res.ended,true);assert.equal(res.listenerCount('drain'),0);assert.equal(owner.size,0);
});
