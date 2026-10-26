import { ROOT_CREDENTIALS_FILE, ensureStore } from '../server/store.js';

await ensureStore();
console.log(`root 初始账号已准备好：${ROOT_CREDENTIALS_FILE}`);
