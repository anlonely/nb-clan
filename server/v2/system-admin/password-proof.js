import {scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {need} from './model.js';
import {AREAS,allowed} from './access.js';
/** Root-owned G03 password route consumes this proof inside its final transaction.
 * A raw account id or a previously verified password is not enough after reset/revocation.
 * This adapter never exposes proofs, password hashes or passwords to the browser. */
export function createSystemPasswordProofAdapter(identity,{now=Date.now}={}) {
 const proofs=new WeakMap();
 return {
  async authenticate(username,password){
   need(typeof username==='string' && username.length<=32 && typeof password==='string' && password.length<=128,'AUTH_INVALID_CREDENTIALS',401);
   const repo=identity.repo,u=repo.all('users').find(u=>u.username?.toLowerCase()===username.toLowerCase());
   const [scheme,salt,hash]=String(u?.passwordHash||'').split('$');need(scheme==='scrypt'&&salt&&hash,'AUTH_INVALID_CREDENTIALS',401);
   const actual=await promisify(scrypt)(password,salt,64),expected=Buffer.from(hash,'hex');need(actual.length===expected.length&&timingSafeEqual(actual,expected),'AUTH_INVALID_CREDENTIALS',401);
   const account=repo.all('accounts').find(a=>a.legacyUserId===u.id);need(account,'AUTH_INVALID_CREDENTIALS',401);
   const proof=Object.freeze({});proofs.set(proof,{accountId:account.id,userId:u.id,passwordHash:u.passwordHash,revision:account.revision,expiresAt:now()+30000});return proof;
  },
  consume(proof){
   const p=proofs.get(proof);proofs.delete(proof);need(p&&p.expiresAt>now(),'PASSWORD_PROOF_EXPIRED',401);
   const repo=identity.repo,a=repo.get('accounts',p.accountId),u=repo.get('users',p.userId);
   need(a&&a.revision===p.revision&&u?.passwordHash===p.passwordHash,'PASSWORD_PROOF_REVOKED',401);
   const actor=identity.actorForAccount(a.id);
   const eligible=AREAS.some(area=>allowed(identity,actor,area)) || actor.grants?.some(g=>g.effect==='allow'&&['members.basic_edit','members.review','members.change_status'].includes(g.capability));
   need(eligible,'PLATFORM_LOGIN_REQUIRED',403);return a;
  }
 };
}
