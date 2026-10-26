# G05 隔离运行环境

仅用于 NB Clan V2 成员空间的本地开发和桌面验收。平台 OAuth、角色资格、Steam 身份是构造适配器；内部业务使用真实 G03 身份路由、G04 报名路由、G05 成员路由和同一份隔离 SQLite。

## 启动和停止

在 G05 独立工作树根目录运行：

```sh
node test/support/v2-member-space/dev.mjs
```

默认地址 `http://127.0.0.1:4315`，一个 API 进程，同源 Vite middleware。浏览器可打开 `/app/home` 或 `/app/wipes/<id>`。UI 文件即时刷新；修改后端文件后须停止本地实例再启动。端口占用时明确失败，不会寻找别的服务复用。`--port 0` 可明确申请临时端口，`--static` 可服务此工作树预先构建的 `dist/`；参数不能指定任意目录、host 或生产配置。

终端 Ctrl-C 会停止该子进程、关闭 Vite/HTTP、检查点并关闭 SQLite；`shutdown.json` 留下关闭记录。不要直接运行 `runtime.mjs`，它要求启动器提供严格白名单和新的空数据文件。

每次启动都会新建 `work/g05/runtime-*/data/nb-clan.sqlite`，已有运行数据不会覆盖。`work/g05/runtime-latest.json` 指向最新元数据；对应 `runtime.json` 为 0600，包含 origin、pid、SQLite 路径、构造场次 ID 和仅本地控制令牌。不要把其中令牌、登录 Cookie 或完整私有元数据复制到公共报告。

## 隔离边界

- 不读取生产 `.env`；不传递 HOME、代理、平台凭据、生产数据库、任意 NODE_OPTIONS。
- 每个运行子进程加载既有 `test/support/v2-baseline/loopback-only.mjs`。该 Node 守卫拒绝非 loopback 连接和 Unix Socket，它不是操作系统级沙箱。
- `NB_DISABLE_BACKGROUND_JOBS=1`，Vital/Atlas 外联关闭，Rust+ relay flush 间隔为 0；不挂载后台任务和通知发送器。
- HTTP 只监听 127.0.0.1，验证 Host，G03 路由另外验证精确 Origin 和 CSRF。
- 创建新的 G03/G04 schema 并执行正式迁移函数，记录完整迁移标记。
- 直接挂载正式导出的 `createIdentityRouter`、`createSchedulingRouter`、`createMemberSpaceRouter`；受控适配器仅存在于本脚本。未声称经过旧的 `server/api.js:createApiRouter` 启动链。
- 初始已验证身份和小队关系是构造数据库事实；开荒创建/发布、初始 beta 报名和控制改期/改报名都经过真实 HTTP 业务路由。没有第二条报名写路径。

## 构造账号

真实 `/api/v2/auth/{discord|kook}/start` 跳转到构造账号选择页；选中后继续走真实 callback、finish 和 V2 cookie。选择页可用 `a[data-fixture="alpha"]` 定位。

| key | 成员 | 说明 |
| --- | --- | --- |
| alpha | 阿北 | 一队成员，初始未报名 |
| beta | 小林 | 一队成员，初始已准时报名；HTTP 自检专用 |
| leader | 周队 | 一队队长，有有效本人身份 |
| admin | 值班管理员 | 一队管理员，有有效本人身份 |
| foreign | 另一队成员 | 二队，仅能看到二队受众场次 |
| new | 新队员 | 无账号/绑定；真实 onboarding 与 Steam bind 路径 |
| denied | 无平台资格 | 构造资格校验拒绝，不能进入成员业务 |

`new` 的 Steam start 会跳转到本地确认页，链接 `a[data-fixture-steam="new"]` 生成一次性构造 Steam 证明，再交给真实绑定回调。不会向真人 Discord/KOOK/Steam 发起认证或修改真实账号。

场次 `nextWipeId` 是本队按 ID 升序排列的最后一项，却是时间最近的一场；`firstOwnIdCursorWipeId` 刻意不是下一场。另有时间更早但只面向二队的 `foreignWipeId`。日期以启动时刻为基准，避免固定日期过期。

## 验收控制

只在本隔离脚本挂载的 `POST /api/v2/__fixtures/control` 要求：

- `Origin` 为该 runtime 的精确 origin。
- `Content-Type: application/json`。
- `x-g05-control` 等于私有 `runtime.json` 的 controlToken。

| action | 其他字段 | 作用 |
| --- | --- | --- |
| `fault` | `fixture`（可选账号限定）、`method`、`path`、`mode`、`delayMs` | 消耗一次匹配请求故障；支持 bootstrap/me/wipes/operations 路径 |
| `clear-faults` | 无 | 移除还未消耗的故障 |
| `reschedule` | `wipeId` 可选、`minutes` 1–240 | 管理员经真实 PATCH 修改集合时间，产生内容修订 |
| `signup` | `fixture`、`wipeId` 可选、`response` | 经该成员真实登录和报名 HTTP，制造并发版本冲突 |
| `revoke` | `fixture` | 调用真实身份服务 revokeAccountScope，发撤权事件并清除会话 |
| `eligibility` | `fixture`、`status=eligible/denied/unavailable` | 更改受控外部资格并过期已有资格证据 |
| `inspect` | 无 | 返回本地请求轨迹、真实报名、回执、撤权事件和数据库 integrity |

`fault.mode`：

- `delay`：业务读取/写入已完成，响应延迟 1–30000ms；用于检查缓存过期和晚到响应。
- `disconnect-before`：未执行业务就断开连接；operation GET 暂时 404，同 key/body 仍可重试。
- `disconnect-after`：真实业务已执行，在 JSON 响应返回前断开；用于“结果不明”与回执恢复。
- `unavailable`：一次 503，用于离线/弱网恢复界面。

必须用 `fixture` 限定自动化故障，避免影响别的浏览器账号。控制路由不是正式产品接口，不导入生产。

## 验证

```sh
node --test test/v2-member-runtime.test.js
node test/support/v2-member-space/verify-http.mjs
```

HTTP 自检使用当前运行实例：15 项真实 HTTP 检查，结果写该 runDir 的 `http-check.json`。它会增加 beta 报名版本、撤销 beta 会话后重新登录；不会完成 new 绑定或改变 alpha 报名。已登录 beta 浏览器会受该撤权影响，所以在开始 beta 浏览器验收之前运行它。

HTTP 检查不能替代 1440px 浏览器操作和截图，也不能证明真人外部平台认证通过。

## 浏览器截图落盘

`POST /api/v2/__fixtures/evidence` 使用相同的精确 Origin 和 `x-g05-control` 鉴权。只有此路由的 JSON 请求体上限为 3MB，其他控制路由仍为 8KB。

```json
{"name":"home-1440.png","base64":"<CDP Page.captureScreenshot 返回的 PNG base64>"}
```

也可上传断言记录：

```json
{"name":"browser-check.json","json":{"viewport":{"width":1440},"checks":[]}}
```

文件名仅允许字母、数字、下划线、连字符和末尾 `.png`/`.json`，不可带目录。PNG 校验签名、JSON 校验可解析性，文件写入该 runDir 下的 `browser-evidence/`，权限 0600。响应返回 `{file, bytes, sha256, replayed}`；相同内容可重放，不同内容同名返回 409，避免覆盖已有证据。此路由不提供任意读写文件能力，也不由正式产品 router 挂载。
