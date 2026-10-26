import { discordInteractionLanguage } from '../notification-platforms/interaction-language.js';

export const v2IdentityEnabled = () => process.env.NB_V2_IDENTITY_ENABLED === '1';
export const legacyRegistrationReadonly = () => v2IdentityEnabled() || process.env.NB_DISCORD_REGISTRATION_MODE === 'legacy_readonly';
export function legacyRegistrationNotice(locale = 'zh-CN') {
  const raw = process.env.NB_V2_PUBLIC_ORIGIN || process.env.NB_PUBLIC_BASE_URL || '';
  let link = '/api/v2/auth/discord/start?returnTo=%2Fapp%2Fhome';
  try { const url = new URL(raw); if (['https:', 'http:'].includes(url.protocol)) link = `${url.origin}${link}`; } catch {}
  const messages = {
    'zh-CN': '旧入队登记已封存。请前往网站登录并验证 Steam，历史申请与审核记录会保留。',
    en: 'Legacy member registration is closed. Sign in on the website and verify Steam. Previous applications and review records are retained.',
    ru: 'Старая регистрация участников закрыта. Войдите на сайт и подтвердите Steam. Предыдущие заявки и записи проверки сохранены.',
    tr: 'Eski üye kaydı kapatıldı. Web sitesinde giriş yapın ve Steam hesabınızı doğrulayın. Önceki başvurular ve inceleme kayıtları korunur.',
    th: 'ปิดการลงทะเบียนสมาชิกแบบเดิมแล้ว เข้าสู่เว็บไซต์และยืนยัน Steam ใบสมัครและบันทึกการตรวจสอบเดิมยังคงอยู่',
    ko: '기존 회원 등록이 종료되었습니다. 웹사이트에 로그인하고 Steam을 인증하세요. 이전 신청 및 심사 기록은 보존됩니다.',
  };
  return { mode: 'legacy_readonly', message: messages[discordInteractionLanguage(locale)], loginUrl: link };
}
export function legacyRegistrationInteraction(customId) {
  return legacyRegistrationReadonly() && /^(nb_member_register:|nb_member_review:)/.test(String(customId || ''));
}
export function legacyIdentityGuard(req, res, next) {
  if (v2IdentityEnabled()) {
    // V2 grants/restrictions must not be bypassed by a still-valid legacy browser cookie.
    // The feature is opt-in while G05/G07 migrate the remaining frontend/business routes.
    delete req.user;
    delete req.sessionId;
    if (req.path === '/auth/login' && req.method === 'POST') return res.redirect(307, '/api/v2/auth/password');
  }
  const readonly = legacyRegistrationReadonly();
  if (readonly && req.method !== 'GET' && (/^\/third-party\/admin\/discord-member-applications(?:\/|$)/.test(req.path) ||
    /^\/settings\/discord\/member-registration-card(?:\/|$)/.test(req.path))) {
    return res.status(410).json({ ok: false, errorCode: 'LEGACY_REGISTRATION_READONLY', error: legacyRegistrationNotice().message, ...legacyRegistrationNotice() });
  }
  if (v2IdentityEnabled() && /^\/auth\/(discord|kook|steam)(?:\/|$)/.test(req.path)) {
    const match = req.path.match(/^\/auth\/(discord|kook|steam)\/start$/);
    if (match && req.method === 'GET') {
      const query = typeof req.query?.returnTo === 'string' ? `?returnTo=${encodeURIComponent(req.query.returnTo)}` : '';
      return res.redirect(303, `/api/v2/auth/${match[1]}/start${query}`);
    }
    return res.status(410).json({ ok: false, error: 'LEGACY_AUTH_RETIRED', ...legacyRegistrationNotice() });
  }
  next();
}
