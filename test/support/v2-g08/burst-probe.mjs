import '../results.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {startBackend,api} from './host.mjs';
import {openStreams} from './load.mjs';
import {staticWeb} from './web.mjs';
import {launchBrowser,pageFor} from './browser.mjs';
const directory=process.argv[2],ev='output/test-results/g08',result={directory};let backend,streams,browser,web;
try{
  backend=await startBackend({directory,resume:!process.argv.includes('--fresh'),log:ev+'/burst-probe-backend.log'});
  web=await staticWeb(backend,path.resolve('work/v2-g08/build-final'));
  const dir=path.resolve('work/v2-g08/profile-'+randomUUID());await fs.mkdir(dir,{recursive:true});browser=await launchBrowser(dir);
  const pages=[];for(let i=0;i<10;i++){const session=await pageFor(browser,web.origin,backend.ready.sessions[i]);await session.page.goto(web.origin+(i?'/app/home':'/admin/realtime/chat?scope=g08-0'));pages.push(session);}
  const chat=pages[0].page;await chat.bringToFront();await chat.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='开始接收'));await chat.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='开始接收').click());await chat.waitForSelector('[data-message-id]');
  streams=await openStreams(backend,20);await backend.control('metrics');
  const pending=new Map(),early=new Map(),samples=[],browserSSE=[],acceptedIds=[];let failure;pages[0].cdp.on('Network.eventSourceMessageReceived',event=>{if(event.eventName==='realtime'){const data=JSON.parse(event.data);if(data.eventType==='chat.created')browserSSE.push({id:data.payload.id,atMs:performance.now()});}});
  const finish=(id,start,end)=>{samples.push({id,beginMs:start,endMs:end,ms:end-start});pending.delete(id);};
  await chat.exposeFunction('__g08Probe',ids=>{const end=performance.now();for(const id of ids){if(pending.has(id))finish(id,pending.get(id),end);else early.set(id,end);}});
  await chat.evaluate(()=>{const seen=new Set([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId));new MutationObserver(()=>{const ids=[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId).filter(id=>!seen.has(id));ids.forEach(id=>seen.add(id));if(ids.length)window.__g08Probe(ids);}).observe(document.querySelector('.rt-chat-list'),{childList:true,subtree:true});});
  await backend.control('profile-start');const start=performance.now(),jobs=[];result.offered=[];
  for(let n=0;n<200;n++){
    const scheduledMs=start+n*50;await new Promise(r=>setTimeout(r,Math.max(0,scheduledMs-performance.now())));
    const beginMs=performance.now();jobs.push((async()=>{const reply=await backend.control('chat',{id:'burst-probe-'+start+'-'+n,message:'x'.repeat(n%20===0?8192:1024)});acceptedIds.push(reply.id);result.offered.push({id:reply.id,n,beginMs,scheduledMs,acceptedMs:performance.now(),accepted:reply.result.accepted});if(early.has(reply.id)){finish(reply.id,beginMs,early.get(reply.id));early.delete(reply.id);}else pending.set(reply.id,beginMs);})().catch(e=>{failure=e.stack;}));
    if(n%100===0)jobs.push(Promise.all(pages.slice(1).map(({page})=>page.evaluate(()=>fetch('/api/v2/me/home').then(r=>r.json())))).catch(e=>{failure=e.stack;}));
  }
  await Promise.all(jobs);await new Promise(r=>setTimeout(r,2000));result.elapsedMs=performance.now()-start;result.samples=samples;result.unseen=pending.size;result.error=failure;
  const values=samples.map(r=>r.ms).sort((a,b)=>a-b);result.p95=values[Math.ceil(values.length*.95)-1];result.profile=await backend.control('profile-stop');result.browserSSE=browserSSE;result.delivery=streams.verify(acceptedIds);result.streams=streams.snapshot();result.metric=await backend.control('metrics');result.page=await chat.evaluate(()=>({text:document.body.innerText,visible:document.visibilityState,messages:document.querySelectorAll('[data-message-id]').length}));await chat.screenshot({path:ev+'/burst-probe.png'});

}catch(e){result.error=e.stack;process.exitCode=1;}finally{await streams?.close();await browser?.close();await web?.close();await new Promise(r=>setTimeout(r,500));result.shutdown=await backend?.stop().catch(e=>({error:e.stack}));await fs.writeFile(ev+'/burst-probe.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({elapsedMs:result.elapsedMs,error:result.error,p95:result.p95,offered:result.offered?.length,seen:result.samples?.length,unseen:result.unseen,lag:result.metric?.eventLoop}));}
