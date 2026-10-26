export const SECTION_FIELDS = Object.freeze({
  connection: ['enabled', 'applicationId', 'publicKey'],
  identity: ['roleSpecialtyMappings', 'roleSquadMappings', 'roleSystemMappings'],
  features: ['commands'], servers: ['targets'], automation: ['autoWipeCards']
});
export function sectionSaveBody(draft, section) {
  if (!SECTION_FIELDS[section]) throw new Error('Unknown configuration section');
  return {expectedRevision: draft.revision, configSection: section, config: Object.fromEntries(
    SECTION_FIELDS[section].filter(key => draft[key] !== undefined).map(key => [key, draft[key]])
  )};
}
export function legacyBotDestination(platform, hash = '', search = '') {
  if (platform === 'electricians') return '/admin/bot/electricians';
  if (!['discord', 'kook'].includes(platform)) return null;
  const section = {'#server-commands': 'features', '#server-servers': 'servers', '#server-tools': 'tools'}[hash];
  if (!section) return null;
  const params = new URLSearchParams(search);
  params.set('platform', platform);
  return `/admin/bot/${section}?${params}`;
}
export function cardTypeForFeature(feature) {
  return ({server_connect_card: 'server_connect', electrician_ids_card: 'electrician_ids', welcome_guide_card: 'welcome_guide', ranking: 'ranking', kookRanking: 'ranking', map: 'map', wipe: 'wipe_notice'})[feature] || 'custom';
}
export async function deliveryTargetId(platform, targetId, cardType) {
  const prefix = {server_connect: 'server_connect', electrician_ids: 'electrician', welcome_guide: 'welcome_guide'}[cardType];
  if (!prefix) return targetId;
  const bytes = new TextEncoder().encode(`${platform}:${targetId}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `${prefix}_${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
}
export async function runtimeActionBody({action, platform, input, target, revision}) {
  const body = {expectedRevision: revision};
  if (action?.startsWith('card_') || ['metadata', 'register_commands'].includes(action)) {
    if (!target) throw new Error('TARGET_REQUIRED');
    body.targetId = target.id;
  }
  if (action?.startsWith('card_')) {
    Object.assign(body, {cardType: input.cardType || 'ranking', language: platform === 'discord' ? 'en' : 'zh-CN', mentionMode: 'none'});
    body.targetId = await deliveryTargetId(platform, target.id, body.cardType);
    if (body.cardType === 'custom') body.commandId = input.commandId;
    if (body.cardType === 'wipe_notice') body.signupTargetId = target.id;
    if (['ranking', 'map', 'server_connect', 'wipe_notice'].includes(body.cardType)) body.wipeId = input.wipeId;
    if (input.sourceId) body.sourceId = input.sourceId;
    if (action !== 'card_preview') Object.assign(body, {previewId: input.previewId, contentHash: input.contentHash});
  } else if (action === 'register_commands') {
    const ids = String(input.commandIds || '').split(',').map(value => value.trim()).filter(Boolean);
    if (ids.length) body.commandIds = [...new Set(ids)];
  } else if (action === 'metadata') Object.assign(body, {kind: input.kind || 'channels', page: 1, ...(platform === 'kook' && (input.kind || 'channels') === 'channels' ? {channelType: 1} : {})});
  else for (const key of action === 'query' ? ['steamId', 'sourceId', 'serverId', 'providerWipeId'] : ['wipeId', 'sourceId']) if (input[key]?.trim()) body[key] = input[key].trim();
  if (action === 'query') body.sourceId = input.sourceId || 'official';
  else if (action === 'ranking' || body.cardType === 'ranking') body.sourceId = input.sourceId || 'vital';
  return body;
}
