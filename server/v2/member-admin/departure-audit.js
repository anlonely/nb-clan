import { requireValue } from './repository.js';
import { statusOf } from './model.js';
import { reconcileMemberRoleDeparture } from '../identity/departure-lock.js';

const COLLECTION = 'v2CommunityRoleAudits';
const PROVIDERS = ['discord', 'kook'];
const FLAGGED = ['missing_role', 'not_in_guild'];

function activePolicies(identity) {
  return new Map(identity.repo.all('policies')
    .filter(policy => PROVIDERS.includes(policy.provider) && policy.enabled && policy.guildId && policy.allowedRoleIds?.length)
    .map(policy => [policy.provider, policy]));
}

function linkedIdentities(identity, memberId) {
  const account = identity.repo.all('accounts').find(row => row.memberId === memberId);
  if (!account) return [];
  return identity.repo.all('identities').filter(row => row.accountId === account.id && PROVIDERS.includes(row.provider) && row.externalId);
}

function sameContext(audit, policy, link) {
  return audit?.provider === link.provider && audit.externalId === link.externalId &&
    audit.guildId === policy.guildId && audit.policyRevision === policy.policyRevision &&
    audit.matchMode === policy.matchMode && JSON.stringify(audit.expectedRoleIds) === JSON.stringify(policy.allowedRoleIds);
}

export function currentDepartureAudits(identity, repo, memberId) {
  const policies = activePolicies(identity);
  const audits = repo.find(COLLECTION, 'memberId', memberId, 10);
  return linkedIdentities(identity, memberId).flatMap(link => {
    const policy = policies.get(link.provider);
    if (!policy) return [];
    const audit = audits.find(row => sameContext(row, policy, link));
    return audit ? [audit] : [];
  });
}

export function departureCandidatePredicate(status) {
  const statuses = status ? [status] : FLAGGED;
  return `EXISTS (
    SELECT 1 FROM json_records audit
    JOIN json_records policy ON policy.collection='v2EligibilityPolicies'
      AND json_extract(policy.payload_json,'$.provider')=json_extract(audit.payload_json,'$.provider')
      AND json_extract(policy.payload_json,'$.enabled')=1
      AND json_extract(policy.payload_json,'$.guildId')=json_extract(audit.payload_json,'$.guildId')
      AND json_extract(policy.payload_json,'$.policyRevision')=json_extract(audit.payload_json,'$.policyRevision')
      AND json_extract(policy.payload_json,'$.matchMode')=json_extract(audit.payload_json,'$.matchMode')
      AND json_extract(policy.payload_json,'$.allowedRoleIds')=json_extract(audit.payload_json,'$.expectedRoleIds')
    JOIN json_records account ON account.collection='v2Accounts'
      AND json_extract(account.payload_json,'$.memberId')=r.id
    JOIN json_records identity ON identity.collection='v2Identities'
      AND json_extract(identity.payload_json,'$.accountId')=account.id
      AND json_extract(identity.payload_json,'$.provider')=json_extract(audit.payload_json,'$.provider')
      AND json_extract(identity.payload_json,'$.externalId')=json_extract(audit.payload_json,'$.externalId')
    WHERE audit.collection='${COLLECTION}'
      AND json_extract(audit.payload_json,'$.memberId')=r.id
      AND json_extract(audit.payload_json,'$.status') IN (${statuses.map(value => `'${value}'`).join(',')})
  )`;
}

function recordId(memberId, provider) { return `${memberId}:${provider}`; }

async function checkRole(identity, repo, memberId, link, policy, now, preflightError) {
  let status = 'check_failed', actualRoleIds = [], error = '';
  try {
    if (preflightError) throw Object.assign(new Error(preflightError), { errorCode: preflightError });
    const result = await identity.providers?.[link.provider]?.roles(link.externalId, policy.guildId);
    requireValue(result?.externalId === link.externalId && result.guildId === policy.guildId &&
      Array.isArray(result.roleIds) && result.roleIds.length <= 500 &&
      result.roleIds.every(value => typeof value === 'string'), 'ELIGIBILITY_UNAVAILABLE', 503);
    actualRoleIds = [...new Set(result.roleIds)];
    const actual = new Set(actualRoleIds);
    const matched = policy.matchMode === 'all'
      ? policy.allowedRoleIds.every(role => actual.has(role))
      : policy.allowedRoleIds.some(role => actual.has(role));
    status = matched ? 'valid' : 'missing_role';
  } catch (cause) {
    status = cause?.errorCode === 'ELIGIBILITY_DENIED' ? 'not_in_guild' : 'check_failed';
    error = status === 'check_failed' ? cause?.errorCode || 'ELIGIBILITY_UNAVAILABLE' : '';
  }
  const checkedAt = new Date(now()).toISOString();
  return identity.repo.transaction(() => {
    const currentPolicy = activePolicies(identity).get(link.provider);
    const currentLink = linkedIdentities(identity, memberId).find(row => row.provider === link.provider);
    const member = repo.get('members', memberId);
    // A changed identity or admission policy cannot turn an old observation into a new candidate.
    if (!currentPolicy || currentPolicy.guildId !== policy.guildId ||
      currentPolicy.policyRevision !== policy.policyRevision || currentPolicy.matchMode !== policy.matchMode ||
      JSON.stringify(currentPolicy.allowedRoleIds) !== JSON.stringify(policy.allowedRoleIds) ||
      currentLink?.externalId !== link.externalId ||
      member?.deletedAt || !member || statusOf(member) !== 'active') return null;
    const record = { id: recordId(memberId, link.provider), memberId, provider: link.provider,
      externalId: link.externalId, guildId: policy.guildId, policyRevision: policy.policyRevision,
      matchMode: policy.matchMode, expectedRoleIds: [...policy.allowedRoleIds], actualRoleIds, status, error, checkedAt };
    repo.put(COLLECTION, record);
    reconcileMemberRoleDeparture(identity, memberId);
    return record;
  });
}

export async function scanDepartureRoles(service, actor, input = {}) {
  actor = service.fresh(actor);
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_DATA');
  const read = service.repo.scope(actor, 'members.read');
  const change = service.repo.scope(actor, 'members.change_status');
  const review = service.repo.scope(actor, 'members.review');
  const page = service.page(actor, 'departure-scan', { limit: 4, cursor: input.cursor }, 'members', {
    text: `${read.text} AND (${change.text} OR ${review.text}) AND COALESCE(json_extract(r.payload_json,'$.deletedAt'),'')='' AND COALESCE(json_extract(r.payload_json,'$.memberStatus'),CASE json_extract(r.payload_json,'$.membershipStatus') WHEN 'paused' THEN 'suspended' WHEN 'departed' THEN 'left' ELSE 'active' END)='active' AND EXISTS (
      SELECT 1 FROM json_records account
      JOIN json_records identity ON identity.collection='v2Identities' AND json_extract(identity.payload_json,'$.accountId')=account.id
      JOIN json_records policy ON policy.collection='v2EligibilityPolicies' AND json_extract(policy.payload_json,'$.provider')=json_extract(identity.payload_json,'$.provider')
      WHERE account.collection='v2Accounts' AND json_extract(account.payload_json,'$.memberId')=r.id
        AND json_extract(policy.payload_json,'$.enabled')=1 AND COALESCE(json_extract(policy.payload_json,'$.guildId'),'')<>''
        AND json_array_length(policy.payload_json,'$.allowedRoleIds')>0
    )`,
    args: [...read.args, ...change.args, ...review.args]
  }, row => ({ id: row.id }));
  const policies = activePolicies(service.identity);
  const rows = [];
  for (const member of page.items) for (const link of linkedIdentities(service.identity, member.id)) {
    const policy = policies.get(link.provider);
    if (policy) rows.push({ memberId: member.id, link, policy });
  }
  const preflight = new Map();
  await Promise.all([...new Set(rows.map(row => row.link.provider))].map(async provider => {
    const policy = policies.get(provider);
    let error = '';
    try {
      const roles = await service.identity.providers?.[provider]?.admissionRoles(policy.guildId);
      requireValue(Array.isArray(roles) && policy.allowedRoleIds.every(role => roles.includes(role)), 'ADMISSION_ROLE_CONFIG_INVALID', 503);
    } catch (cause) {
      error = cause?.errorCode === 'ADMISSION_ROLE_CONFIG_INVALID' ? cause.errorCode : 'ELIGIBILITY_UNAVAILABLE';
    }
    preflight.set(provider, error);
  }));
  const observations = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    observations.push(...await Promise.all(rows.slice(offset, offset + 4)
      .map(row => checkRole(service.identity, service.repo, row.memberId, row.link, row.policy, service.now,
        preflight.get(row.link.provider)))));
  }
  const completed = observations.filter(Boolean);
  return { scannedMembers: page.items.length, checkedBindings: completed.length,
    flagged: completed.filter(row => FLAGGED.includes(row.status)).length,
    failed: completed.filter(row => row.status === 'check_failed').length,
    skipped: observations.length - completed.length, nextCursor: page.nextCursor };
}
