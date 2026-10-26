import {fixture,cursorFixture,SEED} from '../v2-baseline/fixtures.mjs';
import {createHash} from 'node:crypto';
import {MEMBER_GRANTS,CAPABILITIES,grant} from '../../../server/v2/identity/permissions.js';
import {signupId} from '../../../server/v2/scheduling/service.js';
import {upsertSqliteCollectionRecord} from '../../../server/storage/sqlite-migrate.js';
import {createRelaySourceAdapter} from '../../../server/v2/realtime/source.js';
import {normalizeRustplusRelayPayload} from '../../../server/rustplus-relay.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function seed({identity,system,scale=5,cursorCount=100000}){
 const inputs=[fixture(1),fixture(5)];for(const x of inputs)if(x.manifest.sha256!==fixture(x.manifest.label==='S1'?1:5).manifest.sha256)throw Error('Non-deterministic fixture');
 const data=fixture(scale).data,now=Date.now(),stamp=new Date(now).toISOString(),repo=identity.repo,s=system.scheduling.repo,loaded={};
 repo.transaction(()=>{
  for(const q of data.squads)repo.put('squads',{...q,revision:1});
  for(const r of data.squadMembers)repo.put('squadMembers',{...r,validFrom:'2026-09-08T00:00:00Z',validTo:null});
  for(const [i,m]of data.members.entries()){
   repo.put('members',{...m,displayName:m.customName,timeZone:'Asia/Shanghai',language:'zh-CN',revision:1});
   repo.put('accounts',{id:`g08_account_${i}`,memberId:m.id,status:'active',roleId:i===0?'admin':'member',permissionVersion:1,revision:1,createdAt:stamp,grants:i===0?CAPABILITIES.map(c=>grant(c,{type:'all'})):structuredClone(MEMBER_GRANTS)});
   repo.put('bindings',{id:`g08_binding_${i}`,accountId:`g08_account_${i}`,memberId:m.id,steamId:m.steamId,status:'verified',verifiedAt:stamp,proofSource:'synthetic_g08_password_identity',revision:1});
  }
  for(const [i,w]of data.wipes.entries()){
   const row={id:w.id,title:`G08 构造档期 ${i}`,description:'',lifecycle:i===0?'active':'scheduled',revision:1,contentRevision:1,signupWindow:'open',signupOpensAt:new Date(now-86400000).toISOString(),signupClosesAt:new Date(now+7*86400000).toISOString(),musterAt:new Date(now+(i+1)*3600000).toISOString(),timeZone:'Asia/Shanghai',serverScheduledWipeAt:null,serverProfileId:`fixture-server-${i%2}`,serverSnapshot:{name:`构造服务器 ${i%2}`,directConnect:'client.connect 127.0.0.1:28015'},audience:{squadIds:[],memberIds:data.members.map(m=>m.id),includeUnassigned:true}};
   s.put('wipes',row);s.put('contents',{...row,id:`${w.id}:1`,wipeId:w.id,contentRevision:1});
  }
  for(const p of data.wipeParticipants)s.put('signups',{id:signupId(p.wipeId,p.memberId),wipeId:p.wipeId,memberId:p.memberId,response:p.status==='skip'?'not_attending':'attending_on_time',signupRevision:1,confirmedContentRevision:1,expectedArrivalAt:null,timeZone:'Asia/Shanghai',updatedAt:stamp,source:'synthetic'});
  for(const k of data.kdaRows)upsertSqliteCollectionRecord(repo.db,'kdaRows',k.id,{...k,source:'vital',sourceId:'vital'});
 });
 const realtime=system.realtime.repository;
 for(const i of [0,1])realtime.bind({id:`g08-${i}`,sourceId:'g08-collector',serverKey:`g08-collector:server-${i}`,resource:{kind:'squad',id:data.squads[i].id},label:`G08 实时服务器 ${i}`});
 const source=createRelaySourceAdapter({repository:realtime,normalizePayload:normalizeRustplusRelayPayload});
 const ingest=(i,n,message)=>source.ingest(`g08-${i}`,{type:'clan_chat_message',id:`g08-live-${n}`,client:{id:'g08-collector',name:'G08'},server:{id:`server-${i}`,name:`G08 实时服务器 ${i}`},steamId:data.members[0].steamId,displayName:'G08 测量',message,sentAt:new Date().toISOString()},{sourceEpoch:realtime.scope(`g08-${i}`).epoch});
 const cursor=[];
 repo.transaction(()=>{
  const insert=repo.db.prepare('INSERT INTO v2_realtime_records(scope,kind,id,occurred,received,payload) VALUES(?,?,?,?,?,?)');
  for(const kind of ['chat','audit']){const digest=createHash('sha256');let count=0,bytes=0;
   for(const row of cursorFixture(kind,cursorCount)){const line=JSON.stringify(row)+'\n';digest.update(line);bytes+=Buffer.byteLength(line);count++;
    insert.run(`g08-${row.sequence%2}`,kind==='chat'?'chat':'invite',row.id,row.occurredAt,row.occurredAt,JSON.stringify({id:row.id,steamId:data.members[0].steamId,displayName:'G08 构造游标',message:row.text,status:kind==='audit'?'accepted':undefined,sentAt:row.occurredAt}));}
   cursor.push({kind,count,bytes,sha256:digest.digest('hex'),projection:kind==='chat'?'realtime chat':'realtime invite audit'});
  }
 });
 for(const collection of ['members','squads','squadMembers'])loaded[collection]=repo.all(collection).length;
 loaded.wipes=s.all('wipes').length;loaded.signups=s.all('signups').length;loaded.kdaRows=repo.db.prepare("SELECT count(*) n FROM json_records WHERE collection='kdaRows'").get().n;
 return {manifest:{seed:SEED,inputs:inputs.map(x=>x.manifest),loadedScale:`S${scale}`,loaded,transformedAt:stamp,transformSha256:hash({data,stamp,cursor}),cursor},ingest};
}
