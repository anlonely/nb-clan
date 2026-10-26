import { displayTimeZone } from '../display-preferences.js';
import React, { useEffect, useMemo, useState } from 'react';
import {t,getUiLocale} from '../i18n.js';
import { useApp } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { createRelayCommand } from './command.js';
import { notifySuccess } from '../toast.jsx';
import RelayWebApi from './web-api.jsx';
import './style.css';
const copy = error => ({
  REVISION_CONFLICT: t("配置已发生变化。请重新读取，再检查并提交。"), ACCESS_DENIED: t("当前账号没有中继配置权限。"), AUTH_CHANGED: t("账号权限已变化，请重新登录。"),
  CACHE_REFRESH_REQUIRED: t("Token 已提交，配置状态需要恢复。"), RELAY_AUTH_INVALIDATOR_REQUIRED: t("认证服务尚未接入，暂时无法修改。"), RELAY_AUTH_INVALIDATION_FAILED: t("认证状态刷新失败，请核对操作结果。"),
  OPERATION_IN_PROGRESS: t("原操作仍在处理，请稍后再次核对。"), INVALID_TOKEN_LENGTH: t("请输入 16–256 位 Token。"), JOURNAL_UNAVAILABLE: t("无法保存操作编号，请检查浏览器会话存储。")
}[error?.errorCode] || t("请求未完成，请核对操作结果或重新读取。"));
export default function RelayAdminPage({ embedded = false }) {
  const { client } = useApp(); return <RelaySession key={client.getGeneration()} client={client} embedded={embedded}/>;
}
function RelaySession({ client, embedded }) {
  const query = useQuery(client, ['relay-admin'], '/api/v2/relay-admin', { ttlMs: 0 });
  const [editing, setEditing] = useState(null), [state, setState] = useState({ phase: 'idle' });
  const command = useMemo(() => createRelayCommand({ client, storage: sessionStorage, onChange: setState, onSaved: (_result, operationId) => { notifySuccess("配置已保存", { id: operationId }); setEditing(null); query.retry().catch(() => {}); } }), [client]);
  useEffect(() => { setState(command.snapshot()); return () => command.dispose(); }, [command]);
  const busy = ['submitting','recovering'].includes(state.phase), unresolved = busy || state.phase === 'unknown', data = query.data;
  const canWrite = data?.canWrite && !query.error && !query.refreshing && !unresolved;
  const open = action => { if (canWrite) setEditing({ action, expectedRevision: data.revision }); };
  return <section className={`relay-admin${embedded ? ' is-embedded' : ''}`} aria-label={t("Rust+ 接入")}>
    <header className="relay-heading"><div>{!embedded && <p className="relay-eyebrow">{t("平台接入")}</p>}{embedded ? <h2>{t("Rust+ 接入")}</h2> : <h1>{t("Rust+ 接入")}</h1>}</div><button onClick={() => query.retry().catch(() => {})} disabled={query.refreshing || busy}>{t("重新读取")}</button></header>
    <RelayWebApi client={client}/>
    {query.error && <p role="alert" className="relay-notice error">{t("读取失败，修改入口已暂停。")}{copy(query.error)}</p>}
    {(state.phase === 'unknown' || state.phase === 'recovering') && <section role="alert" className="relay-notice error"><strong>{t("操作结果待核对")}</strong><p>{copy(state.error)}</p><p className="relay-operation">{t("操作编号：")}{state.journal?.id}</p><button disabled={busy} onClick={() => command.recover()}>{busy ? t("正在核对…") : t("核对并恢复操作")}</button></section>}
    {state.phase === 'error' && <p role="alert" className="relay-notice error">{copy(state.error)}</p>}
    {state.phase === 'not-recorded' && <p role="status" className="relay-notice">{t("未找到此操作的提交记录。请重新读取配置后再设置。")}</p>}
    {!data ? <p role="status">{t("正在读取中继配置…")}</p> : <section className="relay-panel"><div className="relay-panel-heading"><h2>{t("中继 Token")}</h2><span className="relay-tag">{data.configured ? t("已设置") : t("未设置")}</span></div>
      <dl><div><dt>{t("已保存 Token")}</dt><dd><code>{data.masked || t("未设置")}</code></dd></div><div><dt>{t("最近更新")}</dt><dd>{data.tokenUpdatedAt ? new Date(data.tokenUpdatedAt).toLocaleString(getUiLocale().startsWith('en')?'en-US':'zh-CN', { timeZone: displayTimeZone(),  hour12: false }) : '—'}</dd></div><div><dt>{t("中继接口")}</dt><dd><code>{data.endpoint}</code></dd></div></dl>
      {!data.canWrite && <p className="relay-hint">{data.authInvalidatorReady ? t("当前账号可查看此配置。修改需要 API 或 Rust 工具编辑权限。") : t("认证服务尚未接入，暂时无法修改 Token。")}</p>}
      <div className="relay-actions"><button className="primary" disabled={!canWrite} onClick={() => open('save')}>{t("设置 Token")}</button><button disabled={!canWrite || !data.configured} onClick={() => open('clear')}>{t("清除 Token")}</button></div>
      {editing && <TokenEditor key={`${editing.action}:${editing.expectedRevision}`} draft={editing} busy={unresolved} pending={busy} onClose={() => setEditing(null)} onSubmit={input => command.run(editing.action, input)}/>}
    </section>}
  </section>;
}
function TokenEditor({ draft, busy, pending, onClose, onSubmit }) {
  const [token, setToken] = useState(''), saving = draft.action === 'save', valid = !saving || token.trim().length >= 16 && token.trim().length <= 256;
  return <form className="relay-editor" aria-label={saving ? t("设置中继 Token") : t("清除中继 Token")} onSubmit={event => { event.preventDefault(); if (busy || !valid) return; const input = { expectedRevision: draft.expectedRevision, ...(saving ? { token } : {}) }; setToken(''); onSubmit(input).catch(() => {}); }}>
    <h3>{saving ? t("设置新的 Token") : t("清除已保存的 Token")}</h3>
    {saving ? <label>Token<input aria-label={t("中继 Token")} type="password" value={token} minLength={16} maxLength={256} autoComplete="new-password" spellCheck={false} required disabled={busy} onChange={event => setToken(event.target.value)} placeholder={t("16–256 位，保存后不回显")}/></label> : <p>{t("清除后，中继客户端将无法继续通过此 Token 认证。")}</p>}
    <div className="relay-actions"><button className="primary" type="submit" disabled={busy || !valid}>{pending ? t("正在处理…") : saving ? t("保存 Token") : t("确认清除")}</button><button type="button" disabled={busy} onClick={onClose}>{t("取消")}</button></div>
  </form>;
}
