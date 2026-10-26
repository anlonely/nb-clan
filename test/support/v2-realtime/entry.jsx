// Standalone verification entry. The public App is owned by the integration task.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext, AppLink } from '../../../src/v2/context.jsx';
import { createQueryClient } from '../../../src/v2/query-client.js';
import { Button, Loading, Notice } from '../../../src/v2/ui.jsx';
import RealtimeWorkspace from '../../../src/v2/realtime/index.jsx';
import '../../../src/v2/style.css';
function IsolatedApp() {
  const [path, setPath] = useState(location.pathname + location.search),
    [session, setSession] = useState(null),
    [booting, setBooting] = useState(true),
    [error, setError] = useState(null),
    [online, setOnline] = useState(navigator.onLine);
  const authEpoch = useRef(0);
  const [client] = useState(() => createQueryClient({
    defaultTimeoutMs: 5000,
    onAuthorizationLost: () => {
      authEpoch.current++;
      setSession(null);
      setBooting(false);
    }
  }));
  const go = useCallback((to, {
    replace = false
  } = {}) => {
    if (!to.startsWith('/') || to.startsWith('//')) return;
    history[replace ? 'replaceState' : 'pushState']({}, '', to);
    setPath(location.pathname + location.search);
    window.scrollTo(0, 0);
  }, []);
  const refreshSession = useCallback(async () => {
    const epoch = ++authEpoch.current;
    try {
      const response = await client.request('/api/v2/bootstrap');
      if (epoch !== authEpoch.current) return;
      client.setIdentity({
        accountId: response.data.accountId,
        scopeVersion: response.meta.scopeVersion,
        csrfToken: response.data.csrfToken
      });
      setSession(response.data);
      setError(null);
      return response.data;
    } catch (e) {
      if (epoch === authEpoch.current) {
        setSession(null);
        if (!['AUTH_REQUIRED', 'AUTH_SESSION_INVALID'].includes(e.errorCode)) setError(e);
      }
    } finally {
      if (epoch === authEpoch.current) setBooting(false);
    }
  }, [client]);
  const logout = async () => {
    try {
      await client.request('/api/v2/auth/logout', {
        method: 'POST',
        body: {}
      });
      client.clearIdentity('logout');
      setSession(null);
      go('/admin/realtime');
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    refreshSession();
    const pop = () => setPath(location.pathname + location.search),
      up = () => {
        setOnline(true);
        refreshSession();
      },
      down = () => setOnline(false);
    addEventListener('popstate', pop);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => {
      removeEventListener('popstate', pop);
      removeEventListener('online', up);
      removeEventListener('offline', down);
    };
  }, [refreshSession]);
  useEffect(() => {
    if (!session) return;
    const events = new EventSource('/api/v2/auth/events');
    const revoke = () => client.clearIdentity('authorization-revoked');
    events.addEventListener('authorization-revoked', revoke);
    return () => events.close();
  }, [session?.accountId, client]);
  const context = {
    client,
    session,
    path,
    go,
    refreshSession,
    logout,
    online,
    zone: session?.member?.timeZone || 'Asia/Shanghai',
    updateProfile: () => {}
  };
  return <AppContext.Provider value={context}>
    <div role="note" style={{
      background: '#fff2cc',
      color: '#533f15',
      borderBottom: '1px solid #e5cc78',
      padding: '9px 24px',
      fontSize: 13,
      marginLeft: session && !path.startsWith('/app/') ? 216 : 0
    }}><strong>G07-realtime 本地隔离验收</strong> · 真实 G03 会话与 SQLite 实时后端；账号与数据源为构造数据，无真实外部采集。</div>
    {booting ? <Loading /> : !session ? <main className="main" style={{
      maxWidth: 700,
      margin: '70px auto'
    }}><h1>管理空间隔离登录</h1><p>选择构造账号后使用真实 G03 会话与 CSRF；本页不验证外部 OAuth。</p><a className="button primary" href="/__fixture/login/admin">以构造管理员登录</a><a className="button" href="/__fixture/login/alpha">以构造成员登录</a><Button onClick={refreshSession}>重新读取会话</Button></main> : <>{path.startsWith('/app/') ? <main className="main"><AppLink to="/admin/realtime">返回管理空间</AppLink><RealtimeWorkspace /></main> : <div className="app-shell"><aside className="sidebar"><AppLink to="/admin/realtime" className="brand"><strong>NB<span>CLAN</span></strong><small>一起开荒，一起回家。</small></AppLink><p className="workspace-label">管理空间</p><nav aria-label="管理导航"><AppLink to="/admin/realtime" className="nav-link active">战队实时</AppLink><AppLink to="/admin/realtime/chat" className="nav-link">只读聊天</AppLink>{session.workspaces?.member === true && <AppLink to="/app/home" className="nav-link">返回成员空间</AppLink>}</nav><div className="sidebar-bottom"><button onClick={logout}>退出登录</button><small>隔离构造身份 · 无真实外发</small></div></aside><div className="workspace"><header className="topbar"><span>NB CLAN <i>/</i> 管理空间</span><span>{session.displayName}</span></header><main id="main" className="main"><RealtimeWorkspace /></main><footer className="page-footer">G07-realtime 本地隔离运行器</footer></div></div>}</>}
  </AppContext.Provider>;
}
const rootElement = document.getElementById('root');
const root = rootElement.__g07StatsRoot || createRoot(rootElement);
rootElement.__g07StatsRoot = root;
root.render(<IsolatedApp />);
