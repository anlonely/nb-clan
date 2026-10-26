import { deploymentText, siteOrigin } from '../../branding.js';
import { createHash } from 'node:crypto';
import { electricianProfilesUrl as profilesUrlFor } from './electrician-card.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

export const WELCOME_GUIDE_COMMAND_ID = 'welcome_guide_card';
export const welcomeGuideTargetId = (id, platform = 'kook') => `welcome_guide_${createHash('sha256').update(`${platform}:${id}`).digest('hex').slice(0, 24)}`;

const BINDING_URL = () => deploymentText("https://clan.example.com/login?returnTo=%2Fapp%2Fme");
const TUTORIAL_URL = () => deploymentText("https://clan.example.com/guides/kook-steam-binding.html?v=binding-hq-2");
const channelUrl = (guildId, channelId) => `https://www.kookapp.cn/app/channels/${guildId}/${channelId}`;
const channelIdValid = value => /^\d{10,20}$/.test(String(value || ''));

export function welcomeGuideDetails(target) {
  if (![target?.guildId, target?.electricianChannelId, target?.serverConnectChannelId].every(channelIdValid)) return null;
  const electricianProfilesUrl = profilesUrlFor(target);
  return {
    bindingUrl: BINDING_URL(),
    tutorialUrl: TUTORIAL_URL(),
    electricianUrl: channelUrl(target.guildId, target.electricianChannelId),
    electricianProfilesUrl,
    electricianTutorialUrl: `${electricianProfilesUrl}#tutorial`,
    serverUrl: channelUrl(target.guildId, target.serverConnectChannelId)
  };
}

export function discordWelcomeGuideDetails(target, language = 'en') {
  if (![target?.guildId, target?.electricianChannelId, target?.serverConnectChannelId].every(channelIdValid)) return null;
  const channelUrl = channelId => `https://discord.com/channels/${target.guildId}/${channelId}`;
  const selected = discordInteractionLanguage(language);
  const electricianProfilesUrl = profilesUrlFor(target, 'discord', selected);
  return {
    bindingUrl: `${siteOrigin()}/login?lang=${selected === 'zh-CN' ? 'zh-CN' : 'en'}&returnTo=%2Fapp%2Fme`,
    electricianUrl: channelUrl(target.electricianChannelId),
    tutorialUrl: deploymentText("https://clan.example.com/guides/discord-steam-binding.html?v=en-hq-2"),
    electricianProfilesUrl,
    electricianTutorialUrl: `${electricianProfilesUrl}#tutorial`,
    serverUrl: channelUrl(target.serverConnectChannelId),
  };
}

export function welcomeGuidePayload(channelId, details) {
  const text = content => ({ type: 'kmarkdown', content });
  const section = content => ({ type: 'section', text: text(content) });
  const heading = content => ({ type: 'header', text: { type: 'plain-text', content } });
  const button = (label, value, theme = 'primary') => ({ type: 'button', theme, click: 'link', value, text: { type: 'plain-text', content: label } });
  const link = (label, value, theme = 'primary') => ({ type: 'action-group', elements: [button(label, value, theme)] });
  const modules = [
    heading('📢 开荒前先看这三件事'),
    { type: 'context', elements: [{ type: 'plain-text', content: deploymentText("Clan Portal · 开荒须知") }] },
    { type: 'divider' },
    heading('⚡ 第一件事：绑定 KOOK & Steam'),
    section('前往战队网站，使用 **KOOK 登录**，再按页面提示完成 **Steam 验证**。'),
    section('⚠️登录Steam账号需要加速Steam商店或者开启VPN'),
    { type: 'action-group', elements: [button('前往网页绑定', details.bindingUrl), button('查看教程', details.tutorialUrl, 'info')] },
    { type: 'divider' },
    heading('⚡ 第二件事：加电工 ID'),
    section('点击前往添加电工Steam好友按钮，根据教程添加全部电工Steam好友。'),
    section('🟢 加了 → 炮台可能不揍你\n🔴 没加 → 炮台一定揍你'),
    { type: 'action-group', elements: [button('前往添加电工Steam好友', details.electricianProfilesUrl), button('查看教程', details.electricianTutorialUrl, 'info')] },
    { type: 'divider' },
    heading('⚡ 第三件事：服务器 IP 和地图'),
    section('服务器 IP 和地图在 **#服务器直连** 频道，记得去看。'),
    link('查看 #服务器直连', details.serverUrl, 'info'),
    { type: 'divider' },
    heading('❌ 开荒注意'),
    section('• 禁止收主家的床\n• 禁止拍床在出入口上下楼位置\n• 不要随便清队友包\n• 抄家炮楼没成型前不要进去'),
    { type: 'divider' },
    section('祝各位玩得开心，多多挖矿，少被炮台揍 ⛏️🔥')
  ];
  return { type: 10, target_id: channelId, content: JSON.stringify([{ type: 'card', theme: 'primary', size: 'lg', modules }]) };
}

const discordGuideCopy = {
  en: {
    title: '📢 Before the Wipe: 3 Things to Do', description: deploymentText("Clan Portal · Wipe guide"),
    fields: [
      ['⚡ 1. Link Discord & Steam', 'Open the team website with **Discord**, then complete **Steam verification**.'],
      ['⚡ 2. Add the Electricians on Steam', 'Click **Add Electricians on Steam**, follow the tutorial, and send a friend request to everyone on the list.\n🟢 Added: turrets may spare you.\n🔴 Not added: expect to be shot.'],
      ['⚡ 3. Check the Server IP & Map', 'Find the server address and map in the Server Direct Connect channel.'],
      ['❌ Wipe Rules', '• Do not pick up beds in the main base.\n• Do not place beds on entrances or stairways.\n• Do not loot teammates’ bags without permission.\n• Stay out of a raid base until the tower is ready.'],
    ],
    footer: 'Have fun, mine plenty, and watch out for turrets ⛏️🔥',
    buttons: ['Register / Link Steam', 'Binding Tutorial', 'Add Electricians on Steam', 'Friend Tutorial', 'Server Direct Connect'],
  },
  'zh-CN': {
    title: '📢 开荒前先看这三件事', description: deploymentText("Clan Portal · 开荒须知"),
    fields: [
      ['⚡ 第一件事：绑定 Discord & Steam', '前往战队网站，使用 **Discord 登录**，再完成 **Steam 验证**。'],
      ['⚡ 第二件事：加电工 Steam 好友', '点击 **添加电工 Steam 好友**，按教程添加名单上的全部电工。\n🟢 加了：炮台可能不揍你。\n🔴 没加：炮台一定揍你。'],
      ['⚡ 第三件事：服务器 IP 和地图', '前往服务器直连频道查看服务器地址和地图。'],
      ['❌ 开荒注意', '• 禁止收主家的床。\n• 禁止在出入口和上下楼位置放床。\n• 不要随便清队友包。\n• 抄家炮楼没成型前不要进去。'],
    ],
    footer: '祝各位玩得开心，多多挖矿，少被炮台揍 ⛏️🔥',
    buttons: ['登记 / 绑定 Steam', '绑定教程', '添加电工 Steam 好友', '好友教程', '服务器直连'],
  },
  ru: {
    title: '📢 Перед вайпом: 3 важных шага', description: deploymentText("Clan Portal · Подготовка к вайпу"),
    fields: [
      ['⚡ 1. Привяжите Discord и Steam', 'Войдите на сайт команды через **Discord**, затем пройдите **подтверждение Steam**.'],
      ['⚡ 2. Добавьте электриков в Steam', 'Нажмите **Добавить электриков в Steam**, следуйте инструкции и отправьте заявку в друзья всем электрикам из списка.\n🟢 Добавили: турели могут вас пощадить.\n🔴 Не добавили: турели будут стрелять.'],
      ['⚡ 3. Проверьте IP сервера и карту', 'Адрес сервера и карта находятся в канале прямого подключения к серверу.'],
      ['❌ Правила вайпа', '• Не подбирайте кровати на основной базе.\n• Не ставьте кровати у входов и на лестницах.\n• Не забирайте вещи из рюкзаков союзников без разрешения.\n• Не заходите на рейдовую базу, пока башня не готова.'],
    ],
    footer: 'Хорошей игры! Добывайте больше ресурсов и берегитесь турелей ⛏️🔥',
    buttons: ['Регистрация / Steam', 'Инструкция по привязке', 'Добавить электриков в Steam', 'Как добавить в друзья', 'Подключение к серверу'],
  },
  tr: {
    title: '📢 Wipe öncesi: Yapılacak 3 şey', description: deploymentText("Clan Portal · Wipe rehberi"),
    fields: [
      ['⚡ 1. Discord ve Steam hesaplarını bağlayın', 'Takımın web sitesine **Discord ile giriş yapın**, ardından **Steam doğrulamasını** tamamlayın.'],
      ['⚡ 2. Elektrikçileri Steam’de ekleyin', '**Elektrikçileri Steam’de ekle** düğmesine basın, rehberi takip edin ve listedeki tüm elektrikçilere arkadaşlık isteği gönderin.\n🟢 Eklediniz: taretler sizi vurmayabilir.\n🔴 Eklemediniz: taretler size ateş eder.'],
      ['⚡ 3. Sunucu IP’sini ve haritayı kontrol edin', 'Sunucu adresi ve haritası, sunucuya doğrudan bağlantı kanalındadır.'],
      ['❌ Wipe kuralları', '• Ana üsteki yatakları toplamayın.\n• Girişlere ve merdivenlere yatak koymayın.\n• İzin almadan takım arkadaşlarınızın çantalarını yağmalamayın.\n• Kule hazır olmadan baskın üssüne girmeyin.'],
    ],
    footer: 'İyi eğlenceler! Bolca maden toplayın ve taretlere dikkat edin ⛏️🔥',
    buttons: ['Kayıt / Steam bağla', 'Hesap bağlama rehberi', 'Elektrikçileri Steam’de ekle', 'Arkadaş ekleme rehberi', 'Sunucuya doğrudan bağlan'],
  },
  th: {
    title: '📢 ก่อนเริ่มไวป์: 3 สิ่งที่ต้องทำ', description: deploymentText("Clan Portal · คู่มือก่อนเริ่มไวป์"),
    fields: [
      ['⚡ 1. เชื่อมโยง Discord และ Steam', 'เข้าสู่เว็บไซต์ทีมด้วย **Discord** แล้วดำเนินการ **ยืนยัน Steam** ให้เสร็จสิ้น'],
      ['⚡ 2. เพิ่มช่างไฟเป็นเพื่อนบน Steam', 'กด **เพิ่มช่างไฟเป็นเพื่อนบน Steam** ทำตามคู่มือ และส่งคำขอเป็นเพื่อนให้ช่างไฟทุกคนในรายชื่อ\n🟢 เพิ่มแล้ว: ป้อมปืนอาจไม่ยิงคุณ\n🔴 ยังไม่เพิ่ม: ป้อมปืนจะยิงคุณ'],
      ['⚡ 3. ตรวจสอบ IP เซิร์ฟเวอร์และแผนที่', 'ดูที่อยู่เซิร์ฟเวอร์และแผนที่ได้ในช่องเชื่อมต่อเซิร์ฟเวอร์โดยตรง'],
      ['❌ กฎของไวป์', '• ห้ามเก็บเตียงในฐานหลัก\n• ห้ามวางเตียงขวางทางเข้าออกหรือบันได\n• ห้ามเก็บของจากกระเป๋าเพื่อนร่วมทีมโดยไม่ได้รับอนุญาต\n• ห้ามเข้าฐานสำหรับบุกจนกว่าหอจะสร้างเสร็จ'],
    ],
    footer: 'เล่นให้สนุก ขุดแร่ให้เยอะ และระวังป้อมปืน ⛏️🔥',
    buttons: ['ลงทะเบียน / เชื่อม Steam', 'คู่มือเชื่อมบัญชี', 'เพิ่มช่างไฟเป็นเพื่อนบน Steam', 'คู่มือเพิ่มเพื่อน', 'เชื่อมต่อเซิร์ฟเวอร์โดยตรง'],
  },
  ko: {
    title: '📢 와이프 전: 해야 할 3가지', description: deploymentText("Clan Portal · 와이프 안내"),
    fields: [
      ['⚡ 1. Discord와 Steam 연결', '팀 웹사이트에서 **Discord로 로그인**한 후 **Steam 인증**을 완료하세요.'],
      ['⚡ 2. Steam에서 전기 담당자 친구 추가', '**Steam 전기 담당자 친구 추가**를 누르고 안내에 따라 명단의 모든 전기 담당자에게 친구 요청을 보내세요.\n🟢 추가함: 포탑이 쏘지 않을 수 있습니다.\n🔴 추가하지 않음: 포탑이 공격합니다.'],
      ['⚡ 3. 서버 IP와 지도 확인', '서버 바로 연결 채널에서 서버 주소와 지도를 확인하세요.'],
      ['❌ 와이프 규칙', '• 본진의 침대를 회수하지 마세요.\n• 출입구와 계단에 침대를 놓지 마세요.\n• 허락 없이 팀원의 가방을 털지 마세요.\n• 타워가 완성되기 전에는 레이드 기지에 들어가지 마세요.'],
    ],
    footer: '즐겁게 플레이하고, 광물을 많이 캐고, 포탑을 조심하세요 ⛏️🔥',
    buttons: ['등록 / Steam 연결', '계정 연결 안내', 'Steam 전기 담당자 친구 추가', '친구 추가 안내', '서버 바로 연결'],
  },
};

export function discordWelcomeGuidePayload(details, language = 'en') {
  const copy = discordGuideCopy[discordInteractionLanguage(language)];
  const button = (label, url) => ({ type: 2, style: 5, label, url });
  return {
    content: '',
    embeds: [{
      title: copy.title,
      description: copy.description,
      color: 0x5865f2,
      fields: copy.fields.map(([name, value]) => ({ name, value, inline: false })),
      footer: { text: copy.footer },
    }],
    components: [{ type: 1, components: [
      button(copy.buttons[0], details.bindingUrl),
      button(copy.buttons[1], details.tutorialUrl),
    ] }, { type: 1, components: [
      button(copy.buttons[2], details.electricianProfilesUrl),
      button(copy.buttons[3], details.electricianTutorialUrl),
      button(copy.buttons[4], details.serverUrl),
    ] }],
    allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
  };
}
