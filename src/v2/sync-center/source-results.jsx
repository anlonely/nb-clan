import React from 'react';
import { t } from '../i18n.js';
import { Badge } from '../ui.jsx';

const sourceNames = { profile: 'Steam 基础资料', playtime: 'Rust 游戏时长', inventory: '库存', bans: 'Steam 封禁', restriction: '账号限制', official: '官服累计战绩', battlemetrics: '服务器在线', squad: '队伍' };
const sourceStates = { observed: '已获取', partial: '部分获取', unavailable: '未取得', private: '未公开' };
const errors = {
  RATE_LIMITED: '来源限流，请稍后重试', SOURCE_PRICE_UNAVAILABLE: '库存已获取，价格暂不可用',
  SOURCE_MISSING_FIELDS: '必要字段未返回', SOURCE_PRIVATE: '数据未公开', SOURCE_UNAVAILABLE: '来源暂不可用',
  SOURCE_TIMEOUT: '来源请求超时', SOURCE_NOT_CONFIGURED: '来源未配置', CREDENTIALS_INVALID: '来源凭据失效',
  SOURCE_MAPPING_REQUIRED: '尚未配置玩家映射', SOURCE_WINDOW_REQUIRED: '没有可用的采集时间范围'
};
export function SyncSourceResults({ item }) {
  const sources = (item.sourceResults || []).filter(e => Object.hasOwn(sourceNames, e.source) && e.status !== 'not_required');
  if (!sources.length) return null;
  return <div className="sync-source-results" aria-label={t("本次来源结果")}>
    {item.quality === 'unknown' && <p className="muted">{t("风险检测尚未取得有效证据，不能判定为正常。")}</p>}
    <dl>{sources.map(e => <div key={e.source}>
      <dt>{t(sourceNames[e.source])}</dt>
      <dd><Badge tone={e.status === 'observed' ? 'green' : 'warning'}>{t(sourceStates[e.status] || '未取得')}</Badge>
        {e.error && <span>{t(e.source === 'restriction' && e.error === 'SOURCE_MISSING_FIELDS' ? '暂时无法判定账号是否受限' : errors[e.error] || '本次未取得完整数据')}</span>}
      </dd>
    </div>)}</dl>
  </div>;
}
