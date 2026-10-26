// Controlled native wire responses and proof port only; no product imports this file.
import '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost} from '../../../server/v2/candidate-host/index.js';
import {hash} from '../../../server/v2/management-adapters/source-policy/model.js';
export async function fixture(config,{capabilities={steam:true},enabled=true,credentials=true,wipe=false,discord=false}={}){
  const password='Synthetic-Canonical-Root-Password';await initializeCandidate(config,{rootPassword:password});
  if(wipe||discord){const store=await import('../../../server/store.js');await store.updateStore(data=>{
    if(wipe){const startedAt=new Date(Date.now()-3600000).toISOString();data.wipes=[{id:'canonical-wipe',name:'候选当前档',timeZone:'Asia/Shanghai',status:'active',startedAt,actualStartedAt:startedAt,serverActualWipeAt:startedAt,serverPresetId:'canonical-server',serverName:'候选服务器',battlemetricsId:'12345',vitalServerId:'1',vitalWipeId:'native-wipe',kdaProvider:'vital',kdaMemberScope:'all_members',audience:{squadIds:[],memberIds:[],includeUnassigned:true}}];}
    if(discord)data.settings.discord={enabled:true,targets:[{id:'canonical-target-a',name:'指定候选 target',enabled:true,guildId:'400000000000000001',channelId:'400000000000000003',memberRegisterRoleId:'400000000000000002'},{id:'canonical-target-b',name:'不可默认选择',enabled:true,guildId:'500000000000000001',channelId:'500000000000000003',memberRegisterRoleId:'500000000000000002'}]};
    return true;});const storage=await import('../../../server/storage/sqlite.js');await storage.closeSqliteDatabases();}
  const p=await planCandidateMigration(config);await applyCandidateMigration(config,p,{expectedDigest:p.digest,operatorId:'user_root'});
  const calls=[],controls={enabled:false},native=credentials?{steamApiKey:'synthetic-canonical-steam-key',battlemetricsApiKey:'synthetic-canonical-battlemetrics-key',discordBotToken:'synthetic-canonical-discord-key'}:{};let interceptor;
  const gateway=createServer(async(req,res)=>{try{
    const u=new URL(req.url,'http://localhost'),chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;
    const id=u.searchParams.get('steamids')||u.searchParams.get('steamid')||'76561198999999211';calls.push({path:u.pathname,method:req.method,memberTransaction:f?.identity.repo.db.isTransaction===true});
    if(interceptor)await interceptor({path:u.pathname,body,id});
    let result;
    if(u.pathname.includes('GetPlayerSummaries'))result={response:{players:[{steamid:id,personaname:'采集昵称-'+id.slice(-4),avatarfull:'https://avatars.steamstatic.com/canonical.png',communityvisibilitystate:3}]}};
    else if(u.pathname.includes('GetOwnedGames'))result={response:{games:[{appid:252490,playtime_forever:12000}]}};
    else if(u.pathname.includes('GetPlayerBans'))result={players:[{SteamId:id,VACBanned:false,CommunityBanned:false,NumberOfVACBans:0,NumberOfGameBans:0,DaysSinceLastBan:0,EconomyBan:'none'}]};
    else if(u.pathname.includes('GetUserStatsForGame'))result={playerstats:{steamID:id,stats:[{name:'kill_player',value:25},{name:'deaths',value:5},{name:'rocket_fired',value:2}]}};
    else if(u.pathname==='/broadcast/getbroadcastmpd/')result={success:'ready',retry:0,eresult:1};
    else if(u.pathname.startsWith('/inventory/'))result={success:1,assets:[],descriptions:[],more_items:0};
    else if(u.pathname==='/players/match'){const steam=body.data[0].attributes.identifier;result={data:[{type:'identifier',id:'native-id',attributes:{type:'steamID',identifier:steam},relationships:{player:{data:{type:'player',id:'987654321'}}}}],included:[{type:'player',id:'987654321',attributes:{name:'BM canonical'}}]};}
    else if(u.pathname.includes('/relationships/sessions'))result={data:[{attributes:{start:new Date(Date.now()-1800000).toISOString(),stop:new Date(Date.now()-60000).toISOString()},relationships:{server:{data:{id:'12345'}}}}]};
    else if(u.pathname==='/players/overview')result={data:body.playerIds.map(id=>({context:{userId:id},player:{name:'Vital canonical'},statistics:{combat:{kills:30,deaths:6},raiding:{rockets:2},general:{playTime:1200}}}))};
    else if(u.pathname.endsWith('/roles'))result=[{id:'400000000000000001',name:'everyone'},{id:'400000000000000002',name:'member'}];
    else if(u.pathname.includes('/members/'))result={user:{id:u.pathname.split('/').at(-1),username:'canonicalDiscord'},roles:['400000000000000002']};
    else throw Error('Unhandled controlled native path '+u.pathname);
    res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}});
  await new Promise(r=>gateway.listen(0,'127.0.0.1',r));const gatewayOrigin=`http://127.0.0.1:${gateway.address().port}`;
  const bindings={collection:controls,sources:{capabilities,readCredentials:()=>({...native}),fetchImpl:async(url,input)=>{const u=new URL(url),response=await fetch(gatewayOrigin+u.pathname+u.search,input);
      // Explicit test transport boundary; preserve the real loopback response stream.
      return new Response(response.body,{status:response.status,headers:response.headers});}}};
  const host=createCandidateHost(config,{bindings});let f;const status=await host.start(),origin=status.origin,owners=host.owners(),identity=await owners.api.v2Runtime.getIdentity(),managed=owners.management.getSystem(identity);
  let cookie='',csrf='';
  async function request(route,{body,method=body===undefined?'GET':'POST',key=randomUUID()}={}){const r=await fetch(origin+'/api/v2'+route,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','Idempotency-Key':key,'X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.match(r.headers.get('content-type'),/json/,route);return {status:r.status,body:await r.json(),headers:r.headers};}
  identity.ownerPasswordLogin=true; // Explicit owner recovery login for this isolated HTTP fixture.
 const signed=await request('/auth/owner-password',{body:{username:'root',password}});assert.equal(signed.status,200,JSON.stringify(signed.body));cookie=signed.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=signed.body.data.csrfToken;
  const account=await request('/system-admin/commands/account.create',{body:{input:{expectedRevision:0,username:'canonical-collector',password:'Synthetic-Collector-Password',roleId:'admin'}}});assert.equal(account.status,200,JSON.stringify(account.body));
  const principalId=account.body.data.current.id;assert.notEqual(principalId,'user_root');controls.principal={accountId:principalId,permissionVersion:identity.repo.get('accounts',principalId).permissionVersion};controls.enabled=enabled;
  if(wipe){const current=identity.repo.get('schedulingWipes','canonical-wipe');const r=await request('/wipes/canonical-wipe/commands/confirm-server-start',{body:{expectedRevision:current.revision,serverActualWipeAt:new Date(Date.now()-3600000).toISOString(),serverStartEvidence:'Controlled local HTTP confirmation'}});assert.equal(r.status,200,JSON.stringify(r.body));}
  if(discord)controls.discord={targetId:'canonical-target-a',configurationRevision:managed.platforms.service.config('discord').revision,legacyRulesDigest:hash(managed.platforms.service.repo.get('legacy-archive','discord'))};
  for(const source of ['steam','battlemetrics','kda','discord']){const r=await request('/sync-center/sources/'+source,{body:{expectedRevision:1,minIntervalMs:0}});assert.equal(r.status,200,JSON.stringify(r.body));}
  f={host,owners,identity,managed,request,controls,native,capabilities,calls,principalId,setInterceptor:fn=>interceptor=fn,
    create:async(steamId='76561198999999211',fields={})=>{const r=await request('/member-admin/members',{body:{steamInput:steamId,fields}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;},
    jobs:()=>managed.service.repo.rows('job',{limit:501}),
    progress:()=>{const seq=identity.repo.db.prepare('SELECT max(seq) n FROM v2_member_admin_outbox').get().n;return {seq,checkpoint:managed.memberOutbox.position(),followup:managed.followups.progress(seq)};},
    async drain(){for(let i=0;i<100;i++){await owners.management.tick();if(!managed.service.repo.activeJobs().length)break;await new Promise(r=>setTimeout(r,30));}},
    async close(){try{await host.stop();}finally{gateway.closeAllConnections();await new Promise(r=>gateway.close(r));}}
  };
  return f;
}
