// Portable request adapter for the mini-program owner. request({path,method,
// headers,body}) must return the V2 envelope and throw structured HTTP errors.
// No wx global, hard-coded production URL, or alternate signup state is used.
export function createMiniProgramClient({request,createOperationId}){
 let token=null,pending=new Map();const id=()=>{if(typeof createOperationId!=='function')throw new Error('OPERATION_ID_FACTORY_REQUIRED');return createOperationId();};
 const call=(path,{method='GET',body,operationId}={})=>request({path:`/api/v2/mini-program${path}`,method,body,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(operationId?{'Idempotency-Key':operationId}:{})}});
 return {capabilities:()=>call('/capabilities'),async login(code){const r=await call('/login',{method:'POST',body:{code,clientVersion:2}});token=r.data.token;pending.clear();return r.data;},async logout(){try{return await call('/logout',{method:'POST',operationId:id(),body:{}});}finally{token=null;pending.clear();}},wipe:wipeId=>call(`/wipes/${encodeURIComponent(wipeId)}`),
  async signup({wipeId,input,actionKey='self'}){const key=`${wipeId}:${actionKey}`,body={kind:'direct-v2',adapterVersion:2,wipeId,input},digest=JSON.stringify(body);let op=pending.get(key);if(op&&op.digest!==digest)throw new Error('PREVIOUS_OPERATION_UNRESOLVED');if(!op){op={id:id(),digest};pending.set(key,op);}try{const r=await call('/signup',{method:'POST',body,operationId:op.id});pending.delete(key);return r.data;}catch(e){if(e.status>=400&&e.status<500)pending.delete(key);throw e;}},
  confirm:({contextToken,input,operationId})=>call('/signup',{method:'POST',body:{kind:'confirm',contextToken,input},operationId}),
  legacy:({wipeId,status,operationId})=>call('/signup',{method:'POST',body:{kind:'legacy',adapterVersion:1,wipeId,legacyStatus:status,legacyToggle:true},operationId}),
  command:({command,input,operationId})=>call(`/commands/${encodeURIComponent(command)}`,{method:'POST',body:input,operationId})};
}
