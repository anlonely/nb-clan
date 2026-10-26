import React, {useEffect, useRef, useState} from 'react';
import {useApp} from '../context.jsx';
import {t} from '../i18n.js';
import {Button, Modal} from '../ui.jsx';
export default function UnsavedChanges({dirty, pending = false, onDiscard}) {
  const {go} = useApp(), [destination, setDestination] = useState(null), allowed = useRef(false);
  useEffect(() => {
    if (!dirty && !pending) return;
    const navigate = event => {
      if (allowed.current) {allowed.current = false; return;}
      event.preventDefault();
      setDestination(event.detail);
    };
    const unload = event => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('v2:before-navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {window.removeEventListener('v2:before-navigate', navigate); window.removeEventListener('beforeunload', unload);};
  }, [dirty, pending]);
  return destination && <Modal title={t(pending ? '请先核实当前操作' : '有未保存的改动')} onClose={() => setDestination(null)} actions={<><Button onClick={() => setDestination(null)}>{t('继续处理当前页面')}</Button>{!pending && <Button kind="danger" onClick={() => {onDiscard?.(); allowed.current = true; const next = destination; setDestination(null); go(next.to, next.options);}}>{t('放弃改动并离开')}</Button>}</>}><p>{t(pending ? '当前操作尚无最终回执，请先在当前页面查询回执或重试同次操作，避免重复执行。' : '切换页面会丢失当前未保存的配置。保存后再离开，或明确放弃本次改动。')}</p></Modal>;
}
