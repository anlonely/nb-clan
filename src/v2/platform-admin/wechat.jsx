import React from 'react';
import {t} from '../i18n.js';
import { AppLink } from '../context.jsx';
import { Badge, Button, Panel } from '../ui.jsx';
import { Select } from '../select.jsx';

export const wechatAreas = [
  ['mini-config', '微信小程序配置'],
  ['mini-access', '微信小程序登录与准入'],
  ['website-login', '微信网站登录'],
];

const templates = [
  ['wipeSignupStatus', '报名状态变更', '用于通知成员报名状态发生变化。'],
  ['wipeOpen', '档期开启', '用于发布档期开启通知。'],
  ['wipeReminder', '档期提醒', '用于发送开荒档期提醒。'],
];

export function WechatTabs({ area, onChange }) {
  return <nav className="platform-area-tabs wechat-area-tabs" aria-label={t("微信配置类别")}>
    {wechatAreas.map(([key, label]) => <button key={key} type="button" aria-current={area === key ? 'page' : undefined} onClick={() => onChange(key)}>{t(label)}</button>)}
  </nav>;
}

export default function WechatSettings({ area, data, draft, change, busy, online, dirty, onSave, onReset, credentials, tools }) {
  const disabled = !data.canConfigure || busy || online === false;
  const actions = <div className="platform-actions">
    <Button kind="primary" disabled={disabled} onClick={onSave}>{t("保存小程序配置")}</Button>
    <Button disabled={busy} onClick={onReset}>{t("重新读取")}</Button>
    {dirty && <span className="muted">{t("有未保存更改 · 切换页签会保留")}</span>}
  </div>;
  return <>
    <section className="wechat-settings-section" hidden={area !== 'mini-config'} aria-label={t("微信小程序配置")}>
      <header className="wechat-section-heading"><div><h2>{t("微信小程序配置")}</h2><p className="muted">{t("管理小程序接入凭据和开荒订阅通知。")}</p></div><Badge>{t("配置版本")} {data.revision}</Badge></header>
      <Panel><h3>{t("基础配置")}</h3><div className="platform-fields">
        <label><span>{t("小程序 AppID")}</span><input aria-label={t("小程序 AppID")} value={draft.appId || ''} disabled={disabled} onChange={e => change('appId', e.target.value)}/><small className="muted">{t("使用微信公众平台中对应小程序的 AppID。")}</small></label>
        <div className="wechat-setting-summary"><span>{t("小程序接入")}</span><strong>{data.enabled ? t("已启用") : t("未启用")}</strong><small className="muted">{t("在“微信小程序登录与准入”中管理。")}</small></div>
      </div><h3>{t("订阅通知模板")}</h3><p className="muted">{t("按通知用途填写模板 ID，留空表示未配置。通知发送仍需成员同意订阅。")}</p>
      <div className="wechat-template-fields">{templates.map(([key, label, hint]) => <label key={key}><span>{t(label)}</span><input aria-label={t("{value0}模板 ID",{value0:t(label)})} value={draft.subscriptionTemplates?.[key] || ''} maxLength={160} disabled={disabled} placeholder={t("填写模板 ID")} onChange={e => change('subscriptionTemplates', { ...draft.subscriptionTemplates, [key]: e.target.value })}/><small className="muted">{t(hint)}</small></label>)}</div>
      <details className="wechat-extra-templates"><summary>{t("其他订阅模板 ID")}</summary><p className="muted">{t("保留已有附加模板列表，不替代上方按用途配置的模板。")}</p><div className="platform-fields"><label><span>{t("订阅模板 ID（逗号分隔）")}</span><input aria-label={t("订阅模板 ID（逗号分隔）")} value={(draft.subscriptionTemplateIds || []).join(',')} disabled={disabled} onChange={e => change('subscriptionTemplateIds', e.target.value.split(',').map(value => value.trim()).filter(Boolean))}/></label></div></details>
      {actions}</Panel>
      {credentials}
      <details className="wechat-maintenance"><summary>{t("连接验证与维护")}</summary><p className="muted">{t("验证状态：")}{data.validation?.state === 'verified_adapter' ? (data.validation.evidenceLevel === 'live' ? t("适配器验证完成") : t("隔离适配器通过")) : t("尚未验证")}{t("。真实平台授权与投递仍需独立验收。")}</p><p className="muted">{t("保存配置后，可按需执行连接验证和维护。报名通知请前往")} <AppLink to="/admin/wipes">{t("档期管理")}</AppLink>{t("。")}</p>{tools}</details>
    </section>
    <section className="wechat-settings-section" hidden={area !== 'mini-access'} aria-label={t("微信小程序登录与准入")}>
      <header className="wechat-section-heading"><div><h2>{t("微信小程序登录与准入")}</h2><p className="muted">{t("微信资料用于进入小程序，关联战队身份后使用成员功能。")}</p></div><Badge tone={data.enabled ? 'green' : ''}>{data.enabled ? t("小程序已启用") : t("小程序未启用")}</Badge></header>
      <Panel><h3>{t("登录设置")}</h3><div className="platform-fields"><label className="platform-check"><input aria-label={t("启用微信小程序")} type="checkbox" checked={Boolean(draft.enabled)} disabled={disabled} onChange={e => change('enabled', e.target.checked)}/><span>{t("启用微信小程序")}</span></label><label><span>{t("最低客户端能力版本")}</span><Select aria-label={t("最低客户端能力版本")} value={draft.minClientVersion || 1} disabled={disabled} onChange={e => change('minClientVersion', Number(e.target.value))}><option value={1}>{t("版本 1 · 兼容旧版报名确认")}</option><option value={2}>{t("版本 2 · 新版直接报名")}</option></Select><small className="muted">{t("控制旧版报名请求的兼容方式，不是微信客户端版本。新版小程序使用版本 2。")}</small></label></div>{actions}</Panel>
      <Panel><h3>{t("成员进入流程")}</h3><ol className="wechat-access-steps"><li><strong>{t("完善微信资料")}</strong><p>{t("首次进入由成员选择头像并填写昵称。")}</p></li><li><strong>{t("关联现有战队身份")}</strong><p>{t("在信息关联页获取短码，通过官网 KOOK 登录后关联；也可用小程序扫描官网关联二维码。")}</p></li><li><strong>{t("本人确认后使用")}</strong><p>{t("回到小程序确认账号，展示关联的 Steam、KOOK、Discord 与角色，按现有成员资格和权限使用报名、全部队伍与排行榜。")}</p></li></ol><div className="wechat-access-note"><strong>{t("无需小程序 Steam 入队审核")}</strong><p>{t("小程序入队审核和管理端已移除。KOOK 登录资格沿用网站现有准入配置。")}</p><AppLink to="/admin/platforms/kook#login">{t("查看 KOOK 登录与准入")}</AppLink></div></Panel>
    </section>
    <section className="wechat-settings-section" hidden={area !== 'website-login'} aria-label={t("微信网站登录")}>
      <Panel className="panel wechat-website-unavailable"><Badge>{t("暂不可用")}</Badge><h2>{t("微信网站登录暂不可用")}</h2><p className="muted">{t("目前未开放使用微信账号直接登录网站。")}</p><p className="muted">{t("小程序关联通过官网 KOOK 登录完成，与微信网站登录是独立功能。")}</p><AppLink to="/admin/platforms/kook#login" className="button">{t("查看 KOOK 登录配置")}</AppLink></Panel>
    </section>
  </>;
}
