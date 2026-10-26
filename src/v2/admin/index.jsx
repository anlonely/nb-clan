import React,{useEffect} from 'react';
import { t } from '../i18n.js';
import {useApp,AppLink} from '../context.jsx';
import {Notice} from '../ui.jsx';
import {matchAdminLocation} from './model.js';
import {WipeList,WipeDetail} from './wipes.jsx';
import {WipeWizard} from './wizard.jsx';
import {NotificationWizard,IntentPage,DeliveryPage} from './notifications.jsx';
import './style.css';
import './history.css';
import {PendingAdminOperations} from './recovery.jsx';
export {matchAdminLocation};
export default function AdminWorkspace(){
  const {path,go,session}=useApp(),route=matchAdminLocation(path);
  useEffect(()=>{if(['/admin','/admin/'].includes(path))go('/admin/wipes',{replace:true});},[path,go]);
  let page;
  if(!route)page=<Notice title={t("管理页面不存在")} action={<AppLink to="/admin/wipes">{t("返回档期列表")}</AppLink>}>{t("请从管理空间重新选择。")}</Notice>;
  else if(route.page==='list')page=<WipeList/>;
  else if(route.page==='new')page=<WipeWizard/>;
  else if(route.page==='wipe')page=<WipeDetail id={route.wipeId}/>;
  else if(route.page==='notifications')page=<NotificationWizard wipeId={route.wipeId} repeatDeliveryId={route.searchParams.get('repeatDeliveryId')||undefined}/>;
  else if(route.page==='intent')page=<IntentPage intentId={route.intentId}/>;
  else page=<DeliveryPage deliveryId={route.deliveryId}/>;
  return <section className="v2-admin"><div className="admin-space-switch"><AppLink to="/admin/wipes">{t("档期管理")}</AppLink>{session.workspaces?.member === true && <AppLink to="/app/home">{t("返回成员空间 ↗")}</AppLink>}</div><PendingAdminOperations/><div key={`${route?.page}:${route?.wipeId||route?.intentId||route?.deliveryId||''}`}>{page}</div></section>;
}
