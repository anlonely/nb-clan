# Clan Portal

面向 Rust 战队的自托管成员、开荒安排与社区管理系统。React + Vite 前端、Node.js + Express 服务端、SQLite 存储；提供中文和英文 Web 界面。采用 AGPL-3.0-only。

## 功能与范围

- 成员查询、资料管理、队伍和角色权限。
- 开荒档期、报名、通知、历史与战绩查询/导出。
- Discord、KOOK Bot 配置、社区身份验证与消息交互。
- 可选 Steam、BattleMetrics、Vital 等数据源及微信小程序。
- 后台同步任务、审计记录、健康检查、备份与恢复工具。

核心管理界面可以在没有第三方凭据的情况下运行。平台登录、通知、外部数据采集和小程序需要各自的应用配置及网络访问；公开源码不包含运营账号、成员数据或生产凭据。

## 本机快速开始

使用 **Node.js 22.23.1**（`.node-version` / `.nvmrc`）和 npm。原生运行适用于 macOS/Linux；Windows 使用 WSL2 或 Docker。

```sh
npm ci
cp .env.example .env
npm run setup
npm run build
npm run doctor
npm start
```

访问 http://127.0.0.1:8787/login，选择管理员登录。用户名为 `root`；随机初始密码保存在 `data/root-credentials.txt`，不会打印到终端。`setup` 再次执行只检查已有完整安装，不覆盖数据。

本机模式仅接受回环地址，关闭外部 OAuth 和回调。要启用真实平台服务，请按 [安装说明](docs/INSTALLATION.md) 配置 HTTPS。开发时运行 `npm run dev` 并访问 `http://127.0.0.1:5173`；API 在 8787，开发命令会显式设置来源校验并通过 Vite 转发 API。

## Docker

```sh
docker compose build
docker compose run --rm nb-clan-member-system node scripts/setup.mjs
docker compose up -d
```

默认使用命名数据卷，宿主端口固定在 `127.0.0.1:8787`。初始化结果只显示凭据文件位置；管理员可在自己机器上读取卷中的 `root-credentials.txt`。不要把本机模式发布到公网。

生产 HTTPS、可选代理及目录挂载见 [运维说明](docs/OPERATIONS.md)。首次初始化需要空数据目录/空卷，升级已有站点应先备份。

## 开发与验证

```sh
npm run test:unit
npm run test:core
npm run test:integration
npm run test:migration
npm run test:browser
npm run test:mini
npm run build
npm run check:release
```

浏览器分组需要已安装 Chrome/Chromium；必要时通过 `PUPPETEER_EXECUTABLE_PATH` 指定可执行文件。

`npm test` 顺序运行全部分组，集成组执行前会自动构建前端。测试使用隔离数据；测试执行入口限制外网连接，真实平台验收需要另行配置，不能将离线测试通过解释为 Discord/KOOK/微信服务已经验收。

`scopeContract: true` 仅用于独立的能力与作用域算法测试。夹具默认使用真实身份服务；HTTP、运行时与固定角色矩阵测试验证部署中的 owner/admin/member 权限。

## 文档

- [安装与首次登录](docs/INSTALLATION.md)
- [配置](docs/CONFIGURATION.md)
- [架构与兼容边界](docs/ARCHITECTURE.md)
- [平台集成](docs/INTEGRATIONS.md)
- [备份、升级和部署](docs/OPERATIONS.md)
- [贡献指南](CONTRIBUTING.md) · [安全问题](SECURITY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md) · [变更记录](CHANGELOG.md)

## 授权

本项目采用 [GNU AGPL v3](LICENSE)，SPDX 标识为 `AGPL-3.0-only`。修改后通过网络提供服务时，应按许可证向用户提供对应源码。网页底部提供源码入口；运营修改版本时，将 `VITE_SOURCE_URL` 指向你实际运行版本的完整源码并重新构建。第三方依赖继续遵守各自许可证。

项目不隶属于 Facepunch、Valve、Discord、KOOK 或微信；相关名称仅用于说明兼容的平台。
