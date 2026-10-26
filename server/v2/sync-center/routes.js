import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
const dates=value=>Array.isArray(value)?value.map(dates):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,/At$/.test(key)&&typeof v==='number'?(v?new Date(v).toISOString():null):dates(v)])):value;
export function createSyncCenterRouter({getSystem}) {
  if(typeof getSystem!=='function')throw new TypeError('getSystem required');const router=express.Router();
  router.use('/sync-center',express.json({limit:'32kb'}));
  const wrap=(fn,status=200)=>async(req,res)=>{const requestId=req.v2RequestId||randomUUID();res.set('Cache-Control','no-store');try{if(!req.v2Identity?.authenticate)throw new IdentityError('AUTH_REQUIRED',401);const {actor}=await req.v2Identity.authenticate(['GET','HEAD'].includes(req.method)?undefined:{mutation:true});const system=await getSystem(req);if(system?.service?.identity!==req.v2Identity.service)throw new IdentityError('SYNC_SETUP_REQUIRED',503);if(!['GET','HEAD'].includes(req.method)&&(!req.body||typeof req.body!=='object'||Array.isArray(req.body)))throw new IdentityError('SYNC_INPUT_INVALID',422);const data=await fn(system.service,actor,req,{operationId:req.get('Idempotency-Key')});res.status(status).json({data:dates(data),meta:{schemaVersion:1,requestId,serverTime:new Date().toISOString(),scopeVersion:actor.permissionVersion}});}catch(e){const known=e instanceof IdentityError;res.status(known?e.status:503).json({error:{errorCode:known?e.errorCode:'SYNC_UNAVAILABLE',messageKey:known?e.errorCode:'SYNC_UNAVAILABLE',requestId,operationId:req.get('Idempotency-Key')||null,fieldErrors:e.fieldErrors||{},retryable:known?Boolean(e.retryable||e.status>=500):true,current:known?e.current||null:null}});}};
  router.get('/sync-center/events',wrap((s,a,r)=>s.events(a,r.query)));
  router.get('/sync-center/runs',wrap((s,a,r)=>s.runs(a,r.query)));
  router.get('/sync-center/jobs',wrap((s,a,r)=>s.list(a,r.query)));
  router.post('/sync-center/jobs',wrap((s,a,r,o)=>s.request(a,r.body,o),202));
  router.get('/sync-center/jobs/:id',wrap((s,a,r)=>s.detail(a,r.params.id,r.query)));
  router.post('/sync-center/jobs/:id/candidate',wrap((s,a,r,o)=>s.confirmCandidate(a,r.params.id,r.body,o)));
  router.post('/sync-center/jobs/:id/commands/:action',wrap((s,a,r,o)=>s.action(a,r.params.id,r.params.action,r.body,o)));
  router.get('/sync-center/operations/:id',wrap((s,a,r)=>s.operation(a,r.params.id)));
  router.get('/sync-center/sources',wrap((s,a)=>s.sources(a)));
  router.post('/sync-center/sources/:id',wrap((s,a,r,o)=>s.saveSource(a,r.params.id,r.body,o)));
  router.get('/sync-center/coverage',wrap((s,a,r)=>s.coverage(a,r.query)));
  router.get('/sync-center/rules',wrap((s,a)=>s.rules(a)));
  router.post('/sync-center/rules',wrap((s,a,r,o)=>s.saveRule(a,null,r.body,o),201));
  router.post('/sync-center/rules/actions/delete',wrap((s,a,r,o)=>s.deleteRules(a,r.body,o)));
  router.post('/sync-center/rules/:id',wrap((s,a,r,o)=>s.saveRule(a,r.params.id,r.body,o)));
  router.use('/sync-center',(e,req,res,next)=>res.status(e.status===413?413:422).json({error:{errorCode:'SYNC_INPUT_INVALID',messageKey:'SYNC_INPUT_INVALID',requestId:req.v2RequestId||randomUUID(),operationId:req.get('Idempotency-Key')||null,fieldErrors:{},retryable:false,current:null}}));
  return router;
}
