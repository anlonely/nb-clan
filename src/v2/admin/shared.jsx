import React from 'react';
import { t } from '../i18n.js';
import { AppLink } from '../context.jsx';
import { Button, Notice, QueryState as SharedQueryState } from '../ui.jsx';
import { errorCopy } from '../format.js';
export const adminError=error=>t(({WIPE_INCOMPLETE:'请补齐服务器和时间后再创建。',SIGNUP_WINDOW_INVALID:'报名截止时间必须晚于当前时间。',INVALID_WIPE:'请检查档期字段。',REVISION_CONFLICT:'这份记录已被修改，请读取最新版本，对比后重新确认。',WIPE_IMMUTABLE:'当前阶段不允许这项修改。',REASON_REQUIRED:'请填写操作原因。',COMPLETENESS_REQUIRED:'请选择归档数据完整程度。',ADMIN_OPERATION_STORAGE_UNAVAILABLE:'浏览器无法保存待确认操作，请允许会话存储后重试。',SERVER_CONNECT_INVALID:'服务器直连请填写 connect 主机:端口。',SERVER_CONNECT_PORT_INVALID:'服务器直连端口必须在 1 到 65535 之间。',SERVER_MAP_URL_INVALID:'地图链接请填写完整的 HTTPS 地址。'}[error?.errorCode]||errorCopy(error)));
export function OperationNotice({op,onCompare}) {
  const {state}=op;
  if(state.status==='idle')return null;
  if(['unknown','submitting'].includes(state.status))return <Notice title={state.status==='submitting'?t('正在提交，请稍候'):t('提交结果待核实')} action={<div className="admin-row"><Button disabled={state.status==='submitting'} onClick={op.reconcile}>{t("核实同一次操作")}</Button><Button disabled={state.status==='submitting'} onClick={op.retry}>{t("重试同一次操作")}</Button></div>}>{t("已保留原操作内容。暂时查不到回执不代表未提交；请先核实，避免重复操作。")}</Notice>;
  if(state.status==='committed')return null;
  if(state.status==='cancelled')return <Notice title={t("身份或权限已变化")}>{t("请重新核实登录后继续。")}</Notice>;
  return <Notice tone="error" title={state.status==='conflict'?t('版本有变化，尚未覆盖'):t('这次操作未完成')} action={onCompare?<Button onClick={onCompare}>{t("读取最新版本并核对")}</Button>:undefined}>{adminError(state.error)} {Object.keys(state.error?.fieldErrors||{}).join('、')}</Notice>;
}
export function Pager({cursor,nextCursor,base}) { const join=base.includes('?')?'&':'?';return (cursor||nextCursor)?<nav className="admin-row admin-pager" aria-label={t("翻页")}>{cursor&&<AppLink className="button" to={base}>{t("返回第一页")}</AppLink>}{nextCursor&&<AppLink className="button" to={`${base}${join}cursor=${encodeURIComponent(nextCursor)}`}>{t("下一页")}</AppLink>}</nav>:null; }
export function ErrorNotice({error}) {return error?<Notice tone="error" title={t("请检查后继续")}>{adminError(error)} {error.candidates?.map(c=>`${c.utcOffset} (${c.utc})`).join(t(' 或 '))}</Notice>:null;}

export function AdminQueryState({query,children}) {
  if ([401,403,404].includes(query.error?.status)) return <Notice tone="error" title={t("当前无法查看这项记录")} action={<Button onClick={()=>query.retry().catch(()=>{})}>{t("重新核实访问权限")}</Button>}>{adminError(query.error)}</Notice>;
  return <SharedQueryState query={{...query,retry:()=>query.retry().catch(()=>{})}}>{children}</SharedQueryState>;
}
