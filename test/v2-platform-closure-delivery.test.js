import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/v2-platform-closure/fixture.mjs';
async function setup(t){const f=await fixture();t.after(()=>f.close());return f;}
test('cards queue original intent, attempt, delivery and exact-reference edit; replay does not send',async t=>{
 const f=await setup(t),p=await f.preview(),queued=await f.command(p);
 assert.equal(queued.status,'queued');assert.equal(f.transport.getCalls().length,0);
 const d=f.notifications.repo.get('deliveries',queued.result.reference);assert.equal(d.resource.kind,'platformCard');assert.equal(d.wipeId,null);
 await f.worker.runOnce({workerId:'closure-worker',limit:10});
 assert.equal(f.notifications.repo.get('deliveries',d.id).status,'sent');assert.ok(f.notifications.repo.all('attempts').some(x=>x.deliveryId===d.id&&x.startedAt));
 assert.equal(f.platformService.receipt(f.actor('admin'),'card-command').status,'succeeded');
 await f.command(p);assert.equal(f.transport.getCalls().filter(x=>x.operation==='send').length,1);
 const originalId=f.transport.getMessages()[0].messageId;
 await f.worker.runOnce({workerId:'closure-worker',limit:10});
 const updated=await f.preview(),edit=await f.command(updated,'card_refresh','card-edit');assert.equal(edit.status,'queued');
 await f.worker.runOnce({workerId:'closure-worker',limit:10});
 assert.equal(f.platformService.receipt(f.actor('admin'),'card-edit').status,'succeeded');
 assert.equal(f.transport.getCalls().filter(x=>x.operation==='send').length,1);assert.ok(f.transport.getCalls().some(x=>x.operation==='edit'&&x.messageId===originalId));
});
test('lost response remains delivery_unknown and a new operation cannot send a duplicate',async t=>{
 const f=await setup(t);f.transport.enqueue({platform:'discord',operation:'send',targetId:'discord-target',kind:'response_lost'});
 const p=await f.preview(),q=await f.command(p);await f.worker.runOnce({workerId:'closure-worker',limit:10});
 assert.equal(f.notifications.repo.get('deliveries',q.result.reference).status,'delivery_unknown');
 assert.equal(f.platformService.receipt(f.actor('admin'),'card-command').status,'result_unknown');
 const another=await f.command(p,'card_publish','new-id');assert.equal(another.status,'failed');assert.equal(f.platformService.receipt(f.actor('admin'),'new-id').status,'failed');
 await f.worker.runOnce({workerId:'closure-worker',limit:10});assert.equal(f.transport.getCalls().filter(x=>x.operation==='send').length,1);
});
test('revocation after queuing prevents external I/O and is visible as failure',async t=>{
 const f=await setup(t),q=await f.command(await f.preview());const account=f.ir.get('accounts','admin');f.ir.put('accounts',{...account,permissionVersion:2});
 await f.worker.runOnce({workerId:'closure-worker',limit:10});assert.equal(f.transport.getCalls().length,0);assert.equal(f.notifications.repo.get('deliveries',q.result.reference).status,'failed');
});
