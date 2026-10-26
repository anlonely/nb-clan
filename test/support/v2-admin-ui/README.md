# G06-A 管理空间独立运行器

运行器只用于 g06-parallel/1 的 A 分路隔离开发，不证明 G06-B/C、总入口或平台端到端通过。

```sh
node test/support/v2-admin-ui/dev.mjs --port 0
```

必须在本独立工作树根目录启动。默认端口 4326；`--port 0` 由 OS 分配。每次生成新的 `work/g06-a/runtime-*/data/nb-clan.sqlite`，拒绝已有 SQLite、主协调目录、目录软链接、额外环境键与低位端口。父启动器仅传白名单环境；没有 dotenv、真实平台密钥或生产配置。`NB_DISABLE_BACKGROUND_JOBS=1`，没有通知 worker/timer；Node 回环网络 guard 拒绝非本机外连。guard 是应用内防护，不是 OS 网络沙箱。

进入启动日志中的地址。未登录时点击“使用构造 Discord 身份登录”，在构造账号页选“值班管理员 · admin”。账号已具备构造 Steam 绑定；真实 G03 OAuth state/callback/finish、资格检查、会话 Cookie 与 CSRF 都会运行，平台身份/资格数据是构造适配器。其他已绑定成员可用来检查权限。仅本运行器向 IdentityService 显式注入一小时构造资格 TTL；不修改真实 G03 默认五分钟规则，也不在名单 GET 时刷新资格。没有真人外部登录验收。

独立 `entry.jsx` 创建本运行器唯一 React root 与唯一 G05 QueryClient；提供原 AppContext 字段、真实 bootstrap 和身份 SSE，复用 G05 UI/桌面外壳，并挂 `src/v2/admin/index.jsx`。不加载或修改公共 App 入口。侧栏成员空间入口只使用 `session.workspaces?.member === true`，缺少字段时隐藏，不从角色或成员绑定推断。`/app/home` 使用真实 G05 HomePage，方便检验返回成员空间。浏览器验收范围为 1440px 桌面。

## 实现边界

| 路径 | 实际实现 |
| --- | --- |
| `/api/v2/auth/**` | 真实 G03 router、会话与 CSRF；OAuth provider/资格为本地构造 |
| `/api/v2/wipes`、单档、summary、signups、commands、archives、`/operations/:id` | 真实 G04 router、SchedulingService、新 SQLite |
| `/api/v2/wipes/:id/history` | 主调度授权的真实只读 admin-history router，投影当前 SQLite G04 事件；输入哈希/排除增量记录见 `work/g06-a/history-input-baseline.json` |
| `/api/v2/bootstrap`、`/me/**` | 真实 G05 MemberSpaceRouter，同一新 SQLite |
| `/api/v2/admin/wipes`、`/admin/wipe-options` | A 的 B 协议替身，但档期/成员/小队读自真实 G03/G04 repository 与权限关系 |
| notification-options / previews / publish-intents / deliveries / notifications operations | `notification-double.mjs`；冻结 DTO、幂等、权限、revision、unknown 恢复的协议替身 |
| 预览渲染、平台 send/lookup 结果 | 构造结果，没有调用 C renderer/transport、B worker 或真实平台 |

所有通知接口回复 `X-G06-Notification-Implementation: contract-double; g06-parallel/1`；浏览器顶部常驻同样的隔离说明。通知状态持久保存在本次 SQLite 的独立 `g06AContractDouble` 表中，刷新页面保持同一意图与操作键。202 只产生 queued 目标，绝不自动标为 sent。只有受保护控制接口或明确管理员核实能改变投递结果；不能作为持久通知引擎/并发worker/平台可靠性验收。

G04 档期、报名、回执始终由实际 G04 服务维护。种子只构造一份草稿和一份已发布/报名开放场次、一份真实 G04 代报名；不把前端原型数组当权威。

## 控制与故障

`work/g06-a/runtime-latest.json` 指向本次私有 `runtime.json`。后者包含 `controlToken`，仅文件模式 0600 保存，禁止放入文档/公开证据/浏览器截图。Vite 明确拒绝 `work/**`、运行元数据、SQLite、`.env*` 等文件。控制请求必须满足本机连接、精确 Host、`Origin` 等于运行地址与 `x-g06-a-control` 等于该 token：

```
POST /api/v2/__fixtures/control
```

可在一次本地 Node 脚本内读取元数据、构建上述头部调用；不要打印 token、Cookie 或 CSRF。支持正文：

- `{action:'delivery',deliveryId,status:'sent',messageId:'synthetic-message'}`：构造已送达，messageUrl 始终 null，避免伪造成功链接。
- `{action:'delivery',deliveryId,status:'failed'}` 或 `status:'delivery_unknown'`：构造明确失败或结果未知。还支持 queued/sending/retry_wait/cancelled。
- `{action:'fault',method,path,mode,delayMs?}`：method 限 GET/POST/PUT/PATCH，path 限本次 v2 管理/档期/通知/操作路由。mode 为 delay、disconnect-before、disconnect-after、unavailable 或 not-found。每条故障仅消耗一次，按精确 method/path 匹配。
- `not-found` 可针对 `/api/v2/operations/:id` 或 `/api/v2/notifications/operations/:id` 构造临时 404；它不删除已提交记录，也不证明先前写未提交。
- `{action:'clear-faults'}` 清除未消耗的故障。
- `{action:'refresh-eligibility'}` 对全部已绑定构造成员的 Discord/KOOK 身份显式调用真实 `identity.checkEligibility`，结果来自本地 provider；可加 `fixture:'admin'` 限定成员。返回检查/过期时间与一小时 TTL，避免长浏览器验收因种子资格自然过期而人数减少。超过 TTL 仍会按真实 G04 规则排除过期成员，需手动再次调用这个受保护 POST，不设置后台刷新。
- `{action:'revoke',fixture:'admin'}` 真实撤销该构造账号作用域，触发真实会话失效；慎用，会中断当前浏览器会话。
- `{action:'inspect'}` 返回不含 bearer/CSRF/token 的 request trace、构造投递与 G04 回执概要、SQLite integrity。没有正文原文，只有命令 hash。

公开 fixture health/manifest 仅返回非秘密构造 ID 与就绪状态，不返回控制 token。

## 验证

```sh
node --test test/v2-admin-runtime-safety.test.js
node test/support/v2-admin-ui/verify-http.mjs /absolute/work/g06-a/runtime-XXX/runtime.json
node test/support/v2-admin-ui/build.mjs
```

`verify-http.mjs` 创建独立命名的 HTTP 验证草稿，运行真实构造登录，不复用浏览器会话。它注入精确单条故障，输出仅含脱敏 request 路径/状态/操作 ID 的 `http-verification.json`。不得把此 HTTP 检查标成浏览器验收。`http.jsonl`、数据库、Cookie、私有元数据留在 `work/`；公开证据只复制审阅后的脱敏报告。

Vite 文件监听明确排除本工作树 `work/**`、`output/test-results/**` 与 `dist/**`，构建产物和证据写入不会触发页面热重载。`node test/support/v2-admin-ui/verify-watch.mjs` 使用独立构造目录实测监听排除，并确认源码目录仍有监听事件。

构建输出只在 `work/g06-a/runtime-build/`。它验证独立入口可以编译，不改公共 Vite 配置或应用入口。停止时向启动命令发 SIGINT/SIGTERM，关闭 Vite/server 并 checkpoint SQLite；不操作任何生产服务。
