import {IdentityError} from '../../identity/errors.js';
import {authorize} from '../../identity/permissions.js';
import {PlatformAdminService,sanitizeGuildIcon} from '../../platform-admin/service.js';
import {hash} from '../../platform-admin/model.js';
import {retainedDiscordCommandSchemas} from '../../notification-platforms/native-interactions.js';

const origins={discord:'https://discord.com',kook:'https://www.kookapp.cn'};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
const snowflake=v=>typeof v==='string'&&/^\d{17,20}$/.test(v);
const fail=(code,status=503)=>{throw new IdentityError(code,status);};
const need=(v,code='NATIVE_PLATFORM_INPUT_INVALID',status=422)=>{if(!v)fail(code,status);};
const sync=v=>{need(!v?.then,'NATIVE_PLATFORM_SYNC_READER_REQUIRED',503);return v;};
const label=v=>{need(typeof v==='string'&&v.length>0&&v.length<=200,'NATIVE_PLATFORM_RESPONSE_INVALID',502);return v.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,100);};
const dto=(state,items,extra={})=>({schema:'platform-result/1',state,items,...extra});
const rejected=new Set([400,401,403,404,405,413,422,429]);

/** Concrete native HTTP mapping; all credentials/network policy remain trusted host ports.
 * getPlatformService is lazy; factory construction does not access identity, DB or network.
 */
export function createNativePlatformMetadata({getPlatformService,readCredentials,fetchImpl,
  timeoutMs=5000,maxBytes=524288,maxActive=4}={}){
  need([getPlatformService,readCredentials,fetchImpl].every(f=>typeof f==='function'),'NATIVE_PLATFORM_HOST_REQUIRED',503);
  need(Number.isInteger(timeoutMs)&&timeoutMs>=20&&timeoutMs<=30000&&Number.isInteger(maxBytes)&&maxBytes>=1024&&maxBytes<=2097152&&Number.isInteger(maxActive)&&maxActive>=1&&maxActive<=16,'NATIVE_PLATFORM_LIMIT_INVALID');
  let accepting=true;const pending=new Set(),controllers=new Set();
  function start(args,action){
    need(accepting,'NATIVE_PLATFORM_STOPPED',503);
    need(pending.size<maxActive,'NATIVE_PLATFORM_BUSY',429);
    const service=sync(getPlatformService());need(service instanceof PlatformAdminService,'NATIVE_PLATFORM_OWNER_REQUIRED',503);
    const {identity}=service,{platform,input,actor,operationId}=args||{};
    need(['discord','kook'].includes(platform)&&input&&typeof input==='object'&&!Array.isArray(input));
    const discovery=action==='metadata'&&input.kind==='guilds';
    const keys=action==='metadata'?['expectedRevision','targetId','kind','page','channelType','after']:['expectedRevision','targetId','commandIds'];
    need(Object.keys(input).every(k=>keys.includes(k))&&(discovery&&input.targetId===undefined||id(input.targetId)));
    const config=service.config(platform),configHash=hash(config),record=service.repo.get('operation',operationId);
    need(record?.status==='running'&&record.action===action&&record.actorId===actor?.id&&record.platform===platform&&record.revision===config.revision&&record.digest===hash({id:platform,input,action}),'NATIVE_PLATFORM_OPERATION_REQUIRED',409);
    need(typeof args.assertCurrent==='function'&&args.config&&hash(args.config)===configHash&&input.expectedRevision===config.revision,'NATIVE_PLATFORM_CONFIG_CHANGED',409);
    const targets=config.targets?.filter(t=>t.id===input.targetId);
    if(!discovery)need(config.enabled===true&&targets?.length===1&&targets[0].enabled===true,'NATIVE_PLATFORM_TARGET_DISABLED',409);
    const target=discovery?null:structuredClone(targets[0]);
    if(target)need(platform==='discord'?snowflake(target.guildId):id(target.guildId),'NATIVE_PLATFORM_GUILD_INVALID');
    const pv=actor.permissionVersion,scope=identity.scopeDigest(identity.actorForAccount(actor.id));
    const current=()=>{
      need(accepting,'NATIVE_PLATFORM_STOPPED',503);const asserted=sync(args.assertCurrent()),fresh=identity.actorForAccount(actor.id);
      need(asserted?.id===actor.id&&fresh.permissionVersion===pv&&asserted.permissionVersion===pv&&identity.scopeDigest(fresh)===scope,'NATIVE_PLATFORM_AUTH_CHANGED',403);
      authorize(fresh,'platforms.configure',{kind:'platformTarget',id:platform},identity.relations());
      if(target)authorize(fresh,'platforms.configure',{kind:'platformTarget',id:target.id},identity.relations());
      need(hash(service.config(platform))===configHash,'NATIVE_PLATFORM_CONFIG_CHANGED',409);
      return fresh;
    };
    current();
    function credential(){const c=sync(readCredentials({platform,target:structuredClone(target),identity,db:identity.repo.db}));
      need(c&&typeof c.botToken==='string'&&c.botToken.length>0&&c.botToken.length<=4096&&!/[\x00-\x20\x7f]/.test(c.botToken)&&typeof c.revision==='string'&&c.revision.length>0&&c.revision.length<=160&&id(c.transportKey),'NATIVE_PLATFORM_CREDENTIALS_REQUIRED',503);return {botToken:c.botToken,revision:c.revision,transportKey:c.transportKey};}
    const credentialHash=hash(credential());
    const check=()=>{current();const c=credential();need(hash(c)===credentialHash,'NATIVE_PLATFORM_CREDENTIALS_CHANGED',409);return c;};
    const controller=new AbortController();controllers.add(controller);
    return {service,identity,platform,input,config,target,check,controller,writeStarted:false,writeAttempts:0};
  }
  async function request(context,method,path,body=null){
    const {platform,check,controller}=context,c=check();need(!controller.signal.aborted,'NATIVE_PLATFORM_TIMEOUT',504);
    const url=new URL(path,origins[platform]);need(url.origin===origins[platform]&&!url.hash&&!url.username&&!url.password,'NATIVE_PLATFORM_ROUTE_INVALID');
    // Paths/body are private products of the two methods below; no request URL/header port exists.
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      if(['POST','PATCH','DELETE'].includes(method)){context.writeStarted=true;context.writeAttempts++;}
      const response=await fetchImpl(url.href,{method,redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bot ${c.botToken}`,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
      need(!controller.signal.aborted,'NATIVE_PLATFORM_TIMEOUT',504);check();
      need(response&&Number.isInteger(response.status),'NATIVE_PLATFORM_RESPONSE_INVALID',502);
      if(method==='DELETE'&&response.status===204){check();need(!controller.signal.aborted,'NATIVE_PLATFORM_TIMEOUT',504);return null;}
      need(response.body?.[Symbol.asyncIterator],'NATIVE_PLATFORM_RESPONSE_INVALID',502);
      const length=response.headers?.get?.('content-length');need(!length||/^\d+$/.test(length)&&Number(length)<=maxBytes,'NATIVE_PLATFORM_RESPONSE_TOO_LARGE',502);
      const chunks=[];let bytes=0;
      for await(const chunk of response.body){bytes+=chunk.byteLength;need(bytes<=maxBytes,'NATIVE_PLATFORM_RESPONSE_TOO_LARGE',502);chunks.push(Buffer.from(chunk));need(!controller.signal.aborted,'NATIVE_PLATFORM_TIMEOUT',504);}
      let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('NATIVE_PLATFORM_RESPONSE_INVALID',502);}
      check();need(!controller.signal.aborted,'NATIVE_PLATFORM_TIMEOUT',504);
      if(response.status===429){const e=new IdentityError('NATIVE_PLATFORM_RATE_LIMITED',429);e.nativeRejected=true;throw e;}
      if(response.status<200||response.status>=300){const e=new IdentityError(rejected.has(response.status)?'NATIVE_PLATFORM_REJECTED':'NATIVE_PLATFORM_RESULT_UNKNOWN',502);e.nativeRejected=rejected.has(response.status);throw e;}
      if(platform==='kook'){need(data&&Number.isInteger(data.code),'NATIVE_PLATFORM_RESPONSE_INVALID',502);need(data.code===0,'NATIVE_PLATFORM_REJECTED',502);data=data.data;}
      return data;
    }catch(error){const aborted=controller.signal.aborted;controller.abort();if(error instanceof IdentityError)throw error;fail(aborted?'NATIVE_PLATFORM_TIMEOUT':'NATIVE_PLATFORM_IO_FAILED',502);}
    finally{clearTimeout(timer);}
  }
  function run(args,action,fn){
    let context;
    try{context=start(args,action);}catch(error){if(!(error instanceof IdentityError))error=new IdentityError('NATIVE_PLATFORM_UNAVAILABLE',503);error.definitelyNotApplied=true;throw error;}
    const work=(async()=>{try{return await fn(context);}catch(error){const e=error instanceof IdentityError?error:new IdentityError('NATIVE_PLATFORM_UNAVAILABLE',503);e.definitelyNotApplied=!context.writeStarted||error.nativeRejected===true&&context.writeAttempts===1;throw e;}
      finally{context.controller.abort();controllers.delete(context.controller);}})();
    pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
  }
  const metadata=args=>run(args,'metadata',async c=>{
    const {platform,input,target}=c,kind=input.kind||'channels',page=input.page??1;
    need(['channels','roles','guilds'].includes(kind)&&Number.isInteger(page)&&page>=1&&page<=1000);
    need(input.channelType===undefined||kind==='channels'&&[1,2].includes(input.channelType));
    need(input.after===undefined||kind==='guilds'&&platform==='discord'&&snowflake(input.after));
    let rows,total,pageTotal,reference;
    if(platform==='discord'){
      need(input.channelType===undefined,'NATIVE_PLATFORM_INPUT_INVALID');
      if(kind==='guilds'){
        need(page===1?input.after===undefined:snowflake(input.after));
        const query=new URLSearchParams({limit:'50',...(input.after?{after:input.after}:{})});
        const raw=await request(c,'GET',`/api/v10/users/@me/guilds?${query}`);
        need(Array.isArray(raw)&&raw.length<=50&&raw.every(r=>snowflake(r?.id)&&(!input.after||BigInt(r.id)>BigInt(input.after)))&&new Set(raw.map(r=>r.id)).size===raw.length,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
        rows=raw;total=raw.length;
        // Discord exposes no total; counts describe this page. Keep snowflakes as strings.
        reference=raw.length===50?raw.reduce((max,r)=>BigInt(r.id)>BigInt(max)?r.id:max,raw[0].id):null;
      }else{
        const raw=await request(c,'GET',`/api/v10/guilds/${target.guildId}/${kind}`);need(Array.isArray(raw)&&raw.length<=2000,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
        need(raw.every(r=>snowflake(r?.id)&&(r.guild_id==null||r.guild_id===target.guildId))&&new Set(raw.map(r=>r.id)).size===raw.length,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
        total=raw.length;pageTotal=Math.ceil(total/50);rows=raw.slice((page-1)*50,page*50);
      }
    }else{
      const query=new URLSearchParams({... (kind==='guilds'?{}:{guild_id:target.guildId}),page:String(page),page_size:'50',...(kind==='channels'?{type:String(input.channelType??1)}:{})});
      const raw=await request(c,'GET',`/api/v3/${kind==='guilds'?'guild':kind==='channels'?'channel':'guild-role'}/list?${query}`);
      need(Array.isArray(raw?.items)&&raw.items.length<=50&&raw.meta?.page===page&&raw.meta.page_size===50&&Number.isInteger(raw.meta.total)&&raw.meta.total>=0&&Number.isInteger(raw.meta.page_total)&&raw.meta.page_total>=0&&(raw.meta.page_total===Math.ceil(raw.meta.total/50)||raw.meta.total===0&&raw.meta.page_total===1),'NATIVE_PLATFORM_RESPONSE_INVALID',502);
      rows=raw.items;total=raw.meta.total;pageTotal=raw.meta.page_total;
    }
    const items=rows.map(r=>{
      need(r&&typeof r==='object'&&(kind==='guilds'||r.guild_id==null||r.guild_id===target.guildId),'NATIVE_PLATFORM_RESPONSE_INVALID',502);
      const key=kind==='roles'&&platform==='kook'?r.role_id:r.id;
      need(platform==='kook'&&kind==='roles'?Number.isSafeInteger(key)&&key>=0:id(key),'NATIVE_PLATFORM_RESPONSE_INVALID',502);
      if(kind==='channels')need(Number.isInteger(r.type)&&r.type>=0&&r.type<=99,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
      const iconUrl=kind==='guilds'?sanitizeGuildIcon(platform==='discord'&&typeof r.icon==='string'&&/^(?:a_)?[a-f0-9]{32}$/.test(r.icon)?`https://cdn.discordapp.com/icons/${key}/${r.icon}.${r.icon.startsWith('a_')?'gif':'png'}?size=128`:platform==='kook'?r.icon:null):null;
      return {id:String(key),label:label(r.name),...(iconUrl?{iconUrl}:{}),status:kind==='guilds'?'guild':kind==='roles'?'role':r.is_category===true||platform==='discord'&&r.type===4?'category':`channel:${r.type}`};
    });
    need(new Set(items.map(r=>r.id)).size===items.length,'NATIVE_PLATFORM_RESPONSE_INVALID',502);c.check();
    return dto('succeeded',items,{reference:reference===undefined?(page<pageTotal?String(page+1):null):reference,counts:{total,succeeded:items.length,failed:0,skipped:0,unknown:0}});
  });
  const registerCommands=args=>run(args,'register_commands',async c=>{
    need(c.platform==='discord','NATIVE_PLATFORM_COMMAND_UNSUPPORTED');need(snowflake(c.config.applicationId),'NATIVE_PLATFORM_APPLICATION_REQUIRED');
    const schemasForTarget=()=>retainedDiscordCommandSchemas({...structuredClone(c.config),targets:[structuredClone(c.target)]});
    const schemas=schemasForTarget();need(Array.isArray(schemas)&&schemas.length<=25,'NATIVE_PLATFORM_COMMAND_SCHEMA_INVALID',503);
    const selected=c.input.commandIds;need(selected===undefined||Array.isArray(selected)&&selected.length>0&&selected.length<=25&&new Set(selected).size===selected.length&&selected.every(id),'NATIVE_PLATFORM_COMMAND_INVALID');
    // The shared native interaction module produces schemas only for supported handlers.
    const commands=schemas;
    need(selected===undefined||selected.every(name=>commands.some(c=>c.name===name)),'NATIVE_PLATFORM_COMMAND_UNSUPPORTED');
    const chosen=selected?commands.filter(c=>selected.includes(c.name)):commands;
    need(chosen.length>0&&new Set(chosen.map(c=>c.name)).size===chosen.length,'NATIVE_PLATFORM_COMMAND_UNSUPPORTED');
    const items=[];let succeeded=0;
    for(const command of chosen){
      // Re-derive this reviewed schema at every boundary; no client-provided command body.
      const before=c.writeAttempts;
      try{
        c.check();need(hash(schemasForTarget())===hash(schemas),'NATIVE_PLATFORM_COMMAND_SCHEMA_CHANGED',409);
        const path=`/api/v10/applications/${c.config.applicationId}/guilds/${c.target.guildId}/commands`;
        let result,expectedId;
        if(command.name==='wipe-react'){
          // Rename only the retired Wipe slash command; never bulk overwrite a guild's commands.
          const existing=await request(c,'GET',path);
          need(Array.isArray(existing)&&existing.length<=200&&existing.every(row=>snowflake(row?.id)&&row.application_id===c.config.applicationId&&row.guild_id===c.target.guildId&&[1,2,3].includes(row.type)&&typeof row.name==='string'&&row.name.length>0&&row.name.length<=100)&&new Set(existing.map(row=>row.id)).size===existing.length,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
          const old=existing.filter(row=>row.type===1&&row.name==='wipe'),current=existing.filter(row=>row.type===1&&row.name===command.name);
          need(old.length<=1&&current.length<=1,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
          const retained=current[0]||old[0];
          if(retained){
            expectedId=retained.id;const {type,...update}=command;
            result=await request(c,'PATCH',`${path}/${retained.id}`,update);
          }else result=await request(c,'POST',path,command);
          need(snowflake(result?.id)&&(!expectedId||result.id===expectedId)&&result.application_id===c.config.applicationId&&result.guild_id===c.target.guildId&&result.name===command.name&&result.type===1,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
          if(old[0]&&current[0])await request(c,'DELETE',`${path}/${old[0].id}`);
        }else result=await request(c,'POST',path,command);
        need(snowflake(result?.id)&&result.application_id===c.config.applicationId&&result.guild_id===c.target.guildId&&result.name===command.name&&result.type===1,'NATIVE_PLATFORM_RESPONSE_INVALID',502);
        c.check();succeeded++;items.push({id:result.id,label:`/${command.name}`,status:'succeeded'});
      }catch(error){
        const unknown=c.writeAttempts>before&&(error.nativeRejected!==true||c.writeAttempts-before>1);
        const state=unknown?'unknown':succeeded?'partial':'failed';
        items.push({id:command.name,label:`/${command.name}`,status:unknown?'unknown':'failed'});
        return dto(state,items,{errorCode:error instanceof IdentityError?error.errorCode:'NATIVE_PLATFORM_UNAVAILABLE',counts:{total:chosen.length,succeeded,failed:unknown?0:1,unknown:unknown?1:0,skipped:chosen.length-items.length}});
      }
    }
    return dto('succeeded',items,{counts:{total:chosen.length,succeeded,failed:0,unknown:0,skipped:0}});
  });
  return {platformMetadata:Object.freeze({metadata,registerCommands}),async stop(){accepting=false;for(const c of controllers)c.abort();await Promise.allSettled([...pending]);},diagnostics:()=>({accepting,active:pending.size,externalVerified:false})};
}
