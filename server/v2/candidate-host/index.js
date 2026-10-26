import {createServer} from 'node:http';
import {candidateConfig,assertEnvironment,paths,need,CandidateError,acquireCandidateLease} from './config.js';
import {validateBindings} from './bindings.js';
import {trackCandidatePorts} from './ports.js';
import {validateCandidateReady} from './migrations.js';
export {candidateConfig,candidateEnvironment} from './config.js';
export {initializeCandidate,planCandidateMigration,applyCandidateMigration,validateCandidateReady} from './migrations.js';
let claimed=false;
const safeError=(e,fallback='CANDIDATE_BOOT_FAILED')=>new CandidateError(/^[A-Z][A-Z0-9_]{1,80}$/.test(e?.errorCode||'')?e.errorCode:fallback);
export function createCandidateHost(input,{bindings={}}={}) {
  const config=candidateConfig(input);
  validateBindings(bindings);
  const ports=trackCandidatePorts(bindings);bindings=ports.bindings;
  // Pure construction: no environment/files/DB access, business imports, migration or listeners.
  let unsafeDisconnect=false,state='created',startPromise,stopPromise,api,server,store,storage,background,queueOwner,management,notifications,origin,releaseLease,sourcePolicy,wechat,providers,vip,hex,legacyQuiesced=false;
  const pending=new Set(),events=[];
  const status=()=>({state,origin:state==='ready'?origin:null,pendingRequests:pending.size,nativeCalls:ports.active,localCandidateOnly:true,g07FullAcceptance:false,
    owners:{management:Boolean(management),notifications:Boolean(notifications)},external:{notifications:Boolean(bindings.notifications),sources:Boolean(bindings.sources),oauth:false,mini:false},events:[...events]});
  function unavailable(req,res){req.resume();res.status(503).setHeader('Connection','close');res.end(JSON.stringify({error:{errorCode:'CANDIDATE_NOT_ACCEPTING'}}));}
  async function boot(){
    state='starting';
    need(!(bindings.sources?.capabilities?.memberRisk||bindings.sources?.capabilities?.discordMembershipAudit)||typeof bindings.sources?.readCredentials==='function','CANDIDATE_TRUSTED_CREDENTIAL_ADAPTER_REQUIRED',422);
    assertEnvironment(config);releaseLease=await acquireCandidateLease(config);await validateCandidateReady(config);events.push('exclusive-process-lease','migration-gate');
    store=await import('../../store.js');storage=await import('../../storage/sqlite.js');need(store.DATA_DIR===config.dataDirectory,'CANDIDATE_FRESH_PROCESS_REQUIRED');
    const {default:express}=await import('express');const app=express();app.disable('x-powered-by');app.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');if(state!=='ready')return unavailable(req,res);next();});
    server=createServer(app);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bindHost,resolve);});
    origin=`http://127.0.0.1:${server.address().port}`;process.env.NB_V2_PUBLIC_ORIGIN=origin;events.push('loopback-bound-not-ready');
    const {createApiRouter,stopBackgroundJobs}=await import('../../api.js');background=stopBackgroundJobs;
    if(bindings.vipNotifications){
      background();const {drainBackgroundTaskQueues}=await import('../../background-task-queue.js');
      const drained=await drainBackgroundTaskQueues({timeoutMs:config.shutdownGraceMs});await store.drainStoreWrites();
      need(!drained.totalPending&&!drained.totalRunning,'CANDIDATE_LEGACY_DRAIN_REQUIRED');legacyQuiesced=true;events.push('legacy-background-disabled-and-drained');
    }
    const {createManagementRuntime}=await import('../management-runtime/index.js');
    const {createCandidateNotificationOwner}=await import('./notifications.js');
    const {createLocalSystemStorage}=await import('../system-admin/storage.js');
    const {createCanonicalSourcePolicy}=await import('../management-adapters/source-policy/index.js');
    const {createCandidateWechat}=await import('./wechat.js');
    const {createCandidateProviders}=await import('./providers.js');const {createCandidateVip}=await import('./vip.js');
    const {createCandidateHex}=await import('./hex.js');
    const hexFor=identity=>hex||=createCandidateHex({binding:bindings.hexQuery,notificationBinding:bindings.notifications,identity});
    const providersFor=identity=>providers||=createCandidateProviders({binding:bindings.providers,sources:bindings.sources||{},identity});
    const vipFor=identity=>vip||=createCandidateVip({binding:bindings.vipNotifications,notificationBinding:bindings.notifications,identity,isLegacyQuiesced:()=>legacyQuiesced&&['starting','ready'].includes(state)});
    const wechatFor=identity=>wechat||=(createCandidateWechat({binding:bindings.wechat,identity,getSystem:()=>management.getSystem(identity)}));
    const policyFor=identity=>{
      if(sourcePolicy)return sourcePolicy;
      sourcePolicy=createCanonicalSourcePolicy({identity,getSystem:()=>management.getSystem(identity),readControl:()=>bindings.collection,
        sourceBindings:providersFor(identity).sourceOptions});return sourcePolicy;
    };
    // The original API owns G03, BM queue and global writes. No alternate API or identity factory.
    api=createApiRouter({
      notificationRuntimeFactory:deps=>notifications=createCandidateNotificationOwner({...deps,publicOrigin:origin,intervalMs:bindings.hexQuery?Math.min(config.intervalMs,1000):config.intervalMs,bindings:bindings.notifications,
        getPlatformService:()=>management.getSystem(identityRef).platforms.service,
        getCardViewHandler:identity=>proof=>management.getSystem(identity).platformHost.viewDiscordCard(proof),
        getCommunityHandler:(identity,platform)=>proof=>management.getSystem(identity).platformHost.community[platform].handleVerified(proof)}),
      managementRuntimeFactory:deps=>{
        queueOwner=deps.sharedBattlemetricsQueue;need(deps.runStoreWriteTask===store.runStoreWriteTask&&deps.patchStoreCache===store.patchStoreCache,'CANDIDATE_WRITE_OWNER_MISMATCH');
        management=createManagementRuntime({...deps,intervalMs:config.intervalMs,
          sourceHostOptions:identity=>({...providersFor(identity).sourceOptions,
            ...(bindings.hexQuery?{capabilities:{...providersFor(identity).sourceOptions.capabilities,hexaytron:hexFor(identity).bound&&bindings.hexQuery.enabled===true}}:{}),fetchImpl:bindings.sources?.fetchImpl||fetch,
            readCredentials:policyFor(identity).readCredentials,readDiscordSettings:policyFor(identity).readDiscordSettings}),
          sourceAdminOptions:identity=>({readRuntimeStatus:policyFor(identity).readRuntimeStatus}),
          memberFollowupOptions:identity=>({readPolicy:policyFor(identity).readPolicy,readPrincipal:policyFor(identity).readPrincipal,
            readSourceConfig:policyFor(identity).readFollowupSourceConfig}),
          memberInboxOptions:bindings.wechat?identity=>wechatFor(identity).inboxOptions:undefined,
          platformMediaOptions:bindings.wechat?identity=>wechatFor(identity).mediaOptions:undefined,
          hexQueryOptions:bindings.hexQuery?identity=>hexFor(identity).options:undefined,
          relayAdminOptions:()=>({}),
          adminExtrasOptions:bindings.adminExtras?()=>({readCatalog:()=>bindings.adminExtras.readCatalog()}):undefined,
          vipNotificationOptions:bindings.vipNotifications?identity=>vipFor(identity).options:undefined,
          memberOptions:()=>({}),platformHostOptions:identity=>({...bindings.platforms,...(bindings.wechat?{wechat:wechatFor(identity).miniOptions}:{}),...(bindings.notifications?{g06:{platforms:notifications.getSystem(identity).service.platforms,targets:()=>notifications.catalog.listTargets()}}:{})}),
          platformAdapters:()=>({... (bindings.vault?{vault:bindings.vault}:{}),... (bindings.platformMetadata?{platform:bindings.platformMetadata}:{})}),
          realtimeOptions:()=>bindings.realtime||{},
          systemOptions:identity=>({storage:createLocalSystemStorage({db:identity.repo.db,directory:paths(config).managed,databaseFile:paths(config).database})})});
        return management;
      }
    });
    let identityRef=await api.v2Runtime.getIdentity();
    const managed=management.getSystem(identityRef),notify=notifications.getSystem(identityRef);
    need(managed.identity===identityRef&&managed.scheduling===notify.service.scheduling&&api.v2Runtime.getMemberSpace(identityRef).scheduling===managed.scheduling,'CANDIDATE_SHARED_OWNER_MISMATCH');
    need(managed.sources&&managed.sourceHost.battlemetricsQueue===queueOwner,'CANDIDATE_BM_QUEUE_MISMATCH');
    if(bindings.collection?.enabled)sourcePolicy.readPrincipal();
    wechatFor(identityRef);vipFor(identityRef);
    if(vip.bound&&bindings.vipNotifications.enabled)vip.principal();
    app.use('/api',(req,res,next)=>{
      if(!req.path.startsWith('/v2/')&&!req.path.startsWith('/integrations/v2/notifications/'))return res.status(410).json({error:{errorCode:'CANDIDATE_LEGACY_SURFACE_DISABLED'}});
      try{wechat.gate(req.path);}catch(error){return res.status(error.status||503).json({error:{errorCode:error.errorCode||'CANDIDATE_WECHAT_ADAPTERS_UNBOUND'}});}
      if(/^\/v2\/auth\/(discord|kook|steam)(\/|$)/.test(req.path))return res.status(503).json({error:{errorCode:'CANDIDATE_OAUTH_ADAPTER_UNBOUND'}});
      next();
    },(req,res,next)=>{
      // These GET streams are owned and drained by the original runtime. A
      // browser closing an established subscription leaves no HTTP write to finish.
      const streamRoute=req.method==='GET'&&(/^\/v2\/(?:auth\/|members\/)?events\/?$/.test(req.path)||/^\/v2\/realtime\/[^/]+\/stream\/?$/.test(req.path));
      const p=new Promise(resolve=>{res.once('finish',resolve);res.once('close',()=>{
        const establishedStream=streamRoute&&res.headersSent&&res.statusCode===200&&/^text\/event-stream(?:;|$)/i.test(String(res.getHeader('content-type')||''));
        if(!res.writableFinished&&!establishedStream)unsafeDisconnect=true;
        resolve();
      });});pending.add(p);p.finally(()=>pending.delete(p));next();
    },api);
    app.use((error,req,res,next)=>res.status(error.status||503).json({error:{errorCode:safeError(error).errorCode}}));
    await api.v2Runtime.start();need(state==='starting','CANDIDATE_STOP_REQUESTED');
    events.push('same-G03-scheduling-write-and-BM-owners','owners-started');state='ready';return status();
  }
  async function drain(){
    state='stopping';events.push('http-admission-stopped');
    const http=server?new Promise(resolve=>{server.close(()=>resolve());server.closeIdleConnections?.();}):Promise.resolve();
    const timer=setTimeout(()=>server?.closeAllConnections?.(),config.shutdownGraceMs);timer.unref();
    try{
      if(!store){await http;await releaseLease?.();state='stopped';return status();}
      background?.();const ownerStops=await Promise.allSettled([api?.v2Runtime.stop(),providers?.stop()]);
      const failure=ownerStops.find(result=>result.status==='rejected');if(failure)throw failure.reason;
      events.push('owners-drained');if(providers)events.push('provider-owners-drained');
      await ports.drain(config.shutdownGraceMs);events.push('native-adapter-promises-drained');
      const until=Date.now()+config.shutdownGraceMs;
      while(queueOwner&&(queueOwner.snapshot().running||queueOwner.snapshot().pendingCount)){need(Date.now()<until,'CANDIDATE_BM_DRAIN_TIMEOUT');await new Promise(r=>setTimeout(r,5));}
      events.push('shared-BM-queue-drained');
      const {drainBackgroundTaskQueues}=await import('../../background-task-queue.js');await drainBackgroundTaskQueues({timeoutMs:config.shutdownGraceMs,stopAccepting:true});
      await store?.drainStoreWrites();events.push('original-queues-drained');
      await http;await Promise.allSettled([...pending]);need(!unsafeDisconnect,'CANDIDATE_HTTP_DRAIN_UNCONFIRMED');events.push('http-drained');
      await storage?.closeSqliteDatabases({checkpointMode:'TRUNCATE'});await releaseLease?.();events.push('shared-sqlite-closed');state='stopped';
    }catch(e){state='drain_failed';throw safeError(e,'CANDIDATE_DRAIN_FAILED');}finally{clearTimeout(timer);}
    return status();
  }
  return Object.freeze({config,status,
    start(){need(state==='created'||state==='starting'||state==='ready','CANDIDATE_LIFECYCLE_INVALID');if(startPromise)return startPromise;need(!claimed,'CANDIDATE_FRESH_PROCESS_REQUIRED');claimed=true;return startPromise=(boot().catch(async e=>{try{await drain();}catch{}throw safeError(e);}));},
    stop(){if(stopPromise)return stopPromise;if(state==='created'){state='stopped';return Promise.resolve(status());}return stopPromise=(async()=>{if(state==='starting'){state='stopping';await startPromise?.catch(()=>{});if(state==='stopped')return status();}return drain();})();},
    // Trusted host composition inspection; never returned by HTTP and never authenticates a caller.
    owners(){need(state==='ready','CANDIDATE_NOT_READY');return {api,management,notifications,sourcePolicy,wechat,providers,vip,hex,sharedBattlemetricsQueue:queueOwner};}
  });
}
