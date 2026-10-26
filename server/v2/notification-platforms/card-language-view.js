import { requireValue } from '../identity/errors.js';
import { interactionText } from './interaction-language.js';

const nativeProofs = new WeakSet();
export function discordCardViewInput(event) {
  const customId = event.data?.custom_id;
  if (typeof customId !== 'string' || !customId.startsWith('nblang:')) return null;
  requireValue(event.type === 3 && event.data.component_type === 2 && typeof event.message?.id === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(event.message.id), 'PLATFORM_PAYLOAD_INVALID', 422);
  let match = /^nblang:signup:([A-Za-z0-9_-]{43})$/.exec(customId);
  if (match) return { kind: 'card_view', cardKind: 'signup', reference: match[1] };
  match = /^nblang:card:([a-f0-9]{64})$/.exec(customId);
  requireValue(match, 'PLATFORM_PAYLOAD_INVALID', 422);
  return { kind: 'card_view', cardKind: 'card', reference: match[1] };
}
export function markCardViewProof(proof) { nativeProofs.add(proof); return proof; }
export function assertCardViewProof(proof) {
  requireValue(nativeProofs.has(proof) && proof.provider === 'discord' && proof.payload?.kind === 'card_view' && proof.originMessageId, 'PLATFORM_AUTH_INVALID', 401);
  return proof;
}
export function withCardLanguageButton(payload, cardId, language = 'en') {
  requireValue(/^[a-f0-9]{64}$/.test(cardId), 'PLATFORM_PAYLOAD_INVALID', 422);
  const result = structuredClone(payload);
  const button = { type: 2, style: 2, label: interactionText('discord', { locale: language }, 'viewLanguage'), custom_id: `nblang:card:${cardId}`, emoji: { name: '🌐' } };
  result.components ||= [];
  const last = result.components.at(-1);
  if (last?.type === 1 && last.components.length < 5) last.components.push(button);
  else { requireValue(result.components.length < 5, 'PLATFORM_PAYLOAD_INVALID', 422); result.components.push({ type: 1, components: [button] }); }
  return result;
}
