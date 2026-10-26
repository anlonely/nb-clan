import React, { useEffect, useMemo, useState } from 'react';
import {t} from '../i18n.js';
import { useApp, AppLink } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { createSourceCommand } from './command.js';
import { notifySuccess } from '../toast.jsx';
import './style.css';
const errorCopy = e => ({ REVISION_CONFLICT: t("配置已发生变化。请重新读取，取消当前编辑后重新打开表单核对。"), ROOT_REQUIRED: t("仅所有者可以修改来源凭据。"), ACCESS_DENIED: t("当前账号没有来源配置权限。"), CACHE_REFRESH_REQUIRED: t("配置已提交，缓存尚未更新。请核对并修复此操作。"), DUPLICATE_KEY: t("该密钥已存在于另一条记录，请选择已有记录。"), INVALID_SECRET_LENGTH: t("密钥长度不符合要求，请检查后重新填写。"), JOURNAL_UNAVAILABLE: t("无法保存操作编号，请允许当前页面使用会话存储。") }[e?.errorCode] || t("请求未完成，请核对操作结果或重新读取。"));
const effectiveCopy = { settings: '已保存配置', injected: '宿主注入凭据', none: '未配置', unknown: '宿主状态未接入' };
const tabs = ['连接配置', '采集策略', '运行结果'];
export default function SourceAdminPage() {
  const { client } = useApp(), generation = client.getGeneration();
  return <SourceAdminSession key={generation} client={client}/>;
}
function SourceAdminSession({ client }) {
  const query = useQuery(client, ['source-admin'], '/api/v2/source-admin', { ttlMs: 0 });
  const [selected, select] = useState(null), [tab, setTab] = useState("连接配置"), [editing, setEditing] = useState(null);
  const [state, setState] = useState({ phase: 'idle' });
  const command = useMemo(() => createSourceCommand({ client, storage: sessionStorage, onChange: setState,
    onSaved: (_result, operationId) => { notifySuccess("配置已保存", { id: operationId }); setEditing(null); query.retry().catch(() => {}); } }), [client]);
  useEffect(() => { setState(command.snapshot()); return () => command.dispose(); }, [command]);
  const busy = ['submitting','unknown'].includes(state.phase), item = query.data?.items.find(x => x.id === selected) || query.data?.items[0];
  const refresh = () => query.retry().catch(() => {});
  function open(action, key) {
    if (!item?.canWrite || busy || editing || query.error || query.refreshing) return;
    setEditing({ action, key, expectedRevision: item.revision });
  }
  return <main className="source-admin">
    <header className="source-heading"><h2>{t("数据来源")}</h2><button onClick={refresh} disabled={query.refreshing || busy}>{query.refreshing ? t("正在读取…") : t("重新读取")}</button></header>
    {query.error && <div role="alert" className="source-notice error">{t("读取失败，保存入口已暂停。")}{errorCopy(query.error)}</div>}
    {state.phase === 'unknown' && <div role="alert" className="source-notice error"><strong>{t("操作结果待核对")}</strong><p>{errorCopy(state.error)} {t("操作编号：")}{state.journal?.id}</p><button onClick={() => command.recover()}>{t("核对并修复操作")}</button>{command.canRetry() && <button onClick={() => command.retry()}>{t("使用原编号重试")}</button>}</div>}
    {state.phase === 'error' && <div role="alert" className="source-notice error">{errorCopy(state.error)}</div>}
    {state.phase === 'not-recorded' && <div role="status" className="source-notice">{t("未找到此操作的提交记录。请重新读取配置后再提交。")}</div>}
    {!query.data ? <p role="status">{query.error ? t("来源配置暂时不可用。请重新读取。") : t("正在读取来源配置…")}</p> : !item ? <p role="status">{t("暂无可用数据来源。")}</p> : <div className="source-workspace">
      <nav className="source-directory" aria-label={t("数据来源")}>{query.data.items.map(x => <button key={x.id} className="source-card" aria-current={item.id === x.id ? 'page' : undefined} disabled={busy || Boolean(editing) && item.id !== x.id} onClick={() => { select(x.id); setTab("连接配置"); }}><strong>{t(x.name)}</strong><span className="source-tag">{x.storeConfigured ? t("已保存凭据") : x.id === 'kda' ? t("按服务器配置") : t("未保存凭据")}</span><small>{x.capabilities.map(value=>t(value)).join(' · ')}</small></button>)}</nav>
      <section className="source-detail" aria-label={t("{value0}配置", {value0:t(item.name)})}><div className="source-detail-heading"><h3>{t(item.name)}</h3><span className="source-tag">{t("连接未验证")}</span></div>
        <dl className="source-facts"><div><dt>{t("凭据来源")}</dt><dd>{t(effectiveCopy[item.effectiveSource])}</dd></div><div><dt>{t("配置状态")}</dt><dd>{item.storeConfigured ? t("已保存") : t("未保存")}</dd></div><div><dt>{t("采集适配器")}</dt><dd>{item.providerAvailable ? t("已接入") : item.runtimeStatusKnown ? t("尚未接入") : t("状态未知")}</dd></div></dl>
        <nav className="source-tabs" aria-label={t("来源详情")}>{tabs.map(x => <button key={x} aria-current={tab === x ? 'page' : undefined} onClick={() => setTab(x)}>{t(x)}{x === "连接配置" && editing ? t(" · 编辑中") : ''}</button>)}</nav>
        <div className="source-content" hidden={tab !== "采集策略"}><div className="source-section"><h3>{t("采集能力")}</h3><p>{item.capabilities.map(value=>t(value)).join(' · ')}</p></div><div className="source-section"><h3>{t("数据映射")}</h3><ul>{item.mapping.map(text => <li key={text}>{t(text)}</li>)}</ul></div><div className="source-notice"><p>{t(item.runtimeNote)}</p><p>{t("采集范围与执行由同步任务管理，保存凭据不会启动采集。")}</p>{item.runRecordsHref && <AppLink to={item.runRecordsHref}>{t("管理采集任务 →")}</AppLink>}</div></div>
        <div className="source-content" hidden={tab !== "运行结果"}><h3>{t("采集任务与运行记录")}</h3><p>{t("在同步中心查看最近成功与失败记录，以及玩家匹配、资料补全、在线时长任务的范围、进度和错误。")}</p>{item.runRecordsHref ? <AppLink className="source-link" to={item.runRecordsHref}>{t("查看同步中心运行记录 →")}</AppLink> : <p className="source-notice">{t("当前账号没有全局同步记录读取权限。")}</p>}<p className="source-small">{t("当前页面未执行外部连接检查。")}</p></div>
        <div className="source-content" hidden={tab !== "连接配置"}><p>{item.id === 'battlemetrics' ? t("保留多组 API Key，首选密钥用于来源读取。宿主注入凭据存在时会优先使用注入值。") : item.id === 'steam' ? t("保存的 Web API Key 优先使用；清除后可能恢复使用宿主注入凭据。Steam 登录与此密钥独立。") : t("KDA provider 与服务器/Wipe 映射由档期配置维护。此页只读，不提供通用 KDA 密钥。")}</p>
          {!item.canWrite && item.id !== 'kda' && <p className="source-notice">{t("当前为只读状态，凭据修改仅限所有者。")}</p>}
          {item.id === 'battlemetrics' && <><div className="source-key-list">{!item.keys.length && <p className="source-empty">{t("暂无已保存密钥")}</p>}{item.keys.map(k => <article className="source-key" key={k.id}><div><strong>{k.label}</strong> {k.primary && <span className="source-tag">{t("主密钥")}</span>}<p><code>{k.masked}</code></p></div><div className="source-actions"><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || Boolean(query.error)} onClick={() => open('battlemetrics.save', k)}>{t("编辑")}</button><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || k.primary || Boolean(query.error)} onClick={() => open('battlemetrics.primary', k)}>{t("设为主密钥")}</button><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || Boolean(query.error)} className="source-danger" onClick={() => open('battlemetrics.delete', k)}>{t("删除")}</button></div></article>)}</div><div className="source-actions"><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || Boolean(query.error)} className="source-primary" onClick={() => open('battlemetrics.save')}>{t("新增 BM 密钥")}</button><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || !item.keys.length || Boolean(query.error)} className="source-danger" onClick={() => open('battlemetrics.clear')}>{t("清空 BM 密钥")}</button></div></>}
          {item.id === 'steam' && <><p>{t("已保存密钥：")}<code>{item.masked || t("无")}</code></p><div className="source-actions"><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || Boolean(query.error)} className="source-primary" onClick={() => open('steam.save')}>{t("保存 Steam 密钥")}</button><button type="button" disabled={!item.canWrite || busy || Boolean(editing) || query.refreshing || !item.storeConfigured || Boolean(query.error)} className="source-danger" onClick={() => open('steam.clear')}>{t("清除 Steam 密钥")}</button></div></>}
          {editing && <SourceEditor key={`${editing.action}:${editing.key?.id || ''}:${editing.expectedRevision}`} draft={editing} busy={busy} blocked={Boolean(query.error) || query.refreshing} onClose={() => setEditing(null)} onSubmit={input => command.run(editing.action, input)}/>}
        </div>
      </section></div>}
  </main>;
}
function SourceEditor({ draft, busy, blocked, onClose, onSubmit }) {
  const [apiKey, setApiKey] = useState(''), [label, setLabel] = useState(draft.key?.label || '');
  const saving = draft.action.endsWith('.save'), bm = draft.action.startsWith('battlemetrics'), existing = Boolean(draft.key);
  const min = bm ? 24 : 16, max = bm ? 2048 : 128;
  const valid = !saving || (bm && existing && !apiKey || apiKey.trim().length >= min && apiKey.trim().length <= max);
  const title = saving ? existing ? t("编辑 BM 密钥") : bm ? t("新增 BM 密钥") : t("保存 Steam 密钥") : draft.action.endsWith('.primary') ? t("切换主密钥") : t("移除已保存密钥");
  return <form className="source-editor" aria-label={title} onSubmit={e => { e.preventDefault(); if (!valid || busy || blocked) return;
    const input = { expectedRevision: draft.expectedRevision, ...(draft.key ? { id: draft.key.id } : {}), ...(saving && (apiKey || !existing) ? { apiKey } : {}), ...(saving && bm ? { label } : {}) };
    onSubmit(input).catch(() => {});
  }}><h3>{title}</h3>
    {saving ? <>{bm && <label>{t("标签")}<input aria-label={t("密钥标签")} value={label} maxLength={80} disabled={busy} onChange={e => setLabel(e.target.value)}/></label>}<label>API Key<input aria-label="API Key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={max} minLength={existing ? undefined : min} required={!existing} disabled={busy} onChange={e => setApiKey(e.target.value)} placeholder={existing ? t("留空保留原密钥") : t("{value0}–{value1} 位，保存后不回显", {value0:min,value1:max})}/></label></> : <p>{draft.action.endsWith('.primary') ? t("将“{value0}”设为首选。", {value0:draft.key.label}) : draft.key ? t("删除“{value0}”。", {value0:draft.key.label}) : t("清除该来源在网站中保存的密钥。")} {t("依赖原凭据的采集任务可能需要重新创建。")}</p>}
    <p className="source-small">{t("保存不会验证外部连接。编辑期间如配置发生变化，提交时会提示重新核对。")}</p><div className="source-actions"><button className={saving || draft.action.endsWith('.primary') ? "source-primary" : "source-danger"} type="submit" disabled={!valid || busy || blocked}>{busy ? t("正在处理…") : saving ? t("保存配置") : t("确认修改")}</button><button type="button" disabled={busy} onClick={onClose}>{t("取消")}</button></div>
  </form>;
}
