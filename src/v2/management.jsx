import React, { lazy, useEffect } from 'react';
import { t } from './i18n.js';
import { useApp, AppLink } from './context.jsx';
import { Notice } from './ui.jsx';
import { managementHome, managementNavigation, managementSection } from './management-navigation.js';
const modules = {
  wipes: lazy(() => import('./admin/index.jsx')),
  members: lazy(() => import('./member-admin/index.jsx')),
  stats: lazy(() => import('./stats/index.jsx')),
  sync: lazy(() => import('./sync-center/index.jsx')),
  realtime: lazy(() => import('./realtime/index.jsx')),
  bot: lazy(() => import('./bot-admin/index.jsx')),
  platforms: lazy(() => import('./platform-admin/index.jsx')),
  system: lazy(() => import('./system-admin/index.jsx'))
};
export default function ManagementWorkspace() {
  const { path, session, go } = useApp(), section = managementSection(path), home = managementHome(session);
  useEffect(() => { if (path === '/admin' || path === '/admin/') go(home, { replace: true }); }, [path, home, go]);
  if (!managementNavigation(session).some(item => item.id === section)) return <Notice title={t("这个管理页面不可用")} action={<AppLink to={home}>{t("返回管理空间")}</AppLink>}>{t("请从当前账号可见的导航进入。")}</Notice>;
  const Page = modules[section];
  return <Page key={section}/>;
}
