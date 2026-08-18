# dsh-postgres-backends

PostgreSQL durable backend family for DeepSeek Harness. 两个后端：

- **`session-persistence-postgres`**：第三方 `SessionPersistence` 提供者，契约同官方 JSONL/SQLite 后端（append-only、contiguous-seq、惰性物化、load 时补关中断轮），落在 PostgreSQL 行而非文件字节或 `node:sqlite`。
- **`storage-postgres`**：第三方 `storage.backend` KV 后端，契约同官方 `storage-json`/`storage-sqlite`，一个数据库承载所有路由过来的 storage 域单元（workspace 注册表、message_feedback、session_projcache 等），文档行式（`key TEXT` / `value JSONB`）。

独立第三方仓库，不改动 DeepSeek Harness 源码。通过 profile 的 `cordis.patch.yml` 把默认持久化/存储后端替换为 PostgreSQL。

## 特性

- **事件溯源不变**：每个 `SessionEvent` 映射一行 `events` 表，`data` 存 JSONB；`sessions` 表存 out-of-log metadata
- **追加 = 事务**：`BEGIN`/`COMMIT` 包住整批，中批失败整体回滚；单条 multi-row INSERT 批量写入
- **惰性物化**：首笔 `append` 才写 `sessions` 行（`list` 只报有行的会话）
- **崩溃恢复**：`load` 时合成关闭事件（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`）
- **NUL 安全**：DSH scope key 的 U+0000 经双层转义进出 JSONB（见下文）
- **异步驱动**：使用 `pg` 连接池，不阻塞事件循环（优于官方 SQLite 的同步 `DatabaseSync`）
- **跨机共享**：连远程 PostgreSQL 即可多机共享同一会话库

### storage-postgres（KV 域存储）

- **文档行式**：每条 KV 记录一行 `kv_<unit>_<table>`（`key TEXT` 主键 / `value JSONB`），单元身份与全局分别存 `kv_units` / `kv_unit_globals`
- **与 session 表隔离**：`kv_` 前缀 + 独立 `kv_units` 注册表，与 `sessions`/`events`/`persistence_state`（带 store_id 版本戳）互不干扰
- **版本戳**：每个单元首次 open 时在 `kv_units` 盖版本号；版本不符抛 `version-mismatch`，防止 schema 漂移
- **NUL 安全**：KV value 同样走 `escapeNulText`/`unescapeNulText` 双层转义进出 JSONB
- **隔离迁移**：Console 迁移用独立 backend 实例（自有连接池，不挂运行时 hub），绝不与运行中的 `storage.backend` 注册表竞争

## 安装

### 1. 将本包加入 web profile

```bash
dsh plugin --profile web add dsh-postgres-backends
# 本地开发：dsh plugin --profile web add /home/weisanju/gitrepos/dsh-postgres-backends
```

### 2. 在 profile 补丁中替换默认 JSONL / JSON 后端

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# 禁用默认 JSONL 会话后端
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-postgres
      name: 'dsh-postgres-backends'
      config:
        connectionString: 'postgres://postgres:postgres@localhost:5432/postgres'
    # KV 存储后端（同一 PG 实例，独立 kv_* 表族）
    - id: storage-postgres
      name: 'dsh-postgres-backends/storage'
      config:
        connectionString: 'postgres://postgres:postgres@localhost:5432/postgres'

# 把 storage-domain 的默认后端从 json 路由到 postgres
# （patch 替换整行 config；routes 留空 = 全部域走 postgres）
- id: storage-domain
  config:
    backend: postgres
    routes: {}
```

> `storage-domain` 的 `Config { backend, routes? }`：`backend` 是默认路由，`routes` 按域覆盖。上面把默认改为 `postgres`、`routes: {}` 表示**所有域**都路由到 postgres。如需个别域保留 JSON，在 `routes` 里指明，如 `routes: { session_projcache: json }`。

### 3. 重启

```bash
cd <deepseek-harness-checkout> && dsh web --patch local-overlay.yml
```

## PG Console（设置页 UI）

包内附带一个可选的 **Settings 控制台**（默认不启用），在设置页提供：

- **连接配置**：host / port / user / password / database / poolMax 表单 + 测试连接 + 保存（存入 `settings.yaml` 的 `pg-backends` 命名空间，密码不回传浏览器）
- **会话迁移**：JSONL ⇄ PostgreSQL 双向迁移，支持预览（dry-run）与真实迁移；源只读、目标增量写、幂等可重跑

启用方式：在 profile 补丁的 `insert` 里加一行：

```yaml
- insert:
    - id: pg-console
      name: 'dsh-postgres-backends/console'
```

client 界面通过包的 `dsh.client` 声明自动挂载（设置页出现 "PostgreSQL Backends" section），API 走 `/pg-console/api/*`（受信 loopback 校验）。

> **配置存储**：连接配置存放在独立的 `~/.dsh/pg-console.json`（0600 权限），**不写入 settings.yaml**。原因：settings.yaml 顶层会被合并进每个 cordis 插件的 config，一个 `pg-backends` namespace 块会污染同名插件（哪怕只有部分字段、缺 password）导致主 PG 后端 `client password must be a string` 崩溃。独立文件彻底规避。

HTTP API（与 UI 等价，可脚本化）：

```bash
# 测试连接
curl -X POST http://127.0.0.1:3081/pg-console/api/connection.test \
  -H 'content-type: application/json' \
  -d '{"config":{"host":"localhost","port":5432,"user":"postgres","password":"postgres","database":"postgres"}}'
# → {"ok":true,"value":{"ok":true,"latencyMs":6}}

# JSONL → PG 真实迁移（dryRun:true 仅预览）
curl -X POST http://127.0.0.1:3081/pg-console/api/migrate.start \
  -H 'content-type: application/json' \
  -d '{"direction":"jsonl-to-pg","config":{"host":"localhost","port":5432,"user":"postgres","password":"postgres","database":"postgres"},"dryRun":false}'
```

> 迁移只**复制**不删除：源保持原样。迁移是**事件级增量**的——每次运行读取目标已提交的 seq 长度，只追加源中多出来的后缀（依赖 append 的 contiguity 校验保证 seq 连续无空洞），所以：
> - 已完全同步的会话标记 *target is up to date*（零写入）
> - 源在迁移过程中继续增长（如生产实例仍在写 JSONL）时，本次缺的尾部由下一次运行补上（标记 *source changed mid-run*）
> - 迁移期间 PG 后端会分块插入（单事务内 4000 事件/批，规避 PostgreSQL 单条 INSERT 的 65535 绑定参数上限）

> **冲突处理策略**（UI 下拉或 API `onConflict` 字段，默认 `skip`）：
> - `skip`（默认）：目标已有 → 不写；目标比源多 → 报告 *target is ahead by N events*（方向感知差异提示），**绝不删除目标**；目标比源少 → 增量续传
> - `overwrite`：目标已有且与源不齐 → **整会话重建**（先删目标行再用源全量重建，目标变成源的精确副本）。**仅 PG 为目标时支持**；反向（pg→jsonl）会拒绝，保护生产 JSONL 侧不被删除
> - `clone`：目标 id 已存在 → 以 `原id-clone` 的新身份完整导入（seq 0..N 连续），目标原有副本保持不动

> **同步方向补课**：迁移是**单向复制**，不是双向合并。JSONL 与 PG 是同一会话的两个事实源候选，但 DSH 的 append-only + 全局唯一 seq 模型不允许两侧同时各写各的（seq 冲突）。**同一时刻只有一个后端在写**：以 PG 为主后，PG 是权威、JSONL 只是历史（或手动 pg→jsonl 做备份/回滚）；反过来当 JSONL 是权威时，手动跑 jsonl→pg 增量同步副本。迁移**总是手动触发**——这是有意为之：自动周期同步会掩盖"何时切换"这个决定。

### Storage 域迁移（JSON ⇄ PostgreSQL）

Console 设置页还提供 storage 域的**双向迁移**（`~/.dsh/storages/*.json` ⇄ `kv_*` 表），用于把默认 `storage-json` 的数据迁到 `storage-postgres`（或反向回滚/备份）。同样支持 dry-run 预览与 `skip`/`overwrite` 冲突策略。源只读、不删。

HTTP API：

```bash
# 列出两侧单元清单（json 侧 ↔ pg 侧：版本/记录数/是否有 global）
curl -X POST http://127.0.0.1:3081/pg-console/api/storage.list \
  -H 'content-type: application/json' \
  -d '{"config":{"host":"localhost","port":5432,"user":"postgres","password":"postgres","database":"postgres"}}'

# JSON → PG 真实迁移（dryRun:true 仅预览；onConflict: skip|overwrite）
curl -X POST http://127.0.0.1:3081/pg-console/api/storage.migrate \
  -H 'content-type: application/json' \
  -d '{"direction":"json-to-pg","config":{"host":"localhost","port":5432,"user":"postgres","password":"postgres","database":"postgres"},"dryRun":false,"onConflict":"skip","rebootstrap":true}'
```

> **`rebootstrap`（仅 json→pg、仅 workspace 单元）**：把 PG 侧 `workspace` 单元的 global 改写为 `initialized: false` + 清空 `workspaceIds`。下次启动 `WorkspaceRegistry.bootstrap()` 会用当前 `sessionPersistence.list()`（现在已是 PG 会话）**重建**每个 workspace 的 `sessionIds`——这正是修复 Web UI 侧边栏 "Ungrouped sessions" 的机制：旧 `workspace.json` 里陈旧的 `sessionIds` 数组被清掉，按 cwd 重新分组归位。

> 迁移后需**重启 dsh**：`storage-domain` 路由到 postgres 是启动期读 config 决定的，运行中不切换；重启后才走 PG 读新数据。JSON 源文件不删（与 session 迁移同政策，留作回滚备份）。

> 迁移用**隔离** backend 实例（自有连接池，不注册到运行时 hub），不会与运行中正开着的 workspace 域竞争。

## 配置项

| 键 | 必填 | 默认 | 说明 |
|----|------|------|------|
| `connectionString` | 否 | — | PG 连接串（`postgres://user:pass@host:port/db`）；不填则用下方 host/port/user/password/database |
| `host` / `port` / `user` / `password` / `database` | 否 | localhost / 5432 / postgres / postgres / postgres | 独立连接参数（未提供 `connectionString` 时使用） |
| `poolMax` | 否 | 10 | 连接池最大客户端数 |
| `connectionTimeoutMillis` | 否 | 0 | 取连接超时（毫秒）；0 = 无限等待（pg 默认）。建议设有限值，避免 PG 挂起时 `connect()` 无限阻塞 |
| `preparedSessionCacheSize` | 否 | 5 | 保留的冷会话准备数 |
| `writeBatchMaxDelayMs` | 否 | 200 | 批量写入合并窗口 |
| `schema` | 否 | 当前用户 | 表所在 schema |

## 表结构（自动创建）

```sql
CREATE TABLE IF NOT EXISTS persistence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  created_at       BIGINT NOT NULL,
  cwd              TEXT,
  parent_session   TEXT,
  seed_length      INTEGER,
  origin           TEXT,
  delegation_depth INTEGER,
  agent_preset     TEXT,
  incarnation      TEXT NOT NULL,
  revision         BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL,
  type              TEXT NOT NULL,
  time              BIGINT NOT NULL,
  data              JSONB NOT NULL,
  source_event_seqs JSONB,
  surface_op        JSONB,
  ignorable         INTEGER,
  PRIMARY KEY (session_id, seq)
);
```

### storage-postgres 表族（自动创建）

```sql
CREATE TABLE IF NOT EXISTS kv_units (
  name    TEXT PRIMARY KEY,
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv_unit_globals (
  unit  TEXT PRIMARY KEY REFERENCES kv_units(name),
  value JSONB NOT NULL
);
-- 每个单元的每张表:
CREATE TABLE IF NOT EXISTS kv_<unit>_<table> (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
```

单元/表名经 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 校验后才进标识符（防注入）；记录 key 是参数化绑定，任意字符串。`kv_units` 的版本行在 `open` 时用 advisory-lock 事务 insert-or-check，并发进程不会竞争。

## NUL 转义（为什么有这个设计）

DSH 的 agent-instructions 事件数据里，`source.changes[].scope` 用 **真实 NUL（U+0000）** 拼接
"目录 + 文件名"作为对账 key（如 `".\u0000AGENTS.md"`，NUL 是 POSIX 文件名唯一保证不出现的字符）。
JSONL 文件后端能原样存储；但 PostgreSQL 的 `text`/`JSONB` **不允许 NUL**，直接写入会报
`SQLSTATE 22P05`、`"\u0000 cannot be converted to text"`，症状表现为每轮对话
"本轮运行失败：unsupported Unicode escape sequence"。

因此本插件在 JSONB 边界做**双层转义**（不影响 DSH 本体）：

- 写入：真实 NUL → 6 字符字面量 `\u0000`；原文字面量 `\u0000` → 7 字符 `\\u0000`
  （防止解码时把用户原本的 `\u0000` 文本误还原成 NUL）；对象**键**同样转义
- 读出：`rowToEvent` 里反向还原（`\\u0000` → 原样，`\u0000` → 真实 NUL）

实现见 `src/schema.ts` 的 `escapeNulText` / `unescapeNulText`，测试见
`tests/pg.spec.ts` 的 "round-trips NUL bytes" 用例。

## 已知边界

- **`events_session_id_fkey`（外键违规）**：`events.session_id → sessions(id) ON DELETE CASCADE`。
  正常写入顺序安全（`appendBatch` 在同一事务先物化 `sessions` 行再插 `events`）。若
  `sessions` 行被**外部删除**（手动 `DELETE`/`TRUNCATE`），CASCADE 会连带清空该会话的
  events，此时`appendBatch` 报 `23503 foreign_key_violation` 上抛（不静默自愈——自愈
  补行会留下 seq 空洞，导致下次 `load` 报 corrupt）。处理：清库时连 events 一起清，
  并**重启实例**让协调器重新从库 adopt。
- **连接中断**：空闲连接被 PG 断开（重启/网络分区）时 pooled client 报错，进程不会崩溃
  （`pool.on('error')` 只记日志），下一个 `acquire` 自动新建连接自愈。

## 开发

```bash
pnpm install
pnpm test          # 需要本地 PostgreSQL
pnpm typecheck
```

测试套件使用**独立的 `dsh_test` 数据库**，绝不连接生产库。具体：

- 默认目标：`postgres://postgres:postgres@localhost:5432/dsh_test`，首次运行时由 `tests/helpers/db.ts` 连到维护库 `postgres` 自动 `CREATE DATABASE`。
- 覆盖：设 `DSH_PG_TEST_CONN=postgres://...` 指向自定义测试库。
- 各 spec 的 `beforeEach` 会 `DROP TABLE ... CASCADE` 自己负责的表（session 表或 `kv_*` 表），所以测试间互不干扰；`fileParallelism: false` 保证串行。

> ⚠️ 不要把测试指向生产数据库。历史版本曾硬编码 `5432/postgres`，跑测试会 `DROP` 掉生产会话表，触发 `events_session_id_fkey` 外键错误。现版本已隔离修复。

## 许可

MIT