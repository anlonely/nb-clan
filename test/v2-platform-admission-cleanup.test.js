import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installIdentitySchema,IdentityRepository} from '../server/v2/identity/repository.js';
import {installPlatformAdminSchema} from '../server/v2/platform-admin/repository.js';
import {PlatformAdminService} from '../server/v2/platform-admin/service.js';
import {normalizeConfig,WECHAT_SUBSCRIPTION_TEMPLATE_KEYS} from '../server/v2/platform-admin/model.js';
import {TEMPLATE_KEYS} from '../server/v2/member-inbox/service.js';

test('saved registration fields are retired without changing admission policy or active server features',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());installIdentitySchema(db);installPlatformAdminSchema(db);
 const repo=new IdentityRepository(db),service=new PlatformAdminService({identity:{repo}});
 const policy={id:'discord',provider:'discord',guildId:'guild',allowedRoleIds:['member-role'],matchMode:'any',enabled:true,policyRevision:3};repo.put('policies',policy);
 for(const platform of ['discord','kook']){
  const original={id:platform,revision:2,enabled:true,targets:[{id:'server',guildId:'guild',channelId:'general',memberRegisterChannelId:'apply',memberReviewChannelId:'review',memberManageRoleId:'reviewer',enabledCommandIds:['kda','member','kookMember','map']}],commands:[{id:'member',type:'persistent_card'},{id:'map',type:'persistent_card',titleTemplate:'Map'}]};
  service.repo.put('config',platform,platform,'',Date.now(),original);
  const current=service.config(platform);assert.deepEqual(current.targets,[{id:'server',guildId:'guild',channelId:'general',enabledCommandIds:['kda','map']}]);assert.deepEqual(current.commands,[original.commands[1]]);
  const {id,revision,...input}=original;assert.deepEqual(normalizeConfig(platform,input).targets,current.targets);
  assert.deepEqual(service.repo.get('config',platform),original);assert.deepEqual(repo.get('policies','discord'),policy);
 }
});

test('WeChat retains event notifications while retired review templates disappear from configuration and subscriptions',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());installIdentitySchema(db);installPlatformAdminSchema(db);
 const service=new PlatformAdminService({identity:{repo:new IdentityRepository(db)}});
 const original={id:'wechat',revision:4,subscriptionTemplates:{joinReviewResult:'old-result',adminJoinReview:'old-admin',wipeOpen:'keep-open',wipeReminder:'keep-reminder'}};
 service.repo.put('config','wechat','wechat','',Date.now(),original);
 assert.deepEqual(service.config('wechat').subscriptionTemplates,{wipeOpen:'keep-open',wipeReminder:'keep-reminder'});
 assert.deepEqual(WECHAT_SUBSCRIPTION_TEMPLATE_KEYS,TEMPLATE_KEYS);assert.equal(TEMPLATE_KEYS.includes('joinReviewResult'),false);
 assert.equal(normalizeConfig('wechat',{subscriptionTemplates:original.subscriptionTemplates}).subscriptionTemplates.wipeOpen,'keep-open');
 assert.throws(()=>normalizeConfig('wechat',{subscriptionTemplates:{unknown:'bad'}}));
});
