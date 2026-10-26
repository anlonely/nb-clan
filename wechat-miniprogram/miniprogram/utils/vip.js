const { formatUtc8Date, todayUtc8Date } = require('./time');

const VIP_TYPE_TEXT = {
  none: '无',
  priority: '优先队列',
  queue_skip: '免排队'
};

const VIP_PROVIDERS = [
  {
    key: 'vital',
    label: 'Vital VIP',
    types: ['none', 'priority', 'queue_skip'],
    fields: {
      object: 'vitalVip',
      type: 'vitalVipType',
      purchasedAt: 'vitalVipPurchasedAt',
      expiresAt: 'vitalVipExpiresAt'
    }
  },
  {
    key: 'rustinity',
    label: 'Rustinity VIP',
    types: ['none', 'queue_skip'],
    fields: {
      object: 'rustinityVip',
      type: 'rustinityVipType',
      purchasedAt: 'rustinityVipPurchasedAt',
      expiresAt: 'rustinityVipExpiresAt'
    }
  },
  {
    key: 'atlas',
    label: 'Atlas VIP',
    types: ['none', 'priority', 'queue_skip'],
    fields: {
      object: 'atlasVip',
      type: 'atlasVipType',
      purchasedAt: 'atlasVipPurchasedAt',
      expiresAt: 'atlasVipExpiresAt'
    }
  }
];

const VIP_PROVIDER_BY_KEY = Object.fromEntries(VIP_PROVIDERS.map((provider) => [provider.key, provider]));

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

function normalizeVipDate(value) {
  return formatUtc8Date(value);
}

function isExpiredVipDate(value) {
  const date = normalizeVipDate(value);
  return Boolean(date && date < todayUtc8Date());
}

function vipTypeText(type) {
  return VIP_TYPE_TEXT[type] || type || '无';
}

function directVipObject(source = {}) {
  return hasOwn(source, 'type') ? source : null;
}

function vipProviderConfig(key = 'vital') {
  return VIP_PROVIDER_BY_KEY[key] || VIP_PROVIDER_BY_KEY.vital;
}

function vipTypeOptions(providerOrKey = 'vital') {
  const provider = typeof providerOrKey === 'string' ? vipProviderConfig(providerOrKey) : providerOrKey;
  return (provider.types || VIP_PROVIDER_BY_KEY.vital.types).map((value) => ({
    value,
    label: vipTypeText(value)
  }));
}

function pickProviderVipSource(source = {}, providerKey = 'vital') {
  const provider = vipProviderConfig(providerKey);
  const fields = provider.fields;
  const vip = source[fields.object] || directVipObject(source) || {};
  return {
    provider,
    vip,
    type: source[fields.type] || vip.type || 'none',
    purchasedAt: source[fields.purchasedAt] || vip.purchasedAt || '',
    expiresAt: source[fields.expiresAt] || vip.expiresAt || '',
    hasExpiresAt: hasOwn(source, fields.expiresAt) || hasOwn(vip, 'expiresAt')
  };
}

function pickVipSource(source = {}, mode = 'vital') {
  if (mode === 'currentServer') {
    const vip = source.currentServerVip
      || source.serverVip
      || source.myServerVip
      || directVipObject(source)
      || source.vitalVip
      || {};
    return {
      vip,
      type: source.currentServerVipType || source.serverVipType || vip.type || source.vitalVipType || 'none',
      purchasedAt: source.currentServerVipPurchasedAt || source.serverVipPurchasedAt || vip.purchasedAt || source.vitalVipPurchasedAt || '',
      expiresAt: source.currentServerVipExpiresAt || source.serverVipExpiresAt || vip.expiresAt || source.vitalVipExpiresAt || '',
      hasExpiresAt: hasOwn(source, 'currentServerVipExpiresAt') ||
        hasOwn(source, 'serverVipExpiresAt') ||
        hasOwn(vip, 'expiresAt') ||
        hasOwn(source, 'vitalVipExpiresAt')
    };
  }

  return pickProviderVipSource(source, mode);
}

function isActiveVip(vip = {}) {
  return vip.active === true && vip.expired !== true;
}

function vipState(source = {}, options = {}) {
  const { mode = 'vital' } = options;
  const picked = pickVipSource(source, mode);
  const type = picked.type || 'none';
  const purchasedAt = normalizeVipDate(picked.purchasedAt);
  const expiresAt = normalizeVipDate(picked.expiresAt);
  const expired = type !== 'none' && (picked.vip.expired === true || isExpiredVipDate(expiresAt));
  const active = type !== 'none' && isActiveVip(picked.vip) && !expired;
  const visible = active;
  const label = active ? vipTypeText(type) : '';
  const activeExpiryText = expiresAt
    ? `到期 ${expiresAt}`
    : (picked.hasExpiresAt ? '到期未更新' : '');
  const text = active
    ? [vipTypeText(type), activeExpiryText].filter(Boolean).join(' · ')
    : '';
  return {
    type,
    label,
    text,
    summary: text,
    expiresText: active ? activeExpiryText : '',
    expiresAt,
    purchasedAt,
    active,
    visible,
    expired,
    className: active ? (type === 'queue_skip' ? 'queue-skip' : (type === 'priority' ? 'priority' : 'none')) : 'none',
    badgeText: active ? (type === 'queue_skip' ? '免' : (type === 'priority' ? '优' : '')) : '',
    valueClass: ''
  };
}

module.exports = {
  VIP_PROVIDERS,
  VIP_PROVIDER_BY_KEY,
  VIP_TYPE_TEXT,
  isActiveVip,
  isExpiredVipDate,
  normalizeVipDate,
  vipProviderConfig,
  vipState,
  vipTypeOptions,
  vipTypeText
};
