import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthFlow } from '../src/v2/auth-flow.js';

test('owner sign-in requires the advertised capability and adopts the resulting admin session', async () => {
  let enabled = false, generation = 0, identity;
  const calls = [], changes = [], visits = [];
  const client = {getGeneration:()=>generation, getIdentity:()=>identity,
    request:async (path,options)=>{calls.push(path); return {data:path.endsWith('/providers')?{ownerPasswordLogin:enabled}:{accountId:'user_root'}};}};
  const flow = createAuthFlow({client, continuing:false, returnTo:'/app/home',onChange:s=>changes.push(s),go:(...a)=>visits.push(a),refreshSession:async()=>{
    generation++; identity={accountId:'user_root',workspaces:{member:false,admin:true},capabilities:['scheduling.read']}; return identity;
  }});
  try {
    await flow.load(); await flow.ownerLogin('test-ephemeral-owner-password');
    assert.deepEqual(calls,['/api/v2/auth/providers']);
    enabled=true; await flow.load(); await flow.ownerLogin('test-ephemeral-owner-password');
    assert.equal(calls.at(-1),'/api/v2/auth/owner-password');
    assert.equal(visits.length,1); assert.match(visits[0][0],/^\/admin\//);
    assert.equal(JSON.stringify(changes).includes('test-ephemeral-owner-password'),false);
  } finally {flow.dispose();}
});
