import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';
import { useApp, AppLink } from '../context.jsx';
import { Badge, Button, Panel } from '../ui.jsx';
import { commandNames, invalidateWipe } from './model.js';
import { listPendingAdminOperations, subscribeAdminOperations, clearAdminOperation } from './operation.js';

const enc = encodeURIComponent;
const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
function describe(operation) {
  const p = operation.path, wipe = p.match(/^\/api\/v2\/wipes\/([^/]+)(.*)$/), intent = p.match(/^\/api\/v2\/publish-intents\/([^/]+)/), delivery = p.match(/^\/api\/v2\/deliveries\/([^/]+)/);
  if (p === '/api/v2/wipes') return { label: operation.body?.publishImmediately ? '创建并开放报名' : '新建档期草稿', resource: '档期 ID 等待回执', to: '/admin/wipes/new' };
  if (wipe) {
    const id = decode(wipe[1]), suffix = wipe[2], base = `/admin/wipes/${enc(id)}`;
    if (suffix.startsWith('/signups/')) return { label: '管理员代报名', resource: t('档期 {id}', { id }), wipeId: id, memberId: decode(suffix.slice('/signups/'.length)), to: `${base}?tab=roster` };
    if (suffix === '/notification-previews') return { label: '保存通知预览', resource: t('档期 {id}', { id }), wipeId: id, to: `${base}/notifications` };
    if (suffix === '/publish-intents') return { label: '保存通知投递安排', resource: t('档期 {id}', { id }), wipeId: id, to: `${base}/notifications` };
    const command = suffix.match(/^\/commands\/([^/]+)$/)?.[1];
    return { label: command ? commandNames[command] || '档期操作' : '保存档期安排', resource: t('档期 {id}', { id }), wipeId: id, to: command ? base : `${base}?edit=1` };
  }
  if (intent) { const id = decode(intent[1]); return { label: '重试已知失败目标', resource: t('通知意图 {id}', { id }), intentId: id, to: `/admin/publish-intents/${enc(id)}` }; }
  if (delivery) { const id = decode(delivery[1]); return { label: p.endsWith('/reconcile') ? '核实单目标投递' : p.endsWith('/cancel') ? '取消目标投递' : '重试已知失败投递', resource: t('投递 {id}', { id }), deliveryId: id, to: `/admin/deliveries/${enc(id)}` }; }
  return { label: '管理员操作', resource: '原操作编号见下方', to: '/admin/wipes' };
}
function invalidateCommitted(client, operation, current, info) {
  if (operation.domain === 'scheduling') {
    const wipeId = info.wipeId || current?.id; if (wipeId) invalidateWipe(client, wipeId);
    if (info.memberId) client.invalidateQueries(['admin-signup', info.wipeId, info.memberId]);
    return;
  }
  for (const key of [['notification-intents'], ['notification-intent'], ['notification-delivery'], ['admin-wipes']]) client.invalidateQueries(key);
}

export function PendingAdminOperations() {
  const { client, path } = useApp(), [pending, setPending] = useState([]);
  const pathRef = useRef(path); pathRef.current = path;
  useEffect(() => {
    let active = true, queued = false;
    const read = () => {
      queued = false; if (!active) return;
      const entries = listPendingAdminOperations(client).map(entry => ({ ...entry, state: entry.operation.getState() }));
      if (active) setPending(entries);
    };
    const schedule = () => { if (!queued && active) { queued = true; queueMicrotask(read); } };
    const unsubscribe = subscribeAdminOperations(client, schedule);
    const unsubscribeIdentity = client.subscribeIdentity(() => { if (active) setPending([]); });
    read();
    return () => { active = false; unsubscribe(); unsubscribeIdentity(); };
  }, [client]);
  async function run(entry, method) {
    const generation = client.getGeneration(), state = await entry.operation[method]();
    if (generation !== client.getGeneration() || state.status !== 'committed') return;
    const info = describe(entry.operation), current = state.current;
    invalidateCommitted(client, entry.operation, current, info);
    // A creation reconciled while its editor is absent has already been consumed
    // here. Do not make a future unrelated "new draft" page reuse that result.
    if (entry.operation.path === '/api/v2/wipes' && !pathRef.current.startsWith('/admin/wipes/new')) clearAdminOperation(client, entry.slot);
  }
  if (!pending.length) return null;
  return <Panel className="panel admin-stack" aria-label={t("未完成管理员操作")}>
    {pending.length > 0 && <><h2>{t("待核实的管理员操作")} <Badge>{pending.length}</Badge></h2><p className="caption">{t("这些操作来自当前账号。已保留原内容与操作编号，刷新或切换页面后仍可核实；暂时查不到回执不代表未提交。")}</p>
      {pending.map(entry => { const info = describe(entry.operation), sending = entry.state.status === 'submitting'; return <div className="admin-card" key={entry.slot}>
        <div className="admin-row"><strong>{t(info.label)}</strong><Badge>{sending ? t('正在提交') : t('等待核实')}</Badge></div><p className="caption">{t(info.resource)}</p><p className="caption">{t("操作编号")} <code>{entry.operation.operationId}</code></p>
        {entry.state.error?.errorCode === 'IDEMPOTENCY_CONFLICT' && <p>{t("此编号存在内容冲突，需核实原操作；不会自动生成新编号。")}</p>}
        {entry.state.error?.errorCode === 'ADMIN_OPERATION_STORAGE_UNAVAILABLE' && <p>{t("会话存储暂不可用，本次重试未发出；仍可读取回执核实。")}</p>}
        <div className="admin-row"><Button disabled={sending} onClick={() => run(entry, 'reconcile')}>{t("核实原操作")}</Button><Button disabled={sending} onClick={() => run(entry, 'retry')}>{t("用原编号重试")}</Button><AppLink to={info.to}>{t("打开来源页面")}</AppLink></div>
      </div>; })}</>}
  </Panel>;
}
