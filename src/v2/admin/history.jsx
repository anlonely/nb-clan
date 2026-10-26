import React, { useEffect, useReducer } from 'react';
import { t } from '../i18n.js';
import { useApp } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Button, Badge, Panel, Notice, QueryState } from '../ui.jsx';
import { time } from '../format.js';
import { historyEventView, historyFailure, historyPagination, initialHistoryPage } from './history-model.js';

const safeTime = (value, zone) => { try { return value ? time(value, zone) : t('未记录'); } catch { return t('时间或时区待核实'); } };
function Person({ person, isSelf = false }) {
  const name = person.current
    ? isSelf && person.text.startsWith('本人 · ') ? `${t('本人')} · ${person.text.slice(5)}` : person.text
    : t(person.text);
  return <span aria-label={person.current ? t('{name}（当前显示名）', { name }) : undefined}>{name}</span>;
}

export function HistoryEvent({ event, zone }) {
  const row = historyEventView(event);
  const state = row.state?.filter(([label, value]) => ['档期状态', '结束结果', '报名窗口'].includes(label) && value !== '未记录').map(([, value]) => t(value)) || [];
  const fields = row.changedFields.filter(label => !['档期状态', '归档版本', '内容版本', '报名版本', '已确认内容版本'].includes(label)).map(t);
  const showFields = event.action === 'wipe.edit' && fields.length > 0;
  const detail = showFields ? t('调整：{fields}{more}', { fields: fields.slice(0, 4).join(', '), more: fields.length > 4 ? t('等 {count} 项', { count: fields.length }) : '' })
    : state.join(' · ') || (fields.length ? t('更新：{fields}{more}', { fields: fields.slice(0, 4).join(', '), more: fields.length > 4 ? t('等 {count} 项', { count: fields.length }) : '' }) : '');
  return <li className={`wipe-history-event ${row.kind}`}>
    <time dateTime={row.occurredAt || undefined}>{safeTime(row.occurredAt, zone)}</time>
    <div className="wipe-history-event-body">
      <div className="wipe-history-event-heading"><h3>{row.kind === 'signup' && row.subject ? <><Person person={row.subject}/> · </> : null}{t(row.action)}</h3><Badge>{t(row.source)}</Badge></div>
      {row.kind === 'signup' && row.signup ? <p className="wipe-history-detail"><span>{t("报名回复")}</span><strong>{t(row.signup.response)}</strong>{row.signup.response === '晚些到' && row.signup.expectedArrivalAt && <> {t("· 预计到场")} {safeTime(row.signup.expectedArrivalAt, zone)}</>}</p>
        : detail && <p className="wipe-history-detail">{detail}</p>}
      {!row.selfSignup && <p className="wipe-history-actor">{t("操作人")} <Person person={row.actor} isSelf={Boolean(event.actor?.isSelf)}/></p>}
      {row.reason && <p className="wipe-history-reason">{t("备注：")}{row.reason}</p>}
    </div>
  </li>;
}

export default function WipeHistory({ wipeId }) {
  // Changing wipes starts a fresh cursor scope before useQuery can issue a read.
  return <HistoryContent key={wipeId} wipeId={wipeId}/>;
}

function HistoryContent({ wipeId }) {
  const { client, zone } = useApp(), [page, move] = useReducer(historyPagination, undefined, initialHistoryPage);
  const query = useQuery(client, ['admin-history', wipeId, page.cursor], `/api/v2/wipes/${encodeURIComponent(wipeId)}/history?limit=20${page.cursor ? `&cursor=${encodeURIComponent(page.cursor)}` : ''}`);
  const failure = historyFailure(query.error);
  useEffect(() => {
    if (query.error?.errorCode !== 'CURSOR_EXPIRED' || !page.cursor) return;
    move({ type: 'expired' }); client.invalidateQueries(['admin-history', wipeId, '']);
  }, [query.error, page.cursor, client, wipeId]);
  return <Panel className="wipe-history-panel"><div className="wipe-history-heading"><div><h2>{t("变更记录")}</h2><p>{t("安排与报名的已提交变化，按时间从近到远排列。")}</p></div></div>
    {page.resetNotice && <Notice title={t("历史分页已过期，已返回第一页")}>{query.loading || query.refreshing ? t('正在重新读取当前有权查看的事件。') : t('已从第一页重新读取当前有权查看的事件。')}</Notice>}
    {failure?.hideData ? <Notice tone="error" title={t(failure.title)} action={<Button onClick={() => query.retry().catch(() => {})}>{t("重新读取历史")}</Button>}>{t(failure.detail)}</Notice>
      : <QueryState query={{...query,retry:()=>query.retry().catch(()=>{})}}>{data => <>
        {data.items.length ? <ol className="wipe-history-list">{data.items.map(event => <HistoryEvent key={event.id} event={event} zone={zone}/>)}</ol>
          : <p role="status">{t("当前权限下暂无可查看的本场事件。")}</p>}
        {(page.previous.length > 0 || data.nextCursor) && <nav className="wipe-history-pagination" aria-label={t("变更记录翻页")}>
          <Button disabled={!page.previous.length || query.loading || query.refreshing || Boolean(query.error)} onClick={() => move({ type: 'previous' })}>{t("上一页")}</Button>
          <span>{t('第 {page} 页 · 本页 {count} 条', { page: page.previous.length + 1, count: data.items.length })}</span>
          <Button disabled={!data.nextCursor || query.loading || query.refreshing || Boolean(query.error)} onClick={() => move({ type: 'next', cursor: data.nextCursor })}>{t("下一页")}</Button>
        </nav>}
        <p className="wipe-history-footnote">{t("仅显示当前有权查看的记录；姓名按当前成员资料显示。")}</p>
      </>}</QueryState>}
  </Panel>;
}
