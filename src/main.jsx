// Both V2 workspaces share one identity/root; legacy routes retain their entry.
let workspaceRoute = /^\/(app(?:\/|$)|admin(?:\/|$)|auth(?:\/|$)|login(?:\/|$)|help(?:\/|$))/.test(window.location.pathname);
// The normal production host redirects root before HTML; this also handles an
// already-open/cached root page after activation without a separate build flag.
if (['/', '/index.html'].includes(window.location.pathname)) {
  try {
    const response = await fetch('/api/workspace-entry', { cache: 'no-store' });
    if (!response.ok) throw new Error('WORKSPACE_ENTRY_UNAVAILABLE');
    if ((await response.json()).defaultWorkspace === 'v2') {
      const route = new URLSearchParams(window.location.search).get('login') === '1' ? '/login' : '/app/home';
      history.replaceState({}, '', route);
      workspaceRoute = true;
    }
  } catch { /* Offline legacy root stays available; protected V2 routes never fall back. */ }
}
// Keep each dynamic import in its own statement so Vite retains the matching
// CSS/module preload graph for each route in production builds.
let entry;
if (workspaceRoute) entry = import('./v2/main.jsx');
else entry = import('./legacy-main.jsx');
entry.catch(() => {
  const root = document.getElementById('root');
  let language = navigator.languages?.[0] || navigator.language || 'zh';
  try { language = localStorage.getItem('nb-lang') || language; } catch { /* Storage may be unavailable. */ }
  const english = !/^zh(?:[-_]|$)/i.test(language);
  root.textContent = english ? 'Page resources could not be loaded. Check your connection and reload.' : '页面资源暂时无法载入，请检查网络后刷新。';
  const retry = document.createElement('button');
  retry.textContent = english ? 'Reload' : '重新加载'; retry.onclick = () => window.location.reload(); root.appendChild(retry);
});
