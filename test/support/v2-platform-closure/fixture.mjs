import {fixture as original} from '../v2-platform-host/fixture.mjs';
import {installNotificationBusinessSchema,installNotificationPlatformCardSchema} from '../../../server/v2/notifications/index.js';
import {createNotificationWorker} from '../../../server/v2/notifications/worker.js';
import {createPlatformCards} from '../../../server/v2/platform-admin/cards.js';
export async function fixture(){
 const f=original();await f.start();
 installNotificationBusinessSchema(f.db);installNotificationPlatformCardSchema(f.db);
 const targets=()=>f.g06.targets().map(t=>({...t,label:t.name,languages:['zh-CN'],roleOptions:[]}));
 Object.assign(f.notifications.catalog,{listTargets:targets,getTarget:id=>targets().find(t=>t.id===id)});
 // The original fixture does not opt in to the new schema. Explicitly bind the
 // domain after migration, using the SAME notification service and original queue.
 const cards=createPlatformCards({identity:f.identity,scheduling:f.scheduling,stats:f.stats,notifications:f.notifications,platformService:f.platformService,runStoreWriteTask:f.runStoreWriteTask,now:f.now});
 Object.assign(f.platformService.adapters.cards,cards);
 const worker=createNotificationWorker(f.notifications);
 const execute=(action,input,operationId)=>f.platformService.execute(f.actor('admin'),'discord',action,{expectedRevision:1,...input},{operationId});
 const preview=async(cardType='map',extra={})=>(await execute('card_preview',{targetId:'discord-target',cardType,wipeId:'host-wipe',...extra},'preview-'+Math.random().toString(36).slice(2))).result.preview;
 const command=(p,action='card_publish',id='card-command')=>execute(action,{targetId:'discord-target',cardType:'map',wipeId:'host-wipe',previewId:p.id,contentHash:p.contentHash},id);
 return {...f,worker,execute,preview,command,async close(){await worker.stop();await f.close();}};
}
