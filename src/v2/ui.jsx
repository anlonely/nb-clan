import { t } from './i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, UserRound, X } from 'lucide-react';
import { AppLink } from './context.jsx';
import { errorCopy } from './format.js';
export const Button = ({kind='',children,...props}) => <button type="button" className={`button ${kind}`} {...props}>{children}</button>;
export const Badge = ({children,tone=''}) => <span className={`badge ${tone}`}>{children}</span>;
export const Panel = ({children,...props}) => <section className="panel" {...props}>{children}</section>;
export function Avatar({ name = '', src, size, className = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`avatar ${className}`} aria-hidden="true" style={size ? { width: size, height: size } : undefined}>{src && !failed ? <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : name ? name.slice(0, 1) : <UserRound size={20}/>}</span>;
}
export const Title = ({children,eyebrow,subtitle,actions}) => <header className="page-title"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1 tabIndex={-1}>{children}</h1></div>{actions}</header>;
export const Notice = ({title,children,action,tone=''}) => <div className={`notice ${tone}`} role={tone==='error'?'alert':'status'}><AlertCircle size={20}/><div><strong>{title}</strong>{children && <p>{children}</p>}{action}</div></div>;
export const Empty = ({title,children,to='/app/home',action=t("返回首页")}) => <div className="empty"><h2>{title}</h2><p className="muted">{children}</p><AppLink to={to} className="button">{action}<ArrowRight size={16}/></AppLink></div>;
export const Loading = () => <div role="status" aria-label={t("正在加载")} className="loading"><span>{t("正在加载安排…")}</span><div className="skeleton"/><div className="skeleton short"/></div>;
export function QueryState({query,children}) {
  if (!query.data) return query.error ? <Notice title={t("暂时无法读取")} tone="error" action={<Button onClick={query.retry}>{t("重试")}</Button>}>{errorCopy(query.error)}</Notice> : <Loading/>;
  return <>{query.error ? <Notice title={t("显示上次读取的数据")} action={<Button onClick={query.retry}>{t("重新读取")}</Button>}>{errorCopy(query.error)}</Notice> : null}{children(query.data)}</>;
}
export function Modal({title,children,onClose,actions,className=''}) {
  const ref=useRef(null);
  useEffect(()=>{ const dialog=ref.current;dialog.showModal();return()=>dialog.close(); },[]);
  return <dialog ref={ref} className={`modal ${className}`} onCancel={e=>{e.preventDefault();onClose();}} aria-labelledby="dialog-title"><header><h2 id="dialog-title">{title}</h2><Button aria-label={t("关闭对话框")} onClick={onClose}><X size={18}/></Button></header><div className="modal-body">{children}</div><footer>{actions}</footer></dialog>;
}
