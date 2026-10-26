import React, {useEffect, useRef, useState} from 'react';
import {Check, ChevronDown, ExternalLink, Link2, Plus, RefreshCw, Search, Trash2, Undo2, Users, Zap} from 'lucide-react';
import {t, getUiLocale} from '../i18n.js';
import {useApp, AppLink} from '../context.jsx';
import UnsavedChanges from '../bot-admin/unsaved-changes.jsx';
import {useQuery} from '../use-query.jsx';
import {Button, Badge, Notice, Panel, QueryState, Modal, Avatar} from '../ui.jsx';
import {Select} from '../select.jsx';
import {notifySuccess} from '../toast.jsx';
import './electricians.css';

const endpoint = '/api/v2/platform-admin/electricians';
const steam = value => /^\d{17}$/.test(value.trim()) ? `https://steamcommunity.com/profiles/${value.trim()}/` : value.trim().replace(/\?l=english$/, '').replace(/\/$/, '') + '/';
const entryKey = entry => entry.kind === 'manual' ? `manual:${steam(entry.url).toLowerCase()}` : entry.kind === 'member' ? `member:${entry.memberId}` : `specialty:${entry.specialty}:${entry.squadId || ''}`;
const profileId = url => new URL(url).pathname.split('/')[2];
function entryRows(entry, data) {
  if (entry.kind === 'manual') {
    const url = steam(entry.url), avatar = Object.values(data.resolved || {}).flat().find(row => row.url === url)?.avatar || data.members.find(member => steam(member.steamId) === url)?.avatar;
    return [{...entry, avatar}];
  }
  return data.members.filter(member => entry.kind === 'member' ? member.id === entry.memberId : member.specialties.includes(entry.specialty) && (!entry.squadId || member.squadIds.includes(entry.squadId))).map(member => ({name: member.name, url: steam(member.steamId), avatar: member.avatar}));
}
function resolvedRows(entries, data) {
  const groups = {CN: [], EU: []}, seen = new Set();
  for (const entry of entries) for (const row of entryRows(entry, data)) {
    const url = steam(row.url), key = url.toLowerCase();
    if (!seen.has(key)) {seen.add(key); groups[entry.group].push({...row, url});}
  }
  return groups;
}
function sourceName(entry, data) {
  return entry.kind === 'manual' ? entry.name : entry.kind === 'member' ? data.members.find(member => member.id === entry.memberId)?.name || t('成员已离队') : t(data.specialties[entry.specialty]);
}
const methods = [['manual', '手动添加', Link2], ['member', '选择成员', Users], ['specialty', '按专长', Zap]];

export default function Electricians({embedded = false}) {
  const {client, online} = useApp(), query = useQuery(client, ['platform-admin', 'electricians'], endpoint, {ttlMs: 15000});
  const [entries, setEntries] = useState([]), [kind, setKind] = useState('manual'), [group, setGroup] = useState('CN');
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [memberIds, setMemberIds] = useState([]), [search, setSearch] = useState('');
  const [specialty, setSpecialty] = useState('electricity'), [squadId, setSquadId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState(null), [undo, setUndo] = useState(null);
  const [sourceSearch, setSourceSearch] = useState(''), [filter, setFilter] = useState('all'), [discard, setDiscard] = useState(false);
  const pending = useRef(null), saved = useRef(null);
  useEffect(() => {
    if (!query.data || pending.current) return;
    // A background read must not replace an unsaved draft. Its original
    // revision remains the save precondition so a concurrent edit conflicts.
    if (saved.current && JSON.stringify(entries) !== JSON.stringify(saved.current.entries)) return;
    saved.current = {revision: query.data.revision, entries: query.data.entries};
    setEntries(query.data.entries); setUndo(null);
  }, [query.data?.revision]);
  function add(data) {
    let incoming;
    if (kind === 'manual') {
      if (!name.trim() || !/^https:\/\/steamcommunity\.com\/(?:profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?$/.test(steam(url))) {setError('请填写昵称和有效的 Steam 主页链接或 17 位 SteamID。'); return;}
      incoming = [{kind, group, name: name.trim(), url: steam(url)}];
    } else if (kind === 'member') {
      if (!memberIds.length) return;
      incoming = memberIds.map(memberId => ({kind, group, memberId}));
    } else {
      if (!data.canSelectSpecialty || !Object.hasOwn(data.specialties, specialty)) return;
      incoming = [{kind, group, specialty, squadId}];
    }
    const seen = new Set(entries.map(entryKey)), next = [...entries];
    for (const entry of incoming) if (!seen.has(entryKey(entry))) {seen.add(entryKey(entry)); next.push(entry);}
    if (next.length > 200) {setError('最多保存 200 个手动条目、成员或专长规则。'); return;}
    setError('');
    if (next.length === entries.length) {setFeedback({text: '这些来源已在名单中，无需重复添加。'}); return;}
    setUndo(entries); setEntries(next); setName(''); setUrl(''); setMemberIds([]);
    setFeedback({text: '已添加 {count} 个来源，保存后生效。', values: {count: next.length - entries.length}});
  }
  function remove(index) {
    setUndo(entries); setEntries(entries.filter((_, i) => i !== index)); setError('');
    setFeedback({text: '已移除来源，保存后生效。'});
  }
  async function reload(data) {
    if (busy || pending.current) return;
    saved.current = {revision: data.revision, entries: data.entries};
    setDiscard(false); setError(''); setFeedback(null); setUndo(null); setEntries(data.entries);
    try {await query.retry();} catch { /* QueryState displays the reload error. */ }
  }
  async function save(data) {
    if (busy || online === false || !data.canConfigure) return;
    // Retain both the original body and key across timeouts, including when
    // a background read observes a newer revision after the save committed.
    const operation = pending.current || {id: crypto.randomUUID(), body: {
      entries, expectedRevision: saved.current?.revision ?? data.revision
    }};
    pending.current = operation; setBusy(true); setError('');
    try {
      const response = await client.request(endpoint, {method: 'POST', body: operation.body, headers: {'Idempotency-Key': operation.id}});
      if (response.data.status && response.data.status !== 'succeeded') {
        setError('上次保存结果尚未确认，请先重试同次保存。'); return;
      }
      const current = response.data.current;
      if (!current || !Array.isArray(current.entries)) throw {errorCode: 'SAVE_RECEIPT_INVALID'};
      pending.current = null; saved.current = {revision: current.revision, entries: current.entries};
      setEntries(current.entries); setUndo(null); setFeedback(null);
      notifySuccess('电工 ID 已保存', {id: operation.id});
      // Reload failure is displayed by QueryState; the confirmed save remains
      // successful and must not turn into a new pending mutation.
      try {await query.retry();} catch { /* QueryState displays the read error. */ }
    } catch (cause) {
      if (cause.status >= 400 && cause.status < 500) pending.current = null;
      setError(cause.errorCode === 'REVISION_CONFLICT' ? '名单已在别处修改，请重新读取。' : {text: '{code} · 请重试同次保存。', values: {code: cause.errorCode || 'NETWORK_ERROR'}});
    } finally {setBusy(false);}
  }
  return <section className="electrician-admin"><UnsavedChanges dirty={Boolean(saved.current)&&JSON.stringify(entries)!==JSON.stringify(saved.current.entries)} pending={!!pending.current} onDiscard={()=>{setEntries(saved.current?.entries||query.data?.entries||[]);setError('');setFeedback(null);}}/>
    <header className="electrician-heading"><div><span className="eyebrow">Discord / KOOK</span><h2><Zap size={22}/>{t('电工ID')}</h2>{!embedded && <p>{t('统一管理电工好友，两端卡片共用同一份名单。')}</p>}</div><div className="cs-row-actions"><Badge>{t('共享名单')}</Badge><AppLink className="button" to="/admin/bot/tools?feature=electrician_ids_card">{t('预览 / 更新关联卡片')}</AppLink></div></header>
    <QueryState query={query}>{data => {
      const locked = busy || online === false || !data.canConfigure || Boolean(pending.current);
      const dirty = JSON.stringify(entries) !== JSON.stringify(saved.current?.entries ?? data.entries), rows = resolvedRows(entries, data);
      const members = data.members.filter(member => `${member.name} ${member.steamId}`.toLowerCase().includes(search.trim().toLowerCase()));
      const matched = data.members.filter(member => member.specialties.includes(specialty) && (!squadId || member.squadIds.includes(squadId)));
      const sources = entries.map((entry, index) => ({entry, index})).filter(({entry}) => (filter === 'all' || entry.group === filter) && `${sourceName(entry, data)} ${entry.url || ''} ${entry.kind === 'member' ? data.members.find(member => member.id === entry.memberId)?.steamId || '' : ''} ${data.squads.find(squad => squad.id === entry.squadId)?.name || ''}`.toLowerCase().includes(sourceSearch.trim().toLowerCase()));
      const canAdd = kind === 'manual' ? name.trim() && url.trim() : kind === 'member' ? memberIds.length : data.canSelectSpecialty && Object.hasOwn(data.specialties, specialty);
      return <>
        <div className="electrician-overview">
          {['CN', 'EU'].map(key => <div key={key} className={`electrician-stat ${key.toLowerCase()}`}><span className="electrician-region">{key}</span><div><span>{t(`${key}电工`)}</span><strong>{rows[key].length}{getUiLocale() === 'zh' && <small>{t('位')}</small>}</strong></div></div>)}
          <div className="electrician-stat"><span className="electrician-region"><Users size={20}/></span><div><span>{t('去重后总人数')}</span><strong>{rows.CN.length + rows.EU.length}{getUiLocale() === 'zh' && <small>{t('位')}</small>}</strong></div><Badge>{t('自动去重')}</Badge></div>
        </div>
        {!data.canConfigure && <Notice title={t('当前为只读模式，无法修改名单。')}/>}
        {online === false && <Notice title={t('当前离线，恢复连接后可继续编辑。')}/>}
        <div className="electrician-workspace">
          <Panel className="panel electrician-builder">
            <div className="electrician-panel-title"><h3><Plus size={17}/>{t('添加电工')}</h3></div>
            <div className="electrician-methods" role="group" aria-label={t('添加方式')}>
              {methods.filter(([key]) => key !== 'specialty' || data.canSelectSpecialty).map(([key, label, Icon]) => <button key={key} type="button" disabled={locked} aria-pressed={kind === key} onClick={() => {setKind(key); setError('');}}><Icon size={15}/>{t(label)}</button>)}
            </div>
            <form onSubmit={event => {event.preventDefault(); if (!locked && canAdd) add(data);}}>
              <fieldset disabled={locked} className="electrician-fields">
                <div><span className="electrician-field-label">{t('添加到分组')}</span><div className="electrician-group-choice" role="group" aria-label={t('添加到分组')}>{['CN', 'EU'].map(key => <button type="button" key={key} aria-pressed={group === key} onClick={() => setGroup(key)}>{t(`${key}电工`)}{group === key && <Check size={14}/>}</button>)}</div></div>
                {kind === 'manual' ? <>
                  <label>{t('昵称')}<input aria-label={t('昵称')} value={name} maxLength={80} placeholder={t('电工的游戏昵称')} onChange={event => setName(event.target.value)}/></label>
                  <label>{t('Steam 主页链接或 SteamID')}<input aria-label={t('Steam 主页链接或 SteamID')} value={url} maxLength={200} placeholder="7656119… / https://steamcommunity.com/…" onChange={event => setUrl(event.target.value)}/><small>{t('粘贴 Steam 主页链接或 17 位 SteamID。')}</small></label>
                </> : kind === 'member' ? <>
                  <label>{t('搜索成员')}<span className="electrician-search-box"><Search size={16}/><input aria-label={t('搜索成员')} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('昵称或 SteamID')}/></span></label>
                  <div className="electrician-selection-tools"><span>{t('已选 {count} 位', {count: memberIds.length})}</span><button type="button" disabled={!members.length} onClick={() => setMemberIds([...new Set([...memberIds, ...members.map(member => member.id)])])}>{t('全选搜索结果')}</button><button type="button" disabled={!memberIds.length} onClick={() => setMemberIds([])}>{t('清空选择')}</button></div>
                  <div className="electrician-member-picker">{members.map(member => <label key={member.id} className={memberIds.includes(member.id) ? 'selected' : ''}><input type="checkbox" checked={memberIds.includes(member.id)} onChange={event => setMemberIds(event.target.checked ? [...memberIds, member.id] : memberIds.filter(id => id !== member.id))}/><Avatar className="electrician-person-initial" name={member.name} src={member.avatar} size={32}/><span className="electrician-member-text"><strong>{member.name}</strong><small>{member.steamId}</small><span className="electrician-specialties">{member.specialties.map(key => <span key={key}>{t(data.specialties[key])}</span>)}</span></span></label>)}{!members.length && <p className="electrician-empty">{t('没有匹配的成员，请换个关键词。')}</p>}</div>
                </> : <>
                  <label>{t('专长')}<Select aria-label={t('专长')} value={specialty} onChange={event => setSpecialty(event.target.value)}>{Object.entries(data.specialties).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</Select></label>
                  <label>{t('队伍范围')}<Select aria-label={t('队伍范围')} value={squadId} onChange={event => setSquadId(event.target.value)}><option value="">{t('全部队伍')}</option>{data.squads.map(squad => <option key={squad.id} value={squad.id}>{squad.name}</option>)}</Select></label>
                  <div className="electrician-rule-summary"><Zap size={18}/><div><strong>{t('当前匹配 {count} 位成员', {count: matched.length})}</strong><small>{t('保存规则后，成员加入或专长变化会自动更新名单。')}</small></div></div>
                </>}
                {error && <Notice tone="error" title={typeof error === 'string' ? t(error) : t(error.text, error.values)}/>}
                <Button type="submit" kind="primary" disabled={locked || !canAdd}><Plus size={16}/>{kind === 'member' ? t('添加已选成员（{count}）', {count: memberIds.length}) : kind === 'specialty' ? t('添加自动规则') : t('添加到名单')}</Button>
                <small className="electrician-draft-hint">{t('添加后先预览，点击底部保存才会生效。')}</small>
              </fieldset>
            </form>
          </Panel>
          <Panel className="panel electrician-sources">
            <div className="electrician-panel-title"><h3>{t('名单来源')}<Badge>{entries.length}</Badge></h3><span>{t('手动 / 成员 / 专长规则')}</span></div>
            <div className="electrician-list-toolbar"><div className="electrician-filters" role="group" aria-label={t('筛选名单分组')}>{[['all', '全部'], ['CN', 'CN电工'], ['EU', 'EU电工']].map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{t(label)}<span>{key === 'all' ? entries.length : entries.filter(entry => entry.group === key).length}</span></button>)}</div><label className="electrician-search-box"><Search size={15}/><input aria-label={t('搜索名单来源')} value={sourceSearch} onChange={event => setSourceSearch(event.target.value)} placeholder={t('搜索昵称、SteamID 或专长')}/></label></div>
            <div className="electrician-source-list">{sources.map(({entry, index}) => {
              const label = sourceName(entry, data), profiles = entryRows(entry, data), link = entry.kind === 'specialty' ? null : profiles[0]?.url;
              return <div className="electrician-source-row" key={entryKey(entry)}>{entry.kind === 'specialty' ? <span className="electrician-source-icon specialty"><Zap size={17}/></span> : <Avatar className="electrician-source-icon" name={label} src={profiles[0]?.avatar} size={32}/>}<div className="electrician-source-main"><strong>{label}{link && <a href={steam(link)} target="_blank" rel="noopener noreferrer" aria-label={t('打开 {name} 的 Steam 主页', {name: label})}><ExternalLink size={13}/></a>}</strong><small>{entry.kind === 'manual' ? `Steam · ${profileId(steam(entry.url))}` : entry.kind === 'member' ? t('成员 · 自动跟随昵称') : `${data.squads.find(squad => squad.id === entry.squadId)?.name || t('全部队伍')} · ${t('匹配 {count} 位', {count: profiles.length})}`}</small></div><div className="electrician-source-tags"><span className={`electrician-group-tag ${entry.group.toLowerCase()}`}>{entry.group}</span><span className="electrician-kind-tag">{t(entry.kind === 'manual' ? '手动' : entry.kind === 'member' ? '成员' : '自动规则')}</span></div><Button kind="ghost" disabled={locked} aria-label={t('移除 {name}', {name: label})} onClick={() => remove(index)}><Trash2 size={14}/><span>{t('移除')}</span></Button></div>;
            })}{!sources.length && <div className="electrician-empty"><Users size={24}/><strong>{t(entries.length ? '没有匹配的来源' : '名单还没有来源')}</strong><p>{t(entries.length ? '试试其他分组或关键词。' : '从左侧添加电工、成员或专长规则。')}</p></div>}</div>
            <details className="electrician-preview"><summary><span><Users size={16}/>{t('最终名单预览')}<Badge>{rows.CN.length + rows.EU.length}</Badge></span><ChevronDown size={16}/></summary><p>{t('按 Steam 主页去重，这份名单用于 Discord 与 KOOK 卡片中的电工名单网页。')}</p><div className="electrician-preview-groups">{Object.entries(rows).map(([key, list]) => <section key={key}><h4>{t(`${key}电工`)}<span>{list.length}</span></h4>{list.map(row => <a key={row.url} href={row.url} target="_blank" rel="noopener noreferrer"><span>{row.name}</span><ExternalLink size={13}/></a>)}{!list.length && <p>{t('暂无电工')}</p>}</section>)}</div></details>
          </Panel>
        </div>
                {feedback && <div className="electrician-feedback" role="status"><Check size={16}/><span>{t(feedback.text, feedback.values)}</span>{undo && <Button kind="ghost" disabled={locked} onClick={() => {setEntries(undo); setUndo(null); setFeedback(null); setError('');}}><Undo2 size={15}/>{t('撤销上一步')}</Button>}</div>}
        <div className="electrician-savebar"><div><span className={`electrician-save-dot ${dirty ? 'dirty' : ''}`}/><div><strong>{t(dirty ? '有未保存的改动' : '所有更改已保存')}</strong><small>{t('版本')} {saved.current?.revision ?? data.revision} · {t('保存后，Discord 与 KOOK 卡片中的电工名单链接会显示最新名单。')}</small></div></div><div className="electrician-save-actions"><Button disabled={busy || Boolean(pending.current) || !data.canConfigure && dirty} onClick={() => dirty ? setDiscard(true) : reload(data)}><RefreshCw size={15}/>{t(dirty ? '放弃更改' : '重新读取')}</Button><Button kind="primary" disabled={busy || online === false || !data.canConfigure || !dirty && !pending.current} onClick={() => save(data)}>{busy ? t('正在保存…') : pending.current ? t('重试同次保存') : t('保存电工ID')}</Button></div></div>
        {discard && <Modal title={t('放弃未保存的改动')} onClose={() => setDiscard(false)} actions={<><Button onClick={() => setDiscard(false)}>{t('继续编辑')}</Button><Button kind="primary" onClick={() => reload(data)}>{t('放弃更改')}</Button></>}>{t('当前改动尚未保存，放弃后将恢复最近保存的名单。')}</Modal>}
      </>;
    }}</QueryState>
  </section>;
}
