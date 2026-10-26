import { requireValue } from '../identity/errors.js';

// Only the original native-verifier object carries authority. JSON and copied
// objects cannot substitute a Discord principal or cross callback domains.
const proofs = new WeakSet();
export function markSteamLinksProof(proof) {
  requireValue(proof && typeof proof === 'object' && proof.provider === 'discord' && proof.payload?.kind === 'steam_links', 'PLATFORM_AUTH_INVALID', 401);
  proofs.add(proof);
  return proof;
}
export const isSteamLinksProof = proof => Boolean(proof && proofs.has(proof));
export function assertSteamLinksProof(proof) {
  requireValue(isSteamLinksProof(proof) && proof.provider === 'discord' && proof.payload?.kind === 'steam_links', 'PLATFORM_AUTH_INVALID', 401);
  return proof;
}
