import { t, dateLocale } from './i18n.js';
import { LanguageSwitch, useUiLocale, useDisplayTimeZone } from './language-switch.jsx';
import { ResourceBoundary } from './resource-boundary.jsx';
import { parseMemberLocation, workspaceForLocation, needsWorkspaceSession, workspaceAuthReturnTo, canOpenWorkspace } from './router.js';
import { sessionAuthReturnTo } from './auth-flow.js';
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Home, CalendarDays, Users, ChartNoAxesColumn, UserRound, HelpCircle, LogOut, ShieldCheck, Bot } from 'lucide-react';
import { createQueryClient } from './query-client.js';
import { AppContext, AppLink } from './context.jsx';
import { Loading, Notice, Button } from './ui.jsx';
import { errorCopy } from './format.js';
import { useBusinessEvents } from './business-events.js';
import './style.css';
import './brand.css';
import './ui-theme.css';
import { ToastHost } from './toast.jsx';
import { BRAND_NAME, SOURCE_URL, BrandLogo, brandLogoUrl } from './brand.jsx';
import { managementNavigation, managementHome, managementSection } from './management-navigation.js';
const HomePage=lazy(()=>import('./pages.jsx').then(m=>({default:m.HomePage})));
const ListPage=lazy(()=>import('./pages.jsx').then(m=>({default:m.ListPage})));
const TeamPage=lazy(()=>import('./pages.jsx').then(m=>({default:m.TeamPage})));
const HistoryPage=lazy(()=>import('./pages.jsx').then(m=>({default:m.HistoryPage})));
const ProfilePage=lazy(()=>import('./profile.jsx'));
const WechatLinkPage=lazy(()=>import('./wechat-link.jsx'));
const WipePage=lazy(()=>import('./wipe.jsx'));
const AuthPage=lazy(()=>import('./auth.jsx'));
const HelpPage=lazy(()=>import('./help.jsx'));
const AdminWorkspace=lazy(()=>import('./management.jsx'));
const currentLocation=()=>location.pathname+location.search+location.hash;
export function App() {
  const uiLocale = useUiLocale();
  const zone = useDisplayTimeZone();
  const [path,setPath]=useState(currentLocation),[session,setSession]=useState(null),[booting,setBooting]=useState(true),[bootError,setBootError]=useState(null),[online,setOnline]=useState(navigator.onLine),[reason,setReason]=useState('');
  const authEpoch=useRef(0),channel=useRef(null),sessionRef=useRef(null),attempted=useRef(false);
  const currentPath=useRef(currentLocation()),navIndex=useRef(Number.isInteger(history.state?.nbNavIndex)?history.state.nbNavIndex:0),restoringNavigation=useRef(false),approvedPop=useRef(false);
  const canNavigate=(to,options)=>window.dispatchEvent(new CustomEvent('v2:before-navigate',{cancelable:true,detail:{to,options}}));
  const [client]=useState(()=>createQueryClient({defaultTimeoutMs:10000,onAuthorizationLost:({reason:why}={})=>{
    authEpoch.current++; sessionRef.current=null;setSession(null);setBooting(false);setReason(why==='MEMBER_DEPARTED'?"你已离队，请联系管理获取语音频道角色":['logout','AUTH_REQUIRED','AUTH_SESSION_INVALID'].includes(why)?'': "登录或访问范围已变化，请重新登录。");
  }}));
  const go=useCallback((to,{replace=false,scroll=true,historyDelta}={})=>{
    if (!parseMemberLocation(to).pathname) return;
    if(to!==currentPath.current&&!canNavigate(to,{replace,scroll,historyDelta}))return;
    if(Number.isInteger(historyDelta)&&historyDelta!==0){approvedPop.current=true;history.go(historyDelta);return;}
    if(!replace)navIndex.current++;
    history[replace?'replaceState':'pushState']({nbNavIndex:navIndex.current},'',to);currentPath.current=currentLocation();setPath(currentPath.current);if(scroll)window.scrollTo(0,0);
  },[]);
  const refreshSession=useCallback(async({signal}={})=>{
    const epoch=++authEpoch.current;setBootError(null);
    try {
      const payload=await client.request('/api/v2/bootstrap',{signal});
      if(epoch!==authEpoch.current)return;
      client.setIdentity({accountId:payload.data.accountId,scopeVersion:payload.meta.scopeVersion,csrfToken:payload.data.csrfToken});
      sessionRef.current=payload.data;setSession(payload.data);setReason('');return payload.data;
    }catch(error){if(epoch===authEpoch.current){setBootError(error);if(!sessionRef.current)setSession(null);}}
    finally{if(epoch===authEpoch.current)setBooting(false);}
  },[client]);
  useBusinessEvents({client,session,online,refreshSession});
  const logout=async()=>{
    try{await client.request('/api/v2/auth/logout',{method:'POST',body:{}});client.clearIdentity('logout');channel.current?.postMessage('logout');go('/login',{replace:true});}
    catch(error){setBootError(error);}
  };
  useEffect(()=>{
    history.replaceState({...history.state,nbNavIndex:navIndex.current},'',currentLocation());
    const pop=()=>{
      if(restoringNavigation.current){restoringNavigation.current=false;return;}
      const destination=currentLocation(),index=history.state?.nbNavIndex;
      const approved=approvedPop.current;approvedPop.current=false;
      const options=Number.isInteger(index)&&index!==navIndex.current?{historyDelta:index-navIndex.current,scroll:false}:{replace:true,scroll:false};
      if(!approved&&destination!==currentPath.current&&!canNavigate(destination,options)){
        if(Number.isInteger(index)&&index!==navIndex.current){restoringNavigation.current=true;history.go(navIndex.current-index);}
        else history.pushState({nbNavIndex:navIndex.current},'',currentPath.current);
        return;
      }
      if(Number.isInteger(index))navIndex.current=index;
      currentPath.current=destination;setPath(destination);
    };window.addEventListener('popstate',pop);
    const connected=()=>{setOnline(true);if(sessionRef.current)refreshSession();};const disconnected=()=>setOnline(false);
    const focus=()=>{if(sessionRef.current && navigator.onLine && !document.hidden)refreshSession();};
    window.addEventListener('online',connected);window.addEventListener('offline',disconnected);window.addEventListener('focus',focus);
    if(typeof BroadcastChannel!=='undefined'){channel.current=new BroadcastChannel('nb-v2-session');channel.current.onmessage=()=>client.clearIdentity('account-changed');}
    if(needsWorkspaceSession(currentLocation())){attempted.current=true;refreshSession();}else setBooting(false);
    return()=>{window.removeEventListener('popstate',pop);window.removeEventListener('online',connected);window.removeEventListener('offline',disconnected);window.removeEventListener('focus',focus);channel.current?.close();};
  },[client,refreshSession]);
  useEffect(()=>{if(needsWorkspaceSession(path)&&!attempted.current){attempted.current=true;setBooting(true);refreshSession();}},[path,refreshSession]);
  useEffect(()=>{
    if(!session || !online)return;
    const generation=client.getGeneration(),events=new EventSource('/api/v2/auth/events');
    let fallbackTimer=null;
    const stillCurrent=()=>generation===client.getGeneration();
    const revoke=()=>{if(stillCurrent()){client.clearIdentity('authorization-revoked');channel.current?.postMessage('revoked');}events.close();};
    events.addEventListener('authorization-revoked',revoke);
    // EventSource owns reconnect backoff. Failed streams get bounded identity polling,
    // without replacing a healthy stream on every bootstrap or focus event.
    events.onopen=()=>{clearInterval(fallbackTimer);fallbackTimer=null;};
    events.onerror=()=>{if(!fallbackTimer)fallbackTimer=setInterval(()=>{if(stillCurrent()&&navigator.onLine&&!document.hidden)refreshSession();},30000);};
    return()=>{events.close();clearInterval(fallbackTimer);};
  },[session?.accountId,client.getIdentity()?.scopeVersion,client.getGeneration(),online,client,refreshSession]);
  const locationParts=parseMemberLocation(path),route=locationParts.pathname,help=route==='/help',continuing=route==='/auth/continue';
  const visibleBootError=bootError&&!(route==='/app/wechat-link'&&!session&&bootError.status===401);
  const memberAccess=session?.workspaces?.member===true,adminAccess=session?.workspaces?.admin===true;
  const adminRoute=workspaceForLocation(path)==='admin',adminShell=adminAccess&&(adminRoute||!memberAccess);
  const workspaceLabel=adminShell?t("管理空间"):memberAccess?t("成员空间"):t("工作空间");
  const home=memberAccess?'/app/home':adminAccess?managementHome(session):'/help';
  useEffect(()=>{
    document.title=`${session?.brand?.name || BRAND_NAME} · ${workspaceLabel}`;document.documentElement.lang=dateLocale();
    const theme=session?.member?.theme||'light';document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):theme;
  },[session,workspaceLabel,uiLocale]);
  useEffect(()=>{
    const icon=document.querySelector('link[rel="icon"]')||document.createElement('link');
    icon.rel='icon';icon.href=brandLogoUrl(session?.brand?.logoUrl);
    if(!icon.parentNode)document.head.appendChild(icon);
  },[session?.brand?.logoUrl]);
  useEffect(()=>{const id=setTimeout(()=>document.querySelector('main h1')?.focus({preventScroll:true}),80);return()=>clearTimeout(id);},[path]);
  useEffect(()=>{if(session&&route==='/login')go(sessionAuthReturnTo(locationParts.searchParams.get('returnTo'),session),{replace:true});},[session,route,path,go]);
  const nav=adminShell?managementNavigation(session).map(item=>[item.path,item.label,item.id==='bot'?Bot:ShieldCheck]):memberAccess?
    [['/app/home',t("首页"),Home],['/app/wipes',t("开荒"),CalendarDays],['/app/team',t("队伍"),Users],['/app/history',t("战绩"),ChartNoAxesColumn],['/app/me',t("我的"),UserRound]]:[];
  let page;
  if(booting)page=<Loading/>;
  else if(help)page=<HelpPage/>;
  else if(route==='/app/wechat-link')page=<WechatLinkPage/>;
  else if(!session || continuing)page=<AuthPage continuing={continuing} reason={reason} returnTo={workspaceAuthReturnTo(path)}/>;
  else if(route==='/login')page=<Loading/>;
  else if(workspaceForLocation(path)&&!canOpenWorkspace(session,path))page=<Notice title={adminRoute?t("没有管理空间访问权限"):t("当前账号无法访问成员空间")} action={<AppLink to={home}>{home==='/help'?t("查看帮助"):adminAccess&&!memberAccess?t("进入管理空间"):t("返回成员首页")}</AppLink>}>{adminRoute?t("当前账号没有可用的管理功能权限。"):t("成员空间需要已核实的成员身份及本人资料读取权限。")}</Notice>;
  else if(adminRoute)page=<AdminWorkspace/>;
  else if(route==='/app/home'||route==='/app'||route==='/app/')page=<HomePage/>;
  else if(route==='/app/wipes')page=<ListPage/>;
  else if(locationParts.wipeId!==undefined)page=<WipePage key={route} id={locationParts.wipeId}/>;
  else if(route==='/app/team')page=<TeamPage/>;
  else if(route==='/app/me')page=<ProfilePage/>;
  else if(route==='/app/history'||route==='/app/stats')page=<HistoryPage/>;
  else page=<Notice title={t("页面不存在")} action={<AppLink to={home}>{t("返回空间首页")}</AppLink>}>{t("请从导航重新选择。")}</Notice>;
  const context={client,session,uiLocale,path,go,refreshSession,logout,online,zone,updateProfile:profile=>setSession(s=>s?{...s,displayName:profile.displayName,member:{...s.member,...profile}}:s)};
  return <AppContext.Provider value={context}>
    <ToastHost client={client}/>
    <a className="skip-link" href="#main">{t("跳到主要内容")}</a>
    {session&&!continuing?<div className="app-shell">
      <aside className="sidebar">
        <AppLink to={home} className="brand rsg-brand"><BrandLogo logoUrl={session.brand?.logoUrl} width="80" height="80"/><strong>{session?.brand?.name || BRAND_NAME}</strong><small>{t("一起开荒，一起回家。")}</small></AppLink>
        <p className="workspace-label">{workspaceLabel}</p>
        <nav aria-label={t("{v0}导航", {v0:(workspaceLabel)})}>{nav.map(([to,label,Icon])=><AppLink key={to} to={to} className={`nav-link ${(adminShell?managementSection(route)===managementSection(to):route===to||route.startsWith(to+'/'))?'active':''}`} aria-current={(adminShell?managementSection(route)===managementSection(to):route===to||route.startsWith(to+'/'))?'page':undefined}><Icon size={19}/>{t(label)}</AppLink>)}</nav>
        <div className="sidebar-bottom">
          {adminAccess&&!adminShell&&<AppLink to={managementHome(session)}><ShieldCheck size={18}/>{t("管理空间")}</AppLink>}
          {memberAccess&&adminShell&&<AppLink to="/app/home"><Home size={18}/>{t("成员空间")}</AppLink>}
          <AppLink to="/help"><HelpCircle size={18}/>{t("帮助与入门")}</AppLink>
          <button onClick={logout}><LogOut size={18}/>{t("退出登录")}</button>
          <small><ShieldCheck size={15}/>{t("内容按当前访问权限展示")}</small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar"><span>{session?.brand?.name || BRAND_NAME} <i>/</i> {workspaceLabel}</span><div className="topbar-actions"><span className="caption" title={t("显示时区")}>{t("显示时区")} · {zone}</span><LanguageSwitch/>{memberAccess?<AppLink to="/app/me" className="account"><UserRound size={16}/>{session.displayName||t("我的账号")}</AppLink>:<span className="account"><UserRound size={16}/>{adminAccess?t("管理账号"):t("当前账号")}</span>}</div></header>
        <main id="main" className="main">
          {!online&&<Notice title={t("网络已断开")}>{t("已读取内容暂时保留，恢复网络后可重新核实安排。提交结果不明时，请核实同一次操作。")}</Notice>}
          {visibleBootError&&<Notice title={t("暂时无法核实登录状态")} action={<Button onClick={refreshSession}>{t("重新核实")}</Button>}>{errorCopy(bootError)}</Notice>}
          <ResourceBoundary><Suspense key={`${session.accountId}:${client.getGeneration()}`} fallback={<Loading/>}>{page}</Suspense></ResourceBoundary>
        </main>
        <footer className="page-footer"><span>{session?.brand?.name || BRAND_NAME}{t("· 每次相聚都有安排")}</span><AppLink to="/help">{t("帮助与说明")}</AppLink><a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("源代码")} · AGPL-3.0</a></footer>
      </div>
    </div>:<div className="auth-shell">
      <header><AppLink to="/app/home" className="brand rsg-brand"><BrandLogo logoUrl={session?.brand?.logoUrl} width="52" height="52"/><strong>{session?.brand?.name || BRAND_NAME}</strong></AppLink><div className="topbar-actions"><span className="caption" title={t("显示时区")}>{t("显示时区")} · {zone}</span><LanguageSwitch/><AppLink to="/help">{t("帮助")}</AppLink></div></header>
      <main id="main">{visibleBootError&&<Notice title={t("暂时无法核实登录状态")} action={<Button onClick={refreshSession}>{t("重新核实")}</Button>}>{errorCopy(bootError)}</Notice>}<ResourceBoundary><Suspense fallback={<Loading/>}>{page}</Suspense></ResourceBoundary></main><footer className="page-footer"><a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{t("源代码")} · AGPL-3.0</a></footer>
    </div>}
  </AppContext.Provider>;
}
const rootElement=document.getElementById('root');
const root=rootElement.__nbClanRoot||createRoot(rootElement);rootElement.__nbClanRoot=root;root.render(<App/>);
