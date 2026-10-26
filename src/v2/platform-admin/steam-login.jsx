import { displayTimeZone } from '../display-preferences.js';
import React, { useEffect, useRef, useState } from 'react';
import {t,getUiLocale} from '../i18n.js';
import { AppLink, useApp } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Badge, Button, Notice, Panel, QueryState } from '../ui.jsx';
import { notifySuccess } from '../toast.jsx';

const endpoint = '/api/v2/platform-admin/steam/login';
const absoluteUrl = value => new URL(value, window.location.origin).href;

export default function SteamLoginPage({ canManageSource = false }) {
  const { client, online } = useApp();
  const query = useQuery(client, ['platform-admin', 'steam', 'login'], endpoint, { ttlMs: 15000 });
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(null);

  useEffect(() => {
    if (query.data) setEnabled(query.data.enabled);
  }, [query.data?.enabled, query.data?.updatedAt]);

  async function save(data) {
    if (busy || online === false || !data.canConfigure || enabled === data.enabled) return;
    const body = { enabled, expectedUpdatedAt: data.updatedAt };
    const serial = JSON.stringify(body);
    if (pending.current && pending.current.serial !== serial) {
      setError("上次保存结果尚未确认，请重新读取后再修改。");
      return;
    }
    const operation = pending.current || { id: crypto.randomUUID(), serial };
    pending.current = operation;
    setBusy(true);
    setError('');
    try {
      const response = await client.request(endpoint, {
        method: 'POST', body, headers: { 'Idempotency-Key': operation.id }
      });
      pending.current = null;
      setEnabled(response.data.current.enabled);
      notifySuccess("Steam 登录设置已保存", { id: operation.id });
      try {
        await query.retry();
      } catch {
        setError("设置已保存，但重新读取失败。请点击“重新读取”确认最新状态。");
      }
    } catch (cause) {
      if (cause.status >= 400 && cause.status < 500) pending.current = null;
      setError(cause.errorCode === 'REVISION_CONFLICT'
        ? "设置已在别处修改，请重新读取后保存。"
        : {source:"{value0} · 请重试同次保存。",params:{value0:cause.errorCode || 'NETWORK_ERROR'}});
    } finally {
      setBusy(false);
    }
  }

  return <section className="platform-module platform-steam-page" aria-label={t("Steam 登录配置")}>
    <header className="platform-module-heading"><div><span className="eyebrow">{t("登录与身份")}</span><h2>{t("Steam 登录配置")}</h2></div><Badge>OpenID 2.0</Badge></header>
    <QueryState query={query}>{data => <>
      <Panel>
        <div className="platform-row-heading"><h2>{t("网站登录")}</h2><Badge>{data.enabled ? t("已启用") : t("已停用")}</Badge></div>
        <p className="muted">{t("本站通过 Steam OpenID 验证 SteamID。此登录方式无需 OAuth Client ID 或 Client Secret。")}</p>
        <dl className="platform-steam-facts">
          <div><dt>{t("认证提供方")}</dt><dd><code>{data.providerUrl}</code></dd></div>
          <div><dt>{t("登录入口")}</dt><dd><code>{absoluteUrl(data.startUrl)}</code></dd></div>
          <div><dt>{t("回调地址")}</dt><dd><code>{absoluteUrl(data.callbackUrl)}</code></dd></div>
          <div><dt>{t("最近修改")}</dt><dd>{data.updatedAt ? new Date(data.updatedAt).toLocaleString(getUiLocale().startsWith('en')?'en-US':'zh-CN', { timeZone: displayTimeZone() }) : t("尚未单独修改")}</dd></div>
        </dl>
        <label className="platform-steam-toggle"><input type="checkbox" checked={enabled ?? data.enabled} disabled={!data.canConfigure || busy || online === false} onChange={event => setEnabled(event.target.checked)}/><span>{t("允许已绑定的成员使用 Steam 登录")}</span></label>
        {!data.canConfigure && <p className="muted">{t("当前账号仅可查看此配置。")}</p>}
        {error && <Notice title={typeof error==='string'?t(error):t(error.source,error.params)} tone="error"/>}
        <div className="platform-actions"><Button kind="primary" disabled={!data.canConfigure || busy || online === false || enabled === data.enabled} onClick={() => save(data)}>{busy ? t("正在保存…") : t("保存登录设置")}</Button><Button disabled={busy} onClick={() => { pending.current = null; setError(''); query.retry(); }}>{t("重新读取")}</Button></div>
      </Panel>
      <Panel><h2>Steam Web API Key</h2><p className="muted">{t("公开资料、封禁和库存同步使用单独的 Web API Key；它不参与 Steam 登录验证。")}</p>{canManageSource && <AppLink className="button" to="/admin/platforms/sources">{t("管理 Steam 数据来源")}</AppLink>}</Panel>
    </>}</QueryState>
  </section>;
}
