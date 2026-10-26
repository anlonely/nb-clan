import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/v2-native-platform-metadata/fixture.mjs';

const applicationId='500000000000000001',guildId='100000000000000001';
const path=`/api/v10/applications/${applicationId}/guilds/${guildId}/commands`;
const oldId='800000000000000011',currentId='800000000000000012';
const command=(id,name,type=1)=>({id,name,type,application_id:applicationId,guild_id:guildId,description:'Existing command'});
async function setup(rows,hook){
 const f=await fixture();f.commands=structuredClone(rows);
 const config=f.service.config('discord');
 f.service.save(f.identity.actorForAccount('admin'),'discord',{expectedRevision:config.revision,config:{targets:[{...config.targets[0],enabledCommandIds:['wipe']}],commands:[{id:'wipe',name:'wipe-react',type:'event_command',slashCommand:'wipe-react',enabled:true,signupMode:'member_required'}]}},{operationId:randomUUID()});
 f.fault=async context=>{
  if(hook&&await hook(context,f))return true;
  const {req,res,body}=context;
  if(req.method==='GET'&&req.url===path){res.end(JSON.stringify(f.commands));return true;}
  if(req.method==='PATCH'){
   assert.equal(body.type,undefined,'Discord command type is immutable in PATCH');
   const existing=f.commands.find(row=>req.url===`${path}/${row.id}`);assert.ok(existing);
   Object.assign(existing,body);res.end(JSON.stringify(existing));return true;
  }
  if(req.method==='DELETE'){
   f.commands=f.commands.filter(row=>req.url!==`${path}/${row.id}`);res.statusCode=204;res.end();return true;
  }
  return false;
 };
 return f;
}

test('wipe-react registration renames only retired slash /wipe and preserves its ID',async()=>{
 const untouched=[command('800000000000000021','map'),command('800000000000000022','wipe',2)];
 const f=await setup([command(oldId,'wipe'),...untouched]);try{
  const key=randomUUID(),result=await f.request('discord','register_commands',{commandIds:['wipe-react']},key);
  assert.equal(result.data.status,'succeeded',JSON.stringify(result));assert.equal(result.data.result.items[0].id,oldId);
  assert.deepEqual(f.calls.map(row=>[row.method,row.path]),[['GET',path],['PATCH',`${path}/${oldId}`]]);
  assert.deepEqual(f.commands.slice(1),untouched);assert.equal(f.commands[0].name,'wipe-react');
  await f.request('discord','register_commands',{commandIds:['wipe-react']},key);assert.equal(f.calls.length,2,'receipt replay does not rename twice');
 }finally{await f.close();}
});

test('existing wipe-react updates in place then removes only duplicate retired /wipe',async()=>{
 const unrelated=command('800000000000000021','map');
 const f=await setup([command(oldId,'wipe'),command(currentId,'wipe-react'),unrelated]);try{
  const result=await f.request('discord','register_commands',{commandIds:['wipe-react']});
  assert.equal(result.data.status,'succeeded',JSON.stringify(result));assert.equal(result.data.result.items[0].id,currentId);
  assert.deepEqual(f.calls.map(row=>[row.method,row.path]),[['GET',path],['PATCH',`${path}/${currentId}`],['DELETE',`${path}/${oldId}`]]);
  assert.deepEqual(f.commands.map(row=>row.name),['wipe-react','map']);assert.deepEqual(f.commands[1],unrelated);
 }finally{await f.close();}
});

test('wipe-react without a retired slash command creates only the canonical command',async()=>{
 const f=await setup([command('800000000000000022','wipe',2)]);try{
  const result=await f.request('discord','register_commands',{commandIds:['wipe-react']});
  assert.equal(result.data.status,'succeeded',JSON.stringify(result));
  assert.deepEqual(f.calls.map(row=>[row.method,row.path]),[['GET',path],['POST',path]]);assert.equal(f.calls[1].body.name,'wipe-react');
 }finally{await f.close();}
});

test('foreign or duplicate guild command records stop wipe-react before any write',async()=>{
 for(const rows of [[{...command(oldId,'wipe'),guild_id:'100000000000000002'}],[command(oldId,'wipe'),command(currentId,'wipe')]]){
  const f=await setup(rows);try{
   const result=await f.request('discord','register_commands',{commandIds:['wipe-react']});assert.equal(result.data.status,'failed',JSON.stringify(result));
   assert.equal(result.data.result.errorCode,'NATIVE_PLATFORM_RESPONSE_INVALID');assert.deepEqual(f.calls.map(row=>row.method),['GET']);
  }finally{await f.close();}
 }
});

test('known PATCH rejection does not create another command or remove the old one',async()=>{
 const f=await setup([command(oldId,'wipe')],({req,res})=>{if(req.method!=='PATCH')return false;res.statusCode=429;res.end(JSON.stringify({retry_after:1}));return true;});try{
  const key=randomUUID(),result=await f.request('discord','register_commands',{commandIds:['wipe-react']},key);
  assert.equal(result.data.status,'failed',JSON.stringify(result));assert.equal(result.data.result.counts.failed,1);assert.equal(result.data.result.counts.unknown,0);
  await f.request('discord','register_commands',{commandIds:['wipe-react']},key);assert.deepEqual(f.calls.map(row=>row.method),['GET','PATCH']);assert.equal(f.commands[0].name,'wipe');
 }finally{await f.close();}
});

test('a rejection removing retired /wipe after successful PATCH reports an unknown result and never retries',async()=>{
 const f=await setup([command(oldId,'wipe'),command(currentId,'wipe-react')],({req,res})=>{if(req.method!=='DELETE')return false;res.statusCode=429;res.end(JSON.stringify({retry_after:1}));return true;});try{
  const key=randomUUID(),result=await f.request('discord','register_commands',{commandIds:['wipe-react']},key);
  assert.equal(result.data.status,'result_unknown',JSON.stringify(result));assert.equal(result.data.result.counts.unknown,1);assert.equal(result.data.result.counts.succeeded,0);
  await f.request('discord','register_commands',{commandIds:['wipe-react']},key);assert.deepEqual(f.calls.map(row=>row.method),['GET','PATCH','DELETE']);assert.equal(f.commands.length,2);
 }finally{await f.close();}
});

test('credentials changing during PATCH remain unknown without unsafe fallback POST',async()=>{
 const f=await setup([command(oldId,'wipe')],({req},fixture)=>{if(req.method==='PATCH')fixture.tokens.discord={...fixture.tokens.discord,revision:'2'};return false;});try{
  const result=await f.request('discord','register_commands',{commandIds:['wipe-react']});assert.equal(result.data.status,'result_unknown',JSON.stringify(result));
  assert.deepEqual(f.calls.map(row=>row.method),['GET','PATCH']);assert.doesNotMatch(JSON.stringify(result),/synthetic-.*-secret/);
 }finally{await f.close();}
});

test('malformed PATCH identity remains unknown and prevents deletion of retired /wipe',async()=>{
 const f=await setup([command(oldId,'wipe'),command(currentId,'wipe-react')],({req,res,body})=>{if(req.method!=='PATCH')return false;res.end(JSON.stringify({...command('800000000000000099','wipe-react'),...body}));return true;});try{
  const result=await f.request('discord','register_commands',{commandIds:['wipe-react']});assert.equal(result.data.status,'result_unknown',JSON.stringify(result));
  assert.deepEqual(f.calls.map(row=>row.method),['GET','PATCH']);assert.equal(f.commands.length,2);
 }finally{await f.close();}
});
