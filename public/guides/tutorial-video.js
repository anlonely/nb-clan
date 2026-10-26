// One worker serves both guides; only a visible tutorial is warmed.
const workerUrl = new URL('/guides/tutorial-media-sw.js?v=media-cache-3', location.origin).href;
const controlled = () => navigator.serviceWorker.controller?.scriptURL === workerUrl;

async function connectCache() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await navigator.serviceWorker.register(workerUrl, { scope: '/guides/', updateViaCache: 'none' });
    if (!controlled()) await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); };
      const changed = () => { if (controlled()) finish(); };
      const timer = setTimeout(finish, 2500);
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
    return controlled() ? navigator.serviceWorker.controller : null;
  } catch { return null; }
}

// A blocked registration must never prevent the ordinary player from loading.
const cacheReady = Promise.race([connectCache(), new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
for (const video of document.querySelectorAll('video[data-tutorial-src]')) {
  const dialog = video.closest('dialog');
  let worker = null, warmed = false;
  const warm = () => {
    const connection = navigator.connection;
    if (!worker || warmed || document.visibilityState !== 'visible' || (dialog && !dialog.open) ||
        connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType)) return;
    warmed = true;
    worker.postMessage({ type: 'CACHE_TUTORIAL', url: video.src });
  };
  if (dialog) new MutationObserver(warm).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  document.addEventListener('visibilitychange', warm);
  cacheReady.then(controller => {
    worker = controller;
    video.src = video.dataset.tutorialSrc;
    warm();
  });
}
