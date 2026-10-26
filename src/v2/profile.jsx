import { automaticTimeZone, displayTimeZone, setDisplayTimeZone } from './display-preferences.js';
import { t } from './i18n.js';
import { notifySuccess } from './toast.jsx';
import './member-profile.css';
import React,{useEffect,useRef,useState} from 'react';
import { useQuery } from './use-query.jsx';
import { useApp,AppLink } from './context.jsx';
import { Avatar,Badge,Button,Panel,Title,QueryState,Notice,Modal } from './ui.jsx';
import { Select } from './select.jsx';
import { specialties, normalizeSpecialties, browserTimeZone, timeZoneOptions } from '../../shared/member-preferences.js';
const profileDraft = profile => ({...profile, specialty:normalizeSpecialties(profile.specialty),timeZone:automaticTimeZone()?(profile.timeZone || browserTimeZone()):displayTimeZone()});
import { errorCopy,time } from './format.js';
import { createProfileOperation,dismissProfileOperation,getProfileOperation } from './profile-operation.js';
function CloseAccount({owner}){
 const {client,go,online}=useApp();const [open,setOpen]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const key=useRef(null);
 async function close(){if(!confirmed||busy)return;setBusy(true);setError('');key.current ||= crypto.randomUUID();try{await client.request('/api/v2/auth/close-account',{method:'POST',body:{confirmation:'LEAVE'},headers:{'Idempotency-Key':key.current}});client.clearIdentity('logout');go('/login',{replace:true});}catch(e){setError(e.errorCode==='PROTECTED_ACCOUNT'?"所有者账号不能自行注销。":e.status===0?"请求结果尚未确认，请重新登录核对账号状态。":e);}finally{setBusy(false);}}
 return <Panel><h2>{t("账号与离队")}</h2>{owner?<p className="caption">{t("所有者账号不能自行注销。")}</p>:<Button kind="danger" onClick={()=>setOpen(true)}>{t("注销账号并离队")}</Button>}{open&&<Modal title={t("注销账号并离队")} onClose={()=>!busy&&setOpen(false)} actions={<><Button disabled={busy} onClick={()=>setOpen(false)}>{t("取消")}</Button><Button kind="danger" disabled={!confirmed||busy||online===false} onClick={close}>{busy?t("正在注销…"):t("确认注销并离队")}</Button></>}><p>{t("注销后将退出当前战队和队伍，账号停用，所有登录会话失效。历史游玩与排行记录保留。")}</p><label className="check-row"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>{t("我确认注销自己的账号并离队")}</label>{error&&<Notice title={typeof error==='string'?t(error):errorCopy(error)} tone="error"/>}</Modal>}</Panel>;
}
export default function ProfilePage(){const {client}=useApp();const query=useQuery(client,['me'],'/api/v2/me',{ttlMs:60000});return <><Title eyebrow={t("我的资料")} subtitle={t("让队友知道怎么称呼你、你擅长什么。")}>{t("我的资料")}</Title><QueryState query={query}>{data=><ProfileForm data={data} query={query}/>}</QueryState></>;}
function ProfileForm({data,query}){
  const {client,updateProfile,zone}=useApp();
  const [draft,setDraft]=useState(()=>{const pending=getProfileOperation(client),profile=['submitting','unknown'].includes(pending?.getState().status)?{...data.profile,...pending.body,revision:pending.body.expectedRevision}:data.profile;return profileDraft(profile);}),[error,setError]=useState(null),[reading,setReading]=useState(false);
  const [operation,setOperation]=useState(()=>getProfileOperation(client)),[opState,setOpState]=useState(()=>getProfileOperation(client)?.getState()||{status:'idle'});
  const mounted=useRef(true),applied=useRef(null),readSequence=useRef(0);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;readSequence.current++;};},[]);
  useEffect(()=>{
    if(!operation){setOpState({status:'idle'});return;}
    const receive=()=>{
      const state=operation.getState();setOpState(state);
      if(state.status==='committed'&&applied.current!==operation){const cached=client.getQueryState(['me']).data,current=(cached?.profile?.revision||0)>state.current.profile.revision?cached:state.current;applied.current=operation;setDraft(profileDraft(current.profile));setError(null);}
    };
    receive();return operation.subscribe(receive);
  },[operation]);
  const editable=new Set(data.editableFields||[]),busy=opState.status==='submitting',unknown=opState.status==='unknown',conflict=opState.status==='conflict';
  const shownError=error||opState.error,locked=busy||unknown||reading||!editable.size;
  const edit=(name,value)=>{setDraft(d=>({...d,[name]:value}));setError(null);};
  function submit(e){
    e?.preventDefault();setError(null);
    const existing=getProfileOperation(client);
    if(existing?.getState().status==='submitting')return;
    if(existing?.getState().status==='unknown'){setOperation(existing);existing.retry();return;}
    if(!editable.size||conflict)return;
    const values={displayName:draft.displayName,specialty:draft.specialty,timeZone:draft.timeZone,theme:draft.theme||'light'};
    const body={expectedRevision:draft.revision,...Object.fromEntries(Object.entries(values).filter(([field])=>editable.has(field)&&(field!=='timeZone'||!automaticTimeZone())))};
    try{const next=createProfileOperation(client,{body,onCommitted:current=>{updateProfile(current.profile);notifySuccess('资料已保存',{id:next.operationId});}});setOperation(next);next.submit();}
    catch(err){setError(err);}
  }
  async function readLatest(){
    const generation=client.getGeneration(),sequence=++readSequence.current,previous=operation;setReading(true);setError(null);
    try{const latest=await query.retry();if(!mounted.current||generation!==client.getGeneration()||sequence!==readSequence.current)return;
      setDraft(profileDraft(latest.data.profile));dismissProfileOperation(client,previous);setOperation(null);
    }catch(err){if(mounted.current&&generation===client.getGeneration()&&sequence===readSequence.current)setError(err);}
    finally{if(mounted.current&&sequence===readSequence.current)setReading(false);}
  }
  return <div className="detail-grid member-profile"><Panel><div className="profile-intro"><Avatar name={data.profile.displayName} src={data.profile.avatar}/><div><h2>{data.profile.displayName}</h2><Badge tone="green">{({active:t("在队"),paused:t("暂休"),departed:t("已离队")})[data.profile.membershipStatus]||t("成员资料")}</Badge></div></div>{(shownError||busy)&&<Notice tone={busy?'':'error'} title={busy?t("正在保存资料"):unknown?t("资料保存结果待核实"):t("资料暂未保存")} action={unknown?<Button disabled={busy} onClick={()=>submit()}>{t("重试同一次保存")}</Button>:conflict?<Button disabled={reading} onClick={readLatest}>{t("读取最新资料后重新编辑")}</Button>:null}>{busy?t("返回此页仍可查看这次保存结果。"):errorCopy(shownError)}</Notice>}<form onSubmit={submit}><fieldset disabled={locked||conflict} className="profile-fields"><label className="field">{t("常用名")}<input value={draft.displayName} disabled={!editable.has('displayName')} onChange={e=>edit('displayName',e.target.value)} maxLength={80} required/><small>{t("用于战队内称呼，不会改变 Steam 账号。")}</small></label><fieldset className="profile-specialties" disabled={!editable.has('specialty')}><legend>{t("我的专长（可多选）")}</legend>{Object.entries(specialties).map(([key,label])=><label key={key}><input type="checkbox" checked={draft.specialty.includes(key)} onChange={e=>edit('specialty',e.target.checked?[...draft.specialty,key]:draft.specialty.filter(item=>item!==key))}/>{t(label)}</label>)}</fieldset><label className="check-row profile-timezone-auto"><input type="checkbox" checked={automaticTimeZone()} onChange={e=>setDisplayTimeZone(e.target.checked?'':draft.timeZone)}/>{t("自动跟随设备时区")}</label><label className="field profile-half">{t("显示时区")}<Select value={automaticTimeZone()?zone:draft.timeZone} disabled={automaticTimeZone()||!editable.has('timeZone')} onChange={e=>{edit('timeZone',e.target.value);setDisplayTimeZone(e.target.value);}} required>{timeZoneOptions(automaticTimeZone()?zone:draft.timeZone).map(z=><option key={z} value={z}>{z}</option>)}</Select><small>{t("时间展示跟随当前浏览器设置，实际开荒时刻不变。")}</small></label><label className="field profile-half">{t("页面主题")}<Select value={draft.theme||'light'} disabled={!editable.has('theme')} onChange={e=>edit('theme',e.target.value)}><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option><option value="system">{t("跟随系统")}</option></Select></label><button type="submit" className="button primary" disabled={locked||conflict}>{busy?t("正在保存…"):t("保存资料")}</button></fieldset></form></Panel><aside className="stack"><Panel><h2>{t("账号绑定")}</h2><div className="binding-row"><strong>Steam</strong><Badge tone={data.bindings.steam.status==='verified'?'green':''}>{data.bindings.steam.status==='verified'?t("已验证"):t("待验证")}</Badge></div>{data.bindings.steam.steamId&&<p className="mono">{data.bindings.steam.steamId}</p>}{data.bindings.steam.verifiedAt&&<p className="caption">{t("验证于")} {time(data.bindings.steam.verifiedAt,zone)}</p>}{data.bindings.platforms.map(p=><section key={p.provider} className="platform-binding"><div className="binding-row"><strong>{p.provider==='discord'?'Discord':p.provider==='kook'?'KOOK':p.provider.startsWith('wechat:')?t("微信"):p.provider}</strong><Badge tone="green">{t("已连接")}</Badge></div><dl className="binding-details"><div><dt>{t("昵称")}</dt><dd>{p.displayName||t("未记录")}</dd></div>{p.externalId&&<div><dt>{t("平台 ID")}</dt><dd className="mono">{p.externalId}</dd></div>}</dl></section>)}{!data.bindings.platforms.some(p=>p.provider.startsWith('wechat:'))&&<AppLink to="/app/wechat-link" className="button">{t("关联微信小程序")}</AppLink>}<p className="caption">{t("需要变更 Steam 或平台绑定，请联系管理员核实归属。")}</p></Panel><Panel><h2>{t("常用入口")}</h2><AppLink to="/app/history" className="check-row">{t("我的报名记录")}</AppLink><AppLink to="/help" className="check-row">{t("绑定与报名帮助")}</AppLink></Panel><CloseAccount owner={data.bindings.steam.status==='verified'&&data.bindings.steam.steamId==='76561199886302710'}/></aside></div>;
}
