import { t } from './i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Link2, QrCode } from 'lucide-react';
import { useApp, AppLink } from './context.jsx';
import { useQuery } from './use-query.jsx';
import { Avatar, Badge, Button, Notice, Panel, QueryState, Title } from './ui.jsx';
import { errorCopy } from './format.js';
import { createWechatLinkFlow, validWechatLinkCode, wechatLinkExpired, wechatLinkError, WECHAT_LINK_LOGIN_URL } from './wechat-link-flow.js';
import './wechat-link.css';

function LocalQr({ payload }) {
  const [image, setImage] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setImage(''); setFailed(false);
    // Encode on this device. A link ticket must never be sent to a QR service.
    import('qrcode').then(module => module.default.toDataURL(payload, {
      width: 280, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#132018', light: '#ffffff' }
    })).then(value => { if (active) setImage(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [payload]);
  return failed ? <Notice title={t("二维码暂时无法生成")}>{t("请使用左侧关联码方式。")}</Notice> :
    <div className="wechat-link-qr">{image ? <img src={image} width="280" height="280" alt={t("用小程序信息关联页的扫一扫扫描此二维码")}/> : <p role="status">{t("正在生成二维码…")}</p>}</div>;
}

function IdentityCard({ title, name, avatar, steamId }) {
  return <div className="wechat-link-identity"><Avatar name={name} src={avatar} size={48}/><div><small>{title}</small><strong>{name || t("未设置昵称")}</strong>{steamId && <span className="mono">SteamID {steamId}</span>}</div></div>;
}

export function LinkForm({ data }) {
  const { client, online } = useApp();
  const [code, setCode] = useState(''), [confirmed, setConfirmed] = useState(false), [now, setNow] = useState(Date.now());
  const [state, setState] = useState({ challenge: null, error: null, busy: false, mode: null });
  const flow = useRef(null);
  useEffect(() => {
    const current = createWechatLinkFlow({ client, onChange: setState }); flow.current = current;
    return () => { current.dispose(); if (flow.current === current) flow.current = null; };
  }, [client]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const challenge = state.challenge, linked = challenge?.status === 'linked';
  const expired = !linked && (wechatLinkExpired(challenge, now) || ['expired', 'cancelled'].includes(challenge?.status));
  useEffect(() => {
    if (!challenge || expired || linked || online === false) return;
    const timer = setInterval(() => { if (!document.hidden) flow.current?.poll(); }, 3000);
    return () => clearInterval(timer);
  }, [challenge?.linkId, expired, linked, online]);
  useEffect(() => { if (linked) client.invalidateQueries(['me']); }, [client, linked]);
  const kook = data.bindings.platforms.find(platform => platform.provider === 'kook');
  const ready = Boolean(kook && data.bindings.steam.status === 'verified');
  const disabled = state.busy || online === false || !confirmed || !ready;
  const seconds = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 1000)) : 0;
  const restart = () => { flow.current?.reset(); setCode(''); setConfirmed(false); };
  return <div className="stack">
    <Panel><h2>{t("确认要关联的成员账号")}</h2><IdentityCard title={t("当前官网账号")} name={data.profile.displayName} avatar={data.profile.avatar} steamId={data.bindings.steam.steamId}/>
      <div className="wechat-link-kook"><Badge tone={kook ? 'green' : ''}>KOOK {kook ? t("已关联") : t("未关联")}</Badge>{kook && <span>{kook.displayName || kook.externalId}</span>}</div>
      {!ready ? <Notice title={t("请先完成 KOOK 与 Steam 身份关联")} action={<a href={WECHAT_LINK_LOGIN_URL} className="button">{t("使用 KOOK 登录")}</a>}>{t("登录后会返回本页继续关联微信。")}</Notice> : !challenge && <label className="check-row"><input type="checkbox" checked={confirmed} disabled={state.busy} onChange={event => setConfirmed(event.target.checked)}/>{t("确认将我的微信关联到以上成员账号")}</label>}
    </Panel>
    {state.error && <Notice tone="error" title={t("关联暂未完成")}>{wechatLinkError(state.error) || errorCopy(state.error)}</Notice>}
    {linked ? <Panel><div className="success-line"><CheckCircle2/>{t("微信关联成功")}</div><p>{t("请返回小程序查看 Steam、KOOK、Discord 和角色信息。")}</p><AppLink to="/app/me" className="button">{t("返回我的资料")}</AppLink></Panel> : expired ?
      <Notice title={t("本次关联已过期")} action={<Button onClick={restart}>{t("重新关联")}</Button>}>{t("请重新获取关联码或生成二维码；过期请求无法完成关联。")}</Notice> : challenge ?
      <Panel><h2>{challenge.status === 'awaiting_confirmation' ? t("请在小程序确认关联") : t("用小程序扫描二维码")}</h2>
        {challenge.profile && <IdentityCard title={t("待关联微信")} name={challenge.profile.nickName} avatar={challenge.profile.avatarUrl}/>}
        {challenge.target && <IdentityCard title={t("将关联到")} name={challenge.target.displayName} avatar={challenge.target.avatar} steamId={challenge.target.steamId}/>}
        {challenge.status === 'pending' && state.mode === 'qr' && challenge.qrPayload && <LocalQr payload={challenge.qrPayload}/>}
        <p>{challenge.status === 'awaiting_confirmation' ? t("核对小程序显示的成员账号后，点击「确认关联」。只有完成这一步才会建立关联。") : t("打开小程序 → 信息关联 → 扫一扫，扫描上方二维码，再核对成员账号并确认。")}</p>
        <p className="caption">{t("剩余 {minutes} 分 {seconds} 秒，完成后此页会自动更新。", {minutes:Math.floor(seconds / 60),seconds:String(seconds % 60).padStart(2, '0')})}</p>
        <div className="button-row"><Button disabled={state.busy || online === false} onClick={() => flow.current?.poll()}>{t("刷新关联状态")}</Button><Button kind="ghost" onClick={restart}>{t("使用新的关联方式")}</Button></div>
      </Panel> : <div className="home-grid wechat-link-methods">
        <Panel><Link2 size={24}/><h2>{t("输入小程序关联码")}</h2><p className="caption">{t("在小程序「信息关联」中获取关联码，然后输入下方。")}</p><form onSubmit={event => { event.preventDefault(); if (!disabled) flow.current?.claim(code); }}><label className="field">{t("8 位关联码")}<input value={code} onChange={event => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 8))} inputMode="numeric" autoComplete="off" pattern="[0-9]{8}" maxLength={8} placeholder={t("请输入 8 位数字")} disabled={state.busy} required/></label><button type="submit" className="button primary" disabled={disabled || !validWechatLinkCode(code)}>{state.busy && state.mode === 'code' ? t("正在核对…") : t("核对微信并继续")}</button></form></Panel>
        <Panel><QrCode size={24}/><h2>{t("小程序扫码关联")}</h2><p className="caption">{t("适合电脑操作。生成二维码后，使用小程序信息关联页的「扫一扫」。")}</p><Button kind="primary" disabled={disabled} onClick={() => flow.current?.qr()}>{state.busy && state.mode === 'qr' ? t("正在生成…") : t("生成关联二维码")}</Button></Panel>
      </div>}
  </div>;
}

export default function WechatLinkPage() {
  const { client, session } = useApp();
  const query = useQuery(client, ['me'], '/api/v2/me', { enabled: Boolean(session), ttlMs: 60000 });
  if (!session) return <div className="auth-layout wechat-link-page"><div className="auth-story"><p className="eyebrow">{t("关联微信")}</p><h1 tabIndex={-1}>{t("把微信和")}<br/>{t("战队身份连起来。")}</h1><p>{t("使用 KOOK 登录官网，再输入小程序关联码，或用小程序扫描二维码。")}</p><p>{t("最后回到小程序确认，即可使用已有的 Steam、KOOK、Discord 和角色信息。")}</p></div><Panel className="panel auth-card"><Link2 size={27}/><h2>{t("关联微信小程序")}</h2><p className="muted">{t("请使用你的战队 KOOK 账号登录。首次登录按官网现有流程确认 Steam 身份。")}</p><a href={WECHAT_LINK_LOGIN_URL} className="button platform-button">{t("使用 KOOK 登录")}<ArrowRight size={18}/></a><p className="caption">{t("授权完成后自动返回本页。")}</p></Panel></div>;
  return <div className="wechat-link-page"><Title eyebrow={t("关联微信")}>{t("关联微信小程序")}</Title><p className="muted">{t("关联现有战队身份，最后一步由你在小程序中确认。")}</p><QueryState query={query}>{data => <LinkForm data={data}/>}</QueryState></div>;
}
