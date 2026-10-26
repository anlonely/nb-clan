import {useEffect,useRef,useState} from 'react';
import {t} from '../i18n.js';
import { notifySuccess } from '../toast-store.js';
export function downloadResult(r) {
 if(!r?.content)return;
 const url=URL.createObjectURL(new Blob([r.content],{type:r.contentType||'text/plain'})),a=document.createElement('a');
 a.href=url;a.download=r.fileName||'system-export.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
// Only receipt identity is persisted. Passwords, tokens, proxy credentials, files and
// role/account payloads remain in the current component memory and are cleared on auth change.
export function useSystemOperation(client,onDone) {
 const scope=client.getIdentity(),key=`v2-system-operation:${scope?.accountId}`;
 const body=useRef(null),lock=useRef(false),[journal,setJournal]=useState(null),[state,setState]=useState('idle'),[error,setError]=useState(null),[result,setResult]=useState(null);
 useEffect(()=>{body.current=null;lock.current=false;setJournal(null);setError(null);setResult(null);setState('idle');
  try{const j=JSON.parse(sessionStorage.getItem(key));if(j){setJournal(j);setState('unknown');lock.current=true;}}catch{}
  return()=>{body.current=null;};
 },[key]);
 const success=(j,r)=>{sessionStorage.removeItem(key);body.current=null;lock.current=false;setJournal(null);setState('saved');setResult(r);
  if(!['brand.upload.start','brand.upload.part'].includes(j.action))notifySuccess(j.action==='proxy.probe'||j.action.endsWith('.export')||j.action==='storage.backup'?"操作成功":"保存成功",{id:j.id});
  onDone?.({...r,action:j.action});};
 async function send(j,payload) {
  const epoch=client.getGeneration();setError(null);setState('submitting');
  try{const r=await client.request(`/api/v2/system-admin/commands/${j.action}`,{method:'POST',body:{target:j.target,input:payload},headers:{'Idempotency-Key':j.id},timeoutMs:30000});
   if(epoch!==client.getGeneration())return;success(j,r.data);return r.data;
  }catch(e){if(epoch!==client.getGeneration())return;setError(e);const unknown=!e.status||e.status>=500;setState(unknown?'unknown':'error');
   if(!unknown){sessionStorage.removeItem(key);body.current=null;lock.current=false;setJournal(null);}throw e;
  }
 }
 return {state,error,result,journal,busy:state==='submitting'||state==='unknown',
  async run(action,input,target=''){if(client.getIdentity()?.accountId!==scope?.accountId || client.getIdentity()?.scopeVersion!==scope?.scopeVersion)throw Error('AUTH_CHANGED');if(lock.current)throw Error(t("操作尚未核实"));lock.current=true;const j={id:crypto.randomUUID(),action,target};
   try{sessionStorage.setItem(key,JSON.stringify(j));}catch{lock.current=false;setError({errorCode:"操作编号无法保存在本次会话中"});return;}
   body.current=input;setJournal(j);return send(j,input);},
  retry:()=>journal&&body.current&&send(journal,body.current),canRetry:!!body.current,
  async reconcile(){if(!journal)return;const epoch=client.getGeneration();try{const r=await client.request(`/api/v2/system-admin/operations/${journal.id}`);if(epoch!==client.getGeneration())return;
   if(r.data.state==='succeeded')success(journal,r.data);else {const recovered=await client.request(`/api/v2/system-admin/operations/${journal.id}/recover`,{method:'POST',headers:{'Idempotency-Key':journal.id},timeoutMs:30000});if(epoch===client.getGeneration())success(journal,recovered.data);}
  }catch(e){if(epoch!==client.getGeneration())return;setError(e);if(e.status===404){sessionStorage.removeItem(key);setJournal(null);body.current=null;lock.current=false;setState('not-recorded');}else setState('unknown');}}
 };
}
