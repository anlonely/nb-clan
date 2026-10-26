import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fixture} from './support/v2-realtime/fixture.mjs';
const records=[];
const observed=fn=>{try{return {value:fn()}}catch(error){return {error:error.errorCode,status:error.status}}};
test('account projections retain exact actors and scope digests across fresh identity changes',()=>{
 const f=fixture();try{
  const check=label=>{for(const account of f.ir.all('accounts')){
   assert.deepEqual(observed(()=>f.identity.actorForAccount(account.id)),observed(()=>f.identity.readActorForAccount(account.id)),label+' actor '+account.id);
   assert.equal(f.identity.scopeDigest(account),f.identity.readScopeDigest(account),label+' digest '+account.id);
  }records.push(label);};
  check('original');
  const id=f.actor('alpha').id,account=f.ir.get('accounts',id),binding=f.ir.all('bindings').find(b=>b.accountId===id);
  f.ir.put('bindings',{...binding,status:'revoked',revision:binding.revision+1});check('revoked binding');
  f.ir.put('squadMembers',{id:'g08-null-member',memberId:null,squadId:'alpha',validTo:null});check('null member relationship');
  f.ir.put('bindings',binding);f.ir.put('accounts',{...account,status:'disabled'});check('disabled');
  f.ir.put('accounts',account);f.ir.put('restrictions',{id:'g08-restriction',accountId:id,startsAt:'2020-01-01T00:00:00Z',endsAt:null});check('restricted');
  f.ir.remove('restrictions','g08-restriction');
  const member=f.ir.get('members',account.memberId);f.ir.put('members',{...member,memberStatus:'left'});check('membership changed');
  f.ir.put('members',member);const session=f.identity.issueSession(account);f.ir.put('accounts',{...account,permissionVersion:account.permissionVersion+1});
  assert.equal(observed(()=>f.identity.session(session.token)).error,'PERMISSIONS_CHANGED');records.push('existing session rejected after permission change');
 }finally{f.db.close();}
});
test.after(()=>fs.writeFile('output/test-results/g08/identity-projection.json',JSON.stringify(records,null,2)+'\n'));
