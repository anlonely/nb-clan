import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IdentityRepository, installIdentitySchema } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { applyIdentityMigration, planIdentityMigration } from '../../../server/v2/identity/migration.js';
import { CAPABILITIES, grant } from '../../../server/v2/identity/permissions.js';
import { SchedulingRepository, installSchedulingSchema } from '../../../server/v2/scheduling/repository.js';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { createNotificationCallbackHandler } from '../../../server/v2/notification-platforms/callbacks.js';

// Constructed identities only; no production files, env, sessions or network.
export async function callbackFixture(t) {
  const parent = resolve('work/g06-c'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'callback-fixture-'));
  const databasePath = join(directory, 'fixture.sqlite');
  let db = new DatabaseSync(databasePath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  installIdentitySchema(db); installSchedulingSchema(db);
  const state = { now: Date.parse('2026-09-10T06:00:00.000Z'), roles:['member-role'], wait:null, events:[] };
  const providers = Object.fromEntries(['discord','kook'].map(provider => [provider, { async roles(externalId,guildId) {
    state.events.push(`roles:${provider}`); if (state.wait) await state.wait;
    return { externalId,guildId,roleIds:state.roles };
  } }]));
  let identity = new IdentityService(new IdentityRepository(db), { providers, now: () => state.now });
  applyIdentityMigration(identity.repo, planIdentityMigration({}));
  identity.repo.setScalar('v2SchedulingMigration', { version:1, fixture:true });
  identity.repo.setScalar('v2RosterRevision',1);
  for (const p of identity.repo.all('policies')) identity.repo.put('policies', { ...p, enabled:true,
    guildId:'100000000000000001', allowedRoleIds:['member-role'] });
  const profile = { provider:'discord', id:'200000000000000001', displayName:'构造成员，不是真实用户' };
  const eligibility = await identity.checkEligibility(profile.provider,profile.id);
  const bound = identity.bind(profile,'76561198000000001',eligibility,identity.login(profile,eligibility));
  const actor = identity.session(bound.token).actor;
  identity.repo.put('identities',{id:'fixture-kook',provider:'kook',externalId:profile.id,accountId:actor.id,revision:1});
  identity.repo.put('accounts',{id:'operator',memberId:null,status:'active',roleId:'admin',adminAssignedByOwner:true,permissionVersion:1,revision:1,
    grants:CAPABILITIES.map(cap => grant(cap,{type:'all'}))});
  let scheduling = new SchedulingService(new SchedulingRepository(db),identity,{now:()=>state.now});
  const operator = identity.actorForAccount('operator');
  let wipe = scheduling.createWipe(operator,{title:'隔离跨端档期',description:'仅供本地验证',serverProfileId:'local-server',
    serverSnapshot:{name:'构造服务器'},timeZone:'Asia/Shanghai',audience:{squadIds:[],memberIds:[actor.memberId],includeUnassigned:false},
    musterAt:'2026-09-10T08:00:00.000Z',signupOpensAt:'2026-09-10T05:00:00.000Z',signupClosesAt:'2026-09-10T09:00:00.000Z'},
  {operationId:'fixture-create'}).current;
  wipe=scheduling.transition(operator,wipe.id,'publish',{expectedRevision:wipe.revision},{operationId:'fixture-publish'}).current;
  const references = new Map(['on-time','late','absent','withdraw'].map((token,i) => [token,{
    wipeId:wipe.id,contentRevision:1,action:['attending_on_time','attending_later','not_attending','withdraw'][i],
    timeZone:'Asia/Shanghai',targetId:'local-target',expiresAt:null}]));
  for (const [token,action] of [['join-8h','join_8h'],['join-16h','join_16h'],['connect','copy_connect'],['register','register_member']])
    references.set(token,{wipeId:wipe.id,contentRevision:1,action,timeZone:'Asia/Shanghai',targetId:'local-target',
      directConnect:action==='copy_connect'?'client.connect example.test:28015':'',expiresAt:null});
  const privateReplies=[],acks=[];
  const transport={runtimeMode:'isolated',async request(){throw new Error('Unexpected public dispatch');},
    async respondPrivate({platform,verifiedInteraction,payload}) {
      state.events.push(`private:${platform}`); privateReplies.push({platform,externalId:verifiedInteraction.externalId,payload});
    }};
  const resolveReference=(token,scope)=>{
    state.events.push('resolve');
    if (!['discord','kook'].includes(scope.platform) || scope.channelId!=='300000000000000001' ||
      !(scope.guildId==='100000000000000001' || scope.platform==='kook' && scope.guildId===null) || !references.has(token))
      throw Object.assign(new Error('Invalid fixture reference'),{errorCode:'PLATFORM_ACTION_REFERENCE_INVALID'});
    return structuredClone(references.get(token));
  };
  const envelope=(platform,actionReference='on-time',extra={})=>({
    rawBody:Buffer.from(JSON.stringify({provider:platform,externalId:profile.id,interactionId:'click-one',
      guildId:platform==='kook'?null:'100000000000000001',channelId:'300000000000000001',actionReference,
      privateReplyContext:platform==='discord'?{applicationId:'400000000000000001',interactionToken:'fixture-private-token'}:
        {userId:profile.id,channelId:'300000000000000001',messageId:'card-one'}, payload:{kind:'public'},...(platform==='discord'?{locale:'zh-CN'}:{}),...extra})),
    headers:{},receivedAt:new Date(state.now).toISOString()});
  const io={async ack(payload){state.events.push('ack');acks.push(payload);}};
  const handler=(platform,override={})=>createNotificationCallbackHandler({platform,identity,scheduling,
    verify:envelope=>JSON.parse(Buffer.from(envelope.rawBody).toString('utf8')),resolveActionReference:resolveReference,
    publicOrigin:'http://127.0.0.1:4316',transport,now:()=>state.now,...override});
  state.events=[];
  return {state,profile,actor,operator,wipe,references,transport,privateReplies,acks,envelope,io,handler,resolveReference,
    get identity(){return identity;},get scheduling(){return scheduling;},
    signup(){return scheduling.getSignup(identity.actorForAccount(actor.id),wipe.id,actor.memberId);},
    restart(){db.close();db=new DatabaseSync(databasePath);identity=new IdentityService(new IdentityRepository(db),{providers,now:()=>state.now});
      scheduling=new SchedulingService(new SchedulingRepository(db),identity,{now:()=>state.now});},
    reschedule(){wipe=scheduling.updateWipe(operator,wipe.id,{expectedRevision:wipe.revision,musterAt:'2026-09-10T08:30:00.000Z'},
      {operationId:`reschedule-${wipe.revision}`}).current;return wipe;}
  };
}
export function replyText(reply) {
  return reply.platform==='discord'?reply.payload.content:JSON.parse(reply.payload.content)[0].modules[0].text.content;
}
export function privateButtons(reply) {
  return reply.platform==='discord'?reply.payload.components.flatMap(r=>r.components).map(b=>({value:b.custom_id,url:b.url,label:b.label})):
    JSON.parse(reply.payload.content)[0].modules.filter(m=>m.type==='action-group').flatMap(m=>m.elements).map(b=>({value:b.click==='return-val'?b.value:null,url:b.click==='link'?b.value:null,label:b.text.content}));
}
export function confirmPayload(button) {
  if (button.value.startsWith('nbconfirm:')) return {kind:'confirm',contextToken:button.value.slice(10)};
  const [,contextToken,epoch]=button.value.split(':');
  return {kind:'confirm',contextToken,input:{expectedArrivalAt:new Date(Number(epoch)).toISOString(),timeZone:'UTC'}};
}
