(() => {
  try {
    const theme = localStorage.getItem('nb-theme');
    document.documentElement.dataset.theme = ['system', 'light', 'dark'].includes(theme) ? theme : 'system';
  } catch {
    document.documentElement.dataset.theme = 'system';
  }
})();
