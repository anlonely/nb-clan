import {hash,need} from './model.js';
/** One explicitly selected current target + reviewed immutable migration archive.
 * Live legacy settings.discord is deliberately not a configuration input. */
export function readCanonicalDiscord(identity,platform,selection,{enabled,credentialReaderBound}){
  need(platform?.identity===identity&&platform.repo?.db===identity.repo.db,'CANONICAL_PLATFORM_OWNER_MISMATCH');
  const config=platform.config('discord'),archive=platform.repo.get('legacy-archive','discord');
  const archiveDigest=archive?hash(archive):null;
  const fail=reason=>({ready:false,reason,source:{kind:'platform_admin_records.legacy-archive',digest:archiveDigest,editableInCurrentUi:false},settings:{guildId:'',revision:config.revision||0,memberRegisterRoleSquadRules:[]}});
  if(!enabled)return fail('DISCORD_CAPABILITY_DISABLED');
  if(!credentialReaderBound)return fail('TRUSTED_CREDENTIAL_ADAPTER_REQUIRED');
  if(!selection)return fail('DISCORD_TARGET_SELECTION_REQUIRED');
  if(!config.enabled)return fail('DISCORD_PLATFORM_DISABLED');
  const matches=(config.targets||[]).filter(t=>t.id===selection.targetId);if(matches.length!==1)return fail('DISCORD_TARGET_MISSING');
  const target=matches[0];if(target.enabled!==true)return fail('DISCORD_TARGET_DISABLED');
  if(config.revision!==selection.configurationRevision)return fail('DISCORD_PLATFORM_REVISION_CHANGED');
  if(!/^\d{17,20}$/.test(target.guildId))return fail('DISCORD_GUILD_REQUIRED');
  if(!archive||archiveDigest!==selection.legacyRulesDigest)return fail('DISCORD_MIGRATED_RULES_REVIEW_REQUIRED');
  const rows=archive.targetRules?.filter(r=>r.targetId===target.id)||[];
  if(rows.length!==1)return fail('DISCORD_MIGRATED_TARGET_RULES_REQUIRED');
  const row=rows[0],rules=row.memberRegisterRoleSquadRules||[];
  need(Array.isArray(rules)&&rules.length<=500,'CANONICAL_DISCORD_RULE_LIMIT');
  if(!rules.some(r=>/^\d{17,20}$/.test(r.roleId)&&r.squadId)&&!/^\d{17,20}$/.test(row.memberRegisterRoleId||''))return fail('DISCORD_ROLE_RULES_REQUIRED');
  const binding=hash({target,revision:config.revision,archiveDigest,selection});
  return {ready:true,reason:null,source:{kind:'platform_admin_records.legacy-archive',digest:archiveDigest,editableInCurrentUi:false},
    // Existing source-host fingerprints updatedAt; bind the complete target and archive there.
    settings:{guildId:target.guildId,revision:config.revision,updatedAt:binding,
      memberRegisterRoleId:row.memberRegisterRoleId||'',memberRegisterRoleSquadRules:structuredClone(rules)}};
}
