import {performance} from 'node:perf_hooks';import {randomUUID} from 'node:crypto';
import {api} from './host.mjs';
export const paths={home:'/me/home',wipe:'/wipes/fixture_wipe_0/summary',signup:'/wipes/fixture_wipe_0/signups?limit=50',members:'/member-admin/members?limit=50',stats:'/stats/rows?wipeId=fixture_wipe_0&sourceId=vital&metricVersion=nb-kda-1&limit=50'};
const cycle=['home','home','home','home','home','home','wipe','wipe','wipe','wipe','wipe','signup','signup','signup','signup','members','members','members','stats','stats'];
export async function shortReads(backend,record,{samplesPerPath=1000,signal}={}){
 let next=0;const rounds=Math.ceil(samplesPerPath/2),total=rounds*cycle.length,counts={},durations={},errors=[];
 await Promise.all(Array.from({length:10},async(_,worker)=>{while(next<total&&!signal?.aborted){const index=next++,kind=cycle[index%cycle.length],begin=performance.now();let r,error;try{r=await api(backend,paths[kind]);if(r.status!==200||r.body?.error||!r.body?.data)throw Error(r.body?.error?.errorCode||'INVALID_RESPONSE');counts[kind]=(counts[kind]||0)+1;}catch(e){error=e.message;}if(error)errors.push({kind,error});else(durations[kind]||=[]).push(performance.now()-begin);record({phase:'short-read',kind,index,worker,beginMs:begin,endMs:performance.now(),status:r?.status,bytes:r?.bytes,error});}}));
 if(signal?.aborted)throw Error('G08_ABORTED');for(const kind of Object.keys(paths))if(!(counts[kind]>=samplesPerPath))throw Error(`G08 ${kind} insufficient valid samples ${counts[kind]||0}`);
 const latency=Object.fromEntries(Object.entries(durations).map(([kind,values])=>{values.sort((a,b)=>a-b);return [kind,{n:values.length,p95:values[Math.ceil(values.length*.95)-1],p99:values[Math.ceil(values.length*.99)-1]}];}));
 return {counts,latency,errors,concurrency:10,ratio:{home:.30,wipe:.25,signup:.20,members:.15,stats:.10}};
}
export async function signupBurst(backend,record,{seconds=60,rate=10,signal}={}){
 const revisions=new Map(),inflight=new Set(),errors=[],started=performance.now();let valid=0;
 for(let i=0;i<seconds*rate&&!signal?.aborted;i++){
  const index=i%10,session=backend.ready.sessions[index];if(!revisions.has(index)){const current=await api(backend,'/wipes/fixture_wipe_0/my-signup',{session});if(current.status!==200)throw Error('G08 signup seed read failed');revisions.set(index,current.body.data.signupRevision);}
  const due=started+i*1000/rate;await new Promise(r=>setTimeout(r,Math.max(0,due-performance.now())));
  const begin=performance.now(),revision=revisions.get(index);revisions.set(index,revision+1);
  const task=(async()=>{let r,error;try{r=await api(backend,'/wipes/fixture_wipe_0/my-signup',{session,method:'PUT',key:randomUUID(),body:{response:Math.floor(i/10)%2?'attending_on_time':'not_attending',expectedSignupRevision:revision,confirmedContentRevision:1,timeZone:'Asia/Shanghai'}});if(r.status!==200||r.body?.error)throw Error(r.body?.error?.errorCode||'INVALID_RESPONSE');}catch(e){error=e.message;}if(error)errors.push({index:i,error});else valid++;record({phase:'signup-burst',index:i,accountIndex:index,dueMs:due,beginMs:begin,endMs:performance.now(),status:r?.status,bytes:r?.bytes,error});})();inflight.add(task);task.finally(()=>inflight.delete(task));
 }
 await Promise.all(inflight);if(signal?.aborted)throw Error('G08_ABORTED');if(errors.length)throw Error('G08 signup write failures: '+JSON.stringify(errors.slice(0,10)));if(valid!==seconds*rate)throw Error('G08 insufficient signup samples');return {seconds,rate,valid,errors};
}
export async function openStreams(backend,count=20){
 const controllers=[],streams=[],session=backend.ready.admin;
 for(let i=0;i<count;i++){
  const controller=new AbortController();controllers.push(controller);
  const response=await fetch(backend.ready.origin+`/api/v2/realtime/g08-${i%2}/stream`,{headers:{Cookie:`nb_v2_session=${session.token}`},signal:controller.signal});if(response.status!==200)throw Error('G08 stream '+response.status);
  const state={i,scope:i%2,bytes:0,frames:0,realtime:0,duplicates:0,types:{},closed:false,ids:new Set()};streams.push(state);
  state.done=(async()=>{let buffer='';const decoder=new TextDecoder();try{for await(const chunk of response.body){
   state.bytes+=chunk.length;buffer+=decoder.decode(chunk,{stream:true});let end;
   while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const lines=frame.split('\n'),type=lines.find(l=>l.startsWith('event: '))?.slice(7);if(!type)continue;
    state.frames++;state.types[type]=(state.types[type]||0)+1;state.lastEventId=lines.find(l=>l.startsWith('id: '))?.slice(4)||state.lastEventId;
    const raw=lines.find(l=>l.startsWith('data: '))?.slice(6);if(type==='realtime'&&raw){const data=JSON.parse(raw);if(data.eventType==='chat.created'){state.realtime++;state.lastMessageId=data.payload.id;if(state.ids.has(data.payload.id))state.duplicates++;state.ids.add(data.payload.id);}}
   }
  }}catch(e){state.error=controller.signal.aborted?'aborted':e.message;}finally{state.closed=true;}})();
 }
 return {snapshot:()=>streams.map(({done,ids,...s})=>({...s,uniqueMessages:ids.size})),verify:expected=>streams.map(s=>({i:s.i,scope:s.scope,expected:s.scope===0?expected.length:0,received:s.ids.size,missing:s.scope===0?expected.filter(id=>!s.ids.has(id)):[],duplicates:s.duplicates,closed:s.closed})),async close(){controllers.forEach(c=>c.abort());await Promise.all(streams.map(s=>s.done));}};
}
