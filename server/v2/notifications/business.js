import { IdentityError } from '../identity/errors.js';
import { need, hash, newId, stamp, identifier, languages } from './shared.js';

const kinds = new Set(['memberReview', 'vipExpiry', 'hexQuery', 'platformCard', 'discordOpenWipe']);

// Absence is the legacy G06 wipe schema. An unrecognized marker never falls back.
export function resourceKind(row) {
  if (row?.resource === undefined) return 'wipe';
  need(kinds.has(row?.resource?.kind) && identifier(row.resource.id) && row.wipeId === null,
    'NOTIFICATION_RESOURCE_INVALID', 503);
  return row.resource.kind;
}
export const resourceFields = row => resourceKind(row) === 'wipe' ? {} : { resource: structuredClone(row.resource), wipeId: null };
export function domainFor(service, row) {
  const kind = resourceKind(row);
  need(kinds.has(kind), 'NOTIFICATION_RESOURCE_INVALID', 503);
  service.repo.requireBusinessSchema(kind);
  const domain = service.businessDomains?.[kind];
  need(domain && ['executionContext', 'visible', 'renderEdit', 'validateInboxReference'].every(k => typeof domain[k] === 'function'),
    'NOTIFICATION_BUSINESS_DOMAIN_REQUIRED', 503);
  return domain;
}
export function registerBusinessDomain(service, kind, domain) {
  need(kinds.has(kind) && !service.businessDomains?.[kind], 'NOTIFICATION_BUSINESS_DOMAIN_CONFLICT', 503);
  service.repo.requireBusinessSchema(kind);
  service.businessDomains = { ...service.businessDomains, [kind]: domain };
  try { domainFor(service, { resource: { kind, id: 'schema-probe' }, wipeId: null }); }
  catch (error) { delete service.businessDomains[kind]; throw error; }
}

/** Trusted, synchronous domain admission. Never exposed as a public POST endpoint. */
export function createBusinessIntent(service, plan) {
  const { repo } = service, resource = plan.resource || { kind: 'memberReview', id: plan.applicationId };
  need(repo.db.isTransaction, 'NOTIFICATION_BUSINESS_TRANSACTION_REQUIRED', 503);
  const probe = { ...plan, resource, wipeId: null };
  const domain = domainFor(service, probe);
  const allowedPurposes = resource.kind === 'discordOpenWipe' ? ['open_wipe.publish'] : resource.kind === 'platformCard' ? ['card.publish'] : resource.kind === 'hexQuery' ? ['hex.query'] : resource.kind === 'vipExpiry' ? ['vip.expiring'] : ['review.pending', 'review.result'];
  const language = resource.kind === 'memberReview' ? 'zh-CN' : plan.language;
  need(allowedPurposes.includes(plan.purpose) && languages.includes(language) && identifier(plan.unitKey) &&
    Number.isSafeInteger(plan.snapshot?.contentRevision) && plan.snapshot.contentRevision > 0 &&
    plan.payload && hash(plan.payload) === plan.payloadHash, 'NOTIFICATION_BUSINESS_INPUT_INVALID', 422);
  // Domain re-reads canonical application, receiver, principal, policy and target before persistence.
  domain.executionContext(probe, { mode: 'send', actorAccountId: plan.createdByAccountId });
  const businessKey = hash({ resource, unitKey: plan.unitKey, purpose: plan.purpose });
  const old = repo.forResource('intents', resource).find(i => i.businessKey === businessKey);
  if (old) return { intentId: old.id, deduplicated: true };
  const createdAt = stamp(service.now), id = newId('intent');
  repo.put('intents', { id, resource, wipeId: null, revision: 1, contentRevision: plan.snapshot.contentRevision,
    purpose: plan.purpose, purposeInstance: plan.unitKey, repeatOfIntentId: null, createdAt,
    createdByAccountId: plan.createdByAccountId, schedule: null, businessKey, targetIds: [plan.target.id],
    previewId: null, event: plan.event });
  const delivery = { id: newId('delivery'), intentId: id, resource, wipeId: null,
    targetId: plan.target.id, targetLabel: plan.target.label, platform: plan.target.platform, language,
    revision: 1, status: 'queued', attemptCount: 0, executionEpoch: 0, nextAttemptAt: null, dueAt: null, expiresAt: null,
    lastErrorCode: null, lastErrorMessage: null, createdAt, updatedAt: createdAt, sentAt: null, cancelRequested: false,
    createdByAccountId: plan.createdByAccountId, previewId: null, target: plan.target, selection: null,
    payload: plan.payload, payloadHash: plan.payloadHash, snapshot: plan.snapshot, binding: plan.binding,
    purpose: plan.purpose, event: plan.event, actionReferenceIds: [], knownNotSent: true,
    leaseOwner: null, leaseUntil: null, currentAttemptId: null };
  repo.put('deliveries', delivery);
  repo.appendChange({ resource, wipeId: null, intentId: id, deliveryId: delivery.id, targetId: delivery.targetId,
    type: 'delivery.queued', createdAt });
  return { intentId: id, deliveryId: delivery.id, deduplicated: false };
}

export function businessVisible(service, actor, row) {
  try { return domainFor(service, row).visible(actor, row) === true; }
  catch (error) { if (error instanceof IdentityError) return false; throw error; }
}
