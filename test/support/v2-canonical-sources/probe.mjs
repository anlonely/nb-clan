import {observations} from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {fixture} from './fixture.mjs';
import {defaultRules} from '../../../server/v2/member-admin/risk.js';
import {createCanonicalSourcePolicy} from '../../../server/v2/management-adapters/source-policy/index.js';
const config=JSON.parse(process.argv[2]),mode=process.argv[3]||'enabled';
const isRisk=mode==='risk'||mode==='rules-drift',isDiscord=mode.startsWith('discord');
const f=await fixture(config,{enabled:!['disabled','discord','discord-drift','discord-archive-drift','discord-selection'].includes(mode),credentials:mode!=='missing',
  ...(['all-five','wipe-drift'].includes(mode)?{wipe:true,capabilities:{steam:true,battlemetrics:true,vital:true}}:{}),
  ...(isRisk?{capabilities:{steam:true,memberRisk:true,steamRisk:true,inventory:true}}:{}),
  ...(isDiscord?{discord:true,capabilities:{discordMembershipAudit:true}}:{})});
const checks=[],extra={};let created,release;
const check=(name,fn)=>{fn();checks.push(name);};
const profile=memberId=>f.managed.members.repo.all('memberProfiles').find(p=>p.memberId===memberId);
const expect=async(route,body,status=200)=>{const r=await f.request(route,{body});assert.equal(r.status,status,JSON.stringify(r.body));return r.body.data;};
const bounded=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timed out '+label)),10000))]);}finally{clearTimeout(timer);}};
async function gate(match,work,mutate){let enter;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);f.setInterceptor(async req=>{if(match(req.path)){enter(req);await wait;}});const pending=work().then(value=>({value}),error=>({error}));try{await bounded(entered,'native response');await mutate();}finally{release();f.setInterceptor(null);}const outcome=await bounded(pending,'worker completion');release=null;if(outcome.error)throw outcome.error;}
async function riskRules(change){const current=await expect('/member-admin/risk-rules');return expect('/member-admin/risk-rules',{expectedRevision:current.revision,rules:change(current.rules),squadFilter:current.squadFilter||''});}
try{
  const db=f.identity.repo.db,n=db.prepare('SELECT total_changes() n').get().n;
  const policy=createCanonicalSourcePolicy({identity:f.identity,getSystem:()=>f.managed,readControl:()=>f.controls,sourceBindings:{capabilities:f.capabilities,readCredentials:()=>({...f.native})}});
  policy.readPolicy();policy.diagnostics();await expect('/source-admin/sources/steam');await expect('/source-admin/sources/battlemetrics');
  check('constructor-and-canonical-GET-do-not-write-or-migrate',()=>assert.equal(db.prepare('SELECT total_changes() n').get().n,n));
  check('same-original-identity-BM-queue-and-source-authority',()=>{assert.equal(f.managed.identity,f.identity);assert.equal(f.managed.sourceHost.battlemetricsQueue,f.owners.sharedBattlemetricsQueue);assert.equal(f.managed.service.authority,f.managed.sources.authority);});
  if(isRisk)await riskRules(()=>defaultRules().map(r=>({...r,enabled:!['inventory_value','no_online_days','unassigned_squad'].includes(r.type)})));
  if(isDiscord){
    created=await f.create('76561198999999231',{discordId:'400000000000000004'});
    f.identity.repo.put('accounts',{id:'canonical-discord-member',memberId:created.id,status:'active',roleId:'member',permissionVersion:1,revision:1});
    f.identity.repo.put('bindings',{id:'canonical-discord-binding',accountId:'canonical-discord-member',memberId:created.id,steamId:'76561198999999231',status:'verified',revision:1});
    f.identity.repo.put('identities',{id:'canonical-discord-identity',provider:'discord',externalId:'400000000000000004',accountId:'canonical-discord-member',verifiedAt:new Date().toISOString(),revision:1});
    const policy=f.identity.repo.all('policies').find(row=>row.provider==='discord');
    f.identity.repo.put('policies',{...policy,id:policy?.id||'discord',provider:'discord',enabled:true,guildId:'400000000000000001',allowedRoleIds:['400000000000000002'],matchMode:'any',policyRevision:(policy?.policyRevision||0)+1});
    await f.drain();
    const d=f.owners.sourcePolicy;
    if(mode==='discord-selection'){
      const pin=f.controls.discord;delete f.controls.discord;check('multiple-targets-never-choose-first',()=>{assert.equal(d.diagnostics().discord.reason,'DISCORD_TARGET_SELECTION_REQUIRED');assert.equal(d.readDiscordSettings().guildId,'');});f.controls.discord={...pin,targetId:'missing'};check('explicit-target-required',()=>assert.equal(d.diagnostics().discord.reason,'DISCORD_TARGET_MISSING'));f.controls.discord=pin;
      const configOwner=f.managed.platforms.service,current=configOwner.config('discord');
      for(const [name,targets]of [['disabled',current.targets.map(t=>({...t,enabled:false}))],['deleted',current.targets.filter(t=>t.id!==pin.targetId)],['guild-changed',current.targets.map(t=>({...t,guildId:'600000000000000001'}))]]){
        const before=configOwner.config('discord');await expect('/platform-admin/discord/config',{expectedRevision:before.revision,config:{enabled:before.enabled,targets}});check('canonical-target-'+name+'-invalidates-pin',()=>assert.equal(d.diagnostics().discord.ready,false));
      }
    }else{
      check('explicit-canonical-target-and-reviewed-archive-ready',()=>assert.equal(d.diagnostics().discord.ready,true));
      const settings=d.readDiscordSettings(),revision=d.readPolicy().revision;
      const old=f.identity.repo.scalar('settings');f.identity.repo.setScalar('settings',{...old,discord:{enabled:true,botToken:'legacy-never-used',guildId:'700000000000000001',memberRegisterRoleId:'700000000000000002'}});
      check('live-legacy-discord-never-falls-back',()=>{assert.deepEqual(d.readDiscordSettings(),settings);assert.equal(d.readPolicy().revision,revision);});
      const previousDiscordObservation=structuredClone(f.identity.repo.get('members',created.id).discordMembershipObservation);
      const input={type:'discord_membership_audit',scope:{kind:'members',memberIds:[created.id]}},admitted=await expect('/sync-center/jobs',input,202),job=admitted.job;assert.ok(job?.id);extra.discordJob=job.id;
      if(mode==='discord-drift'||mode==='discord-archive-drift')await gate(path=>path.includes('/members/'),()=>f.drain(),async()=>{const owner=f.managed.platforms.service;if(mode==='discord-archive-drift'){const archive=owner.repo.get('legacy-archive','discord');owner.repo.put('legacy-archive','discord','discord','user_root',Date.now(),{...archive,targetRules:archive.targetRules.map(r=>({...r,memberRegisterRoleId:'800000000000000002'}))});}else{const current=f.identity.repo.all('policies').find(row=>row.provider==='discord');f.identity.repo.put('policies',{...current,guildId:'600000000000000001',policyRevision:current.policyRevision+1});}});else await f.drain();
      const p=f.identity.repo.get('members',created.id);extra.discordObservation={status:p.discordMembershipStatus,observation:p.discordMembershipObservation};
      if(mode==='discord')check('original-Discord-native-read-canonical-profile',()=>{assert.ok(f.jobs().some(j=>j.type==='discord_membership_audit'&&j.status==='succeeded'),JSON.stringify(f.jobs()));assert.ok(p?.discordMembershipObservation,JSON.stringify(p));});
      else if(mode==='discord-archive-drift')check('legacy-archive-change-does-not-override-verified-identity-policy-source',()=>{assert.equal(f.jobs().find(j=>j.id===job.id)?.status,'succeeded');assert.equal(p.discordMembershipObservation.context.guildId,'400000000000000001');});
      else check('current-community-policy-change-fences-inflight-write',()=>{assert.deepEqual(p?.discordMembershipObservation,previousDiscordObservation);assert.notEqual(f.jobs().find(j=>j.id===job.id)?.status,'succeeded');});
    }
  }else{
    if(mode==='capability-drift')f.capabilities.steam=false;
    if(mode==='paused')await expect('/sync-center/sources/steam',{expectedRevision:2,paused:true});
    if(mode==='all-five'){
      const originalWipe=f.identity.repo.get('schedulingWipes','canonical-wipe');db.exec('BEGIN');
      try{f.identity.repo.put('schedulingWipes',{...originalWipe,lifecycle:'ended',endedAt:new Date(Date.now()-7200000).toISOString()});check('invalid-closed-window-is-not-ready-or-admitted',()=>assert.equal(f.owners.sourcePolicy.readPolicy().tasks.battlemetrics_playtime.ready,false));f.identity.repo.put('schedulingWipes',originalWipe);f.identity.repo.put('schedulingWipes',{...originalWipe,id:'second-active-wipe'});check('multiple-current-wipes-never-pick-first',()=>{for(const type of ['battlemetrics_playtime','kda'])assert.equal(f.owners.sourcePolicy.readPolicy().tasks[type].reason,'CURRENT_WIPE_AMBIGUOUS');});}finally{db.exec('ROLLBACK');}
      const args={type:'battlemetrics_playtime',scope:{kind:'members',memberIds:[],wipeId:'canonical-wipe'}};
      const raw=f.owners.sourcePolicy.readSourceConfig(args),admitted=f.owners.sourcePolicy.readFollowupSourceConfig(args);
      check('active-BM-admission-does-not-fabricate-window-cutoff',()=>{assert.equal(raw.enabled,false);assert.equal(raw.to,'');assert.equal(admitted.enabled,true);assert.equal(admitted.to,'');assert.ok(!args.scope.sourceWindowId);});
      const authority=f.managed.sources.authority,capture=authority.captureScope;authority.captureScope=undefined;
      try{check('missing-original-window-capture-refuses-admission',()=>assert.equal(f.owners.sourcePolicy.readFollowupSourceConfig(args).enabled,false));}finally{authority.captureScope=capture;}
      check('bound-invalid-window-is-never-overridden',()=>assert.throws(()=>f.owners.sourcePolicy.readFollowupSourceConfig({...args,scope:{...args.scope,sourceWindowId:'missing'}})));
    }
    created=await f.create();
    if(['key-drift','principal-drift','rules-drift','control-drift','adapter-key-drift','principal-version-drift','wipe-drift'].includes(mode)){
      await gate(path=>mode==='rules-drift'?path.includes('GetPlayerBans'):mode==='wipe-drift'?path.includes('/relationships/sessions'):path.includes('GetPlayerSummaries'),()=>f.drain(),async()=>{
        if(mode==='key-drift'){const current=await expect('/source-admin/sources/steam');await expect('/source-admin/commands/steam.save',{input:{expectedRevision:current.revision,apiKey:'Controlled-Changed-Steam-Key'}});}
        if(mode==='principal-drift'){const account=f.identity.repo.get('accounts',f.principalId);await expect('/system-admin/commands/account.status',{target:f.principalId,input:{expectedRevision:account.revision,status:'disabled'}});}
        if(mode==='rules-drift')await riskRules(rules=>rules.map(r=>({...r,threshold:r.threshold+1})));
        if(mode==='principal-version-drift'){const account=f.identity.repo.get('accounts',f.principalId);await expect('/system-admin/commands/account.password',{target:f.principalId,input:{expectedRevision:account.revision,password:'Controlled-New-Principal-Password'}});}
        if(mode==='wipe-drift'){const wipe=f.identity.repo.get('schedulingWipes','canonical-wipe');await expect('/wipes/canonical-wipe/commands/confirm-server-start',{expectedRevision:wipe.revision,serverActualWipeAt:new Date(Date.now()-3000000).toISOString(),serverStartEvidence:'Controlled current wipe correction'});}
        if(mode==='control-drift')f.controls.enabled=false;
        if(mode==='adapter-key-drift')f.native.steamApiKey='Controlled-Adapter-Rotated-Key';
      });
      const member=f.identity.repo.get('members',created.id),p=profile(created.id);
      if(mode==='principal-drift')check('root-shared-worker-revocation-cancels-claims-and-releases-leases',()=>{assert.ok(f.jobs().every(j=>j.status==='cancelled'&&j.reason==='AUTHORIZATION_REVOKED'&&!j.owner&&j.leaseUntil===0),JSON.stringify(f.jobs()));extra.rootWorkerRevocationFixVerified=true;});
      check('inflight-'+mode+'-prevents-old-canonical-write',()=>{if(mode==='rules-drift')assert.ok(!p?.riskScan);else if(mode==='wipe-drift'){const job=f.jobs().find(j=>j.type==='battlemetrics_playtime');assert.notEqual(job.status,'succeeded');assert.ok(!p?.battlemetricsSyncedAt);}else{assert.ok(!member.steamNickname);assert.ok(f.jobs().every(j=>j.status!=='succeeded'));}});
    }else await f.drain();
    if(['enabled','all-five','risk'].includes(mode)){
      check('real-HTTP-outbox-single-worker-source-canonical-write',()=>{const jobs=f.jobs();assert.equal(jobs.length,mode==='all-five'?5:2,JSON.stringify({jobs,progress:f.progress()}));assert.ok(jobs.every(j=>['succeeded','no_work'].includes(j.status)),JSON.stringify(jobs));assert.match(f.identity.repo.get('members',created.id).steamNickname,/采集昵称/);});
      if(mode==='all-five'){
        const job=f.jobs().find(j=>j.type==='battlemetrics_playtime');extra.bmWindow=db.prepare('SELECT * FROM v2_source_windows WHERE job_id=?').get(job.scope.sourceWindowId);extra.profile=profile(created.id);extra.kda=f.managed.members.repo.all('kdaRows').filter(r=>r.memberId===created.id);
        check('original-window-persisted-and-BM-KDA-canonical-values-written',()=>{assert.ok(job.scope.sourceWindowId);assert.ok(extra.bmWindow,JSON.stringify(job.scope));assert.equal(f.identity.repo.get('members',created.id).battlemetricsId,'987654321');assert.ok(extra.profile);assert.ok(extra.kda.some(r=>r.kills===30),JSON.stringify(extra));});
      }
      if(mode==='risk'){extra.profile=profile(created.id);check('risk-quality-reflects-current-selected-rules',()=>{assert.equal(extra.profile.riskScan.quality,'complete',JSON.stringify(extra.profile));assert.equal(f.owners.sourcePolicy.readPolicy().tasks.member_profile.coverage,'partial_capabilities');});}
    }else if(['disabled','missing','paused','capability-drift'].includes(mode))check('disabled-or-unready-no-jobs-no-network-with-completed-outbox',()=>{assert.equal(f.jobs().length,0);assert.equal(f.calls.length,0);assert.ok(f.progress().followup.completed);});
  }
  check('explicit-current-G03-principal-not-event-author',()=>{assert.notEqual(f.principalId,'user_root');assert.ok(f.jobs().filter(j=>j.trigger==='auto').every(j=>j.actorId===f.principalId));});
  check('no-native-network-inside-member-transaction',()=>assert.ok(f.calls.every(c=>c.memberTransaction===false)));
  check('no-default-env-data-or-external-network-access',()=>{assert.equal(observations.forbiddenAttempts,0);assert.equal(observations.externalNetworkAttempts,0);});
  const result={mode,checks,principalId:f.principalId,eventActor:'user_root',policy:f.owners.sourcePolicy.diagnostics(),jobs:f.jobs().map(j=>({id:j.id,type:j.type,status:j.status,actorId:j.actorId,scope:j.scope,items:j.items.map(i=>({status:i.status,reason:i.reason}))})),progress:f.progress(),...(created?{member:{id:created.id,steamNickname:f.identity.repo.get('members',created.id).steamNickname}}:{}),calls:f.calls,observations,...extra,realPlatformAcceptance:false};
  const serialized=JSON.stringify(result,null,2);assert.ok(!/synthetic-canonical-.*-key|Controlled-Changed-Steam-Key|Controlled-Adapter-Rotated-Key|legacy-never-used|controlled-openid/.test(serialized));console.log(serialized);
}finally{release?.();await f.close();}
