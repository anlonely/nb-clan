import { t } from './i18n.js';
import { Select as Dropdown } from './select.jsx';
import { parseMemberLocation } from './router.js';
import React,{useEffect,useRef,useState} from 'react';
import { ArrowLeft,Copy } from 'lucide-react';
import { useQuery } from './use-query.jsx';
import { createSignupOperation } from './signup-operation.js';
import { useApp,AppLink } from './context.jsx';
import { Badge,Button,Panel,Title,QueryState,Notice,Modal } from './ui.jsx';
import { arrivalTime,errorCopy,localInput,responseLabel,lifecycleLabel,time } from './format.js';
import { Pager } from './pages.jsx';
import { notifySuccess } from './toast.jsx';
import WipeStats from './wipe-stats.jsx';
const operations=new WeakMap();
function safeMapUrl(value){
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
function operationStore(client){
  if(!operations.has(client)){const map=new Map();operations.set(client,map);client.subscribeIdentity(()=>{for(const op of map.values())op.dispose();map.clear();});}
  return operations.get(client);
}
export default function WipePage({id}){
  const {client}=useApp();const query=useQuery(client,['wipe',id],`/api/v2/wipes/${encodeURIComponent(id)}/summary`,{ttlMs:20000});
  return <><AppLink to="/app/wipes" className="back-link"><ArrowLeft size={16}/>{t("所有开荒")}</AppLink><QueryState query={query}>{data=><WipeContent id={id} data={data} query={query}/>}</QueryState></>;
}
function WipeContent({id,data,query}){
  const {client,path,go,zone,session}=useApp();const w=data.wipe,current=data.mySignup||{response:null,signupRevision:0};
  const server=w.serverSnapshot||{},connect=server.connectCommand||server.directConnect||server.connect||server.connectUrl||'';
  const mapUrl=[server.mapLink,server.mapUrl,server.rustMapsLink,server.mapImageUrl].map(safeMapUrl).find(Boolean)||'';
  // Pin in-progress local time input to its displayed zone when the device zone changes.
  const [entryZone,setEntryZone]=useState(zone);
  const store=operationStore(client),[operation,setOperation]=useState(()=>store.get(id)||null),[opState,setOpState]=useState(()=>store.get(id)?.getState()||{status:'idle'});
  const [editing,setEditing]=useState(!current.response),[base,setBase]=useState(()=>({wipe:w,signup:current})),[choice,setChoice]=useState(current.response||''),[arrival,setArrival]=useState(localInput(current.expectedArrivalAt,zone)),[offset,setOffset]=useState(''),[candidates,setCandidates]=useState([]),[error,setError]=useState(null),[withdraw,setWithdraw]=useState(false),[copied,setCopied]=useState(false);
  const tab=parseMemberLocation(path).searchParams.get('tab')||'plan';
  const unknown=['submitting','unknown'].includes(opState.status),conflict=opState.status==='conflict';
  const mounted=useRef(true);useEffect(()=>()=>{mounted.current=false;},[]);
  useEffect(()=>{if(!operation)return;setOpState(operation.getState());return operation.subscribe(()=>{const next=operation.getState();setOpState(next);if(next.status==='committed'){const existing=client.getQueryState(['wipe',id]).data;if(existing&&next.current.signupRevision>=(existing.mySignup?.signupRevision||0)){client.setQueryData(['wipe',id],{...existing,mySignup:next.current,wipe:{...existing.wipe,mySignup:next.current}},{meta:query.meta});client.invalidateQueries(['wipe',id]);client.invalidateQueries(['home']);client.invalidateQueries(['history']);}notifySuccess('报名已保存',{id:operation.operationId});setEditing(false);store.delete(id);}});},[operation]);
  function begin(){setEntryZone(zone);setBase({wipe:w,signup:current});setChoice(current.response||'');setArrival(localInput(current.expectedArrivalAt,zone));setEditing(true);setError(null);}
  async function refreshConflict(){
    try{
      const result=await query.retry();
      if(!mounted.current)return;
      operation?.dispose();store.delete(id);setOperation(null);setOpState({status:'idle'});
      setBase({wipe:result.data.wipe,signup:result.data.mySignup});
      setChoice(result.data.mySignup?.response||'');setArrival(localInput(result.data.mySignup?.expectedArrivalAt,zone));
      setEditing(false);setError(null);
    }catch(e){if(mounted.current)setError(e);}
  }
  async function handleResult(op,method){
    const generation=client.getGeneration();const result=await op[method]();
    if(!mounted.current||generation!==client.getGeneration())return;
    setOpState(result);
    if(result.status==='committed'){
      const existing=client.getQueryState(['wipe',id]).data||data;
      const latest=result.current.signupRevision>=(existing.mySignup?.signupRevision||0)?result.current:existing.mySignup;
      client.setQueryData(['wipe',id],{...existing,mySignup:latest,wipe:{...existing.wipe,mySignup:latest}},{meta:query.meta});
      store.delete(id);setBase({wipe:existing.wipe,signup:latest});setEditing(false);setError(null);notifySuccess('报名已保存',{id:op.operationId});
      client.invalidateQueries(['home']);client.invalidateQueries(['wipes']);client.invalidateQueries(['history']);client.invalidateQueries(['wipe',id]);
    }else if(result.status==='conflict'){setEditing(false);}
    else if(result.status==='failed'){setError(result.error);store.delete(id);}
  }
  async function save(response=choice){
    if(['submitting','unknown'].includes(store.get(id)?.getState().status))return;
    setError(null);setCandidates([]);let expectedArrivalAt=null;
    if(response==='attending_later')try{expectedArrivalAt=arrivalTime(arrival,entryZone,offset);}catch(e){setError(e);setCandidates(e.candidates||[]);return;}
    const body={response,expectedArrivalAt,timeZone:entryZone,expectedSignupRevision:base.signup.signupRevision,confirmedContentRevision:base.wipe.contentRevision};
    if(response==='attending_later')body.rawTimeInputs={expectedArrivalAt:{localDateTime:arrival,timeZone:entryZone,...(offset?{utcOffset:offset}:{})}};
    operation?.dispose();const next=createSignupOperation(client,{wipeId:id,body});store.set(id,next);setOperation(next);await handleResult(next,'submit');
  }
  const canSignup=data.mySignup!==null&&session.participation?.canSignup!==false,writable=w.effectiveSignupWindow==='open';
  return <><Title eyebrow={t("开荒详情")} subtitle={t("时间显示为 {v0}，战队安排时区为 {v1}。", {v0:(zone),v1:(w.timeZone)})} actions={<Badge tone={w.lifecycle==='scheduled'?'green':''}>{t(lifecycleLabel[w.lifecycle])}</Badge>}>{w.title||w.serverSnapshot?.name}</Title><div className="time-strip"><div><span>{t("服务器预计开服")}</span><strong>{time(w.serverScheduledWipeAt,zone)}</strong><small>{w.serverActualWipeAt?t("实际开服 {v0}", {v0:(time(w.serverActualWipeAt,zone))}):t("实际开服待确认")}</small></div><div><span>{t("报名截止")}</span><strong>{time(w.signupClosesAt,zone)}</strong><small>{writable?t("报名开放中"):w.effectiveSignupWindow==='not_open'?t("报名尚未开放"):t("报名已关闭")}</small></div></div><nav className="tabs" aria-label={t("开荒详情")}>{[['plan',t("安排与报名")],['team',t("队友")],['server',t("服务器与地图")],['stats',t("战绩")]].map(([value,label])=><AppLink key={value} to={`/app/wipes/${encodeURIComponent(id)}?tab=${value}`} className={tab===value?'selected':''} aria-current={tab===value?'page':undefined}>{t(label)}</AppLink>)}</nav>
  {tab==='plan'&&<div className="detail-grid"><div className="stack"><Panel><div className="section-title"><h2>{t("我的报名")}</h2><Badge tone={current.response?'green':''}>{unknown?t("结果待确认"):t(responseLabel[current.response])||t("未回复")}</Badge></div>{unknown?<Notice title={opState.status==='submitting'?t("正在保存，请稍候"):t("提交结果还不明确")} action={<div className="button-row"><Button disabled={opState.status==='submitting'} onClick={()=>handleResult(operation,'reconcile')}>{t("查询这次提交")}</Button><Button disabled={opState.status==='submitting'} onClick={()=>handleResult(operation,'retry')}>{t("重试同一次提交")}</Button></div>}>{t("暂时查不到回执，也不能说明原请求没有提交。我们已保留同一次请求；核实前请不要另选安排。")}</Notice>:conflict?<Notice title={t("回复已在其他地方修改")} action={<Button onClick={refreshConflict}>{t("刷新最新回复")}</Button>}>{t("刷新后可继续修改报名，已保存的回复不会被覆盖。")}</Notice>:null}
  {!canSignup&&<Notice title={t("当前身份暂不能报名")}>{errorCopy({errorCode:session.participation?.reasonCode||'MEMBERSHIP_INACTIVE'})}<AppLink to="/app/team">{t("查看我的队伍")}</AppLink></Notice>}
  {!writable&&!unknown&&<Notice title={w.effectiveSignupWindow==='not_open'?t("报名尚未开放"):w.lifecycle==='active'?t("本开荒已开始，报名截止。"):t("报名已截止。")}/>}
  {error&&<Notice tone="error" title={t("暂未保存")}>{errorCopy(error)}</Notice>}
  {editing&&!unknown&&!conflict&&canSignup&&writable?<><p className="muted">{t("告诉队友你什么时候来，保存后才会生效。")}</p><fieldset className="signup-options"><legend className="sr-only">{t("我的到场安排")}</legend>{Object.entries(responseLabel).map(([value,label])=><label key={value} className={`choice ${choice===value?'chosen':''}`}><input type="radio" name="attendance" value={value} checked={choice===value} onChange={()=>{setChoice(value);setOffset('');setError(null);}}/><div><strong>{t(label)}</strong><small>{value==='attending_on_time'?t("{v0}，准时开荒", {v0:(time(base.wipe.serverScheduledWipeAt,zone))}):value==='attending_later'?t("选择完整日期和预计到场时间"):t("明确告诉队友，这次不参加")}</small></div></label>)}</fieldset>{choice==='attending_later'&&<div className="arrival-box"><label className="field">{t("预计到场时间")}<input type="datetime-local" value={arrival} onChange={e=>{setArrival(e.target.value);setOffset('');setCandidates([]);}}/><small>{entryZone}</small></label><div className="button-row">{[8,16].map(h=><Button key={h} onClick={()=>{setArrival(localInput(new Date(Date.parse(base.wipe.actualStartedAt||base.wipe.serverScheduledWipeAt||base.wipe.musterAt)+h*3600000).toISOString(),entryZone));setOffset('');}}>{t("开荒 +{hours} 小时", {hours:h})}</Button>)}</div><p className="caption">{t("将保存：")}{arrival?arrival.replace('T',' '):t("请选择时间")} · {entryZone}</p>{candidates.length>1&&<label className="field">{t("请选择 UTC 偏移")}<Dropdown value={offset} onChange={e=>setOffset(e.target.value)}><option value="">{t("选择明确的时刻")}</option>{candidates.map(c=><option key={c.utc} value={c.utcOffset}>{c.utcOffset} · {c.utc}</option>)}</Dropdown></label>}</div>}<div className="form-actions"><Button kind="primary" disabled={!choice} onClick={()=>save()}>{t("保存报名")}</Button>{current.response&&<Button onClick={()=>{setEditing(false);setError(null);}}>{t("取消编辑")}</Button>}</div></>:!unknown&&<div className="saved-signup"><p><strong>{t("已保存的回复：")}{t(responseLabel[current.response])||t("未回复")}</strong>{current.response==='attending_later'?` · ${time(current.expectedArrivalAt,zone)}`:''}</p>{current.updatedAt&&<p className="caption">{t("更新时间：{time}", {time:time(current.updatedAt,zone)})}</p>}{writable&&canSignup&&!conflict&&<div className="button-row"><Button onClick={begin}>{t("修改报名")}</Button>{current.response&&<Button kind="ghost" onClick={()=>setWithdraw(true)}>{t("撤回回复")}</Button>}</div>}</div>}</Panel><Panel><h2>{t("备注：")}</h2><p className="body-copy">{w.description||'—'}</p></Panel></div><aside className="stack"><Panel><h2>{t("报名概况")}</h2><dl className="counts"><div><dt>{t("已确认参加")}</dt><dd>{data.counts.confirmedAttending}</dd></div><div><dt>{t("计划参加")}</dt><dd>{data.counts.plannedAttending}</dd></div><div><dt>{t("未回复")}</dt><dd>{data.counts.unanswered}</dd></div><div><dt>{t("这次不来")}</dt><dd>{data.counts.notAttending}</dd></div></dl><AppLink className="text-link" to={`/app/wipes/${encodeURIComponent(id)}?tab=team`}>{t("查看队友安排")}</AppLink></Panel></aside></div>}
  {tab==='team'&&<SignupList id={id}/>}
  {tab==='server'&&<div className="stack"><Panel><h2>{server.name||w.title}</h2><p>{t("预计开服时间：{time} · {zone}", {time:time(w.serverScheduledWipeAt,zone),zone})}</p>{connect&&<><code className="connect-command">{connect}</code><Button onClick={async()=>{try{await navigator.clipboard.writeText(connect);setCopied(true);}catch{setCopied(false);}}}><Copy size={16}/>{copied?t("已复制"):t("复制连接命令")}</Button><p className="caption">{t("在 Rust 控制台粘贴此命令。")}</p></>}{server.address?<p className="muted">{server.address}</p>:!connect&&<p className="muted">{t("如果没有提供连接地址，请在战队社区查看本场公告。")}</p>}</Panel><Panel><h2>{t("地图")}</h2>{mapUrl?<a className="button" href={mapUrl} target="_blank" rel="noopener noreferrer">{t("查看本场地图")}</a>:<p className="muted">{t("地图：尚未提供经过确认的地图数据。")}</p>}</Panel></div>}
  {tab==='stats'&&<WipeStats id={id}/>}
  {withdraw&&<Modal title={t("撤回这次回复？")} onClose={()=>setWithdraw(false)} actions={<><Button onClick={()=>setWithdraw(false)}>{t("保留回复")}</Button><Button kind="danger" onClick={()=>{setWithdraw(false);save(null);}}>{t("确认撤回回复")}</Button></>}><p>{t("撤回后会显示为“未回复”。如果确定不能来，请选择“这次不来”。")}</p></Modal>}</>;
}
function SignupList({id}){const {client,path,zone}=useApp(),cursor=parseMemberLocation(path).searchParams.get('cursor')||'';const q=useQuery(client,['signups',id,cursor],`/api/v2/wipes/${encodeURIComponent(id)}/signups?limit=25&cursor=${encodeURIComponent(cursor)}`);return <QueryState query={q}>{data=><Panel><h2>{t("队友的安排")}</h2><div className="table-scroll"><table><thead><tr><th>{t("队友")}</th><th>{t("回复")}</th><th>{t("预计到场时间")}</th></tr></thead><tbody>{data.items.map(s=><tr key={s.memberId}><td>{s.displayName||t("队友")}</td><td>{t(responseLabel[s.response])||t("未回复")}</td><td>{s.response==='attending_later'?time(s.expectedArrivalAt,zone):s.response==='attending_on_time'?t("准时"):'—'}</td></tr>)}</tbody></table></div>{!data.items.length&&<p>{t("当前范围内还没有成员。")}</p>}<Pager cursor={cursor} nextCursor={data.nextCursor} base={`/app/wipes/${encodeURIComponent(id)}?tab=team`}/></Panel>}</QueryState>;}
