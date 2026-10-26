// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixture} from './support/v2-realtime/fixture.mjs';
const records=[];
for(const resource of ['squad','wipe'])test(`event batch keeps exact signed cursors and fresh authority for ${resource} scopes`,()=>{
  const f=fixture({scopeContract:true});try{
    const account=f.ir.get('accounts','g05_account_admin'),actor=f.actor('admin');
    if(resource==='wipe'){
      f.ir.put('schedulingWipes',{id:'g08-scope-wipe',audience:{memberIds:[f.actor('alpha').memberId],squadIds:[],includeUnassigned:false}});
      f.db.prepare('UPDATE v2_realtime_scopes SET resource=? WHERE id=?').run(JSON.stringify({kind:'wipe',id:'g08-scope-wipe'}),'alpha');
    }
    const cursor=f.service.events(actor,'alpha').cursor;
    for(let n=0;n<90;n++)f.chat('alpha',10000+n);
    const read=f.ir.all.bind(f.ir);let calls=0;f.ir.all=name=>{calls++;return read(name);};
    const before=f.service.readEvents(actor,'alpha',cursor),oldReads=calls;calls=0;const after=f.service.events(actor,'alpha',cursor),newReads=calls;
    assert.deepEqual(after,before);assert.equal(after.events.length,90);assert.ok(newReads<oldReads/4,`${oldReads} -> ${newReads}`);
    f.ir.put('accounts',{...account,permissionVersion:account.permissionVersion+1,grants:[...account.grants,{capability:'relay.chat_read',effect:'deny',scope:{type:'all'}}]});
    assert.throws(()=>f.service.events(actor,'alpha',after.cursor),e=>e.errorCode==='PERMISSIONS_CHANGED');
    assert.throws(()=>f.service.events(f.actor('admin'),'alpha',after.cursor),e=>e.errorCode==='ACCESS_DENIED');
    records.push({resource,events:90,oldReads,newReads,identicalSignedCursors:true,freshDeny:true});
  }finally{f.db.close();}
});
test('squad membership changes invalidate the next batch without a permissionVersion bump',()=>{
  const f=fixture({scopeContract:true});try{
    const actor=f.actor('alpha'),cursor=f.service.events(actor,'alpha').cursor;
    const row=f.ir.all('squadMembers').find(r=>r.memberId===actor.memberId);f.ir.put('squadMembers',{...row,validFrom:'2030-01-01T00:00:00.000Z'});
    const before=f.service.readEvents(f.actor('alpha'),'alpha',cursor),after=f.service.events(f.actor('alpha'),'alpha',cursor);
    assert.equal(after.resetRequired,true);assert.deepEqual(after,before);
  }finally{f.db.close();}
});
test.after(()=>fs.writeFile('output/test-results/g08/realtime-snapshot.json',JSON.stringify(records,null,2)+'\n'));
test('squad-only projection preserves self, explicit squad grants and denies with foreign relationships',()=>{
 const f=fixture({scopeContract:true});try{
  f.ir.put('squadMembers',{id:'g08-other-null',memberId:null,squadId:'alpha',validTo:null});
  for(const account of f.ir.all('accounts')){
   const variants=[account.grants,[{capability:'relay.chat_read',effect:'allow',scope:{type:'self'}}],[{capability:'relay.chat_read',effect:'allow',scope:{type:'squads',ids:['alpha']}},{capability:'relay.chat_read',effect:'deny',scope:{type:'squads',ids:['beta']}}]];
   for(const grants of variants){f.ir.put('accounts',{...account,grants});const actor=f.identity.actorForAccount(account.id);
    for(const scope of ['alpha','beta']){const observe=fn=>{try{return {value:fn()}}catch(e){return {code:e.errorCode,status:e.status}}};assert.deepEqual(observe(()=>f.service.events(actor,scope)),observe(()=>f.service.readEvents(actor,scope)));}
   }f.ir.put('accounts',account);
  }
 }finally{f.db.close();}
});
