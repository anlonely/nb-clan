import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import net from 'node:net';
import express from 'express';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {fixture} from './fixtures.mjs';
import {createIdentityRouter} from '../../../server/v2/identity/routes.js';
import {createSystemAdminRouter,systemIdentityWriteCompatibilityGuard} from '../../../server/v2/system-admin/routes.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),runDir=process.env.G07_SYSTEM_RUN;
assert.ok(runDir.startsWith(path.join(root,'test/support/v2-system-admin/.runs/run-')));assert.equal(process.env.NB_DISABLE_BACKGROUND_JOBS,'1');
const allow=['PATH','LANG','TZ','NODE_ENV','NB_DISABLE_BACKGROUND_JOBS','NB_V2_IDENTITY_ENABLED','G07_SYSTEM_RUN','G07_SYSTEM_MODE','G07_SYSTEM_HOST','NODE_OPTIONS','__CF_USER_TEXT_ENCODING'];
assert.deepEqual(Object.keys(process.env).filter(k=>!allow.includes(k)),[]);assert.throws(()=>net.connect({host:'example.com',port:443}),e=>e.code==='G01_EGRESS_BLOCKED');
const f=await fixture(path.join(runDir,'data')),app=express(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
assert.ok(['localhost','127.0.0.1'].includes(process.env.G07_SYSTEM_HOST));
const origin=`http://${process.env.G07_SYSTEM_HOST}:${server.address().port}`,identityRouter=createIdentityRouter({service:f.identity,contexts:f.contexts,origin,providers:{},
 authenticatePassword:async(username,password)=>{const {scrypt,timingSafeEqual}=await import('node:crypto'),{promisify}=await import('node:util');
  const u=f.repo.all('users').find(u=>u.username===username);if(!u)return null;const [,salt,hash]=u.passwordHash.split('$'),key=await promisify(scrypt)(password,salt,64);if(!timingSafeEqual(key,Buffer.from(hash,'hex')))return null;
  return f.repo.all('accounts').find(a=>a.legacyUserId===u.id)?.id;
 }});
app.disable('x-powered-by');app.use((req,res,next)=>{if(req.get('host')!==new URL(origin).host||req.socket.remoteAddress!=='127.0.0.1')return res.sendStatus(400);next();});
app.post('/__fixture/login',express.json({limit:'1kb'}),(req,res)=>{if(req.get('origin')!==origin)return res.sendStatus(403);const a=f.repo.get('accounts',req.body.account);if(!a)return res.sendStatus(403);
 const s=f.identity.issueSession(a);res.cookie('nb_v2_session',s.token,{path:'/api/v2',httpOnly:true,sameSite:'strict'});res.cookie('nb_v2_csrf',s.csrfToken,{path:'/api/v2',httpOnly:true,sameSite:'strict'});res.json({isolated:true});});
app.use('/api/v2',systemIdentityWriteCompatibilityGuard);
app.use('/api/v2',(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:options=>identityRouter.authenticate(options)(req)};identityRouter(req,res,next);});
app.use('/api/v2',createSystemAdminRouter({service:f.service}));
app.use('/api',(req,res)=>res.status(404).json({error:{errorCode:'NOT_FOUND'}}));
app.use((e,req,res,next)=>res.status(e.status||503).json({error:{errorCode:e.errorCode||'SYSTEM_UNAVAILABLE'}}));
const outDir=path.join(runDir,'dist');await build({root,configFile:false,envFile:false,envDir:runDir,plugins:[react()],build:{outDir,emptyOutDir:false,rollupOptions:{input:path.join(root,'test/support/v2-system-admin/index.html')}}});
app.use('/assets',express.static(path.join(outDir,'assets')));const html=await readFile(path.join(outDir,'test/support/v2-system-admin/index.html'),'utf8');app.use((req,res)=>res.type('html').send(html));
await writeFile(path.join(runDir,'runtime.json'),JSON.stringify({origin,runDir,pid:process.pid,node:process.version,database:f.databaseFile,fixtureAccounts:['root','admin','operator','viewer','member','impostor'],backgroundJobs:'not imported',egress:'loopback-only guard',sharedEntryModified:false},null,2));
console.log(JSON.stringify({ready:true,origin,runDir}));
let stopping=false;async function stop(){if(stopping)return;stopping=true;await f.owner.stop();await identityRouter.stopEvents();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>stop().then(()=>process.exit()));
if(process.env.G07_SYSTEM_MODE==='verify'){try{const {verify}=await import('./verify.mjs');await verify({origin,runDir,f});}finally{await stop();}}
