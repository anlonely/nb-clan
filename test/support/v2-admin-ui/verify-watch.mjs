import '../results.mjs';
import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { root } from './config.mjs';
import { runtimeWatchOptions } from './watch-options.mjs';
const base=path.join(root,'work/g06-a');await mkdir(base,{recursive:true});assert.equal(await realpath(base),base);
const runDir=await mkdtemp(path.join(base,'runtime-watch-')),projectRoot=path.join(runDir,'fixture-root');
await mkdir(path.join(projectRoot,'src'),{recursive:true});
const source=path.join(projectRoot,'src/watch-probe.txt');await writeFile(source,'initial');
const server=createServer((_req,res)=>res.end('watch fixture'));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const events=[],messages=[];
const vite=await createViteServer({root:projectRoot,configFile:false,envFile:false,envDir:false,appType:'custom',logLevel:'silent',
  server:{middlewareMode:true,hmr:{server},watch:runtimeWatchOptions(projectRoot),host:'127.0.0.1'},optimizeDeps:{noDiscovery:true,include:[]}});
const normalize=file=>path.relative(projectRoot,file).split(path.sep).join('/');
vite.watcher.on('all',(event,file)=>events.push({event,path:normalize(file)}));
const send=vite.ws.send.bind(vite.ws);vite.ws.send=(...args)=>{messages.push(args);return send(...args);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let report;
try{
  for(let attempt=0;attempt<20&&!events.some(e=>e.path==='src/watch-probe.txt');attempt++){await pause(100);await appendFile(source,`\nprobe-${attempt}`);}
  await pause(200);assert.ok(events.some(e=>e.path==='src/watch-probe.txt'),'Positive control: actual Vite watcher must observe source edits');
  events.length=0;messages.length=0;
  const outputs=['work/g06-a/runtime-build/index.html','output/test-results/g06-a/index.html','dist/index.html'];
  for(const relative of outputs){const file=path.join(projectRoot,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'<!doctype html><title>isolated output</title>');}
  await pause(500);
  for(const relative of outputs)await appendFile(path.join(projectRoot,relative),'\n<!-- changed -->');
  await pause(600);
  assert.equal(events.filter(e=>outputs.includes(e.path)).length,0,'Generated output must not reach the Vite watcher');
  assert.equal(messages.filter(args=>args[0]?.type==='full-reload'||args[0]?.type==='update').length,0,'Generated output must not cause reload/update messages');
  report={at:new Date().toISOString(),passed:3,checks:['Actual Vite watcher observes source-directory changes','Generated work/evidence/dist files produce no watcher events','Generated HTML writes produce no Vite reload/update messages'],observedGeneratedEvents:0,observedReloadMessages:0,browser:false,network:'loopback-only',source:'standalone actual Vite watcher verification'};
  await writeFile(path.join(runDir,'watch-verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,report:path.join(runDir,'watch-verification.json')},null,2));
}finally{await vite.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
