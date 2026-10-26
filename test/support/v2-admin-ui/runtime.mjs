import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, appendFile, readFile, writeFile, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { root, validateRuntimeEnvironment } from './config.mjs';
import { fixtures, seedIdentities, controlledProviders } from '../v2-member-space/fixtures.mjs';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { planSchedulingMigration, applySchedulingMigration } from '../../../server/v2/scheduling/migration.js';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { createSchedulingRouter } from '../../../server/v2/scheduling/routes.js';
import { openSqliteDatabase, closeSqliteDatabases } from '../../../server/storage/sqlite.js';
import { createNotificationDouble, createNotificationDoubleRouter } from './notification-double.mjs';
import { fixtureEligibilityTtlMs, refreshFixtureEligibility } from './fixture-eligibility.mjs';
import { createAdminHistoryRouter } from '../../../server/v2/admin-history/routes.js';
import { runtimeWatchOptions } from './watch-options.mjs';
validateRuntimeEnvironment();
const runDir=process.env.G06_A_RUN_DIR;
assert.equal(await realpath(runDir),runDir);
await assert.rejects(access(process.env.NB_SQLITE_FILE),{code:'ENOENT'},'Fresh SQLite required for every runtime');
const { createMemberSpaceRouter }=await import('../../../server/v2/member-space/routes.js');
const db=await openSqliteDatabase();installIdentitySchema(db);const identityRepo=new IdentityRepository(db);
applyIdentityMigration(identityRepo,planIdentityMigration({}));installSchedulingSchema(db);const schedulingRepo=new SchedulingRepository(db);
applySchedulingMigration(schedulingRepo,planSchedulingMigration({}));seedIdentities(identityRepo);
const app=express(),server=createServer(app);
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.G06_A_PORT),'127.0.0.1',resolve);});
const origin=`http://127.0.0.1:${server.address().port}`;process.env.NB_V2_PUBLIC_ORIGIN=origin;
const controlled=controlledProviders(origin),identity=new IdentityService(identityRepo,{providers:controlled.providers,eligibilityTtl:fixtureEligibilityTtlMs});
const identityRouter=createIdentityRouter({service:identity,origin,providers:controlled.providers});
const scheduling=new SchedulingService(schedulingRepo,identity),notificationDouble=createNotificationDouble({identity,scheduling});
const controlToken=randomBytes(32).toString('base64url'),faults=[],traces=[];let ready=false;
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
app.disable('x-powered-by');
app.use((req,res,next)=>{
  if(req.socket.remoteAddress!=='127.0.0.1'||req.get('host')!==new URL(origin).host)return res.status(400).json({error:{errorCode:'ISOLATED_ORIGIN_REQUIRED'}});
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});next();
});
app.use('/api/v2/__fixtures',express.json({limit:'12kb'}));
app.get('/api/v2/__fixtures/health',(_req,res)=>res.status(ready?200:503).json({ready,isolated:true,origin,notificationImplementation:'contract-double',fixtureEligibilityTtlMs,backgroundJobs:false,realPlatformDelivery:false}));
app.get('/api/v2/__fixtures/manifest',(_req,res)=>res.json({fixtures:fixtures.filter(f=>f.accountId),...fixtureData,notificationImplementation:'contract-double',notificationTargets:['g06_discord','g06_kook']}));
app.get('/api/v2/__fixtures/oauth/:provider',(req,res)=>{
  if(!controlled.providers[req.params.provider]||typeof req.query.state!=='string')return res.sendStatus(400);
  const links=fixtures.filter(f=>f.accountId).sort((a,b)=>(a.key==='admin'?-1:b.key==='admin'?1:0)).map(f=>`<a data-fixture="${f.key}" href="${origin}/api/v2/__fixtures/oauth/${req.params.provider}/select?${escape(new URLSearchParams({state:req.query.state,fixture:f.key}))}">${escape(f.displayName)} · ${f.key} <small>${f.roleId}</small></a>`).join('');
  res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>G06-A 构造平台登录</title><style>body{font:17px system-ui;max-width:800px;margin:60px auto;background:#f4f6f8;color:#202930}a{display:block;padding:18px;margin:12px 0;border:1px solid #c9d0d8;border-radius:8px;background:white;color:#294b38;text-decoration:none}small{float:right}</style><h1>选择构造平台账号</h1><p>仅 G06-A 本地验收；无真实平台认证。管理界面选择值班管理员。</p>${links}</html>`);
});
app.get('/api/v2/__fixtures/oauth/:provider/select',(req,res,next)=>{try{
  if(typeof req.query.state!=='string'||req.query.state.length>1000||!fixtures.some(f=>f.accountId&&f.key===req.query.fixture))return res.sendStatus(400);
  const code=controlled.ticket(req.params.provider,req.query.fixture);res.redirect(303,`${origin}/api/v2/auth/${req.params.provider}/callback?${new URLSearchParams({state:req.query.state,code})}`);
}catch(e){next(e);}});
function requireControl(req,res,next){const supplied=Buffer.from(req.get('x-g06-a-control')||'');if(req.get('origin')!==origin||supplied.length!==controlToken.length||!timingSafeEqual(supplied,Buffer.from(controlToken)))return res.status(403).json({error:{errorCode:'FIXTURE_CONTROL_DENIED'}});next();}
app.post('/api/v2/__fixtures/control',requireControl,async(req,res,next)=>{try{
  const body=req.body||{};
  if(body.action==='refresh-eligibility')return res.json(await refreshFixtureEligibility(identity,{fixture:body.fixture??null}));
  if(body.action==='delivery')return res.json(notificationDouble.control({deliveryId:body.deliveryId,status:body.status,...(body.messageId?{messageId:body.messageId}:{})}));
  if(body.action==='fault'){
    if(!['GET','POST','PUT','PATCH'].includes(body.method)||!/^\/api\/v2\/(?:admin\/(?:wipes|wipe-options)(?:\?|$)|wipes(?:\/|$)|operations\/|notifications\/operations\/|publish-intents\/|deliveries\/)/.test(body.path)||
      !['delay','disconnect-before','disconnect-after','unavailable','not-found'].includes(body.mode)||/[\r\n]/.test(body.path))return res.sendStatus(422);
    const fault={id:randomUUID(),method:body.method,path:body.path,mode:body.mode,delayMs:Math.min(30000,Math.max(1,Number(body.delayMs)||1500))};faults.push(fault);return res.json({queued:fault});
  }
  if(body.action==='clear-faults'){faults.length=0;return res.json({cleared:true});}
  if(body.action==='revoke'){const fixture=fixtures.find(f=>f.key===body.fixture&&f.accountId);if(!fixture)return res.sendStatus(422);identity.revokeAccountScope(fixture.accountId,'g06_a_controlled_revocation');return res.json({revoked:true});}
  if(body.action==='inspect')return res.json({traces,faults,notificationDouble:notificationDouble.inspect(),integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,schedulingReceipts:schedulingRepo.all('receipts').map(r=>r.operationReceipt)});
  return res.sendStatus(422);
}catch(e){next(e);}});
app.use('/api/v2',(req,res,next)=>{
  const route=`/api/v2${req.path}`,index=faults.findIndex(f=>f.method===req.method&&(f.path===route||f.path===req.originalUrl)),fault=index>=0?faults.splice(index,1)[0]:null;
  req.v2RequestId=randomUUID();
  if(fault?.mode==='disconnect-before')return req.socket.destroy();
  if(['unavailable','not-found'].includes(fault?.mode)){const code=fault.mode==='not-found'?'RESOURCE_NOT_FOUND':'ISOLATED_TRANSIENT_FAILURE';return res.status(fault.mode==='not-found'?404:503).json({error:{errorCode:code,messageKey:code,fieldErrors:{},requestId:req.v2RequestId,operationId:req.get('Idempotency-Key')||null,retryable:fault.mode!=='not-found',current:null}});}
  const json=res.json.bind(res);res.json=payload=>{
    if(!route.startsWith('/api/v2/auth/')){const trace={at:new Date().toISOString(),route,method:req.method,status:res.statusCode,operationId:req.get('Idempotency-Key')||null,commandHash:req.body?hashCommand(req.body):null,errorCode:payload?.error?.errorCode||null,fault:fault?.mode||null};traces.push(trace);appendFile(path.join(runDir,'http.jsonl'),`${JSON.stringify(trace)}\n`).catch(()=>{});}
    if(fault?.mode==='disconnect-after'){req.socket.destroy();return res;}
    if(fault?.mode==='delay'){setTimeout(()=>{if(!res.destroyed)json(payload);},fault.delayMs).unref();return res;}
    return json(payload);
  };
  req.v2Identity={service:identity,authenticate:options=>identityRouter.authenticate(options)(req)};next();
});
const {hash:hashCommand}=await import('../../../server/v2/scheduling/service.js');
app.use('/api/v2',identityRouter,createSchedulingRouter(),createMemberSpaceRouter(),createAdminHistoryRouter(),createNotificationDoubleRouter({service:notificationDouble}));
app.use('/api',(_req,res)=>res.status(404).json({error:{errorCode:'ISOLATED_ROUTE_NOT_FOUND'}}));
app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:{errorCode:error.errorCode||'ISOLATED_RUNTIME_ERROR'}}));
const {createServer:createViteServer}=await import('vite');const {default:react}=await import('@vitejs/plugin-react');
const vite=await createViteServer({root,configFile:false,envFile:false,envDir:false,plugins:[react()],appType:'custom',
  server:{middlewareMode:true,hmr:{server},watch:runtimeWatchOptions(root),host:'127.0.0.1',allowedHosts:['127.0.0.1'],fs:{strict:true,allow:[root],deny:['.env','.env.*','**/.git/**','**/work/**','**/*.sqlite','**/*.sqlite-*','**/runtime.json','**/*.{crt,pem,key}']}}});
app.use(vite.middlewares);
app.use(async(req,res,next)=>{try{if(req.method!=='GET')return res.sendStatus(404);const html=await readFile(path.join(root,'test/support/v2-admin-ui/index.html'),'utf8');res.type('html').send(await vite.transformIndexHtml(req.originalUrl,html));}catch(e){next(e);}});
await refreshFixtureEligibility(identity);
const admin=identity.actorForAccount('g05_account_admin'),stamp=Date.now(),at=hours=>new Date(stamp+hours*3600000).toISOString();
const common={description:'集合前进入一队语音，优先建家并确定首轮分工。',serverProfileId:'g06_local_server',serverSnapshot:{id:'g06_local_server',name:'一队主服 · 本地构造',address:'127.0.0.1',region:'EU'},serverScheduleSource:'manual',audience:{squadIds:['g05_squad'],memberIds:[],includeUnassigned:false},timeZone:'Asia/Shanghai',autoStart:false,autoOpenSignup:false,signupOpensAt:at(-1),signupClosesAt:at(3),musterAt:at(4),serverScheduledWipeAt:at(4.5)};
const draft=scheduling.createWipe(admin,{...common,title:'周末长档 · 待完善草稿'},{operationId:randomUUID()}).current;
let scheduled=scheduling.createWipe(admin,{...common,title:'今晚北境一队 · 主服开荒'},{operationId:randomUUID()}).current;
scheduled=scheduling.transition(admin,scheduled.id,'publish',{expectedRevision:scheduled.revision},{operationId:randomUUID()}).current;
scheduled=scheduling.transition(admin,scheduled.id,'reopen-signup',{expectedRevision:scheduled.revision,closesAt:at(3),reason:'构造报名窗口开启'},{operationId:randomUUID()}).current;
await scheduling.prepareSignupTarget(admin,scheduled.id,'g05_beta',{delegate:true});
scheduling.saveSignup(admin,scheduled.id,'g05_beta',{response:'attending_on_time',expectedArrivalAt:null,timeZone:'Asia/Shanghai',expectedSignupRevision:0,confirmedContentRevision:scheduled.contentRevision,reason:'隔离构造报名种子'},{delegate:true,operationId:randomUUID()});
const fixtureData={draftWipeId:draft.id,nextWipeId:scheduled.id};ready=true;
const metadata={ready,createdAt:new Date().toISOString(),cwd:root,runDir,pid:process.pid,origin,controlToken,sqliteFile:process.env.NB_SQLITE_FILE,...fixtureData,environmentKeys:Object.keys(process.env).sort(),fixtureEligibilityTtlMs,eligibilityRefresh:'Explicit construction or protected POST control only; no roster GET refresh',backgroundJobs:false,realPlatformDelivery:false,
  routerWiring:['createIdentityRouter','createSchedulingRouter','createMemberSpaceRouter','createAdminHistoryRouter','createNotificationDoubleRouter'],
  realBackend:['G03 sessions, callback and CSRF','G04 wipes, signups, summary, operations and archives','G05 bootstrap and member queries','Root approved read-only G04 event history projection'],
  doubles:['constructed OAuth identities/eligibility','g06-parallel/1 B routes + notification rendering + per-target platform outcomes'],
  limitation:'No createApiRouter integration, G06-B/C renderer/worker or real platform acceptance. Notification double persists isolated SQLite state only; no background worker.',
  networkGuard:'Node G01 loopback guard, not an OS-wide sandbox'};
await writeFile(path.join(runDir,'runtime.json'),JSON.stringify(metadata,null,2),{mode:0o600});
await writeFile(path.join(root,'work/g06-a/runtime-latest.json'),JSON.stringify({runDir,origin,pid:process.pid,metadata:path.join(runDir,'runtime.json')},null,2),{mode:0o600});
console.log(JSON.stringify({ready,origin,runDir,metadata:path.join(runDir,'runtime.json'),...fixtureData}));
let closing=false;
async function close(signal){if(closing)return;closing=true;ready=false;await vite.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeSqliteDatabases({checkpointMode:'TRUNCATE'});await writeFile(path.join(runDir,'shutdown.json'),JSON.stringify({at:new Date().toISOString(),signal,closed:true}));}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close(signal).then(()=>process.exit(0)));
