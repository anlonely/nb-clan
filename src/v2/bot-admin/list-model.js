const platforms = new Set(['discord', 'kook']);
const sections = new Set(['features', 'servers', 'open-signups', 'electricians', 'tools', 'activity']);
const filterKeys = {features: ['type', 'search'], servers: ['feature', 'search']};

export const botPlatform = value => platforms.has(value) ? value : '';

export function botSectionPath(section, platform = '') {
  const base = `/admin/bot/${sections.has(section) ? section : 'features'}`;
  return botPlatform(platform) ? `${base}?platform=${platform}` : base;
}

export function botListParams(section, source = '') {
  const sourceParams = new URLSearchParams(source), params = new URLSearchParams();
  const platform = botPlatform(sourceParams.get('platform'));
  if (platform) params.set('platform', platform);
  for (const key of filterKeys[section] || []) if (sourceParams.get(key)) params.set(key, sourceParams.get(key));
  return params;
}

export function botListPath(section, source = '') {
  const params = botListParams(section, source);
  return `/admin/bot/${section}${params.size ? `?${params}` : ''}`;
}

export function botListReturnPath(section, source = '') {
  const params = new URLSearchParams(source), returnTo = params.get('returnTo');
  const base = `/admin/bot/${section}`;
  if (returnTo && returnTo.length <= 4096 && (returnTo === base || returnTo.startsWith(`${base}?`)) && !returnTo.includes('#')) {
    return botListPath(section, returnTo.slice(base.length + 1));
  }
  return botListPath(section, params);
}

export function botDetailPath(section, source, platform, record) {
  const params = botListParams(section, source);
  params.set('platform', botPlatform(platform));
  params.set('returnTo', botListReturnPath(section, source));
  if (section === 'servers') {
    params.set('targetId', record.id);
    return `/admin/bot/servers/${botPlatform(platform)}/${encodeURIComponent(record.guildId || 'new')}?${params}`;
  }
  return `/admin/bot/features/${encodeURIComponent(record.id)}?${params}`;
}

export function canCreateBotConfig(data, section) {
  return data?.canConfigure === true && (data[section === 'features' ? 'commands' : 'targets'] || []).length < 30;
}
