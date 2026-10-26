import { t } from './i18n.js';
import React,{useLayoutEffect,useRef,useState} from 'react';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useApp,AppLink } from './context.jsx';
import { Button,Notice,Loading } from './ui.jsx';
import { errorCopy,time } from './format.js';
import './auth-community.css';
import { createAuthFlow,safeAuthReturnTo } from './auth-flow.js';
import { BRAND_NAME } from './brand.jsx';
export function AuthCommunity({ community, provider }) {
  const [failed, setFailed] = useState(false);
  const platform = provider === 'discord' ? 'Discord' : 'KOOK';
  return <section className="auth-community" aria-label={t("{v0} 服务器及我的角色", {v0:(platform)})}>
    <div className="auth-community-heading">
      <div className="auth-community-icon">{community?.iconUrl && !failed
        ? <img src={community.iconUrl} alt={t("服务器头像")} referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
        : <span aria-label={t("服务器暂无头像")}>{(community?.name || platform).slice(0, 1)}</span>}</div>
      <div><small className="muted">{t("{platform} 服务器", {platform})}</small><strong>{community?.name || t("服务器信息暂未读取")}</strong></div>
    </div>
    <div className="auth-community-roles"><small className="muted">{t("我的角色")}</small>
      {community?.available ? community.roles?.length
        ? <ul>{community.roles.map(role => <li key={role.id}>{role.name}</li>)}</ul>
        : <p className="caption">{t("暂无可显示的角色")}</p>
        : <p className="caption">{t("角色名称暂未读取，可重新检查成员资格。")}</p>}
    </div>
  </section>;
}
export default function AuthPage({continuing,returnTo,reason}) {
  const {client,go,refreshSession}=useApp();
  const [view,setState]=useState({data:null,error:null,busy:false});
  const [ownerPassword, setOwnerPassword] = useState('');
  const flow=useRef(null),safeReturn=safeAuthReturnTo(returnTo),step=JSON.stringify([continuing,safeReturn]);
  // A prop change renders before the effect starts the next request. Never render
  // an old provider DTO as an onboarding DTO during that transition.
  const {data,error,busy}=view.step===step?view:{data:null,error:null,busy:false};
  useLayoutEffect(()=>{
    const current=createAuthFlow({client,continuing,returnTo:safeReturn,go,refreshSession,
      onChange:state=>{if(flow.current===current)setState({...state,step});}});
    flow.current=current;current.load();
    return()=>{current.dispose();if(flow.current===current)flow.current=null;};
  },[client,continuing,safeReturn,step,go,refreshSession]);
  const load=()=>flow.current?.load();
  const act=action=>flow.current?.act(action);
  const params=new URLSearchParams(location.search);
  const code=params.get('error'), wait=Number(params.get('retryAfter'));
  const shownError=error && !(code && error.errorCode==='AUTH_CONTEXT_EXPIRED') ? error
    : data?.errorCode ? {errorCode:data.errorCode,retryAfterSeconds:data.retryAfterSeconds}
      : code && (!continuing || !data) ? {errorCode:code,retryAfterSeconds:Number.isFinite(wait)?wait:undefined} : null;
  return <div className="auth-layout"><div className="auth-story"><p className="eyebrow">{t("从这里开启下一场开荒")}</p><h1>{t("开荒之前，")}<br/>{t("先和队友碰个面。")}</h1><p>{t("看看开荒时间，告诉队友你的安排。")}</p><ol className="auth-steps"><li><span>1</span>{t("登录战队所在平台")}</li><li><span>2</span>{t("首次确认 Steam 账号")}</li><li><span>3</span>{t("返回原来的开荒安排")}</li></ol><p className="muted caption">{t("账号由平台验证，无需手填 Steam ID。")}</p></div><section className="panel auth-card"><ShieldCheck size={27}/><h2>{continuing?t("继续完成验证"):t("进入 {brand}", {brand: BRAND_NAME})}</h2><p className="muted">{continuing?t("{v0}，完成下方步骤后会返回原来的页面。", {v0:(data?.displayName||t('你的平台身份'))}):data?.ownerPasswordLogin&&!data.providers?.some(p=>p.enabled&&p.configured)?t("使用管理员账号配置站点，随后可启用社区平台登录。"):t("登录需关联 Steam，并拥有 KOOK 或 Discord 的指定身份组；首次加入请先使用战队平台登录。")}</p>{reason&&<Notice title={t(reason)}/>}{shownError&&<Notice title={t("需要处理一步")} tone="error">{errorCopy(shownError)}</Notice>}{!data&&!error?<Loading/>:continuing?<>{data?<><p className="binding-state">{t("已连接")} {data.provider==='discord'?'Discord':'KOOK'}<span>{t("有效至")} {time(data.expiresAt)}</span></p><AuthCommunity key={`${data.provider}:${data.community?.iconUrl || ''}`} community={data.community} provider={data.provider}/>{data.allowedActions.includes('steam')&&<Button kind="primary wide" disabled={busy} onClick={()=>act('steam/start')}>{t("前往 Steam 确认账号")}<ArrowRight size={17}/></Button>}{data.allowedActions.includes('retry')&&<Button disabled={busy} onClick={()=>act('eligibility/retry')}>{t("重新检查成员资格")}</Button>}<Button kind="ghost" disabled={busy} onClick={()=>act('cancel')}>{t("取消这次登录")}</Button></>:<><Button onClick={()=>go(`/login?returnTo=${encodeURIComponent(safeReturn)}`)}>{t("重新开始登录")}</Button><Button kind="ghost" onClick={load}>{t("重试读取")}</Button></>}</>:<>{data?.providers?.filter(p=>p.enabled&&p.configured).map(p=><a className="button platform-button" key={p.provider} href={`/api/v2/auth/${p.provider}/start?returnTo=${encodeURIComponent(safeReturn)}`}>{t("使用 {platform} 登录", {platform:p.provider==='steam'?'Steam':p.provider==='discord'?'Discord':'KOOK'})}<ArrowRight size={18}/></a>)}{data&&!data.ownerPasswordLogin&&!data.providers?.some(p=>p.enabled&&p.configured)&&<Notice title={t("平台登录暂不可用")}>{t("请联系管理员确认战队登录入口。")}</Notice>}{data?.ownerPasswordLogin && <form className="owner-login" onSubmit={async event => {
        event.preventDefault();
        if (ownerPassword && !busy) { await flow.current?.ownerLogin(ownerPassword); setOwnerPassword(''); }
      }}>
        <h3>{t('管理员登录')}</h3>
        <p className="caption">{t('使用安装时创建的 root 账号管理此站点。')}</p>
        <label>{t('管理员密码')}<input type="password" name="password" autoComplete="current-password"
          required value={ownerPassword} onChange={event => setOwnerPassword(event.target.value)} disabled={busy}/></label>
        <Button type="submit" kind="primary wide" disabled={busy || !ownerPassword}>{t(busy ? '正在登录…' : '登录管理空间')}</Button>
      </form>}{error&&<Button onClick={load}>{t("重新读取登录方式")}</Button>}</>}<p className="caption"><AppLink to="/help">{t("绑定遇到问题？查看帮助")}</AppLink></p></section></div>;
}
