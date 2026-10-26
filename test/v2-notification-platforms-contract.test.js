import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../server/v2/notification-platforms/index.js';
import { createIsolatedNotificationTransport } from '../server/v2/notification-platforms/isolated-transport.js';
import { hashPayload } from '../server/v2/notification-platforms/canonical.js';
import { callbackFixture } from './support/v2-notification-platforms/fixture.mjs';
import { nativeEnvelopes } from './support/v2-notification-platforms/native-envelopes.mjs';

function renderInput(f,platform,mode='send',purpose='signup_open') {
  const s=f.scheduling.summary(f.operator,f.wipe.id),w=s.wipe;
  return {schemaVersion:1,templateId:'wipe-notification',templateRevision:1,purpose,mode,
    target:{id:`local-${platform}`,platform,guildId:'100000000000000001',channelId:'300000000000000001',enabled:true,
      languages:['zh-CN'],roleOptions:[],capabilities:{preview:true,send:true,mentionRoles:false,mentionEveryone:true},
      configurationRevision:1,runtimeMode:'isolated',transportKey:`fixture:${platform}`},
    selection:{targetId:`local-${platform}`,language:'zh-CN',mentionMode:'none',roleIds:[]},
    snapshot:{wipeId:w.id,title:w.title,description:w.description,serverLabel:w.serverSnapshot.name,musterAt:w.musterAt,
      signupClosesAt:w.signupClosesAt,serverScheduledWipeAt:w.serverScheduledWipeAt,timeZone:w.timeZone,lifecycle:w.lifecycle,
      effectiveSignupWindow:w.effectiveSignupWindow,contentRevision:w.contentRevision,rosterRevision:s.rosterRevision,
      counts:s.counts,teamCounts:{CN:{onTime:0,later:0,notAttending:0},EU:{onTime:0,later:0,notAttending:0}},countScope:s.countScope,evaluatedAt:s.evaluatedAt,memberUrl:`http://127.0.0.1:4316/app/wipes/${w.id}?tab=plan#signup`},
    actionRefs:[...(platform==='discord'
      ? ['attending_on_time','attending_later','join_8h','join_16h','not_attending','copy_connect']
      : ['attending_on_time','attending_later','not_attending','withdraw'])]
      .map((action,i)=>({action,token:({attending_on_time:'on-time',attending_later:'late',not_attending:'absent',withdraw:'withdraw'})[action]||`public-ref-${i}`}))};
}
const context=key=>({attemptId:`attempt-${key}`,executionEpoch:1,operationKey:`op-${key}`,signal:new AbortController().signal,timeoutMs:1000});

test('frozen public index exports exactly the four contracted factories/functions',()=>{
  assert.deepEqual(Object.keys(api).sort(),['createNotificationCallbackHandler','createNotificationPlatforms','listNotificationTemplates','renderNotification']);
});

for(const platform of ['discord','kook']) {
  test(`${platform}: common renderer preview -> native store -> verified signup -> same-id update -> terminal card`,async t=>{
    const f=await callbackFixture(t),native=nativeEnvelopes({now:()=>f.state.now});
    const transport=createIsolatedNotificationTransport({now:()=>f.state.now});
    const adapters=api.createNotificationPlatforms({transport,now:()=>f.state.now});
    const input=renderInput(f,platform),preview=api.renderNotification(input);
    const sent=await adapters[platform].send({...preview,target:input.target,context:context('send')});
    assert.equal(sent.outcome,'sent');assert.equal(hashPayload(transport.getMessages()[0].payload),preview.payloadHash);
    const buttons=platform==='discord'?preview.payload.components[0].components:JSON.parse(preview.payload.content)[0].modules.find(m=>m.type==='action-group').elements;
    const reference=platform==='discord'?buttons[0].custom_id:buttons[0].value;
    const handler=api.createNotificationCallbackHandler({platform,identity:f.identity,scheduling:f.scheduling,
      verify:native.verifiers[platform],resolveActionReference:f.resolveReference,transport,publicOrigin:'http://127.0.0.1:4316',now:()=>f.state.now});
    await handler(native[platform](reference),f.io);
    assert.equal(f.signup().signupRevision,1);
    const editInput=renderInput(f,platform,'edit');editInput.selection.mentionMode='everyone';
    const updated=api.renderNotification(editInput);
    assert.equal(editInput.snapshot.counts.confirmedAttending,1);
    assert.equal((await adapters[platform].edit({...updated,target:input.target,messageRef:sent.messageRef,context:context('edit')})).outcome,'updated');
    let messages=transport.getMessages();assert.equal(messages.length,1);assert.equal(messages[0].messageId,sent.messageRef.messageId);
    assert.equal(hashPayload(messages[0].payload),updated.payloadHash);
    if(platform==='discord')assert.deepEqual(messages[0].payload.allowed_mentions.parse,[]);
    else assert.equal(messages[0].payload.content.includes('(met)'),false);
    const wipe=f.scheduling.wipe(f.wipe.id);
    f.scheduling.transition(f.operator,f.wipe.id,'cancel',{expectedRevision:wipe.revision,reason:'constructed closure'},{operationId:'closure'});
    const terminal=api.renderNotification(renderInput(f,platform,'edit','cancelled'));
    assert.ok(terminal.rendered.actions.every(a=>a.url));
    await adapters[platform].edit({...terminal,target:input.target,messageRef:sent.messageRef,context:context('terminal')});
    messages=transport.getMessages();assert.equal(messages.length,1);assert.equal(messages[0].editCount,2);
    assert.equal(transport.getCalls().filter(c=>c.operation==='send').length,1);
    const privateOutput=transport.getPrivateReplies();assert.ok(privateOutput.length>=1);
    assert.equal(JSON.stringify(transport.inspect()).includes('interactionToken'),false);
    assert.equal(JSON.stringify(transport.inspect()).includes('nbconfirm:'),false);
  });
}
