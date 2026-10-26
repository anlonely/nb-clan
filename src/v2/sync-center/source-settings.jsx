import React,{useState} from 'react';
import {t} from '../i18n.js';
import { Button,Badge,Modal } from '../ui.jsx';

export const sourceNames={discord:'Discord',kook:'KOOK',battlemetrics:'BattleMetrics',kda:'KDA 战绩',steam:'Steam'};
export function CommandRecovery({command}) {return command.state==='unknown'?<div className="sync-actions"><Button onClick={command.reconcile}>{t("核实结果")}</Button><Button onClick={command.retry}>{t("重试同一次操作")}</Button></div>:null;}
const fields=[['concurrency','并发任务数',1,10],['reservedManual','手动任务预留',0,9],['minIntervalMs','请求间隔（毫秒）',0,3600000],['timeoutMs','请求超时（毫秒）',100,120000],['maxAttempts','最大尝试次数',1,10],['priority','调度优先级',0,100]];
export function SourceCards({items,busy,onConfigure,onToggle,onDelete}) {
  return <div className="sync-source-grid">{[...items].sort((a,b)=>Number(a.paused)-Number(b.paused)).map(source=><article className="sync-source-card" key={source.id}>
    <header><h3>{t(sourceNames[source.id]||source.id)}</h3><Badge tone={source.paused?'warning':'success'}><span className={`sync-source-indicator${source.paused?'':' is-active'}`} aria-hidden="true"/>{source.paused?t("已暂停"):t("已启用")}</Badge></header>
    <dl className="sync-source-counts">{[['queued',t("等待")],['running',t("执行中")],['retryWait',t("待重试")]].map(([key,label])=><div key={key}><dt>{label}</dt><dd>{source.queue?.[key]??0}</dd></div>)}</dl>
    <p className="caption sync-source-status">{source.paused?({MANUAL_PAUSE:t("已手动暂停"),CREDENTIALS_INVALID:t("凭据失效"),PROXY_UNAVAILABLE:t("代理不可用"),SOURCE_UNAVAILABLE:t("来源暂不可用"),ADMISSION_ROLE_CONFIG_INVALID:t("准入角色配置已失效")}[source.pauseReason]||t("调度已暂停")):t("调度正常")}</p><footer><Button disabled={busy} onClick={()=>onConfigure(source)}>{t("配置")}</Button><Button className="button sync-source-toggle" disabled={busy} onClick={()=>onToggle(source)}>{source.paused?t("恢复调度"):t("暂停调度")}</Button><Button kind="danger" disabled={busy} onClick={()=>onDelete(source)}>{t("删除")}</Button></footer>
  </article>)}</div>;
}
export function SourceSettings({source,command,onClose}) {
  const [values,setValues]=useState(()=>Object.fromEntries(fields.map(([key])=>[key,source[key]])));
  const valid=fields.every(([key,,min,max])=>Number.isInteger(values[key])&&values[key]>=min&&values[key]<=max)&&values.reservedManual<values.concurrency;
  return <Modal title={t("{value0} 调度配置", {value0:t(sourceNames[source.id]||source.id)})} onClose={onClose} actions={<><Button disabled={command.busy} onClick={onClose}>{t("取消")}</Button><Button kind="primary" disabled={command.busy||!valid} onClick={()=>command.run(`/api/v2/sync-center/sources/${encodeURIComponent(source.id)}`,{...values,expectedRevision:source.revision})}>{t("保存配置")}</Button></>}>
    <div className="sync-settings-fields">{fields.map(([key,label,min,max])=><label className="field" key={key}>{t(label)}<input type="number" min={min} max={max} step="1" value={values[key]} onChange={e=>setValues({...values,[key]:e.target.value===''?'':Number(e.target.value)})}/></label>)}</div>
    <p className="caption">{t("手动任务预留必须小于并发任务数。")}</p>
    {command.error&&<p role="alert" className="sync-plan-error">{command.error.errorCode==='REVISION_CONFLICT'?t("配置已更新，请关闭窗口刷新后重试。"):t("保存未完成，请检查填写内容或核实操作结果。")}</p>}
    <CommandRecovery command={command}/>
  </Modal>;
}
