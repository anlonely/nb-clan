import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {api} from './host.mjs';
export async function cursorReads(backend,record){
  const result={};
  for(const kind of ['chats','invites']){
    let cursor=null,maximumBytes=0;const times=[];
    for(let i=0;i<1000;i++){
      const beginMs=performance.now();let response,error;
      try{response=await api(backend,`/realtime/g08-0/${kind}?limit=50`+(cursor?'&before='+encodeURIComponent(cursor):''),{session:backend.ready.admin});assert.equal(response.status,200);assert.ok(response.body.data.items.length<=50);cursor=response.body.data.nextCursor;}
      catch(e){error=e.message;}
      const endMs=performance.now();record({phase:'cursor-read',kind,index:i,beginMs,endMs,bytes:response?.bytes,status:response?.status,error});assert.equal(error,undefined);
      maximumBytes=Math.max(maximumBytes,response.bytes);times.push(endMs-beginMs);
    }
    times.sort((a,b)=>a-b);result[kind]={n:times.length,p95:times[949],p99:times[989],maximumBytes};
  }
  return result;
}
