import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {syncJob,waitJob} from './recovery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function steady({backend,desktop,pages,streams,record,signal}){
  const expectedURL=desktop.chat.url();
  const pending=new Map(),early=new Map(),latencies=[],acceptedIds=[],browserReceived=new Set(),inflight=new Set();
  let period='warmup',timer,metricTask,syncPromise,liveIndex=0,environmentFailure;
  desktop.chat.on('close',()=>{environmentFailure='Measurement page closed';});
  desktop.chat.on('framenavigated',frame=>{if(frame===desktop.chat.mainFrame()&&frame.url()!==expectedURL){environmentFailure='Measurement page navigated: '+frame.url();record({phase:'environment-change',url:frame.url(),atMs:performance.now()});}});
  await desktop.chat.exposeFunction('__g08EnvironmentChanged',event=>{record({phase:'environment-change',...event,atMs:performance.now()});environmentFailure='Measurement page changed: '+event.kind;});
  await desktop.chat.evaluate(()=>{document.addEventListener('visibilitychange',()=>{if(document.hidden)window.__g08EnvironmentChanged({kind:'hidden',url:location.href});});for(const type of ['pointerdown','keydown'])document.addEventListener(type,event=>{if(event.isTrusted)window.__g08EnvironmentChanged({kind:type,url:location.href});},{capture:true});});
  const finish=(id,entry,endMs)=>{const ms=endMs-entry.beginMs;latencies.push(ms);record({phase:'chat-propagation',id,...entry,endMs});pending.delete(id);};
  desktop.cdp.on('Network.eventSourceMessageReceived',event=>{if(event.eventName==='realtime'){const data=JSON.parse(event.data);if(data.eventType==='chat.created'){browserReceived.add(data.payload.id);record({phase:'browser-sse',id:data.payload.id,sseReceivedMs:performance.now()});}}});
  await desktop.chat.exposeFunction('__g08Observed',ids=>{
    const endMs=performance.now();for(const id of ids){const entry=pending.get(id);if(entry)finish(id,entry,endMs);else early.set(id,endMs);}
    while(early.size>200)early.delete(early.keys().next().value);
  });
  await desktop.chat.evaluate(()=>{
    const seen=new Set([...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId));
    new MutationObserver(()=>{const ids=[...document.querySelectorAll('[data-message-id]')].map(e=>e.dataset.messageId).filter(id=>!seen.has(id));ids.forEach(id=>seen.add(id));if(ids.length)window.__g08Observed(ids);}).observe(document.querySelector('.rt-chat-list'),{childList:true,subtree:true});
  });
  const metric=()=>metricTask||=(async()=>{
    const current=await backend.control('metrics');record({phase:'steady-metric',period,...current,streams:streams.snapshot(),unseenMessages:pending.size});
  })().finally(()=>{metricTask=null;});
  const warmStart=performance.now(),wallStart=Date.now();let sync,prepared=false;
  const queuePlan=Array.from({length:50},(_,i)=>({wipeId:'fixture_wipe_'+(i+1),kind:i<30?'normal':'burst',dueAt:wallStart+(i<30?300000+i*60000:420000)}));
  const preparation=(async()=>{for(const item of queuePlan){if(signal.aborted)throw Error('G08_ABORTED');const result=await backend.control('notification-enqueue',{wipeId:item.wipeId,schedule:{dueAt:new Date(item.dueAt).toISOString(),expiresAt:new Date(item.dueAt+120000).toISOString()}});Object.assign(item,result);record({phase:'notification-prepared',...item});}prepared=true;})();
  preparation.catch(()=>{});
  try{
    timer=setInterval(()=>metric().catch(e=>record({phase:'metric-error',error:e.message})),10000);await metric();
    let fatal,nextDue=warmStart,nextRead=warmStart;
    const launch=fn=>{const job=Promise.resolve().then(fn).catch(e=>{fatal||=e;}).finally(()=>inflight.delete(job));inflight.add(job);};
    while(nextDue<warmStart+35*60000){
      await sleep(Math.max(0,nextDue-performance.now()));
      if(signal.aborted)throw Error('G08_ABORTED');if(environmentFailure)throw Error(environmentFailure);if(fatal)throw fatal;
      const elapsed=nextDue-warmStart;period=elapsed<300000?'warmup':'steady';
      if(!syncPromise&&period==='steady'){
        await preparation;assert.ok(prepared);const recent=latencies.slice(-100).sort((a,b)=>a-b);assert.ok(recent.length===100&&recent[94]<=1000,'G08 warmup chat latency failed: '+recent[94]);
        await backend.control('reset-steady-metrics');syncPromise=syncJob(backend,Array.from({length:40},(_,i)=>'fixture_member_'+i)).then(job=>{sync=job;record({phase:'steady-sync',jobId:job.id});});
        syncPromise.catch(e=>{fatal||=e;});
      }
      const burst=elapsed>=420000&&elapsed<480000,rate=burst?20:5;
      const beginMs=performance.now(),scheduledMs=nextDue,id='stream-'+(++liveIndex),message='G08 测量 '+id+' '+'x'.repeat(liveIndex%20===0?8192:1024);
      const row={beginMs,scheduledMs,period,bytes:Buffer.byteLength(message),rate};
      assert.ok(beginMs-scheduledMs<2500,'Controller missed its offered load schedule');
      assert.ok(inflight.size<100,'Ingress backlog exceeded controller bound');
      launch(async()=>{
        const response=await backend.control('chat',{id,message});row.acceptedMs=performance.now();row.normalizedMessageBytes=response.normalizedMessageBytes;
        acceptedIds.push(response.id);record({phase:'chat-ingress',id:response.id,...row,accepted:response.result.accepted});assert.equal(response.result.accepted,true);
        if(early.has(response.id)){finish(response.id,row,early.get(response.id));early.delete(response.id);}else pending.set(response.id,row);
      });
      if(nextDue>=nextRead){nextRead+=5000;const readPeriod=period;launch(()=>Promise.all(pages.slice(1).map(async p=>{const beginMs=performance.now();try{
        const value=await p.page.evaluate(async()=>{const r=await fetch('/api/v2/me/home');return {status:r.status,body:await r.json()};});record({phase:'browser-session-read',period:readPeriod,beginMs,endMs:performance.now(),status:value.status,error:value.status!==200?(value.body.error?.errorCode||String(value.status)):undefined});
      }catch(e){record({phase:'browser-session-read',period:readPeriod,beginMs,endMs:performance.now(),error:e.message});}})));}
      if(liveIndex%300===0)console.log(JSON.stringify({stage:period,elapsedSeconds:Math.round(elapsed/1000),liveIndex,unseen:pending.size,inflight:inflight.size}));
      nextDue+=1000/rate;
    }
    await Promise.all([...inflight]);await syncPromise;if(fatal)throw fatal;
    await sleep(1000);await metric();assert.equal(pending.size,0,'Unseen realtime messages');const browserMissing=acceptedIds.filter(id=>!browserReceived.has(id));assert.equal(browserMissing.length,0,'Missing browser SSE events');const delivery=streams.verify(acceptedIds);assert.ok(delivery.every(s=>!s.closed&&!s.missing.length&&!s.duplicates),JSON.stringify(delivery));
    const notifications=await backend.control('notification-rows');assert.equal(notifications.length,50);assert.ok(notifications.every(d=>d.status==='sent'),JSON.stringify(notifications.filter(d=>d.status!=='sent')));
    for(const row of notifications){const plan=queuePlan.find(p=>p.deliveries.includes(row.id));record({phase:'notification-queue',kind:plan.kind,...row,ageMs:Date.parse(row.sentAt)-Math.max(Date.parse(row.createdAt),Date.parse(row.dueAt))});}
    const job=await waitJob(backend,sync.id);assert.equal(job.status,'succeeded');
    return {warmupStartedAt:new Date(wallStart).toISOString(),steadyStartedAt:new Date(wallStart+300000).toISOString(),warmupMs:300000,steadyMs:1800000,actualDurationMs:performance.now()-warmStart,liveIndex,unseen:[],browserReceived:browserReceived.size,delivery,sync:job,streams:streams.snapshot(),notifications,queuePlan};
  }finally{clearInterval(timer);await Promise.allSettled([...inflight,...(syncPromise?[syncPromise]:[]),...(metricTask?[metricTask]:[])]);await preparation;}
}
