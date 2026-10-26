const locales = ['zh-CN', 'zh-TW', 'ru', 'tr', 'th', 'ko'];
const description = (english, ...translations) => ({description: english,
  description_localizations: Object.fromEntries(locales.map((locale, index) => [locale, translations[index]]))});

// Fixed native names belong to the Steam association owner. Guild-only POST
// registration keeps every other application command intact.
export function steamLinksCommandSchemas() {
  return [
    {name: 'setsteam', type: 1, ...description('Link your Steam account in this server',
      '在当前服务器关联你自己的 Steam 账号', '在目前伺服器關聯你自己的 Steam 帳號',
      'Привязать свой аккаунт Steam на этом сервере', 'Bu sunucuda kendi Steam hesabını bağla',
      'เชื่อมโยงบัญชี Steam ของคุณในเซิร์ฟเวอร์นี้', '이 서버에서 내 Steam 계정 연결하기'), options: []},
    {name: 'view', type: 1, ...description('View Steam links in this server',
      '查看当前服务器的 Steam 关联', '查看目前伺服器的 Steam 關聯',
      'Посмотреть привязки Steam на этом сервере', 'Bu sunucudaki Steam bağlantılarını görüntüle',
      'ดูการเชื่อมโยง Steam ในเซิร์ฟเวอร์นี้', '이 서버의 Steam 연결 확인하기'), options: [
      {name: 'user', type: 1, ...description('View one linked user by Discord user or Steam identifier; provide exactly one',
        '选择 Discord 用户或输入 Steam 标识，且只能选择一项', '選擇 Discord 使用者或輸入 Steam 識別碼，且只能選擇一項',
        'Найти привязку: укажите пользователя Discord или Steam ID, только один вариант',
        'Bir Discord kullanıcısı veya Steam tanımlayıcısı seç; yalnızca birini belirt',
        'เลือกผู้ใช้ Discord หรือระบุ Steam อย่างใดอย่างหนึ่งเท่านั้น',
        'Discord 사용자 또는 Steam 식별자 중 하나만 지정하여 조회'), options: [
        {name: 'user', type: 6, required: false, ...description('Discord user in this server (choose this or identifier)',
          '当前服务器的 Discord 用户（与 identifier 二选一）', '目前伺服器的 Discord 使用者（與 identifier 二選一）',
          'Пользователь Discord на сервере (либо identifier)', 'Bu sunucudaki Discord kullanıcısı (veya identifier)',
          'ผู้ใช้ Discord ในเซิร์ฟเวอร์นี้ (หรือ identifier)', '이 서버의 Discord 사용자 (identifier와 둘 중 하나)')},
        {name: 'identifier', type: 3, required: false, max_length: 256, ...description('17-digit Steam ID or steamcommunity.com profile URL (choose this or user)',
          '17 位 Steam ID 或 steamcommunity.com 资料链接（与 user 二选一）',
          '17 位 Steam ID 或 steamcommunity.com 個人資料連結（與 user 二選一）',
          '17-значный Steam ID или ссылка steamcommunity.com (либо user)',
          '17 haneli Steam ID veya steamcommunity.com profil URL adresi (veya user)',
          'Steam ID 17 หลักหรือลิงก์โปรไฟล์ steamcommunity.com (หรือ user)',
          '17자리 Steam ID 또는 steamcommunity.com 프로필 URL (user와 둘 중 하나)')}
      ]},
      {name: 'all', type: 1, ...description('List linked human members in this server (authorized roles only)',
        '查看当前服务器已关联 Steam 的成员名单（需名单权限）', '查看目前伺服器已關聯 Steam 的成員名單（需名單權限）',
        'Участники сервера с привязанным Steam (нужно разрешение)', 'Steam bağlı sunucu üyelerini listele (liste izni gerekir)',
        'ดูสมาชิกที่เชื่อมโยง Steam ในเซิร์ฟเวอร์นี้ (ต้องมีสิทธิ์)', 'Steam을 연결한 서버 구성원 목록 (목록 권한 필요)'), options: []},
      {name: 'nosteam', type: 1, ...description('List human members without a Steam link in this server (authorized roles only)',
        '查看当前服务器未关联 Steam 的成员名单（需名单权限）', '查看目前伺服器未關聯 Steam 的成員名單（需名單權限）',
        'Участники сервера без привязки Steam (нужно разрешение)', 'Steam bağlantısı olmayan üyeleri listele (liste izni gerekir)',
        'ดูสมาชิกที่ยังไม่เชื่อมโยง Steam ในเซิร์ฟเวอร์นี้ (ต้องมีสิทธิ์)', 'Steam을 연결하지 않은 서버 구성원 목록 (목록 권한 필요)'), options: []}
    ]}
  ];
}
