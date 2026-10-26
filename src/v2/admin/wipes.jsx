import { Select as Dropdown } from '../select.jsx';
import { t } from '../i18n.js';
import React,{useEffect,useRef,useState} from 'react';
import {CalendarDays,Plus,ArrowRight} from 'lucide-react';
import {useApp,AppLink} from '../context.jsx';
import {useQuery} from '../use-query.jsx';
import {Avatar,Badge,Button,Panel,Title,Notice} from '../ui.jsx';
import {time,localInput,arrivalTime,lifecycleLabel,responseLabel} from '../format.js';
import {specialties} from '../../../shared/member-preferences.js';
import {matchAdminLocation,adminWipeTab,invalidateWipe,availableCommands,commandNames,windowLabel,countScopeLabel} from './model.js';
import {WipeWizard} from './wizard.jsx';
import WipeHistory from './history.jsx';
import {historyActionLabel} from './history-model.js';
import {purposeLabels} from './notification-model.js';
import {useAdminOperation} from './use-operation.jsx';
import ServerConnectPublish from '../server-connect-publish.jsx';
import {AdminQueryState as QueryState,OperationNotice,ErrorNotice,Pager} from './shared.jsx';
const api=id=>`/api/v2/wipes/${encodeURIComponent(id)}`;
export function WipeList(){
  const {client,path,zone}=useApp(),r=matchAdminLocation(path),lifecycle=r?.searchParams.get('lifecycle')||'',cursor=r?.searchParams.get('cursor')||'';
  const q=useQuery(client,['admin-wipes',{lifecycle,cursor}],`/api/v2/admin/wipes?limit=20&lifecycle=${encodeURIComponent(lifecycle)}&cursor=${encodeURIComponent(cursor)}`);
  return <><Title eyebrow={t("管理空间")} subtitle={t("从准备下一场，到核实名单与每一条通知。")} actions={<AppLink className="button primary" to="/admin/wipes/new"><Plus size={18}/>{t("新建档期")}</AppLink>}>{t("开档工作台")}</Title><nav className="admin-filters" aria-label={t("档期阶段")}>{[['',t('全部')],...Object.entries(lifecycleLabel)].map(([value,label])=><AppLink className={lifecycle===value?'selected':''} key={value} to={`/admin/wipes${value?`?lifecycle=${value}`:''}`}>{t(label)}</AppLink>)}</nav><QueryState query={q}>{data=><><div className="admin-stack">{data.items.map(({wipe:w,notificationCounts:c})=><AppLink className="admin-wipe-row" to={`/admin/wipes/${encodeURIComponent(w.id)}`} key={w.id}><span className="admin-calendar"><CalendarDays size={23}/></span><div className="admin-wipe-name"><div className="admin-row"><Badge>{t(lifecycleLabel[w.lifecycle]||w.lifecycle)}</Badge><span className="caption">{t(windowLabel[w.effectiveSignupWindow||w.signupWindow]||'待确认')}</span></div><h2>{w.title||t('未命名草稿')}</h2><p>{w.serverSnapshot?.name||t('服务器待填写')} · {time(w.serverScheduledWipeAt,zone)} · {zone}</p></div><div className="admin-wipe-result">{c?<><strong>{t("通知：已发送")} {c.sent||0}</strong><small>{t("失败")} {c.failed||0} {t("· 待核实")} {c.delivery_unknown||0}</small></>:<span>{t("暂无通知记录")}</span>}<ArrowRight size={18}/></div></AppLink>)}</div>{!data.items.length&&<Panel><div className="empty"><CalendarDays size={32}/><h2>{t("这里还没有档期")}</h2><p>{t("当前阶段或授权范围内暂无记录。")}</p><AppLink className="button primary" to="/admin/wipes/new">{t("创建第一份草稿")}</AppLink></div></Panel>}<Pager cursor={cursor} nextCursor={data.nextCursor} base={`/admin/wipes${lifecycle?`?lifecycle=${lifecycle}`:''}`}/><p className="caption">{t(countScopeLabel[data.countScope] || '当前授权可见档期')}</p></>}</QueryState></>;
}
export function WipeDetail({id}){const {client,path}=useApp(),r=matchAdminLocation(path),q=useQuery(client,['wipe',id],`${api(id)}/summary`);return <QueryState query={q}>{data=>r.searchParams.get('edit')==='1'?<WipeWizard key={id} wipe={data.wipe}/>:<WipeContent id={id} data={data} query={q}/>}</QueryState>;}
function WipeContent({id,data,query}){
  const {path,zone,session}=useApp(),w=data.wipe,tab=adminWipeTab(matchAdminLocation(path).searchParams.get('tab')),base=`/admin/wipes/${encodeURIComponent(id)}`;
  return <><AppLink className="back-link" to="/admin/wipes">{t("← 全部档期")}</AppLink><Title eyebrow={`${t(lifecycleLabel[w.lifecycle])} / ${t(windowLabel[w.effectiveSignupWindow]||'报名状态待核实')}`} subtitle={t('档期 {id} · 记录版本 {revision} · 内容版本 {contentRevision}', { id: w.id, revision: w.revision, contentRevision: w.contentRevision })} actions={<div className="admin-row wipe-title-actions">{['draft','scheduled','active'].includes(w.lifecycle)&&<AppLink className="button" to={`${base}?edit=1`}>{w.lifecycle==='draft'?t('继续填写草稿'):t('修改 / 改期')}</AppLink>}<AppLink className="button primary" to={`${base}/notifications`}>{t("准备通知")}</AppLink><ServerConnectPublish wipe={w} compact/></div>}>{w.title||t('未命名草稿')}</Title><nav className="admin-filters" aria-label={t("档期详情")}>{[['overview',t('概览')],['roster',t('报名名单')],['materials',t('地图与资料')],['stats',t('战绩')],['notifications',t('通知记录')],['history',t('历史与归档')]].map(([key,label])=><AppLink className={tab===key?'selected':''} to={`${base}?tab=${key}`} key={key}>{t(label)}</AppLink>)}</nav>
  {tab==='overview'&&<><div className="admin-metrics">{[[t('已确认参加'),data.counts.confirmedAttending],[t('计划参加'),data.counts.plannedAttending],[t('未回复'),data.counts.unanswered]].map(([label,value])=><Panel key={label}><span>{label}</span><strong>{value}</strong></Panel>)}</div><p className="caption">{t(countScopeLabel[data.countScope]||data.countScope)} {t("· 截至")} {time(data.evaluatedAt,zone)} {t("· 名单版本")} {data.rosterRevision}</p><div className="admin-detail-grid"><Panel><h2>{t("本场安排")}</h2><div className="admin-summary">{[[t('服务器'),w.serverSnapshot?.name||t('待填写')],[t('服务器预计开服'),time(w.serverScheduledWipeAt,zone)],[t('结束结果'),({completed:t('正常结束'),aborted:t('异常中止'),cancelled:t('已取消')})[w.outcome]||t('尚未结束')],[t('报名截止'),time(w.signupClosesAt,zone)]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><p className="caption">{t("显示时区")} · {zone} / {t("安排时区：")}{w.timeZone||t('待填写')}</p><p className="body-copy">{w.description||t('暂无补充说明。')}</p>{session.workspaces?.member === true && <AppLink className="text-link" to={`/app/wipes/${encodeURIComponent(id)}?tab=plan#signup`}>{t("在成员空间查看")}</AppLink>}</Panel><div className="admin-stack"><Panel><h2>{t("下一步操作")}</h2><LifecycleActions wipe={w} query={query}/></Panel></div></div></>}
  {tab==='roster'&&<Roster id={id} wipe={w}/>}
  {tab==='materials'&&<MaterialsEditor wipe={w} query={query}/>}
  {tab==='stats'&&<Panel><h2>{t("本场战绩")}</h2><p className="muted">{t("暂无战绩数据")}</p>{w.archiveRevision>0&&<AppLink className="button" to={`${base}?tab=history&view=archive`}>{t("查看已保存归档")}</AppLink>}</Panel>}
  {tab==='notifications'&&<IntentList id={id}/>}
  {tab==='history'&&<History wipe={w}/>}
  </>;
}
function safeExternal(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:undefined;}catch{return undefined;}}
const connectValue=snapshot=>snapshot?.connectCommand||snapshot?.directConnect||snapshot?.connect||'';
const mapValue=snapshot=>snapshot?.mapLink||snapshot?.mapUrl||snapshot?.rustMapsLink||snapshot?.mapImageUrl||'';
function MaterialsEditor({wipe,query}){
  const {client}=useApp(),snapshot=wipe.serverSnapshot||{};
  const [connect,setConnect]=useState(()=>connectValue(snapshot)),[map,setMap]=useState(()=>mapValue(snapshot));
  const [error,setError]=useState(null),[message,setMessage]=useState(''),[comparison,setComparison]=useState(null);
  const op=useAdminOperation(`wipe-materials:${wipe.id}`),consumed=useRef(null);
  const currentConnect=connectValue(snapshot),currentMap=mapValue(snapshot);
  const changed=connect.trim()!==currentConnect||map.trim()!==currentMap;
  useEffect(()=>{if(op.state.status!=='committed'||consumed.current===op.operation?.operationId)return;
    consumed.current=op.operation?.operationId;
    const saved=op.state.current;
    if(saved?.serverSnapshot){setConnect(connectValue(saved.serverSnapshot));setMap(mapValue(saved.serverSnapshot));}
    setMessage('服务器资料已保存，成员页和微信小程序刷新档期后会同步更新。');
    invalidateWipe(client,wipe.id);op.reset();
  },[op.state,op.operation,client,wipe.id]);
  async function compare(){try{const result=await query.retry();setComparison(result.data.wipe);}catch(e){setError(e);}}
  async function save(){
    try{
      setError(null);setMessage('');
      const command=connect.trim(),link=map.trim();
      if(command&&!/^(?:(?:client\.connect|connect)\s+|steam:\/\/connect\/)?(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):([0-9]{1,5})\/?$/i.test(command))throw {errorCode:'SERVER_CONNECT_INVALID'};
      if(command){const port=Number(command.match(/:([0-9]{1,5})\/?$/)?.[1]);if(port<1||port>65535)throw {errorCode:'SERVER_CONNECT_PORT_INVALID'};}
      if(link){let url;try{url=new URL(link);}catch{throw {errorCode:'SERVER_MAP_URL_INVALID'};}if(url.protocol!=='https:'||url.username||url.password)throw {errorCode:'SERVER_MAP_URL_INVALID'};}
      const next={...snapshot,connectCommand:command,directConnect:'',connect:'',mapLink:link,mapUrl:'',rustMapsLink:'',mapImageUrl:''};
      await op.begin({path:api(wipe.id),method:'PATCH',body:{expectedRevision:wipe.revision,serverSnapshot:next,reason:'更新服务器直连与地图链接'}});
    }catch(e){setError(e);}
  }
  const editable=['draft','scheduled','active'].includes(wipe.lifecycle);
  return <Panel><h2>{t('服务器与本场资料')}</h2><p>{snapshot.name||t('尚未填写服务器')}</p>
    <OperationNotice op={op} onCompare={op.state.status==='conflict'?compare:undefined}/><ErrorNotice error={error}/>
    {message&&<Notice title={t('保存成功')}>{t(message)}</Notice>}
    {comparison&&<Notice title={t('服务器资料已更新')} action={<Button onClick={()=>{op.reset();setConnect(connectValue(comparison.serverSnapshot));setMap(mapValue(comparison.serverSnapshot));setComparison(null);setError(null);}}>{t('载入最新资料重新编辑')}</Button>}>{t('请核对最新的服务器直连和地图链接。')}</Notice>}
    <fieldset className="admin-fieldset" disabled={!editable||op.busy||op.state.status==='conflict'}>
      <label className="field">{t('服务器直连')}<input value={connect} onChange={e=>{setConnect(e.target.value);setError(null);setMessage('');}} maxLength={300} placeholder="connect rust.example.com:28015"/></label>
      <label className="field">{t('服务器地图链接')}<input type="url" value={map} onChange={e=>{setMap(e.target.value);setError(null);setMessage('');}} maxLength={2000} placeholder="https://rustmaps.com/map/..."/></label>
      {map&&safeExternal(map)&&<a className="text-link" href={safeExternal(map)} target="_blank" rel="noreferrer">{t('查看地图链接')}</a>}
      <p className="caption">{t('保存后，成员页和微信小程序刷新档期时会读取新链接。')}</p>
      {wipe.lifecycle!=='draft'&&<p className="caption">{t('修改已发布档期的服务器资料后，成员原有报名保持有效。')}</p>}
      {editable&&<div className="admin-row"><Button kind="primary" disabled={!changed||query.refreshing||Boolean(query.error)} onClick={save}>{t('保存修改')}</Button><Button disabled={!changed} onClick={()=>{setConnect(currentConnect);setMap(currentMap);setError(null);setMessage('');}}>{t('取消修改')}</Button></div>}
    </fieldset></Panel>;
}
function LifecycleActions({wipe:w,query}){
  const {client,zone}=useApp(),[command,setCommand]=useState(''),[reason,setReason]=useState(''),[outcome,setOutcome]=useState('completed'),[closes,setCloses]=useState(localInput(w.signupClosesAt,w.timeZone||zone)),[actual,setActual]=useState(''),[offset,setOffset]=useState(''),[evidence,setEvidence]=useState(''),[completeness,setCompleteness]=useState('missing'),[note,setNote]=useState(''),[error,setError]=useState(null),[latest,setLatest]=useState(null);
  const op=useAdminOperation(`wipe-command:${w.id}`),consumed=useRef(null);
  useEffect(()=>{if(op.state.status==='committed'&&consumed.current!==op.operation?.operationId){consumed.current=op.operation?.operationId;invalidateWipe(client,w.id);setCommand('');op.reset();}},[op.state,op.operation,client,w.id]);
  async function compare(){try{const r=await query.retry();setLatest(r.data.wipe);}catch(e){setError(e);}}
  async function submit(){try{setError(null);const body={expectedRevision:w.revision};if(reason)body.reason=reason;
    if(command==='end')body.outcome=outcome;
    if(command==='reopen-signup'){body.closesAt=arrivalTime(closes,w.timeZone||zone,offset);body.rawTimeInputs={closesAt:{localDateTime:closes,timeZone:w.timeZone||zone,...(offset?{utcOffset:offset}:{})}};}
    if(command.startsWith('confirm-')){const k=command==='confirm-start'?'actualStartedAt':'serverActualWipeAt',e=command==='confirm-start'?'startEvidence':'serverStartEvidence';body[k]=arrivalTime(actual,w.timeZone||zone,offset);body[e]=evidence;body.rawTimeInputs={[k]:{localDateTime:actual,timeZone:w.timeZone||zone,...(offset?{utcOffset:offset}:{})}};}
    if(['archive','revise-archive'].includes(command)){body.completeness=completeness;body.data={note};if(command==='revise-archive')body.baseArchiveRevision=w.archiveRevision;}
    await op.begin({path:`${api(w.id)}/commands/${command}`,body});}catch(e){setError(e);}}
  const mustReason=['cancel','close-signup','reopen-signup','archive','revise-archive'].includes(command)||command==='end'&&outcome!=='completed';
  return <div className="admin-stack"><OperationNotice op={op} onCompare={op.state.status==='conflict'?compare:undefined}/><ErrorNotice error={error}/>{latest&&<Notice title={t('最新记录版本 {revision}', { revision: latest.revision }) } action={<Button onClick={()=>{op.reset();setCommand('');setLatest(null);}}>{t("已核对，重新选择操作")}</Button>}>{latest.title} · {t(lifecycleLabel[latest.lifecycle])} · {time(latest.serverScheduledWipeAt,latest.timeZone||zone)}</Notice>}
    {!command&&<div className="admin-action-list">{availableCommands(w).map(c=><Button key={c} disabled={op.busy||query.refreshing||Boolean(query.error)} onClick={()=>{op.reset();setCommand(c);setReason('');setError(null);}}>{t(commandNames[c])}</Button>)}{!availableCommands(w).length&&<p className="caption">{t("本场已取消，保留原始安排与取消归档。")}</p>}</div>}
    {command&&<fieldset className="admin-fieldset" disabled={op.busy||query.refreshing||Boolean(query.error)||op.state.status==='conflict'}><h3>{t(commandNames[command])}</h3>{command==='end'&&<label className="field">{t("结束结果")}<Dropdown value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="completed">{t("正常结束")}</option><option value="aborted">{t("异常中止")}</option><option value="cancelled">{t("进行中取消")}</option></Dropdown></label>}{command==='reopen-signup'&&<label className="field">{t("新的报名截止时间")}<input type="datetime-local" value={closes} onChange={e=>setCloses(e.target.value)}/><small>{w.timeZone||zone}</small></label>}{command.startsWith('confirm-')&&<><label className="field">{t("确认的实际时间")}<input type="datetime-local" value={actual} onChange={e=>setActual(e.target.value)}/></label><label className="field">{t("确认依据")}<textarea value={evidence} onChange={e=>setEvidence(e.target.value)} maxLength={2000}/></label></>}{(command==='reopen-signup'||command.startsWith('confirm-'))&&<label className="field">{t("UTC 偏移（可留空）")}<input value={offset} onChange={e=>setOffset(e.target.value)} placeholder="+08:00"/></label>}
    {['archive','revise-archive'].includes(command)&&<><label className="field">{t("归档完整程度")}<Dropdown value={completeness} onChange={e=>setCompleteness(e.target.value)}><option value="missing">{t("缺少战绩数据")}</option><option value="partial">{t("部分资料齐全")}</option><option value="complete">{t("已核对完整")}</option></Dropdown></label><label className="field">{t("结档记录")}<textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={10000}/></label></>}
    <label className="field">{t("操作原因")}{mustReason?t('（必填）'):t('（选填）')}<textarea maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="admin-row"><Button kind={['cancel','end'].includes(command)?'danger':'primary'} disabled={mustReason&&!reason.trim()} onClick={submit}>{t("确认")}{t(commandNames[command])}</Button><Button onClick={()=>setCommand('')}>{t("返回")}</Button></div></fieldset>}
  </div>;
}
function Roster({id,wipe}) {
  const {client,path} = useApp();
  const cursor = matchAdminLocation(path).searchParams.get('cursor') || '';
  const q = useQuery(client,['signups',id,cursor],`${api(id)}/signups?limit=25&cursor=${encodeURIComponent(cursor)}`);
  const [selected,setSelected] = useState(null);
  return <>
    <QueryState query={q}>{data=><Panel>
      <div className="admin-row admin-between"><div><h2>{t("报名名单")}</h2><p className="caption">{t(countScopeLabel[data.countScope]||data.countScope)} · {t('共 {count} 人 · 名单版本 {revision}', { count: data.counts.eligibleTotal, revision: data.rosterRevision })}</p></div><Button onClick={()=>q.retry().catch(()=>{})}>{t("核对最新名单")}</Button></div>
      <div className="admin-table"><table className="admin-roster-table"><thead><tr><th>{t("成员 / SteamID")}</th><th>{t("专长")}</th><th>{t("队伍")}</th><th>{t("计划回复")}</th><th>{t("回复来源")}</th><th>{t("操作")}</th></tr></thead><tbody>{data.items.map(s=>{
        const name = s.displayName || s.memberId;
        const avatar = <Avatar name={name} src={s.avatar} size={44}/>;
        return <tr key={s.memberId}>
          <td><div className="admin-roster-member">{s.canViewProfile?<AppLink className="admin-roster-avatar-link" to={`/admin/members/profile/${encodeURIComponent(s.memberId)}`} aria-label={t('查看 {name} 的成员资料', { name })}>{avatar}</AppLink>:avatar}<div><strong>{name}</strong><small>{s.canViewProfile ? s.steamId || t('SteamID 未记录') : '—'}</small></div></div></td>
          <td>{s.specialty?.map(key=>t(specialties[key]||key)).join(' · ')||'—'}</td>
          <td>{s.squadName||'—'}</td>
          <td>{t(responseLabel[s.response]||'未回复')}</td>
          <td>{s.source||t('尚未回复')}<small className="admin-muted">{t("版本")} {s.signupRevision}</small></td>
          <td><Button disabled={!['scheduled','active'].includes(wipe.lifecycle)} onClick={()=>setSelected(s)}>{t("代报名")}</Button></td>
        </tr>;
      })}</tbody></table></div>
      {!data.items.length&&<p>{t("当前授权范围内没有可报名成员。")}</p>}
      <Pager cursor={cursor} nextCursor={data.nextCursor} base={`/admin/wipes/${encodeURIComponent(id)}?tab=roster`}/>

    </Panel>}</QueryState>
    {selected&&<DelegateForm key={selected.memberId} wipe={wipe} member={selected} onClose={()=>setSelected(null)}/>}
  </>;
}
function DelegateForm({wipe,member,onClose}){
  const {client,zone}=useApp(),q=useQuery(client,['admin-signup',wipe.id,member.memberId],`${api(wipe.id)}/signups/${encodeURIComponent(member.memberId)}`);
  return <QueryState query={q}>{signup=><DelegateEditor wipe={wipe} member={member} signup={signup} query={q} onClose={onClose} zone={zone}/>}</QueryState>;
}
function DelegateEditor({wipe,member,signup,query,onClose,zone:initialZone}){
  const [zone]=useState(initialZone);
  const {client}=useApp(),[base,setBase]=useState({wipe,signup}),[response,setResponse]=useState(signup.response||'attending_on_time'),[arrival,setArrival]=useState(localInput(signup.expectedArrivalAt,zone)),[offset,setOffset]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(null),[comparison,setComparison]=useState(null),op=useAdminOperation(`delegate:${wipe.id}:${member.memberId}`),consumed=useRef(null);
  useEffect(()=>{if(op.state.status==='committed'&&consumed.current!==op.operation?.operationId){consumed.current=op.operation?.operationId;invalidateWipe(client,wipe.id);client.invalidateQueries(['admin-signup',wipe.id,member.memberId]);setBase(b=>({...b,signup:op.state.current}));op.reset();}},[op.state,op.operation,client,wipe.id,member.memberId]);
  async function save(){try{const expectedArrivalAt=response==='attending_later'?arrivalTime(arrival,zone,offset):null,body={response:response||null,expectedArrivalAt,timeZone:zone,expectedSignupRevision:base.signup.signupRevision,confirmedContentRevision:base.wipe.contentRevision,reason};if(expectedArrivalAt)body.rawTimeInputs={expectedArrivalAt:{localDateTime:arrival,timeZone:zone,...(offset?{utcOffset:offset}:{})}};setError(null);await op.begin({path:`${api(wipe.id)}/signups/${encodeURIComponent(member.memberId)}`,method:'PUT',body});}catch(e){setError(e);}}
  async function compare(){try{const [a,b]=await Promise.all([client.request(`${api(wipe.id)}/summary`),query.retry()]);setComparison({wipe:a.data.wipe,signup:b.data});}catch(e){setError(e);}}
  return <Panel><h2>{t('替 {name} 填写报名', { name: member.displayName||member.memberId })}</h2><p className="caption">{t('将记录操作者和原因。当前窗口：{window}；窗口关闭时需要额外的截止后代改权限。', { window: t(windowLabel[base.wipe.effectiveSignupWindow]) })}</p><OperationNotice op={op} onCompare={op.state.status==='conflict'?compare:undefined}/><ErrorNotice error={error}/>{comparison&&<Notice title={t("回复已更新")} action={<Button onClick={()=>{op.reset();setBase(comparison);setResponse(comparison.signup.response||'');setArrival(localInput(comparison.signup.expectedArrivalAt,zone));setComparison(null);}}>{t("载入最新回复")}</Button>}>{t('当前回复 {response}，版本 {revision}。', { response: t(responseLabel[comparison.signup.response]||'未回复'), revision: comparison.signup.signupRevision })}</Notice>}
  <fieldset className="admin-fieldset" disabled={op.busy||op.state.status==='conflict'}><div className="form-grid"><label className="field">{t("代填回复")}<Dropdown value={response} onChange={e=>setResponse(e.target.value)}>{Object.entries(responseLabel).map(([v,label])=><option key={v} value={v}>{t(label)}</option>)}<option value="">{t("撤回，设为未回复")}</option></Dropdown></label><label className="field">{t("操作原因")}<input value={reason} onChange={e=>setReason(e.target.value)} maxLength={500}/></label></div>{response==='attending_later'&&<div className="form-grid"><label className="field">{t("完整预计到场时间")}<input type="datetime-local" value={arrival} onChange={e=>setArrival(e.target.value)}/><small>{zone}</small></label><label className="field">{t("UTC 偏移（可留空）")}<input value={offset} onChange={e=>setOffset(e.target.value)}/></label></div>}<div className="admin-row"><Button kind="primary" disabled={!reason.trim()} onClick={save}>{t("确认保存代报名")}</Button><Button onClick={onClose}>{t("关闭")}</Button></div></fieldset></Panel>;
}
function IntentList({id}){const {client,path,zone}=useApp(),cursor=matchAdminLocation(path).searchParams.get('cursor')||'',q=useQuery(client,['notification-intents',id,{cursor}],`${api(id)}/publish-intents?limit=20&cursor=${encodeURIComponent(cursor)}`);return <QueryState query={q}>{data=><Panel><div className="admin-row admin-between"><h2>{t("本场通知记录")}</h2><AppLink className="button primary" to={`/admin/wipes/${encodeURIComponent(id)}/notifications`}>{t("准备通知")}</AppLink></div>{data.items.map(item=><AppLink className="admin-record" to={`/admin/publish-intents/${encodeURIComponent(item.id)}`} key={item.id}><div><strong>{t(purposeLabels[item.purpose] || item.purpose)} {t("· 内容版本")} {item.contentRevision}</strong><small>{time(item.createdAt,zone)}</small></div><span>{t("已发送")} {item.counts.sent} / {item.counts.total} {t("· 待核实")} {item.counts.delivery_unknown}</span><ArrowRight size={18}/></AppLink>)}{!data.items.length&&<p className="admin-muted">{t("本场尚无通知意图。发布安排不会自动发送通知。")}</p>}<Pager cursor={cursor} nextCursor={data.nextCursor} base={`/admin/wipes/${encodeURIComponent(id)}?tab=notifications`}/></Panel>}</QueryState>;}
function History({wipe}){
  const {path}=useApp(),requested=matchAdminLocation(path).searchParams.get('view');
  const view=requested==='archive'&&wipe.archiveRevision>0?'archive':requested==='receipt'?'receipt':'activity';
  const base=`/admin/wipes/${encodeURIComponent(wipe.id)}?tab=history`;
  return <>
    <nav className="wipe-history-subtabs" aria-label={t("历史内容")}>
      <AppLink to={base} aria-current={view==='activity'?'page':undefined}>{t("变更记录")}</AppLink>
      {wipe.archiveRevision>0&&<AppLink to={`${base}&view=archive`} aria-current={view==='archive'?'page':undefined}>{t("归档版本")}</AppLink>}
      <AppLink to={`${base}&view=receipt`} aria-current={view==='receipt'?'page':undefined}>{t("操作核验")}</AppLink>
    </nav>
    {view==='activity'?<WipeHistory wipeId={wipe.id}/>:view==='archive'?<ArchiveHistory wipe={wipe}/>:<ReceiptLookup/>}
  </>;
}
function ArchiveHistory({wipe}){
  const {client,zone}=useApp(),[revision,setRevision]=useState(String(wipe.archiveRevision));
  const archive=useQuery(client,['admin-archive',wipe.id,revision],`${api(wipe.id)}/archives/${encodeURIComponent(revision)}`);
  const completeness={complete:'已核对完整',partial:'部分资料齐全',missing:'缺少战绩数据',not_applicable:'不适用'};
  return <Panel className="wipe-archive-panel"><div className="wipe-archive-header"><h2>{t("归档版本")}</h2>
    {wipe.archiveRevision>1&&<label>{t("查看版本")} <Dropdown value={revision} onChange={event=>setRevision(event.target.value)}>{Array.from({length:wipe.archiveRevision},(_,index)=><option key={index+1} value={String(index+1)}>{t("版本")} {index+1}</option>)}</Dropdown></label>}
  </div><QueryState query={archive}>{record=><>
    <dl className="wipe-archive-facts"><div><dt>{t("归档类型")}</dt><dd>{record.kind==='cancellation'?t('取消档案'):t('结档档案')}</dd></div>
      <div><dt>{t("保存时间")}</dt><dd>{time(record.createdAt,zone)}</dd></div>
      <div><dt>{t("资料状态")}</dt><dd>{t(completeness[record.completeness]||'待核实')}</dd></div></dl>
    {record.reason&&<p className="wipe-archive-note"><strong>{t("归档原因：")}</strong>{record.reason}</p>}
    {record.data?.note&&<p className="wipe-archive-note"><strong>{t("结档记录：")}</strong>{record.data.note}</p>}
    <p className="wipe-history-footnote">{t("归档时保存的名单：")}{record.roster?.rows?.length??t('未记录')} {t("人 · 安排内容版本")} {record.wipe?.contentRevision??t('未记录')}</p>
  </>}</QueryState></Panel>;
}
function ReceiptLookup(){
  const {client,zone}=useApp(),[operationId,setOperationId]=useState(''),[receipt,setReceipt]=useState(null),[error,setError]=useState(null);
  async function lookup(event){event.preventDefault();try{setError(null);setReceipt((await client.request(`/api/v2/operations/${encodeURIComponent(operationId.trim())}`)).data);}catch(cause){setError(cause);setReceipt(null);}}
  return <Panel className="wipe-receipt-panel"><h2>{t("按编号核验操作")}</h2><p>{t("适用于手中已有操作编号、需要确认是否提交成功的情况。查询不会重新执行操作。")}</p>
    <form className="wipe-receipt-form" onSubmit={lookup}><label className="field">{t("操作编号")}<input value={operationId} maxLength={150} onChange={event=>{setOperationId(event.target.value);setReceipt(null);setError(null);}} placeholder={t("粘贴操作编号")}/></label><Button type="submit" disabled={!operationId.trim()}>{t("查询回执")}</Button></form>
    <ErrorNotice error={error}/>{receipt&&<dl className="wipe-archive-facts"><div><dt>{t("操作")}</dt><dd>{t(historyActionLabel(receipt.operationReceipt?.action))}</dd></div>
      <div><dt>{t("提交时间")}</dt><dd>{time(receipt.operationReceipt?.committedAt,zone)}</dd></div>
      <div><dt>{t("当前版本")}</dt><dd>{receipt.current?.revision??receipt.current?.signupRevision??t('未记录')}</dd></div></dl>}
  </Panel>;
}
