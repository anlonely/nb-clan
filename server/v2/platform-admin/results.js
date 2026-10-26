import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

// Input is already projected/authorized by Stats or Scheduling. Preserve its
// values and terminal state without forwarding provider-specific objects.
export const metricLabels={kills:'击杀',deaths:'死亡',assists:'助攻',kd:'KD',kda:'KDA',t3Kills:'T3 击杀',rockets:'火箭',sulfur:'硫磺',metalOre:'金属矿',building:'建筑',onlineSeconds:'在线秒数',playTimeSeconds:'游戏秒数'};
const metricKeys=Object.keys(metricLabels);
const labels={
 'zh-CN':Object.values(metricLabels),
 en:['Kills','Deaths','Assists','KD','KDA','T3 kills','Rockets','Sulfur','Metal ore','Building','Online seconds','Playtime seconds'],
 ru:['Убийства','Смерти','Помощь','KD','KDA','Убийства T3','Ракеты','Сера','Металлическая руда','Строительство','Секунды онлайн','Секунды игры'],
 tr:['Öldürme','Ölüm','Asist','KD','KDA','T3 öldürme','Roket','Kükürt','Metal cevheri','İnşa','Çevrimiçi saniye','Oyun süresi (saniye)'],
 th:['สังหาร','ตาย','ช่วยสังหาร','KD','KDA','สังหาร T3','จรวด','กำมะถัน','แร่โลหะ','ก่อสร้าง','เวลาออนไลน์ (วินาที)','เวลาเล่น (วินาที)'],
 ko:['처치','사망','도움','KD','KDA','T3 처치','로켓','유황','금속 광석','건설','온라인 시간 (초)','플레이 시간 (초)'],
};
const resultCopy={
 'zh-CN':{unknown:'未知',member:'成员',succeeded:'查询结果已保存',failed:'查询失败',queued:'任务已排队，尚未完成',running:'任务正在执行',cancelled:'任务已取消',partial:'查询部分完成',skipped:'任务已跳过',unverified:'结果待核实'},
 en:{unknown:'Unknown',member:'Member',succeeded:'Query results saved',failed:'Query failed',queued:'Task queued; not complete yet',running:'Task running',cancelled:'Task cancelled',partial:'Query partially completed',skipped:'Task skipped',unverified:'Result pending verification'},
 ru:{unknown:'Неизвестно',member:'Участник',succeeded:'Результаты запроса сохранены',failed:'Запрос не выполнен',queued:'Задача в очереди; ещё не завершена',running:'Задача выполняется',cancelled:'Задача отменена',partial:'Запрос выполнен частично',skipped:'Задача пропущена',unverified:'Результат требует проверки'},
 tr:{unknown:'Bilinmiyor',member:'Üye',succeeded:'Sorgu sonuçları kaydedildi',failed:'Sorgu başarısız',queued:'Görev sırada; henüz tamamlanmadı',running:'Görev çalışıyor',cancelled:'Görev iptal edildi',partial:'Sorgu kısmen tamamlandı',skipped:'Görev atlandı',unverified:'Sonuç doğrulanmayı bekliyor'},
 th:{unknown:'ไม่ทราบ',member:'สมาชิก',succeeded:'บันทึกผลการค้นหาแล้ว',failed:'การค้นหาล้มเหลว',queued:'งานอยู่ในคิวและยังไม่เสร็จ',running:'กำลังดำเนินงาน',cancelled:'ยกเลิกงานแล้ว',partial:'การค้นหาเสร็จสิ้นบางส่วน',skipped:'ข้ามงานแล้ว',unverified:'ผลลัพธ์รอการตรวจสอบ'},
 ko:{unknown:'알 수 없음',member:'멤버',succeeded:'조회 결과가 저장되었습니다',failed:'조회 실패',queued:'작업 대기 중이며 아직 완료되지 않았습니다',running:'작업 실행 중',cancelled:'작업 취소됨',partial:'조회 일부 완료',skipped:'작업 건너뜀',unverified:'결과 확인 대기 중'},
};
export function rankingLabel(row,selected='kills',language='zh-CN'){
 const lang=discordInteractionLanguage(language),copy=resultCopy[lang],metricLabelsFor=Object.fromEntries(metricKeys.map((key,index)=>[key,labels[lang][index]]));
 const keys=[...new Set([Object.hasOwn(metricLabels,selected)?selected:'kills','kills','deaths'])];
 return [row.displayName||copy.member,...keys.map(key=>`${row.values?.[key]??copy.unknown} ${metricLabelsFor[key]}`)].join(' · ');
}
// A replay may change display language without re-running a query. Retain only
// values already shown in the label, never the full provider row or extra data.
const rankingPresentation=(row,selected='kills')=>{
 const metric=Object.hasOwn(metricLabels,selected)?selected:'kills',keys=[...new Set([metric,'kills','deaths'])];
 return {kind:'ranking',displayName:row.displayName?String(row.displayName):'',selected:metric,
  values:Object.fromEntries(keys.map(key=>[key,row.values?.[key]===undefined||row.values?.[key]===null?null:String(row.values[key])]))};
};
export function rankingResult(rows,selected,language='zh-CN'){return {schema:'platform-result/1',state:'succeeded',items:rows.items.map(row=>({id:row.memberId,label:rankingLabel(row,selected,language),status:row.status||'unavailable',presentation:rankingPresentation(row,selected)}))};}
export function mapLines(wipe,language='zh-CN'){const s=wipe.serverSnapshot||{};return [...new Set([s.name,s.mapLink||s.mapUrl,s.rustMapsLink||s.mapImageUrl,s.directConnect||s.connectUrl].filter(v=>typeof v==='string'&&v))];}
export function mapResult(wipe,language='zh-CN'){return {schema:'platform-result/1',state:'succeeded',reference:wipe.id,items:[{id:wipe.id,label:wipe.title,status:'local'},...mapLines(wipe,language).map((label,n)=>({id:`${wipe.id}:${n}`,label,status:'local'}))]};}
export function jobResult(job,language='zh-CN'){
 const copy=resultCopy[discordInteractionLanguage(language)];
 const j=job.job||job,state=['succeeded','failed','cancelled','queued','running','partial','skipped'].includes(j.status)?j.status:'unknown';
 const errorCode=state==='failed'&&/^[A-Z0-9_]{1,80}$/.test(j.result?.errorCode||'')?j.result.errorCode:state==='failed'?'SOURCE_UNAVAILABLE':null;
 return {schema:'platform-result/1',state,reference:j.id||job.jobId||null,errorCode,
  items:state==='succeeded'&&Array.isArray(j.result?.rows)&&j.result.rows.length?j.result.rows.slice(0,50).map((row,n)=>({id:row.id||String(n),label:rankingLabel(row,'kills',language),status:row.status||'unavailable',presentation:rankingPresentation(row)})):
   [{id:j.id||'',label:copy[state]||copy.unverified,status:state,presentation:{kind:'job-state',state}}]};
}

export function localizeResult(result,language='zh-CN'){
 if(!result||!Array.isArray(result.items))return result;
 const copy=resultCopy[discordInteractionLanguage(language)];
 return {...result,items:result.items.map(item=>{
  const p=item.presentation;
  if(p?.kind==='ranking'&&typeof p.displayName==='string'&&Object.hasOwn(metricLabels,p.selected)&&p.values&&typeof p.values==='object')return {...item,label:rankingLabel(p,p.selected,language)};
  if(p?.kind==='job-state'&&typeof p.state==='string')return {...item,label:copy[p.state]||copy.unverified};
  return item;
 })};
}
