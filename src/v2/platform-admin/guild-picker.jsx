import React,{useState} from 'react';
import {t} from '../i18n.js';
import {Button,Notice} from '../ui.jsx';
import {Select} from '../select.jsx';

export default function GuildPicker({platform,data,target,disabled,perform,onSelect}){
 const [catalog,setCatalog]=useState(null),[error,setError]=useState('');
 const current=catalog?.revision===data.revision?catalog:null,items=current?.items||data.guildCatalog?.items||[];
 const canRead=!disabled&&data.actions.some(action=>action.id==='metadata'&&action.available);
 async function load(more=false){
  setError('');const page=more?current.page+1:1;
  const result=await perform(`/api/v2/platform-admin/${platform}/actions/metadata`,{expectedRevision:data.revision,kind:'guilds',page,...(more&&platform==='discord'?{after:current.next}:{})});
  if(result?.status!=='succeeded'){setError("服务器读取失败，请检查机器人凭据和服务器访问权限。已有配置保持不变。");return;}
  const rows=result.result.items.filter(item=>item.status==='guild');
  setCatalog({revision:data.revision,page,items:[...new Map([...(more?items:[]),...rows].map(item=>[item.id,item])).values()],next:result.result.reference});
  const match=rows.find(item=>item.id===target.guildId);if(match&&match.label!==target.name)onSelect(match);
 }
 return <div className="cs-guild-picker"><div className="cs-subheading"><h4>{t("选择服务器")}</h4><Button disabled={!canRead} onClick={()=>load()}>{current?t("重新读取服务器"):t("读取服务器列表")}</Button></div>
  <label className="cs-field"><span>{t("机器人已加入的服务器")}</span><Select aria-label={t("选择服务器")} value={target.guildId||''} disabled={disabled||!items.length} onChange={event=>{const guild=items.find(item=>item.id===event.target.value);if(guild)onSelect(guild);}}><option value="">{t("请选择服务器")}</option>{target.guildId&&!items.some(item=>item.id===target.guildId)&&<option value={target.guildId}>{target.name||target.guildId}</option>}{items.map(item=><option key={item.id} value={item.id}>{item.label} · {item.id}</option>)}</Select></label>
  {target.guildId&&<p className="cs-hint">{t("服务器 ID：")}<code>{target.guildId}</code></p>}
  {!current&&!items.length&&<p className="cs-hint">{t("读取后选择服务器，名称和 ID 自动填入。")}</p>}
  {current&&!items.length&&<p className="cs-hint">{t("机器人尚未返回可用服务器，请确认已加入目标服务器。")}</p>}
  {current?.next&&<Button disabled={!canRead} onClick={()=>load(true)}>{t("加载更多服务器")}</Button>}
  {error&&<Notice tone="error" title={t(error)}/>}
 </div>;
}
