import React, { useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Check, CircleCheck, CircleX, Clock3, Copy, ExternalLink, Hash, RefreshCw, Search, Users } from 'lucide-react';
import { AppLink, useApp } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Avatar, Badge, Button, Notice, Panel, QueryState } from '../ui.jsx';
import { Select } from '../select.jsx';
import { arrivalTime, time } from '../format.js';
import { displayTimeZone } from '../display-preferences.js';
import { t } from '../i18n.js';
import './open-signups.css';

const base = '/admin/bot/open-signups';
const endpoint = '/api/v2/bot-admin/open-signups';
const statuses = { queued: '等待发布', running: '正在发布', published: '已发布', failed: '发布失败', unknown: '发布结果待核实', cancelled: '已取消发布' };
const responses = [['accepted', '参加', CircleCheck], ['declined', '不参加', CircleX], ['late', '迟到', Clock3]];
const positivePage = value => /^\d{1,6}$/.test(String(value || '')) && Number(value) > 0 ? Number(value) : 1;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const profileHref = id => /^\d{5,25}$/.test(String(id || '')) ? `https://discord.com/users/${id}` : null;
const messageHref = value => /^https:\/\/discord\.com\/channels\/\d{5,25}\/\d{5,25}\/\d{5,25}$/.test(value || '') ? value : null;

export function openSignupLocation(path = base) {
  const url = new URL(path, 'https://local.invalid');
  const match = url.pathname.match(/^\/admin\/bot\/open-signups\/([^/]+)$/);
  let id = null;
  if (match) { try { id = decodeURIComponent(match[1]); } catch { /* Invalid routes show a read error rather than throwing. */ } }
  const params = url.searchParams;
  return { id, params, filters: { serverId: params.get('serverId') || '', guildId: params.get('guildId') || '',
    from: params.get('from') || '', to: params.get('to') || '', status: Object.hasOwn(statuses, params.get('status')) ? params.get('status') : '',
    q: (params.get('q') || '').slice(0, 100), sort: params.get('sort') === 'createdAt' ? 'createdAt' : 'wipeAt',
    order: params.get('order') === 'asc' ? 'asc' : 'desc', page: positivePage(params.get('page')) } };
}

export function openSignupListUrl(filters = {}) {
  const params = new URLSearchParams();
  for (const key of ['serverId', 'guildId', 'from', 'to', 'status', 'q']) if (filters[key]) params.set(key, String(filters[key]).trim());
  if (filters.sort && filters.sort !== 'wipeAt') params.set('sort', filters.sort);
  if (filters.order === 'asc') params.set('order', 'asc');
  if (positivePage(filters.page) > 1) params.set('page', String(positivePage(filters.page)));
  return `${base}${params.size ? `?${params}` : ''}`;
}

function nextDate(value) {
  if (!datePattern.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw new Error('OPEN_SIGNUP_DATE_INVALID');
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function dateBoundary(value, zone) {
  nextDate(value);
  // Calendar filters use the website display zone, never the browser/host UTC
  // offset. A midnight fold starts at its first occurrence; a gap starts at the
  // first available minute of that day.
  for (let minute = 0; minute < 1440; minute++) {
    const localDateTime = `${value}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    try { return arrivalTime(localDateTime, zone); }
    catch (error) {
      if (error.errorCode === 'TIME_AMBIGUOUS' && error.candidates?.[0]?.utc) return error.candidates[0].utc;
      if (error.errorCode !== 'TIME_NONEXISTENT') throw error;
    }
  }
  throw new Error('OPEN_SIGNUP_DATE_INVALID');
}

export function openSignupListRequest(filters, zone) {
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('OPEN_SIGNUP_DATE_ORDER');
  const params = new URLSearchParams({ page: String(positivePage(filters.page)), pageSize: '25', sort: filters.sort || 'wipeAt', order: filters.order || 'desc' });
  for (const key of ['serverId', 'guildId', 'status', 'q']) if (filters[key]) params.set(key, String(filters[key]).trim());
  if (filters.from) params.set('from', dateBoundary(filters.from, zone));
  if (filters.to) params.set('to', dateBoundary(nextDate(filters.to), zone));
  return `${endpoint}?${params}`;
}

export function openSignupReturnTo(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^\/admin\/bot\/open-signups(?:\?[^#]*)?$/.test(value)) return base;
  return openSignupListUrl(openSignupLocation(value).filters);
}

function PublishedState({ publication }) {
  const status = publication?.status;
  return <span className={`open-signup-publication ${Object.hasOwn(statuses, status) ? status : 'unknown'}`}><i aria-hidden="true"/>{t(statuses[status] || '发布状态待核实')}</span>;
}

function ResponseCounts({ counts = {} }) {
  return <div className="open-signup-inline-counts">{responses.map(([key, label, Icon]) => <span className={key} key={key} title={t(label)}><Icon size={13}/><span className="sr-only">{t(label)} </span>{counts[key] || 0}</span>)}</div>;
}

function CopyValue({ value, label = '复制 Discord ID', compact = false }) {
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(String(value)); setFeedback('已复制'); }
    catch { setFeedback('复制失败，请手动复制'); }
  }
  return <span className={`open-signup-copy${compact ? ' compact' : ''}`}>
    <button type="button" aria-label={t(label)} title={t(label)} onClick={copy}>{feedback === '已复制' ? <Check size={13}/> : <Copy size={13}/>}</button>
    {feedback && <span className="open-signup-copy-feedback" role="status">{t(feedback)}</span>}
  </span>;
}

function DiscordPerson({ person, showId = false, avatar = false }) {
  const id = person?.discordId || '', name = person?.name || id || t('未记录'), link = profileHref(id);
  return <div className="open-signup-person">{avatar && <Avatar name={name} size={34}/>}<div className="open-signup-person-text">{link
    ? <a className="open-signup-profile" href={link} target="_blank" rel="noopener noreferrer" title={t('查看 {name} 的 Discord 资料', {name})}>{name}<ExternalLink size={12}/></a>
    : <span>{name}</span>}{showId && id && <div className="open-signup-person-id"><span>{id}</span><CopyValue value={id} compact/></div>}</div></div>;
}

function ReadStamp({ value, zone }) {
  return <span className="open-signup-read-stamp">{value ? t('最后读取：{time}', { time: time(value, zone) }) : t('等待首次读取')}</span>;
}

function Pagination({ data, to, noun = '条记录' }) {
  if (!data || data.pages <= 1 && data.page <= 1) return null;
  return <nav className="open-signup-pagination" aria-label={t('分页')}><span>{t('共 {count} {unit}', {count: data.total || 0, unit: t(noun)})}</span><div>
    {data.page > 1 ? <AppLink className="button" to={to(data.page - 1)}><ArrowLeft size={14}/>{t('上一页')}</AppLink> : <Button disabled><ArrowLeft size={14}/>{t('上一页')}</Button>}
    <span>{t('第 {page} / {pages} 页', {page: data.page || 1, pages: Math.max(1, data.pages || 1)})}</span>
    {data.page < data.pages ? <AppLink className="button" to={to(data.page + 1)}>{t('下一页')}<ArrowRight size={14}/></AppLink> : <Button disabled>{t('下一页')}<ArrowRight size={14}/></Button>}
  </div></nav>;
}

function SelectFilter({ label, value, options = [], allLabel, onChange }) {
  return <label>{t(label)}<Select aria-label={t(label)} value={value} onChange={event => onChange(event.target.value)}><option value="">{t(allLabel)}</option>
    {value && !options.some(item => item.id === value) && <option value={value}>{value}</option>}
    {options.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
  </Select></label>;
}

function SignupFilters({ filters, data, apply }) {
  const [draft, setDraft] = useState(filters), [error, setError] = useState('');
  const {zone = displayTimeZone()} = useApp();
  const change = (key, value) => {setDraft(previous => ({...previous, [key]: value})); setError('');};
  const active = ['serverId', 'guildId', 'from', 'to', 'status', 'q'].some(key => filters[key]);
  function submit(event) {
    event.preventDefault();
    try { openSignupListRequest(draft, zone); apply({...draft, page: 1}); }
    catch { setError('请检查日期范围，结束日期不能早于开始日期。'); }
  }
  return <form className="open-signup-filters" onSubmit={submit}>
    <div className="open-signup-filter-fields">
      <SelectFilter label="游戏服务器" allLabel="全部游戏服务器" value={draft.serverId} options={data?.filters?.servers} onChange={value => change('serverId', value)}/>
      <SelectFilter label="Discord 服务器" allLabel="全部 Discord 服务器" value={draft.guildId} options={data?.filters?.guilds} onChange={value => change('guildId', value)}/>
      <fieldset className="open-signup-date-range"><legend>{t('Wipe 日期范围')}</legend><div><input type="date" aria-label={t('Wipe 开始日期')} value={draft.from} max={draft.to || undefined} onChange={event => change('from', event.target.value)}/><span>—</span><input type="date" aria-label={t('Wipe 结束日期')} value={draft.to} min={draft.from || undefined} onChange={event => change('to', event.target.value)}/></div></fieldset>
      <label>{t('发布状态')}<Select aria-label={t('发布状态')} value={draft.status} onChange={event => change('status', event.target.value)}><option value="">{t('全部状态')}</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</Select></label>
      <label className="open-signup-record-search">{t('搜索记录')}<span className="open-signup-search"><Search size={15}/><input aria-label={t('搜索报名记录')} maxLength={100} value={draft.q} placeholder={t('游戏服务器、频道或创建者 ID')} onChange={event => change('q', event.target.value)}/></span></label>
      <div className="open-signup-filter-actions"><button className="button primary" type="submit">{t('筛选')}</button>{active && <Button kind="ghost" onClick={() => apply({sort: filters.sort, order: filters.order})}>{t('重置')}</Button>}</div>
    </div>
    {error && <p className="open-signup-filter-error" role="alert">{t(error)}</p>}
  </form>;
}

export function OpenSignupList() {
  const {client, path, go, zone = displayTimeZone(), online} = useApp();
  const {filters} = openSignupLocation(path);
  let request, filterError;
  try { request = openSignupListRequest(filters, zone); } catch { filterError = true; request = endpoint; }
  const query = useQuery(client, ['bot-open-signups', request], request, {enabled: !filterError});
  const apply = next => go(openSignupListUrl(next));
  const listUrl = openSignupListUrl(filters);
  const filtered = ['serverId', 'guildId', 'from', 'to', 'status', 'q'].some(key => filters[key]);
  return <section className="open-signups">
    <header className="open-signup-heading"><div><div className="open-signup-heading-title"><h2>{t('开放报名')}</h2><Badge>Discord</Badge></div></div><Button disabled={query.refreshing || online === false || filterError} onClick={() => query.retry().catch(() => {})}><RefreshCw size={15} className={query.refreshing ? 'open-signup-spinning' : ''}/>{t(query.refreshing ? '正在刷新…' : '刷新')}</Button></header>
    <Panel className="panel open-signup-list-panel"><SignupFilters key={listUrl} filters={filters} data={query.data} apply={apply}/>
      <div className="open-signup-list-meta"><div><span>{query.data ? t('{count} 条报名记录', {count: query.data.total}) : t('报名记录')}</span><span className="open-signup-zone"><Clock3 size={13}/>{zone}</span></div><label className="open-signup-sort"><span>{t('排序')}</span><Select aria-label={t('报名记录排序')} value={`${filters.sort}:${filters.order}`} onChange={event => {const [sort, order] = event.target.value.split(':'); apply({...filters, sort, order, page: 1});}}>
        <option value="wipeAt:desc">{t('Wipe 时间：从晚到早')}</option><option value="wipeAt:asc">{t('Wipe 时间：从早到晚')}</option><option value="createdAt:desc">{t('创建时间：由新到旧')}</option><option value="createdAt:asc">{t('创建时间：由旧到新')}</option>
      </Select></label></div>
      {filterError ? <Notice tone="error" title={t('请检查日期范围，结束日期不能早于开始日期。')}/> : <QueryState query={query}>{data => <>
        {data.items.length ? <div className="open-signup-table-scroll"><table className="open-signup-records"><colgroup><col className="game"/><col className="wipe"/><col className="guild"/><col className="creator"/><col className="counts"/><col className="publication"/><col className="action"/></colgroup><thead><tr><th>{t('游戏服务器')}</th><th>{t('Wipe 日期与时间')}</th><th>{t('Discord 服务器 / 频道')}</th><th>{t('创建者 / 创建时间')}</th><th><div className="open-signup-count-heading">{responses.map(([key, label, Icon]) => <span key={key} title={t(label)}><Icon size={13}/>{t(label)}</span>)}</div></th><th>{t('发布状态')}</th><th><span className="sr-only">{t('操作')}</span></th></tr></thead><tbody>{data.items.map(item => {
          const href = `${base}/${encodeURIComponent(item.id)}?returnTo=${encodeURIComponent(listUrl)}`;
          return <tr key={item.id}><td><AppLink className="open-signup-game-link" to={href}>{item.server?.name || t('未记录')}</AppLink></td><td><span className="open-signup-date">{time(item.wipeAt, zone)}</span>{Date.parse(item.wipeAt) < Date.parse(data.readAt) && <small className="open-signup-past" title={t('Wipe 时间已过去，不代表报名已关闭。')}>{t('Wipe 已过去')}</small>}</td><td><span className="open-signup-guild-name">{item.guild?.name || item.guild?.id || '—'}</span><small className="open-signup-channel"><Hash size={11}/>{item.channel?.name || item.channel?.id || '—'}</small></td><td><DiscordPerson person={item.creator}/><small>{time(item.createdAt, zone)}</small></td><td><ResponseCounts counts={item.counts}/></td><td><PublishedState publication={item.publication}/></td><td><AppLink className="open-signup-detail-link" to={href} aria-label={t('查看 {name} 的报名名单', {name: item.server?.name || item.id})}>{t('查看')}<ArrowRight size={14}/></AppLink></td></tr>;
        })}</tbody></table></div> : <div className="open-signup-empty"><CalendarDays size={28}/><h3>{t(filtered ? '没有匹配的报名记录' : '还没有开放报名记录')}</h3><p>{t(filtered ? '调整筛选条件，或查看其他 Wipe 日期。' : '在 Discord 使用 /newwipe 发布后，创建记录和人员名单会显示在这里。')}</p>{filtered && <Button onClick={() => apply({})}>{t('清除筛选')}</Button>}</div>}
        <Pagination data={data} to={page => openSignupListUrl({...filters, page})}/><div className="open-signup-list-footer"><span>{t('仅显示当前账号有权查看的记录。')}</span><ReadStamp value={data.readAt} zone={zone}/></div>
      </>}</QueryState>}
    </Panel>
  </section>;
}

function CardInformation({ card, zone }) {
  const update = card.update;
  return <aside className="open-signup-card-information"><Panel><h3>{t('卡片信息')}</h3><dl>
    <div><dt>{t('Discord 服务器')}</dt><dd>{card.guild?.name || card.guild?.id || '—'}{card.guild?.name && <small>{card.guild.id}</small>}</dd></div>
    <div><dt>{t('发布频道')}</dt><dd><Hash size={12}/>{card.channel?.name || card.channel?.id || '—'}</dd></div>
    <div><dt>{t('创建者')}</dt><dd><DiscordPerson person={card.creator}/></dd></div>
    <div><dt>{t('创建时间')}</dt><dd>{time(card.createdAt, zone)}</dd></div>
    <div><dt>{t('卡片更新时间')}</dt><dd>{time(card.updatedAt, zone)}</dd></div>
    <div><dt>{t('原设置时区')}</dt><dd>{card.timeZone || '—'}<small>{time(card.wipeAt, card.timeZone || zone)}</small></dd></div>
  </dl><div className="open-signup-connect"><h4>{t('服务器直连')}</h4>{card.settings?.directConnect ? <div><code>{card.settings.directConnect}</code><CopyValue value={card.settings.directConnect} label="复制服务器直连"/></div> : <p>{t('未填写直连信息')}</p>}{card.resolvedIp?.command && <><h4>{t('备用直连')}</h4><div><code>{card.resolvedIp.command}</code><CopyValue value={card.resolvedIp.command} label="复制备用直连"/></div></>}</div>
    <div className="open-signup-notes"><h4>{t('备注')}</h4><p>{card.settings?.notes || t('暂无备注')}</p></div>
    <div className="open-signup-delivery"><h4>{t('发布结果')}</h4><PublishedState publication={card.publication}/>{card.publication?.updatedAt && <small>{time(card.publication.updatedAt, zone)}</small>}{card.publication?.errorCode && <code>{card.publication.errorCode}</code>}
      {update && <div><h4>{t('最近更新结果')}</h4><span>{t(({queued:'更新已排队',running:'正在更新',succeeded:'更新已完成',failed:'更新失败',unknown:'更新结果待核实',result_unknown:'更新结果待核实',cancelled:'更新已取消',skipped:'已跳过更新'})[update.status] || '更新结果待核实')}</span>{update.updatedAt && <small>{time(update.updatedAt, zone)}</small>}{update.errorCode && <code>{update.errorCode}</code>}</div>}
    </div>
  </Panel><p className="open-signup-settings-hint">{t('修改卡片设置，请打开 Discord 原消息并点击 Settings。')}</p></aside>;
}

export function OpenSignupDetail({ id }) {
  const {client, path, go, zone = displayTimeZone(), online} = useApp();
  const {params} = openSignupLocation(path);
  const response = responses.some(([key]) => key === params.get('response')) ? params.get('response') : 'accepted';
  const search = (params.get('attendee') || '').slice(0, 100), page = positivePage(params.get('page'));
  const [draftSearch, setDraftSearch] = useState(search), [refreshing, setRefreshing] = useState(false);
  const returnTo = openSignupReturnTo(params.get('returnTo'));
  const detailEndpoint = `${endpoint}/${encodeURIComponent(id)}`;
  const query = useQuery(client, ['bot-open-signup', id], detailEndpoint);
  const rosterParams = new URLSearchParams({response, q: search, page: String(page), pageSize: '25'});
  const rosterEndpoint = `${detailEndpoint}/signups?${rosterParams}`;
  const roster = useQuery(client, ['bot-open-signup-roster', id, rosterEndpoint], rosterEndpoint);
  const detailUrl = changes => {
    const next = new URLSearchParams({returnTo, response, ...(search ? {attendee: search} : {}), ...(page > 1 ? {page: String(page)} : {})});
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, String(value)) : next.delete(key);
    return `${base}/${encodeURIComponent(id)}?${next}`;
  };
  async function refresh() {setRefreshing(true); try {await Promise.allSettled([query.retry(), roster.retry()]);} finally {setRefreshing(false);}}
  return <section className="open-signups"><AppLink className="back-link" to={returnTo}><ArrowLeft size={14}/>{t('返回开放报名')}</AppLink>
    <QueryState query={query}>{card => <>
      <header className="open-signup-heading detail"><div><div className="open-signup-heading-title"><h2>{card.server?.name || t('开放报名')}</h2><Badge>Discord</Badge></div><p><CalendarDays size={15}/>{t('Wipe：{time}', {time: time(card.wipeAt, zone)})}<span className="open-signup-zone">{zone}</span></p><PublishedState publication={card.publication}/></div><div className="open-signup-heading-actions"><Button disabled={refreshing || query.refreshing || roster.refreshing || online === false} onClick={refresh}><RefreshCw size={15} className={refreshing ? 'open-signup-spinning' : ''}/>{t(refreshing ? '正在刷新…' : '刷新')}</Button>{messageHref(card.publication?.messageUrl) && <a className="button primary" href={messageHref(card.publication.messageUrl)} target="_blank" rel="noopener noreferrer">{t('打开 Discord 原消息')}<ExternalLink size={15}/></a>}</div></header>
      <div className="open-signup-detail-grid"><Panel className="panel open-signup-roster"><div className="open-signup-roster-heading"><h3><Users size={18}/>{t('报名名单')}</h3><ReadStamp value={roster.data?.readAt} zone={zone}/></div>
        <nav className="open-signup-response-tabs" aria-label={t('报名状态')}>{responses.map(([key, label, Icon]) => <AppLink key={key} aria-current={response === key ? 'page' : undefined} className={key} to={detailUrl({response: key, page: null})}><Icon size={17}/>{t(label)}<strong>{roster.data?.counts?.[key] ?? card.counts?.[key] ?? 0}</strong></AppLink>)}</nav>
        <form className="open-signup-roster-search" onSubmit={event => {event.preventDefault(); go(detailUrl({attendee: draftSearch.trim(), page: null}));}}><label className="open-signup-search"><Search size={15}/><input aria-label={t('搜索 Discord 昵称或 ID')} value={draftSearch} maxLength={100} onChange={event => setDraftSearch(event.target.value)} placeholder={t('搜索 Discord 昵称或 ID')}/></label><button className="button" type="submit">{t('搜索')}</button>{search && <Button kind="ghost" onClick={() => {setDraftSearch(''); go(detailUrl({attendee: null, page: null}));}}>{t('清除')}</Button>}</form>
        <QueryState query={roster}>{data => <>
          {data.items.length ? <div className="open-signup-table-scroll"><table className="open-signup-attendees"><colgroup><col/><col/><col/></colgroup><thead><tr><th>{t('Discord 用户')}</th><th>{t('当前状态')}</th><th>{t('最后更新时间')}</th></tr></thead><tbody>{data.items.map(person => <tr key={person.discordId}><td><DiscordPerson person={person} avatar showId/></td><td><span className={`open-signup-response ${person.response}`}>{t(responses.find(([key]) => key === person.response)?.[1] || '未记录')}</span></td><td>{time(person.updatedAt, zone)}</td></tr>)}</tbody></table></div> : <div className="open-signup-empty roster"><Users size={26}/><h3>{t(search ? '没有匹配的 Discord 用户' : '该状态下暂无报名人员')}</h3><p>{t(search ? '请尝试其他昵称或 Discord ID。' : 'Discord 上的最新回应会显示在这里。')}</p></div>}
          <Pagination data={data} noun="位用户" to={page => detailUrl({page})}/>
        </>}</QueryState>
      </Panel><CardInformation card={card} zone={zone}/></div>
    </>}</QueryState>
  </section>;
}

export default function OpenSignups() {
  const {path} = useApp(), location = openSignupLocation(path);
  return location.id ? <OpenSignupDetail key={`${location.id}:${location.params.get('attendee') || ''}`} id={location.id}/> : <OpenSignupList/>;
}
