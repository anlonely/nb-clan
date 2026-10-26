import React, {useEffect,useState} from 'react';
import {t} from '../i18n.js';
import {Button,Notice,Panel} from '../ui.jsx';
import {Select} from '../select.jsx';
import {Server} from 'lucide-react';
import UnsavedChanges from '../bot-admin/unsaved-changes.jsx';

function GuildIcon({url}) {
 const [failed,setFailed]=useState(false);
 return <span className="login-guild-icon">{url&&!failed?<img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:<Server size={16}/>}</span>;
}

export default function LoginPolicy({platform,data,disabled,onSave,onLoad,onServerSetup}) {
 const [editing,setEditing]=useState(!data.loginPolicy?.allowedRoleIds?.length);
 const [policy,setPolicy]=useState(data.loginPolicy),[resources,setResources]=useState(null),[error,setError]=useState(''),[search,setSearch]=useState('');
 const [guildResources,setGuildResources]=useState(null);
 useEffect(()=>setPolicy(data.loginPolicy),[data.loginPolicy?.policyRevision]);
 if(!policy)return null;
 const targets=[...(data.targets||[]).filter(t=>t.guildId).reduce((map,t)=>{if(!map.has(t.guildId)||t.enabled)map.set(t.guildId,t);return map;},new Map()).values()];
 const target=targets.find(t=>t.guildId===policy.guildId);
 const guildPage=guildResources?.revision===data.revision?guildResources:null;
 const guilds=[...new Map([...(data.guildCatalog?.items||[]),...(guildPage?.items||[])].map(item=>[item.id,item])).values()];
 const guild=guilds.find(item=>item.id===policy.guildId);
 const guildOptions=[...new Map([...targets.map(t=>({id:t.guildId,label:t.name||t.guildId})),...guilds].map(item=>[item.id,item])).values()];
 const loaded=resources?.guildId===policy.guildId&&resources.revision===data.revision;
 const cached=data.loginRoleCatalog?.guildId===policy.guildId?data.loginRoleCatalog.items:[];
 const items=loaded?resources.items:cached;
 const names=new Map([...cached,...items].map(item=>[item.id,item.label]));
 const unknown=policy.allowedRoleIds.filter(id=>!items.some(item=>item.id===id));
 const canLoad=!disabled&&data.enabled&&target?.enabled&&data.actions.some(a=>a.id==='metadata'&&a.available);
 const canLoadGuilds=!disabled&&data.actions.some(a=>a.id==='metadata'&&a.available);
 const change=(key,value)=>setPolicy(p=>({...p,[key]:value}));
 const choose=(id,checked)=>change('allowedRoleIds',checked?[...new Set([...policy.allowedRoleIds,id])]:policy.allowedRoleIds.filter(value=>value!==id));
 async function loadGuilds(more=false) {
  setError('');const page=more?(platform==='kook'?Number(guildPage.next):guildPage.page+1):1;
  const response=await onLoad({expectedRevision:data.revision,kind:'guilds',page,...(more&&platform==='discord'?{after:guildPage.next}:{})});
  if(response?.status==='succeeded'&&response.result?.items) {
   setGuildResources({revision:data.revision,page,items:[...new Map([...(more?guilds:[]),...response.result.items.filter(item=>item.status==='guild')].map(item=>[item.id,item])).values()],next:response.result.reference});
  } else setError("服务器读取失败，请检查机器人凭据和服务器访问权限。已保存的准入规则保持不变。");
 }
 async function load(more=false) {
  setError('');const guildId=policy.guildId;
  const response=await onLoad({expectedRevision:data.revision,targetId:target.id,kind:'roles',page:more?Number(resources.next):1});
  if(response?.status==='succeeded'&&response.result?.items) {
   setResources({guildId,revision:data.revision,items:[...new Map([...(more?items:[]),...response.result.items.filter(i=>i.status==='role')].map(i=>[i.id,i])).values()],next:response.result.reference});
  } else setError(response?.errorCode==='NATIVE_PLATFORM_REJECTED'?"平台拒绝读取身份组，请检查机器人是否已加入所选服务器及其角色权限。已保存的准入规则保持不变。":"身份组读取失败，已保存的准入规则保持不变。");
 }
 async function save(){const response=await onSave(policy);if(response?.status==='succeeded'){setEditing(false);setError('');}}
 if(!editing)return <Panel className="panel login-policy login-policy-saved">
  <div className="login-policy-overview"><div className="login-policy-server"><GuildIcon key={guild?.iconUrl||policy.guildId} url={guild?.iconUrl}/><div className="login-policy-server-copy"><span className="login-policy-caption">{t("准入服务器")}</span><strong>{guild?.label||target?.name||policy.guildId||t("未选择服务器")}</strong><span className="login-policy-match">{t("匹配方式：")}{policy.matchMode==='all'?t("同时拥有全部所选身份组"):t("拥有任意一个所选身份组")}</span></div></div><Button disabled={disabled} onClick={()=>setEditing(true)}>{t("修改身份组")}</Button></div>
  <h3>{t("允许登录的身份组")}</h3><ul className="login-role-summary">{policy.allowedRoleIds.map(id=><li key={id} title={id}>{names.get(id)||id}</li>)}</ul>
  {!policy.allowedRoleIds.length&&<p className="caption">{t("未选择身份组")}</p>}
 </Panel>;
 return <Panel className="panel login-policy"><UnsavedChanges dirty={!disabled&&JSON.stringify(policy)!==JSON.stringify(data.loginPolicy)} onDiscard={()=>setPolicy(data.loginPolicy)}/><div className="platform-row-heading"><h2>{t("网站登录准入")}</h2><span className="caption">{t("已选 {value0} 个身份组",{value0:policy.allowedRoleIds.length})}</span></div>
  <div className="platform-fields"><label>{t("准入服务器")}<Select aria-label={t("准入服务器")} value={policy.guildId} disabled={disabled} onChange={e=>{if(e.target.value===policy.guildId)return;change('guildId',e.target.value);change('allowedRoleIds',[]);setSearch('');setError('');}}><option value="">{t("请选择服务器")}</option>{policy.guildId&&!guildOptions.some(item=>item.id===policy.guildId)&&<option value={policy.guildId}>{t("当前服务器 · {value0}",{value0:policy.guildId})}</option>}{guildOptions.map(item=><option key={item.id} value={item.id}>{item.label}{targets.some(t=>t.guildId===item.id&&t.enabled)?'':t(" · 未启用")}</option>)}</Select></label>
   <label>{t("身份组匹配方式")}<Select aria-label={t("身份组匹配方式")} value={policy.matchMode} disabled={disabled} onChange={e=>change('matchMode',e.target.value)}><option value="any">{t("拥有任意一个所选身份组")}</option><option value="all">{t("拥有全部所选身份组")}</option></Select></label>
  </div>
  <div className="platform-row-heading"><h3>{t("允许登录的身份组")}</h3><div className="login-policy-read-actions">{guildPage?.next&&<Button disabled={!canLoadGuilds} onClick={()=>loadGuilds(true)}>{t("加载更多服务器")}</Button>}<Button disabled={!canLoadGuilds} onClick={()=>loadGuilds()}>{t("读取服务器")}</Button><Button disabled={!canLoad} onClick={()=>load()}>{loaded?t("重新读取身份组"):t("读取身份组")}</Button></div></div>
  {!canLoad&&!disabled&&<p className="caption">{t("请先在平台连接中启用服务，并在“Bot 功能管理 → 服务器与权限”中启用并保存对应服务器。")}<button type="button" className="cs-text-button" onClick={onServerSetup}>{t("前往配置")}</button></p>}
  {items.length>8&&<label className="field">{t("筛选身份组")}<input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("身份组名称或 ID")}/></label>}
  <div className="login-role-options">{items.filter(item=>(item.label+' '+item.id).toLowerCase().includes(search.toLowerCase())).map(item=><label key={item.id}><input type="checkbox" checked={policy.allowedRoleIds.includes(item.id)} disabled={disabled} onChange={e=>choose(item.id,e.target.checked)}/><span>{item.label}<small>{item.id}</small></span></label>)}{unknown.map(id=><label key={id}><input type="checkbox" checked disabled={disabled} onChange={()=>choose(id,false)}/><span>{names.get(id)||t("名称暂不可用")}<small>{id}</small></span></label>)}</div>
  {!policy.allowedRoleIds.length&&!items.length&&<p className="caption">{t("读取服务器身份组后，勾选允许登录网站的身份组。")}</p>}
  {loaded&&resources.next&&<Button disabled={!canLoad} onClick={()=>load(true)}>{t("加载更多身份组")}</Button>}
  {error&&<Notice tone="error" title={t(error)}/>}
  <label className="platform-check login-policy-enabled"><input type="checkbox" checked={policy.enabled} disabled={disabled} onChange={e=>change('enabled',e.target.checked)}/>{t("允许通过 {value0} 登录",{value0:platform==='discord'?'Discord':'KOOK'})}</label>
  <p className="caption">{t("登录还需绑定 Steam。系统角色默认为成员，所有者可在本平台的“身份映射”中配置管理员规则。保存后，此平台已有登录会话需要重新登录。")}</p>
  <div className="button-row"><Button kind="primary" disabled={disabled||!policy.guildId||policy.enabled&&!policy.allowedRoleIds.length} onClick={save}>{t("保存登录准入")}</Button><Button disabled={disabled} onClick={()=>{setPolicy(data.loginPolicy);setError('');setEditing(false);}}>{t("取消")}</Button></div>
 </Panel>;
}
