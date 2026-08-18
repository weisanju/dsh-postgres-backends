# dsh-postgres-backends

PostgreSQL durable backend family for DeepSeek Harness. Today: a third-party `SessionPersistence` provider satisfying the same contract as the official JSONL/SQLite backends (append-only, contiguous-seq, lazy materialization, interrupted-turn close on load), expressed over PostgreSQL rows instead of file bytes or `node:sqlite`. More PG backends (settings, …) land here over time.

独立第三方仓库，不改动 DeepSeek Harness 源码。通过 profile 的 `cordis.patch.yml` 替换默认持久化后端为 PostgreSQL。

## 特性

- **事件溯源不变**：每个 `SessionEvent` 映射一行 `events` 表，`data` 存 JSONB；`sessions` 表存 out-of-log metadata
- **追加 = 事务**：`BEGIN`/`COMMIT` 包住整批，中批失败整体回滚；单条 multi-row INSERT 批量写入
- **惰性物化**：首笔 `append` 才写 `sessions` 行（`list` 只报有行的会话）
- **崩溃恢复**：`load` 时合成关闭事件（`TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`）
- **NUL 安全**：DSH scope key 的 U+0000 经双层转义进出 JSONB（见下文）
- **异步驱动**：使用 `pg` 连接池，不阻塞事件循环（优于官方 SQLite 的同步 `DatabaseSync`）
- **跨机共享**：连远程 PostgreSQL 即可多机共享同一会话库

## 安装

### 1. 将本包加入 web profile

```bash
dsh plugin --profile web add dsh-postgres-backends
# 本地开发：dsh plugin --profile web add /home/weisanju/gitrepos/dsh-postgres-backends
```

### 2. 在 profile 补丁中替换默认 JSONL 后端

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
# 禁用默认 JSONL 后端
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-postgres
      name: 'dsh-postgres-backends'
      config:
        connectionString: 'postgres://postgres:postgres@localhost:5432/postgres'
```

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

> **同步方向补课**：迁移是**单向复制**，不是双向合并。JSONL 与 PG 是同一会话的两个事实源候选，但 DSH 的 append-only + 全局唯一 seq 模型不允许两侧同时各写各的（seq 冲突）。**同一时刻只有一个后端在写**：默认用法是"JSONL 权威、PG 定期增量同步副本"；切到 PG 后反过来跑 pg→jsonl 做备份/回滚，而不是双写。

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
pnpm test          # 需要本地 PostgreSQL（默认 postgres://postgres:postgres@localhost:5432/postgres）
pnpm typecheck
```

## 许可

MIT