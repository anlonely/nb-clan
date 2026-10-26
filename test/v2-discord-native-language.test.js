import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture} from './support/v2-native-interactions/fixture.mjs';
import {retainedDiscordCommandSchemas} from '../server/v2/notification-platforms/native-interactions.js';
import {createPublishedPlatformAdapters} from '../server/v2/platform-admin/published-services.js';

const cases=[
 {locale:'zh-CN',edit:'更新本人 VIP 信息',month:'购买月份（本年）',day:'购买日期',none:'无 VIP',saved:'本人 VIP 信息已保存',queued:'报名卡已排队，尚未送达',delivered:'报名卡已送达',kills:'击杀',querySaved:'查询结果已保存'},
 {locale:'en-US',edit:'Update your VIP information',month:'Purchase month (this year)',day:'Purchase day',none:'No VIP',saved:'Your VIP information has been saved',queued:'Sign-up card queued, awaiting delivery',delivered:'Sign-up card delivered',kills:'Kills',querySaved:'Query results saved'},
 {locale:'ru',edit:'Обновить свои данные VIP',month:'Месяц покупки (этот год)',day:'День покупки',none:'Без VIP',saved:'Ваши данные VIP сохранены',queued:'Карточка записи в очереди на отправку',delivered:'Карточка записи доставлена',kills:'Убийства',querySaved:'Результаты запроса сохранены'},
 {locale:'tr',edit:'VIP bilgilerinizi güncelleyin',month:'Satın alma ayı (bu yıl)',day:'Satın alma günü',none:'VIP yok',saved:'VIP bilgileriniz kaydedildi',queued:'Kayıt kartı gönderim için sıraya alındı',delivered:'Kayıt kartı gönderildi',kills:'Öldürme',querySaved:'Sorgu sonuçları kaydedildi'},
 {locale:'th',edit:'อัปเดตข้อมูล VIP ของคุณ',month:'เดือนที่ซื้อ (ปีนี้)',day:'วันที่ซื้อ',none:'ไม่มี VIP',saved:'บันทึกข้อมูล VIP ของคุณแล้ว',queued:'การ์ดลงชื่ออยู่ในคิวรอส่ง',delivered:'ส่งการ์ดลงชื่อแล้ว',kills:'สังหาร',querySaved:'บันทึกผลการค้นหาแล้ว'},
 {locale:'ko',edit:'내 VIP 정보 수정',month:'구매 월 (올해)',day:'구매 일',none:'VIP 없음',saved:'내 VIP 정보가 저장되었습니다',queued:'참가 신청 카드가 전송 대기 중입니다',delivered:'참가 신청 카드가 전송되었습니다',kills:'처치',querySaved:'조회 결과가 저장되었습니다'}
];
const setup=async t=>{const f=await fixture();t.after(()=>f.close());const listTargets=f.notifications.catalog.listTargets;f.notifications.catalog.listTargets=()=>listTargets().map(target=>({...target,languages:target.platform==='discord'?['zh-CN','en']:target.languages}));f.notifications.catalog.getTarget=id=>f.notifications.catalog.listTargets().find(target=>target.id===id);return f;};
const localized=(event,locale)=>({...event,...(locale===undefined?{}:{locale}),guild_locale:locale==='zh-CN'?'en-US':'zh-CN'});
// Eligibility is deliberately rechecked on every interaction. Compare all other
// persisted business rows; hash the snapshot to keep failures concise.
const snapshot=f=>createHash('sha256').update(JSON.stringify(Object.fromEntries(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,f.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all().filter(row=>row.collection!=='v2Eligibility')])))).digest('hex');
const submit=(f,id,custom_id,locale)=>localized(f.discord(id,5,{custom_id,components:[{type:18,component:{type:3,custom_id:'date_month',values:['9']}},{type:18,component:{type:4,custom_id:'date_day',value:'8'}}]}),locale);

test('retained slash schemas localize every description while keeping canonical IDs and enabled scope',()=>{
 const config={targets:[{enabled:true,enabledCommandIds:['kda','ranking','map','attendance']}],commands:[{id:'attendance',enabled:true,type:'event_command',slashCommand:'wipe-react'},{id:'off',enabled:false,type:'event_command',slashCommand:'disabled'}]};
 const commands=retainedDiscordCommandSchemas(config);
 assert.deepEqual(commands.map(c=>c.name),['kda','ranking','map','wipe-react']);
 for(const field of commands.flatMap(command=>[command,...command.options])){
  assert.ok(field.description.length>0&&field.description.length<=100);
  assert.doesNotMatch(field.description,/[\u3400-\u9fff]/);
  for(const locale of ['zh-CN','zh-TW','en-US','en-GB','ru','tr','th','ko']){assert.ok(field.description_localizations[locale].length>0&&field.description_localizations[locale].length<=100);}
  assert.equal(field.description_localizations['zh-TW'],field.description_localizations['zh-CN']);
  assert.equal(field.description_localizations['en-US'],field.description);
 }
 assert.deepEqual(commands.at(-1).options.map(o=>[o.name,o.type,o.required]),[['wipe',3,true],['mention_everyone',5,false]]);
 assert.deepEqual(retainedDiscordCommandSchemas({targets:[{enabled:false,enabledCommandIds:config.targets[0].enabledCommandIds}],commands:config.commands}),[]);
});

for(const language of cases){
 test(`signed ${language.locale} VIP select/modal/save and locale replay remain private and apply once`,async t=>{
  const f=await setup(t),event=(id,type,data)=>localized(f.discord(id,type,data),language.locale);
  const open=await f.send('discord',event('open',3,{component_type:2,custom_id:'nb_vital_vip:open'}));
  assert.equal(open.ack.type,4);assert.equal(open.ack.data.flags,64);assert.equal(open.ack.data.content,language.edit);
  assert.deepEqual(open.ack.data.components[0].components[0].options.map(o=>o.value),['vital','rustinity','atlas']);
  const provider=await f.send('discord',event('provider',3,{component_type:3,custom_id:'nb_vital_vip:provider',values:['atlas']}));
  assert.equal(provider.ack.data.components[0].components[0].options[0].label,language.none);
  assert.deepEqual(provider.ack.data.components[0].components[0].options.map(o=>o.value),['none','queue_skip','priority']);
  const modalEvent=event('modal',3,{component_type:3,custom_id:'nb_vital_vip:type:atlas',values:['priority']}),modal=await f.send('discord',modalEvent);
  assert.equal(modal.ack.type,9);assert.ok(modal.ack.data.title.length<=45);assert.equal(modal.ack.data.components[0].label,language.month);assert.equal(modal.ack.data.components[1].label,language.day);
  assert.deepEqual(modal.ack.data.components.map(row=>row.component.custom_id),['date_month','date_day']);
  const before=snapshot(f),replay=await f.send('discord',modalEvent);
  assert.equal(replay.ack.data.custom_id,modal.ack.data.custom_id);assert.equal(replay.ack.data.components[0].label,language.month);assert.deepEqual(snapshot(f),before);
  const revision=f.ir.get('members','m002').revision,submission=submit(f,'submit',modal.ack.data.custom_id,language.locale),saved=await f.send('discord',submission);
  assert.deepEqual(saved.ack,{type:5,data:{flags:64}});assert.ok(saved.reply.payload.content.includes(language.saved));assert.equal(f.ir.get('members','m002').revision,revision+1);
  const after=snapshot(f),receipt=await f.send('discord',submission);
  assert.ok(receipt.reply.payload.content.includes(language.saved));assert.deepEqual(snapshot(f),after);assert.equal(f.transport.getCalls().length,0);
 });

 test(`signed ${language.locale} wipe command receipt follows actor locale without changing the public card`,async t=>{
  const f=await setup(t),event=localized(f.discord('wipe-localized',2,{name:'gather',options:[{name:'wipe',type:3,value:'host-wipe'}]},'admin'),language.locale);
  const queued=await f.send('discord',event);assert.deepEqual(queued.ack,{type:5,data:{flags:64}});assert.ok(queued.reply.payload.content.includes(language.queued));
  const delivery=f.notifications.repo.all('deliveries')[0];assert.equal(delivery.language,'en');assert.equal(f.transport.getCalls().length,0);
  await f.worker.runOnce({workerId:'locale-worker',limit:10});
  const current=f.notifications.repo.get('deliveries',delivery.id);assert.equal(current.status,'sent');
  const before=snapshot(f),receipt=await f.send('discord',event);assert.ok(receipt.reply.payload.content.includes(language.delivered));assert.deepEqual(snapshot(f),before);
  assert.equal(f.notifications.repo.all('deliveries').length,1);assert.equal(f.notifications.repo.all('intents').length,1);assert.equal(f.transport.getCalls().filter(c=>c.operation==='send').length,1);
 });

 test(`signed ${language.locale} community ranking/query use localized labels and replay reads the same result`,async t=>{
  const f=await setup(t),config=f.platformService.config('discord');
  f.platformService.save(f.actor('admin'),'discord',{expectedRevision:config.revision,config:{targets:config.targets.map(target=>({...target,enabledCommandIds:[...target.enabledCommandIds,'kda']}))}},{operationId:'enable-query-fixture'});
  const rankingEvent=localized(f.discord('ranking-localized',2,{name:'ranking',options:[{name:'wipe',type:3,value:'host-wipe'},{name:'metric',type:3,value:'kills'}]}),language.locale);
  const ranking=await f.send('discord',rankingEvent);assert.deepEqual(ranking.ack,{type:5,data:{flags:64}});assert.ok(ranking.reply.payload.content.includes(language.kills),ranking.reply.payload.content);
  const afterRanking=snapshot(f),rankingReceipt=await f.send('discord',rankingEvent);assert.ok(rankingReceipt.reply.payload.content.includes(language.kills),rankingReceipt.reply.payload.content);assert.deepEqual(snapshot(f),afterRanking);
  const queryEvent=localized(f.discord('query-localized',2,{name:'kda',options:[{name:'steam_input',type:3,value:f.ir.get('members','m002').steamId},{name:'source',type:3,value:'official'}]},'admin'),language.locale);
  const query=await f.send('discord',queryEvent);assert.deepEqual(query.ack,{type:5,data:{flags:64}});assert.ok(query.reply.payload.content.includes(language.querySaved),query.reply.payload.content);
  const afterQuery=snapshot(f),queryReceipt=await f.send('discord',queryEvent);assert.ok(queryReceipt.reply.payload.content.includes(language.querySaved),queryReceipt.reply.payload.content);assert.deepEqual(snapshot(f),afterQuery);
  const map=await f.send('discord',localized(f.discord('map-localized',2,{name:'map',options:[{name:'wipe',type:3,value:'host-wipe'}]}),language.locale));assert.ok(map.reply.payload.content.includes(f.sr.get('wipes','host-wipe').title));assert.equal(f.transport.getCalls().length,0);
 });
}

for(const locale of [undefined,'fr','invalid_locale'])test(`VIP locale ${String(locale)} falls back to English despite Chinese guild locale`,async t=>{
 const f=await setup(t),reply=await f.send('discord',localized(f.discord('fallback',3,{component_type:2,custom_id:'nb_vital_vip:open'}),locale));
 assert.equal(reply.ack.data.content,'Update your VIP information');assert.equal(reply.ack.data.flags,64);assert.equal(f.transport.getCalls().length,0);
});

test('published adapters pass signed Discord locale to the same Stats and Scheduling services',async t=>{
 const f=await setup(t),published=createPublishedPlatformAdapters({identity:f.identity,scheduling:f.scheduling,stats:f.stats,executeStatsJob:id=>f.stats.runJob(id),write:f.runStoreWriteTask});
 for(const language of cases){
  const event=localized(f.discord('published-'+language.locale,2,{name:'kda',options:[{name:'steam_input',type:3,value:f.ir.get('members','m002').steamId}]},'admin'),language.locale),proof=f.verifiers.discord(f.raw('discord',event));
  const args={actor:f.actor('admin'),input:{wipeId:'host-wipe',steamInput:f.ir.get('members','m002').steamId,sourceId:'official'},operationId:'published:'+language.locale,source:'discord',proof,assertCurrent:()=>{}};
  const ranking=published.platform.stats.ranking({...args,input:{wipeId:'host-wipe',sourceId:'vital',metric:'kills'}});assert.ok(ranking.items[0].label.includes(language.kills));
  const query=await published.platform.queries.query(args);assert.equal(query.items[0].label,language.querySaved);
  const map=published.platform.scheduling.map(args);assert.equal(map.items[0].label,f.sr.get('wipes','host-wipe').title);
 }
 const chinese=published.platform.stats.ranking({actor:f.actor('admin'),input:{wipeId:'host-wipe',sourceId:'vital'},source:'kook',proof:{locale:'en-US'}});assert.ok(chinese.items[0].label.includes('击杀'));
 assert.equal(f.transport.getCalls().length,0);
});

test('changing locale after signing cannot produce a native community proof or business write',async t=>{
 const f=await setup(t),event=localized(f.discord('signed-locale',3,{component_type:2,custom_id:'nb_vital_vip:open'}),'en-US'),envelope=f.raw('discord',event),before=snapshot(f);
 envelope.rawBody=Buffer.from(JSON.stringify({...event,locale:'zh-CN'}));assert.throws(()=>f.verifiers.discord(envelope),error=>error.errorCode==='PLATFORM_AUTH_INVALID');assert.deepEqual(snapshot(f),before);
});
