import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-native-platform-metadata/fixture.mjs';
import { retainedDiscordCommandSchemas } from '../server/v2/notification-platforms/native-interactions.js';

const applicationId='500000000000000001',privateGuild='1153571748147634236',rsgGuild='1554983512321425488';
const definition={id:'newwipe',name:'Open sign-up',type:'event_command',slashCommand:'newwipe',enabled:true};
const personal={id:'personal',name:'Personal server',guildId:privateGuild,channelId:'1153571748147634237',enabled:true,enabledCommandIds:['newwipe']};
const rsg={id:'rsg',name:'Clan Portal',guildId:rsgGuild,channelId:'1554985837962207302',enabled:true,enabledCommandIds:['map','wipe']};
const commands=[definition,{id:'wipe',name:'wipe-react',type:'event_command',slashCommand:'wipe-react',signupMode:'member_required',enabled:true}];
const config=()=>({enabled:true,commands:structuredClone(commands),targets:structuredClone([personal,rsg])});

test('newwipe registration opens settings without requiring an existing wipe or mention option',()=>{
  const schema=retainedDiscordCommandSchemas({...config(),targets:[personal]});
  assert.equal(schema.length,1);assert.equal(schema[0].name,'newwipe');assert.equal(schema[0].type,1);
  assert.deepEqual(schema[0].options,[]);
  const retained=retainedDiscordCommandSchemas({...config(),targets:[rsg]});
  assert.deepEqual(retained.map(row=>row.name),['map','wipe-react']);
  assert.equal(retained.find(row=>row.name==='wipe-react').options[0].name,'wipe');
});

test('newwipe slash description supports the six requested languages and English default',()=>{
  const schema=retainedDiscordCommandSchemas({...config(),targets:[personal]})[0];
  assert.match(schema.description,/open wipe sign-up/i);assert.ok(schema.description.length<=100);
  for(const locale of ['zh-CN','ru','tr','th','ko']){
    const description=schema.description_localizations[locale];
    assert.equal(typeof description,'string');assert.ok(description.length>0&&description.length<=100);
    assert.notEqual(description,schema.description);
  }
  assert.equal(typeof schema.description_localizations['zh-TW'],'string');
});

test('disabled or unassigned newwipe does not appear in guild command registration',()=>{
  for(const edit of [c=>c.commands[0].enabled=false,c=>c.targets[0].enabled=false,c=>c.targets[0].enabledCommandIds=[]]){
    const input=config();input.targets=[structuredClone(personal)];edit(input);
    assert.deepEqual(retainedDiscordCommandSchemas(input),[]);
  }
});

async function setup(t){
  const f=await fixture();t.after(()=>f.close());const current=f.service.config('discord');
  f.service.save(f.identity.actorForAccount('admin'),'discord',{expectedRevision:current.revision,config:config()},{operationId:randomUUID()});
  f.fault=async({req,res,body})=>{
    if(req.method!=='POST')return false;
    const match=/^\/api\/v10\/applications\/(\d+)\/guilds\/(\d+)\/commands$/.exec(req.url);
    assert.ok(match);res.statusCode=201;
    res.end(JSON.stringify({...body,id:'800000000000000021',application_id:match[1],guild_id:match[2]}));return true;
  };
  return f;
}

test('native registration sends only newwipe to the selected personal guild and replay does not register twice',async t=>{
  const f=await setup(t),operationId=randomUUID();
  const before=f.service.config('discord').targets.find(row=>row.id==='rsg');
  const result=await f.request('discord','register_commands',{targetId:'personal',commandIds:['newwipe']},operationId);
  assert.equal(result.status,200);assert.equal(result.data.status,'succeeded',JSON.stringify(result));
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'POST');
  assert.equal(f.calls[0].path,`/api/v10/applications/${applicationId}/guilds/${privateGuild}/commands`);
  assert.equal(f.calls[0].body.name,'newwipe');assert.deepEqual(f.calls[0].body.options,[]);
  assert.deepEqual(f.service.config('discord').targets.find(row=>row.id==='rsg'),before);
  const replay=await f.request('discord','register_commands',{targetId:'personal',commandIds:['newwipe']},operationId);
  assert.equal(replay.data.status,'succeeded');assert.equal(f.calls.length,1);
});

test('requesting newwipe for unassigned RSG fails before any native mutation',async t=>{
  const f=await setup(t);
  const result=await f.request('discord','register_commands',{targetId:'rsg',commandIds:['newwipe']});
  assert.equal(result.data.status,'failed',JSON.stringify(result));assert.equal(f.calls.length,0);
});
