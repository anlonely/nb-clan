import { formatShortDate } from '../format.js';
import { cx } from '../ui/cx.js';
import { normalizeSpecialtyValues } from './specialty.jsx';
import { activeVitalVipType } from './vip.js';

function editableProfileFormFromMember(member = null) {
  return {
    customName: member?.customName || '',
    phone: member?.phone || '',
    notes: member?.notes || '',
    specialty: normalizeSpecialtyValues(member?.specialty),
    vitalVipType: member?.vitalVipType || member?.vitalVip?.type || 'none',
    vitalVipPurchasedAt: member?.vitalVipPurchasedAt || member?.vitalVip?.purchasedAt || '',
    vitalVipExpiresAt: member?.vitalVipExpiresAt || member?.vitalVip?.expiresAt || '',
    rustinityVipType: member?.rustinityVipType || member?.rustinityVip?.type || 'none',
    rustinityVipPurchasedAt: member?.rustinityVipPurchasedAt || member?.rustinityVip?.purchasedAt || '',
    rustinityVipExpiresAt: member?.rustinityVipExpiresAt || member?.rustinityVip?.expiresAt || '',
    atlasVipType: member?.atlasVipType || member?.atlasVip?.type || 'none',
    atlasVipPurchasedAt: member?.atlasVipPurchasedAt || member?.atlasVip?.purchasedAt || '',
    atlasVipExpiresAt: member?.atlasVipExpiresAt || member?.atlasVip?.expiresAt || ''
  };
}

function emptyMemberForm() {
  return {
    steamInput: '',
    customName: '',
    discordId: '',
    discordName: '',
    wechatId: '',
    specialty: [],
    phone: '',
    notes: '',
    vitalVipType: 'none',
    vitalVipPurchasedAt: '',
    vitalVipExpiresAt: '',
    rustinityVipType: 'none',
    rustinityVipPurchasedAt: '',
    rustinityVipExpiresAt: '',
    atlasVipType: 'none',
    atlasVipPurchasedAt: '',
    atlasVipExpiresAt: '',
    battlemetricsId: '',
    squadId: ''
  };
}

function vitalVipLabel(member = {}, t) {
  const type = member.vitalVipType || member.vitalVip?.type || 'none';
  if (type === 'priority') return t('vitalVipPriority');
  if (type === 'queue_skip') return t('vitalVipQueueSkip');
  return t('vitalVipNone');
}

function vitalVipMonthDay(value) {
  const raw = String(value || '').trim().slice(0, 10);
  const match = raw.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}`;
  if (/^\d{0,2}[-/]?\d{0,2}$/.test(raw)) return raw.replace('/', '-');
  return formatShortDate(value) || raw;
}

function strictDateString(year, month, day) {
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  if (!Number.isInteger(numericYear) || !Number.isInteger(numericMonth) || !Number.isInteger(numericDay)) return '';
  if (numericYear < 2020 || numericYear > 2100 || numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > 31) return '';
  const date = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
  if (
    date.getUTCFullYear() !== numericYear ||
    date.getUTCMonth() !== numericMonth - 1 ||
    date.getUTCDate() !== numericDay
  ) return '';
  return `${String(numericYear).padStart(4, '0')}-${String(numericMonth).padStart(2, '0')}-${String(numericDay).padStart(2, '0')}`;
}

function normalizeVitalVipFormDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const fullDate = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (fullDate) return strictDateString(fullDate[1], fullDate[2], fullDate[3]);
  const monthDay = raw.match(/^(\d{2})[-/](\d{2})$/);
  if (!monthDay) return '';
  return strictDateString(new Date().getUTCFullYear(), monthDay[1], monthDay[2]);
}

function vitalVipLines(member = {}, t) {
  const type = activeVitalVipType(member);
  if (type === 'none') return [t('vitalVipNone')];
  const expiresAt = member.vitalVipExpiresAt || member.vitalVip?.expiresAt || '';
  const purchasedAt = member.vitalVipPurchasedAt || member.vitalVip?.purchasedAt || '';
  return [
    vitalVipLabel(member, t),
    expiresAt ? `${t('vitalVipExpiresAt')} ${vitalVipMonthDay(expiresAt)}` : '',
    purchasedAt ? `${t('vitalVipPurchasedAt')} ${vitalVipMonthDay(purchasedAt)}` : ''
  ].filter(Boolean);
}

function VitalVipSummary({ member = {}, t }) {
  const type = activeVitalVipType(member);
  const lines = vitalVipLines(member, t);
  return (
    <span className={cx('vital-vip-pill', 'vital-vip-stack', `vip-${type}`)}>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className={index === 0 ? 'vital-vip-title' : 'vital-vip-date'}>
          {line}
        </span>
      ))}
    </span>
  );
}

function rustinityVipLabel(member = {}, t) {
  const type = member.rustinityVipType || member.rustinityVip?.type || 'none';
  if (type === 'queue_skip') return t('vitalVipQueueSkip');
  return t('vitalVipNone');
}

function rustinityVipLines(member = {}, t) {
  const type = member.rustinityVipType || member.rustinityVip?.type || 'none';
  if (type === 'none') return [t('vitalVipNone')];
  const expiresAt = member.rustinityVipExpiresAt || member.rustinityVip?.expiresAt || '';
  const purchasedAt = member.rustinityVipPurchasedAt || member.rustinityVip?.purchasedAt || '';
  return [
    rustinityVipLabel(member, t),
    expiresAt ? `${t('rustinityVipExpiresAt')} ${vitalVipMonthDay(expiresAt)}` : '',
    purchasedAt ? `${t('rustinityVipPurchasedAt')} ${vitalVipMonthDay(purchasedAt)}` : ''
  ].filter(Boolean);
}

function RustinityVipSummary({ member = {}, t }) {
  const type = member.rustinityVipType || member.rustinityVip?.type || 'none';
  const lines = rustinityVipLines(member, t);
  return (
    <span className={cx('vital-vip-pill', 'vital-vip-stack', `vip-${type}`)}>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className={index === 0 ? 'vital-vip-title' : 'vital-vip-date'}>
          {line}
        </span>
      ))}
    </span>
  );
}

function atlasVipLabel(member = {}, t) {
  const type = member.atlasVipType || member.atlasVip?.type || 'none';
  if (type === 'priority') return t('vitalVipPriority');
  if (type === 'queue_skip') return t('vitalVipQueueSkip');
  return t('vitalVipNone');
}

function atlasVipLines(member = {}, t) {
  const type = member.atlasVipType || member.atlasVip?.type || 'none';
  if (type === 'none') return [t('vitalVipNone')];
  const expiresAt = member.atlasVipExpiresAt || member.atlasVip?.expiresAt || '';
  const purchasedAt = member.atlasVipPurchasedAt || member.atlasVip?.purchasedAt || '';
  return [
    atlasVipLabel(member, t),
    expiresAt ? `${t('atlasVipExpiresAt')} ${vitalVipMonthDay(expiresAt)}` : '',
    purchasedAt ? `${t('atlasVipPurchasedAt')} ${vitalVipMonthDay(purchasedAt)}` : ''
  ].filter(Boolean);
}

function AtlasVipSummary({ member = {}, t }) {
  const type = member.atlasVipType || member.atlasVip?.type || 'none';
  const lines = atlasVipLines(member, t);
  return (
    <span className={cx('vital-vip-pill', 'vital-vip-stack', `vip-${type}`)}>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className={index === 0 ? 'vital-vip-title' : 'vital-vip-date'}>
          {line}
        </span>
      ))}
    </span>
  );
}

function serverVipLines(vip = {}, t) {
  const active = vip.active !== false && ['priority', 'queue_skip'].includes(vip.type || 'none');
  if (!active) return [t('vitalVipNone')];
  return [
    vip.type === 'priority' ? t('vitalVipPriority') : t('vitalVipQueueSkip'),
    vip.expiresAt ? `${t('vitalVipExpiresAt')} ${vitalVipMonthDay(vip.expiresAt)}` : '',
    vip.purchasedAt ? `${t('vitalVipPurchasedAt')} ${vitalVipMonthDay(vip.purchasedAt)}` : ''
  ].filter(Boolean);
}

function ServerVipSummary({ participant = {}, t }) {
  const vip = participant.currentServerVip ||
    participant.serverVip ||
    participant.member?.currentServerVip ||
    participant.member?.serverVip ||
    {};
  const active = vip.active !== false && ['priority', 'queue_skip'].includes(vip.type || 'none');
  const type = active ? vip.type : 'none';
  const lines = serverVipLines(vip, t);
  return (
    <span className={cx('vital-vip-pill', 'vital-vip-stack', `vip-${type}`)}>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className={index === 0 ? 'vital-vip-title' : 'vital-vip-date'}>
          {line}
        </span>
      ))}
    </span>
  );
}

function addDaysDate(value, days) {
  const normalized = normalizeVitalVipFormDate(value);
  if (!normalized) return '';
  const time = Date.parse(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(time)) return '';
  return new Date(time + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const VITAL_VIP_DURATION_DAYS = 28;

function updateVitalVipForm(form, patch) {
  const next = { ...form, ...patch };
  if (patch.vitalVipType === 'none') {
    return { ...next, vitalVipPurchasedAt: '', vitalVipExpiresAt: '' };
  }
  if (Object.hasOwn(patch, 'vitalVipPurchasedAt') && !Object.hasOwn(patch, 'vitalVipExpiresAt')) {
    const normalizedPurchasedAt = normalizeVitalVipFormDate(patch.vitalVipPurchasedAt);
    next.vitalVipPurchasedAt = normalizedPurchasedAt || patch.vitalVipPurchasedAt;
    next.vitalVipExpiresAt = normalizedPurchasedAt ? addDaysDate(normalizedPurchasedAt, VITAL_VIP_DURATION_DAYS) : '';
  }
  if (Object.hasOwn(patch, 'vitalVipExpiresAt') && patch.vitalVipExpiresAt && !Object.hasOwn(patch, 'vitalVipPurchasedAt')) {
    const normalizedExpiresAt = normalizeVitalVipFormDate(patch.vitalVipExpiresAt);
    next.vitalVipExpiresAt = normalizedExpiresAt || patch.vitalVipExpiresAt;
    next.vitalVipPurchasedAt = normalizedExpiresAt ? addDaysDate(normalizedExpiresAt, -VITAL_VIP_DURATION_DAYS) : '';
  }
  return next;
}

function updateRustinityVipForm(form, patch) {
  const next = { ...form, ...patch };
  if (patch.rustinityVipType === 'none') {
    return { ...next, rustinityVipPurchasedAt: '', rustinityVipExpiresAt: '' };
  }
  if (Object.hasOwn(patch, 'rustinityVipPurchasedAt') && !Object.hasOwn(patch, 'rustinityVipExpiresAt')) {
    const normalizedPurchasedAt = normalizeVitalVipFormDate(patch.rustinityVipPurchasedAt);
    next.rustinityVipPurchasedAt = normalizedPurchasedAt || patch.rustinityVipPurchasedAt;
    next.rustinityVipExpiresAt = normalizedPurchasedAt ? addDaysDate(normalizedPurchasedAt, VITAL_VIP_DURATION_DAYS) : '';
  }
  if (Object.hasOwn(patch, 'rustinityVipExpiresAt') && patch.rustinityVipExpiresAt && !Object.hasOwn(patch, 'rustinityVipPurchasedAt')) {
    const normalizedExpiresAt = normalizeVitalVipFormDate(patch.rustinityVipExpiresAt);
    next.rustinityVipExpiresAt = normalizedExpiresAt || patch.rustinityVipExpiresAt;
    next.rustinityVipPurchasedAt = normalizedExpiresAt ? addDaysDate(normalizedExpiresAt, -VITAL_VIP_DURATION_DAYS) : '';
  }
  return next;
}

function updateAtlasVipForm(form, patch) {
  const next = { ...form, ...patch };
  if (patch.atlasVipType === 'none') {
    return { ...next, atlasVipPurchasedAt: '', atlasVipExpiresAt: '' };
  }
  if (Object.hasOwn(patch, 'atlasVipPurchasedAt') && !Object.hasOwn(patch, 'atlasVipExpiresAt')) {
    const normalizedPurchasedAt = normalizeVitalVipFormDate(patch.atlasVipPurchasedAt);
    next.atlasVipPurchasedAt = normalizedPurchasedAt || patch.atlasVipPurchasedAt;
    next.atlasVipExpiresAt = normalizedPurchasedAt ? addDaysDate(normalizedPurchasedAt, VITAL_VIP_DURATION_DAYS) : '';
  }
  if (Object.hasOwn(patch, 'atlasVipExpiresAt') && patch.atlasVipExpiresAt && !Object.hasOwn(patch, 'atlasVipPurchasedAt')) {
    const normalizedExpiresAt = normalizeVitalVipFormDate(patch.atlasVipExpiresAt);
    next.atlasVipExpiresAt = normalizedExpiresAt || patch.atlasVipExpiresAt;
    next.atlasVipPurchasedAt = normalizedExpiresAt ? addDaysDate(normalizedExpiresAt, -VITAL_VIP_DURATION_DAYS) : '';
  }
  return next;
}

function vitalVipRequiresPurchaseDate(form = {}) {
  return ['priority', 'queue_skip'].includes(form.vitalVipType || 'none');
}

function vitalVipPurchaseDateValidationError(form = {}, t) {
  if (!vitalVipRequiresPurchaseDate(form)) return '';
  return normalizeVitalVipFormDate(form.vitalVipPurchasedAt) ? '' : t('vitalVipPurchaseDateRequired');
}

function rustinityVipRequiresPurchaseDate(form = {}) {
  return (form.rustinityVipType || 'none') === 'queue_skip';
}

function rustinityVipPurchaseDateValidationError(form = {}, t) {
  if (!rustinityVipRequiresPurchaseDate(form)) return '';
  return normalizeVitalVipFormDate(form.rustinityVipPurchasedAt) ? '' : t('rustinityVipPurchaseDateRequired');
}

function atlasVipRequiresPurchaseDate(form = {}) {
  return ['priority', 'queue_skip'].includes(form.atlasVipType || 'none');
}

function atlasVipPurchaseDateValidationError(form = {}, t) {
  if (!atlasVipRequiresPurchaseDate(form)) return '';
  return normalizeVitalVipFormDate(form.atlasVipPurchasedAt) ? '' : t('atlasVipPurchaseDateRequired');
}

function memberVipPurchaseDateValidationError(form = {}, t) {
  return vitalVipPurchaseDateValidationError(form, t) || rustinityVipPurchaseDateValidationError(form, t) || atlasVipPurchaseDateValidationError(form, t);
}

export {
  AtlasVipSummary,
  RustinityVipSummary,
  ServerVipSummary,
  VitalVipSummary,
  atlasVipRequiresPurchaseDate,
  editableProfileFormFromMember,
  emptyMemberForm,
  memberVipPurchaseDateValidationError,
  rustinityVipRequiresPurchaseDate,
  updateAtlasVipForm,
  updateRustinityVipForm,
  updateVitalVipForm,
  vitalVipMonthDay,
  vitalVipRequiresPurchaseDate
};
