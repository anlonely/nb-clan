# G06 本场操作历史

`createAdminHistoryRouter()` 从 `routes.js` 导出，由 root 在 `/api/v2`、G03 identity middleware 之后注册。它只增加 `GET /wipes/:id/history`，不改写 G04 事件、不安装 schema、不启动后台任务。`AdminHistoryService(identity, options).list(actor, wipeId, query, options)` 可供独立本地检查使用，所有查询共用 `identity.repo.db` 的 `SchedulingRepository`。

接口采用 `docs/V2_G06_PARALLEL_CONTRACT_ADDENDUM_02.md` 冻结的完整 DTO。普通成员的 `wipes.read` 不足以打开管理历史；需要本场任一 edit/publish/start/end/archive/delegate 权限。报名事件的 subject `signups.read` 在 SQL 的 LIMIT 前过滤，读取后的同一 scope resolver 再复核。`members.read` 单独决定当前展示名，标签不是历史姓名快照。没有全场总数或隐藏条数。

默认 20、上限 50 条。`createdAt DESC,id DESC` keyset 加首次本场不可变事件的最大 rowid，固定这次分页的事件集合；同毫秒新记录不会混入旧页。游标采用 AES-GCM 隐藏内部水位、账号和边界事件，不向客户端暴露被过滤记录的标识或行数。账号、权限版本、当前 scopeDigest、wipeId、过滤/排序/schema 和五分钟期限全部绑定；不会因为普通新报名改变全局 rosterRevision 而失效。边界事件的 rowid/hash 被重建或改写时返回 `CURSOR_EXPIRED`。

HTTP 路径使用服务端进程内随机密钥；进程重启、换账号、过期或篡改时明确返回 `CURSOR_EXPIRED`，前端应清游标重读。空 `cursor=` 与未提供游标一样读取首屏。直接调用 service 可显式注入服务端专用 `cursorSecret`，但本模块不安装或持久保存密钥；不得使用浏览器知道的 CSRF token 或其可计算哈希作为密钥。密钥、令牌、原始 before/after、操作/账号/成员 ID 不进入 DTO。

历史服务和 router 自身没有任何数据库写入，读 savepoint 保持权限、水位和本页在同一快照。G03 认证模块仍执行已有的新鲜度/撤权逻辑；其必要的资格刷新不被历史模块绕开。无写验证使用已通过 G03 的有效 password 会话和 `PRAGMA query_only=ON`，单独记录认证边界。

root 负责总入口挂载及真实管理浏览器验收。A 使用 `['admin-history', wipeId, cursor]`；出现 `CURSOR_EXPIRED` 清游标重读。通知记录仍从 B 的意图/投递接口读取。
