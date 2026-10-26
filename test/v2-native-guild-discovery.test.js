import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/v2-native-platform-metadata/fixture.mjs';

const guildId=n=>String(100000000000000000n+BigInt(n));
function clearConfiguration(f,platform){
  f.db.prepare("DELETE FROM platform_admin_records WHERE kind='config' AND platform=?").run(platform);
  assert.equal(f.service.config(platform).enabled,false);
  assert.deepEqual(f.service.config(platform).targets,[]);
}
const discover=(f,platform,input={},actor='admin')=>f.request(platform,'metadata',{targetId:undefined,kind:'guilds',...input},randomUUID(),actor);

test('Discord discovery before configuration returns names and string IDs through HTTP, and follows after without truncating pages',async()=>{
  const f=await fixture();try{
    clearConfiguration(f,'discord');
    f.fault=({req,res})=>{
      const q=new URL('http://localhost'+req.url).searchParams;
      const rows=q.has('after')?[{id:guildId(51),name:'第二页'}]:Array.from({length:50},(_,i)=>({id:guildId(i+1),name:'服务器 '+(i+1),permissions:'8',token:'must-not-leak'}));
      res.end(JSON.stringify(rows));return true;
    };
    const first=await discover(f,'discord',{page:1});
    assert.equal(first.data.status,'succeeded',JSON.stringify(first));
    assert.deepEqual(first.data.resource,{kind:'platformTarget',id:'discord'});
    assert.equal(first.data.result.items.length,50);
    assert.deepEqual(first.data.result.items[0],{id:guildId(1),label:'服务器 1',status:'guild'});
    assert.equal(first.data.result.reference,guildId(50));
    const next=await discover(f,'discord',{page:2,after:first.data.result.reference});
    assert.equal(next.data.status,'succeeded',JSON.stringify(next));
    assert.deepEqual(next.data.result.items,[{id:guildId(51),label:'第二页',status:'guild'}]);
    assert.equal(next.data.result.reference,null);
    assert.deepEqual(f.calls.map(x=>[x.method,x.path]),[['GET','/api/v10/users/@me/guilds?limit=50'],['GET',`/api/v10/users/@me/guilds?limit=50&after=${guildId(50)}`]]);
    assert.doesNotMatch(JSON.stringify([first,next]),/must-not-leak|permissions|synthetic-.*-secret/);
  }finally{await f.close();}
});

test('KOOK discovery before configuration follows numbered pages and handles empty guild lists',async()=>{
  const f=await fixture();try{
    clearConfiguration(f,'kook');let empty=false;
    f.fault=({req,res})=>{
      const page=Number(new URL('http://localhost'+req.url).searchParams.get('page'));
      res.end(JSON.stringify({code:0,data:{items:empty?[]:[{id:'kook-'+page,name:'KOOK '+page}],meta:{page,page_size:50,total:empty?0:51,page_total:empty?1:2}}}));return true;
    };
    const first=await discover(f,'kook');
    assert.equal(first.data.status,'succeeded',JSON.stringify(first));
    assert.equal(first.data.result.reference,'2');
    assert.deepEqual(first.data.result.items,[{id:'kook-1',label:'KOOK 1',status:'guild'}]);
    const second=await discover(f,'kook',{page:2});assert.equal(second.data.result.reference,null);
    empty=true;const none=await discover(f,'kook');assert.deepEqual(none.data.result.items,[]);assert.equal(none.data.result.reference,null);
    assert.deepEqual(f.calls.slice(0,2).map(x=>x.path),['/api/v3/guild/list?page=1&page_size=50','/api/v3/guild/list?page=2&page_size=50']);
  }finally{await f.close();}
});

test('guild discovery preserves authorization, bounded inputs, credentials and existing target gates',async()=>{
  const f=await fixture();try{
    clearConfiguration(f,'discord');
    assert.equal((await discover(f,'discord',{},'viewer')).status,403);
    for(const input of [{page:2},{page:1,after:guildId(1)},{after:'https://evil.invalid'},{url:'https://evil.invalid'},{channelType:1}]){
      const result=await discover(f,'discord',input);assert.equal(result.data.status,'failed',JSON.stringify(result));
    }
    assert.equal((await discover(f,'kook',{after:guildId(1)})).data.status,'failed');
    for(const action of ['metadata','register_commands'])assert.equal((await f.request('discord',action)).data.status,'failed');
    f.tokens.discord=null;
    const missing=await discover(f,'discord');assert.equal(missing.data.errorCode,'NATIVE_PLATFORM_CREDENTIALS_REQUIRED');
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('guild discovery discards results if configuration, actor or credentials change during the GET',async()=>{
  for(const mutation of ['config','actor','credentials']){
    const f=await fixture();try{
      clearConfiguration(f,'discord');
      f.fault=({res})=>{
        if(mutation==='config'){const c=f.service.config('discord');f.service.repo.put('config','discord','discord','admin',f.now(),{...c,revision:c.revision+1});}
        if(mutation==='actor'){const a=f.ir.get('accounts','admin');f.ir.put('accounts',{...a,permissionVersion:a.permissionVersion+1});}
        if(mutation==='credentials')f.tokens.discord={...f.tokens.discord,revision:'2'};
        res.end(JSON.stringify([{id:guildId(1),name:'must-not-leak'}]));return true;
      };
      const result=await discover(f,'discord');assert.equal(result.data.status,'failed',JSON.stringify(result));
      assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(result),/must-not-leak/);
    }finally{await f.close();}
  }
});

test('channel, role and retained command paths keep their existing behavior',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('discord','metadata')).data.result.items[0].status,'channel:0');
    assert.equal((await f.request('discord','metadata',{kind:'roles'})).data.result.items[0].status,'role');
    assert.equal((await f.request('kook','metadata')).data.result.reference,'2');
    assert.equal((await f.request('kook','metadata',{kind:'roles'})).data.result.items[0].id,'702');
    assert.equal((await f.request('discord','register_commands',{commandIds:['kda']})).data.result.counts.succeeded,1);
    assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  }finally{await f.close();}
});
