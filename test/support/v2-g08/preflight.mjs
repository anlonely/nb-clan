import '../results.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {startBackend,api} from './host.mjs';
import {staticWeb} from './web.mjs';
import {launchBrowser,currentDesktop} from './browser.mjs';
const ev=path.resolve('output/test-results/g08'),dir=process.argv.find(a=>a.startsWith('--resume='))?.slice(9)||path.resolve('work/v2-g08/preflight-'+randomUUID()),result={dir};
let backend,web,browser;
try{
  await fs.mkdir(dir,{recursive:true});backend=await startBackend({directory:dir+'/nb-v2-candidate-preflight',scale:5,cursorCount:200,resume:process.argv.some(a=>a.startsWith('--resume=')),log:ev+'/preflight-backend.log'});
  if(!process.argv.includes('--desktop-only')){const begin=performance.now();result.notification=await backend.control('notification-enqueue',{wipeId:'fixture_wipe_1'});result.enqueueMs=performance.now()-begin;
  console.log(JSON.stringify({notification:result.notification,enqueueMs:result.enqueueMs}));
  for(let n=0;n<100;n++){const rows=await backend.control('notification-rows');result.notificationRows=rows;if(rows.length&&rows.every(r=>r.status==='sent'))break;await new Promise(r=>setTimeout(r,300));}
  assert.ok(result.notificationRows.every(r=>r.status==='sent'),JSON.stringify(result.notificationRows));
  result.metric=await backend.control('metrics');}
  web=await staticWeb(backend,path.resolve('work/v2-g08/build-final'));browser=await launchBrowser(dir);
  result.desktop=(await currentDesktop({browser,web,backend,record:()=>{},ev})).results;
  result.success=true;
}catch(e){result.error=e.stack;console.error(e.stack);process.exitCode=1;if(browser){for(const [n,p]of(await browser.pages()).entries()){result['page'+n]=await p.evaluate(()=>({url:location.href,text:document.body.innerText})).catch(()=>null);}}}finally{
  await fs.writeFile(ev+'/preflight.json',JSON.stringify(result,null,2)+'\n');
  await browser?.close();await web?.close();result.stopped=await backend?.stop().catch(e=>({error:e.stack}));
  await fs.writeFile(ev+'/preflight.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({success:result.success,error:result.error}));
}
