const { ensureCanEnterApp } = require('../services/api');
function goLink() { wx.switchTab({ url: '/pages/link/index/index' }); }
async function access(page) {
  const sequence = page.accessSequence = (page.accessSequence || 0) + 1;
  const profile = await ensureCanEnterApp();
  if (!profile || page.active === false || sequence !== page.accessSequence) return null;
  const linked = Boolean(profile.linked && profile.kookLinked);
  if (page.active !== false) page.setData({ linked });
  return { ...profile, linked };
}
function error(page, failure) { page.setData({ errorText: failure?.message || '加载失败，请重试' }); }
module.exports = { goLink, access, error };
