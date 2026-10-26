import {fork} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {candidateConfig,candidateEnvironment} from '../../../server/v2/candidate-host/config.js';
export async function startBackend({directory,scale=5,cursorCount=100000,resume=false,log}){
 const config=candidateConfig({dataDirectory:directory,port:0,intervalMs:1000,shutdownGraceMs:15000});
 const child=fork(new URL('./backend.mjs',import.meta.url),[JSON.stringify({config,scale,cursorCount,resume})],{execArgv:['--import',new URL('../v2-stats/resolve.mjs',import.meta.url).pathname],env:candidateEnvironment(config,{searchPath:process.env.PATH}),stdio:['ignore','pipe','pipe','ipc']});
 const output=createWriteStream(log,{flags:'a'});child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
 const pending=new Map();let serial=0;
 child.on('message',m=>{if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(Error(m.error)):p.resolve(m.result);}});
 const exited=new Promise(r=>child.once('exit',(code,signal)=>{output.end();for(const p of pending.values())p.reject(Error('G08 child exited'));r({code,signal});}));
 const ready=await new Promise((resolve,reject)=>{child.on('message',m=>{if(m.ready)resolve(m)});child.once('error',reject);child.once('exit',(c)=>reject(Error('Backend exited '+c)));});
 const control=(action,args)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.send({id,action,args});});
 let stopped=false;
 return {ready,child,control,exited,async stop(){if(stopped)return;stopped=true;const final=child.connected?await control('stop'):null;await exited;return final;}};
}
export async function api(backend,path,{session=backend.ready.sessions[0],method='GET',body,key,headers={}}={}){
 const origin=backend.ready.origin;const response=await fetch(origin+'/api/v2'+path,{method,headers:{Cookie:`nb_v2_session=${session.token}; nb_v2_csrf=${session.csrfToken}`,...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,...(key?{'Idempotency-Key':key}:{})}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes)}catch{data=null}
 return {status:response.status,headers:Object.fromEntries(response.headers),bytes:bytes.length,body:data};
}
