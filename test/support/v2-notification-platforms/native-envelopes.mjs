import { generateKeyPairSync, randomBytes, sign, createCipheriv } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createDiscordVerifier, createKookVerifier } from '../../../server/v2/notification-platforms/verifiers.js';

// Ephemeral signing credentials generated per test/run, never loaded from env or
// persisted into evidence. These helpers produce the documented wire envelopes.
export function nativeEnvelopes({now}) {
  const keys=generateKeyPairSync('ed25519');
  const publicKey=keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  const verifyToken=randomBytes(24).toString('base64url'),encryptKey=randomBytes(24).toString('base64url');
  const applicationId='400000000000000001';
  const verifiers={discord:createDiscordVerifier({publicKey,applicationId,now}),
    kook:createKookVerifier({verifyToken,encryptKey,now})};
  let eventNumber=0;
  function discord(value,{interactionId=`${500000000000000000n+BigInt(++eventNumber)}`,externalId='200000000000000001',...extra}={}) {
    const event={id:interactionId,application_id:applicationId,type:3,token:randomBytes(24).toString('base64url'),
      guild_id:'100000000000000001',channel_id:'300000000000000001',member:{user:{id:externalId}},
      data:{component_type:2,custom_id:value},...extra};
    const rawBody=Buffer.from(JSON.stringify(event)),timestamp=String(Math.floor(now()/1000));
    return {rawBody,headers:{'x-signature-timestamp':timestamp,
      'x-signature-ed25519':sign(null,Buffer.concat([Buffer.from(timestamp),rawBody]),keys.privateKey).toString('hex')},
    receivedAt:new Date(now()).toISOString()};
  }
  function kook(value,{interactionId=`event-${++eventNumber}`,externalId='200000000000000001',...extra}={}) {
    const event={s:0,sn:eventNumber,d:{type:255,channel_type:'PERSON',target_id:'not-a-guild',msg_id:interactionId,
      msg_timestamp:now(),verify_token:verifyToken,extra:{type:'message_btn_click',body:{user_id:externalId,
        target_id:'300000000000000001',msg_id:'same-public-card',value}},...extra}};
    const iv=randomBytes(16),cipher=createCipheriv('aes-256-cbc',Buffer.from(encryptKey),iv);
    const encrypted=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(event))),cipher.final()]);
    const encrypt=Buffer.concat([iv,Buffer.from(encrypted.toString('base64'))]).toString('base64');
    return {rawBody:deflateSync(Buffer.from(JSON.stringify({encrypt}))),headers:{'content-encoding':'deflate'},
      receivedAt:new Date(now()).toISOString()};
  }
  return {verifiers,discord,kook};
}
