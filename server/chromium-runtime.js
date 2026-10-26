import { existsSync } from 'node:fs';

function envNonNegativeInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, max);
}

function envFlagEnabled(value, fallback = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(text);
}

export function chromiumExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

export function chromiumLaunchArgs() {
  const args = ['--disable-dev-shm-usage'];
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (envFlagEnabled(process.env.NB_CHROMIUM_DISABLE_SANDBOX, runningAsRoot)) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  return args;
}

const CHROMIUM_MAX_CONCURRENCY = Math.max(
  1,
  envNonNegativeInteger(process.env.NB_CHROMIUM_MAX_CONCURRENCY, 1, 4)
);
let activeChromiumJobs = 0;

export async function withChromiumSlot(task, options = {}) {
  if (activeChromiumJobs >= CHROMIUM_MAX_CONCURRENCY) {
    throw Object.assign(new Error(options.busyMessage || '导出任务繁忙，请稍后重试'), {
      status: 503,
      code: options.busyCode || 'chromium_export_busy',
      skipApiErrorLog: true
    });
  }
  activeChromiumJobs += 1;
  try {
    return await task();
  } finally {
    activeChromiumJobs = Math.max(0, activeChromiumJobs - 1);
  }
}

export const __chromiumRuntimeForTests = {
  activeJobs: () => activeChromiumJobs,
  maxConcurrency: CHROMIUM_MAX_CONCURRENCY,
  reset() {
    activeChromiumJobs = 0;
  }
};
