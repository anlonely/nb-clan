import React, { useEffect, useMemo, useState } from 'react';
import { t, dateLocale } from '../i18n.js';
import { displayTimeZone } from '../display-preferences.js';
import { createWebApiState, webApiHasCredentials } from './web-api-state.js';

const errorCopy = error => t({
  ACCESS_DENIED: '当前账号没有 Rust+ 接入配置权限。',
  AUTH_CHANGED: '账号权限已变化，请重新登录。',
  REVISION_CONFLICT: '配置已被其他操作修改。请先核对当前配置，再重新编辑。',
  JOURNAL_UNAVAILABLE: '无法保存操作编号，请检查浏览器会话存储。',
  INVALID_BASE_URL: '请输入有效的 HTTPS 地址；本地测试可使用回环地址。',
  WEB_API_URL_INVALID: '请输入有效的 HTTPS 地址；本地测试可使用回环地址。',
  WEB_API_KEY_REQUIRED: '请填写 rust-go Web API 密钥。更换地址后需要重新输入密钥。',
  WEB_API_AUTH_FAILED: 'API 密钥无效或权限不足，请检查 rust-go 中的密钥配置。',
  WEB_API_ACCESS_DENIED: 'API 密钥无效或权限不足，请检查 rust-go 中的密钥配置。',
  WEB_API_UNAVAILABLE: '暂时无法连接 rust-go，请检查 API 地址和服务状态。',
  WEB_API_TIMEOUT: '读取 rust-go 超时，请稍后手动重试。',
  WEB_API_RATE_LIMITED: 'rust-go 暂时限制请求，请稍后手动重试。',
  RATE_LIMITED: 'rust-go 暂时限制请求，请稍后手动重试。',
  OPERATION_IN_PROGRESS: '原操作仍在处理，请稍后再次核对。',
  INVALID_RESPONSE: 'rust-go 返回的数据无法读取，请检查 API 地址与服务版本。',
  NETWORK_UNAVAILABLE: '网络连接未完成，请检查网络后重试。',
  REQUEST_TIMEOUT: '请求超时，请重新核对当前状态。',
  WEB_API_INVALID_CONNECTION: '请输入有效的 rust-go API 地址。',
  WEB_API_INVALID_URL: '请输入有效的 rust-go API 地址。',
  WEB_API_HTTPS_REQUIRED: '请输入有效的 HTTPS 地址；本地测试可使用回环地址。',
  WEB_API_INVALID_API_KEY: '密钥格式不正确，请重新复制完整的 Web API 密钥。',
  WEB_API_INVALID_KEY: '密钥格式不正确，请重新复制完整的 Web API 密钥。',
  WEB_API_INVALID_SWITCH: '传输开关无效，请重新读取配置后编辑。',
  WEB_API_INVALID_SERVER_IDS: '请选择有效的服务器，最多 20 个。',
  WEB_API_NEW_KEY_REQUIRED: '请填写 rust-go Web API 密钥。更换地址后需要重新输入密钥。',
  WEB_API_DISABLE_BEFORE_CLEAR: '清除密钥前，请关闭两项传输开关。',
  WEB_API_CONNECTION_REQUIRED: '请填写 API 地址和 Web API 密钥。',
  WEB_API_SERVER_REQUIRED: '开启传输前，请至少选择一个服务器。',
  WEB_API_UNAUTHORIZED: 'API 密钥无效或权限不足，请检查 rust-go 中的密钥配置。',
  WEB_API_FORBIDDEN: 'API 密钥无效或权限不足，请检查 rust-go 中的密钥配置。',
  WEB_API_NOT_FOUND: '未找到 rust-go API，请检查地址与服务版本。',
  WEB_API_UPSTREAM_ERROR: 'rust-go 服务返回错误，请稍后查看传输状态。',
  WEB_API_RESPONSE_TOO_LARGE: 'rust-go 返回的数据过大，暂时无法读取。',
  WEB_API_INVALID_RESPONSE: 'rust-go 返回的数据无法读取，请检查 API 地址与服务版本。',
  WEB_API_REQUEST_ABORTED: '读取 rust-go 超时或已取消，请稍后查看传输状态。',
  WEB_API_UNREACHABLE: '暂时无法连接 rust-go，请检查 API 地址和服务状态。',
  WEB_API_CLAN_UNAVAILABLE: '战队信息暂不可用，请检查服务器的战队接入状态。',
  WEB_API_SERVER_NOT_RUNNING: '服务器未运行，恢复运行后继续读取。',
  WEB_API_SOURCE_CHANGED: '服务器接入已变化，等待下次重新读取。',
  WEB_API_SYNC_FAILED: '本次传输未完成，请检查 rust-go 服务状态。',
  RELAY_ADMIN_BUSY: '当前请求较多，请稍后手动重试。'
}[error?.errorCode] || '读取或保存未完成，请检查连接设置后重试。');
const statusCopy = state => t({ disabled: '未启用', syncing: '正在读取', ok: '传输正常', error: '传输异常',
  idle: '等待下次读取', unavailable: '服务暂不可用' }[state] || '等待状态');
const time = value => value && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toLocaleString(dateLocale(), { timeZone: displayTimeZone(), hour12: false }) : '—';

export default function RelayWebApi({ client }) {
  const [state, setState] = useState(null), [confirmDiscard, setConfirmDiscard] = useState(false);
  const model = useMemo(() => createWebApiState({ client, storage: sessionStorage, onChange: setState }), [client]);
  useEffect(() => {
    setState(model.snapshot());
    if (model.snapshot().journal) model.checkResult(); else model.refresh();
    const refreshVisible = () => { if (!document.hidden) model.refresh(); };
    const interval = setInterval(refreshVisible, 15000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', refreshVisible); model.dispose(); };
  }, [model]);
  const pending = ['saving', 'checking'].includes(state?.phase), unresolved = pending || state?.phase === 'unknown';
  useEffect(() => {
    if (!state?.dirty && !unresolved) return;
    const beforeUnload = event => { event.preventDefault(); event.returnValue = ''; };
    // AppLink handles navigation in its bubble phase. Guard it before a form is unmounted.
    const beforeLink = event => {
      const link = event.target.closest?.('a[href]');
      if (!link || link.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const destination = new URL(link.href, location.href);
      if (destination.href === location.href || destination.pathname === location.pathname && destination.search === location.search && destination.hash) return;
      if (!window.confirm(t(unresolved ? '保存结果尚未确认，离开后可返回此页继续核对。确定离开？' : '尚有未保存的 Web API 配置，确定放弃并离开？'))) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const beforeTraversal = event => {
      if (event.navigationType !== 'traverse' || !event.cancelable) return;
      if (!window.confirm(t(unresolved ? '保存结果尚未确认，离开后可返回此页继续核对。确定离开？' : '尚有未保存的 Web API 配置，确定放弃并离开？'))) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', beforeLink, true);
    window.navigation?.addEventListener('navigate', beforeTraversal);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', beforeLink, true); window.navigation?.removeEventListener('navigate', beforeTraversal); };
  }, [state?.dirty, unresolved]);
  if (!state) return null;
  const { config, draft } = state, canEdit = !!config?.canWrite && !state.loadError && !unresolved;
  const changedElsewhere = draft && config && draft.expectedRevision !== config.revision;
  const hasCredentials = webApiHasCredentials(draft, config);
  const enabled = draft?.infoEnabled || draft?.chatEnabled;
  const valid = draft && (!enabled || hasCredentials && draft.serverIds.length > 0) &&
    (!state.keyInputCleared || !!draft.apiKey.trim() || draft.clearApiKey) && draft.serverIds.length <= 20;
  const selected = new Set(draft?.serverIds || []), running = new Set(state.servers?.map(server => server.id) || []);
  const savedNames = new Map((config?.status?.servers || []).map(server => [server.id, server.name || server.id]));
  const absent = [...selected].filter(id => !running.has(id));
  const toggle = (id, checked) => model.change('serverIds', checked ? [...selected, id] : [...selected].filter(value => value !== id));
  return <section className="relay-panel relay-web-api" aria-labelledby="relay-web-api-title">
    <div className="relay-panel-heading"><h2 id="relay-web-api-title">Rust-go Web API</h2><span className={`relay-tag relay-web-api-state is-${config?.status?.state || 'disabled'}`}>{statusCopy(config?.status?.state)}</span></div>
    <p className="relay-hint">{t('读取 rust-go Web 中运行的服务器，按需传输战队信息和战队聊天。')}</p>
    <div className="relay-web-api-toolbar"><span>{t('关闭网页后后台继续读取；关闭对应开关并保存后停止后续读取，已有记录保留。')}</span><button type="button" disabled={state.loading || pending} onClick={() => unresolved ? model.checkResult() : model.refresh()}>{state.loading ? t('正在读取…') : t('刷新状态')}</button></div>
    {state.loadError && <p className="relay-notice error" role="alert">{t('读取失败，保存入口已暂停。')}{errorCopy(state.loadError)}</p>}
    {!draft ? <p role="status">{t('正在读取 Web API 配置…')}</p> : <form onSubmit={event => { event.preventDefault(); if (canEdit && valid && !changedElsewhere) model.save(); }}>
      {!config.canWrite && <p className="relay-notice">{t('当前账号仅可查看。修改需要 API 或 Rust 工具编辑权限。')}</p>}
      <fieldset className="relay-web-api-fields" disabled={!canEdit}>
        <legend>{t('连接设置')}</legend>
        <label className="relay-web-api-field">{t('API 地址')}<input type="url" value={draft.baseUrl} maxLength={1024} onChange={event => model.change('baseUrl', event.target.value)} placeholder="https://rust-go.example.com" autoComplete="off" spellCheck={false}/><small>{t('填写 rust-go Web 地址或完整 API 地址。')}</small></label>
        <label className="relay-web-api-field">{t('API 密钥')}<span className="relay-web-api-key-row"><input type="password" value={draft.apiKey} onChange={event => model.change('apiKey', event.target.value)} autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={config.apiKeyConfigured ? t('已保存密钥；留空保留，输入新密钥替换') : t('填写 rust-go Web API 密钥')}/>{config.apiKeyConfigured && <button type="button" onClick={() => model.change('clearApiKey', !draft.clearApiKey)}>{draft.clearApiKey ? t('保留已存密钥') : t('清除已存密钥')}</button>}</span><small>{t('在 rust-go 创建 Web API 密钥，授予 read:dashboard 和 read:servers 权限。密钥保存后不回显。')}</small></label>
        {draft.clearApiKey && <p className="relay-notice">{t('保存后将清除已存密钥，并关闭两项传输。')}</p>}
        {state.keyInputCleared && !draft.apiKey.trim() && !draft.clearApiKey && <p className="relay-notice">{t('本次输入的密钥已清空。如需再次保存，请重新输入该密钥。')}</p>}
      </fieldset>
      <fieldset className="relay-web-api-servers" disabled={!canEdit}>
        <legend>{t('读取的服务器')}</legend>
        <div className="relay-web-api-server-heading"><p className="relay-hint">{t('可选择多个运行中的服务器，最多 20 个。')}</p><button type="button" disabled={!canEdit || !hasCredentials || state.serversLoading} onClick={() => model.readServers()}>{state.serversLoading ? t('正在读取服务器…') : t('读取运行中服务器')}</button></div>
        {state.serversError && <p className="relay-notice error" role="alert">{errorCopy(state.serversError)}</p>}
        {state.servers === null && !state.serversLoading && <p className="relay-web-api-empty">{t('填写连接信息后，读取并选择运行中的服务器。')}</p>}
        {state.servers?.length === 0 && <p className="relay-web-api-empty" role="status">{t('当前没有运行中的服务器。请先在 rust-go 启动服务器，再重新读取。')}</p>}
        <div className="relay-web-api-server-list">{state.servers?.map(server => <label key={server.id} className={`relay-web-api-server ${selected.has(server.id) ? 'is-selected' : ''}`}><input type="checkbox" checked={selected.has(server.id)} disabled={!canEdit || selected.size >= 20 && !selected.has(server.id)} onChange={event => toggle(server.id, event.target.checked)}/><span><strong>{server.name}</strong><small>{server.id}{server.clanAvailable === false ? ` · ${t('当前未检测到战队')}` : ''}</small></span><span className="relay-tag">{t('运行中')}</span></label>)}</div>
        {absent.length > 0 && <div className="relay-web-api-retained"><p>{t(state.servers === null ? '已选择的服务器（尚未核实运行状态）' : '以下已选服务器当前未运行或不可用，保留选择后会在恢复运行时继续读取。')}</p>{absent.map(id => <label key={id} className="relay-web-api-retained-server"><input type="checkbox" checked onChange={() => toggle(id, false)}/><span>{savedNames.get(id) || id}</span><small>{t('取消勾选可移除')}</small></label>)}</div>}
      </fieldset>
      <fieldset className="relay-web-api-transfers" disabled={!canEdit || draft.clearApiKey}>
        <legend>{t('传输内容')}</legend>
        <label className="relay-web-api-transfer"><input type="checkbox" checked={draft.infoEnabled} onChange={event => model.change('infoEnabled', event.target.checked)}/><span><strong>{t('传输战队信息')}</strong><small>{t('读取战队成员与战队状态。')}</small></span></label>
        <label className="relay-web-api-transfer"><input type="checkbox" checked={draft.chatEnabled} onChange={event => model.change('chatEnabled', event.target.checked)}/><span><strong>{t('传输战队聊天')}</strong><small>{t('读取所选服务器的战队聊天记录。')}</small></span></label>
      </fieldset>
      {enabled && !selected.size && <p className="relay-hint">{t('开启传输前，请至少选择一个服务器。')}</p>}
      {changedElsewhere && <p role="alert" className="relay-notice error">{t('配置已被其他操作修改。当前草稿已保留，请放弃草稿并载入最新配置后重新编辑。')}</p>}
      {state.error && !unresolved && <p className="relay-notice error" role="alert">{errorCopy(state.error)}</p>}
      {unresolved && <div className="relay-notice" role="status"><strong>{t(pending ? '正在保存或核对配置…' : '保存结果待核对')}</strong><p>{t('请先核对原操作结果，确认之前暂不能再次保存。')}</p><p className="relay-operation">{t('操作编号：')}{state.journal?.id}</p><button type="button" disabled={pending} onClick={() => model.checkResult()}>{t('核对保存结果')}</button></div>}
      {state.phase === 'saved' && <p className="relay-notice" role="status">{t('Web API 配置已保存。')}</p>}
      {state.phase === 'not-recorded' && <p className="relay-notice" role="status">{t('未找到本次提交记录。请核对当前配置，重新填写需要更换的密钥后再保存。')}</p>}
      {state.phase === 'superseded' && <p className="relay-notice" role="status">{t('本次配置已保存，随后又有其他修改。请载入最新配置后继续。')}</p>}
      <div className="relay-actions"><button className="primary" type="submit" disabled={!canEdit || !state.dirty || !valid || changedElsewhere}>{pending ? t('正在处理…') : t('保存 Web API 配置')}</button><button type="button" disabled={!state.dirty || unresolved} onClick={() => setConfirmDiscard(true)}>{t('放弃改动并载入最新配置')}</button>{state.dirty && !unresolved && <span className="relay-web-api-dirty">{t('有未保存的改动')}</span>}</div>
      {confirmDiscard && <div className="relay-notice"><p>{t('放弃当前未保存的 Web API 改动，并使用最近读取的配置？')}</p><div className="relay-actions"><button type="button" disabled={unresolved} onClick={() => { model.discard(); setConfirmDiscard(false); }}>{t('确认放弃')}</button><button type="button" onClick={() => setConfirmDiscard(false)}>{t('继续编辑')}</button></div></div>}
    </form>}
    {config && <section className="relay-web-api-status" aria-label={t('传输状态')}><div><span>{t('最近尝试')}</span><strong>{time(config.status?.lastAttemptAt)}</strong></div><div><span>{t('最近成功')}</span><strong>{time(config.status?.lastSuccessAt)}</strong></div>{config.status?.errorCode && <p role="status" className="relay-web-api-status-error">{errorCopy({ errorCode: config.status.errorCode })}</p>}{config.status?.servers?.length > 0 && <ul className="relay-web-api-server-status">{config.status.servers.map(server => <li key={server.id}><strong>{server.name || server.id}</strong><span>{server.errorCode ? errorCopy({ errorCode: server.errorCode }) : server.state === 'running' ? t('运行中') : statusCopy(server.state)}</span></li>)}</ul>}</section>}
  </section>;
}
