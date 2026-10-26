import {hash,need,validateCollection,readNativeCredentials} from './model.js';
import {readCanonicalDiscord} from './discord.js';
export {validateCollection} from './model.js';
const date=value=>Number.isFinite(Date.parse(value||''))?Date.parse(value):0;
/** Stateless projection of original owners. No schema, cache, worker, env or external I/O. */
export function createCanonicalSourcePolicy({identity,getSystem,readControl,sourceBindings={}}){
  need(identity?.repo?.db&&typeof getSystem==='function'&&typeof readControl==='function','CANONICAL_SOURCE_HOST_REQUIRED');
  const admittedCapabilities={...sourceBindings.capabilities};
  const control=()=>{const c=readControl();need(!c?.then,'CANONICAL_CONTROL_SYNC_REQUIRED');validateCollection(c);return c||{enabled:false};};
  const system=()=>{const s=getSystem();need(s?.identity===identity&&s.sources?.store?.readSourceConfig&&s.sourceHost,'CANONICAL_SOURCE_OWNER_MISMATCH');return s;};
  const settings=()=>identity.repo.scalar('settings')||{};
  const credentials=()=>readNativeCredentials(sourceBindings.readCredentials);
  function readPrincipal(){
    const pin=control().principal;need(pin,'CANONICAL_PRINCIPAL_REQUIRED');const actor=identity.actorForAccount(pin.accountId);
    need(actor.id===pin.accountId&&actor.status==='active'&&!actor.restricted&&actor.permissionVersion===pin.permissionVersion,'CANONICAL_PRINCIPAL_REVOKED',403);
    return {accountId:pin.accountId,permissionVersion:pin.permissionVersion};
  }
  function discord(){const c=control();return readCanonicalDiscord(identity,system().platforms.service,c.discord,
    {enabled:admittedCapabilities.discordMembershipAudit===true&&sourceBindings.capabilities?.discordMembershipAudit===true,credentialReaderBound:typeof sourceBindings.readCredentials==='function'});}
  function readDiscordSettings(){return discord().settings;}
  function readSourceConfig(args){return system().sources.store.readSourceConfig(args);}
  function readFollowupSourceConfig(args){
    const config=readSourceConfig(args),scope=args.scope||{};
    if(args.type!=='battlemetrics_playtime'||Object.hasOwn(scope,'sourceWindowId')||config?.enabled===true)return config;
    // Admission is prospective; only the existing SourceWindow may choose/persist a cutoff.
    const owner=system(),wipe=identity.repo.get('schedulingWipes',scope.wipeId||(scope.kind==='current_wipe'?scope.id:null));
    const identityConfig=readSourceConfig({...args,type:'battlemetrics_identity'});
    const capturable=owner.service.authority===owner.sources.authority&&typeof owner.sources.authority.captureScope==='function'&&
      config?.sourceId==='battlemetrics'&&identityConfig?.enabled===true&&config.serverId===wipe?.serverProfileId&&
      wipe?.lifecycle==='active'&&!config.to&&date(wipe.serverActualWipeAt||wipe.actualStartedAt)>0&&/^\d{1,30}$/.test(config.battlemetricsServerId)&&
      date(config.from)>0&&date(config.from)<=identity.now()&&!scope.sourceWindowIntentId;
    return capturable?{...config,enabled:true,admission:'original_window_capture_required'}:config;
  }
  function selectedWipe(kind){
    const wipes=identity.repo.all('schedulingWipes');need(wipes.length<=10000,'CANONICAL_WIPE_LIMIT');
    const active=wipes.filter(w=>w.lifecycle==='active');
    // V2 supports multiple servers. Never silently select a first arbitrary active wipe.
    if(active.length>1)return {wipe:null,reason:'CURRENT_WIPE_AMBIGUOUS'};
    const started=w=>{const at=date(w?.serverActualWipeAt||w?.actualStartedAt)||(w?.lifecycle!=='active'&&date(w?.endedAt));return w&&['active','ended','archived'].includes(w.lifecycle)&&at>0&&at<=identity.now();};
    const server=w=>String(w?.serverSnapshot?.battlemetricsId||w?.serverSnapshot?.battlemetricsServerId||'');
    if(active.length&&started(active[0])&&(kind!=='battlemetrics'||/^\d{1,30}$/.test(server(active[0]))))return {wipe:active[0],reason:null};
    const closed=wipes.filter(w=>['ended','archived'].includes(w.lifecycle)&&started(w)&&(kind!=='battlemetrics'||/^\d{1,30}$/.test(server(w))))
      .sort((a,b)=>date(b.endedAt)-date(a.endedAt)||a.id.localeCompare(b.id));
    if(closed.length>1&&date(closed[0].endedAt)===date(closed[1].endedAt))return {wipe:null,reason:'CURRENT_WIPE_AMBIGUOUS'};
    const same=active[0]&&kind==='battlemetrics'?closed.filter(w=>w.serverProfileId===active[0].serverProfileId):[];
    if(same.length>1&&date(same[0].endedAt)===date(same[1].endedAt))return {wipe:null,reason:'CURRENT_WIPE_AMBIGUOUS'};
    return same[0]||closed[0]?{wipe:same[0]||closed[0],reason:null}:{wipe:null,reason:active.length?'WIPE_NOT_STARTED':'WIPE_NOT_CONFIGURED'};
  }
  function readPolicy(){
    const c=control(),s=settings(),native=credentials(),live={...sourceBindings.capabilities};
    const runtime=system(),caps=admittedCapabilities;
    const equivalent=hash(caps)===hash(live),global=c.enabled===true&&equivalent;
    const sourceState=id=>runtime.service.repo.get('source',id)||{};
    const base=type=>readSourceConfig({type,scope:{kind:'members',memberIds:[]}});
    const steam=base('steam_profile_backfill'),bm=base('battlemetrics_identity');
    const configured={steam:steam.enabled===true,battlemetrics:bm.enabled===true};
    const common={version:1,control:{enabled:c.enabled,principal:c.principal||null,discord:c.discord||null},capabilities:live,
      credentialFingerprint:hash(native),sourceSettingsFingerprint:hash({steamWebApi:s.steamWebApi,battlemetrics:s.battlemetrics,proxy:s.system?.proxy}),
      riskRulesFingerprint:hash(s.accountRisk||{}),pausedSources:Object.fromEntries(['steam','battlemetrics','kda','discord'].map(id=>[id,sourceState(id).paused===true]))};
    const tasks={};
    function task(type,enabled,ready,reason,details={}){
      const source=type==='kda'?'kda':type.startsWith('battlemetrics_')?'battlemetrics':'steam';
      if(sourceState(source).paused){ready=false;reason='SOURCE_PAUSED';}
      tasks[type]={enabled,ready:enabled&&ready,identity:hash([common,type,details]),wipeId:details.wipe?.id||null,
        reason:!global?equivalent?'BACKGROUND_DISABLED':'CAPABILITY_BINDING_CHANGED':!enabled?'SOURCE_DISABLED':ready?null:reason,
        ...details};delete tasks[type].wipe;
    }
    task('steam_profile_backfill',live.steam===true,configured.steam,'STEAM_KEY_REQUIRED');
    const riskMode=live.memberRisk===true;
    const riskSources={steam:configured.steam,restriction:live.steamRisk===true,inventory:live.inventory===true,
      valuation:live.inventoryEnrichment===true&&typeof sourceBindings.inventoryEnrichment==='function',battlemetrics:configured.battlemetrics};
    task('member_profile',live.steam===true,configured.steam&&(!riskMode||typeof sourceBindings.readCredentials==='function'),!configured.steam?'STEAM_KEY_REQUIRED':'TRUSTED_CREDENTIAL_ADAPTER_REQUIRED',
      {mode:riskMode?'risk':'steam_profile',availableSources:riskMode?riskSources:{steam:configured.steam},coverage:riskMode&&!Object.values(riskSources).every(Boolean)?'partial_capabilities':'configured_not_verified'});
    task('battlemetrics_identity',live.battlemetrics===true,configured.battlemetrics,'BATTLEMETRICS_KEY_REQUIRED');
    for(const [type,kind,enabled]of [['battlemetrics_playtime','battlemetrics',live.battlemetrics===true],['kda','kda',live.vital===true]]){
      const selected=selectedWipe(kind),wipe=selected.wipe;
      const config=wipe?(type==='battlemetrics_playtime'?readFollowupSourceConfig:readSourceConfig)({type,scope:{kind:'members',memberIds:[],wipeId:wipe.id}}):null;
      // SourceWindow captures the upper cutoff atomically with job insertion. A live wipe has no endedAt yet.
      const ready=type==='battlemetrics_playtime'?Boolean(wipe&&configured.battlemetrics&&config?.enabled&&config?.serverId&&/^\d{1,30}$/.test(config.battlemetricsServerId)&&date(config.from)):Boolean(wipe&&config?.enabled&&config.sourceId==='vital');
      task(type,enabled,ready,selected.reason||(type==='kda'?'VITAL_WIPE_SOURCE_NOT_CONFIGURED':!configured.battlemetrics?'BATTLEMETRICS_KEY_REQUIRED':'BATTLEMETRICS_SERVER_WINDOW_REQUIRED'),
        {wipe,sourceFingerprint:hash(config||{}),wipeFingerprint:hash(wipe||{}),requiresCurrentMemberAdmission:true});
    }
    return {enabled:global,revision:hash(common),tasks};
  }
  function readRuntimeStatus(source){
    const p=readPolicy(),native=credentials();const id=source==='kda'?'kda':source==='steam'?'steam_profile_backfill':'battlemetrics_identity';
    return {providerAvailable:p.tasks[id]?.enabled===true&&p.tasks[id]?.ready===true,
      injectedCredentialConfigured:Boolean(source==='steam'?native.steamApiKey:source==='battlemetrics'?native.battlemetricsApiKey:false)};
  }
  function diagnostics(){const p=readPolicy(),d=discord();return {enabled:p.enabled,revision:p.revision,tasks:p.tasks,
    discord:{ready:d.ready&&Boolean(credentials().discordBotToken),reason:d.ready&&!credentials().discordBotToken?'DISCORD_TOKEN_REQUIRED':d.reason,source:d.source},
    principalConfigured:Boolean(control().principal),connectionVerified:false};}
  return {readPolicy,readPrincipal,readSourceConfig,readFollowupSourceConfig,readDiscordSettings,readRuntimeStatus,readCredentials:credentials,diagnostics};
}
