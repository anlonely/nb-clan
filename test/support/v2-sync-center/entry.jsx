// Standalone verification entry. The public App is owned by the integration task.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext, AppLink } from '../../../src/v2/context.jsx';
import { createQueryClient } from '../../../src/v2/query-client.js';
import { Button, Loading, Notice } from '../../../src/v2/ui.jsx';

import AdminWorkspace from '../../../src/v2/sync-center/index.jsx';
import '../../../src/v2/style.css';
function IsolatedApp() {
  const [path,setPath] = useState(location.pathname+location.search), [session,setSession] = useState(null), [booting,setBooting] = useState(true), [error,setError] = useState(null), [online,setOnline] = useState(navigator.onLine);
  const authEpoch=useRef(0);
  const [client] = useState(() => createQueryClient({ defaultTimeoutMs:5000, onAuthorizationLost:() => { authEpoch.current++; setSession(null); setBooting(false); } }));
  const go = useCallback((to,{replace=false}={}) => { if(!to.startsWith('/')||to.startsWith('//'))return; history[replace?'replaceState':'pushState']({},'',to); setPath(location.pathname+location.search); window.scrollTo(0,0); },[]);
  const refreshSession=useCallback(async()=>{
    const epoch=++authEpoch.current;
    try { const response=await client.request('/api/v2/auth/me'); if(epoch!==authEpoch.current)return;
      client.setIdentity({ accountId:response.data.accountId, scopeVersion:response.meta.scopeVersion, csrfToken:response.data.csrfToken }); setSession(response.data);setError(null);return response.data;
    }catch(e){if(epoch===authEpoch.current){setSession(null);if(!['AUTH_REQUIRED','AUTH_SESSION_INVALID'].includes(e.errorCode))setError(e);}}
    finally{if(epoch===authEpoch.current)setBooting(false);}
  },[client]);
  const logout=async()=>{try{await client.request('/api/v2/auth/logout',{method:'POST',body:{}});client.clearIdentity('logout');setSession(null);go('/admin/sync/data');}catch(e){setError(e);}};
  useEffect(()=>{refreshSession();const pop=()=>setPath(location.pathname+location.search),up=()=>{setOnline(true);refreshSession();},down=()=>setOnline(false);
    addEventListener('popstate',pop);addEventListener('online',up);addEventListener('offline',down);
    return()=>{removeEventListener('popstate',pop);removeEventListener('online',up);removeEventListener('offline',down);};
  },[refreshSession]);
  useEffect(()=>{if(!session)return;const events=new EventSource('/api/v2/auth/events');const revoke=()=>client.clearIdentity('authorization-revoked');events.addEventListener('authorization-revoked',revoke);return()=>events.close();},[session?.accountId,client]);
  const context={client,session,path,go,refreshSession,logout,online,zone:session?.member?.timeZone||'Asia/Shanghai',updateProfile:()=>{}};
  return <AppContext.Provider value={context}>
    <div role="note" style={{background:'#fff2cc',color:'#533f15',borderBottom:'1px solid #e5cc78',padding:'9px 24px',fontSize:13,marginLeft:session&&!path.startsWith('/app/')?216:0}}><strong>G07-sync 本地隔离验收</strong> · 任务 / 回执 / 会话：真实 G03 / G07 与隔离 SQLite；平台身份和采集结果为构造适配器，无真实外发。</div>
    {booting?<Loading/>:!session?<main className="main" style={{maxWidth:700,margin:'70px auto'}}><h1>管理空间隔离登录</h1><p>本页登录经过真实 G03 OAuth 回调、会话与 CSRF。下一页选择“值班管理员 · admin”。平台身份为构造数据。</p>{error&&<Notice title="读取失败">{error.errorCode||error.message}</Notice>}<a className="button primary" href={`/api/v2/auth/discord/start?returnTo=${encodeURIComponent(path.startsWith('/admin/')?path:'/admin/sync/data')}`}>使用构造 Discord 身份登录</a><Button onClick={refreshSession}>重新读取会话</Button></main>:<>{path.startsWith('/app/')?<main className="main"><AppLink to="/admin/sync/data">返回管理空间</AppLink><AdminWorkspace/></main>:<div className="app-shell"><aside className="sidebar"><AppLink to="/admin/sync/data" className="brand"><strong>NB<span>CLAN</span></strong><small>一起开荒，一起回家。</small></AppLink><p className="workspace-label">管理空间</p><nav aria-label="管理导航"><AppLink to="/admin/sync/data" className="nav-link active">同步中心</AppLink><AppLink to="/admin/sync/plans" className="nav-link">自动计划</AppLink>{session.workspaces?.member===true&&<AppLink to="/app/home" className="nav-link">返回成员空间</AppLink>}</nav><div className="sidebar-bottom"><button onClick={logout}>退出登录</button><small>隔离构造身份 · 无真实外发</small></div></aside><div className="workspace"><header className="topbar"><span>NB CLAN <i>/</i> 管理空间</span><span>{session.displayName}</span></header><main id="main" className="main"><AdminWorkspace/></main><footer className="page-footer">G07-sync 本地隔离运行器</footer></div></div>}</>}
  </AppContext.Provider>;
}
const rootElement=document.getElementById('root');
const root=rootElement.__g07SyncRoot||createRoot(rootElement);
rootElement.__g07SyncRoot=root;
root.render(<IsolatedApp/>);
