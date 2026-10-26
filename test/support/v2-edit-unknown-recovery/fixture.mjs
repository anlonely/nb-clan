import { authenticatedSession } from '../authenticated-session.mjs';
import {fixture as original} from '../v2-platform-host/fixture.mjs';
import {installNotificationBusinessSchema,installNotificationPlatformCardSchema,createNotificationRouter} from '../../../server/v2/notifications/index.js';
import {createNotificationWorker} from '../../../server/v2/notifications/worker.js';
import {createPlatformCards} from '../../../server/v2/platform-admin/cards.js';
import {createNotificationPlatforms,buildNativeNotificationRequest} from '../../../server/v2/notification-platforms/platforms.js';
import {createIdentityRouter} from '../../../server/v2/identity/routes.js';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
export async function fixture({lateTimeoutMs=5000}={}){
 const cleanup=[];const close=async()=>{for(const fn of cleanup.splice(0).reverse())await fn();};try{
 const dir=mkdtempSync(join(tmpdir(),'g08-edit-unknown-')),filename=join(dir,'isolated.sqlite'),f=original({filename});cleanup.push(async()=>{await f.close();rmSync(dir,{recursive:true,force:true});});await f.start();
 installNotificationBusinessSchema(f.db);installNotificationPlatformCardSchema(f.db);
 const targets=()=>f.g06.targets().map(t=>({...t,label:t.name,languages:['zh-CN'],roleOptions:[]}));Object.assign(f.notifications.catalog,{listTargets:targets,getTarget:id=>targets().find(t=>t.id===id)});
 const cards=createPlatformCards({identity:f.identity,scheduling:f.scheduling,stats:f.stats,notifications:f.notifications,platformService:f.platformService,runStoreWriteTask:f.runStoreWriteTask,now:f.now});Object.assign(f.platformService.adapters.cards,cards);
 const calls=[],messages=new Map();let hold=false,applyHeld=true,release,heldResponse,onHeld;cleanup.push(async()=>release?.());
 const upstream=express();upstream.use(express.json());upstream.use((req,res,next)=>{calls.push({method:req.method,path:req.path});next();});
 upstream.post('/api/v10/channels/:channel/messages',(req,res)=>{const value={...req.body,id:'fixture-original-message',channel_id:req.params.channel,guild_id:'100000000000000001'};messages.set(value.id,value);res.json(value);});
 upstream.get('/api/v10/channels/:channel/messages/:id',(req,res)=>{const m=messages.get(req.params.id);res.status(m?200:404).json(m||{code:10008});});
 upstream.patch('/api/v10/channels/:channel/messages/:id',async(req,res)=>{const m=messages.get(req.params.id);if(!m)return res.status(404).json({code:10008});if(hold&&!applyHeld){hold=false;heldResponse=new Promise(r=>{release=r;});await heldResponse;return res.status(503).json({error:'isolated provider did not apply edit'});}const next={...m,...req.body};messages.set(req.params.id,next);if(hold){hold=false;onHeld?.();heldResponse=new Promise(r=>{release=r;});await heldResponse;}res.json(next);});
 const upstreamServer=createServer(upstream);cleanup.push(async()=>{release?.();upstreamServer.closeAllConnections();await new Promise(r=>upstreamServer.close(r));});await new Promise(r=>upstreamServer.listen(0,'127.0.0.1',r));const upstreamOrigin=`http://127.0.0.1:${upstreamServer.address().port}`;
 const transport={runtimeMode:'isolated',async respondPrivate(){throw Error('UNUSED_PRIVATE_RESPONSE');},async request(args){const request=buildNativeNotificationRequest(args);const r=await fetch(upstreamOrigin+request.path,{method:request.method,headers:{'Content-Type':'application/json'},...(request.body?{body:JSON.stringify(request.body)}:{})});return {status:r.status,headers:{},body:await r.json()};}};
 const native=createNotificationPlatforms({transport,now:f.now});
 // Non-cooperative adapter returns its native HTTP result late; worker must fence it.
 f.notifications.platforms={...native,discord:{...native.discord,edit:args=>native.discord.edit({...args,context:{...args.context,signal:new AbortController().signal,timeoutMs:lateTimeoutMs}})}};
 f.notifications.options.requestTimeoutMs=80;f.notifications.options.leaseMs=1000;const worker=createNotificationWorker(f.notifications);cleanup.push(()=>worker.stop());
 const app=express(),server=createServer(app);cleanup.push(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,auth=createIdentityRouter({service:f.identity,origin,providers:{}});
 cleanup.push(()=>auth.stopEvents());
 const session=await authenticatedSession(f.identity,'admin');
 app.get('/__fixture/session',(req,res)=>{res.cookie('nb_v2_session',session.token,{httpOnly:true,sameSite:'strict'});res.json({accountId:'admin',scopeVersion:1,csrfToken:session.csrfToken});});
 app.use('/api/v2',express.json(),(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:options=>auth.authenticate(options)(req)};next();},auth,f.host.adminRouter,createNotificationRouter({getSystem:()=>({service:f.notifications})}));
 async function request(path,{method='GET',body,operationId=randomUUID()}={}){const r=await fetch(origin+'/api/v2'+path,{method,headers:{'Content-Type':'application/json',Cookie:'nb_v2_session='+session.token,Origin:origin,'X-CSRF-Token':session.csrfToken,'Idempotency-Key':operationId},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};}
 async function action(name,input,id=randomUUID()){const r=await request('/platform-admin/discord/actions/'+name,{method:'POST',operationId:id,body:{expectedRevision:1,targetId:'discord-target',cardType:'map',wipeId:'host-wipe',...input}});if(r.status!==200)throw Error(JSON.stringify(r));return r.data;}
 const preview=async()=> (await action('card_preview',{})).result.preview;
 async function prepare({apply=true,queueWhileWaiting=false}={}){const p=await preview(),q=await action('card_publish',{previewId:p.id,contentHash:p.contentHash});await worker.runOnce({workerId:'g08-worker',limit:10});await worker.runOnce({workerId:'g08-worker',limit:10});const w=f.sr.get('wipes','host-wipe');f.sr.put('wipes',{...w,serverSnapshot:{...w.serverSnapshot,mapLink:'https://example.invalid/target-v2'}});const update=await preview();const queued=await action('card_refresh',{previewId:update.id,contentHash:update.contentHash});let queuedEditId,queuedWhileStatus;hold=true;applyHeld=apply;onHeld=()=>{if(queueWhileWaiting){const op=f.notifications.repo.get('messageOperations',queued.result.reference),d=f.notifications.repo.get('deliveries',q.result.reference);queuedWhileStatus=op.status;queuedEditId=f.notifications.queueMessageOperation(d,'edit',{messageRefId:op.messageRefId,reasonCode:'REFRESH_REQUESTED'}).id;}};await worker.runOnce({workerId:'g08-worker',limit:10});return {deliveryId:q.result.reference,editId:queued.result.reference,queuedEditId,queuedWhileStatus};}
 async function observe(){const r=await fetch(upstreamOrigin+'/api/v10/channels/200000000000000001/messages/fixture-original-message');return r.json();}
 async function releaseLate(){release?.();for(let i=0;i<100&& !f.notifications.repo.all('attempts').some(a=>a.lateEvidence?.length);i++)await new Promise(r=>setTimeout(r,5));}
 return {...f,filename,origin,upstreamOrigin,app,server,session,reauthenticate:async()=>Object.assign(session,await authenticatedSession(f.identity,'admin')),calls,messages,worker,request,action,preview,prepare,observe,releaseLate,close};
 }catch(error){await close();throw error;}
}
