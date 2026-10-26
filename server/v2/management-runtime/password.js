import { IdentityError } from '../identity/errors.js';
import { SystemError } from '../system-admin/model.js';
import { createSystemPasswordProofAdapter } from '../system-admin/password-proof.js';
export function createManagementPasswordProof(identity) {
  const adapter = createSystemPasswordProofAdapter(identity);
  const translate = error => { throw error instanceof SystemError ? new IdentityError(error.errorCode, error.status) : error; };
  return {
    async authenticate(...args) { try { return await adapter.authenticate(...args); } catch (error) { translate(error); } },
    consume(proof) { try { return adapter.consume(proof); } catch (error) { translate(error); } }
  };
}
