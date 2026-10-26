# 配置

`setup`、`doctor`、`start` 显式读取 `.env`，进程已有环境变量优先。`NB_ENV_FILE` 可指定其他配置文件。`.env.example` 仅包含占位值，可提交；实际 `.env` 不可提交。

| 配置 | 用途 |
| --- | --- |
| `NB_DATA_DIR` | 数据目录，默认 `./data`；必须由运行用户拥有 |
| `NB_SQLITE_FILE` | SQLite 文件，默认数据目录内 `nb-clan.sqlite` |
| `NB_STORAGE_MODE` | 公开版使用 `sqlite-primary` |
| `NB_V2_PRODUCTION_ENABLED` / `NB_V2_IDENTITY_ENABLED` | 均为 `1`，选择当前 V2 |
| `NB_LOCAL_MODE` | `1` 为受限本机模式，`0` 为 HTTPS 部署 |
| `NB_LOCAL_CONTAINER` | 仅容器本机模式使用，配合宿主端口回环绑定 |
| `NB_OWNER_PASSWORD_LOGIN` | 显式启用安装所有者密码登录；关闭会拒绝旧密码会话 |
| `NB_V2_PUBLIC_ORIGIN` | 精确访问 origin，生产必须 HTTPS，不允许查询、路径或凭据 |
| `NB_BIND_HOST` / `PORT` | 监听地址/端口，本机默认 `127.0.0.1:8787` |
| `NB_TRUST_PROXY` | 仅按真实反向代理配置；本机模式必须关闭 |
| `NB_BRAND_NAME` | 服务端卡片和登录后站点名 |
| `VITE_BRAND_NAME` | 前端初始站点名，修改后重建 |
| `VITE_SOURCE_URL` | 此部署对应源码地址，修改后重建 |

不要在 `VITE_*` 变量中放密钥，它们会进入浏览器构建。Logo 可在系统配置中设置。默认电工名单为空，须为自己的社区配置成员，不会附带原站成员。

可选平台凭据见 INTEGRATIONS.md。翻译 API 不设置默认私人服务；只在明确配置地址、模型与密钥后使用。`doctor` 只检查本地配置与数据库，不验证外部账号有效性。
