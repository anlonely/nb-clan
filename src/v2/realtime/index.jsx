import { displayTimeZone } from '../display-preferences.js';
import { t, getUiLocale } from '../i18n.js';
import { Select as Dropdown } from '../select.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { useApp, AppLink } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Button, Badge, Panel, Title, Notice, QueryState, Modal, Avatar } from '../ui.jsx';
import { emptyChat, reduceChat, visibleChat } from './chat-state.js';
import { notifySuccess } from '../toast.jsx';
import { RealtimeMembersTable, RealtimeMemberModal } from './members.jsx';
import { defaultMemberSort, nextMemberSort } from './member-sort.js';
import { inviteDisplayName } from './invite-display.js';
import './style.css';
const RelayAdminPage = React.lazy(() => import('../relay-admin/index.jsx'));
const time = value => value ? new Date(value).toLocaleString(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { timeZone: displayTimeZone(),
  hour12: false
}) : t('尚无记录');
const base = id => `/api/v2/realtime/${encodeURIComponent(id)}`;
const errorText = e => t(({
  SOURCE_ADAPTER_REQUIRED: '尚未接入实时来源。',
  SOURCE_RESET_ADAPTER_REQUIRED: '来源重置服务尚未接线，未执行任何重置。',
  MEMBERS_ADAPTER_REQUIRED: '成员导入服务尚未接线，未创建成员。',
  REVISION_CONFLICT: '数据已变化，请刷新后重新确认。',
  CURSOR_EXPIRED: '历史游标已失效，请重新读取。',
  ACCESS_DENIED: '当前账号没有该操作权限。',
  LEGACY_AUTHORITY_REQUIRED: '旧有效权限尚未接线，操作已拒绝。'
})[e?.errorCode] || t('暂时无法完成：{error}。', { error: e?.errorCode || t('连接中断') }));
export default function RealtimeWorkspace() {
  const { path } = useApp(), mode = path?.includes('/relay') ? 'relay' : path?.includes('/chat') ? 'chat' : 'info';
  const selected = new URL(path || location.href, location.origin).searchParams.get('scope');
  const scopeQuery = selected ? `?scope=${encodeURIComponent(selected)}` : '';
  return <div className="rt-page"><Title eyebrow="RUST+">{t("战队实时")}</Title><nav className="rt-tabs" aria-label={t("战队实时导航")}><AppLink aria-current={mode === 'info' ? 'page' : undefined} to={`/admin/realtime/info${scopeQuery}`}>{t("战队信息")}</AppLink><AppLink aria-current={mode === 'chat' ? 'page' : undefined} to={`/admin/realtime/chat${scopeQuery}`}>{t("只读聊天")}</AppLink><AppLink aria-current={mode === 'relay' ? 'page' : undefined} to={`/admin/realtime/relay${scopeQuery}`}>{t("Rust+ 接入")}</AppLink></nav>{mode === 'relay' ? <><RealtimeSourceSelector selected={selected}/><RelayAdminPage embedded/></> : <RealtimeData mode={mode} selected={selected}/>}</div>;
}
function RealtimeSourceSelector({ selected }) {
  const { client, go } = useApp();
  const catalog = useQuery(client, ['realtime', 'scopes', 'info'], '/api/v2/realtime/scopes?mode=info');
  return <QueryState query={catalog}>{data => {
    const id = data.items.some(s => s.id === selected) ? selected : data.items[0]?.id;
    return <Panel className="rt-source-panel">{id ? <><div className="rt-source-picker"><label>{t('来源账号 / 服务器')}<Dropdown aria-label={t('来源账号 / 服务器')} value={id} onChange={e => go(`/admin/realtime/relay?scope=${encodeURIComponent(e.target.value)}`)}>{data.items.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</Dropdown></label><Badge>{data.items.length} {t('个可见来源')}</Badge></div><div className="rt-source-links"><AppLink className="button" to={`/admin/realtime/info?scope=${encodeURIComponent(id)}`}>{t('查看战队信息')}</AppLink><AppLink className="button" to={`/admin/realtime/chat?scope=${encodeURIComponent(id)}`}>{t('查看只读聊天')}</AppLink></div></> : <p className="muted">{t('暂无可见实时来源')}</p>}</Panel>;
  }}</QueryState>;
}
function RealtimeData({ mode, selected }) {
  const { client } = useApp();
  const catalog = useQuery(client, ['realtime', 'scopes', mode], `/api/v2/realtime/scopes?mode=${mode}`);
  return <QueryState query={catalog}>{data => {
        const id = data.items.some(s => s.id === selected) ? selected : data.items[0]?.id;
        return id ? <ScopePage key={`${client.getGeneration()}:${id}:${mode}`} id={id} mode={mode} /> : <Panel className="rt-source-panel"><div className="rt-empty"><span className="rt-empty-mark" aria-hidden="true">RUST+</span><h2>{t("暂无可见实时来源")}</h2><p>{t("连接来源上报数据后，可查看战队成员与在线状态。")}</p><AppLink className="button" to="/admin/realtime/relay">{t("查看 Rust+ 接入")}</AppLink></div></Panel>;
      }}</QueryState>;
}
function ScopePage({
  id,
  mode
}) {
  const {
      client
    } = useApp(),
    summary = useQuery(client, ['realtime', id, 'summary'], `${base(id)}/summary`),
    [dialog, setDialog] = useState(null),
    [profile, setProfile] = useState(null),
    [memberSort, setMemberSort] = useState(defaultMemberSort);
  useEffect(() => {
    if (mode !== 'info') return;
    const timer = setInterval(() => {
      if (!document.hidden) summary.retry().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [id, mode, summary.retry]);
  return <><div className="rt-actions rt-page-actions"><Button onClick={() => summary.retry().catch(() => {})}>{t("刷新观察结果")}</Button>{summary.data?.commands?.reset && <Button kind="danger" onClick={() => setDialog({
        action: 'reset'
      })}>{t("重置当前来源")}</Button>}{summary.data?.commands?.clearChat && <Button kind="danger" onClick={() => setDialog({
        action: 'clear-chat'
      })}>{t("清空本地聊天历史")}</Button>}</div>{mode === 'info' ? <QueryState query={summary}>{data => <><Panel><div className="rt-heading"><div><h2>{data.clan?.name || t('尚无战队快照')}</h2><p>{data.clan?.announcement || t('暂无战队公告')}</p><small>{t("战队 ID：")}{data.clan?.id || '—'} {t("· 来源：")}{data.scope.sourceId} · {data.scope.serverKey}</small></div><Badge tone={data.status === 'fresh' ? 'success' : 'warning'}>{{
                fresh: t('观察有效'),
                stale: t('名单已过期'),
                unavailable: t('来源不可用')
              }[data.status]}</Badge></div><div className="rt-source-facts"><strong>{t("来源账号")}</strong><span>{data.source.name}</span><span>{t("首次收到")} {time(data.source.firstReceivedAt)}</span><span>{t("最近上报")} {time(data.source.lastReportAt)}</span></div><p className="muted">{t("名单观察：")}{time(data.observedAt)} {t("· 接收：")}{time(data.receivedAt)} {t('· 有效期 {seconds} 秒', { seconds: data.ttlMs / 1000 })}</p>{data.status !== 'fresh' && <Notice title={t("当前在线状态未知")}>{t("保留上次观察的名单供核对，不计入实时在线人数。")}</Notice>}<div className="rt-metrics">{[[t('当前名单'), data.counts.members], [t('在线'), data.counts.online], [t('离线'), data.counts.offline], [t('待处理邀请'), data.invites.length]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? t('未知')}</strong></div>)}</div><p>{data.squads.map(s => t('{name}：{online} / {total}', { name: s.name, online: s.online ?? t('未知'), total: s.total })).join('　 · 　')}</p></Panel><RealtimeMembersTable members={data.members} commands={data.commands} sort={memberSort} onSort={key => setMemberSort(current => nextMemberSort(current, key))} onProfile={setProfile} onImport={member => setDialog({ action: 'import-member', member })} time={time} />{data.invites.length > 0 && <Panel className="rt-pending-panel"><div className="rt-heading"><h2>{t('当前邀请')}</h2><Badge>{data.invites.length}</Badge></div><div className="rt-pending-list">{data.invites.map((r, i) => <div key={r.id || i}><InvitePerson name={r.displayName || r.inviteeName} steamId={r.steamId || r.inviteeSteamId} members={data.members} onProfile={setProfile}/><InviteStatus record={r}/></div>)}</div></Panel>}<Invites id={id} members={data.members} onProfile={setProfile} /></>}</QueryState> : <Chat id={id} onChanged={() => summary.retry().catch(() => {})} />} {profile && <RealtimeMemberModal member={profile} onClose={() => setProfile(null)} time={time} />}{dialog && <CommandDialog id={id} dialog={dialog} revision={summary.data?.revision} close={() => setDialog(null)} done={() => {
      setDialog(null);
      client.invalidateQueries(['realtime', id]);
      summary.retry().catch(() => {});
    }} />}</>;
}
function InvitePerson({ name, steamId, members, records = [], onProfile }) {
  const member = members.find(item => item.steamId === steamId);
  const displayName = inviteDisplayName({ name, steamId, members, records }) || (steamId ? t('昵称未取得') : t('未知'));
  return <button type="button" className="rt-invite-person" onClick={() => onProfile({ ...member, displayName, steamId: steamId || member?.steamId })}>
    <Avatar name={displayName} src={member?.avatar} size={34}/>
    <span><strong>{displayName}</strong>{steamId && <small>{steamId}</small>}</span>
  </button>;
}
function InviteStatus({ record }) {
  const label = record.statusLabel ? t(record.statusLabel) : record.status === 'accepted' ? t('已接受') : record.status === 'pending' ? t('待确认') : record.status || t('未知');
  return <span className={`rt-invite-status rt-invite-status-${record.status === 'accepted' ? 'accepted' : record.status === 'pending' ? 'pending' : 'other'}`}>{label}</span>;
}
function Invites({ id, members, onProfile }) {
  const { client } = useApp();
  const [q, setQ] = useState(''), [before, setBefore] = useState(null);
  const query = useQuery(client, ['realtime', id, 'invites', q, before], `${base(id)}/invites?${new URLSearchParams({ q, ...(before ? { before } : {}) })}`);
  return <Panel className="rt-invites-panel">
    <div className="rt-heading"><div><h2>{t('邀请记录')}</h2><p className="muted">{t('点击昵称可查看成员信息')}</p></div><Button onClick={() => { setBefore(null); query.retry().catch(() => {}); }}>{t('刷新邀请')}</Button></div>
    <div className="rt-invite-toolbar"><input aria-label={t('搜索邀请记录')} placeholder={t('搜索邀请人、受邀人、状态')} value={q} onChange={e => { setQ(e.target.value); setBefore(null); }}/></div>
    <QueryState query={query}>{data => <>
      <p className="rt-invite-counts">{t('筛选统计：{counts}', { counts: Object.entries(data.counts || {}).map(([k, v]) => `${k === 'accepted' ? t('已接受') : k === 'pending' ? t('待确认') : t('未知')} ${v}`).join(' · ') || t('0 条') })}</p>
      <div className="rt-table rt-invites-table"><table><thead><tr><th>{t('邀请人')}</th><th>{t('受邀人')}</th><th>{t('时间')}</th><th>{t('状态')}</th></tr></thead><tbody>{data.items.map(r => <tr key={r.id}>
        <td><InvitePerson name={r.inviterName || r.invitedBy} steamId={r.inviterSteamId} members={members} records={data.items} onProfile={onProfile}/></td>
        <td><InvitePerson name={r.inviteeName || r.displayName} steamId={r.inviteeSteamId || r.steamId} members={members} onProfile={onProfile}/></td>
        <td className="rt-date">{r.sentAt ? time(r.sentAt) : r.firstSeenAt ? t('首次观察：{time}', { time: time(r.firstSeenAt) }) : time(r.receivedAt)}</td>
        <td><InviteStatus record={r}/></td>
      </tr>)}</tbody></table>{!data.items.length && <p className="rt-table-empty">{t('没有符合条件的邀请记录。')}</p>}</div>
      <div className="rt-actions rt-invite-pagination"><Button disabled={!before} onClick={() => setBefore(null)}>{t('回到最新')}</Button><Button disabled={!data.nextCursor} onClick={() => setBefore(data.nextCursor)}>{t('更早邀请')}</Button></div>
    </>}</QueryState>
  </Panel>;
}
function Chat({
  id,
  onChanged
}) {
  const {
      client,
      online
    } = useApp(),
    [state, setState] = useState(() => emptyChat(id)),
    [enabled, setEnabled] = useState(false),
    [status, setStatus] = useState('尚未连接'),
    [error, setError] = useState(null),
    [loading, setLoading] = useState(false),
    [restart, setRestart] = useState(0),
    [pending, setPending] = useState(0),
    [follow, setFollow] = useState(true),
    [frozenTail, setFrozenTail] = useState([]),
    [visible, setVisible] = useState(!document.hidden);
  const live = useRef(state),
    epoch = useRef(0),
    alive = useRef(true),
    followRef = useRef(follow);
  live.current = state;
  followRef.current = follow;
  const change = e => setState(s => reduceChat(s, {
    scope: id,
    ...e
  }));
  useEffect(() => {
    const fn = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    if (!enabled || online === false || !visible) {
      setStatus(online === false ? '网络已断开' : !visible ? '后台暂停' : '已暂停');
      return;
    }
    const generation = ++epoch.current,
      controller = new AbortController();
    let source,
      retryTimer,
      closed = false;
    const valid = () => !closed && alive.current && generation === epoch.current;
    const connect = async () => {
      try {
        setStatus('正在连接');
        if (!live.current.loaded) {
          const r = await client.request(`${base(id)}/chats`, {
            signal: controller.signal
          });
          if (!valid()) return;
          live.current = reduceChat(live.current, {
            scope: id,
            type: 'initial',
            page: r.data
          });
          setState(live.current);
        }
        if (!valid()) return;
        source = new EventSource(`${base(id)}/stream?after=${encodeURIComponent(live.current.after)}`);
        source.onopen = () => {
          if (valid()) {
            setStatus('实时接收中');
            setError(null);
          }
        };
        source.addEventListener('realtime', event => {
          if (!valid()) return;
          const data = JSON.parse(event.data);
          if (data.resourceId !== id) return;
          live.current = reduceChat(live.current, {
            scope: id,
            type: 'event',
            data
          });
          setState(live.current);
          if (data.eventType === 'scope.reset') {
            setFrozenTail([]);
            setPending(0);
            source.close();
            setRestart(n => n + 1);
          }
          if (data.eventType !== 'chat.created') onChanged();else if (!followRef.current) setPending(n => n + 1);
        });
        source.addEventListener('heartbeat', event => {
          if (valid()) {
            const data = JSON.parse(event.data);
            change({
              type: 'source',
              source: data.source
            });
          }
        });
        source.addEventListener('unavailable', () => {
          if (valid()) {
            setStatus('实时服务暂不可用');
            source.close();
            setError({
              errorCode: 'SOURCE_UNAVAILABLE'
            });
          }
        });
        source.addEventListener('reset_required', () => {
          if (!valid()) return;
          source.close();
          setFrozenTail([]);
          setPending(0);
          live.current = emptyChat(id);
          setState(live.current);
          setStatus('正在补齐断线数据');
          setRestart(n => n + 1);
        });
        source.addEventListener('authorization-revoked', () => {
          if (!valid()) return;
          source.close();
          live.current = emptyChat(id);
          setState(live.current);
          client.clearIdentity('AUTHORIZATION_REVOKED');
        });
        source.onerror = () => {
          if (!valid()) return;
          source.close();
          setStatus('连接中断，正在核对权限并重连');
          retryTimer = setTimeout(() => {
            if (valid()) client.request(`${base(id)}/events?after=${encodeURIComponent(live.current.after)}`, {
              signal: controller.signal
            }).then(() => {
              if (valid()) setRestart(n => n + 1);
            }).catch(e => {
              if (valid()) {
                setError(e);
                setStatus('连接失败，请重试');
              }
            });
          }, 1200);
        };
      } catch (e) {
        if (valid()) {
          setError(e);
          setStatus('读取失败');
        }
      }
    };
    connect();
    return () => {
      closed = true;
      controller.abort();
      source?.close();
      clearTimeout(retryTimer);
      epoch.current++;
    };
  }, [id, client, enabled, online, visible, restart]);
  async function more() {
    if (loading || !state.before) return;
    setLoading(true);
    const generation = epoch.current;
    try {
      const r = await client.request(`${base(id)}/chats?before=${encodeURIComponent(state.before)}`);
      if (alive.current && generation === epoch.current) {
        change({
          type: 'history',
          page: r.data
        });
        setFrozenTail(live.current.tail);
        setFollow(false);
      }
    } catch (e) {
      if (alive.current && generation === epoch.current) setError(e);
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  return <Panel><div className="rt-heading"><div><h2>{t("游戏聊天 · 只读")}</h2><p role="status">{t('{status} · 历史 {history} 条 / 实时窗口 {tail} 条', { status: t(status), history: state.history.length, tail: state.tail.length })}</p></div><div className="rt-actions"><Button onClick={() => setEnabled(v => !v)}>{enabled ? t('暂停接收') : t('开始接收')}</Button><Button onClick={() => {
          setFrozenTail([]);
          setPending(0);
          live.current = emptyChat(id);
          setState(live.current);
          setError(null);
          setRestart(n => n + 1);
        }}>{t("重新读取")}</Button></div></div>{state.source && <p>{t("来源状态：")}{{
        fresh: t('观察有效'),
        stale: t('名单已过期'),
        unavailable: t('尚无名单观察')
      }[state.source.status]} {t("· 最近上报：")}{time(state.source.lastReportAt)}</p>}{state.overflow && <Notice title={t("实时窗口已满")}>{t("更早消息保存在历史中，可重新读取历史窗口。")}</Notice>}<p className="muted">{t("保留原文与译文；页面没有向游戏发送消息的能力。")}</p>{error && <Notice tone="error" title={errorText(error)} action={<Button onClick={() => setRestart(n => n + 1)}>{t("重试连接")}</Button>} />}<div className="rt-chat-list" aria-label={t("聊天记录")}><ChatRows rows={visibleChat(follow || !state.loaded ? state : {
        ...state,
        tail: frozenTail
      })} /></div>{enabled && state.loaded && !visibleChat(state).length && <p>{t("当前来源没有聊天记录。")}</p>}<div className="rt-actions"><Button disabled={!state.before || loading || state.history.length >= 1000} onClick={more}>{loading ? t('读取历史中…') : t('加载更早历史')}</Button><Button onClick={() => {
        setFrozenTail(state.tail);
        setFollow(v => !v);
        setPending(0);
      }}>{follow ? t('固定历史视图') : t('查看最新消息{pending}', { pending: pending ? ` (${pending})` : '' })}</Button></div>{state.history.length >= 1000 && <p>{t("已达本次 1000 条历史窗口上限，请重新读取最新窗口。")}</p>}</Panel>;
}
function ChatRows({
  rows
}) {
  return rows.map(m => <article key={m.id} data-message-id={m.id} className="rt-chat-row"><Avatar name={m.displayName} /><div><strong>{m.displayName || m.steamId || t('未知成员')}</strong><small>{m.steamId} · {time(m.sentAt || m.occurredAt)} · {m.channel || 'clan'} {t("· 接收")} {time(m.receivedAt)}</small><p>{m.translatedMessage || m.message}</p>{m.translatedMessage && m.translatedMessage !== m.message && <p className="rt-original">{t("原文：")}{m.message}</p>}</div></article>);
}
function CommandDialog({
  id,
  dialog,
  revision,
  close,
  done
}) {
  const {
      client
    } = useApp(),
    [reason, setReason] = useState(''),
    [squad, setSquad] = useState(''),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [operation] = useState(() => crypto.randomUUID()),
    [expected] = useState(revision),
    [submitted, setSubmitted] = useState(null),
    isImport = dialog.action === 'import-member',
    options = useQuery(client, ['realtime', id, 'member-options'], `${base(id)}/member-options`, {
      enabled: isImport
    });
  async function run() {
    if (busy) return;
    setBusy(true);
    const body = submitted || {
      expectedRevision: expected,
      reason,
      ...(isImport ? {
        steamId: dialog.member.steamId,
        squadId: squad
      } : {})
    };
    setSubmitted(body);
    try {
      await client.request(`${base(id)}/commands/${dialog.action}`, {
        method: 'POST',
        headers: {
          'Idempotency-Key': operation
        },
        body
      });
      notifySuccess(isImport ? '成员已导入' : '操作成功', { id: operation });
      done();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return <Modal title={isImport ? t('导入未登记成员') : dialog.action === 'reset' ? t('重置当前来源数据') : t('清空本地聊天历史')} onClose={() => !busy && close()} actions={<><Button disabled={busy} onClick={close}>{t("取消")}</Button><Button kind="danger" disabled={busy || !submitted && (isImport ? !squad : !reason.trim())} onClick={run}>{busy ? t('正在处理…') : submitted ? t('使用同一操作 ID 重试') : t('确认操作')}</Button></>}><p>{isImport ? t('将 {name} 交给成员服务登记到所选队伍。', { name: dialog.member.displayName }) : dialog.action === 'reset' ? t('仅重置所选来源在本站的数据，通过来源适配器原子执行；不重启 Rust+ 或修改 rust-go。') : t('删除当前来源在本站保存的聊天记录，保留审计；不删除游戏、Discord 或 KOOK 消息。')}</p>{isImport ? <QueryState query={options}>{data => <Dropdown aria-label={t("导入到队伍")} value={squad} disabled={Boolean(submitted)} onChange={e => setSquad(e.target.value)}><option value="">{t("选择队伍")}</option>{data.squads.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Dropdown>}</QueryState> : <label>{t("操作原因")}<input aria-label={t("操作原因")} maxLength={500} value={reason} disabled={Boolean(submitted)} onChange={e => setReason(e.target.value)} /></label>}{error && <Notice tone="error" title={errorText(error)} />}</Modal>;
}
