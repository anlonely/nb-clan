import '../results.mjs';
import path from 'node:path';
/** Keep generated artifacts outside Vite HMR. Scope ignores to this checkout, not parent path names. */
export function runtimeWatchOptions(projectRoot) {
  const excluded = ['work', 'output/test-results', 'dist'].map(relative => path.resolve(projectRoot, relative));
  return { ignored: file => {
    const full = path.resolve(file);
    return excluded.some(directory => full === directory || full.startsWith(`${directory}${path.sep}`));
  } };
}
