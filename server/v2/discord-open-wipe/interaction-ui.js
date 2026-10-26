import { isIP } from 'node:net';
import { requireValue } from '../identity/errors.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';
import { openWipeCustomId } from './interaction-input.js';

const copy = {
  en: {
    createTitle: 'New wipe sign-up', settingsTitle: 'Wipe settings', server: 'Server', serverPlaceholder: 'Choose a server',
    preferences: 'Options', adaptiveDisplay: 'Use client language and local time', adaptiveHint: 'Public text is English. Private views use your language; times use your local zone.',
    autoConnect: 'Get the direct-connect address automatically', autoConnectHint: 'Use the server address when available. Enter a fallback below.',
    connect: 'Direct connect', connectHint: 'If unavailable automatically, enter client.connect host:port.', notes: 'Notes', notesHint: 'Optional details shown on the sign-up card.',
    dateTime: 'Wipe date and time', dateTimeHint: 'YYYY-MM-DD HH:mm, in the time zone below.', timeZone: 'Time zone', timeZoneHint: 'Time zone used for the wipe time above, e.g. Europe/Amsterdam.',
    preview: 'Preview — the card has not been published yet.', previewNeedsTime: 'Set a valid future wipe date and time before publishing.',
    publish: 'Publish', settings: 'Settings', serverChange: 'Change server', language: 'View in your language',
    signupOnTime: 'Accepted', signupLate: 'Late', signup8h: 'Join +8h', signup16h: 'Join +16h', signupAbsent: 'Declined', copy: 'Copy direct connect',
    wipeTime: 'Wipe time', roster: 'Sign-ups', none: 'None yet', published: 'Sign-up card published.', updated: 'Settings saved. The original card has been updated.',
    responseSaved: "You're currently marked as {emoji} {status} on **{server}**.", failed: 'Could not complete this action. {code}', unavailable: 'This card is unavailable. Open the original message again.',
    denied: 'You do not have permission to manage this sign-up.', expired: 'This form has expired. Open settings again.',
    noConnect: 'No direct-connect address is available.', connectReply: 'Direct connect: `{command}`\nCopy and run it in the Rust console.',
    alternativeConnect: 'Alternative direct connect', alreadyPublished: 'This card has already been published.',
  },
  'zh-CN': {
    createTitle: '创建开放报名', settingsTitle: '报名设置', server: '服务器', serverPlaceholder: '选择服务器',
    preferences: '选项', adaptiveDisplay: '自适应客户端语言和当地时间', adaptiveHint: '公共卡片默认英文，私有内容按客户端语言显示，时间按当地时区显示。',
    autoConnect: '自动获取直连地址', autoConnectHint: '优先使用服务器地址，无法获取时使用下方手动填写的地址。',
    connect: '服务器直连', connectHint: '无法自动获取时，填写 client.connect 域名或IP:端口。', notes: '备注', notesHint: '选填，填写后展示在报名卡片上。',
    dateTime: 'Wipe 日期和时间', dateTimeHint: '格式 YYYY-MM-DD HH:mm，按下方时区填写。', timeZone: '时区', timeZoneHint: '上方 Wipe 时间使用的时区，例如 Europe/Amsterdam。',
    preview: '报名预览，卡片尚未发布。', previewNeedsTime: '请先设置有效的未来 Wipe 日期和时间，再发布。',
    publish: '发布报名', settings: '设置', serverChange: '更换服务器', language: '按客户端语言查看',
    signupOnTime: '参加', signupLate: '迟到', signup8h: '晚 8 小时加入', signup16h: '晚 16 小时加入', signupAbsent: '不参加', copy: '复制直连',
    wipeTime: 'Wipe 时间', roster: '报名成员', none: '暂无', published: '报名卡片已发布。', updated: '设置已保存，原报名卡片已更新。',
    responseSaved: '你在 **{server}** 的报名状态为 {emoji} {status}。', failed: '无法完成本次操作。{code}', unavailable: '该卡片当前不可用，请从原消息重新打开。',
    denied: '你没有管理这张报名卡片的权限。', expired: '表单已过期，请重新打开设置。',
    noConnect: '当前没有可用的服务器直连地址。', connectReply: '服务器直连：`{command}`\n复制后在 Rust 控制台执行。',
    alternativeConnect: '备用直连', alreadyPublished: '这张报名卡片已经发布。',
  },
  ru: {
    createTitle: 'Открыть запись на вайп', settingsTitle: 'Настройки вайпа', server: 'Сервер', serverPlaceholder: 'Выберите сервер',
    preferences: 'Параметры', adaptiveDisplay: 'Язык клиента и местное время', adaptiveHint: 'Общая карточка на английском. Личный вид — на вашем языке, время — местное.',
    autoConnect: 'Получать адрес подключения автоматически', autoConnectHint: 'Использовать адрес сервера. Если его нет, введите адрес ниже.',
    connect: 'Прямое подключение', connectHint: 'Если адрес не найден, введите client.connect хост:порт.', notes: 'Примечание', notesHint: 'Необязательный текст на карточке записи.',
    dateTime: 'Дата и время вайпа', dateTimeHint: 'YYYY-MM-DD HH:mm в часовом поясе ниже.', timeZone: 'Часовой пояс', timeZoneHint: 'Часовой пояс для времени вайпа выше, например Europe/Amsterdam.',
    preview: 'Предпросмотр — карточка ещё не опубликована.', previewNeedsTime: 'Перед публикацией укажите корректные дату и время будущего вайпа.',
    publish: 'Опубликовать', settings: 'Настройки', serverChange: 'Сменить сервер', language: 'На языке вашего клиента',
    signupOnTime: 'Приду', signupLate: 'Опоздаю', signup8h: 'Приду через 8 ч', signup16h: 'Приду через 16 ч', signupAbsent: 'Не приду', copy: 'Адрес подключения',
    wipeTime: 'Время вайпа', roster: 'Участники', none: 'Пока нет', published: 'Карточка записи опубликована.', updated: 'Настройки сохранены. Исходная карточка обновлена.',
    responseSaved: 'Ваш статус на **{server}**: {emoji} {status}.', failed: 'Не удалось выполнить действие. {code}', unavailable: 'Карточка недоступна. Откройте исходное сообщение снова.',
    denied: 'У вас нет прав управлять этой записью.', expired: 'Срок действия формы истёк. Откройте настройки снова.',
    noConnect: 'Адрес подключения недоступен.', connectReply: 'Прямое подключение: `{command}`\nСкопируйте и выполните в консоли Rust.',
    alternativeConnect: 'Альтернативное подключение', alreadyPublished: 'Эта карточка уже опубликована.',
  },
  tr: {
    createTitle: 'Yeni wipe kaydı', settingsTitle: 'Wipe ayarları', server: 'Sunucu', serverPlaceholder: 'Bir sunucu seçin',
    preferences: 'Seçenekler', adaptiveDisplay: 'İstemci dili ve yerel saat', adaptiveHint: 'Ortak kart İngilizcedir. Özel görünüm dilinizi, zamanlar yerel saatinizi kullanır.',
    autoConnect: 'Bağlantı adresini otomatik al', autoConnectHint: 'Varsa sunucu adresini kullan. Bulunamazsa aşağıya adres girin.',
    connect: 'Doğrudan bağlantı', connectHint: 'Adres bulunamazsa client.connect sunucu:port girin.', notes: 'Notlar', notesHint: 'Kayıt kartında gösterilecek isteğe bağlı açıklama.',
    dateTime: 'Wipe tarihi ve saati', dateTimeHint: 'Aşağıdaki saat diliminde YYYY-MM-DD HH:mm.', timeZone: 'Saat dilimi', timeZoneHint: 'Yukarıdaki wipe saatinin saat dilimi, ör. Europe/Amsterdam.',
    preview: 'Önizleme — kart henüz yayımlanmadı.', previewNeedsTime: 'Yayımlamadan önce gelecekte geçerli bir wipe tarihi ve saati ayarlayın.',
    publish: 'Yayımla', settings: 'Ayarlar', serverChange: 'Sunucuyu değiştir', language: 'Kendi dilinizde görüntüleyin',
    signupOnTime: 'Katılacağım', signupLate: 'Geç kalacağım', signup8h: '8 saat sonra', signup16h: '16 saat sonra', signupAbsent: 'Katılmayacağım', copy: 'Bağlantıyı kopyala',
    wipeTime: 'Wipe zamanı', roster: 'Katılımcılar', none: 'Henüz yok', published: 'Kayıt kartı yayımlandı.', updated: 'Ayarlar kaydedildi. Mevcut kart güncellendi.',
    responseSaved: '**{server}** sunucusundaki durumunuz: {emoji} {status}.', failed: 'İşlem tamamlanamadı. {code}', unavailable: 'Bu kart kullanılamıyor. İlk mesajı yeniden açın.',
    denied: 'Bu kaydı yönetme izniniz yok.', expired: 'Formun süresi doldu. Ayarları yeniden açın.',
    noConnect: 'Bağlantı adresi yok.', connectReply: 'Doğrudan bağlantı: `{command}`\nKopyalayıp Rust konsolunda çalıştırın.',
    alternativeConnect: 'Alternatif bağlantı', alreadyPublished: 'Bu kart zaten yayımlandı.',
  },
  th: {
    createTitle: 'เปิดลงชื่อไวป์ใหม่', settingsTitle: 'ตั้งค่าการลงชื่อ', server: 'เซิร์ฟเวอร์', serverPlaceholder: 'เลือกเซิร์ฟเวอร์',
    preferences: 'ตัวเลือก', adaptiveDisplay: 'ใช้ภาษาของไคลเอนต์และเวลาท้องถิ่น', adaptiveHint: 'การ์ดสาธารณะเป็นอังกฤษ มุมมองส่วนตัวใช้ภาษาของคุณ และเวลาใช้เขตเวลาท้องถิ่น',
    autoConnect: 'รับที่อยู่เชื่อมต่ออัตโนมัติ', autoConnectHint: 'ใช้ที่อยู่เซิร์ฟเวอร์ถ้ามี หากไม่พบ ให้กรอกที่อยู่ด้านล่าง',
    connect: 'เชื่อมต่อโดยตรง', connectHint: 'หากไม่พบที่อยู่อัตโนมัติ ให้กรอก client.connect โฮสต์:พอร์ต', notes: 'หมายเหตุ', notesHint: 'ไม่บังคับ จะแสดงบนการ์ดลงชื่อ',
    dateTime: 'วันที่และเวลาไวป์', dateTimeHint: 'YYYY-MM-DD HH:mm ตามเขตเวลาด้านล่าง', timeZone: 'เขตเวลา', timeZoneHint: 'เขตเวลาที่ใช้กับเวลาไวป์ด้านบน เช่น Europe/Amsterdam',
    preview: 'ตัวอย่าง — ยังไม่ได้เผยแพร่การ์ด', previewNeedsTime: 'ตั้งวันที่และเวลาไวป์ในอนาคตให้ถูกต้องก่อนเผยแพร่',
    publish: 'เผยแพร่', settings: 'ตั้งค่า', serverChange: 'เปลี่ยนเซิร์ฟเวอร์', language: 'ดูในภาษาของคุณ',
    signupOnTime: 'เข้าร่วม', signupLate: 'มาสาย', signup8h: 'เข้าร่วมหลัง 8 ชม.', signup16h: 'เข้าร่วมหลัง 16 ชม.', signupAbsent: 'ไม่เข้าร่วม', copy: 'คัดลอกคำสั่งเชื่อมต่อ',
    wipeTime: 'เวลาไวป์', roster: 'ผู้ลงชื่อ', none: 'ยังไม่มี', published: 'เผยแพร่การ์ดลงชื่อแล้ว', updated: 'บันทึกการตั้งค่าและอัปเดตการ์ดเดิมแล้ว',
    responseSaved: 'สถานะของคุณบน **{server}** คือ {emoji} {status}', failed: 'ดำเนินการไม่สำเร็จ {code}', unavailable: 'การ์ดนี้ไม่พร้อมใช้งาน โปรดเปิดจากข้อความเดิมอีกครั้ง',
    denied: 'คุณไม่มีสิทธิ์จัดการการลงชื่อนี้', expired: 'แบบฟอร์มหมดอายุ โปรดเปิดการตั้งค่าอีกครั้ง',
    noConnect: 'ไม่มีที่อยู่สำหรับเชื่อมต่อโดยตรง', connectReply: 'เชื่อมต่อโดยตรง: `{command}`\nคัดลอกแล้วรันในคอนโซล Rust',
    alternativeConnect: 'การเชื่อมต่อสำรอง', alreadyPublished: 'เผยแพร่การ์ดนี้แล้ว',
  },
  ko: {
    createTitle: '새 와이프 참가 신청', settingsTitle: '참가 신청 설정', server: '서버', serverPlaceholder: '서버 선택',
    preferences: '옵션', adaptiveDisplay: '클라이언트 언어와 현지 시간 사용', adaptiveHint: '공개 카드는 영어입니다. 개인 화면은 클라이언트 언어로, 시간은 현지 시간으로 표시됩니다.',
    autoConnect: '연결 주소 자동 가져오기', autoConnectHint: '서버 주소가 있으면 사용합니다. 없으면 아래에 직접 입력하세요.',
    connect: '직접 연결', connectHint: '주소를 찾지 못하면 client.connect 호스트:포트를 입력하세요.', notes: '메모', notesHint: '선택 사항이며 참가 신청 카드에 표시됩니다.',
    dateTime: '와이프 날짜와 시간', dateTimeHint: '아래 시간대를 기준으로 YYYY-MM-DD HH:mm을 입력하세요.', timeZone: '시간대', timeZoneHint: '위 와이프 시간에 적용할 시간대입니다. 예: Europe/Amsterdam',
    preview: '미리보기 — 아직 카드가 게시되지 않았습니다.', previewNeedsTime: '게시하기 전에 올바른 미래 와이프 날짜와 시간을 설정하세요.',
    publish: '게시', settings: '설정', serverChange: '서버 변경', language: '내 언어로 보기',
    signupOnTime: '참가', signupLate: '지각', signup8h: '8시간 후 참가', signup16h: '16시간 후 참가', signupAbsent: '불참', copy: '연결 명령어 복사',
    wipeTime: '와이프 시간', roster: '신청자', none: '아직 없음', published: '참가 신청 카드가 게시되었습니다.', updated: '설정이 저장되고 기존 카드가 업데이트되었습니다.',
    responseSaved: '**{server}** 서버의 현재 신청 상태는 {emoji} {status}입니다.', failed: '작업을 완료하지 못했습니다. {code}', unavailable: '카드를 사용할 수 없습니다. 원래 메시지에서 다시 여세요.',
    denied: '이 참가 신청을 관리할 권한이 없습니다.', expired: '양식이 만료되었습니다. 설정을 다시 여세요.',
    noConnect: '연결 주소가 없습니다.', connectReply: '직접 연결: `{command}`\n복사한 후 Rust 콘솔에서 실행하세요.',
    alternativeConnect: '대체 연결', alreadyPublished: '이미 게시된 카드입니다.',
  },
};

const pickerCopy = {
  en: ['Choose a server to see its next wipe date, time and direct-connect address.', 'Settings preview — save to update the original card.', 'Save changes', 'Edit details'],
  'zh-CN': ['选择服务器后，下方会显示下一次 Wipe 日期、时间和直连信息。', '设置预览，保存后更新原报名卡片。', '保存修改', '编辑时间和备注'],
  ru: ['Выберите сервер, чтобы увидеть дату и время следующего вайпа и адрес подключения.', 'Предпросмотр настроек — сохраните, чтобы обновить исходную карточку.', 'Сохранить изменения', 'Изменить данные'],
  tr: ['Bir sunucu seçin; sonraki wipe tarihi, saati ve bağlantı adresi aşağıda gösterilir.', 'Ayar önizlemesi — mevcut kartı güncellemek için kaydedin.', 'Değişiklikleri kaydet', 'Ayrıntıları düzenle'],
  th: ['เลือกเซิร์ฟเวอร์เพื่อดูวันที่ เวลาไวป์ครั้งถัดไป และที่อยู่เชื่อมต่อด้านล่าง', 'ตัวอย่างการตั้งค่า — บันทึกเพื่ออัปเดตการ์ดเดิม', 'บันทึกการเปลี่ยนแปลง', 'แก้ไขรายละเอียด'],
  ko: ['서버를 선택하면 다음 와이프 날짜와 시간, 연결 주소가 아래에 표시됩니다.', '설정 미리보기 — 저장하면 기존 카드가 업데이트됩니다.', '변경 사항 저장', '세부 정보 수정'],
};
for (const [locale, translations] of Object.entries(pickerCopy))
  Object.assign(copy[locale], Object.fromEntries(['pickerPrompt', 'editingPreview', 'save', 'editDetails'].map((key, index) => [key, translations[index]])));

const errorKeys = ['queued', 'updateQueued', 'timeInvalid', 'timeZoneInvalid', 'timeMissing', 'timeFuture', 'timeAmbiguous', 'timeNonexistent', 'timeMismatch', 'connectInvalid', 'notesInvalid', 'serverUnavailable', 'unknownFailure', 'settingsInvalid'];
const errorCopy = {
  en: ['Publishing is queued. The card will appear when Discord confirms delivery.', 'Your changes are queued. The original card will update when Discord confirms the edit.',
    'Enter a valid wipe date and time as YYYY-MM-DD HH:mm.', 'Enter a valid time zone, such as Europe/Amsterdam or Asia/Shanghai.',
    'The next wipe time is unavailable for this server. Open settings and enter it manually.', 'Choose a wipe date and time in the future.',
    'This local time occurs twice when daylight saving time ends. Choose an unambiguous time.', 'This local time does not exist because the clocks move forward. Choose another time.',
    'The date, time and time zone do not match. Check them in settings.', 'Enter a valid direct-connect address, such as client.connect eu-medium.vitalrust.com:28014.',
    'The note is too long or contains unsupported characters. Shorten it and try again.', 'This server is no longer available. Choose a server again.',
    'This action could not be completed. Open the original card or run /newwipe again.', 'Check the settings and try again.'],
  'zh-CN': ['已加入发布队列，Discord 确认发送后会显示卡片。', '修改已加入更新队列，Discord 确认后会更新原卡片。',
    '请填写有效的 Wipe 日期和时间，格式为 YYYY-MM-DD HH:mm。', '请填写有效时区，例如 Europe/Amsterdam 或 Asia/Shanghai。',
    '暂时无法获取该服务器的下一次 Wipe 时间，请打开设置手动填写。', '请选择未来的 Wipe 日期和时间。',
    '夏令时结束时，这个当地时间会出现两次，请选择不重复的时间。', '夏令时切换会跳过这个当地时间，请选择其他时间。',
    '日期、时间与时区不一致，请在设置中检查。', '请填写有效直连，例如 client.connect eu-medium.vitalrust.com:28014。',
    '备注过长或含有不支持的字符，请缩短后重试。', '该服务器当前不可用，请重新选择服务器。',
    '操作未完成，请从原卡片重新打开，或再次执行 /newwipe。', '请检查设置后重试。'],
  ru: ['Публикация поставлена в очередь. Карточка появится после подтверждения Discord.', 'Изменения поставлены в очередь. Исходная карточка обновится после подтверждения Discord.',
    'Введите корректные дату и время вайпа в формате YYYY-MM-DD HH:mm.', 'Введите часовой пояс, например Europe/Amsterdam или Asia/Shanghai.',
    'Время следующего вайпа недоступно. Откройте настройки и введите его вручную.', 'Выберите дату и время вайпа в будущем.',
    'При переходе на зимнее время этот момент повторяется дважды. Выберите однозначное время.', 'При переходе на летнее время этот момент пропускается. Выберите другое время.',
    'Дата, время и часовой пояс не совпадают. Проверьте настройки.', 'Введите адрес подключения, например client.connect eu-medium.vitalrust.com:28014.',
    'Примечание слишком длинное или содержит недопустимые символы. Сократите его.', 'Сервер больше недоступен. Выберите сервер снова.',
    'Действие не завершено. Откройте исходную карточку или выполните /newwipe снова.', 'Проверьте настройки и повторите попытку.'],
  tr: ['Yayımlama kuyruğa alındı. Discord teslimatı onaylayınca kart görünecek.', 'Değişiklikler kuyruğa alındı. Discord onaylayınca mevcut kart güncellenecek.',
    'Geçerli bir wipe tarihi ve saati girin: YYYY-MM-DD HH:mm.', 'Europe/Amsterdam veya Asia/Shanghai gibi geçerli bir saat dilimi girin.',
    'Sonraki wipe saati bulunamadı. Ayarları açıp elle girin.', 'Gelecekte bir wipe tarihi ve saati seçin.',
    'Yaz saati bitişinde bu yerel saat iki kez oluşur. Tek bir ana karşılık gelen saat seçin.', 'Saatler ileri alındığından bu yerel saat mevcut değil. Başka bir saat seçin.',
    'Tarih, saat ve saat dilimi uyuşmuyor. Ayarlardan kontrol edin.', 'Geçerli bir adres girin, ör. client.connect eu-medium.vitalrust.com:28014.',
    'Not çok uzun veya desteklenmeyen karakterler içeriyor. Kısaltıp tekrar deneyin.', 'Bu sunucu artık kullanılamıyor. Yeniden bir sunucu seçin.',
    'İşlem tamamlanamadı. İlk kartı açın veya /newwipe komutunu yeniden çalıştırın.', 'Ayarları kontrol edip tekrar deneyin.'],
  th: ['เพิ่มการเผยแพร่ลงในคิวแล้ว การ์ดจะแสดงเมื่อ Discord ยืนยันการส่ง', 'เพิ่มการแก้ไขลงในคิวแล้ว การ์ดเดิมจะอัปเดตเมื่อ Discord ยืนยัน',
    'กรอกวันที่และเวลาไวป์ที่ถูกต้องในรูปแบบ YYYY-MM-DD HH:mm', 'กรอกเขตเวลาที่ถูกต้อง เช่น Europe/Amsterdam หรือ Asia/Shanghai',
    'ไม่พบเวลาไวป์ครั้งถัดไป โปรดเปิดการตั้งค่าและกรอกเอง', 'เลือกวันที่และเวลาไวป์ในอนาคต',
    'เวลาท้องถิ่นนี้เกิดขึ้นสองครั้งเมื่อสิ้นสุดเวลาออมแสง โปรดเลือกเวลาที่ไม่ซ้ำ', 'เวลาท้องถิ่นนี้ไม่มีอยู่เนื่องจากการเลื่อนนาฬิกาไปข้างหน้า โปรดเลือกเวลาอื่น',
    'วันที่ เวลา และเขตเวลาไม่สอดคล้องกัน โปรดตรวจสอบในการตั้งค่า', 'กรอกที่อยู่ที่ถูกต้อง เช่น client.connect eu-medium.vitalrust.com:28014',
    'หมายเหตุยาวเกินไปหรือมีอักขระที่ไม่รองรับ โปรดย่อแล้วลองอีกครั้ง', 'เซิร์ฟเวอร์นี้ไม่พร้อมใช้งานแล้ว โปรดเลือกเซิร์ฟเวอร์อีกครั้ง',
    'ดำเนินการไม่สำเร็จ โปรดเปิดการ์ดเดิมหรือใช้ /newwipe อีกครั้ง', 'ตรวจสอบการตั้งค่าแล้วลองอีกครั้ง'],
  ko: ['게시가 대기열에 추가되었습니다. Discord가 전송을 확인하면 카드가 표시됩니다.', '변경 사항이 대기열에 추가되었습니다. Discord가 확인하면 기존 카드가 업데이트됩니다.',
    '올바른 와이프 날짜와 시간을 YYYY-MM-DD HH:mm 형식으로 입력하세요.', 'Europe/Amsterdam 또는 Asia/Shanghai와 같은 올바른 시간대를 입력하세요.',
    '다음 와이프 시간을 찾을 수 없습니다. 설정을 열어 직접 입력하세요.', '미래의 와이프 날짜와 시간을 선택하세요.',
    '서머타임이 끝날 때 이 현지 시간이 두 번 발생합니다. 중복되지 않는 시간을 선택하세요.', '시계가 앞으로 이동하여 이 현지 시간은 존재하지 않습니다. 다른 시간을 선택하세요.',
    '날짜, 시간과 시간대가 일치하지 않습니다. 설정에서 확인하세요.', '올바른 주소를 입력하세요. 예: client.connect eu-medium.vitalrust.com:28014',
    '메모가 너무 길거나 지원하지 않는 문자가 있습니다. 줄인 후 다시 시도하세요.', '이 서버는 더 이상 사용할 수 없습니다. 서버를 다시 선택하세요.',
    '작업을 완료하지 못했습니다. 원래 카드를 열거나 /newwipe를 다시 실행하세요.', '설정을 확인한 후 다시 시도하세요.'],
};
for (const [locale, translations] of Object.entries(errorCopy))
  Object.assign(copy[locale], Object.fromEntries(errorKeys.map((key, index) => [key, translations[index]])));

const deliveryStatusCopy = {
  en: ['Delivery result is unknown. Check the channel before publishing again; this card will not be resent automatically.', 'The card was not delivered. Check its delivery status in the admin panel.', 'The edit result is unknown. Verify the original message before changing it again.'],
  'zh-CN': ['投递结果未知，请先检查频道再决定是否重新发布；系统不会自动重发这张卡片。', '卡片未送达，请在管理后台检查投递状态。', '原卡片的更新结果未知，请先核实原消息再继续修改。'],
  ru: ['Результат отправки неизвестен. Проверьте канал перед повторной публикацией. Автоматической повторной отправки не будет.', 'Карточка не доставлена. Проверьте статус отправки в панели управления.', 'Результат изменения неизвестен. Проверьте исходное сообщение перед повторным изменением.'],
  tr: ['Gönderim sonucu bilinmiyor. Yeniden yayımlamadan önce kanalı kontrol edin; kart otomatik olarak tekrar gönderilmeyecek.', 'Kart teslim edilmedi. Yönetim panelinden gönderim durumunu kontrol edin.', 'Düzenleme sonucu bilinmiyor. Yeniden değiştirmeden önce ilk mesajı kontrol edin.'],
  th: ['ไม่ทราบผลการส่ง โปรดตรวจสอบช่องก่อนเผยแพร่ใหม่ ระบบจะไม่ส่งการ์ดนี้ซ้ำโดยอัตโนมัติ', 'ส่งการ์ดไม่สำเร็จ โปรดตรวจสอบสถานะการส่งในหน้าผู้ดูแล', 'ไม่ทราบผลการแก้ไข โปรดตรวจสอบข้อความเดิมก่อนแก้ไขอีกครั้ง'],
  ko: ['전송 결과를 알 수 없습니다. 다시 게시하기 전에 채널을 확인하세요. 카드는 자동으로 재전송되지 않습니다.', '카드가 전송되지 않았습니다. 관리 페이지에서 전송 상태를 확인하세요.', '수정 결과를 알 수 없습니다. 다시 수정하기 전에 원래 메시지를 확인하세요.'],
};
for (const [locale, translations] of Object.entries(deliveryStatusCopy))
  Object.assign(copy[locale], Object.fromEntries(['deliveryUnknown', 'deliveryFailed', 'updateUnknown'].map((key, index) => [key, translations[index]])));

export const OPEN_WIPE_LANGUAGES = Object.freeze(Object.keys(copy));
export function text(locale, key, vars = {}) {
  const template = copy[discordInteractionLanguage(locale)][key];
  requireValue(typeof template === 'string', 'OPEN_WIPE_COPY_INVALID', 500);
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, name) => String(vars[name] ?? ''));
}

/** Translate known business errors without exposing internal codes or provider responses. */
export function localizeError(locale, errorCode) {
  const code = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(errorCode) ? errorCode : '';
  const messages = {
    TIME_INPUT_INVALID: 'timeInvalid', TIME_ZONE_INVALID: 'timeZoneInvalid',
    TIME_AMBIGUOUS: 'timeAmbiguous', TIME_NONEXISTENT: 'timeNonexistent',
    TIME_OFFSET_MISMATCH: 'timeMismatch', TIME_ZONE_MISMATCH: 'timeMismatch', TIME_UTC_MISMATCH: 'timeMismatch',
    OPEN_WIPE_TIME_REQUIRED: 'timeMissing', OPEN_WIPE_TIME_NOT_FUTURE: 'timeFuture',
    OPEN_WIPE_CONNECT_INVALID: 'connectInvalid', OPEN_WIPE_NOTES_INVALID: 'notesInvalid',
    OPEN_WIPE_SERVER_INVALID: 'serverUnavailable', OPEN_WIPE_SERVERS_INVALID: 'serverUnavailable',
    OPEN_WIPE_CATALOG_UNAVAILABLE: 'serverUnavailable', OPEN_WIPE_SETTINGS_INVALID: 'settingsInvalid',
    OPEN_WIPE_UNAVAILABLE: 'unavailable', OPEN_WIPE_ALREADY_PUBLISHED: 'alreadyPublished',
    CARD_EDIT_RECONCILIATION_REQUIRED: 'updateUnknown',
  };
  const key = messages[code] || (/DENIED|DISABLED/.test(code) ? 'denied'
    : /EXPIRED|STALE|CONFLICT/.test(code) ? 'expired' : 'unknownFailure');
  return text(locale, key);
}

const cut = (value, max) => {
  let result = '';
  for (const character of String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim()) {
    if (result.length + character.length > max) break;
    result += character;
  }
  return result;
};
const label = (title, component, description) => ({ type: 18, label: title, ...(description ? { description } : {}), component });
const input = (custom_id, value, { required = false, max = 300, style = 1, placeholder } = {}) => ({
  type: 4, custom_id, style, required, max_length: max, value: String(value ?? '').slice(0, max), ...(placeholder ? { placeholder } : {}),
});
const mentions = () => ({ parse: [], roles: [], users: [], replied_user: false });

function preferenceField(locale, settings) {
  const t = key => text(locale, key);
  return label(t('preferences'), {
    type: 22, custom_id: 'preferences', required: false, min_values: 0, max_values: 2,
    options: [
      { label: t('adaptiveDisplay'), value: 'adaptiveDisplay', description: t('adaptiveHint'), default: settings.adaptiveDisplay !== false },
      { label: t('autoConnect'), value: 'autoConnect', description: t('autoConnectHint'), default: settings.autoConnect !== false },
    ],
  });
}

function serverOptions(servers, selectedId) {
  requireValue(Array.isArray(servers) && servers.length > 0 && servers.length <= 25 &&
    servers.every(server => server && typeof (server.serverId ?? server.id) === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(server.serverId ?? server.id)) &&
    new Set(servers.map(server => server.serverId ?? server.id)).size === servers.length, 'OPEN_WIPE_SERVERS_INVALID', 422);
  return servers.map(server => {
    const id = server.serverId ?? server.id;
    return { label: cut(server.serverName || server.name || server.label || id, 100) || id, value: id, ...(selectedId === id ? { default: true } : {}) };
  });
}

export function createServerModal({ token, servers, locale, defaults = {} }) {
  const options = serverOptions(servers, defaults.serverId);
  const t = key => text(locale, key);
  return { type: 9, data: { custom_id: openWipeCustomId('create_submit', token), title: t('createTitle'), components: [
    label(t('server'), { type: 3, custom_id: 'serverId', required: true, min_values: 1, max_values: 1, placeholder: t('serverPlaceholder'),
      options }),
    preferenceField(locale, defaults),
    label(t('connect'), input('directConnect', defaults.directConnect), t('connectHint')),
    label(t('notes'), input('notes', defaults.notes, { max: 1000, style: 2 }), t('notesHint')),
  ] } };
}

export function createSettingsModal({ token, serverName, settings = {}, locale }) {
  const t = key => text(locale, key);
  return { type: 9, data: { custom_id: openWipeCustomId('settings_submit', token),
    title: cut(`${t('settingsTitle')}${serverName ? ` · ${serverName}` : ''}`, 45), components: [
      label(t('dateTime'), input('wipeAtLocal', String(settings.wipeAtLocal || '').replace('T', ' ').slice(0, 16), { required: true, max: 16, placeholder: 'YYYY-MM-DD HH:mm' }), t('dateTimeHint')),
      label(t('timeZone'), input('timeZone', settings.timeZone || 'UTC', { required: true, max: 80, placeholder: 'Europe/Amsterdam' }), t('timeZoneHint')),
      label(t('connect'), input('directConnect', settings.directConnect), t('connectHint')),
      label(t('notes'), input('notes', settings.notes, { max: 1000, style: 2 }), t('notesHint')),
      preferenceField(locale, settings),
    ] } };
}

/** A private preview never inherits live attendance/settings buttons from a card. */
export function createPreviewPayload({ token, cardPayload, locale, canPublish = true, servers, settings = {}, selectedServer, editing = false }) {
  if (servers) return createServerPickerPayload({ token, servers, locale, cardPayload, canPublish, editing,
    settings: { ...(typeof selectedServer === 'object' && selectedServer ? selectedServer : {}), ...settings,
      serverId: settings.serverId || (typeof selectedServer === 'string' ? selectedServer : selectedServer?.serverId || selectedServer?.id) } });
  requireValue(cardPayload && Array.isArray(cardPayload.embeds) && cardPayload.embeds.length <= 10, 'OPEN_WIPE_PREVIEW_INVALID', 422);
  const t = key => text(locale, key);
  const button = (action, key, style = 2) => ({ type: 2, style, label: t(key), custom_id: openWipeCustomId(action, token) });
  return { content: [t(editing ? 'editingPreview' : 'preview'), ...(!canPublish ? [t('previewNeedsTime')] : []), cardPayload.content || ''].filter(Boolean).join('\n').slice(0, 2000),
    embeds: structuredClone(cardPayload.embeds), allowed_mentions: mentions(), components: [{ type: 1, components: [
      ...(canPublish ? [button('publish', editing ? 'save' : 'publish', 1)] : []), button('edit_details', 'editDetails'), button('server', 'serverChange'),
    ] }],
  };
}

const clipText = (value, max) => {
  const result = String(value ?? '').slice(0, max);
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
};
const escapeTitle = value => cut(value, 200).replace(/([\\`*_{}\[\]()#+.!|>~])/g, '\\$1').replaceAll('@', '＠').replaceAll('<', '‹');

/** Components V2 keeps the live server details below the selection that changes them. */
export function createServerPickerPayload({ token, servers, locale, settings = {}, cardPayload = null, canPublish = false, editing = false }) {
  const options = serverOptions(servers, settings.serverId);
  const selected = options.find(option => option.default);
  requireValue(!cardPayload || Array.isArray(cardPayload.embeds) && cardPayload.embeds.length <= 10, 'OPEN_WIPE_PREVIEW_INVALID', 422);
  const t = key => text(locale, key);
  const button = (action, key, style = 2) => ({ type: 2, style, label: t(key), custom_id: openWipeCustomId(action, token) });
  const heading = selected
    ? [t(editing ? 'editingPreview' : 'preview'), ...(!canPublish ? [t('previewNeedsTime')] : [])].join('\n')
    : `**${t('createTitle')}**\n${t('pickerPrompt')}`;
  const components = [{ type: 10, content: heading },
    { type: 1, components: [{ type: 3, custom_id: openWipeCustomId('select_server', token),
      min_values: 1, max_values: 1, placeholder: t('serverPlaceholder'), options }] }];
  if (selected) {
    const timestamp = Date.parse(settings.wipeAt || '');
    const wipeTime = Number.isFinite(timestamp) && settings.adaptiveDisplay !== false ? `<t:${Math.floor(timestamp / 1000)}:F>`
      : settings.wipeAtLocal ? `${cut(settings.wipeAtLocal, 40)} (${cut(settings.timeZone || 'UTC', 80)})` : t('timeMissing');
    const command = cut(settings.directConnect, 300);
    const parts = /^client\.connect ([a-z0-9.-]+):([0-9]{1,5})$/i.exec(command);
    const ipCommand = parts && !isIP(parts[1]) && isIP(settings.resolvedIp || '') === 4
      ? `client.connect ${settings.resolvedIp}:${parts[2]}` : '';
    const details = [
      `## ${escapeTitle(settings.serverName || selected.label)}`,
      `**${t('wipeTime')}**\n${wipeTime}`,
      `**${t('connect')}**\n${command ? `\`${command}\`` : t('noConnect')}`,
      ...(ipCommand ? [`**${t('alternativeConnect')}**\n\`${ipCommand}\``] : []),
      ...(settings.notes ? [`**${t('notes')}**\n${clipText(settings.notes, 1000)}`] : []),
    ].join('\n\n');
    components.push({ type: 10, content: clipText(details, 4000 - heading.length) },
      { type: 1, components: [button('edit_details', 'editDetails'),
        ...(canPublish ? [button('publish', editing ? 'save' : 'publish', 1)] : [])] });
  }
  return { flags: 32768, content: '', embeds: [], allowed_mentions: mentions(), components };
}
