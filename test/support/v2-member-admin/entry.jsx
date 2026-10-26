import React, { useEffect, useState, useCallback, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { AppContext } from '../../../src/v2/context.jsx';
import { createQueryClient } from '../../../src/v2/query-client.js';
import '../../../src/v2/style.css';
const Page = lazy(() => import('../../../src/v2/member-admin/index.jsx'));
function App() {
  const [path, setPath] = useState(location.pathname + location.search),
    [session, setSession] = useState(null),
    [error, setError] = useState(''),
    [client] = useState(() => createQueryClient({
      onAuthorizationLost: () => {
        setSession(null);
        setError('会话或权限已变化，请重新选择构造账号。');
      }
    }));
  const go = useCallback(to => {
    history.pushState({}, '', to);
    setPath(location.pathname + location.search);
    window.scrollTo(0, 0);
  }, []);
  const refresh = async () => {
    const r = await client.request('/api/v2/auth/me');
    client.setIdentity({
      accountId: r.data.accountId,
      scopeVersion: r.meta.scopeVersion,
      csrfToken: r.data.csrfToken
    });
    setSession(r.data);
  };
  useEffect(() => {
    refresh().catch(() => {});
    const pop = () => setPath(location.pathname + location.search);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const login = async account => {
    client.clearIdentity('fixture-switch', {
      notify: false
    });
    setSession(null);
    await fetch('/__fixture/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        account
      })
    });
    setError('');
    await refresh();
  };
  return <div style={{
    minHeight: '100vh',
    background: '#f4f6f3'
  }}><header style={{
      background: '#203b30',
      color: 'white',
      padding: '18px 36px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between'
    }}><strong>NB CLAN · 成员管理隔离验收</strong><label>构造账号 <select aria-label="构造账号" value={session?.accountId || ''} onChange={e => login(e.target.value)} style={{
          marginLeft: 10,
          padding: 8
        }}><option value="" disabled>选择账号</option>{['admin', 'root', 'leader', 'member', 'viewer'].map(x => <option key={x}>{x}</option>)}</select></label></header><main style={{
      padding: '30px 38px'
    }}>{error && <p role="alert">{error}</p>}{session ? <AppContext value={{
        client,
        path,
        go,
        session,
        online: true,
        refreshSession: refresh
      }}><Suspense fallback={<p>正在加载成员管理…</p>}><Page /></Suspense></AppContext> : <p>选择上方构造账号进入。此运行器只使用独立本地 SQLite，无真实平台认证、采集或消息。</p>}</main></div>;
}
createRoot(document.getElementById('root')).render(<App />);
