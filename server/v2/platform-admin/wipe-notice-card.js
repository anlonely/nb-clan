import { brandName, deploymentText } from '../../branding.js';
import { discordTimestamp } from '../notification-platforms/discord-time.js';
import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

const noticeCopy = {
  en: { title: 'Wipe Update', ended: 'Wipe ended', archived: 'Wipe archived', cancelled: 'Wipe cancelled', closed: 'Sign-ups are closed', open: 'Sign-ups are open', server: 'Server', pending: 'To be confirmed', scheduled: 'Scheduled Wipe', localTime: 'Times are shown in your local time zone.', deadline: 'Registration Deadline', signup: 'Sign Up', before: 'Before the Wipe', read: 'Read {channel}.', add: 'Add all electricians on Steam.', check: 'Check {channel} for connection details.', final: 'View the final status in {channel}.', choose: 'Choose **Attending**, **Join in 8h**, **Join in 16h**, or **Not Attending** in {channel}.', member: 'Register and link your Discord and Steam accounts before signing up.', direct: 'Sign up directly with your Discord account; Steam linking is not required.', footer: 'Automatically synced with the wipe schedule', buttons: ['Wipe Sign-up', 'Server Direct Connect', 'Server Map'] },
  'zh-CN': { title: '档期公告', ended: '档期已结束', archived: '档期已归档', cancelled: '档期已取消', closed: '报名已关闭', open: '报名已开放', server: '服务器', pending: '待确定', scheduled: '服务器计划清档', localTime: '时间按你的本地时区显示。', deadline: '报名截止', signup: '报名', before: '开荒前准备', read: '阅读 {channel}。', add: '添加全部电工 Steam 好友。', check: '在 {channel} 查看服务器直连信息。', final: '在 {channel} 查看最终报名状态。', choose: '在 {channel} 选择 **参加**、**8 小时后到场**、**16 小时后到场** 或 **不参加**。', member: '报名前请完成成员登记并绑定 Discord 与 Steam 账号。', direct: '直接使用 Discord 账号报名，无需绑定 Steam。', footer: '自动同步档期安排', buttons: ['档期报名', '服务器直连', '服务器地图'] },
  ru: { title: 'Обновление вайпа', ended: 'Вайп завершён', archived: 'Вайп в архиве', cancelled: 'Вайп отменён', closed: 'Запись закрыта', open: 'Запись открыта', server: 'Сервер', pending: 'Будет уточнено', scheduled: 'Плановый вайп сервера', localTime: 'Время показано в вашем часовом поясе.', deadline: 'Запись до', signup: 'Запись', before: 'Перед вайпом', read: 'Прочитайте {channel}.', add: 'Добавьте всех электриков в друзья в Steam.', check: 'Данные для подключения находятся в {channel}.', final: 'Итоговый статус записи находится в {channel}.', choose: 'В {channel} выберите **Буду вовремя**, **Через 8 ч**, **Через 16 ч** или **Не участвую**.', member: 'Перед записью зарегистрируйтесь и привяжите Discord и Steam.', direct: 'Записывайтесь через Discord; привязка Steam не требуется.', footer: 'Автоматическая синхронизация с расписанием вайпа', buttons: ['Запись на вайп', 'Подключение к серверу', 'Карта сервера'] },
  tr: { title: 'Wipe güncellemesi', ended: 'Wipe sona erdi', archived: 'Wipe arşivlendi', cancelled: 'Wipe iptal edildi', closed: 'Kayıtlar kapalı', open: 'Kayıtlar açık', server: 'Sunucu', pending: 'Daha sonra belirlenecek', scheduled: 'Planlanan sunucu wipe zamanı', localTime: 'Saatler yerel saat diliminizde gösterilir.', deadline: 'Son kayıt zamanı', signup: 'Kayıt ol', before: 'Wipe öncesi', read: '{channel} kanalını okuyun.', add: 'Tüm elektrikçileri Steam’de arkadaş olarak ekleyin.', check: 'Bağlantı bilgileri için {channel} kanalını kontrol edin.', final: 'Son kayıt durumunu {channel} kanalında görüntüleyin.', choose: '{channel} kanalında **Katılıyorum**, **8 saat sonra**, **16 saat sonra** veya **Katılmıyorum** seçeneğini seçin.', member: 'Kayıt olmadan önce üye kaydınızı tamamlayıp Discord ve Steam hesaplarınızı bağlayın.', direct: 'Discord hesabınızla doğrudan kayıt olun; Steam bağlantısı gerekmez.', footer: 'Wipe takvimiyle otomatik eşitlenir', buttons: ['Wipe kaydı', 'Sunucuya doğrudan bağlan', 'Sunucu haritası'] },
  th: { title: 'อัปเดตกำหนดการไวป์', ended: 'ไวป์สิ้นสุดแล้ว', archived: 'เก็บไวป์เข้าคลังแล้ว', cancelled: 'ยกเลิกไวป์แล้ว', closed: 'ปิดลงทะเบียนแล้ว', open: 'เปิดลงทะเบียนแล้ว', server: 'เซิร์ฟเวอร์', pending: 'รอยืนยัน', scheduled: 'เวลาไวป์เซิร์ฟเวอร์ตามกำหนด', localTime: 'เวลาแสดงตามเขตเวลาท้องถิ่นของคุณ', deadline: 'ปิดรับลงทะเบียน', signup: 'ลงทะเบียน', before: 'เตรียมตัวก่อนเริ่มไวป์', read: 'อ่าน {channel}', add: 'เพิ่มช่างไฟทุกคนเป็นเพื่อนบน Steam', check: 'ดูข้อมูลการเชื่อมต่อได้ใน {channel}', final: 'ดูสถานะการลงทะเบียนสุดท้ายได้ใน {channel}', choose: 'ใน {channel} เลือก **เข้าร่วม** **มาหลัง 8 ชั่วโมง** **มาหลัง 16 ชั่วโมง** หรือ **ไม่เข้าร่วม**', member: 'ก่อนลงทะเบียน โปรดลงทะเบียนสมาชิกและเชื่อมโยง Discord กับ Steam ให้เสร็จสิ้น', direct: 'ลงทะเบียนโดยตรงด้วยบัญชี Discord โดยไม่ต้องเชื่อมโยง Steam', footer: 'ซิงค์กับกำหนดการไวป์โดยอัตโนมัติ', buttons: ['ลงทะเบียนไวป์', 'เชื่อมต่อเซิร์ฟเวอร์โดยตรง', 'แผนที่เซิร์ฟเวอร์'] },
  ko: { title: '와이프 일정 알림', ended: '와이프 종료', archived: '와이프 보관됨', cancelled: '와이프 취소', closed: '참가 신청 마감', open: '참가 신청 가능', server: '서버', pending: '추후 확정', scheduled: '예정된 서버 와이프', localTime: '시간은 현재 사용자의 현지 시간대로 표시됩니다.', deadline: '신청 마감', signup: '참가 신청', before: '와이프 전 준비', read: '{channel}을 읽어 보세요.', add: 'Steam에서 모든 전기 담당자를 친구로 추가하세요.', check: '{channel}에서 서버 연결 정보를 확인하세요.', final: '{channel}에서 최종 신청 상태를 확인하세요.', choose: '{channel}에서 **참가**, **8시간 후 참가**, **16시간 후 참가** 또는 **불참**을 선택하세요.', member: '신청 전에 회원 등록을 완료하고 Discord와 Steam 계정을 연결하세요.', direct: 'Steam 연결 없이 Discord 계정으로 바로 신청하세요.', footer: '와이프 일정과 자동 동기화됨', buttons: ['와이프 참가 신청', '서버 바로 연결', '서버 지도'] },
};

export function discordWipeNoticePayload(wipe, target, config, signupTargetId, language = 'en') {
  const selected = discordInteractionLanguage(language), copy = noticeCopy[selected];
  const replace = (value, channelId) => value.replace('{channel}', `<#${channelId}>`);
  const validChannel = id => /^\d{10,20}$/.test(String(id || ''));
  const signup = config.targets.find(t => t.id === signupTargetId && t.enabled && t.guildId === target.guildId);
  const signupChannelId = signup?.signupCardChannelId || signup?.channelId;
  if (!validChannel(target.guildId) || !validChannel(signupChannelId)) return null;
  const memberRequired = config.commands.find(c=>c.id==='wipe')?.signupMode !== 'discord_only';
  const welcomeChannel = validChannel(target.welcomeGuideChannelId) ? target.welcomeGuideChannelId : null;
  const connectChannel = validChannel(target.serverConnectChannelId) ? target.serverConnectChannelId : null;
  const channel = id => `https://discord.com/channels/${target.guildId}/${id}`;
  const link = (label, url) => ({ type: 2, style: 5, label, url });
  const snapshot = wipe.serverSnapshot || {};
  const title = String(wipe.title || '').replace(/\s+/g, ' ').trim();
  const closed = ['ended', 'archived', 'cancelled'].includes(wipe.lifecycle) || wipe.signupWindow !== 'open';
  const state = copy[wipe.lifecycle] || (closed ? copy.closed : copy.open);
  const map = snapshot.mapLink || snapshot.rustMapsLink;
  let mapUrl = null;
  try { const url = new URL(map); if(url.protocol==='https:'&&!url.username&&!url.password)mapUrl=url.href; } catch {}
  const beforeWipe = [welcomeChannel ? replace(copy.read, welcomeChannel) : null, copy.add,
    connectChannel ? replace(copy.check, connectChannel) : null].filter(Boolean).join(' ');
  return { content: '', embeds: [{
    title: `📣 ${copy.title} · ${title || snapshot.name || deploymentText("Clan Portal")}`.slice(0, 256),
    description: `${brandName()} · ${state}`, color: closed ? 0x95a5a6 : 0xe67e22,
    fields: [
      { name: copy.server, value: snapshot.name || copy.pending, inline: false },
      { name: copy.scheduled, value: `${discordTimestamp(wipe.serverScheduledWipeAt) || copy.pending}\n${copy.localTime}`, inline: false },
      ...(wipe.signupClosesAt ? [{ name: copy.deadline, value: discordTimestamp(wipe.signupClosesAt) || copy.pending, inline: false }] : []),
      { name: copy.signup, value: closed ? `${copy.closed}${selected === 'zh-CN' ? '。' : selected === 'th' ? '\n' : '. '}${replace(copy.final, signupChannelId)}` : `${replace(copy.choose, signupChannelId)}\n${memberRequired ? copy.member : copy.direct}`, inline: false },
      { name: copy.before, value: beforeWipe, inline: false },
    ], footer: { text: `${brandName()} · ${copy.footer}` },
  }], components: [{ type: 1, components: [link(copy.buttons[0], channel(signupChannelId)), ...(connectChannel ? [link(copy.buttons[1], channel(connectChannel))] : []), ...(mapUrl ? [link(copy.buttons[2], mapUrl)] : [])] }], allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
}
