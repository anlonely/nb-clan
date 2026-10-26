import {discordInteractionLanguage} from './interaction-language.js';

// Presentation only. Business input and component values keep their canonical
// identifiers; Discord locale comes exclusively from the verified interaction.
const copy={
 'zh-CN':{
  kdaDescription:'查询玩家战绩',rankingDescription:'读取指定档期排行',mapDescription:'读取指定档期地图',wipeDescription:'发布指定既有档期的报名卡',sourceDescription:'数据来源',serverDescription:'来源服务器',providerWipeDescription:'来源档期',steamDescription:'SteamID 或 Steam 资料页',wipeIdDescription:'既有档期 ID',metricDescription:'排行指标',mentionDescription:'提醒所有人（需要独立权限）',
  vipEdit:'更新本人 VIP 信息',vipTitle:'更新本人 {provider} VIP',vipMonth:'购买月份（本年）',vipDay:'购买日期',vipNone:'无 VIP',vipQueueSkip:'免排队',vipPriority:'优先队列',vipChoose:'请选择本人 VIP 信息',vipDate:'请输入购买日期',vipSaved:'本人 VIP 信息已保存',wipeDelivered:'报名卡已送达',wipeUnknown:'报名卡结果未知，不会重发',wipeQueued:'报名卡已排队，尚未送达',wipeFailed:'报名卡投递失败',syncQueued:'同步任务已交给同步中心'
 },
 en:{
  kdaDescription:'Look up player combat statistics',rankingDescription:'View the leaderboard for an existing wipe',mapDescription:'View the map for an existing wipe',wipeDescription:'Publish the sign-up card for an existing wipe',sourceDescription:'Data source',serverDescription:'Source server',providerWipeDescription:'Source wipe',steamDescription:'SteamID or Steam profile URL',wipeIdDescription:'Existing wipe ID',metricDescription:'Leaderboard metric',mentionDescription:'Mention everyone (requires separate permission)',
  vipEdit:'Update your VIP information',vipTitle:'Update your {provider} VIP',vipMonth:'Purchase month (this year)',vipDay:'Purchase day',vipNone:'No VIP',vipQueueSkip:'Queue skip',vipPriority:'Priority queue',vipChoose:'Choose your VIP information',vipDate:'Enter your purchase date',vipSaved:'Your VIP information has been saved',wipeDelivered:'Sign-up card delivered',wipeUnknown:'The sign-up card delivery result is unknown. It will not be resent',wipeQueued:'Sign-up card queued, awaiting delivery',wipeFailed:'Sign-up card delivery failed',syncQueued:'The sync task has been sent to the sync center'
 },
 ru:{
  kdaDescription:'Посмотреть боевую статистику игрока',rankingDescription:'Посмотреть рейтинг для существующего вайпа',mapDescription:'Посмотреть карту существующего вайпа',wipeDescription:'Опубликовать карточку записи на существующий вайп',sourceDescription:'Источник данных',serverDescription:'Исходный сервер',providerWipeDescription:'Вайп источника',steamDescription:'SteamID или ссылка на профиль Steam',wipeIdDescription:'ID существующего вайпа',metricDescription:'Показатель рейтинга',mentionDescription:'Упомянуть всех (требуется отдельное разрешение)',
  vipEdit:'Обновить свои данные VIP',vipTitle:'Ваш VIP в {provider}',vipMonth:'Месяц покупки (этот год)',vipDay:'День покупки',vipNone:'Без VIP',vipQueueSkip:'Без очереди',vipPriority:'Приоритетная очередь',vipChoose:'Выберите свои данные VIP',vipDate:'Введите дату покупки',vipSaved:'Ваши данные VIP сохранены',wipeDelivered:'Карточка записи доставлена',wipeUnknown:'Результат доставки карточки записи неизвестен. Повторной отправки не будет',wipeQueued:'Карточка записи в очереди на отправку',wipeFailed:'Не удалось доставить карточку записи',syncQueued:'Задача передана в центр синхронизации'
 },
 tr:{
  kdaDescription:'Oyuncunun savaş istatistiklerini sorgula',rankingDescription:'Mevcut bir wipe için sıralamayı görüntüle',mapDescription:'Mevcut bir wipe haritasını görüntüle',wipeDescription:'Mevcut bir wipe için kayıt kartını yayınla',sourceDescription:'Veri kaynağı',serverDescription:'Kaynak sunucu',providerWipeDescription:'Kaynak wipe',steamDescription:'SteamID veya Steam profil bağlantısı',wipeIdDescription:'Mevcut wipe kimliği',metricDescription:'Sıralama ölçütü',mentionDescription:'Herkesi etiketle (ayrı izin gerekir)',
  vipEdit:'VIP bilgilerinizi güncelleyin',vipTitle:'{provider} VIP bilgilerinizi güncelleyin',vipMonth:'Satın alma ayı (bu yıl)',vipDay:'Satın alma günü',vipNone:'VIP yok',vipQueueSkip:'Sırayı atla',vipPriority:'Öncelikli sıra',vipChoose:'VIP bilgilerinizi seçin',vipDate:'Satın alma tarihini girin',vipSaved:'VIP bilgileriniz kaydedildi',wipeDelivered:'Kayıt kartı gönderildi',wipeUnknown:'Kayıt kartının gönderim sonucu bilinmiyor. Tekrar gönderilmeyecek',wipeQueued:'Kayıt kartı gönderim için sıraya alındı',wipeFailed:'Kayıt kartı gönderilemedi',syncQueued:'Görev senkronizasyon merkezine gönderildi'
 },
 th:{
  kdaDescription:'ดูสถิติการต่อสู้ของผู้เล่น',rankingDescription:'ดูอันดับของไวป์ที่มีอยู่',mapDescription:'ดูแผนที่ของไวป์ที่มีอยู่',wipeDescription:'เผยแพร่การ์ดลงชื่อสำหรับไวป์ที่มีอยู่',sourceDescription:'แหล่งข้อมูล',serverDescription:'เซิร์ฟเวอร์ต้นทาง',providerWipeDescription:'ไวป์ต้นทาง',steamDescription:'SteamID หรือลิงก์โปรไฟล์ Steam',wipeIdDescription:'ID ของไวป์ที่มีอยู่',metricDescription:'เกณฑ์จัดอันดับ',mentionDescription:'กล่าวถึงทุกคน (ต้องมีสิทธิ์แยกต่างหาก)',
  vipEdit:'อัปเดตข้อมูล VIP ของคุณ',vipTitle:'อัปเดต VIP {provider} ของคุณ',vipMonth:'เดือนที่ซื้อ (ปีนี้)',vipDay:'วันที่ซื้อ',vipNone:'ไม่มี VIP',vipQueueSkip:'ข้ามคิว',vipPriority:'คิวพิเศษ',vipChoose:'เลือกข้อมูล VIP ของคุณ',vipDate:'กรอกวันที่ซื้อ',vipSaved:'บันทึกข้อมูล VIP ของคุณแล้ว',wipeDelivered:'ส่งการ์ดลงชื่อแล้ว',wipeUnknown:'ไม่ทราบผลการส่งการ์ดลงชื่อ ระบบจะไม่ส่งซ้ำ',wipeQueued:'การ์ดลงชื่ออยู่ในคิวรอส่ง',wipeFailed:'ส่งการ์ดลงชื่อไม่สำเร็จ',syncQueued:'ส่งงานไปยังศูนย์ซิงค์แล้ว'
 },
 ko:{
  kdaDescription:'플레이어 전투 통계 조회',rankingDescription:'기존 와이프의 순위 보기',mapDescription:'기존 와이프의 지도 보기',wipeDescription:'기존 와이프의 참가 신청 카드 게시',sourceDescription:'데이터 출처',serverDescription:'출처 서버',providerWipeDescription:'출처 와이프',steamDescription:'SteamID 또는 Steam 프로필 URL',wipeIdDescription:'기존 와이프 ID',metricDescription:'순위 기준',mentionDescription:'모두 멘션하기 (별도 권한 필요)',
  vipEdit:'내 VIP 정보 수정',vipTitle:'내 {provider} VIP 수정',vipMonth:'구매 월 (올해)',vipDay:'구매 일',vipNone:'VIP 없음',vipQueueSkip:'대기열 건너뛰기',vipPriority:'우선 대기열',vipChoose:'내 VIP 정보를 선택하세요',vipDate:'구매 날짜를 입력하세요',vipSaved:'내 VIP 정보가 저장되었습니다',wipeDelivered:'참가 신청 카드가 전송되었습니다',wipeUnknown:'참가 신청 카드의 전송 결과를 알 수 없습니다. 다시 전송하지 않습니다',wipeQueued:'참가 신청 카드가 전송 대기 중입니다',wipeFailed:'참가 신청 카드를 전송하지 못했습니다',syncQueued:'동기화 센터에 작업이 전달되었습니다'
 }
};

export const communityLanguage=args=>args.source==='discord'?discordInteractionLanguage(args.proof?.locale):'zh-CN';
export function nativeText(language,key,values={}){
 const text=copy[discordInteractionLanguage(language)][key];
 return text.replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??''));
}
export function nativeDescription(key){
 return {description:nativeText('en',key),description_localizations:Object.fromEntries(['zh-CN','zh-TW','en-US','en-GB','ru','tr','th','ko'].map(locale=>[locale,nativeText(locale,key)]))};
}
