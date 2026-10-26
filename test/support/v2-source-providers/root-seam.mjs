// Root integration exercises the installed configuration binding seam directly.
import { createSourceHost } from '../../../server/v2/management-adapters/source-host/index.js';
export async function rootSeam() {
 return { createSourceHost, close: async () => {} };
}
