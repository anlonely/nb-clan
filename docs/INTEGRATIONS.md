# 可选平台集成

本机模式可以使用核心 Web 管理，不启用外部 OAuth、回调或通知传输。接入真实平台前应配置自己的 HTTPS origin、外部网络及后台平台设置。

| 集成 | 需要准备 | 配置与边界 |
| --- | --- | --- |
| Discord | 自有应用、OAuth client、Bot token，必要的 intent/权限 | 回调 `/api/v2/auth/discord/callback`；按社区绑定频道和角色；启用什么功能才授予对应权限 |
| KOOK | 自有 OAuth 应用、Bot 与事件配置 | 回调 `/api/v2/auth/kook/callback`；身份、验证信息和频道与 Discord 独立 |
| Steam | 按功能配置 Web API key、官方身份验证 | 不收集玩家 Steam 密码；登录验证交给官方页面 |
| BattleMetrics / 战绩来源 | 自有 API 凭据、数据源绑定和可访问网络 | 在同步中心启用任务；限流和错误状态不应被隐藏；外部服务变化可能影响可用性 |
| 微信小程序 | 自有 AppID、secret、平台允许的 HTTPS 域名 | `wechat-miniprogram/project.config.json` 默认游客 AppID；编辑 `miniprogram/config.js` 指向自己的站点 |
| 翻译服务 | 自行选择的兼容 API 地址、模型及密钥 | 默认不包含服务地址或凭据，费用和数据处理由部署者选择的服务决定 |
| Chromium 导出 | 系统 Chromium 或 Docker 自带浏览器 | 原生环境设置 `PUPPETEER_EXECUTABLE_PATH`；Docker 已安装浏览器和中英文字体 |

首次接入应先使用独立测试社区/频道，检查回调、权限、消息目标、失败恢复，再开启自动运行。离线测试通过不代表真实平台的回调或意图权限已验证。

公开版提供文字教程，未包含原社区录屏、真实成员截图或邀请二维码。可以添加有权发布的自有教程素材，并保留其来源记录。
