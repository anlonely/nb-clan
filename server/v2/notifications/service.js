import { deploymentText } from '../../branding.js';
import {editOperationDTO,editRecoveryContext,reconcileEdit} from './edit-recovery.js';
import {rosterReadScope} from '../scheduling/read-snapshot.js';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { can, authorize } from '../identity/permissions.js';
import { IdentityError } from '../identity/errors.js';
import { resourceKind, resourceFields, domainFor, businessVisible, registerBusinessDomain, createBusinessIntent } from './business.js';
import { need, hash, tokenHash, newId, stamp, identifier, reason, statuses, purposes, languages, page } from './shared.js';
import { discordSignupRows, submitDiscordSignup } from './discord-signups.js';
import { resolveServerConnectIp } from '../platform-admin/server-connect-card.js';
import { assertCardViewProof } from '../notification-platforms/card-language-view.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k] ?? null]));
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const fields = (value, allowed) => need(object(value) && Object.keys(value).every(k => allowed.includes(k)), 'NOTIFICATION_INPUT_INVALID',422);
const ids = value => { need(Array.isArray(value) && value.length <= 10000 && value.every(identifier),'NOTIFICATION_INPUT_INVALID',422); return [...new Set(value)].sort(); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'PLATFORM_RESULT_UNKNOWN';
const refKeys = ['id','platform','guildId','channelId','messageId','messageUrl','contentRevision','state','updatedAt'];
const deliveryKeys = ['id','intentId','wipeId','targetId','targetLabel','platform','language','revision','status','attemptCount','executionEpoch','nextAttemptAt','dueAt','expiresAt','lastErrorCode','lastErrorMessage','createdAt','updatedAt','sentAt','cancelRequested'];
const cardBrandName = deploymentText("Clan Portal");
export class NotificationService {
  constructor(deps) { Object.assign(this,deps); }
  submitDiscordSignup(verified) { return submitDiscordSignup(this, verified); }
  registerBusinessDomain(kind, domain) { return registerBusinessDomain(this, kind, domain); }
  createBusinessIntent(plan) { return createBusinessIntent(this, plan); }
  resourceRows(name, row) { return resourceKind(row) === 'wipe' ? this.repo.forWipe(name, row.wipeId) : this.repo.forResource(name, row.resource); }
  requireResource(actor, row) {
    if (resourceKind(row) === 'wipe') return this.wipe(actor, row.wipeId);
    need(businessVisible(this, actor, row), 'RESOURCE_NOT_FOUND', 404);
  }
  deliveryPermitted(actor, cap, row) {
    if (resourceKind(row) === 'wipe') return this.permitted(actor, cap, row.targetId);
    return businessVisible(this, actor, row) && this.permitted(actor, cap, row.targetId);
  }
  requireDeliveryCapability(actor, cap, row) { need(this.deliveryPermitted(actor, cap, row), 'ACCESS_DENIED', 403); }
  actor(actor) {
    const current = this.identity.actorForAccount(actor?.id);
    need(current.permissionVersion === actor?.permissionVersion,'PERMISSIONS_CHANGED',401);
    return current;
  }
  permitted(actor, cap, targetId) { return can(actor,`notifications.${cap}`,{kind:'platformTarget',id:targetId},this.identity.relations()); }
  requireTarget(actor,cap,targetId) { authorize(actor,`notifications.${cap}`,{kind:'platformTarget',id:targetId},this.identity.relations()); }
  wipe(actor,id) { need(identifier(id),'WIPE_REQUIRED',422); return this.scheduling.getWipe(actor,id); }
  target(id) {
    const target = this.catalog.getTarget(id);
    need(target && target.id === id && identifier(target.guildId) && identifier(target.channelId) && ['discord','kook'].includes(target.platform) &&
      Number.isSafeInteger(target.configurationRevision) && target.configurationRevision > 0 && Array.isArray(target.languages) && Array.isArray(target.roleOptions), 'TARGET_INVALID',422);
    need(target.runtimeMode === this.options.runtimeMode,this.options.runtimeMode === 'isolated' ? 'ISOLATED_TRANSPORT_REQUIRED' : 'NOTIFICATION_TRANSPORT_MODE_MISMATCH',503);
    return structuredClone(target);
  }
  targetDTO(actor,t) {
    return {...pick(t,['id','platform','guildId','channelId','label','guildLabel','channelLabel','enabled','configurationRevision','languages']),
      ...(t.platform==='discord'?{signupMode:t.signupMode||'member_required'}:{}),
      roleOptions:t.roleOptions.map(r=>pick(r,['id','label'])),runtimeMode:this.options.runtimeMode,capabilities:{
        preview:this.permitted(actor,'preview',t.id),send:this.permitted(actor,'send',t.id),
        mentionRoles:this.permitted(actor,'mention_role',t.id),mentionEveryone:this.permitted(actor,'mention_everyone',t.id)}};
  }
  targetSelection(actor,selection,cap = 'preview',{enabled = true} = {}) {
    const t = this.target(selection.targetId); this.requireTarget(actor,cap,t.id);
    need(!enabled || t.enabled === true,'TARGET_INVALID',422);
    need(languages.includes(selection.language) && t.languages.includes(selection.language),'LANGUAGE_UNSUPPORTED',422);
    if (selection.mentionMode === 'roles') {
      this.requireTarget(actor,'mention_role',t.id); need(selection.roleIds.length > 0 && selection.roleIds.every(id=>t.roleOptions.some(r=>r.id===id)),'MENTION_INVALID',422);
    } else if (selection.mentionMode === 'everyone') this.requireTarget(actor,'mention_everyone',t.id);
    return t;
  }
  allowedPurposes(w) {
    if (w.lifecycle === 'draft') return [];
    if (w.lifecycle === 'cancelled') return ['cancelled','result'];
    if (['ended','archived'].includes(w.lifecycle)) return ['result'];
    return ['signup_open','reminder','schedule_changed','signup_closed'];
  }
  normalizeInput(input) {
    fields(input,['expectedContentRevision','templateId','templateRevision','purpose','purposeInstance','repeatOfIntentId','reason','duplicateRiskAcknowledged','targets','audience','schedule']);
    need(Number.isSafeInteger(input.expectedContentRevision) && input.expectedContentRevision>0,'NOTIFICATION_INPUT_INVALID',422);
    need(input.templateId === 'wipe-notification','TEMPLATE_UNSUPPORTED',422);
    need(input.templateRevision === 1,'TEMPLATE_REVISION_UNSUPPORTED',422);
    need(purposes.includes(input.purpose),'NOTIFICATION_INPUT_INVALID',422);
    need(typeof input.duplicateRiskAcknowledged === 'boolean','NOTIFICATION_INPUT_INVALID',422);
    need(Array.isArray(input.targets) && input.targets.length>=1 && input.targets.length<=20,'TARGET_INVALID',422);
    const targets=input.targets.map(selection=>{
      fields(selection,['targetId','language','mentionMode','roleIds']);
      need(identifier(selection.targetId),'TARGET_INVALID',422); need(languages.includes(selection.language),'LANGUAGE_UNSUPPORTED',422);
      need(['none','roles','everyone'].includes(selection.mentionMode),'MENTION_INVALID',422);
      const roleIds=ids(selection.roleIds); need(selection.mentionMode==='roles' ? roleIds.length>0 : roleIds.length===0,'MENTION_INVALID',422);
      return {...selection,roleIds};
    }).sort((a,b)=>a.targetId.localeCompare(b.targetId)||a.language.localeCompare(b.language));
    need(new Set(targets.map(t=>hash([t.targetId,t.language]))).size===targets.length,'TARGET_INVALID',422);
    fields(input.audience,['squadIds','memberIds','includeUnassigned','allMembers']);
    need(input.audience.allMembers === undefined || typeof input.audience.allMembers === 'boolean','NOTIFICATION_INPUT_INVALID',422);
    need(typeof input.audience.includeUnassigned==='boolean','NOTIFICATION_INPUT_INVALID',422);
    const audience={...(input.audience.allMembers !== undefined ? {allMembers:input.audience.allMembers} : {}),squadIds:ids(input.audience.squadIds),memberIds:ids(input.audience.memberIds),includeUnassigned:input.audience.includeUnassigned};
    need(input.repeatOfIntentId===null || identifier(input.repeatOfIntentId),'NOTIFICATION_INPUT_INVALID',422);
    need(input.reason===null || typeof input.reason==='string' && input.reason.length<=2000,'NOTIFICATION_INPUT_INVALID',422);
    if (input.repeatOfIntentId) { need(uuid(input.purposeInstance),'NOTIFICATION_INPUT_INVALID',422); reason(input.reason); }
    else need(input.purposeInstance==='primary' && input.duplicateRiskAcknowledged===false,'NOTIFICATION_INPUT_INVALID',422);
    let schedule=null;
    if (input.schedule!==null) {
      fields(input.schedule,['dueAt','expiresAt']);
      const {dueAt,expiresAt}=input.schedule;
      need([dueAt,expiresAt].every(v=>typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v))) && Date.parse(expiresAt)>Date.parse(dueAt),'SCHEDULE_INVALID',422);
      schedule={dueAt:new Date(dueAt).toISOString(),expiresAt:new Date(expiresAt).toISOString()};
    }
    return {...input,targets,audience,schedule,reason:input.reason?.trim()||null};
  }
  audienceSnapshot(actor,w,audience) {
    const scheduling=rosterReadScope(this.scheduling,w),identity=scheduling.identity;
    const prospective={...w,audience};
    need((!audience.allMembers || w.audience.allMembers === true) &&
      audience.squadIds.every(id=>w.audience.squadIds.includes(id) || w.audience.allMembers === true && identity.repo.get('squads',id)) &&
      (!audience.includeUnassigned || w.audience.allMembers === true || w.audience.includeUnassigned) &&
      audience.memberIds.every(id=>identity.repo.get('members',id) && scheduling.inAudience(w,id)), 'NOTIFICATION_AUDIENCE_DENIED',403);
    const members=identity.repo.all('members').filter(m=>scheduling.inAudience(prospective,m.id));
    for (const member of members) need(can(actor,'signups.read',{kind:'signup',wipeId:w.id,memberId:member.id},identity.relations()),'NOTIFICATION_AUDIENCE_DENIED',403);
    // Scope checks include frozen archive members; current membership must not reveal an unreadable historical roster.
    const roster=scheduling.rosterForRead(actor,w);
    const full=hash(audience)===hash(w.audience);
    const rows=full?roster.rows:roster.rows.filter(row=>scheduling.inAudience(prospective,row.memberId));
    need(!full || !['authorized_members','authorized_archived_members'].includes(roster.countScope),'NOTIFICATION_AUDIENCE_DENIED',403);
    return {rows,counts:this.scheduling.counts(rows),rosterRevision:roster.rosterRevision,countScope:full?roster.countScope:'notification_audience',evaluatedAt:stamp(this.now)};
  }
  teamCounts(rows) {
    const squads=new Map(this.identity.repo.all('squads').map(squad=>[squad.id,String(squad.name||'').trim().toUpperCase()]));
    const memberships=new Map();
    for(const link of this.identity.relations().squadMembers) if(!link.validTo && ['CN','EU'].includes(squads.get(link.squadId))){
      const groups=memberships.get(link.memberId)||new Set();groups.add(squads.get(link.squadId));memberships.set(link.memberId,groups);
    }
    return Object.fromEntries(['CN','EU'].map(group=>[group,Object.fromEntries([
      ['onTime','attending_on_time'],['later','attending_later'],['notAttending','not_attending']
    ].map(([key,response])=>[key,rows.filter(row=>row.response===response && memberships.get(row.memberId)?.has(group)).length]))]));
  }
  discordTeamAttendance(rows) {
    const squads=new Map(this.identity.repo.all('squads').map(squad=>[squad.id,String(squad.name||'').trim()]));
    const attending=new Set(rows.filter(row=>row.response==='attending_on_time').map(row=>row.memberId));
    const counts=new Map(),seen=new Set();
    for(const link of this.identity.relations().squadMembers) {
      const name=squads.get(link.squadId),key=`${link.squadId}:${link.memberId}`;
      if(link.validTo || !name || !attending.has(link.memberId) || seen.has(key)) continue;
      seen.add(key);
      counts.set(link.squadId,(counts.get(link.squadId)||0)+1);
    }
    return [...counts].map(([squadId,onTime])=>({name:squads.get(squadId).slice(0,80),onTime}))
      .sort((a,b)=>a.name.localeCompare(b.name)).slice(0,24);
  }
  discordAttendanceRows(rows,w) {
    const source=String([w.serverSnapshot?.serverVipProvider,w.serverSnapshot?.vipProvider,w.serverSnapshot?.name,w.serverSnapshot?.vipUrl].filter(Boolean).join(' ')).toLowerCase();
    const provider=source.includes('atlas')?'atlas':source.includes('rustinity')?'rustinity':source.includes('vital')?'vital':'';
    const now=this.now();
    return rows.filter(row=>row.response).map(row=>{
      const member=this.identity.repo.get('members',row.memberId)||{};
      const type=provider?member[`${provider}VipType`]:null;
      const expires=provider?member[`${provider}VipExpiresAt`]:null;
      const expiresAt=typeof expires==='string'&&expires?Date.parse(`${expires.slice(0,10)}T23:59:59.999Z`):null;
      const vipBadge=type&&type!=='none'&&(!Number.isFinite(expiresAt)||expiresAt>=now)
        ? type==='queue_skip'?'🟣':type==='priority'?'🟡':'' : '';
      return {response:row.response,name:String(row.displayName||member.displayName||'').slice(0,80),
        discordId:/^\d{15,22}$/.test(String(member.discordId||''))?String(member.discordId):'',
        expectedArrivalAt:row.response==='attending_later'?(row.expectedArrivalAt||null):null,vipBadge};
    });
  }
  snapshot(actor,w,audience,{includeAttendance=false,target=null}={}) {
    const roster=this.audienceSnapshot(actor,w,audience);
    const discordOnly=includeAttendance&&target?.signupMode==='discord_only';
    const discordRows=includeAttendance&&target&&target.signupConfigurationEnabled!==false?discordSignupRows(this,w.id,target.guildId):[];
    // Visibility changes do not undo committed signup revisions.
    const discordRevision=includeAttendance&&target&&target.signupConfigurationEnabled!==false?
      this.repo.forWipe('discordSignups',w.id).filter(row=>row.guildId===target.guildId).reduce((sum,row)=>sum+row.signupRevision,0):0;
    const directConnect=w.serverSnapshot?.directConnect||w.serverSnapshot?.connectCommand||'';
    return {cardBrandName,wipeId:w.id,title:w.title,description:w.description,serverLabel:w.serverSnapshot?.name||w.serverSnapshot?.label||w.serverProfileId||'',
      directConnect,...(includeAttendance?{directConnectIp:this.signupConnectIps?.get(directConnect)?.ip||null}:{}),
      musterAt:w.musterAt,signupClosesAt:w.signupClosesAt,serverScheduledWipeAt:w.serverScheduledWipeAt,actualStartedAt:w.actualStartedAt||null,timeZone:w.timeZone,
      lifecycle:w.lifecycle,effectiveSignupWindow:this.scheduling.window(w),contentRevision:w.contentRevision,rosterRevision:roster.rosterRevision+discordRevision,
      counts:discordOnly?this.scheduling.counts(discordRows):roster.counts,teamCounts:this.teamCounts(discordOnly?[]:roster.rows),
      ...(includeAttendance?{discordLocaleVersion:1,signupMode:discordOnly?'discord_only':'member_required',signupConfigurationRevision:target?.configurationRevision||null,attendanceRows:discordOnly?discordRows.map(row=>({response:row.response,name:row.name,discordId:row.discordId,expectedArrivalAt:row.expectedArrivalAt,vipBadge:''})):this.discordAttendanceRows(roster.rows,w),teamAttendance:discordOnly?[]:this.discordTeamAttendance(roster.rows),vipUrl:w.serverSnapshot?.vipUrl||''}:{}),
      countScope:discordOnly?'notification_audience':roster.countScope,evaluatedAt:roster.evaluatedAt,
      memberUrl:`${this.publicOrigin}/app/wipes/${encodeURIComponent(w.id)}?tab=plan#signup`};
  }
  async ensureSignupConnectIp(wipe) {
    this.signupConnectIps ||= new Map();
    const command=wipe.serverSnapshot?.directConnect||wipe.serverSnapshot?.connectCommand||'';
    const cached=this.signupConnectIps.get(command);
    if(!cached||cached.expiresAt<=this.now()){
      const ip=await (this.options?.resolveConnectIp||resolveServerConnectIp)(command);
      this.signupConnectIps.set(command,{ip,expiresAt:this.now()+300000});
    }
  }
  refreshCardBrands() {
    return this.repo.transaction(()=>{
      let queued=0;
      for(const delivery of this.repo.all('deliveries')) {
        if(delivery.resource!==undefined||delivery.status!=='sent'||!['discord','kook'].includes(delivery.platform))continue;
        const intent=this.repo.get('intents',delivery.intentId);
        if(intent?.resource!==undefined||intent?.purpose!=='signup_open'||intent.wipeId!==delivery.wipeId)continue;
        let target;
        try {target=this.target(delivery.targetId);} catch(error) {if(error instanceof IdentityError)continue;throw error;}
        if(!target.enabled||target.signupConfigurationEnabled===false||target.platform!==delivery.platform||
          target.platform!==delivery.target?.platform||target.guildId!==delivery.target.guildId||target.channelId!==delivery.target.channelId)continue;
        const operations=this.resourceRows('messageOperations',delivery).filter(op=>op.deliveryId===delivery.id);
        if(operations.some(op=>['queued','running','unknown','result_unknown'].includes(op.status)))continue;
        const refs=this.resourceRows('messageRefs',delivery).filter(ref=>ref.deliveryId===delivery.id&&ref.state==='active'&&
          ref.wipeId===delivery.wipeId&&ref.intentId===delivery.intentId&&ref.targetId===delivery.targetId&&
          ref.platform===target.platform&&ref.guildId===target.guildId&&ref.channelId===target.channelId&&identifier(ref.messageId));
        for(const ref of refs) {
          const edits=operations.filter(op=>op.kind==='edit'&&op.messageRefId===ref.id);
          const pinned=ref.lastMessageOperationId&&edits.find(op=>op.id===ref.lastMessageOperationId);
          // An applied pin is authoritative even when timestamps tie. A broken
          // or uncertain pin cannot make the first-send payload current again.
          if(ref.lastMessageOperationId&&pinned?.status!=='succeeded')continue;
          const latest=pinned||edits.filter(op=>op.status==='succeeded').sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
          const applied=latest||delivery;
          if(applied.snapshot?.cardBrandName===cardBrandName)continue;
          // KOOK's current signup template carries no static brand. Avoid edits
          // to cards whose visible payload never contained the former names.
          if(delivery.platform==='kook'&&!/Rust Siege Group|NB Clan/i.test(JSON.stringify(applied.payload||{})))continue;
          if(edits.some(op=>op.status==='failed'&&(op.requestedCardBrandName===cardBrandName||op.snapshot?.cardBrandName===cardBrandName)))continue;
          try {this.executionContext(delivery,{mode:'edit'});} catch(error) {if(error instanceof IdentityError)continue;throw error;}
          this.queueMessageOperation(delivery,'edit',{messageRefId:ref.id,reasonCode:'CARD_BRAND_CHANGED',requestedCardBrandName:cardBrandName});
          queued++;
        }
      }
      return queued;
    });
  }
  async refreshSignupConnectIps() {
    this.signupConnectIps ||= new Map();
    const deliveries=this.repo.all('deliveries').filter(d=>d.resource===undefined&&d.platform==='discord'&&
      ['sent','queued','retry_wait'].includes(d.status)&&this.repo.get('intents',d.intentId)?.purpose==='signup_open');
    for(const delivery of deliveries){
      const wipe=this.scheduling.repo.get('wipes',delivery.wipeId);
      if(!wipe)continue;
      const command=wipe.serverSnapshot?.directConnect||wipe.serverSnapshot?.connectCommand||'';
      await this.ensureSignupConnectIp(wipe);
      if(delivery.status!=='sent')continue;
      const historical=['ended','archived','cancelled'].includes(wipe.lifecycle);
      const operations=this.resourceRows('messageOperations',delivery).filter(op=>op.deliveryId===delivery.id);
      if(operations.some(op=>['queued','running','unknown'].includes(op.status)))continue;
      const ip=this.signupConnectIps.get(command).ip||null;
      const target=this.catalog.getTarget(delivery.targetId);
      if(!target || !target.enabled || target.guildId!==delivery.target.guildId || target.channelId!==delivery.target.channelId)continue;
      const signupMode=target.signupMode||'member_required',configurationRevision=target.configurationRevision;
      const currentPayload=op=>(op.snapshot?.directConnectIp||null)===ip&&op.snapshot?.directConnect===command&&
        op.snapshot?.discordLocaleVersion===1&&
        op.snapshot?.signupMode===signupMode&&op.snapshot?.signupConfigurationRevision===configurationRevision;
      // The reference pins its applied edit. Timestamps can tie within a batch;
      // selecting another edit by time alone can rewind the observed payload.
      for(const ref of this.resourceRows('messageRefs',delivery).filter(ref=>ref.deliveryId===delivery.id&&['active','update_failed'].includes(ref.state))){
        const edits=operations.filter(op=>op.kind==='edit'&&(!op.messageRefId||op.messageRefId===ref.id));
        const pinned=ref.lastMessageOperationId&&edits.find(op=>op.id===ref.lastMessageOperationId);
        const latest=pinned?.status==='succeeded'?pinned:edits.filter(op=>op.status==='succeeded').sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
        // Add the language entry once to a retained closed card. Subsequent
        // live connection changes must not keep rewriting historical messages.
        if(historical&&(latest||delivery).snapshot?.discordLocaleVersion===1)continue;
        if(edits.some(op=>op.status==='failed'&&op.reasonCode==='SIGNUP_CONNECT_CHANGED'&&
          (op===pinned||!latest||String(op.updatedAt)>String(latest.updatedAt))&&currentPayload(op)))continue;
        if(currentPayload(latest||delivery))continue;
        // Preserve original message identity and let normal execution enforce current authority.
        this.repo.transaction(()=>this.queueMessageOperation(delivery,'edit',{messageRefId:ref.id,reasonCode:'SIGNUP_CONNECT_CHANGED'}));
      }
    }
  }
  validateInputAccess(actor,w,input,cap='preview') {
    const targets=input.targets.map(s=>this.targetSelection(actor,s,cap));
    this.audienceSnapshot(actor,w,input.audience);
    const template=this.templates.find(t=>t.id===input.templateId);
    need(template,'TEMPLATE_UNSUPPORTED',422); need(template.revision===input.templateRevision,'TEMPLATE_REVISION_UNSUPPORTED',422);
    need(template.purposes.includes(input.purpose),'TEMPLATE_UNSUPPORTED',422);
    need(input.targets.every(t=>template.languages.includes(t.language)),'LANGUAGE_UNSUPPORTED',422);
    return targets;
  }
  repeatAccess(actor,w,input) {
    if (!input.repeatOfIntentId) return;
    const parent=this.repo.get('intents',input.repeatOfIntentId);
    need(parent && parent.wipeId===w.id && parent.purpose===input.purpose && parent.purposeInstance!==input.purposeInstance,'NOTIFICATION_INPUT_INVALID',422);
    const selected=new Set(input.targets.map(t=>hash([t.targetId,t.language])));
    const ds=this.repo.forWipe('deliveries',w.id).filter(d=>d.intentId===parent.id && selected.has(hash([d.targetId,d.language])));
    for (const d of ds) this.requireVisibleDelivery(actor,d);
    if (ds.some(d=>d.status==='delivery_unknown')) need(input.duplicateRiskAcknowledged,'DUPLICATE_RISK_NOT_ACKNOWLEDGED');
  }
  makeReferences(w,target,previewId=null) {
    const actions=target.platform==='discord'?
      ['attending_on_time','attending_later','join_8h','join_16h','not_attending','copy_connect']:
      ['attending_on_time','attending_later','not_attending'];
    return actions.map(action=>{
      const token=randomBytes(32).toString('base64url'),id=newId('reference');
      this.repo.put('actionReferences',{id,tokenHash:tokenHash(token),previewId,intentId:null,deliveryId:null,wipeId:w.id,
        contentRevision:w.contentRevision,action,timeZone:w.timeZone,signupMode:target.platform==='discord'?(target.signupMode||'member_required'):null,directConnect:action==='copy_connect'?(w.serverSnapshot?.directConnect||w.serverSnapshot?.connectCommand||''):'',targetId:target.id,platform:target.platform,guildId:target.guildId,channelId:target.channelId,configurationRevision:target.configurationRevision,
        confirmed:false,expiresAt:null,createdAt:stamp(this.now)});
      return {id,action,token};
    });
  }
  render(actor,w,input,target,selection,mode,previewId=null) {
    const attendanceTarget=target.platform==='discord'&&input.purpose!=='signup_open'?{...target,signupMode:'member_required',signupConfigurationEnabled:false}:target;
    const snapshot=this.snapshot(actor,w,input.audience,{includeAttendance:target.platform==='discord',target:attendanceTarget}),refs=this.makeReferences(w,attendanceTarget,previewId);
    const rendered=this.renderer({schemaVersion:1,templateId:input.templateId,templateRevision:input.templateRevision,purpose:input.purpose,
      target:{...target,capabilities:this.targetDTO(actor,target).capabilities},selection,snapshot,actionRefs:refs.map(({action,token})=>({action,token})),mode});
    need(object(rendered) && object(rendered.payload) && rendered.payloadHash===hash(rendered.payload) && object(rendered.rendered) && Array.isArray(rendered.warnings),'NOTIFICATION_SETUP_REQUIRED',503);
    return {...rendered,snapshot,actionReferenceIds:refs.map(r=>r.id)};
  }
  previewDTO(actor,p) {
    return {...pick(p,['id','wipeId','revision','contentRevision','wipeRevision','rosterRevision','createdAt','expiresAt','contentHash','templateId','templateRevision','purpose','purposeInstance','repeatOfIntentId','audience','schedule']),
      targets:p.targets.map(t=>({target:this.targetDTO(actor,t.target),selection:t.selection,rendered:t.rendered,payloadHash:t.payloadHash,warnings:t.warnings}))};
  }
  operationKey(actor,operationId,action,resourceId,input) {
    need(typeof operationId==='string' && /^[A-Za-z0-9:_-]{1,200}$/.test(operationId),'IDEMPOTENCY_KEY_REQUIRED',422);
    const id=hash([actor.id,operationId]),digest=hash({action,resourceId,input}); const existing=this.repo.get('receipts',id);
    if (existing) need(existing.digest===digest,'IDEMPOTENCY_CONFLICT');
    return {id,digest,existing};
  }
  saveReceipt(actor,key,operationId,action,resourceType,resourceId,extra={}) {
    return this.repo.put('receipts',{id:key.id,digest:key.digest,actorAccountId:actor.id,operationId,
      operationReceipt:{operationId,committedAt:stamp(this.now),action,resourceType,resourceId},...extra});
  }
  result(receipt,current,replayed=false) { return {operationReceipt:receipt.operationReceipt,current,replayed}; }
  createPreview(actor,wipeId,raw,{operationId}={}) {
    return this.repo.transaction(()=>{
      actor=this.actor(actor); const w=this.wipe(actor,wipeId),input=this.normalizeInput(raw);
      for (const selection of input.targets) {
        this.requireTarget(actor,'preview',selection.targetId);
        if (selection.mentionMode==='roles') this.requireTarget(actor,'mention_role',selection.targetId);
        if (selection.mentionMode==='everyone') this.requireTarget(actor,'mention_everyone',selection.targetId);
      }
      this.audienceSnapshot(actor,w,input.audience);
      const key=this.operationKey(actor,operationId,'notification.preview',wipeId,input);
      if (key.existing) return this.result(key.existing,this.previewDTO(actor,this.repo.get('previews',key.existing.operationReceipt.resourceId)),true);
      const targets=this.validateInputAccess(actor,w,input);
      need(input.expectedContentRevision===w.contentRevision,'REVISION_CONFLICT',409,{current:{contentRevision:w.contentRevision}});
      need(this.allowedPurposes(w).includes(input.purpose),'NOTIFICATION_INPUT_INVALID',422);
      if (input.schedule) need(Date.parse(input.schedule.dueAt)>this.now(),'SCHEDULE_INVALID',422);
      this.repeatAccess(actor,w,input);
      const id=newId('preview'),createdAt=stamp(this.now),rendered=targets.map((target,i)=>{
        const selection=input.targets[i]; return {target,selection,...this.render(actor,w,input,target,selection,'send',id)};
      });
      const p={id,wipeId,revision:1,creatorAccountId:actor.id,contentRevision:w.contentRevision,wipeRevision:w.revision,
        rosterRevision:rendered[0].snapshot.rosterRevision,createdAt,expiresAt:new Date(this.now()+this.options.previewTtlMs).toISOString(),
        ...pick(input,['templateId','templateRevision','purpose','purposeInstance','repeatOfIntentId','audience','schedule']),input,
        publicOrigin:this.publicOrigin,targets:rendered,contentHash:hash({input,wipeRevision:w.revision,snapshots:rendered.map(t=>t.snapshot),targets:targets.map(t=>this.targetDTO(actor,t)),payloadHashes:rendered.map(t=>t.payloadHash),publicOrigin:this.publicOrigin})};
      this.repo.put('previews',p);
      const receipt=this.saveReceipt(actor,key,operationId,'notification.preview','preview',id,{wipeId});
      return this.result(receipt,this.previewDTO(actor,p));
    });
  }
  createIntent(actor,wipeId,input,{operationId}={}) {
    return this.repo.transaction(()=>{
      actor=this.actor(actor); const w=this.wipe(actor,wipeId);
      fields(input,['previewId','contentHash','expectedContentRevision','purpose','purposeInstance']);
      need(identifier(input.previewId) && typeof input.contentHash==='string' && Number.isSafeInteger(input.expectedContentRevision) && purposes.includes(input.purpose) && identifier(input.purposeInstance),'NOTIFICATION_INPUT_INVALID',422);
      const p=this.repo.get('previews',input.previewId);
      need(p && p.wipeId===wipeId && p.creatorAccountId===actor.id,'RESOURCE_NOT_FOUND',404);
      // Authorization precedes replay; version/expiry follows it so an accepted operation survives response loss.
      for (const t of p.targets) this.requireTarget(actor,'send',t.target.id);
      const key=this.operationKey(actor,operationId,'notification.publish',wipeId,input);
      if (key.existing) {
        this.audienceSnapshot(actor,w,p.audience);
        return this.result(key.existing,this.getIntent(actor,key.existing.operationReceipt.resourceId).intent,true);
      }
      need(Date.parse(p.expiresAt)>this.now(),'PREVIEW_EXPIRED',410);
      need(p.contentHash===input.contentHash && p.contentRevision===input.expectedContentRevision && p.purpose===input.purpose && p.purposeInstance===input.purposeInstance,'PREVIEW_STALE');
      need(w.contentRevision===p.contentRevision && w.revision===p.wipeRevision && p.publicOrigin===this.publicOrigin,'PREVIEW_STALE');
      const targets=this.validateInputAccess(actor,w,p.input,'send');
      need(targets.every((t,i)=>hash(t)===hash(p.targets[i].target)),'PREVIEW_STALE');
      need(this.allowedPurposes(w).includes(p.purpose),'PREVIEW_STALE');
      if (p.schedule) need(Date.parse(p.schedule.dueAt)>this.now(),'SCHEDULE_INVALID',422);
      this.repeatAccess(actor,w,p.input);
      const businessKey=hash({wipeId,contentRevision:p.contentRevision,...p.input});
      const existing=this.repo.all('intents').find(i=>i.businessKey===businessKey);
      if (existing) {
        const receipt=this.saveReceipt(actor,key,operationId,'notification.publish','intent',existing.id,{wipeId});
        return this.result(receipt,this.getIntent(actor,existing.id).intent,true);
      }
      const id=newId('intent'),createdAt=stamp(this.now);
      const intent={id,wipeId,revision:1,contentRevision:p.contentRevision,wipeRevision:p.wipeRevision,rosterRevision:p.rosterRevision,
        purpose:p.purpose,purposeInstance:p.purposeInstance,repeatOfIntentId:p.repeatOfIntentId,createdAt,createdByAccountId:actor.id,
        schedule:p.schedule,input:p.input,businessKey,targetIds:p.targets.map(t=>t.target.id),previewId:p.id};
      this.repo.put('intents',intent);
      for (const t of p.targets) {
        const d={id:newId('delivery'),intentId:id,wipeId,targetId:t.target.id,targetLabel:t.target.label,platform:t.target.platform,language:t.selection.language,
          revision:1,status:'queued',attemptCount:0,executionEpoch:0,nextAttemptAt:null,dueAt:p.schedule?.dueAt||null,expiresAt:p.schedule?.expiresAt||null,
          lastErrorCode:null,lastErrorMessage:null,createdAt,updatedAt:createdAt,sentAt:null,cancelRequested:false,
          createdByAccountId:actor.id,previewId:p.id,target:t.target,selection:t.selection,payload:t.payload,payloadHash:t.payloadHash,snapshot:t.snapshot,
          audience:p.audience,actionReferenceIds:t.actionReferenceIds,knownNotSent:true,leaseOwner:null,leaseUntil:null,currentAttemptId:null};
        this.repo.put('deliveries',d);
        for (const refId of d.actionReferenceIds) { const r=this.repo.get('actionReferences',refId); this.repo.put('actionReferences',{...r,intentId:id,deliveryId:d.id}); }
        this.repo.appendChange({wipeId,intentId:id,deliveryId:d.id,targetId:d.targetId,type:'delivery.queued',createdAt});
      }
      const receipt=this.saveReceipt(actor,key,operationId,'notification.publish','intent',id,{wipeId});
      return this.result(receipt,this.getIntent(actor,id).intent);
    });
  }
  isVisibleDelivery(actor,d) {
    if (d?.resource !== undefined) return businessVisible(this, actor, d);
    return can(actor,'wipes.read',{kind:'wipe',id:d.wipeId},this.identity.relations()) && ['preview','send','reconcile'].some(cap=>this.permitted(actor,cap,d.targetId));
  }
  requireVisibleDelivery(actor,d) { need(d && this.isVisibleDelivery(actor,d),'RESOURCE_NOT_FOUND',404); }
  deliveryDTO(actor,d) {
    this.requireVisibleDelivery(actor,d);
    const send=this.deliveryPermitted(actor,'send',d),reconcile=this.deliveryPermitted(actor,'reconcile',d);
    return {...pick(d,deliveryKeys),...resourceFields(d),lastErrorCode:d.lastErrorCode?safeCode(d.lastErrorCode):null,
      lastErrorMessage:d.lastErrorCode?safeCode(d.lastErrorCode):null,
      messageRefs:this.repo.all('messageRefs').filter(r=>r.deliveryId===d.id).map(r=>pick(r,refKeys)),
      actions:{retry:send && ['failed','retry_wait'].includes(d.status) && d.knownNotSent===true,
        cancel:send && ['queued','retry_wait','sending'].includes(d.status),lookup:reconcile && d.status==='delivery_unknown',
        reconcile:reconcile && d.status==='delivery_unknown',repeat:resourceKind(d)==='wipe' && send && ['sent','failed','delivery_unknown','cancelled'].includes(d.status)}};
  }
  intentDTO(actor,i) {
    const ds=this.resourceRows('deliveries',i).filter(d=>d.intentId===i.id && this.isVisibleDelivery(actor,d));
    need(ds.length,'RESOURCE_NOT_FOUND',404);
    const counts={total:ds.length,...Object.fromEntries(statuses.map(s=>[s,ds.filter(d=>d.status===s).length]))};
    let status='queued';
    if (counts.delivery_unknown) status='needs_attention';
    else if (counts.sending) status='running';
    else if (counts.sent===counts.total) status='completed';
    else if (counts.cancelled===counts.total) status='cancelled';
    else if (counts.failed===counts.total) status='failed';
    else if (counts.failed || counts.cancelled && counts.sent) status='partial_failure';
    else if (counts.sent || counts.retry_wait) status='running';
    return {...pick(i,['id','wipeId','revision','contentRevision','purpose','purposeInstance','repeatOfIntentId','createdAt','createdByAccountId','schedule']),...resourceFields(i),status,counts,countScope:'authorized_targets',deliveryIds:ds.map(d=>d.id)};
  }
  listIntents(actor,wipeId,query={}) {
    actor=this.actor(actor); this.wipe(actor,wipeId);
    const rows=this.repo.forWipe('intents',wipeId).filter(i=>this.repo.forWipe('deliveries',wipeId).some(d=>d.intentId===i.id && this.isVisibleDelivery(actor,d)))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    const result=page(rows,query); return {...result,items:result.items.map(i=>this.intentDTO(actor,i))};
  }
  listReviewIntents(actor,applicationId,query={}) {
    actor=this.actor(actor); need(identifier(applicationId),'NOTIFICATION_INPUT_INVALID',422);
    const resource={kind:'memberReview',id:applicationId};
    domainFor(this,{resource,wipeId:null});
    const deliveries=this.repo.forResource('deliveries',resource).filter(d=>this.isVisibleDelivery(actor,d));
    const rows=this.repo.forResource('intents',resource).filter(i=>deliveries.some(d=>d.intentId===i.id))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    const result=page(rows,query); return {...result,items:result.items.map(i=>this.intentDTO(actor,i))};
  }
  getIntent(actor,id,query={}) {
    actor=this.actor(actor); const i=this.repo.get('intents',id); need(i,'RESOURCE_NOT_FOUND',404);
    if (resourceKind(i)==='wipe') this.wipe(actor,i.wipeId); else domainFor(this,i);
    const intent=this.intentDTO(actor,i),ds=this.resourceRows('deliveries',i).filter(d=>d.intentId===id && this.isVisibleDelivery(actor,d));
    const result=page(ds,query); return {intent,deliveries:result.items.map(d=>this.deliveryDTO(actor,d)),nextCursor:result.nextCursor};
  }
  getDelivery(actor,id) {
    actor=this.actor(actor); const d=this.repo.get('deliveries',id); this.requireVisibleDelivery(actor,d); this.requireResource(actor,d);
    const messageOperations=this.resourceRows('messageOperations',d).filter(o=>o.deliveryId===d.id)
      .sort((a,b)=>Number(b.kind==='edit'&&b.status==='unknown')-Number(a.kind==='edit'&&a.status==='unknown')||b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,20)
      .map(o=>editOperationDTO(this,actor,o));
    return {delivery:this.deliveryDTO(actor,d),messageOperations};
  }
  getOptions(actor,wipeId) {
    actor=this.actor(actor); const w=this.wipe(actor,wipeId);
    return {targets:this.catalog.listTargets().filter(t=>t.enabled===true && this.permitted(actor,'preview',t.id)).map(t=>this.targetDTO(actor,this.target(t.id))),
      templates:this.templates.map(t=>pick(t,['id','revision','label','languages','purposes'])),allowedPurposes:this.allowedPurposes(w)};
  }
  listAdminWipes(actor,query={}) {
    actor=this.actor(actor); const order=['draft','scheduled','active','ended','cancelled','archived'];
    const rows=this.scheduling.repo.all('wipes').filter(w=>(!query.lifecycle || w.lifecycle===query.lifecycle) && can(actor,'wipes.read',{kind:'wipe',id:w.id},this.identity.relations()))
      .sort((a,b)=>order.indexOf(a.lifecycle)-order.indexOf(b.lifecycle)||(a.musterAt||'9999').localeCompare(b.musterAt||'9999')||a.id.localeCompare(b.id));
    const result=page(rows,query);
    return {...result,countScope:'authorized_wipes',items:result.items.map(w=>{
      const ds=this.repo.forWipe('deliveries',w.id).filter(d=>this.isVisibleDelivery(actor,d));
      return {wipe:this.scheduling.getWipe(actor,w.id),notificationCounts:{total:ds.length,...Object.fromEntries(statuses.map(s=>[s,ds.filter(d=>d.status===s).length])),countScope:'authorized_targets'}};
    })};
  }
  listWipeOptions(actor,query={}) {
    actor=this.actor(actor); need(['servers','squads','members'].includes(query.kind),'NOTIFICATION_INPUT_INVALID',422);
    const limit=Math.max(1,Math.min(50,Number(query.limit)||20));
    // Catalog cursors are private. Gather bounded pages, then filter before constructing a public cursor.
    const rows=[],seen=new Set(); let cursor=null;
    do {
      const result=this.catalog.listOptions(query.kind,{q:String(query.q||'').slice(0,200),limit:50,cursor,actor,identity:this.identity});
      need(object(result) && Array.isArray(result.items),'NOTIFICATION_SETUP_REQUIRED',503);
      rows.push(...result.items);cursor=result.nextCursor||null;
      need(rows.length<=10000 && (!cursor || !seen.has(cursor)),'NOTIFICATION_SETUP_REQUIRED',503);
      if (cursor) seen.add(cursor);
    } while (cursor);
    const visible=rows.filter(row=>query.kind==='servers' || can(actor,query.kind==='members'?'members.read':'squads.read',
      {kind:query.kind==='members'?'member':'squad',id:row.id},this.identity.relations()));
    const result=page(visible,{...query,limit});
    return {...result,items:result.items.map(row=>pick(row,query.kind==='servers'?['id','label','serverSnapshot','serverScheduleSource']:
      query.kind==='members'?['id','label','squadIds']:['id','label']))};
  }
  changed(delivery,type) {
    delivery.revision++; delivery.updatedAt=stamp(this.now); this.repo.put('deliveries',delivery);
    const intent=this.repo.get('intents',delivery.intentId);
    if (intent) this.repo.put('intents',{...intent,revision:intent.revision+1});
    this.repo.appendChange({wipeId:delivery.wipeId,...resourceFields(delivery),intentId:delivery.intentId,deliveryId:delivery.id,targetId:delivery.targetId,type,createdAt:delivery.updatedAt});
    return delivery;
  }
  checkRevision(actor,d,input) { need(input.expectedRevision===d.revision,'REVISION_CONFLICT',409,{current:this.deliveryDTO(actor,d)}); }
  requeue(d) {
    need(['failed','retry_wait'].includes(d.status) && d.knownNotSent===true,'DELIVERY_NOT_RETRYABLE');
    // Explicit retry continues the same delivery; total attempt history is never reset.
    d.status='queued';d.nextAttemptAt=null;d.leaseOwner=null;d.leaseUntil=null;d.cancelRequested=false;d.lastErrorCode=null;d.lastErrorMessage=null;
    this.changed(d,'delivery.retry_requested');
  }
  retryFailed(actor,id,input,{operationId}={}) {
    return this.repo.transaction(()=>{
      actor=this.actor(actor); fields(input,['expectedRevision','reason']);reason(input.reason);
      const current=this.getIntent(actor,id).intent,i=this.repo.get('intents',id);
      const ds=this.resourceRows('deliveries',i).filter(d=>d.intentId===id && this.isVisibleDelivery(actor,d));
      const key=this.operationKey(actor,operationId,'notification.retry_failed',id,input);
      for (const d of ds) this.requireDeliveryCapability(actor,'send',d);
      if (key.existing) return this.receiptResult(actor,key.existing);
      need(input.expectedRevision===i.revision,'REVISION_CONFLICT',409,{current});
      const queuedIds=[],skippedIds=[];
      for (const d of ds) {
        if (['failed','retry_wait'].includes(d.status) && d.knownNotSent===true) {
          this.executionContext(d,{mode:'send',actorAccountId:actor.id}); this.requeue(d);queuedIds.push(d.id);
        } else skippedIds.push(d.id);
      }
      const receipt=this.saveReceipt(actor,key,operationId,'notification.retry_failed','retryBatch',id,{wipeId:i.wipeId,...resourceFields(i),queuedIds,skippedIds,reason:input.reason});
      return this.result(receipt,{intent:this.getIntent(actor,id).intent,queuedIds,skippedIds});
    });
  }
  commandDelivery(actor,id,command,input,{operationId}={}) {
    return this.repo.transaction(()=>{
      actor=this.actor(actor); need(['retry','cancel','reconcile'].includes(command),'NOTIFICATION_INPUT_INVALID',422);
      fields(input,command==='reconcile'?['expectedRevision','decision','reason','evidence','messageRef']:['expectedRevision','reason']);reason(input.reason);
      const d=this.repo.get('deliveries',id);this.requireVisibleDelivery(actor,d);this.requireResource(actor,d);
      this.requireDeliveryCapability(actor,command==='reconcile'?'reconcile':'send',d);
      const key=this.operationKey(actor,operationId,`notification.${command}`,id,input);
      if (key.existing) return this.receiptResult(actor,key.existing);
      this.checkRevision(actor,d,input);
      if (command==='retry') { this.executionContext(d,{mode:'send',actorAccountId:actor.id}); this.requeue(d); }
      if (command==='cancel') {
        need(['queued','retry_wait','sending'].includes(d.status),'DELIVERY_NOT_CANCELLABLE');
        d.cancelRequested=true;
        if (d.status!=='sending') {d.status='cancelled';d.nextAttemptAt=null;d.lastErrorCode='CANCELLED_BY_OPERATOR';}
        this.changed(d,'delivery.cancel_requested');
      }
      if (command==='reconcile') {
        need(d.status==='delivery_unknown','DELIVERY_NOT_UNKNOWN');
        need(['request_lookup','confirmed_sent','confirmed_not_sent'].includes(input.decision),'NOTIFICATION_INPUT_INVALID',422);
        this.executionContext(d,{mode:'lookup',actorAccountId:actor.id});
        if (input.decision==='request_lookup') {
          this.queueMessageOperation(d,'lookup',{actorAccountId:actor.id,reasonCode:'MANUAL_LOOKUP',messageRefId:null,deliveryEpoch:d.executionEpoch});
          this.changed(d,'delivery.lookup_requested');
        } else {
          need(typeof input.evidence==='string' && input.evidence.trim().length>0 && input.evidence.length<=4000,'REASON_REQUIRED',422);
          if (input.decision==='confirmed_sent') {
            need(input.messageRef,'DELIVERY_REFERENCE_REQUIRED');
            this.recordMessageRef(d,this.validateMessageRef(input.messageRef,this.executionContext(d,{mode:'lookup',actorAccountId:actor.id}).target),d.snapshot.contentRevision);
            d.status='sent';d.sentAt=stamp(this.now);d.knownNotSent=false;d.lastErrorCode=null;
          } else { d.status='failed';d.knownNotSent=true;d.lastErrorCode='NOT_SENT_CONFIRMED'; }
          d.executionEpoch++;d.currentAttemptId=null;d.leaseOwner=null;d.leaseUntil=null;d.nextAttemptAt=null;
          for (const op of this.resourceRows('messageOperations',d).filter(o=>o.deliveryId===id && o.kind==='lookup' && ['queued','running'].includes(o.status)))
            this.repo.put('messageOperations',{...op,status:'skipped',reasonCode:'MANUAL_RECONCILIATION',updatedAt:stamp(this.now)});
          this.changed(d,'delivery.reconciled');
          if (d.status==='sent') for (const ref of this.repo.all('messageRefs').filter(r=>r.deliveryId===d.id && r.state!=='deleted'))
            this.queueMessageOperation(d,'edit',{messageRefId:ref.id,reasonCode:'MANUAL_SENT_CONFIRMED'});
        }
      }
      const receipt=this.saveReceipt(actor,key,operationId,`notification.${command}`,'delivery',id,{wipeId:d.wipeId,...resourceFields(d),reason:input.reason,
        decision:input.decision||null,evidence:input.evidence||null});
      return this.result(receipt,this.deliveryDTO(actor,d));
    });
  }
  reconcileEditOperation(actor,id,input,options){return reconcileEdit(this,actor,id,input,options);}
  receiptResult(actor,r) {
    const {resourceType,resourceId,action}=r.operationReceipt;
    let current;
    if(resourceType==='messageOperation'){const context=editRecoveryContext(this,actor,resourceId);return this.result(r,editOperationDTO(this,context.actor,context.op),true);}
    if (resourceType==='preview') {
      const p=this.repo.get('previews',resourceId); need(p && p.creatorAccountId===actor.id,'RESOURCE_NOT_FOUND',404);
      const w=this.wipe(actor,p.wipeId); for (const t of p.targets) this.requireTarget(actor,'preview',t.target.id);
      this.audienceSnapshot(actor,w,p.audience);current=this.previewDTO(actor,p);
    } else if (resourceType==='intent' || resourceType==='retryBatch') {
      const intent=this.getIntent(actor,resourceId).intent;
      for (const id of intent.deliveryIds) this.requireDeliveryCapability(actor,'send',this.repo.get('deliveries',id));
      current=resourceType==='intent'?intent:{intent,queuedIds:r.queuedIds.filter(id=>intent.deliveryIds.includes(id)),skippedIds:r.skippedIds.filter(id=>intent.deliveryIds.includes(id))};
    } else {
      const d=this.repo.get('deliveries',resourceId);this.requireVisibleDelivery(actor,d);
      this.requireDeliveryCapability(actor,['notification.reconcile','notification.edit_reconcile'].includes(action)?'reconcile':'send',d); current=this.getDelivery(actor,resourceId).delivery;
    }
    return this.result(r,current,true);
  }
  getOperation(actor,operationId) {
    actor=this.actor(actor);const r=this.repo.get('receipts',hash([actor.id,operationId]));need(r,'RESOURCE_NOT_FOUND',404);
    return this.receiptResult(actor,r);
  }
  executionContext(delivery,{mode='send',actorAccountId=delivery.createdByAccountId}={}) {
    if (resourceKind(delivery)!=='wipe') return domainFor(this,delivery).executionContext(delivery,{mode,actorAccountId});
    const actor=this.identity.actorForAccount(actorAccountId),wipe=this.wipe(actor,delivery.wipeId);
    const target=this.target(delivery.targetId);
    this.requireTarget(actor,mode==='lookup'?'reconcile':'send',target.id);
    need(target.enabled===true,'TARGET_INVALID',422);
    need(target.platform===delivery.target.platform && target.guildId===delivery.target.guildId && target.channelId===delivery.target.channelId,'PREVIEW_STALE');
    this.audienceSnapshot(actor,wipe,delivery.audience);
    if (mode==='send') {
      if (delivery.expiresAt) need(Date.parse(delivery.expiresAt)>this.now(),'REMINDER_EXPIRED');
      const intent=this.repo.get('intents',delivery.intentId);
      need(intent && wipe.revision===intent.wipeRevision && wipe.contentRevision===intent.contentRevision && target.configurationRevision===delivery.target.configurationRevision,'PREVIEW_STALE');
      need(this.allowedPurposes(wipe).includes(intent.purpose),'PREVIEW_STALE');
      this.targetSelection(actor,delivery.selection,'send');
    }
    return {actor,wipe,target};
  }
  renderEdit(delivery) {
    if (resourceKind(delivery)!=='wipe') return domainFor(this,delivery).renderEdit(delivery);
    const {actor,wipe,target}=this.executionContext(delivery,{mode:'edit'}),intent=this.repo.get('intents',delivery.intentId);
    const selection={...delivery.selection,mentionMode:'none',roleIds:[]};
    need(target.languages.includes(selection.language),'LANGUAGE_UNSUPPORTED',422);
    const result=this.render(actor,wipe,intent.input,target,selection,'edit');
    for (const id of result.actionReferenceIds) {
      const r=this.repo.get('actionReferences',id);this.repo.put('actionReferences',{...r,deliveryId:delivery.id,intentId:delivery.intentId});
    }
    return result;
  }
  validateMessageRef(ref,target) {
    if (target?.platform==='inbox') {
      return domainFor(this,{resource:{kind:'memberReview',id:target.applicationId},wipeId:null}).validateInboxReference(ref,target);
    }
    need(object(ref) && ref.platform===target.platform && ref.guildId===target.guildId && ref.channelId===target.channelId && identifier(ref.messageId),'DELIVERY_REFERENCE_REQUIRED');
    let messageUrl=null;
    if (ref.messageUrl!==null && ref.messageUrl!==undefined) {
      try {
        const url=new URL(ref.messageUrl),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const allowed=target.platform==='discord'?['discord.com','canary.discord.com','ptb.discord.com']:['kookapp.cn','www.kookapp.cn','kook.top','www.kook.top'];
        need(url.protocol==='https:' && !url.username && !url.password && !url.port && allowed.includes(url.hostname) && !url.search && !url.hash,'DELIVERY_REFERENCE_REQUIRED');
        need(target.platform==='discord'?parts.join('/')===['channels',target.guildId,target.channelId,ref.messageId].join('/'):
          parts.includes(target.guildId) && parts.includes(target.channelId) && parts.includes(ref.messageId),'DELIVERY_REFERENCE_REQUIRED');
        messageUrl=url.href;
      } catch { throw new IdentityError('DELIVERY_REFERENCE_REQUIRED',409); }
    }
    return {platform:ref.platform,guildId:ref.guildId,channelId:ref.channelId,messageId:ref.messageId,messageUrl};
  }
  recordMessageRef(delivery,raw,contentRevision) {
    const ref=this.validateMessageRef(raw,delivery.target);
    if (delivery.target.platform==='inbox') domainFor(this,delivery).validateInboxReference(ref,delivery.target,delivery.id);
    const existing=this.repo.all('messageRefs').find(r=>r.deliveryId===delivery.id && ['platform','guildId','channelId','messageId'].every(k=>r[k]===ref[k]));
    const row={...existing,...ref,...resourceFields(delivery),id:existing?.id||newId('message'),deliveryId:delivery.id,wipeId:delivery.wipeId,intentId:delivery.intentId,
      targetId:delivery.targetId,contentRevision:Math.max(contentRevision,existing?.contentRevision||0),state:'active',updatedAt:stamp(this.now)};
    this.repo.put('messageRefs',row);
    for (const id of delivery.actionReferenceIds||[]) {
      const r=this.repo.get('actionReferences',id);
      if (r?.intentId===delivery.intentId && r.deliveryId===delivery.id) this.repo.put('actionReferences',{...r,confirmed:true,messageRefId:row.id,confirmedAt:stamp(this.now)});
    }
    return row;
  }
  queueMessageOperation(delivery,kind,extra={}) {
    need(['edit','delete','lookup'].includes(kind),'NOTIFICATION_INPUT_INVALID',422);
    const blocked=kind==='edit'&&this.resourceRows('messageOperations',delivery).find(o=>o.kind==='edit'&&o.messageRefId===(extra.messageRefId||null)&&o.status==='unknown');if(blocked)return blocked;
    const existing=this.resourceRows('messageOperations',delivery).find(o=>o.deliveryId===delivery.id && o.kind===kind && o.messageRefId===(extra.messageRefId||null) && o.status==='queued');
    const row={id:existing?.id||newId('messageop'),...resourceFields(delivery),deliveryId:delivery.id,wipeId:delivery.wipeId,intentId:delivery.intentId,targetId:delivery.targetId,
      actorAccountId:delivery.createdByAccountId,kind,status:'queued',reasonCode:'REFRESH_REQUESTED',messageRefId:null,
      payload:null,payloadHash:null,snapshot:null,actionReferenceIds:[],executionEpoch:existing?.executionEpoch||0,leaseOwner:null,leaseUntil:null,
      attemptCount:existing?.attemptCount||0,currentAttemptId:null,nextAttemptAt:null,createdAt:existing?.createdAt||stamp(this.now),updatedAt:stamp(this.now),...extra};
    this.repo.put('messageOperations',row);
    this.repo.appendChange({wipeId:delivery.wipeId,...resourceFields(delivery),intentId:delivery.intentId,deliveryId:delivery.id,targetId:delivery.targetId,type:`message.${kind}_queued`,createdAt:row.updatedAt});
    return row;
  }
  resolveReference(token,{platform,guildId,channelId}={}) {
    need(typeof token==='string' && /^[A-Za-z0-9_-]{43}$/.test(token) && ['discord','kook'].includes(platform) && identifier(channelId) &&
      (identifier(guildId) || platform==='kook' && guildId===null),'RESOURCE_NOT_FOUND',404);
    const r=this.repo.all('actionReferences').find(r=>r.tokenHash===tokenHash(token));
    need(r?.confirmed && r.intentId && r.deliveryId && r.platform===platform && r.channelId===channelId && (guildId===null && platform==='kook' || r.guildId===guildId) &&
      (!r.expiresAt || Date.parse(r.expiresAt)>this.now()),'RESOURCE_NOT_FOUND',404);
    const intent=this.repo.get('intents',r.intentId),delivery=this.repo.get('deliveries',r.deliveryId),ref=this.repo.get('messageRefs',r.messageRefId);
    need(intent && resourceKind(intent)==='wipe' && delivery?.intentId===intent.id && resourceKind(delivery)==='wipe' && intent.wipeId===r.wipeId && delivery.targetId===r.targetId && ref && ref.state!=='deleted','RESOURCE_NOT_FOUND',404);
    let target;
    try {target=this.target(r.targetId);} catch {throw new IdentityError('RESOURCE_NOT_FOUND',404);}
    need(target.enabled && target.platform===r.platform && target.guildId===r.guildId && target.channelId===r.channelId && target.configurationRevision===r.configurationRevision,'RESOURCE_NOT_FOUND',404);
    need(platform!=='discord'||intent.purpose!=='signup_open'||(r.signupMode||'member_required')===(target.signupMode||'member_required'),'RESOURCE_NOT_FOUND',404);
    const resolved={...pick(r,['wipeId','contentRevision','action','timeZone','directConnect','targetId','expiresAt']),signupMode:r.signupMode||'member_required'};
    if(platform==='discord'&&r.action==='copy_connect'){
      const wipe=this.scheduling.repo.get('wipes',r.wipeId);
      const command=wipe?.serverSnapshot?.directConnect||wipe?.serverSnapshot?.connectCommand||'';
      const cached=this.signupConnectIps?.get(command);
      const applied=ref.lastMessageOperationId?this.repo.get('messageOperations',ref.lastMessageOperationId):null;
      // Cold starts can use the exact original card's applied IP. Never resolve
      // DNS in callback preflight or mix another server's IP with this command.
      const snapshot=ref.lastMessageOperationId
        ? applied?.kind==='edit'&&applied.status==='succeeded'&&applied.deliveryId===delivery.id&&applied.messageRefId===ref.id?applied.snapshot:null
        : delivery.snapshot;
      const ip=cached&&cached.expiresAt>this.now()?cached.ip:snapshot?.directConnect===command?snapshot.directConnectIp:null;
      return {...resolved,directConnect:command,directConnectIp:typeof ip==='string'&&isIP(ip)===4?ip:null};
    }
    return resolved;
  }
  localizedDiscordView(proof) {
    assertCardViewProof(proof);
    need(proof.payload.cardKind==='signup','RESOURCE_NOT_FOUND',404);
    const token=proof.payload.reference;
    this.resolveReference(token,{platform:'discord',guildId:proof.guildId,channelId:proof.channelId});
    const reference=this.repo.all('actionReferences').find(row=>row.tokenHash===tokenHash(token));
    const ref=this.repo.get('messageRefs',reference.messageRefId),delivery=this.repo.get('deliveries',reference.deliveryId);
    need(ref?.state==='active'&&ref.messageId===proof.originMessageId&&ref.deliveryId===delivery?.id&&delivery.status==='sent', 'RESOURCE_NOT_FOUND',404);
    const {actor,wipe,target}=this.executionContext(delivery,{mode:'edit'}),intent=this.repo.get('intents',delivery.intentId);
    const applied=ref.lastMessageOperationId?this.repo.get('messageOperations',ref.lastMessageOperationId):null;
    const original=ref.lastMessageOperationId?applied?.kind==='edit'&&applied.status==='succeeded'&&applied.deliveryId===delivery.id&&applied.messageRefId===ref.id?applied.payload:null:delivery.payload;
    need(original,'RESOURCE_NOT_FOUND',404);
    const references=this.repo.all('actionReferences').filter(row=>row.confirmed&&row.deliveryId===delivery.id&&row.messageRefId===ref.id&&row.configurationRevision===target.configurationRevision);
    const actionRefs=(original.components||[]).flatMap(row=>row.components||[]).flatMap(button=>{
      if(!/^[A-Za-z0-9_-]{43}$/.test(button.custom_id||''))return [];
      const row=references.find(r=>r.tokenHash===tokenHash(button.custom_id));
      return row?[{action:row.action,token:button.custom_id}]:[];
    });
    const attendanceTarget=intent.purpose==='signup_open'?target:{...target,signupMode:'member_required',signupConfigurationEnabled:false};
    const snapshot=this.snapshot(actor,wipe,intent.input.audience,{includeAttendance:true,target:attendanceTarget});
    const copyRef=actionRefs.find(row=>row.action==='copy_connect');
    if(copyRef){const connect=this.resolveReference(copyRef.token,{platform:'discord',guildId:proof.guildId,channelId:proof.channelId});snapshot.directConnectIp=connect.directConnectIp;}
    const rendered=this.renderer({schemaVersion:1,templateId:intent.input.templateId,templateRevision:intent.input.templateRevision,purpose:intent.purpose,
      target:{...target,capabilities:this.targetDTO(actor,target).capabilities},selection:{...delivery.selection,language:discordInteractionLanguage(proof.locale),mentionMode:'none',roleIds:[]},
      snapshot,actionRefs,mode:'edit',omitLanguageButton:true});
    return rendered.payload;
  }
}
