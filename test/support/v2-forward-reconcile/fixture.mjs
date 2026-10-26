import { fixture as hostFixture } from '../v2-platform-host/fixture.mjs';
import { createIsolatedNotificationTransport } from '../../../server/v2/notification-platforms/isolated-transport.js';
import { createNotificationPlatforms } from '../../../server/v2/notification-platforms/platforms.js';
export async function fixture() {
 const transport=createIsolatedNotificationTransport(),native=createNotificationPlatforms({transport}),hooks={};let f;
 const platforms=Object.fromEntries(['discord','kook'].map(platform=>[platform,{...native[platform],
  send:async args=>{const result=await native[platform].send(args);await hooks.afterSend?.(result,args);return result;},
  lookup:async args=>{await hooks.beforeLookup?.(args);return hooks.lookup?hooks.lookup(args):native[platform].lookup(args);}
 }]));
 const targets=()=>['discord','kook'].flatMap(platform=>f.platformService.config(platform).targets.map(t=>({...t,platform,runtimeMode:'isolated',transportKey:`${platform}-isolated`,configurationRevision:f.platformService.config(platform).revision})));
 f=hostFixture({options:{g06:{platforms,targets}}});await f.start();
 f.sourcePages.set('discord:200000000000000001',{verified:true,items:[{id:'forward-source-one',channelId:'200000000000000001',content:'构造转发内容 @everyone',author:'构造成员'}],nextCursor:'fixture-tail'});
 let counter=0;
 const call=async(action,input={},operationId=`forward-test-${++counter}`,actor=f.actor('admin'))=>f.platformService.execute(actor,'bridge',action,{expectedRevision:f.platformService.config('bridge').revision,...input},{operationId});
 const record=()=>{const row=f.db.prepare("SELECT id,payload FROM platform_admin_records WHERE kind='forward' AND json_extract(payload,'$.sourceId')='forward-source-one'").get();return row?{key:row.id,...JSON.parse(row.payload)}:null;};
 const update=value=>{const {key,...row}=value;f.platformService.repo.put('forward',key,'bridge','admin',f.now(),row);};
 return {...f,transport,native,platforms,hooks,targets,call,record,update,
  run:(key)=>call('forward_run',{},key),reconcile:(key)=>call('forward_reconcile',{recordId:record().key},key)};
}
