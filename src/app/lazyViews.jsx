import { createRecoverableLazy } from '../shared/ui/RecoverableLazy.jsx';

export const ApiSettingsView = createRecoverableLazy(() => import('../views/admin/ApiSettingsView.jsx'));
export const DataLookupView = createRecoverableLazy(() => import('../views/data-lookup/DataLookupView.jsx'));
export const DepartedMembersView = createRecoverableLazy(() => import('../views/members/DepartedMembersView.jsx'));
export const DiscordBotSettingsView = createRecoverableLazy(() => import('../views/bot/DiscordBotSettingsView.jsx'));
export const DiscordKookBridgeView = createRecoverableLazy(() => import('../views/discord-kook/DiscordKookBridgeView.jsx'));
export const HistoryView = createRecoverableLazy(
  () => import('../views/kda/KdaHistoryViews.jsx'),
  (module) => module.HistoryView
);
export const HighRiskAccountAlertsView = createRecoverableLazy(() => import('../views/risk-alerts/HighRiskAccountAlertsView.jsx'));
export const KdaView = createRecoverableLazy(
  () => import('../views/kda/KdaHistoryViews.jsx'),
  (module) => module.KdaView
);
export const LogsView = createRecoverableLazy(() => import('../views/admin/LogsView.jsx'));
export const MembersView = createRecoverableLazy(() => import('../views/members/MembersView.jsx'));
export const PermissionsView = createRecoverableLazy(() => import('../views/admin/PermissionsView.jsx'));
export const ProfileView = createRecoverableLazy(() => import('../views/admin/ProfileView.jsx'));
export const QueryView = createRecoverableLazy(() => import('../views/query/QueryView.jsx'));
export const RustplusClanInfoView = createRecoverableLazy(
  () => import('../views/rustplus/RustplusRelayViews.jsx'),
  (module) => module.RustplusClanInfoView
);
export const RustplusClanChatView = createRecoverableLazy(
  () => import('../views/rustplus/RustplusRelayViews.jsx'),
  (module) => module.RustplusClanChatView
);
export const ServerView = createRecoverableLazy(() => import('../views/server/ServerView.jsx'));
export const SquadsView = createRecoverableLazy(() => import('../views/squads/SquadsView.jsx'));
export const SyncCenterPanel = createRecoverableLazy(() => import('../views/sync/SyncCenterPanel.jsx'));
export const SystemSettingsView = createRecoverableLazy(() => import('../views/admin/SystemSettingsView.jsx'));
export const UsersView = createRecoverableLazy(() => import('../views/admin/UsersView.jsx'));
export const WechatMiniProgramView = createRecoverableLazy(() => import('../views/wechat/WechatMiniProgramView.jsx'));
