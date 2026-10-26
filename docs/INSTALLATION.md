# 安装与首次登录

使用已验证的 Node.js 22.23.1 和 npm（本项目使用内置 `node:sqlite` 的 backup API）。SQLite 文件及初始密码保存在自己的数据目录中，不需要现有生产配置、Discord、KOOK、微信或 Steam 凭据。

## 本机体验

在项目根目录执行：

```sh
npm ci
cp .env.example .env
npm run setup
npm run build
npm run doctor
npm start
```

本机配置应为：

```dotenv
NB_STORAGE_MODE=sqlite-primary
NB_DATA_DIR=./data
NB_V2_IDENTITY_ENABLED=1
NB_V2_PRODUCTION_ENABLED=1
NB_LOCAL_MODE=1
NB_OWNER_PASSWORD_LOGIN=1
NB_BIND_HOST=127.0.0.1
PORT=8787
NB_V2_PUBLIC_ORIGIN=http://127.0.0.1:8787
```

打开 `http://127.0.0.1:8787/login`，使用管理员入口、用户名 `root`，从 `data/root-credentials.txt` 读取随机生成的初始密码。该文件权限为 0600，脚本只显示文件位置，不输出密码。不要提交、分享该文件或整个 data 目录。首次安装可通过环境变量 `NB_ROOT_PASSWORD` 指定 16–128 字符密码；不要把它加入公开命令示例或提交到 Git。登录后可在「系统管理 → 账号 → 修改管理员密码」设置新密码，现有会话随即失效；初始密码文件不会随修改更新。

`NB_LOCAL_MODE=1` 仅允许回环地址、同端口 HTTP origin，不允许代理信任、平台 OAuth 或外部回调；本机模式拒绝公网监听。通知发送不绑定外部适配器；查看成员、管理配置等核心功能仍使用完整 V2 与 SQLite。需要真实平台登录或通知时切换下述 HTTPS 部署。

## 环境加载与检查

`setup`、`doctor`、`start` 显式读取当前目录的 `.env`。已有进程环境变量优先；Docker 可直接注入环境变量，不需要在容器内创建 `.env`。`NB_ENV_FILE=/absolute/path/config.env` 可指定另一个文件，该文件不存在会报错。相对 `NB_DATA_DIR` 与 `NB_SQLITE_FILE` 按当前工作目录解析；数据库必须位于数据目录的直接下一层。

`npm run doctor` 检查模式、origin、端口、数据权限、V2 迁移及身份计划证据，缺少前端构建时提示 `npm run build`。它不访问第三方、不输出密钥、不修改数据。检查通过不代表外部服务已配置完成。

## 本地 Docker

基础 Compose 将宿主端口固定绑定到 `127.0.0.1`。容器使用显式 `NB_LOCAL_CONTAINER=1`，在 Linux 容器内允许监听 `0.0.0.0` 以接受端口映射；公开 origin 仍必须是 HTTP 回环地址，平台 OAuth 与外部回调仍关闭。

```sh
docker compose build
docker compose run --rm nb-clan-member-system node scripts/setup.mjs
docker compose up -d
docker compose exec nb-clan-member-system node scripts/doctor.mjs
```

使用 `docker compose exec nb-clan-member-system cat /app/data/root-credentials.txt` 在自己的终端读取初始密码。这个命令包含敏感输出，不要复制到公开日志或截图。改变宿主映射端口时，应同时设置匹配的 `NB_V2_PUBLIC_ORIGIN`。

## HTTPS 部署

保持 SQLite 和两个 V2 开关为 1，将 `NB_LOCAL_MODE=0`、`NB_LOCAL_CONTAINER=0`，设置自己的 HTTPS `NB_V2_PUBLIC_ORIGIN`，用反向代理终止 TLS。容器内通常需 `NB_BIND_HOST=0.0.0.0`，宿主端口应由 Compose 绑定到回环地址。仅信任实际反向代理的地址。运行容器用户必须拥有 data 目录写权限。

空数据卷可先执行 `docker compose run --rm nb-clan-member-system node scripts/setup.mjs`，再启动服务。生产也可显式设置 `NB_OWNER_PASSWORD_LOGIN=1`，通过 HTTPS 的管理员入口配置站点；登录依然检查密码、Origin、速率限制及数据库权限，cookie 使用 Secure。关闭此开关后已签发的 owner 密码会话也不能继续访问。普通账号始终使用平台登录，原 `/api/v2/auth/password` 接口保持关闭。

全新安装会在独占空目录内创建 root、安装 owner 标记、SQLite schema、生产 owner 文件、身份计划证据及迁移 marker。迁移复用既有 plan/apply/validate，通过已经退出的初始化进程提供真实停机证明。再次运行 setup 只验证完整安装，不重置密码、账号或业务数据。

## 已有数据与失败恢复

`setup` 不是已有部署迁移工具。任何非空且未完整迁移的数据目录都会被拒绝；它不会覆盖 JSON、SQLite、用户或凭据。已有站点应先备份并按 `scripts/v2-production/migrate.mjs` 的 plan → 停机凭据 → apply → ready 流程迁移。已有 verified Steam owner 可通过明确设置 `NB_OWNER_STEAM_ID` 指定，公开代码没有默认的站长 Steam 身份；没有安装标记的旧 root 不会自动获得 owner 权限。

安装中断会保留 `.setup.lock` 与已有文件，再次运行会报告 `SETUP_INCOMPLETE_OR_RUNNING`。先确认没有运行中的安装/服务，再检查错误并保留目录备份。对于确认没有任何业务数据的失败首次安装，可改用另一个空数据目录重新安装。不要仅删除锁文件来绕过检查，也不要对已有站点运行清空命令。

数据目录及生产控制文件拒绝符号链接。Linux/macOS 原生运行受支持；Windows 请使用 WSL2 或 Docker，以保持 POSIX 文件所有者及权限检查。

## 前端开发

完成本机初始化后运行 `npm run dev`，打开 `http://127.0.0.1:5173`。开发 API 使用 `node --watch scripts/start.mjs --dev`，显式将公共 origin 设置为 Vite 的 5173 端口；API 仍在 8787 监听。Vite 将 `/api` 与 `/uploads` 代理到该 API。5173 已占用时启动失败，避免自动切换端口导致认证配置不一致。

开发模式要求 `.env` 中 `NB_LOCAL_MODE=1`，仅接受回环监听、禁止代理信任和外部 OAuth。CSRF 仍精确匹配 `http://127.0.0.1:5173`，直接向 API 提交其他 origin 的写请求会被拒绝。部署运行继续使用 `npm run build && npm start`。

开发流程默认 API 端口为 8787；若修改 `PORT`，需同步调整 `vite.config.js` 中的开发代理目标。
