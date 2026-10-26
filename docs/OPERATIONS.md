# 部署、备份与升级

## 本机 Docker

基础 Compose 使用命名数据卷、非 root 用户、只读根文件系统、健康检查和资源限制，端口固定在宿主 `127.0.0.1:8787`。只在空卷执行一次：

```sh
docker compose build
docker compose run --rm nb-clan-member-system node scripts/setup.mjs
docker compose up -d
docker compose ps
```

在自己的终端读取初始密码（不要转发终端输出）：

```sh
docker compose exec nb-clan-member-system cat /app/data/root-credentials.txt
```

## HTTPS 生产部署

使用 `docker-compose.production.yml` 覆盖基础配置，设置实际 `NB_V2_PUBLIC_ORIGIN=https://your-domain.example`，通过自己的 TLS 反向代理访问。生产覆盖关闭本机模式；`deploy/nginx/` 提供模板，必须替换域名、证书和上游，并仅信任实际代理来源。

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

可选代理配置位于 `docker-compose.proxy.yml`，默认不启动代理；该覆盖需要部署者提供自己的配置文件。需要目录挂载时查看 `docker-compose.bind-data.yml`，先设置运行用户的目录权限。部署脚本不再提供个人服务器默认地址，要求显式目标。不要在公开 issue 或日志中粘贴服务器凭据。

## 备份

SQLite 文件不能在活跃写入时直接复制并当作一致备份。运行库快照使用内置备份命令：

```sh
node scripts/sqlite-backup.js --sqlite data/nb-clan.sqlite
node scripts/sqlite-backup.js --verify /absolute/path/to/backup.sqlite
```

脚本生成校验清单并执行恢复读取验证。另须安全保存上传文件、会话密钥、owner/迁移控制文件和私有环境配置；单独的数据库不是完整部署备份。备份目录按敏感数据限制访问。

完整离线备份应先停止服务，等待后台任务排空和 SQLite 关闭，再备份整个数据目录及自己的配置。不要把原部署 `.env` 打包到公开发行物。

## 恢复与升级

1. 停止待恢复实例，保留当前数据目录副本。
2. 校验备份，恢复到原部署的数据位置并保留 owner/迁移控制文件及所有者权限。
3. 使用与备份兼容的程序版本运行 `npm run doctor`，确认通过后启动。
4. 验证登录、成员数量、档期和上传文件；确认后再启用外部自动任务。

升级前先做可恢复备份，保留旧镜像标签。新版本执行所属迁移及 doctor；数据库有不兼容迁移时，回滚必须连同兼容的数据备份一起恢复。`setup` 不会代替旧库升级，也不会覆盖不完整或已有业务的数据目录。

## 健康与停止

`/api/healthz` 用于存活检查，`/api/readyz` 用于可服务状态。使用 SIGTERM 正常停止并留出 Compose 的宽限时间，等待后台任务及数据库排空。不要用删除运行锁的方式强行启动第二个写实例。
