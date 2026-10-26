import { t } from './i18n.js';
import './member-profile.css';
import './team.css';
import { specialties } from '../../shared/member-preferences.js';
import { parseMemberLocation } from './router.js';
import React,{useEffect,useState} from 'react';
import { ArrowRight,CalendarDays,Check,HelpCircle,ShieldCheck } from 'lucide-react';
import { useQuery } from './use-query.jsx';
import { useApp,AppLink } from './context.jsx';
import { Avatar,Badge,Panel,Title,QueryState,Empty,Button,Notice } from './ui.jsx';
import { time,responseLabel,lifecycleLabel } from './format.js';
export function HomePage(){
  const {client,session,zone}=useApp();const query=useQuery(client,['home'],'/api/v2/me/home',{ttlMs:20000});
  return <><Title eyebrow={t("下一次相聚，安排好了")} subtitle={t("看看这次去哪儿，也告诉队友你的时间。")}>{t("你好，{name}。", {name:session.displayName||t("队友")})}</Title><QueryState query={query}>{data=>{
    const w=data.nextWipe,s=w?.mySignup;
    return <>{!w?<Panel><Empty title={t("暂时没有新的开荒安排")} to="/app/team" action={t("看看我的队伍")}></Empty></Panel>:<><section className="wipe-hero"><div className="hero-main"><div className="hero-top"><span className="eyebrow">{t("下一场开荒")}</span><Badge>{t(lifecycleLabel[w.lifecycle])}</Badge></div><h2>{w.title||w.serverSnapshot?.name}</h2><p className="hero-region">{w.serverSnapshot?.name}</p><div className="hero-schedule"><div><span>{t("服务器预计开服")}</span><strong>{time(w.serverScheduledWipeAt,zone,true)}</strong><small>{zone}</small></div><div className="hero-note"><p>{time(w.signupClosesAt,zone,true)} {t("报名截止")}</p></div></div><div className="hero-bottom"><AppLink className="button primary" to={`/app/wipes/${encodeURIComponent(w.id)}`}><ArrowRight size={18}/>{data.participation?.canSignup===false||w.effectiveSignupWindow!=='open'?t("查看开荒安排"):s?.response?t("修改我的安排"):t("我要报名")}</AppLink><span>{w.effectiveSignupWindow==='open'?t("报名开放中"):w.effectiveSignupWindow==='not_open'?t("报名尚未开放"):t("报名已截止")}</span></div></div><aside className="hero-aside"><span className="eyebrow">{t("我的安排")}</span><CalendarDays size={33}/><h3>{t(responseLabel[s?.response])||t("还没有回复")}</h3><p>{s?.response?t("报名已保存，可在截止前修改。"):t("准时、晚点或这次不来，都告诉队友一声。")}</p>{s?.expectedArrivalAt&&<p>{time(s.expectedArrivalAt,zone)}</p>}</aside></section></>}
    <div className="home-grid"><Panel><p className="eyebrow">{t("我的队伍")}</p><h2>{data.team?.name||t("我的队伍")}</h2><p className="muted">{data.team?t("查看队友和各自的安排。"):t("暂未加入队伍。可向队长了解分队安排。")}</p><AppLink to="/app/team" className="text-link">{t("查看我的队伍")}<ArrowRight size={17}/></AppLink></Panel><Panel><p className="eyebrow">{t("参加前准备")}</p><h2>{t("开荒前，准备一下")}</h2><AppLink to="/app/me" className="check-row"><ShieldCheck size={20}/><div>{t("确认我的资料")}<small>{t("查看账号绑定、常用名和专长")}</small></div><ArrowRight size={16}/></AppLink><AppLink to="/app/history" className="check-row"><Check size={20}/><div>{t("我的报名与战绩")}<small>{t("回顾参加过的开荒")}</small></div><ArrowRight size={16}/></AppLink></Panel></div><div className="help-strip"><HelpCircle size={18}/>{t("第一次参加？从报名到进入游戏。")}<AppLink to="/help">{t("看看入门指南")}<ArrowRight size={16}/></AppLink></div></>;
  }}</QueryState></>;
}
export function Pager({nextCursor,base,cursor}){return (nextCursor||cursor)&&<div className="pagination">{cursor&&<AppLink className="button" to={base}>{t("回到第一页")}</AppLink>}{nextCursor&&<AppLink className="button" to={`${base}${base.includes('?')?'&':'?'}cursor=${encodeURIComponent(nextCursor)}`}>{t("下一页")}<ArrowRight size={16}/></AppLink>}</div>;}
export function ListPage(){
  const {client,path,zone}=useApp(),cursor=parseMemberLocation(path).searchParams.get('cursor')||'';
  const query=useQuery(client,['wipes',cursor],`/api/v2/wipes?limit=20&cursor=${encodeURIComponent(cursor)}`,{ttlMs:20000});
  return <><Title eyebrow={t("开荒日历")} subtitle={t("查看开荒时间和我的安排。")}>{t("开荒安排")}</Title><QueryState query={query}>{data=><><div className="stack">{data.items.map(w=><AppLink key={w.id} to={`/app/wipes/${encodeURIComponent(w.id)}`} className="wipe-list-item"><CalendarDays size={30}/><div><Badge tone={w.lifecycle==='scheduled'?'green':''}>{t(lifecycleLabel[w.lifecycle])}</Badge><h2>{w.title||t("开荒安排")}</h2><p>{t("预计开服时间：{time} · {zone}", {time:time(w.serverScheduledWipeAt,zone),zone})}</p></div><span className="list-end">{t(responseLabel[w.mySignup?.response])||t("未回复")}<ArrowRight size={20}/></span></AppLink>)}</div>{!data.items.length&&<Panel><Empty title={t("这里还没有开荒安排")}>{t("新的安排发布后会显示在这里。")}</Empty></Panel>}<Pager cursor={cursor} nextCursor={data.nextCursor} base="/app/wipes"/></>}</QueryState></>;
}
export function TeamPage(){
  const {client,path}=useApp(),params=parseMemberLocation(path).searchParams,cursor=params.get('cursor')||'',teamId=params.get('team')||'';
  const query=useQuery(client,['team',teamId,cursor],`/api/v2/me/team?limit=25&teamId=${encodeURIComponent(teamId)}&cursor=${encodeURIComponent(cursor)}`,{ttlMs:30000});const [selectedId,setSelectedId]=useState(null);
  useEffect(()=>setSelectedId(null),[teamId,cursor]);
  return <><Title eyebrow={t("我的队伍")} subtitle={t("认识队友，了解各自的专长。")}>{t("我的队伍")}</Title><QueryState query={query}>{data=>data.team?<Panel className="panel team-panel"><nav className="team-tabs" role="tablist" aria-label={t("选择队伍")}>{data.teams.map(team=><AppLink key={team.id} role="tab" aria-selected={data.team.id===team.id} className={`team-tab${data.team.id===team.id?' selected':''}`} to={`/app/team?team=${encodeURIComponent(team.id)}`}>{team.name}</AppLink>)}</nav><div className="team-members">{data.items.map(m=>{const expanded=selectedId===m.id,detailsId=`team-member-${encodeURIComponent(m.id)}-details`;return <article className={`team-member-card${expanded?' expanded':''}`} key={m.id}><button type="button" className="team-member-summary" aria-expanded={expanded} aria-controls={detailsId} onClick={()=>setSelectedId(expanded?null:m.id)}><Avatar name={m.steamNickname||m.displayName} src={m.avatar}/><span className="team-member-steam"><strong>{m.steamNickname||m.displayName||t("未记录昵称")}</strong><small className="mono">{m.steamId||t("未记录 Steam ID")}</small></span><span className="team-member-team"><small>{t("队伍")}</small><strong>{m.team?.name||data.team.name}</strong></span><span className="team-member-specialties" aria-label={t("专长")}>{m.specialty?.length?m.specialty.map((key,index)=><span className={`specialty-chip tone-${index%4}`} key={key}>{t(specialties[key]||key)}</span>):<span className="specialty-chip empty">{t("未填写专长")}</span>}</span><ArrowRight className="team-member-arrow" size={18}/></button>{expanded&&<div className="team-member-expanded" id={detailsId}><div className="team-member-expanded-title"><div><strong>{m.displayName||m.steamNickname||t("队友")}</strong><Badge>{({active:t("在队"),paused:t("暂休"),departed:t("离队")})[m.membershipStatus]||t("成员")}</Badge></div><Button kind="ghost" onClick={()=>setSelectedId(null)}>{t("关闭")}</Button></div><MemberDetails member={m}/></div>}</article>})}</div>{!data.items.length&&<p>{t("这支队伍暂无成员。")}</p>}<Pager cursor={cursor} nextCursor={data.nextCursor} base={`/app/team?team=${encodeURIComponent(data.team.id)}`}/></Panel>:<Panel><Empty title={t("暂无可查看的队伍")}>{t("队伍建立后会显示在这里。")}</Empty></Panel>}</QueryState></>;
}
function MemberDetails({member}){
  const account = (provider, fallback = '') => {
    const linked = member.platforms?.[provider], connected = linked?.connected ?? Boolean(fallback);
    return { name: linked?.displayName || fallback || (connected ? t("未记录昵称") : t("未关联")), avatar: linked?.avatar || '' };
  };
  const cards = [
    { id: 'steam', label: 'Steam', name: member.steamNickname || t("未记录昵称"), avatar: member.avatar,
      detail: member.steamId || t("未记录 Steam ID") },
    { id: 'kook', label: 'KOOK', ...account('kook', member.kookName) },
    { id: 'discord', label: 'Discord', ...account('discord', member.discordName) },
    { id: 'wechat', label: t("微信"), ...account('wechat') }
  ];
  return <dl className="team-member-details">{cards.map(card=><div className={`platform ${card.id}`} key={card.id}>
    <dt>{card.label}</dt><dd><Avatar name={card.name} src={card.avatar} size={42}/><span className="team-member-platform-text">
      <strong>{card.name}</strong>{card.detail&&<small className="mono">{card.detail}</small>}</span></dd>
  </div>)}</dl>;

}
export function HistoryPage(){
  const {client,path,zone}=useApp(),cursor=parseMemberLocation(path).searchParams.get('cursor')||'';
  const query=useQuery(client,['history',cursor],`/api/v2/me/history?limit=20&cursor=${encodeURIComponent(cursor)}`,{ttlMs:30000});
  return <><Title eyebrow={t("我的记录")} subtitle={t("回顾我的报名与开荒安排。")}>{t("我的报名与战绩")}</Title><QueryState query={query}>{data=><>{data.items.length?<div className="stack">{data.items.map(item=><Panel key={item.wipe.id}><div className="section-title"><h2>{item.wipe.title}</h2><Badge>{t(lifecycleLabel[item.wipe.lifecycle])}</Badge></div><p>{time(item.wipe.serverScheduledWipeAt,zone)} · {t(responseLabel[item.mySignup?.response])||t("已撤回回复")}</p><div className="section-title"><AppLink to={`/app/wipes/${encodeURIComponent(item.wipe.id)}${parseMemberLocation(path).searchParams.get('wipe')===item.wipe.id?'?tab=stats':''}`} className="text-link">{t("查看该场安排")}<ArrowRight size={16}/></AppLink></div></Panel>)}</div>:<Panel><Empty title={t("还没有报名记录")} to="/app/wipes" action={t("查看开荒安排")}>{t("保存报名后，可以在这里找到。")}</Empty></Panel>}<Pager cursor={cursor} nextCursor={data.nextCursor} base="/app/history"/></>}</QueryState></>;
}
