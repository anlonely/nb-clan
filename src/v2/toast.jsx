import { t } from './i18n.js';
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, X } from 'lucide-react';
import { successToasts as store } from './toast-store.js';
import './toast.css';

export { notifySuccess } from './toast-store.js';

export function ToastHost({ client }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const host = useRef(null);
  useEffect(() => {
    const element = host.current;
    if (!element?.showPopover) return;
    // Keep feedback visible above native dialogs, without moving keyboard focus.
    if (items.length) element.showPopover();
    else if (element.matches(':popover-open')) element.hidePopover();
  }, [items]);
  useEffect(() => {
    const unsubscribe = client.subscribeIdentity(() => store.clear());
    return () => { unsubscribe(); store.clear(); };
  }, [client]);
  return createPortal(<div ref={host} popover="manual" className="toast-host" aria-label={t("操作提示")} aria-live="polite" aria-relevant="additions">
    {items.map(item => <div className="save-toast" key={item.id} role="status">
      <CheckCircle2 size={20}/><span>{t(item.message)}</span>
      <button type="button" aria-label={t("关闭提示")} onClick={() => store.dismiss(item.id)}><X size={16}/></button>
    </div>)}
  </div>, document.body);
}
