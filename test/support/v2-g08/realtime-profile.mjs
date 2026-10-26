import '../results.mjs';
import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {startBackend,api} from './host.mjs';
import {openStreams} from './load.mjs';
const directory=process.argv[2],ev='output/test-results/g08',result={directory};let backend,streams;
try{
  backend=await startBackend({directory,resume:true,log:ev+'/realtime-profile-backend.log'});streams=await openStreams(backend,20);await backend.control('metrics');await backend.control('profile-start');
  const start=performance.now(),samples=[];
  for(let n=0;n<50;n++){
    const begin=performance.now();await backend.control('chat',{id:'profile-'+Date.now()+'-'+n,message:'x'.repeat(1024)});samples.push(performance.now()-begin);
    if(n%25===0)await Promise.all(backend.ready.sessions.slice(1).map(session=>api(backend,'/me/home',{session})));
    await new Promise(r=>setTimeout(r,Math.max(0,200-(performance.now()-begin))));
  }
  result.elapsedMs=performance.now()-start;result.ingressSamples=samples;result.profile=await backend.control('profile-stop');result.metric=await backend.control('metrics');
}catch(e){result.error=e.stack;process.exitCode=1;}finally{await streams?.close();result.shutdown=await backend?.stop().catch(e=>({error:e.stack}));await fs.writeFile(ev+'/realtime-profile.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({elapsedMs:result.elapsedMs,error:result.error,top:result.profile?.top.slice(0,15)}));}
