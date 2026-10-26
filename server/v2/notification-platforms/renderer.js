import { brandName } from '../../branding.js';
import { IdentityError } from '../identity/errors.js';
import { canonicalJson, hashPayload } from './canonical.js';
import { discordTimestamp } from './discord-time.js';
import { isIP } from 'node:net';

const LANGUAGES = ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'];
const PURPOSES = ['signup_open', 'reminder', 'schedule_changed', 'signup_closed', 'cancelled', 'result'];
const ACTIONS = ['attending_on_time', 'attending_later', 'join_8h', 'join_16h', 'not_attending', 'copy_connect', 'register_member', 'withdraw'];
const COUNT_KEYS = ['eligibleTotal', 'unanswered', 'onTime', 'later', 'notAttending', 'responseTotal', 'plannedAttending', 'confirmedAttending', 'pendingReconfirmationAttending', 'pendingReconfirmation'];
const SCOPES = ['audience', 'archived_audience', 'authorized_members', 'authorized_archived_members', 'notification_audience'];
const STATES = ['draft', 'scheduled', 'active', 'ended', 'archived', 'cancelled'];
const WINDOWS = ['not_open', 'open', 'closed'];

const COPY = {
  'zh-CN': {
    purposes: ['报名开放', '开荒提醒', '安排变更', '报名截止', '档期取消', '报名汇总'],
    messages: ['请选择本次档期的到场安排。', '请核对开荒时间和你的报名安排。', '安排已变更，请查看最新时间；已有报名保持有效。', '本次报名已截止，请查看已保存的安排。', '本次档期已取消。', '以下为当前可见范围的报名统计。'],
    labels: ['服务器', '集合时间', '报名截止', '服务器计划清档', '档期状态', '报名状态', '统计范围'],
    counts: ['范围内成员', '未回复', '准时到场意向', '晚到意向', '不参加', '已回复', '计划参加', '已确认参加', '参加意向待重确认', '全部待重确认'],
    scopes: ['本档期全部受众', '归档时全部受众', '当前授权成员', '当前授权的归档成员', '本次通知选定受众'],
    states: ['草稿', '待开始', '进行中', '已结束', '已归档', '已取消'], windows: ['尚未开放', '开放中', '已关闭'],
    actions: ['准时到场', '晚点到场', '不参加', '查看并管理报名', '取消报名'], none: '待确定', version: '内容版本', roster: '名单版本', evaluated: '统计时间',
    truncated: '部分文字已截短，完整安排请在网站查看。', edit: '原卡更新已关闭所有提醒。',
  },
  en: {
    purposes: ['Signups open', 'Wipe reminder', 'Schedule changed', 'Signups closed', 'Wipe cancelled', 'Signup summary'],
    messages: ['Choose your attendance for this wipe.', 'Check the server wipe time and your signup.', 'The schedule changed. Check the latest time; existing signups remain valid.', 'Signups are closed. View your saved plan.', 'This wipe has been cancelled.', 'These signup totals cover the audience shown below.'],
    labels: ['Server', 'Muster time', 'Signup deadline', 'Scheduled server wipe', 'Wipe status', 'Signup window', 'Count scope'],
    counts: ['Members in scope', 'Unanswered', 'Plan to arrive on time', 'Plan to arrive later', 'Not attending', 'Responded', 'Plan to attend', 'Confirmed attending', 'Attending, awaiting reconfirmation', 'All awaiting reconfirmation'],
    scopes: ['Entire wipe audience', 'Entire archived audience', 'Currently authorized members', 'Currently authorized archived members', 'Selected notification audience'],
    states: ['Draft', 'Scheduled', 'Active', 'Ended', 'Archived', 'Cancelled'], windows: ['Not open yet', 'Open', 'Closed'],
    actions: ['On time', 'Arriving later', 'Not attending', 'View and manage signup', 'Withdraw signup'], none: 'To be confirmed', version: 'Content version', roster: 'Roster version', evaluated: 'Counted at',
    truncated: 'Some text was shortened. View the complete plan on the website.', edit: 'All mentions are disabled for this card update.',
  },
  ru: {
    purposes: ['Запись открыта', 'Напоминание о вайпе', 'План изменён', 'Запись закрыта', 'Вайп отменён', 'Сводка записей'],
    messages: ['Укажите, когда вы присоединитесь к этому вайпу.', 'Проверьте время вайпа сервера и свою запись.', 'План изменён. Проверьте новое время; существующие записи остаются в силе.', 'Запись закрыта. Посмотрите сохранённый план.', 'Этот вайп отменён.', 'Ниже приведена статистика записей для указанной аудитории.'],
    labels: ['Сервер', 'Время сбора', 'Запись до', 'Плановый вайп сервера', 'Статус вайпа', 'Приём записей', 'Охват статистики'],
    counts: ['Участников в охвате', 'Без ответа', 'Планируют вовремя', 'Планируют позже', 'Не участвуют', 'Ответили', 'Планируют участие', 'Участие подтверждено', 'Участие ждёт переподтверждения', 'Всего ждут переподтверждения'],
    scopes: ['Вся аудитория вайпа', 'Вся архивная аудитория', 'Доступные сейчас участники', 'Доступные архивные участники', 'Выбранная аудитория уведомления'],
    states: ['Черновик', 'Запланирован', 'Идёт', 'Завершён', 'В архиве', 'Отменён'], windows: ['Ещё не открыта', 'Открыта', 'Закрыта'],
    actions: ['Буду вовремя', 'Приду позже', 'Не участвую', 'Посмотреть и изменить запись', 'Отменить запись'], none: 'Уточняется', version: 'Версия плана', roster: 'Версия списка', evaluated: 'Подсчитано',
    truncated: 'Часть текста сокращена. Полный план доступен на сайте.', edit: 'При обновлении карточки все упоминания отключены.',
  },
  tr: {
    purposes: ['Kayıtlar açıldı', 'Wipe hatırlatması', 'Plan değişti', 'Kayıtlar kapandı', 'Wipe iptal edildi', 'Kayıt özeti'],
    messages: ['Bu wipe için katılım durumunuzu seçin.', 'Sunucu wipe saatini ve kaydınızı kontrol edin.', 'Plan değişti. Güncel saati kontrol edin; mevcut kayıtlar geçerliliğini korur.', 'Kayıtlar kapandı. Kaydettiğiniz planı görüntüleyin.', 'Bu wipe iptal edildi.', 'Aşağıdaki kayıt sayıları belirtilen kitleyi kapsar.'],
    labels: ['Sunucu', 'Toplanma saati', 'Son kayıt zamanı', 'Planlanan sunucu wipe zamanı', 'Wipe durumu', 'Kayıt durumu', 'Sayım kapsamı'],
    counts: ['Kapsamdaki üyeler', 'Yanıt vermeyen', 'Zamanında gelmeyi planlayan', 'Geç gelmeyi planlayan', 'Katılmayan', 'Yanıt veren', 'Katılmayı planlayan', 'Katılımı onaylanan', 'Katılım için yeniden onay bekleyen', 'Tüm yeniden onay bekleyenler'],
    scopes: ['Wipe kitlesinin tamamı', 'Arşivlenen kitlenin tamamı', 'Şu an yetki kapsamındaki üyeler', 'Yetki kapsamındaki arşiv üyeleri', 'Bildirim için seçilen kitle'],
    states: ['Taslak', 'Planlandı', 'Devam ediyor', 'Bitti', 'Arşivlendi', 'İptal edildi'], windows: ['Henüz açılmadı', 'Açık', 'Kapalı'],
    actions: ['Zamanında gelirim', 'Geç gelirim', 'Katılmıyorum', 'Kaydı görüntüle ve yönet', 'Kaydı iptal et'], none: 'Henüz belli değil', version: 'Plan sürümü', roster: 'Liste sürümü', evaluated: 'Sayım zamanı',
    truncated: 'Bazı metinler kısaltıldı. Planın tamamını sitede görüntüleyin.', edit: 'Bu kart güncellemesinde tüm etiketlemeler kapalıdır.',
  },
  th: {
    purposes: ['เปิดลงทะเบียน', 'แจ้งเตือนเวลาไวป์', 'กำหนดการเปลี่ยนแปลง', 'ปิดลงทะเบียน', 'ยกเลิกรอบไวป์', 'สรุปการลงทะเบียน'],
    messages: ['เลือกเวลาที่คุณจะเข้าร่วมรอบไวป์นี้', 'ตรวจสอบเวลาไวป์และการลงทะเบียนของคุณ', 'กำหนดการเปลี่ยนแล้ว โปรดตรวจสอบเวลาใหม่ การลงทะเบียนเดิมยังมีผล', 'ปิดลงทะเบียนแล้ว ดูแผนที่บันทึกไว้ได้', 'ยกเลิกรอบไวป์นี้แล้ว', 'สถิติด้านล่างนับเฉพาะกลุ่มผู้รับที่ระบุ'],
    labels: ['เซิร์ฟเวอร์', 'เวลารวมพล', 'ปิดรับลงทะเบียน', 'กำหนดไวป์เซิร์ฟเวอร์', 'สถานะรอบไวป์', 'สถานะลงทะเบียน', 'ขอบเขตการนับ'],
    counts: ['สมาชิกในขอบเขต', 'ยังไม่ตอบ', 'ตั้งใจมาตรงเวลา', 'ตั้งใจมาสาย', 'ไม่เข้าร่วม', 'ตอบแล้ว', 'ตั้งใจเข้าร่วม', 'ยืนยันเข้าร่วมแล้ว', 'ผู้เข้าร่วมที่รอยืนยันใหม่', 'ทั้งหมดที่รอยืนยันใหม่'],
    scopes: ['ผู้รับทั้งหมดของรอบไวป์', 'ผู้รับทั้งหมดที่เก็บถาวร', 'สมาชิกที่มีสิทธิ์ดูในขณะนี้', 'สมาชิกที่เก็บถาวรและมีสิทธิ์ดู', 'ผู้รับที่เลือกสำหรับการแจ้งเตือนนี้'],
    states: ['ฉบับร่าง', 'กำหนดแล้ว', 'กำลังดำเนินการ', 'สิ้นสุดแล้ว', 'เก็บถาวรแล้ว', 'ยกเลิกแล้ว'], windows: ['ยังไม่เปิด', 'เปิดอยู่', 'ปิดแล้ว'],
    actions: ['มาตรงเวลา', 'มาสาย', 'ไม่เข้าร่วม', 'ดูและจัดการลงทะเบียน', 'ยกเลิกการลงทะเบียน'], none: 'ยังไม่กำหนด', version: 'เวอร์ชันกำหนดการ', roster: 'เวอร์ชันรายชื่อ', evaluated: 'นับเมื่อ',
    truncated: 'ข้อความบางส่วนถูกย่อ ดูแผนฉบับเต็มได้ที่เว็บไซต์', edit: 'ปิดการกล่าวถึงทั้งหมดสำหรับการอัปเดตการ์ดนี้',
  },
  ko: {
    purposes: ['참가 신청 시작', '와이프 알림', '일정 변경', '참가 신청 마감', '와이프 취소', '참가 신청 현황'],
    messages: ['이번 와이프의 참가 일정을 선택하세요.', '서버 와이프 시간과 신청 내용을 확인하세요.', '일정이 변경되었습니다. 새 시간을 확인하세요. 기존 신청은 그대로 유효합니다.', '참가 신청이 마감되었습니다. 저장된 일정을 확인하세요.', '이번 와이프가 취소되었습니다.', '아래 통계는 표시된 대상 범위에 한정됩니다.'],
    labels: ['서버', '집합 시간', '신청 마감', '서버 초기화 예정', '와이프 상태', '신청 상태', '집계 범위'],
    counts: ['범위 내 멤버', '미응답', '정시 도착 예정', '늦게 도착 예정', '불참', '응답 완료', '참가 예정', '참가 확정', '재확인 대기 중인 참가 예정자', '전체 재확인 대기'],
    scopes: ['와이프 전체 대상', '보관된 전체 대상', '현재 조회 권한이 있는 멤버', '조회 권한이 있는 보관 멤버', '이번 알림의 선택된 대상'],
    states: ['초안', '예정', '진행 중', '종료', '보관됨', '취소'], windows: ['아직 시작 전', '신청 가능', '마감'],
    actions: ['정시 도착', '늦게 도착', '불참', '신청 확인 및 관리', '신청 취소'], none: '미정', version: '일정 버전', roster: '명단 버전', evaluated: '집계 시각',
    truncated: '일부 문장이 축약되었습니다. 전체 일정은 웹사이트에서 확인하세요.', edit: '카드 업데이트 시 모든 멘션이 비활성화됩니다.',
  },
};

const DIRECT_CONNECT_LABEL = {
  'zh-CN': '服务器直连', en: 'Direct connect', ru: 'Подключение к серверу',
  tr: 'Sunucuya bağlan', th: 'เชื่อมต่อเซิร์ฟเวอร์', ko: '서버 바로 연결',
};
const ALTERNATIVE_CONNECT_LABEL = {
  'zh-CN': '备用直连', en: 'Alternative direct connect', ru: 'Альтернативное подключение',
  tr: 'Alternatif bağlantı', th: 'การเชื่อมต่อสำรอง', ko: '대체 연결',
};
const LANGUAGE_VIEW_LABEL = {
  'zh-CN': '查看我的语言版本', en: 'View in your language', ru: 'Показать на моём языке',
  tr: 'Kendi dilimde görüntüle', th: 'ดูในภาษาของฉัน', ko: '내 언어로 보기',
};
const ATTENDANCE_COPY = {
  'zh-CN': { date: '日期', time: '时间', heading: '开荒报名', choose: '请选择到场状态：', join8h: '8 小时后到场', join16h: '16 小时后到场', later: '其他晚到', team: '人到场', copy: '复制服务器直连', register: '登记成员', vip: '购买 VIP', noQueue: '免排队', priority: '优先队列' },
  en: { date: 'Date', time: 'Time', heading: 'Wipe Attendance', choose: 'Choose your status:', onTime: 'Attending', notAttending: 'Not Attending', join8h: 'Join in 8h', join16h: 'Join in 16h', later: 'Arriving later', team: 'attending', copy: 'Copy Direct Connect', register: 'Register Member', vip: 'Buy VIP', noQueue: 'No queue', priority: 'Priority queue' },
  ru: { date: 'Дата', time: 'Время', heading: 'Участие в вайпе', choose: 'Выберите статус:', join8h: 'Через 8 ч', join16h: 'Через 16 ч', later: 'Позже', team: 'участников', copy: 'Копировать адрес', register: 'Регистрация', vip: 'Купить VIP', noQueue: 'Без очереди', priority: 'Приоритетная очередь' },
  tr: { date: 'Tarih', time: 'Saat', heading: 'Wipe Katılımı', choose: 'Durumunuzu seçin:', join8h: '8 saat sonra', join16h: '16 saat sonra', later: 'Daha sonra', team: 'katılımcı', copy: 'Bağlantıyı kopyala', register: 'Üye kaydı', vip: 'VIP satın al', noQueue: 'Sıra yok', priority: 'Öncelikli sıra' },
  th: { date: 'วันที่', time: 'เวลา', heading: 'การเข้าร่วมไวป์', choose: 'เลือกสถานะของคุณ:', join8h: 'เข้าร่วมใน 8 ชม.', join16h: 'เข้าร่วมใน 16 ชม.', later: 'เข้าร่วมภายหลัง', team: 'คนเข้าร่วม', copy: 'คัดลอกที่อยู่เซิร์ฟเวอร์', register: 'ลงทะเบียนสมาชิก', vip: 'ซื้อ VIP', noQueue: 'ไม่ต้องรอคิว', priority: 'คิวพิเศษ' },
  ko: { date: '날짜', time: '시간', heading: '와이프 참가', choose: '참가 상태를 선택하세요:', join8h: '8시간 후 참가', join16h: '16시간 후 참가', later: '늦게 참가', team: '명 참가', copy: '접속 주소 복사', register: '멤버 등록', vip: 'VIP 구매', noQueue: '대기열 면제', priority: '우선 대기열' },
};

const need = (condition, code = 'NOTIFICATION_INPUT_INVALID', field = null) => {
  if (!condition) throw new IdentityError(code, 422, { fieldErrors: field ? { [field]: code } : {}, retryable: false });
};
const isString = value => typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const isId = value => isString(value) && value.length > 0 && !/\s/u.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;

// The full-width @ and parentheses cannot be interpreted as either platform's mentions.
// Free text uses KOOK plain-text, while Discord also receives an explicit allowed_mentions.
function safeText(value) {
  return value.replaceAll('@', '＠').replace(/\((met|rol|chn)\)/gi, '（$1）').replaceAll('<', '‹').replaceAll('>', '›');
}

function safeDirectConnect(value) {
  if (typeof value !== 'string' || value.length > 240) return '';
  const command = value.trim();
  const target = command.replace(/^(?:client\.connect|connect)\s+/i, '').replace(/^steam:\/\/connect\//i, '').replace(/\/$/, '');
  const match = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):([0-9]{1,5})$/.exec(target);
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 65535 ? command : '';
}

function safeVipUrl(value) {
  if (typeof value !== 'string' || value.length > 500 || /[\s\u0000-\u001f\u007f\\]/u.test(value) || !/^https?:\/\/[^/?#]/iu.test(value)) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : '';
}

function cut(value, max, warnings, copy) {
  if (value.length <= max) return value;
  if (!warnings.some(w => w.code === 'TEXT_TRUNCATED')) warnings.push({ code: 'TEXT_TRUNCATED', message: copy.truncated });
  let end = max - 1;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1] || '')) end--;
  return `${value.slice(0, end)}…`;
}

function formattedTime(value, timeZone, copy) {
  if (value === null) return copy.none;
  need(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, undefined, 'snapshot.time');
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(new Date(value));
  } catch { need(false, undefined, 'snapshot.timeZone'); }
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (${timeZone}, ${get('timeZoneName').replace(/^GMT/u, 'UTC')})`;
}

function memberLink(snapshot) {
  let url;
  try { url = new URL(snapshot.memberUrl); } catch { need(false, undefined, 'snapshot.memberUrl'); }
  const suffix = `/app/wipes/${encodeURIComponent(snapshot.wipeId)}?tab=plan#signup`;
  need(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && snapshot.memberUrl === `${url.origin}${suffix}` && snapshot.memberUrl.length <= 512, undefined, 'snapshot.memberUrl');
  return snapshot.memberUrl;
}

function discordAttendance(snapshot, copy, language, warnings, mode) {
  const rows = snapshot.attendanceRows || [];
  const start = Date.parse(snapshot.actualStartedAt || snapshot.serverScheduledWipeAt || snapshot.musterAt || '');
  const groups = { onTime: [], join8h: [], join16h: [], later: [], notAttending: [] };
  for (const row of rows) {
    const name = row.discordId ? mode === 'edit'
      ? `[${safeText(row.name || `Discord ${row.discordId}`).replace(/([\\\[\]()])/g, '\\$1')}](https://discord.com/users/${row.discordId})`
      : `<@${row.discordId}>` : safeText(row.name || 'Member');
    const label = name;
    if (row.response === 'attending_on_time') groups.onTime.push(label);
    else if (row.response === 'not_attending') groups.notAttending.push(label);
    else if (row.response === 'attending_later') {
      const arrival = Date.parse(row.expectedArrivalAt || '');
      const key = Number.isFinite(start) && arrival === start + 8 * 3_600_000 ? 'join8h'
        : Number.isFinite(start) && arrival === start + 16 * 3_600_000 ? 'join16h' : 'later';
      groups[key].push(label);
    }
  }
  const attendanceCopy = ATTENDANCE_COPY[language];
  const labels = { onTime: attendanceCopy.onTime || copy.actions[0], join8h: attendanceCopy.join8h,
    join16h: attendanceCopy.join16h, later: attendanceCopy.later, notAttending: attendanceCopy.notAttending || copy.actions[2] };
  const value = items => {
    let body = '', shown = 0;
    for (const item of items) {
      if (body.length + item.length + 1 > 700) break;
      body += `${body ? '\n' : ''}${item}`; shown++;
    }
    if (shown < items.length) {
      warnings.push({ code: 'ATTENDANCE_LIST_TRUNCATED', message: copy.truncated });
      body += `\n+${items.length - shown}`;
    }
    return body || '—';
  };
  const columns = Array.from({ length: 3 }, () => []);
  groups.onTime.forEach((item, index) => columns[index % 3].push(item));
  const fields = columns.map((items, index) => ({ label: index === 0 ? `✅ ${labels.onTime} (${snapshot.counts.onTime})` : '\u200B', value: value(items), inline: true }));
  fields.push({ label: '\u200B', value: '\u200B', inline: false });
  for (const [key, emoji] of [['join8h','🕒'],['join16h','🕒'],['notAttending','❌']])
    fields.push({ label: `${emoji} ${labels[key]} (${groups[key].length})`, value: value(groups[key]), inline: true });
  if (groups.later.length) fields.push({ label: `🕒 ${labels.later} (${groups.later.length})`, value: value(groups.later), inline: false });
  return fields;
}

function validate(input) {
  need(input && typeof input === 'object');
  need(input.omitLanguageButton === undefined || typeof input.omitLanguageButton === 'boolean', undefined, 'omitLanguageButton');
  need(input.schemaVersion === 1);
  need(input.templateId === 'wipe-notification', 'TEMPLATE_UNSUPPORTED');
  need(input.templateRevision === 1, 'TEMPLATE_REVISION_UNSUPPORTED');
  need(PURPOSES.includes(input.purpose), undefined, 'purpose');
  need(input.mode === 'send' || input.mode === 'edit');
  const { target, selection, snapshot } = input;
  need(target && ['discord', 'kook'].includes(target.platform) && isId(target.id) && isId(target.guildId) && isId(target.channelId), 'TARGET_INVALID');
  need(selection && selection.targetId === target.id, 'TARGET_INVALID');
  need(LANGUAGES.includes(selection.language) && Array.isArray(target.languages) && target.languages.includes(selection.language), 'LANGUAGE_UNSUPPORTED');
  need(snapshot && isId(snapshot.wipeId) && revision(snapshot.contentRevision) && revision(snapshot.rosterRevision));
  for (const key of ['title', 'description', 'serverLabel', 'timeZone']) need(isString(snapshot[key]), undefined, `snapshot.${key}`);
  need(snapshot.timeZone.length > 0 && snapshot.timeZone.length <= 100, undefined, 'snapshot.timeZone');
  need(typeof snapshot.evaluatedAt === 'string', undefined, 'snapshot.evaluatedAt');
  need(STATES.includes(snapshot.lifecycle) && WINDOWS.includes(snapshot.effectiveSignupWindow));
  need(SCOPES.includes(snapshot.countScope), undefined, 'snapshot.countScope');
  need(snapshot.counts && typeof snapshot.counts === 'object', undefined, 'snapshot.counts');
  for (const key of COUNT_KEYS) need(Number.isSafeInteger(snapshot.counts[key]) && snapshot.counts[key] >= 0, undefined, `snapshot.counts.${key}`);
  if (snapshot.attendanceRows !== undefined) {
    need(Array.isArray(snapshot.attendanceRows) && snapshot.attendanceRows.length <= 10000, undefined, 'snapshot.attendanceRows');
    for (const row of snapshot.attendanceRows) need(row && ['attending_on_time','attending_later','not_attending'].includes(row.response) &&
      isString(row.name) && row.name.length <= 80 && (row.discordId === '' || /^\d{15,22}$/u.test(row.discordId)) &&
      (row.expectedArrivalAt === null || typeof row.expectedArrivalAt === 'string' && Number.isFinite(Date.parse(row.expectedArrivalAt))) &&
      ['', '🟣', '🟡'].includes(row.vipBadge), undefined, 'snapshot.attendanceRows');
  }
  if (snapshot.teamAttendance !== undefined) {
    need(Array.isArray(snapshot.teamAttendance) && snapshot.teamAttendance.length <= 24, undefined, 'snapshot.teamAttendance');
    for (const team of snapshot.teamAttendance) need(team && isString(team.name) && team.name.length > 0 && team.name.length <= 80 &&
      Number.isSafeInteger(team.onTime) && team.onTime > 0, undefined, 'snapshot.teamAttendance');
  }
  if (target.platform === 'kook') for (const group of ['CN','EU']) for (const key of ['onTime','later','notAttending'])
    need(Number.isSafeInteger(snapshot.teamCounts?.[group]?.[key]) && snapshot.teamCounts[group][key] >= 0, undefined, `snapshot.teamCounts.${group}.${key}`);
  need(Array.isArray(input.actionRefs));
  const actions = new Set(), tokens = new Set();
  for (const ref of input.actionRefs) {
    need(ref && ACTIONS.includes(ref.action) && typeof ref.token === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(ref.token), undefined, 'actionRefs');
    need(ref.action !== 'withdraw' || target.platform === 'kook', undefined, 'actionRefs');
    need(!['join_8h','join_16h','copy_connect','register_member'].includes(ref.action) || target.platform === 'discord', undefined, 'actionRefs');
    need(!actions.has(ref.action) && !tokens.has(ref.token), undefined, 'actionRefs');
    actions.add(ref.action); tokens.add(ref.token);
  }
}

function mentions(input) {
  const { selection, target, mode } = input;
  // Updating an existing card must also work when the original mention grant was revoked.
  if (mode === 'edit') return { mode: 'none', roleIds: [] };
  const mentionMode = selection.mentionMode ?? 'none', roleIds = selection.roleIds ?? [];
  need(['none', 'roles', 'everyone'].includes(mentionMode) && Array.isArray(roleIds), 'MENTION_INVALID');
  need(new Set(roleIds).size === roleIds.length, 'MENTION_INVALID');
  if (mentionMode !== 'roles') need(roleIds.length === 0, 'MENTION_INVALID');
  if (mentionMode === 'roles') {
    need(target.capabilities?.mentionRoles === true && roleIds.length > 0 && roleIds.length <= 100, 'MENTION_INVALID');
    need(Array.isArray(target.roleOptions) && roleIds.every(id => typeof id === 'string' && /^\d{1,20}$/u.test(id) && target.roleOptions.some(role => role?.id === id)), 'MENTION_INVALID');
  }
  if (mentionMode === 'everyone') need(target.capabilities?.mentionEveryone === true, 'MENTION_INVALID');
  return { mode: mentionMode, roleIds: [...roleIds] };
}

export function listNotificationTemplates() {
  return [{ id: 'wipe-notification', revision: 1, label: '档期通知 / Wipe notification', languages: [...LANGUAGES], purposes: [...PURPOSES] }];
}

export function renderNotification(input) {
  validate(input);
  const { snapshot, target, selection, purpose, mode } = input;
  need(snapshot.signupMode === undefined || ['member_required', 'discord_only'].includes(snapshot.signupMode), undefined, 'snapshot.signupMode');
  const copy = COPY[selection.language], attendanceCopy = ATTENDANCE_COPY[selection.language], warnings = [], mention = mentions(input);
  const directConnect = safeDirectConnect(snapshot.directConnect);
  const connectMatch = /^(?:client\.)?connect +([a-z0-9.-]+):([0-9]{1,5})$/i.exec(directConnect);
  const ipDirectConnect = connectMatch && isIP(snapshot.directConnectIp) === 4
    ? `client.connect ${snapshot.directConnectIp}:${connectMatch[2]}` : '';
  const discordSignup = target.platform === 'discord' && purpose === 'signup_open';
  const nicknameSignup = discordSignup && snapshot.signupMode === 'discord_only';
  const signupModeNote = {
    en: nicknameSignup ? 'No Steam link required. Signups use your Discord nickname.' : 'Link your Steam account before signing up.',
    'zh-CN': nicknameSignup ? '无需绑定 Steam，报名使用你的 Discord 昵称。' : '报名前请先绑定 Steam 账号。',
    ru: nicknameSignup ? 'Привязка Steam не нужна. Для записи используется ваш ник Discord.' : 'Перед записью привяжите аккаунт Steam.',
    tr: nicknameSignup ? 'Steam bağlantısı gerekmez. Kayıt için Discord adınız kullanılır.' : 'Kaydolmadan önce Steam hesabınızı bağlayın.',
    th: nicknameSignup ? 'ไม่ต้องเชื่อมโยง Steam การลงชื่อจะใช้ชื่อเล่น Discord ของคุณ' : 'เชื่อมโยงบัญชี Steam ก่อนลงชื่อ',
    ko: nicknameSignup ? 'Steam 연결 없이 Discord 닉네임으로 신청됩니다.' : '신청하기 전에 Steam 계정을 연결하세요.',
  }[selection.language];
  const displayTime = (value, style = 'F') => {
    // Preserve canonical snapshot/date/time-zone validation on both platforms.
    const formatted = formattedTime(value, snapshot.timeZone, copy);
    return target.platform === 'discord' && value !== null ? discordTimestamp(value, style) : formatted;
  };
  const open = ['scheduled', 'active'].includes(snapshot.lifecycle) && snapshot.effectiveSignupWindow === 'open' && !['signup_closed', 'cancelled', 'result'].includes(purpose);
  const displayPurpose = discordSignup && !open ? snapshot.lifecycle === 'cancelled' ? 'cancelled' : 'signup_closed' : purpose;
  const title = cut(safeText(discordSignup && open ? `🚨 ${snapshot.title} 🚨` : `${copy.purposes[PURPOSES.indexOf(displayPurpose)]} · ${snapshot.title}`), target.platform === 'kook' ? 100 : 256, warnings, copy);
  const intro = target.platform === 'kook' ? '' : cut(safeText(`${copy.messages[PURPOSES.indexOf(displayPurpose)]}${snapshot.description ? `\n\n${snapshot.description}` : ''}`), 1800, warnings, copy);
  const allFields = [
    { label: copy.labels[0], value: cut(safeText(snapshot.serverLabel || copy.none), 128, warnings, copy) },
    { label: copy.labels[2], value: displayTime(snapshot.signupClosesAt) },
    { label: copy.labels[3], value: displayTime(snapshot.serverScheduledWipeAt) },
    { label: copy.labels[4], value: copy.states[STATES.indexOf(snapshot.lifecycle)] },
    { label: copy.labels[5], value: copy.windows[WINDOWS.indexOf(snapshot.effectiveSignupWindow)] },
    { label: copy.labels[6], value: copy.scopes[SCOPES.indexOf(snapshot.countScope)] },
    ...COUNT_KEYS.slice(0, 8).map((key, index) => ({ label: copy.counts[index], value: String(snapshot.counts[key]) })),
    ...(target.platform === 'discord' && !discordSignup ? [{ label: copy.evaluated, value: displayTime(snapshot.evaluatedAt), inline: false }] : []),
  ];
  const shortLabels = selection.language === 'zh-CN' ? ['准时', '晚点', '不参加'] :
    [copy.actions[0], copy.actions[1], copy.actions[2]];
  const wipeTime = snapshot.actualStartedAt || snapshot.serverScheduledWipeAt || snapshot.musterAt;
  const timeTag = wipeTime ? Math.floor(Date.parse(wipeTime) / 1000) : null;
  const quickArrivalAvailable = hours => timeTag !== null && (timeTag * 1000 + hours * 3_600_000) > Date.parse(snapshot.evaluatedAt);
  const teamLines = (snapshot.teamAttendance || []).map(team => `📊 ${safeText(team.name)} ${team.onTime} ${attendanceCopy.team}`);
  const body = discordSignup ? [
    `🗓️ ${attendanceCopy.date}: ${displayTime(wipeTime ?? null, 'D')}  🕖 ${attendanceCopy.time}: ${displayTime(wipeTime ?? null, 't')}`,
    '', `**${attendanceCopy.heading}**\n${attendanceCopy.choose}`,
    ...(snapshot.signupMode ? [signupModeNote] : []),
    '', `✅ ${attendanceCopy.onTime || copy.actions[0]}`, `🕒 ${attendanceCopy.join8h}`,
    `🕒 ${attendanceCopy.join16h}`, `❌ ${attendanceCopy.notAttending || copy.actions[2]}`,
    ...(teamLines.length ? ['', ...teamLines] : []),
    ...(directConnect ? ['', `🔗 ${DIRECT_CONNECT_LABEL[selection.language]}: \`${directConnect}\``] : []),
    ...(ipDirectConnect ? [`🔗 ${ALTERNATIVE_CONNECT_LABEL[selection.language]}: \`${ipDirectConnect}\``] : []),
  ].join('\n') : intro;
  const fields = discordSignup ? discordAttendance(snapshot, copy, selection.language, warnings, mode) : target.platform === 'kook' ? [allFields[0], allFields[2], allFields[4],
    ...['onTime','later','notAttending'].map((key,i)=>({label:shortLabels[i],
      value:`${snapshot.counts[key]}  ·  CN ${snapshot.teamCounts.CN[key]}  /  EU ${snapshot.teamCounts.EU[key]}`}))] : allFields;
  if (open) need((discordSignup ? ['attending_on_time','join_8h','join_16h','not_attending'] : ['attending_on_time','attending_later','not_attending'])
    .every(action => input.actionRefs.some(ref => ref.action === action)), undefined, 'actionRefs');
  const website = memberLink(snapshot);
  const discordRegistrationUrl = `${new URL(website).origin}/api/v2/auth/discord/start?returnTo=%2Fapp%2Fme`;
  const vipUrl = safeVipUrl(snapshot.vipUrl);
  const actions = discordSignup ? [
    ...(open ? [
      { label: attendanceCopy.onTime || copy.actions[0], url: null, action: 'attending_on_time', disabled: false },
      { label: attendanceCopy.join8h, url: null, action: 'join_8h', disabled: !quickArrivalAvailable(8) },
      { label: attendanceCopy.join16h, url: null, action: 'join_16h', disabled: !quickArrivalAvailable(16) },
      { label: attendanceCopy.notAttending || copy.actions[2], url: null, action: 'not_attending', disabled: false },
    ] : []),
    ...(directConnect ? [{ label: attendanceCopy.copy, url: null, action: 'copy_connect', disabled: false }] : []),
    ...(open && snapshot.signupMode !== 'discord_only' ? [{ label: attendanceCopy.register, url: discordRegistrationUrl, action: null, disabled: false }]
      : !open && snapshot.signupMode !== 'discord_only' ? [{ label: copy.actions[3], url: website, action: null, disabled: false }] : []),
    ...(vipUrl ? [{ label: attendanceCopy.vip, url: vipUrl, action: null, disabled: false }] : []),
  ] : [
    ...(open ? ['attending_on_time','attending_later','not_attending'].map((action, i) => ({ label: copy.actions[i], url: null, action, disabled: false })) : []),
    { label: copy.actions[3], url: website, action: null, disabled: false },
  ];
  // Reuse an existing opaque attendance reference for an actor-private view.
  // The callback treats this prefix as read-only; it never submits attendance.
  const languageToken = input.actionRefs.find(ref => ref.action === 'attending_on_time')?.token;
  if (target.platform === 'discord' && !input.omitLanguageButton && /^[A-Za-z0-9_-]{43}$/u.test(languageToken || ''))
    actions.push({ label: LANGUAGE_VIEW_LABEL[selection.language], url: null, action: 'view_language', disabled: false });
  const footer = target.platform === 'kook' ? '' : discordSignup
    ? `${brandName()} · ${attendanceCopy.heading}\n${copy.version} ${snapshot.contentRevision} · ${copy.roster} ${snapshot.rosterRevision}`
    : `${copy.version} ${snapshot.contentRevision} · ${copy.roster} ${snapshot.rosterRevision}`;
  if (discordSignup) formattedTime(snapshot.evaluatedAt, snapshot.timeZone, copy);
  const rendered = { title, body, fields, actions, footer, countScope: snapshot.countScope, directConnect };
  const actionToken = action => input.actionRefs.find(ref => ref.action === action).token;
  let payload;
  if (target.platform === 'discord') {
    const content = mention.mode === 'everyone' ? '@everyone' : mention.roleIds.map(id => `<@&${id}>`).join(' ');
    payload = {
      content,
      embeds: [{ title, description: body, ...(discordSignup ? { color: 0xf1c40f, timestamp: snapshot.evaluatedAt } : {}),
        fields: fields.map(field => ({ name: field.label, value: field.value,
          inline: field.inline ?? true })), footer: { text: footer } }],
      allowed_mentions: { parse: mention.mode === 'everyone' ? ['everyone'] : [], roles: mention.roleIds, users: [], replied_user: false },
      components: (discordSignup ? [actions.filter(action => ['attending_on_time','join_8h','join_16h','not_attending'].includes(action.action)),
        actions.filter(action => !['attending_on_time','join_8h','join_16h','not_attending'].includes(action.action))] : [actions])
        .filter(group => group.length).map(group => ({ type: 1, components: group.map(action => {
          const emoji = action.action === 'view_language' ? '🌐' : discordSignup && (action.url === discordRegistrationUrl ? '📝' : ({ attending_on_time: '✅', join_8h: '🕒', join_16h: '🕒', not_attending: '❌', copy_connect: '🔗' })[action.action]);
          return action.url
            ? { type: 2, style: 5, label: action.label, ...(emoji ? { emoji: { name: emoji } } : {}), url: action.url, disabled: false }
            : { type: 2, style: ['attending_on_time','register_member'].includes(action.action) ? 3 : action.action === 'not_attending' ? 4 : action.action === 'copy_connect' ? 1 : 2,
              label: action.label, ...(emoji ? { emoji: { name: emoji } } : {}), custom_id: action.action === 'view_language' ? `nblang:signup:${languageToken}` : actionToken(action.action), disabled: action.disabled };
        }) })),
    };
    need(content.length <= 2000 && title.length + body.length + footer.length + fields.reduce((total, field) => total + field.label.length + field.value.length, 0) <= 6000);
  } else {
    const plain = content => ({ type: 'plain-text', content, emoji: false });
    const mentionText = mention.mode === 'everyone' ? '(met)all(met)' : mention.roleIds.map(id => `(rol)${id}(rol)`).join(' ');
    const cards = [{ type: 'card', theme: purpose === 'cancelled' ? 'danger' : 'info', size: 'lg', modules: [
      ...(mentionText ? [{ type: 'section', text: { type: 'kmarkdown', content: mentionText } }] : []),
      { type: 'header', text: plain(title) },
      ...fields.slice(0,2).map(field => ({ type: 'section', text: plain(`${field.label}  ${field.value}`) })),
      ...(directConnect ? [{ type: 'section', text: { type: 'kmarkdown',
        content: `**${DIRECT_CONNECT_LABEL[selection.language]}**\n\`\`\`\n${directConnect}\n\`\`\`` } }] : []),
      { type: 'divider' },
      { type: 'section', text: { type: 'kmarkdown', content: fields.slice(2).map(field=>`**${field.label}**  ${field.value}`).join('\n') } },
      ...[actions.slice(0, 3), actions.slice(3)].filter(group => group.length).map(group => ({
        type: 'action-group', elements: group.map(action => ({ type: 'button',
          theme: ['not_attending', 'withdraw'].includes(action.action) ? 'secondary' : 'info',
          value: action.url || actionToken(action.action), click: action.url ? 'link' : 'return-val', text: plain(action.label) })) })),
    ] }];
    payload = { type: 10, target_id: target.channelId, content: canonicalJson(cards) };
    need(payload.content.length <= 8000, undefined, 'payload.content');
  }
  if (mode === 'edit') warnings.push({ code: 'EDIT_MENTIONS_SUPPRESSED', message: copy.edit });
  return { rendered, payload, payloadHash: hashPayload(payload), warnings };
}
