import '../results.mjs';
import {fixture} from './fixture.mjs';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {createRequire} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
const root=process.cwd(),require=createRequire(new URL('../../../package.json', import.meta.url)),dir=root+'/test/support/v2-edit-unknown-recovery/.runtime';
await mkdir(dir,{recursive:true});const f=await fixture({lateTimeoutMs:120000});let vite;
try{
 const ids=await f.prepare({queueWhileWaiting:true});
 f.app.get('/__fixture/ids',(_req,res)=>res.json(ids));
 f.app.get('/__fixture/original-message',async(_req,res)=>res.json(await f.observe()));
 f.app.post('/__fixture/next-snapshot',(_req,res)=>{const w=f.sr.get('wipes','host-wipe');f.sr.put('wipes',{...w,serverSnapshot:{...w.serverSnapshot,mapLink:'https://example.invalid/target-v3'}});res.json({ok:true});});
 f.app.post('/__fixture/run-worker',async(_req,res)=>{await f.worker.runOnce({workerId:'g08-desktop',limit:10});res.json({ok:true});});
 f.app.post('/__fixture/release-late',async(_req,res)=>{await f.releaseLate();res.json({ok:true});});
 const snapshot=()=>({ids,delivery:f.notifications.getDelivery(f.actor('admin'),ids.deliveryId),calls:f.calls,attempts:f.notifications.repo.all('attempts').map(({id,messageOperationId,resultKind,lateEvidence})=>({id,messageOperationId,resultKind,lateEvidence})),refs:f.notifications.repo.all('messageRefs'),operations:f.notifications.repo.all('messageOperations').map(({id,status,reconciliation,cancellation})=>({id,status,reconciliation,cancellation}))});
 f.app.get('/__fixture/state',(_req,res)=>res.json(snapshot()));
 f.app.post('/__fixture/save-evidence',async(_req,res)=>{await writeFile(root+'/output/test-results/g08-edit-unknown/desktop-state.json',JSON.stringify(snapshot(),null,2)+'\n',{mode:0o644});res.json({ok:true});});
 vite=await createServer({root,appType:'custom',configFile:false,envFile:false,envDir:false,cacheDir:dir+'/vite',plugins:[react()],resolve:{alias:['react/jsx-dev-runtime','react/jsx-runtime','react-dom/client','react-dom','react','lucide-react'].map(name=>({find:new RegExp('^'+name+'$'),replacement:require.resolve(name)}))},server:{middlewareMode:true,hmr:{server:f.server},fs:{allow:[root,decodeURIComponent(new URL('../../../node_modules', import.meta.url).pathname)],deny:['.env','.env.*','**/data/**','**/.git/**','**/work/**']}}});
 f.app.use(vite.middlewares);
 f.app.get('/',async(req,res)=>res.type('html').send(await vite.transformIndexHtml('/', '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>未知编辑恢复验证</title><div id="root"></div><script type="module" src="/test/support/v2-edit-unknown-recovery/ui-entry.jsx"></script></html>')));
 await writeFile(dir+'/ui.json',JSON.stringify({origin:f.origin,pid:process.pid,...ids}));console.log(f.origin);
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await vite.close();await f.close();process.exit(0);});
}catch(e){await vite?.close();await f.close();throw e;}
