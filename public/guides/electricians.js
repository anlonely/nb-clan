export function steamProfileUrl(value) {
  if (typeof value !== 'string' || value.length > 200 || value !== value.trim()) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'steamcommunity.com' || url.username || url.password || url.port || url.search || url.hash ||
    !/^https:\/\/steamcommunity\.com\/(?:profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?$/i.test(value) ||
    !/^\/(?:profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?$/.test(url.pathname)) return null;
  return `https://steamcommunity.com${url.pathname.replace(/\/$/, '')}/`;
}

export function steamAvatarUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim() ||
    !/^https:\/\/avatars(?:\.[a-z]+)?\.steamstatic\.com\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(value)) return '';
  return new URL(value).href;
}

export function electricianList(payload) {
  if (!payload || !Array.isArray(payload.china) || !Array.isArray(payload.foreign) || payload.china.length + payload.foreign.length > 500) throw Error('INVALID_LIST');
  const seen = new Set(), result = { china: [], foreign: [] };
  for (const group of ['china', 'foreign']) for (const row of payload[group]) {
    const url = steamProfileUrl(row?.url);
    if (!url || typeof row?.name !== 'string' || !row.name.trim() || row.name.length > 80 || seen.has(url)) throw Error('INVALID_LIST');
    seen.add(url); result[group].push({ name: row.name.trim(), url, avatar: steamAvatarUrl(row.avatar) });
  }
  return result;
}

export function electricianTarget(search) {
  const params = new URLSearchParams(search), result = new URLSearchParams();
  if ([...params.keys()].some(key => /^(?:target|platform|guildId|channelId)\[/.test(key))) throw Error('INVALID_TARGET');
  if (params.has('target')) {
    const targets = params.getAll('target');
    const match = targets.length === 1 && /^(\d{10,20})-(\d{10,20})$/.exec(targets[0]);
    if (!match || ['platform', 'guildId', 'channelId'].some(key => params.has(key))) throw Error('INVALID_TARGET');
    return new URLSearchParams({ platform: 'discord', guildId: match[1], channelId: match[2] }).toString();
  }
  const platforms = params.getAll('platform');
  if (platforms.length > 1 || platforms.length === 1 && !['kook', 'discord'].includes(platforms[0])) throw Error('INVALID_TARGET');
  result.set('platform', platforms[0] || 'kook');
  for (const key of ['guildId', 'channelId']) {
    const values = params.getAll(key);
    // KOOK mobile links may omit the channel. The server accepts this only
    // when it resolves to one enabled electrician destination.
    if (key === 'channelId' && values.length === 0 && result.get('platform') === 'kook') continue;
    if (values.length !== 1 || !/^\d{10,20}$/.test(values[0])) throw Error('INVALID_TARGET');
    result.set(key, values[0]);
  }
  return result.toString();
}

export function electricianLanguage(languages) {
  const first=(Array.isArray(languages)?languages[0]:languages)||'en';
  return String(first).toLowerCase().startsWith('zh')?'zh-CN':'en';
}
function startPage() {
  const byId = id => document.getElementById(id);
  const requestedLanguage = new URLSearchParams(location.search).get('lang');
  let en = (['zh-CN', 'en'].includes(requestedLanguage) ? requestedLanguage :
    electricianLanguage(navigator.languages?.length ? navigator.languages : navigator.language)) === 'en';
  const translate = (zh, english) => en ? english : zh;
  const strings={
    'tutorial-label-zh':['中文教程','Chinese tutorial'], 'tutorial-label-en':['英文教程','English tutorial'],
    'brand-tagline':['一起开荒，一起回家。','Wipe together. Come home together.'],
    'page-label':['开荒准备','WIPE PREPARATION'],
    'page-title':['开荒前，先加电工好友','Add the electricians before the wipe'],
    'page-description':['点击头像或「去添加好友」，前往 Steam 主页。','Click an avatar or “Add friend” to open a Steam profile.'],
    'retry-load':['重新读取名单','Reload list'],
    'china-title':['CN电工','CN Electricians'], 'foreign-title':['EU电工','EU Electricians'],
    'china-empty':['暂未配置CN电工。','No CN electricians configured yet.'],
    'foreign-empty':['暂未配置EU电工。','No EU electricians configured yet.'],
    'footer-note':['添加前，请确认已登录自己的 Steam 账号。','Sign in to your own Steam account before adding friends.']
  };
  const retry = byId('retry-load'), dialog = byId('tutorial-dialog'), englishDialog=byId('tutorial-dialog-en');
  let busy = false, roster = null, loadError = null;
  function renderLoadMessage() {
    byId('load-message').textContent = busy ? translate('正在读取电工名单…', 'Loading electricians…')
      : loadError === 'INVALID_TARGET' ? translate('链接不完整，请从电工卡片重新打开。', 'Incomplete link. Open this page from the electrician card.')
        : loadError === 'NOT_CONFIGURED' ? translate('这份电工名单暂不可用，请联系管理员检查配置。', 'This list is unavailable. Please contact an administrator.')
          : loadError === 'INVALID_LIST' ? translate('电工名单暂时无法显示，请稍后重新读取。', 'Cannot display this list. Please reload later.')
            : loadError ? translate('电工名单读取失败，请检查网络后重试。', 'Could not load the list. Check your connection and retry.')
              : translate('暂无电工名单，请稍后再来。', 'No electricians listed yet. Check back later.');
  }
  function applyLanguage() {
    document.documentElement.lang = en ? 'en' : 'zh-CN';
    for (const [id, labels] of Object.entries(strings)) byId(id).textContent = labels[en ? 1 : 0];
    document.title = translate('添加电工好友 · Clan Portal', 'Add Electricians on Steam · Clan Portal');
    document.querySelector('.brand').setAttribute('aria-label', translate('Clan Portal 首页', 'Clan Portal home'));
    byId('language-switch').setAttribute('aria-label', translate('页面语言', 'Page language'));
    for (const button of byId('language-switch').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.language === document.documentElement.lang));
    if (roster) for (const group of ['china', 'foreign']) renderList(group, roster[group]);
    if (busy || roster || loadError) renderLoadMessage();
  }
  for (const button of byId('language-switch').querySelectorAll('button')) button.addEventListener('click', () => {
    en = button.dataset.language === 'en';
    const params = new URLSearchParams(location.search);
    params.set('lang', en ? 'en' : 'zh-CN');
    history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
    applyLanguage();
  });
  function renderList(group, values) {
    const list = byId(`${group}-list`); list.replaceChildren();
    byId(`${group}-count`).textContent = en ? `${values.length}` : `${values.length} 位`;
    byId(`${group}-empty`).hidden = values.length > 0;
    for (const row of values) {
      const item = document.createElement('li'), link = document.createElement('a');
      link.className = 'profile-link'; link.href = en ? `${row.url}?l=english` : row.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', translate(`${row.name}，前往 Steam 主页添加好友`, `Open ${row.name}'s Steam profile to add a friend`));
      const avatar = document.createElement('span'); avatar.className = 'profile-avatar'; avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = [...row.name][0].toUpperCase();
      if (row.avatar) {
        const image = document.createElement('img'); image.alt = ''; image.width = 58; image.height = 58;
        image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = row.avatar; avatar.append(image);
      }
      const text = document.createElement('span'); text.className = 'profile-text';
      const name = document.createElement('strong'); name.className = 'profile-name'; name.textContent = row.name;
      const detail = document.createElement('span'); detail.className = 'profile-detail';
      const profile = new URL(row.url).pathname.split('/');
      const detailLabel = document.createElement('span'); detailLabel.textContent = profile[1] === 'profiles' ? 'STEAM ID' : 'STEAM';
      detail.append(detailLabel, document.createTextNode(profile[2]));
      text.append(name, detail);
      const action = document.createElement('span'); action.className = 'profile-action'; action.textContent = translate('去添加好友 ↗', 'Add friend ↗');
      link.append(avatar, text, action); item.append(link); list.append(item);
    }
  }
  async function load() {
    if (busy) return;
    busy = true; roster = null; loadError = null; retry.hidden = true; byId('groups').hidden = true;
    byId('load-state').hidden = false; byId('load-state').className = 'notice'; renderLoadMessage();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const target = electricianTarget(location.search);
      const response = await fetch(`/api/v2/public/electricians?${target}`, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw Error(response.status === 404 ? 'NOT_CONFIGURED' : 'LOAD_FAILED');
      const data = electricianList(await response.json()), count = data.china.length + data.foreign.length;
      roster = data;
      renderList('china', data.china); renderList('foreign', data.foreign);
      byId('groups').hidden = false; byId('load-state').hidden = count > 0;
      retry.hidden = count > 0;
    } catch (error) {
      byId('load-state').className = 'notice error';
      loadError = error.message;
      retry.hidden = error.message === 'INVALID_TARGET';
    } finally { clearTimeout(timeout); busy = false; renderLoadMessage(); }
  }
  const showTutorial = selected => { if (!selected.open) selected.showModal(); };
  const openLinkedTutorial = () => { if (location.hash === '#tutorial') showTutorial(en?englishDialog:dialog); };
  byId('show-tutorial').addEventListener('click', ()=>showTutorial(dialog));
  byId('show-tutorial-en').addEventListener('click', ()=>showTutorial(englishDialog));
  window.addEventListener('hashchange', openLinkedTutorial);
  for(const selected of [dialog,englishDialog])selected.addEventListener('close', () => {
    selected.querySelector('video')?.pause();
    if (location.hash === '#tutorial') history.replaceState(null, '', location.pathname + location.search);
  });
  applyLanguage();
  openLinkedTutorial();
  retry.addEventListener('click', load);
  load();
}

if (typeof document !== 'undefined') startPage();
