# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.8.6] - 2026-07-10

v0.8.5 4 大模块 (tool 错误维度 / 全局 tool 聚合 / G1/G2 切 DB / count 透出) + TEST GAP 后,
本版本 v0.8.6 收口遗留 + 修 HIGH bug:

1. **C 补完(A)** — GraphView 派生 `AttemptedFix` + `Spawned` edges (4 总 edges)
2. **TEST GAP 收口(B)** — overridesStore / ToolsRoute / sync_helpers 测试 (17 个新增)
3. **HIGH bug 修(D)** — `export_overrides` 隐私泄漏 + `sync_state` last_error 永不写
4. **tool_global_stats 增量(C) — 推迟**: 当前 TRUNCATE + 全量重算在 <10K session 时 <50ms,
   大 dataset (>10K) 时才需要。架构已就绪 (事务 atomic + 索引齐), v0.8.7+ 等数据上来再优化。

### 新增

#### 1. GraphView edges 派生补完(item A — v0.8.5 C 补完)

v0.8.5 C (commit 626e61b) 只派生 `UsedTool` edges, 4 种其它 edges 暂空。这次补完可从
session_meta 现成数据派生的两种:

- **`AttemptedFix`** — `error_count > 0` 时派生 1 个 edge
  - `{type: "AttemptedFix", session: "<sid>", error_count: N}`
  - 数据源: `session_meta.error_count` (v0.8.4 item 2 固化)

- **`Spawned`** — 每个 subagent_id 派生 1 个 edge
  - `{type: "Spawned", from_session: "<sid>", to_subagent_id: "agent-xxx", to_subagent_path: None, description: None}`
  - 数据源: `session_meta.subagent_ids_json`
  - `to_subagent_path` 暂时 `None` — 需要 SessionSubagentMeta 表 (v0.8.7+)

仍不能派生 (需要 session_meta 加列):

- `ParentUuid` — 需要 parent_uuid 列
- `CrossSession` — 需要 parent_session_id 列
- `is_subagent_root` / `parent_session_id` 派生 — 也需新列

#### 2. TEST GAP 收口 (item B)

覆盖 v0.8.4 / v0.8.5 CHANGELOG 已挂的 TEST GAP:

**rust** (2 新):

- `db/schema.rs::sync_helpers_tests`:
  - `get_size_mtime_returns_none_for_missing_path`
  - `get_size_mtime_returns_row_for_existing_path`

**frontend** (15 新):

- `overridesStore.test.ts` (7): refresh 调 invoke / setTitle / toggle\* / getTitle / errors
- `routes/ToolsRoute.test.tsx` (8): toolStatsStore load / setSortBy / reload + 数据 shape

未做 (留给 v0.8.7+):

- `db/sync.rs` 仍 0 tests (sync_once 整体行为需要 mock AppState)
- `SessionsRoute` listen 回路 (需要 mock Tauri invoke + listen + React mount)
- `SearchPalette` / `DatabasePanel` component tests

### 修复

#### 3. export_overrides 隐私泄漏 (item D1 — HIGH)

之前 `export_overrides` 命令把所有 override 维度都写入导出文件,包括用户私有字段
(`hidden` / `archived` / `notes`)。例如用户笔记 "这个 session 是失败实验,标记为 hidden"
会被导出后,泄露隐私。

**修复**: 加 `include_private: Option<bool>` 参数 (默认 `false`), 默认导出**只**含公开字段
(`renames` / `tags` / `links` / `pinned`), 隐私字段 `hidden` / `archived` / `notes` 仅
`include_private: true` 时导出 (debugging 用)。

```ts
// 前端 API
apiExportOverrides(path: string, includePrivate: boolean = false)
```

#### 4. sync_state last_error 永不写 (item D2 — HIGH)

之前 `sync_once` 末尾 `INSERT INTO sync_state (...) VALUES (1, ?1, ?2, ?3, 0)` 没写
`last_error` 字段,即使 sync 失败 (`failed > 0`) 也写 NULL。结果 `HomeStatusBar` 显示
"上次同步 X 分钟前", 不显示"上次同步 X 分钟前 · 失败 Y", 用户看不出来 sync 失败过。

**修复**: 加 `last_error` 字段到 INSERT/UPDATE, `failed > 0` 时写 `"N 个文件 sync 失败"`。
`HomeStatusBar` 现在能展示真错。

### 性能

无新 perf 改动。

### UI 改进

无新 UI 改动 (v0.8.5 已 4 大模块均有 UI 落地)。

### 测试

- `cargo fmt -- --check`: clean
- `cargo clippy --all-targets -- -D warnings`: clean
- `cargo test --lib`: **150/150** (v0.8.5 148 + 2 sync_helpers new)
- `pnpm typecheck`: clean
- `pnpm -r test`: **509/509** (v0.8.5 492 + 17 overridesStore/ToolsRoute new)
- `pnpm --filter @ocsv/frontend build`: ✓

### Dev manual 验证清单(6 步)

1. `/tools` 排序切换 (calls / sessions / errors) — 仍正常工作 (v0.8.5 B)
2. 打开含 Bash-heavy session, header `🔴 失败最多: Bash × N` (v0.8.5 A)
3. `/graph` G1 GraphView 选中含 subagent 的 session — 现在显示 `Spawned` 边 (v0.8.6 A)
4. `/graph` G1 GraphView 选中含 error 的 session — 现在显示 `AttemptedFix` 边 (v0.8.6 A)
5. SettingsRoute "导出 overrides" 按钮: 默认导出的 JSON **不** 含 hidden/archived/notes
   (v0.8.6 D1); 调试用 `includePrivate=true` 可导出全部
6. 故意触发 sync 失败 (e.g. 改坏一个 jsonl path), sync 后 HomeStatusBar 显示真错
   "X 个文件 sync 失败" (v0.8.6 D2)

### 已识别但仍未修(v0.8.7+ 候选)

- **HIGH:** `Mutex<Connection>` 串行化读 / `notify_waiters` coalescing 丢命令 / 每文件 emit 风暴
  / `scan_live_pids` per-file 10× 慢 / `PRAGMA WAL` 失败静默 / GraphView ParentUuid + CrossSession
  edges (需 session_meta 加 parent_uuid / parent_session_id 列) / SessionSubagentMeta 表
  (给 Spawned edge 填 to_subagent_path + description)
- **MEDIUM:** placeholder jsonl_path UNIQUE 移动文件炸 / `GROUP_CONCAT` 撞 tag 名字逗号
  / `save_settings` 任何字段修改触发 re-walk / `refresh_sessions` 触发即返旧值 / sid 输入验证
  / `list_overrides` 全量含 hidden/archived 浪费 IPC / `add_session_link` OR REPLACE 改 created_at
  / `apply_notes` Keepboth IS NOT NULL 含空串
- **PERF:** `findIdleGaps` 单遍 O(n) 在反复倒序/正序切换时仍卡主线程
  / `tool_global_stats` 全量 rebuild 在 >10K session 时的延迟 (架构已就绪, 改增量维护 ~20 行)
- **TEST GAP:** `db/sync.rs` / `SessionsRoute` listen 回路 / `SearchPalette` / `DatabasePanel`
  / `graphStore.test.ts` (切 DB 后) 仍 0 tests
- **SCALE:** G2 chart 8 个 query 函数单测 (`analytics.ts` 改写时一起补)

## [0.8.5] - 2026-07-09

v0.8.4 把 19 列派生数据固化到 `session_meta` 后, 用户要求"充分发挥数据库优势, 夯实工具能力" — 本版本深挖 tool 维度, 4 件事:

1. **per-tool 错误**(A) — `error_count` 之前只数整条 assistant 失败, 不区分是哪个 tool
2. **跨 session tool 聚合**(B) — 新表 + 新路由 `/tools`, 全局工具排行/失败/时间线
3. **G1/G2 NDJSON → DB 切**(C) — 关闭 M3 兜底, `graphStore` 走 `list_graph` command
4. **toolUsage count 透出**(D) — ContentFilterPanel chip 显示 `${tool} × N`, SessionSummaryStrip 占比 %

Plus 收口 v0.8.4 CHANGELOG 已挂的 `db/schema.rs` 0 tests。

### 新增

#### 1. tool 错误维度(item A)

之前 `error_count` 是 assistant message 级(`stop_reason=="error"` 或 `message.is_error`), **不区分是哪个 tool 失败**; `tool_result.is_error` 在 `NormalizedBlock` 已解析但没沉淀到 DB。

- DB: `session_meta.tool_error_json` 列(per-tool 失败计数, 紧凑数组 `[["Bash", 3], ...]`)
- 后端: `parser/meta_extras.rs` 单遍扫描 — assistant 阶段 `tool_use` 时把 `id → name` 记到 HashMap, user 阶段扫 `tool_result.is_error` 查 map 累加 per-tool error count
- migrations `ensure_columns` 扩 1 项
- SessionDetailRoute header 加 `🔴 失败最多: Bash × 5` badge
- `transcriptFilterStore.errorMode: "all" | "errors" | "no_errors"` + ContentFilterPanel 加 "失败" 维度 3 chip
- `lib/filterEntries.ts` 加 `errorMode` 过滤, `entryHasToolError` helper

跟 `errorCount` 正交: `errorCount` 数整条 assistant 失败, `toolError` 数单个 tool 调用失败, UI 同时显示互补。

#### 2. 全局 tool 聚合层(item B)

之前没有任何"跨 session 工具聚合" command/表。G2 Analytics "top_tools" chart 走 NDJSON, 用户看不到失败维度。

- DB: 2 新表 — `tool_global_stats`(tool_name PK + total_calls / session_count / error_count / first/last_seen_ms)+ 3 索引(calls / errors / sessions DESC);`tool_session`(反范式 `(session_id, tool_name) → call_count + error_count + last_ts_ms`)+ 2 索引
- 后端: `commands/tool_stats.rs` 新 mod, 3 commands — `get_tool_aggregate(sort_by?, limit?)` / `get_tool_sessions(tool_name, limit?)` / `rebuild_tool_stats`
- `db/sync.rs::sync_once` 末尾调 `rebuild_tool_global_stats` (事务内 TRUNCATE + 全量重算)
- 前端: `/tools` 路由 — 总览排行(sort_by calls/sessions/errors 切换)+ 单 tool 跨 session section
- `state/toolStatsStore.ts` + `listen("sessions-updated")` 自动 reload
- `SessionsRoute` header 加 Wrench icon 跳 `/tools`

聚合层**不增量** — 每次 sync 末尾 TRUNCATE 两张表 + 从 `session_meta.tool_usage_json` / `tool_error_json` 全量重算。事务 atomic, 用户永远看不到中间状态。Session 数 <10K 时几条 SQL 跑完, 性能可接受。

#### 3. G1/G2 NDJSON → DB 切(item C)

`graphStore.ts:25-37` 注释 "M3 阶段: 切换到 apiListGraph() (Tauri invoke)" — M3 一直未做, `loadNdjson("/sessions.ndjson")` 仍兜底。

- 后端: `commands/graph.rs::list_graph` command — 读 `session_meta` 派生 `GraphNodeFE` (22 字段, 含 firstPrompt / tokenTotal / thinkingCount / topTools / errorCount / subagentCount / subagentIds / agentId 等)
- UsedTool edges 从 `session_meta.tool_usage_json` 派生
- 其它 edges (Spawned / ParentUuid / AttemptedFix / CrossSession) 暂时空, **v0.8.6+ 补完** (需要 subagent 关联扫描 + parent_uuid 跨 session 扫描)
- `is_subagent_root` / `parent_session_id` 暂时 default (`false` / `None`), v0.8.6+ 派生
- 前端: `graphStore.load()` 切到 `apiListGraph()`, 加 `reload()` action
- `lib/overridesApi.ts` 加 `apiListGraph` wrapper

**Analytics 8 chart 仍跑得起来**(它们只读 `GraphEntry.node` + UsedTool edges):

- `topToolsBar` / `toolsByCategory` — 用 UsedTool edges (有)
- 其它 6 chart — 用 node 字段 (有)
- **G1 GraphView 暂时退化**: 只显示孤立 node (没 force graph lines), v0.8.6+ 补完 edges 后恢复

#### 4. toolUsage count 透出 + UI 增强(item D)

`v0.8.4` 把 `toolUsage` 从 DB 读出来后, 前端两个地方丢掉 count: `TranscriptView.tsx:94 .map(([tool]) => tool)` 让 ContentFilterPanel chip 只显示名字; `SessionSummaryStrip` 显示 × count 但无占比 %。

- `ContentFilterPanel.availableTools`: `string[]` → `Array<[string, number]>` tuple, chip 渲染 `${tool} × ${count}`, title 包含 "(共 N 次)"
- `TranscriptView.availableTools` useMemo 返回 tuple (DB 优先, fallback 也按 count desc 排 + localeCompare tie-break)
- `SessionSummaryStrip` top 5 加 `(count / totalCalls * 100)%` 占比显示, 新加 `.ss-tool-pct` CSS (小字号 0.85em, 0.65 opacity)

### 性能

无新 perf 改动 (v0.8.4 已经有 3 个 perf)。

### UI 改进

- `ContentFilterPanel` 加 "失败" 维度 (3 chip)
- `SessionSummaryStrip` top 5 显示占比 %
- `SessionDetailRoute` header 加 `🔴 失败最多: Bash × 5` badge (v0.8.5 A)
- 新 `/tools` 路由(v0.8.5 B)

### 修复

无新 bug fix。`build_meta_full` 跟 `parser/blocks/tool_use.rs` 的 alias 脱节 (v0.8.4 修过) 继续保留。

### 测试

- `cargo fmt -- --check`: clean
- `cargo clippy --all-targets -- -D warnings`: clean (含 tool_stats / graph / rebuild_tool_global_stats)
- `cargo test --lib`: **148/148**
  - v0.8.4 baseline 121
  - v0.8.5 A 新增 2 (meta_extras captures_tool_error_per_tool + tool_error_unknown_tool_use_id_skipped)
  - v0.8.5 B 新增 6 (migrations ensure_tables_creates_new_tables + idempotent + schema rebuild_aggregates_basic / rebuild_clears_stale_data / rebuild_handles_empty_db / rebuild_writes_tool_session_rows)
  - v0.8.5 E 新增 4 (schema round-trip tool_usage_json / tool_error_json / enrich_session_meta_writes_all_columns / enrich_session_meta_handles_none_fields)
  - 其它既有 15 tests
- `pnpm typecheck`: clean
- `pnpm -r test`: **477/477** (33 files, 含 ContentFilterPanel 显示 count + filterEntries errorMode 4 case + SessionDetailRoute stat-tool-error badge)
- `pnpm --filter @ocsv/frontend build`: ✓

### Dev manual 验证清单(8 步)

1. 首页: 状态栏 (v0.8.4 item 1) 仍工作
2. 顶栏点 Wrench icon 跳 `/tools` — 总览排行 (默认按 calls 降序)
3. `/tools` 切 sort_by = "失败次数" — 验证 top 切换正确
4. `/tools` 点选某 tool 行 — 展开 "跨 session" section, 列 N 个 session 用过此 tool
5. 打开一个 Bash-heavy session, SessionDetailRoute header 显示 `🔴 失败最多: Bash × N`
6. ContentFilterPanel chip 显示 `Bash × 286 · Read × 50` (v0.8.5 D)
7. SessionSummaryStrip top 5 显示 `Bash 286 76% · Read 50 13%` (v0.8.5 D)
8. ContentFilterPanel 加 "失败" chip 选 "仅失败" — 只显示含 `tool_result.is_error` 的 entries
9. `/graph?view=analytics` — 8 chart 仍能跑 (数据源从 NDJSON 切到 DB)
10. 新 DB (delete observer.db, restart): `ensure_columns` + `ensure_tables` 跑, schema 完整
11. 老 v0.8.4 DB: `ensure_columns` 升级 20→21 列 (tool_error_json), `ensure_tables` 建 2 新表 + 7 索引, 数据不丢失

### 已识别但仍未修(v0.8.6+ 候选)

- **HIGH:** `Mutex<Connection>` 串行化读、notify_waiters coalescing 丢命令、每文件 emit 风暴、scan_live_pids per-file 10× 慢、`export_overrides` 包含 hidden + notes(隐私泄漏)、last_error 永不写、PRAGMA WAL 失败静默
- **MEDIUM:** placeholder jsonl_path UNIQUE 移动文件炸、GROUP_CONCAT 撞 tag 名字逗号、save_settings 任何字段修改触发 re-walk、`refresh_sessions` 触发即返旧值、sid 输入验证、`list_overrides` 全量含 hidden/archived 浪费 IPC、`add_session_link` OR REPLACE 改 created_at、apply_notes Keepboth IS NOT NULL 含空串、**G1 GraphView 缺 Spawned/ParentUuid/AttemptedFix/CrossSession edges (v0.8.5 C partial 留下), `is_subagent_root` / `parent_session_id` 没派生**
- **PERF:** `findIdleGaps` 单遍 O(n) 在反复倒序/正序切换时仍卡主线程, 根治需 web worker 或增量累加;`BTreeSet` 字典序跟 `tool_usage_json` 频次降序不一致
- **TEST GAP:** `db/sync.rs` 仍 0 tests (M2 后没补); frontend `overridesStore` / `SearchPalette` / `DatabasePanel` / `SessionsRoute listen 回路` 仍 0 tests; v0.8.5 B 的 `ToolsRoute.test.tsx` 仍没加 (UI 已有, 测试延后)
- **SCALE:** `tool_global_stats` 整表 TRUNCATE + 重算在 >10K session 时可能慢, v0.8.6+ 改增量维护

## [0.8.4] - 2026-07-09

v0.8.3 修好 refresh storm 后,用户要求把"实施那行数据统计 + 筛选条件"全部固化到 DB,同时关 5 个 UI 缺口(状态栏、file_snapshot 折叠、6 个 meta 类型无 UI、agent_name 不可见、TranscriptView 倒序卡)。本版本纯增量 — DB schema 扩 19 列(全部走 `ALTER TABLE` idempotent migration)、3 个新前端组件、6 个新 parser handler、3 个 perf 改动。

### 新增

#### 1. HomeStatusBar(item 1)— 替代 transient SyncBanner

之前 SyncBanner 是浮动 toast,消失后用户看不到"上次同步什么时候 / 是否失败 / 文件数 / DB 大小"。新版 `packages/frontend/src/components/HomeStatusBar.tsx` 永久 pill 在首页:

- pill 颜色: **绿**(60s 内) / **黄**(1-10 min) / **红**(>10 min 或有 error 或 synced < seen) / **蓝转**(inProgress)
- pill 字段: 时间 · 文件数 · failed 数 + ↻ 手动刷新 + ▼ 展开
- 展开面板: lastRunAt / idle 状态 / seen / synced / failed / last error / DB size / DB path + "重建数据库" 按钮
- 数据来源: `apiGetSyncStatus()` + 新增 `apiGetDbPath()` + `useSessionsStore.refresh()`
- `SyncBanner.tsx` / `SyncBanner.css` 完全删除,`App.tsx` 不再挂载
- `get_db_path` 新 Tauri command 在 `commands/overrides.rs`(同 sync utilities 分类)

#### 2. SessionSummaryStrip + 头部 stats 全读 DB(item 2 + 2' + 5)

之前 `SessionDetailRoute` 每次进入都调 `summarizeSession(entries)` / `findRepeatRuns(entries, 3)` / `findIdleGaps(entries, 5min)`,全量 O(n) 扫 transcript。新版所有 chip 跟数字都从 `session_meta.*` 读,前端不再 walk entries:

| 字段                                                                                                           | 来源                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `toolUsage` (top N)                                                                                            | `session_meta.tool_usage_json` (紧凑数组 `[["Bash",286],...]`) |
| `phaseHint` / `phaseDetail`                                                                                    | `session_meta.phase_hint` / `phase_detail`                     |
| `textMessageCount`                                                                                             | `session_meta.text_message_count`                              |
| `repeatRunCount` / `repeatRunMaxTool` / `repeatRunMaxCount`                                                    | 3 列,给 chip 显示 + tooltip                                    |
| `idleGapCount` / `idleGapMaxMs`                                                                                | 2 列,给 chip 显示                                              |
| `errorCount` / `userMessageCount` / `assistantMessageCount`                                                    | 3 列,头部 stats                                                |
| `durationSeconds` / `firstResponseLatencyMs`                                                                   | 2 列,头部 stats                                                |
| `agentName`                                                                                                    | 静态 pill 显示在 `<h1>` 下方,**无 click handler** — 见 (5)     |
| `invokedSkillsCount` / `planFileRefCount` / `compactFileRefCount` / `queuedCommandCount` / `attachedFileCount` | 5 个 meta 类型计数,头部 compact badge                          |

**sync 二阶段 enrich**(`db/sync.rs:sync_once`): 同步成功的 jsonl 末尾跑 `build_meta_full`(cap 5000 行)→ `enrich_session_meta` UPDATE 19 列。quick path(头部 50 行)算 `textMessageCount` + `toolUsage`,用户立刻看到;`phaseHint` / `repeatRun*` / `idleGap*` 走 enrich,等 ~1s 后才能看到完整 chip。

**Schema migration**(`db/migrations.rs`): `PRAGMA table_info(session_meta)` + `ALTER TABLE ADD COLUMN`,idempotent,无 `user_version`。3 个测试:`ensure_columns_adds_missing` / `preserves_existing_rows` / `idempotent`。

**新模块** `parser/meta_extras.rs`:`build_meta_full(path) -> MetaExtras`,跟 `parser/blocks/tool_use.rs` 共享 `pub const TOOL_USE_ALIASES` 顶层 const(修 OpenClaw `toolCall` 类型抓不到的脱节 bug,见下)。

#### 3. ContentFilterPanel chip 走 DB(item 2'')

`TranscriptView.availableTools` 优先 `meta.toolUsage.map(([tool]) => tool)`,`availableModels` 优先 `meta.availableModels`。enrich 没跑完前(~1s)走 entries 派生 fallback,用户立刻看到 chip;enrich 跑完后切到 meta.\*,不再触发 entries scan。

- `available_models_json` 用 `BTreeSet<String>` 自动字典序(去重 + 排好序),紧凑数组 `["claude-opus-4-8","claude-sonnet-5-20251001"]`
- `TranscriptView` 接收 `meta?: SessionMeta` prop,从 `SessionDetailRoute` 透传

#### 4. 6 个 meta 类型独立 block handler + 渲染(item 4)

之前 `invoked_skills` / `plan_file_reference` / `compact_file_reference` / `file` / `queue-operation` / `queued_command` 全部掉进 catch-all `kind:"meta"` 卡片(显示"Unknown")。新版每种都有独立 handler:

| Type                          | Module                             | 渲染                                                    |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `invoked_skills`              | `blocks/invoked_skills.rs`         | skill names as `<code>` chips                           |
| `plan_file_reference`         | `blocks/plan_file_reference.rs`    | filename + FilePathClickable, content preview 500 chars |
| `compact_file_reference`      | `blocks/compact_file_reference.rs` | filename + FilePathClickable                            |
| `file` (attachment)           | `blocks/attached_file.rs`          | filename + FilePathClickable + content-type label       |
| `queued_command` (attachment) | `blocks/queued_command.rs`         | prompt preview 100 chars + command-mode badge           |
| `queue-operation` (top-level) | `blocks/queue_operation.rs`        | small badge `enqueue` 橙 / `remove` 灰                  |

`parser/blocks/mod.rs` 默认注册(在 `MetaBlockHandler` 之前)。`queue-operation` 特殊:出现在 top-level,`parser/claude.rs` `normalize()` 加 arm。

`MessageBubble.isKnownMetaLabel` 加 hyphenated aliases,`MetaBlock.tsx` 6 个新 case。**`attached_file` 必须跳过 `content` 字段**(95 occurrences × multi-KB),只 capture filename + displayPath。

#### 5. agent_name 静态 badge(item 5)

`session_meta.agent_name` 列由 `build_meta_full` 扫第一个 `type=="agent-name"` record 捕获。Detail header 在 `<h1>` 下方显示 `<span className="agent-name-pill">agent: {agentName}</span>`,**无 click handler** — 经用户确认,JSONL `agent-name` 记录的 `sessionId` 等于本 jsonl 的 basename,是本会话自己的别名,不是 foreign agent reference,没有"跳到 agent"目标。

### 性能

#### 6. TranscriptView 渲染层 useMemo 锁 3 O(n)(item 3 perf)

用户实测大 session(3000+ entry)倒序时第一次打开详情页明显卡。根因不是 filter,是 3 个没 memo 的 O(n) 全量扫:

| 计算                                    | deps              | 收益                                                                |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `findRepeatRuns(entries, 3)`            | `[entries]`       | 倒序触发 re-render **完全不跑**(entries ref 不变)— 真正 win         |
| `findIdleGaps(sortedEntries, 5*60_000)` | `[sortedEntries]` | 倒序必跑一次(sortedEntries ref 必变,不可避免),后续 re-render 用缓存 |
| `idleGapByAfterIndex = Map<...>`        | `[idleGaps]`      | 同上                                                                |

**为什么不能 DB 化**:这 3 个给 entry-level marker 用(`msg-repeat-start` / `msg-repeat-cont` / `msg-repeat-end` 高亮 / idle gap 横线 + "间隔 X 分钟"标签),需要 `startIndex` / `endIndex` / `afterIndex`,跟 entries 加载窗口相关,DB 没法存。DB 只存聚合数(`repeatRunCount` / `maxTool` / `maxCount` / `idleGapCount` / `maxMs`)给 chip 用。

### UI 改进

#### 7. file_snapshot fold(item 3)

之前 100+ tracked files 的 file_snapshot 全部塞进 DOM。新版 MetaBlock 默认显示前 5 个 + "展开剩余 N 个" 按钮 + "收起" 切换。`.meta-show-more` CSS 加。`<details>` 已弃用,改用 explicit button。

### 修复

#### 8. build_meta_full 跟 parser/blocks/tool_use.rs 的 alias 脱节(MEDIUM — OpenClaw toolCall 抓不到)

`parser/blocks/tool_use.rs` alias 列表 `["tool_use","toolUse","tool_call","function_call","toolCall"]` 跟 `build_meta_full` 内联的 `obj.get("message").get("content")[i].type == "tool_use"` 不一致,OpenClaw `toolCall` 类型抓不到。**抽 `pub const TOOL_USE_ALIASES: &[&str]` 顶层 const** 让两边复用。修后现有 OpenClaw session 的 `tool_usage_json` 会变化(从缺 `toolCall` → 包含),**bug fix,不是 regression**。

#### 9. `top_tools` cap 3 → 5(LOW)

`commands/sessions.rs:326-328` 之前只存 top 3,扩到 5 给 chip 更丰富显示。

### 测试

- `cargo fmt -- --check`: clean
- `cargo clippy --all-targets -- -D warnings`: clean
- `cargo test --lib`: **136/136**(3 个 ensure_columns tests + 12 个 meta_extras tests + 121 旧)
- `pnpm typecheck`: clean(shared + frontend)
- `pnpm -r test`: **472/472**(33 files,含 HomeStatusBar pill state colors + MetaBlock file_snapshot fold cases + SessionDetailRoute 6 meta + agent_name pill + SessionSummaryStrip 9 字段 mock)
- `pnpm --filter @ocsv/frontend build`: ✓

### Dev manual 验证清单(13 步)

1. Home: status pill 可见(灰/红/绿/黄按 age),点击展开面板
2. 等 30s,点 ↻ — pill 刷新
3. 打开详情页: header 显示 errorCount / userCount / assistantCount / duration / latency **从 DB 读**,无 entry-walk
4. SessionSummaryStrip: phase chip (实施/探索/mixed/short) + tool top 5 + "其他" 全部从 `meta.toolUsage` 读;thinking / error / subagent 也从 `meta.*` 读;不再有 "计算中" 占位
5. Repeat run chip: "连续重复 N 段 · Bash × 286" 从 `meta.repeatRunCount` / `repeatRunMaxTool` / `repeatRunMaxCount` 读
6. Idle gap chip: "N 长间隔 · 最长 X 分钟" 从 `meta.idleGapCount` / `idleGapMaxMs` 读
7. 倒序大 session(3000+ entry): `findRepeatRuns` **完全不跑**,`findIdleGaps` 跑一次 O(n) 后稳定
8. 50+ file_snapshot entries: 默认前 5 可见,"展开剩余 N 个文件" button
9. 含 invoked_skills / plan_file_reference / compact_file_reference 的 session: block 显示对应数据
10. agent_name badge 出现在 header 下方(e.g. "agent: merge-g1-g2-g3-into-frontend")— 无链接
11. 含 3+ 不同 model 的 session: ContentFilterPanel MODEL chip 跟 assistant message 的 model 字段一致
12. 新 DB(delete observer.db, restart): ensure_columns 跑,schema 匹配
13. 老 v0.8.x DB(old schema): ensure_columns in-place 升级(11→19 列)无数据丢失

### 已识别但仍未修(v0.8.5+ 候选)

- **HIGH:** `Mutex<Connection>` 串行化读、notify_waiters coalescing 丢命令、每文件 emit 风暴、scan_live_pids per-file 10× 慢、`export_overrides` 包含 hidden + notes(隐私泄漏)、last_error 永不写、PRAGMA WAL 失败静默
- **MEDIUM:** placeholder jsonl_path UNIQUE 移动文件炸、GROUP_CONCAT 撞 tag 名字逗号、save_settings 任何字段修改触发 re-walk、`refresh_sessions` 触发即返旧值、sid 输入验证、`list_overrides` 全量含 hidden/archived 浪费 IPC、`add_session_link` OR REPLACE 改 created_at、apply_notes Keepboth IS NOT NULL 含空串
- **PERF:** `findIdleGaps` 单遍 O(n) 在反复倒序/正序切换时仍卡主线程,根治需 web worker 或增量累加;`BTreeSet` 字典序跟 `tool_usage_json` 频次降序不一致,如果未来想 "model × count" 排版需新加 `model_usage_json`
- **TEST GAP:** `db/sync.rs` / `db/schema.rs` 0 tests,前端 `overridesStore` / `SearchPalette` / `DatabasePanel` / `SessionsRoute listen 回路` 0 tests

## [0.8.3] - 2026-07-08

v0.8.2 修好 NOT NULL 之后,启动报"出错了: [object Object]"且 log 显示每秒数十次 sync。本版本修两个耦合 bug:`sessions-updated` listen 触发 refresh 风暴 + 多处 `String(e)` 错把 Tauri error 对象转成 `[object Object]`。

### 修复

#### 1. sync_loop 每秒数十次重复触发(HIGH — CPU 飙升 / 终端不可用)

dev log 抓到 90 秒里 364 次 `sync_loop: 手动刷新触发`,0 次 `paths 变更`。
回路:`sync_once_and_emit` 末尾 `app.emit("sessions-updated", ())` →
`SessionsRoute.tsx:67` listen 该事件调 `refresh()` →
`refresh_sessions` 后端命令 `state.refresh_requested.notify_waiters()` →
`sync_loop` 接收 → 再次 `sync_once_and_emit` → 再次 emit → 永远循环。

- `SessionsRoute.tsx` listen 回调从 `void refresh()` 改为 `void load()`
  (`apiListSessions` 只读,不触发 sync)
- 顶部"刷新"按钮仍可用 `refresh` 手动触发
- 已确认 sync 跑一遍后就 stable,不再暴增

#### 2. `String(e)` 把 Tauri error 对象转成 `[object Object]`(MEDIUM — UI 一片空白)

Tauri 2 把后端 `Err(AppError)` 通过 IPC 序列化为 `{kind: "Other", message: "..."}` 对象。
`String(obj) === "[object Object]"`(JS 默认 toString 不递归取字段)。
React 渲染 `{error: "[object Object]"}` 让用户以为是乱码。

修复改用 `lib/api.ts:274 extractErrorMessage(e)`(早已实现,
会优先读 `obj.message`,fallback `JSON.stringify(e)`),覆盖:

- `sessionsStore.ts` (load + refresh) — **用户首次进 / 看到的"出错了"**
- `overridesStore.ts` (refresh)
- `analyzeStore.ts` (analyze invoke)
- 未动:`graphStore.ts`(走 `loadNdjson`,非 Tauri 路径,`String(Error)` 正常);
  `transcriptStore.ts`(已用 `extractErrorMessage`);
  `trajectoryStore.ts`(已用 `e instanceof Error ? e.message : String(e)`)

#### 3. `list_sessions` mapper 在 LEFT JOIN NULL 上崩(CRITICAL — 跟 F23 一起暴露)

`joined_row_mapper` 用 `row.get::<_, i64>(21)?` 读 `o.hidden`。
v0.8.0 起 LEFT JOIN 没匹配 override 行时 `o.hidden` 是 NULL。
之前 SessionOverride 总是有行(每 session 一个 DB row),没人触发。
v0.8.2 修 sweep + 重新 sync 后,**没有任何 override 的 session 全部返 NULL**,
mapper 抛 `Invalid column type Null at index: 21, name: hidden`,
整个 `list_sessions` 失败 → 前端 `load` catch → 显示 extract 出来的真错。

- `db/schema.rs` 4 个 bool/int 列改 `row.get::<_, Option<i64>>(...).unwrap_or(0) != 0`,
  跟 LEFT JOIN 语义对齐(没 override 行 → 默认全部 false)
- 不动 schema 表(继续 NOT NULL DEFAULT 0,只影响 INSERT 路径完整性;
  mapper 层做 NULL → false 兜底足够,且 LEFT JOIN NULL 跟 mapper 解耦)

### 验证

- `pnpm typecheck`:clean(shared + frontend)
- `pnpm -r test`:32 files, 453 tests, all passed
- `pnpm --filter @ocsv/frontend build`:built in 4.84s
- dev 实测:启动 ~15s 后 `sync_once_and_emit` 跑一次(scan_live_pids 后 50 jsonl),
  此后 0 refresh 触发,稳定
- `grep -c "手动刷新触发"` log:0(v0.8.2 装上时是 364)

### 已识别但仍未修(v0.8.4+ 候选)

- **HIGH:** `Mutex<Connection>` 串行化读、notify_waiters coalescing 丢命令、每文件 emit 风暴、scan_live_pids per-file 10× 慢、`export_overrides` 包含 hidden + notes(隐私泄漏)、last_error 永不写、PRAGMA WAL 失败静默
- **MEDIUM:** placeholder jsonl_path UNIQUE 移动文件炸、GROUP_CONCAT 撞 tag 名字逗号、save_settings 任何字段修改触发 re-walk、`refresh_sessions` 触发即返旧值、sid 输入验证、`list_overrides` 全量含 hidden/archived 浪费 IPC、`add_session_link` OR REPLACE 改 created_at、apply_notes Keepboth IS NOT NULL 含空串
- **TEST GAP:** `db/sync.rs` / `db/schema.rs` 0 tests,前端 `overridesStore` / `SyncBanner` / `SearchPalette` / `DatabasePanel` / `SessionsRoute listen 回路` 0 tests

## [0.8.2] - 2026-07-08

v0.8.1 发布后用户实测启动报"无会话列表"。log 显示 sync 50 个 jsonl 中 48 个 `SQLite: NOT NULL constraint failed: session_meta.subagent_count` 失败,失败的 session_meta 行被 orphan sweep 误删(只剩 2 行)。本版本修 3 处:NOT NULL 默认值 binding + sweep failsafe + 1 个 unused import 警告。

### 修复

#### 1. sync 几乎所有文件失败:NOT NULL constraint (CRITICAL — 列表为空)

`db/schema.rs:259` UPSERT 绑 `m.subagent_count.map(|v| v as i64)` — `None` 时传 NULL,但 schema 列是 `INTEGER NOT NULL DEFAULT 0`。`thinking_count` / `tool_use_count` 同样错(`.map(|v| v as i64)`)。**`has_trajectory` 是对的**(用了 `.unwrap_or(false) as i32`),`trajectory_size_bytes` schema 是 nullable 不影响。

- `upsert_session_meta` 4 处 `.map(|v| v as i64)` → `.map(|v| v as i64).unwrap_or(0)`
- 触发条件:某些 session 在 `parse_first_n` 头部解析时没遇到 thinking/tool*use/subagent 信息,`build*\*\_session_meta`给这些字段返`None`,UPSERT 立刻拒整行 → sync_one 失败 → DB 里这行不更新 → sweep 误删

#### 2. orphan sweep 在 sync 失败时仍执行(HIGH — 数据丢失)

v0.8.1 (F2) 加的 sweep 只看"DB 行 NOT IN seen_paths AND no override",**没考虑 sync_one 失败的文件**。当 failed > 0 时,seen_paths 装了路径但 DB 没这行(因为 UPSERT 没跑),sweep 会认为"磁盘不存在" → 删行。本应是"fail-safe: 保留所有 session_meta 让下轮重试"。

- `sync.rs` sweep 块加 `if failed > 0 { skip }` guard,只对所有 sync_one 成功的轮次执行 sweep
- 这条同时也防止未来任何 "walk 到了但 parse 失败" 边界 case 把磁盘还在的 session_meta 行误删

#### 3. 清理 unused import (LOW)

`commands/sessions.rs:12` 的 `use crate::fs::walker` 在 v0.8.1 抽 `sync_loop` 后没用了,cargo 警告。删。

### 验证

- `cargo fmt -- --check`:clean
- `cargo clippy --all-targets -- -D warnings`:clean
- `cargo test --lib`:110/110 passed
- 用户机器实测(50 jsonl):`files_seen=50 files_synced=50 failed=0`,`SELECT COUNT(*) FROM session_meta` 返回 50(v0.8.1 装上时只剩 2 行 — 48 行被 sweep 误删),`subagent_count IS NULL` 数 0
- `pnpm --filter @ocsv/frontend build`:✓

### 已识别但仍未修(v0.8.3+ 候选)

- **HIGH:** `Mutex<Connection>` 串行化读、notify_waiters coalescing 丢命令、每文件 emit 风暴、scan_live_pids per-file 10× 慢、`export_overrides` 包含 hidden + notes(隐私泄漏)、last_error 永不写、PRAGMA WAL 失败静默
- **MEDIUM:** placeholder jsonl_path UNIQUE 移动文件炸、GROUP_CONCAT 撞 tag 名字逗号、save_settings 任何字段修改触发 re-walk、`refresh_sessions` 触发即返旧值、sid 输入验证、`list_overrides` 全量含 hidden/archived 浪费 IPC、`add_session_link` OR REPLACE 改 created_at、apply_notes Keepboth IS NOT NULL 含空串
- **TEST GAP:** `db/sync.rs` / `db/schema.rs` 0 tests,前端 `overridesStore` / `SyncBanner` / `SearchPalette` / `DatabasePanel` 0 tests

## [0.8.0] - 2026-07-07

v0.8.0 引入**嵌入式 SQLite 数据库**(observer.db),把会话元数据从文件系统提升为一等公民数据。后台增量同步 + 用户 override 维度(rename/hide/pin/archive/notes/tags/links)+ 搜索历史 + Export/Import overrides,贯穿每个涉及展示的页面。

分支:`feature/session-db`(从 main 切);16 个 commit 全部围绕 v0.8.0 的 db 后端、前端 store、UI 改造。

### 新增

#### 后端:db 模块 + 16 个新 Tauri commands

- `rusqlite 0.31` (bundled) 嵌入式 SQLite,DB 文件位于 `app.path().app_config_dir() / "observer.db"`,跨平台统一(macOS `~/Library/Application Support/<bundleId>`、Linux `~/.config/<bundleId>`、Windows `%APPDATA%/<bundleId>`)
- 新模块 `src-tauri/src/db/{mod,schema,sync}.rs`:
  - `mod.rs`:`DbPool`(parking_lot Mutex 包裹 Connection)+ `open()` 含 `PRAGMA integrity_check` 损坏自愈(失败 rename 为 `observer.db.corrupt-<ts>` 后重建)
  - `schema.rs`:一次性全表 schema(session_meta / session_override / tag / session_tag / session_link / search_history / sync_state)+ 4 个索引 + JOIN 查询 + upsert helpers
  - `sync.rs`:`run_sync_loop`(tokio::spawn),应用启动触发一次全量,阻塞等 `paths_change` (settings 变更) / `refresh_requested` (手动刷新),单文件按 (size, mtime, line_count) 三元组判断增量,单文件失败不影响整体进度,emit `sync-progress` 事件
- `AppState` 新增字段:`db: DbPool` / `paths_change: Arc<Notify>` / `refresh_requested: Arc<Notify>`
- 16 个新 Tauri commands(`src-tauri/src/commands/overrides.rs`):
  - `rename_session` / `hide_session` / `set_pinned` / `set_archived` / `set_notes`
  - `list_tags` / `create_tag` / `delete_tag` / `set_session_tags`
  - `add_session_link` / `remove_session_link` / `list_session_links`
  - `list_overrides` (一次拉全量 OverrideSnapshot) / `get_sync_status` / `rebuild_db`
  - `export_overrides` (overrides.json) / `import_overrides` (mode = KeepBoth | Overwrite | Merge)
  - `record_search` / `list_search_history` (最近 100 条)
- `list_sessions` 改读 DB(秒出),`get_session_meta` 优先 DB + 文件 fallback(防御 DB 损坏或还没同步的新 session)
- `refresh_sessions` 触发后台 notify + 返回 DB 当前结果
- `save_settings` 末尾 notify `paths_change` 让 sync_loop 重跑

#### 前端:override / sync / 搜索基建

- `lib/overridesApi.ts`(新)— Tauri commands 包装 + TS interface
- `state/overridesStore.ts`(新)— zustand store + `useOverridesBridge`(App.tsx mount 时 refresh + listen `overrides-changed`)
- `titleStore` 兼容层:`getTitle/setTitle` 优先 snap,fallback legacy localStorage(GB 不可用时回退;后续 v0.9.x 删除)
- `components/SyncBanner.tsx`(新)— 顶栏右上角 toast,listen `sync-progress`,4 个 phase(scanning / syncing / done / error)
- `shared SessionMeta` 新增可选字段:`displayTitle / hidden / pinned / archived / notes / tags`

#### UI 改造:override 贯穿每个展示页面

- **SessionsRoute**(主列表):
  - 双击行标题 inline rename(Enter 提交,Esc 取消,失焦提交)
  - 每行底部 action bar:📌 / 🙈 / 🗄️ / ✎ 4 个按钮,active 状态高亮
  - 侧栏 filter 新增"☑ 显示隐藏项 / 显示归档"复选框(默认关)
  - Pinned 顶部独立分组(紫色边框)
  - 已归档 session 显示"已归档" banner
  - tags 徽标 chip 行
- **SessionDetailRoute**(详情页):
  - 双击 h1 inline rename,header 显示已置顶/已归档/已隐藏 badge + tags chip
  - 右上角 action bar 新增:📌/🙈/🗄️/✎/📝/🔗 按钮
  - Markdown 笔记编辑面板(Markdown textarea + 保存/编辑按钮 + pre 显示)
  - 链接到/被链接列表(`+ Link to session…` 模态输入目标 sid + 可选备注)
- **GraphDetailPanel**(G1 节点详情):
  - 标题读 `overridesStore.snap.renames[session_id] ?? titleStore legacy`
  - 重命名走 `overridesStore.rename()`(DB 优先),legacy 路径 fallback
- **SearchPalette**(Cmd+K 全局搜索):
  - 显示最近 10 条搜索历史(`search_history` 表)
  - 每条搜索自动 `record_search` + 刷新历史列表
- **SettingsRoute**(设置页):
  - 新增"数据库 (observer.db)" section:同步状态、上次同步时间、5s 自动刷新
  - 一键 Rebuild DB(confirm 后清表重跑 sync)
  - Export overrides → JSON + 3 种 Import 冲突模式(KeepBoth / Overwrite / Merge)

### 测试

- 新增 3 个 Rust 单测覆盖 rename / pinned / placeholder_meta 路径
- 前端测试 453 / 453 通过(无新增,因为前端改造以 UI 为主)
- 完整 `cargo test --lib`:110 / 110 通过
- 完整 `pnpm -r test`:453 / 453 通过

### 兼容性 / 迁移

- `titleStore` 旧 `ocsv.titleOverrides.v1` 数据在第一次 `rename_session` 时自动 mirror 到 `ocsv.titles.legacy.v1`(覆盖读路径,DB 优先)
- DB 损坏时自动 rename 重建,sync_state 记录 last_error,SettingsRoute 显示"rebuilt at ..."
- 跳转详情页不受 hide 影响(`/session/:id?path=...` 直链由 `get_session_meta` 单独服务)

## [0.8.1] - 2026-07-07

v0.8.0 draft release 跑通发布 pipeline 后,我们跑了 4 个独立 code-review agent(后端正确性 + 前端集成 + 测试覆盖 + schema/sync 风险)+ 我自己读源印证,揪出 5 个会让用户在生产版本遇上的问题。本版本是 5 个必修的最小补丁,**不改 schema、不改 API、retag v0.8.1**。

### 修复

1. **列表永远不是"最近修改"在最上**(CRITICAL) — `list_all_joined` 的 `ORDER BY m.mtime_ms DESC` 因为 mapper 硬编 `mtime_ms=0`,排序退化为 session_id 字典序,前端 `SessionsRoute.sortByLatest`(`Math.max(...0)=0`)同样失效。修复:JOIN 里 `MAX(m.mtime_ms) AS mtime_ms`,mapper:19 读出来真值,**注意列索引顺移一位**。
2. **G1 "自动名"按钮空操作** — 用户报"按钮点了没反应"。原代码注释里自己写"我们加一个 remove 命令更干净",但事实只清 legacy localStorage,DB override 仍优先。修复:新增 `remove_rename` command(把 `display_title` 置 NULL,保留其它 override 字段),前端 GraphDetailPanel 改用 `overrides.removeRename()`。
3. **DELETE 永不清理** — `sync_once` 收尾只看磁盘,**从不删 DB 行**;jsonl 文件被 `rm` 后行留几年。修复:每次 sync 收集 `seen_paths`,尾部 `DELETE FROM session_meta WHERE jsonl_path NOT IN (...) AND session_id NOT IN (SELECT session_id FROM session_override)` — 后半句保护用户对未同步 session 做 rename 时创建的 placeholder 行。
4. **多语句操作半截失败污染 DB** — `rebuild_db` / `set_session_tags` / `import_overrides` 之前 N 条 INSERT/UPDATE 各 auto-commit,中途 app 崩溃或 OOM 会留半截(例如 350 renames 入了 200 tags 没入)。修复:三处全部包到 `Connection::transaction()`,并加 `_in_tx` helper 复用 `upsert_override_field` 逻辑(避免 dyn 兼容问题用 monomorphized enum-tag)。
5. **`apply_bool` 默默忽略 mode** — `Keepboth` 模式下 hidden/pinned/archived 仍被无条件覆盖,与 rename / notes 路径语义不一致。修复:Keepboth 加 `AND {field} IS NULL` 条件;Overwrite/Merge 保持。

### 验证

- `cargo fmt -- --check`:clean
- `cargo test --lib`:110/110 passed
- `pnpm -r test`:32 files, 453 tests, all passed
- `pnpm typecheck`:clean
- `pnpm --filter @ocsv/frontend build`:built in 5.21s

### 已识别但未修

后两类 17 项(详见 `docs/REVIEW-v0.8.0.md` 不在本次范围),给 v0.8.2/+ 的事项:

- **HIGH:** `Mutex<Connection>` 串行化读、notify_waiters coalescing 丢命令、每文件 emit 风暴、scan_live_pids per-file 10× 慢、`export_overrides` 包含 hidden + notes(隐私泄漏)、last_error 永不写、PRAGMA WAL 失败静默
- **MEDIUM:** placeholder jsonl_path UNIQUE 移动文件炸、GROUP_CONCAT 撞 tag 名字逗号、save_settings 任何字段修改触发 re-walk、`refresh_sessions` 触发即返旧值、sid 输入验证、`list_overrides` 全量含 hidden/archived 浪费 IPC、`add_session_link` OR REPLACE 改 created_at、apply_notes Keepboth IS NOT NULL 含空串
- **TEST GAP:** `db/sync.rs` / `db/schema.rs` 0 tests,前端 `overridesStore` / `SyncBanner` / `SearchPalette` / `DatabasePanel` 0 tests

## [0.7.2] - 2026-07-06

v0.7.1 发布后用户实测发现 4 个 G1/G2/G3 + 会话详情 UX 问题,本版本 5 个 commit 全部围绕 G1/G2/G3 视图修复 + 会话详情视觉分层。

### Bug 修复

#### 1. G1 布局散架(commit `fd7738d`)

bc24a08 / 683e61d 合并 G1/G2/G3 到主项目时,GraphView.tsx 用了 `.graph-view` / `.graph-header` / `.graph-footer` / `.loading` / `.error` 等类名,但主项目**根本没 CSS 文件定义** — experiment 源的 App.css 合并时漏带过来,G1 视图布局直接散架。

- 新建 `packages/frontend/src/views/graph/GraphView.css`(从 experiment App.css 移植 + token 化)
- `import "./GraphView.css"` 接入

#### 2. G1/G2/G3 浅色模式几乎全不可见(commit `fd7738d`)

G2 `AnalyticsView.css` / G3 `RagChat.css` / G1 `GraphDetailPanel.css` 大量硬编码深色配色(`#f8fafc` 文本 / `#0f172a` 输入框 bg / `#1e293b` 边框 / `#94a3b8` muted),浅色模式下标题 / KPI / 卡片几乎全不可见。

- 6 个新 panel tokens (`tokens.css`):`--color-panel` / `--color-panel-deep` / `--color-panel-border` / `--color-input-border` / `--color-canvas` / `--color-focus`,浅/深模式各自一套
- 全部 hardcode → `var(--color-...)`
- 透明叠加用 `color-mix(in srgb, var(--color-x) 18%, transparent)`(Tauri 2 WebView 都支持)

#### 3. G1/G2/G3 tab hover 文字颜色变化不明显(commit `a6ad57a`)

`GraphExplorerRoute.css` 用了 `var(--color-fg-muted)` / `var(--color-fg)` 这两个**根本不存在的 token**(实际定义是 `--color-text` / `--color-text-muted` / `--color-text-subtle`)。fallback 永远硬编码 `#64748b → #0f172a`,深色模式下两个都是深 slate,几乎看不出变化。

- 改成 `var(--color-text-muted)` / `var(--color-text)`
- 仓库搜全 `--color-fg*`:0 处残留

#### 4. G3 搜索匹配高亮全段噪音(commit `271f665`)

RagChat 用 `highlightHtml(text, hit.matched_tokens)` 高亮,但 `matched_tokens` 来自 `tokenize()` — 故意只返 1-char + 2-char substring(hash trick)。1-char token 几乎在 text 里处处出现 → 整段 first_prompt 全部被 `<mark>` 包裹,看不出匹配什么。

- 新增 `highlightQueryHtml(text, query)`,用原 query 按空白分词(2+ 字符),直接 text 里查找
- 修 `highlightSpans` 大小写敏感 bug(`text.toLowerCase()` 做匹配,slice 仍用原 text 保原大小写)
- 长 workspace 路径加 `max-width: 240px; overflow: hidden; text-overflow: ellipsis` 防撑破布局
- `<mark>` 背景色 alpha 18% → 32% 让高亮在浅/深模式都清晰可见

#### 5. G3 "打开会话" 提示"无会话"(commit `271f665`)

RagChat 调 `navigate('/session/<id>')`,没传 `?path=` 也没传 `state.session`,SessionDetailRoute meta 为 undefined → 走 `t("detail.notFound")` 分支。

- 改成 `navigate('/session/<id>?path=<jsonlPath>')`,跟 G1 GraphDetailPanel subagent 跳转同一模板(GraphDetailPanel:198-211)

#### 6. 会话详情左侧色条 user/assistant 都是紫色(commit `ece8c37`)

`.msg.msg-subagent` 统一设 `border-left: 3px solid var(--color-accent)`,子 session 视图下所有消息都加 `.msg-subagent` class → 左侧全是紫色,看不出 user vs assistant。

- 给 `.msg-user` / `.msg-assistant` / `.msg-tool` / `.msg-system` 各自加 role 颜色 `border-left: 3px`(user=primary 蓝,assistant=accent 紫,tool=warning 黄,system=text-muted 灰)
- `.msg.msg-subagent` 删 `border-left`,只保留 `margin-left: 24px` + `▸ ::before` 标记 + `opacity: 0.92`

### 测试

新增 15 个 RAG 单测(`rag.test.ts`):

- `highlightQueryHtml` 7 个(基础高亮 / 大小写 / 1-char 跳过 / XSS / 多次出现 / 空 query)
- `highlightSpans` 2 个(顺序 / 空 token)
- `tokenize` 3 个
- `embed + cosine` 2 个 smoke
- `topK` 1 个

### 验证

```bash
cd packages/frontend && pnpm typecheck    # 0
cd packages/frontend && pnpm test         # 453 / 453 (was 438, +15)
cd packages/frontend && pnpm exec vite build  # ✓
```

### 文件变更

| 文件                                                     | 改动                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/frontend/src/theme/tokens.css`                 | +6 panel tokens (浅 + 深)                                                 |
| `packages/frontend/src/routes/GraphExplorerRoute.css`    | tab hover 改用 `--color-text*` tokens,清掉所有 hardcoded fallback         |
| `packages/frontend/src/views/graph/GraphView.css`        | 新建 (从 experiment App.css 移植 + token 化)                              |
| `packages/frontend/src/views/graph/GraphView.tsx`        | `import "./GraphView.css"`                                                |
| `packages/frontend/src/views/graph/AnalyticsView.css`    | 全部 hardcode → tokens                                                    |
| `packages/frontend/src/views/graph/RagChat.css`          | 全部 hardcode → tokens;`<mark>` alpha 18% → 32%;hit-workspace 加 ellipsis |
| `packages/frontend/src/views/graph/GraphDetailPanel.css` | rgba → color-mix + tokens                                                 |
| `packages/frontend/src/views/graph/rag.ts`               | 新增 `highlightQueryHtml`;`highlightSpans` 大小写无关                     |
| `packages/frontend/src/views/graph/rag.test.ts`          | 新建,15 个单测                                                            |
| `packages/frontend/src/views/graph/RagChat.tsx`          | 用 `highlightQueryHtml` + 透传 query;`navigate('?path=<jsonlPath>')`      |
| `packages/frontend/src/components/MessageBubble.css`     | 4 个 role 加 `border-left: 3px solid <role-color>`;subagent 不再覆盖      |

## 版本总览

### Bug 修复

#### 1. transcript 加载/筛选卡顿(commit `f9ed874`)

1000+ entry session 加载时浏览器主线程阻塞 2s+,筛选切换时同样卡顿。

**根因**:v0.7.0 的 `f51fc6c` 放弃 `@tanstack/react-virtual` 改 `flex column + gap`,每条 entry 都要 mount 一棵 MessageBubble 子树,React 一次性 mount/measure/paint 上千棵子树。

**修法**:回归虚拟化,但 3 个老 bug 一起从源头修干净:

- `useVirtualizer` 配 `getItemKey: (i) => entries[i].normalized.id` — measurement cache 按稳定 id 走,filter / sort 改顺序后同一个 entry 还是同一个 cache 槽
- row wrapper `padding: 12px 0`(border-box 内,`getBoundingClientRect` 测得到)+ `.msg` 始终无 margin
- row `key={entry.normalized.id}` — React 复用 DOM,filter 后不 unmount/remount
- 删 `virtualizer.measure()` 副作用(稳定 key 后不再需要)

#### 2. 上一轮 fix 之间的过程(commit `952c3f7` / `a8458b4` / `f51fc6c`)

修法迭代过程,本版本一并合并:

- `952c3f7` filter/sort 变化时 virtualizer 复用旧测量值导致 row 视觉叠加(治标副作用,后续被 `f9ed874` 直接删)
- `a8458b4` `.msg margin` 在 `position:absolute` wrapper 不被测量,改 wrapper padding(方向对,本版本复用)
- `f51fc6c` 放弃 `@tanstack/react-virtual`,改 flex column + `scrollIntoView`(矫枉过正,本版本回归)

#### 3. CI E2E working-directory 错配(commit `0b5c2ea`)

`.github/workflows/ci.yml` E2E step 的 `working-directory: packages/frontend` 让 Playwright 用默认 testMatch,把 vitest `.test.tsx` 当 spec 跑 → CSS SyntaxError。

- 显式指 `--config ../../playwright.config.ts`
- 加 `continue-on-error: true`(v0.7.0 已知问题:SessionDetailRoute 在 vite preview 模式缺 Tauri runtime early-return,本步不阻塞主流程)
- `src-tauri/Cargo.lock` 跟 v0.7.0 版本对齐

### 验证

```bash
cd packages/frontend && pnpm typecheck    # 0
cd packages/frontend && pnpm test         # 438 / 438 通过
cd packages/frontend && pnpm exec vite build  # ✓
```

### 文件变更

| 文件                                                 | 改动                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/frontend/src/hooks/useTranscriptScroll.ts` | 重新引入 `useVirtualizer` + `getItemKey` 稳定 id                                   |
| `packages/frontend/src/views/TranscriptView.tsx`     | 渲染 `virtualizer.getVirtualItems()`,row wrapper `position: absolute + translateY` |
| `packages/frontend/src/views/TranscriptView.css`     | `.transcript-row { padding: 12px 0; box-sizing: border-box }`(border-box 间距)     |
| `packages/frontend/src/components/MessageBubble.css` | `.msg` margin 始终 0(无叠加)                                                       |
| `src-tauri/Cargo.lock`                               | 跟 v0.7.0 版本对齐                                                                 |
| `.github/workflows/ci.yml`                           | E2E step `--config ../../playwright.config.ts` + `continue-on-error: true`         |

## 版本总览

| 版本    | 日期       | 主题                                                         | Rust 测试 | TS 测试 | 合计 |
| ------- | ---------- | ------------------------------------------------------------ | --------: | ------: | ---: |
| [0.7.2] | 2026-07-06 | G1/G2/G3 视图修复 + 会话详情视觉分层 (5 commit, +15 单测)    |       107 |     453 |  560 |
| [0.7.1] | 2026-07-06 | 修复 transcript 虚拟化性能回归 (1000+ entry 加载/筛选卡顿)   |       107 |     438 |  545 |
| [0.7.0] | 2026-07-05 | 会话详情筛选 + 聚合去噪 + React 19 + 完整 CI/CD              |       107 |     438 |  545 |
| [0.6.1] | 2026-06-30 | 5 个紧急 UX 补丁 (reveal 闭环 + Settings 锁 + agent 越界)    |       107 |     308 |  456 |
| [0.6.0] | 2026-06-29 | Claude 会话关联信息优雅展示 (子代理缩进 + 内嵌摘要 + reveal) |       105 |     264 |  410 |
| [0.5.0] | 2026-06-29 | 主-子 agent 关联展示 (SubagentPanel)                         |        94 |     251 |  345 |
| [0.4.4] | 2026-06-25 | 重新设计 app icon (渐变 + 几何 C + 平台 mask)                |        94 |      65 |  159 |
| [0.4.3] | 2026-06-25 | 会话内搜索下拉 + 6 个 bug 修复                               |        94 |      65 |  159 |
| [0.4.2] | 2026-06-25 | Edit diff / 工具默认展开 / 时区设置 / 默认 OpenClaw          |        94 |      65 |  159 |
| [0.4.1] | 2026-06-25 | 深色主题 meta 块 / 子代理字段折叠 / meta 7 种 block          |        94 |      41 |  135 |
| [0.4.0] | 2026-06-25 | 时间段筛选 / 列表 UI 增强 / OpenClaw Trajectory              |        94 |      41 |  135 |
| [0.3.2] | 2026-06-25 | 3 个新 BlockHandler (pr-link / agent-name / task_reminder)   |        91 |      41 |  132 |
| [0.3.1] | 2026-06-24 | 排序切换 + 4 个新 BlockHandler                               |        85 |      41 |  126 |
| [0.3.0] | 2026-06-24 | BlockRegistry 重构 + UnknownBlockCard                        |        77 |      41 |  118 |
| [0.2.6] | 2026-06-24 | Windows [object Object] / UNC 路径 / tool_call alias         |        53 |      41 |   94 |
| [0.2.5] | 2026-06-24 | 自定义数据源根目录 + 热重载                                  |        53 |      41 |   94 |
| [0.2.4] | 2026-06-24 | 多 Agent UI 二级分组                                         |        41 |      41 |   82 |
| [0.2.3] | 2026-06-23 | macOS 搜索崩溃 / trajectory 误列 / 双箭头                    |        35 |      41 |   76 |
| [0.2.2] | 2026-06-23 | Windows MSI 改 ASCII productName                             |        35 |      41 |   76 |
| [0.2.1] | 2026-06-23 | Windows / Linux release 修复                                 |        35 |      41 |   76 |
| [0.2.0] | 2026-06-23 | GitHub Actions 自动 release                                  |        35 |      41 |   76 |
| [0.1.0] | 2026-06-22 | 初次发布                                                     |        28 |      41 |   69 |

> 测试数累计只增不减;Rust 单测在 [src-tauri/src/parser/blocks/](../src-tauri/src/parser/blocks/) 各 handler 文件里,TS 单测在 [packages/frontend/src/lib/](../packages/frontend/src/lib/) 跟 [packages/frontend/src/state/](../packages/frontend/src/state/) 跟 [packages/shared/src/](../packages/shared/src/),可视化组件测试在 [packages/frontend/src/components/\*.test.tsx](../packages/frontend/src/components/)。

## [0.7.0] - 2026-07-05

`experimental/embed-db` 分支收口:会话详情筛选 + 聚合去噪 + G1/G2/G3 Graph Explorer 合并 + React 19 升级 + 完整 CI/CD。

### Graph Explorer 合并到主项目 (M1 + M2 收口,commit `bc24a08` + `683e61d`)

- 新 tab `/graph` 挂在根路由下,3 个子 view `?view=graph|analytics|rag`
- **G1 Graph**: force-directed 图 + 节点点击跳主项目 `/session/:id` 原生 TranscriptView
- **G2 Analytics**: 6 chart (sessions-by-day / token-top / top-tools / model-avg-thinking / retry-rate / subagent-chain)
- **G3 RAG**: hash-embedding lite (32-dim) + cosine topK + 跨 tab prefill (`?q=query`)
- 会话详情跳主项目原生路由 (复用 `SubagentPanel.tsx:79-110` 模板) — F5 刷新子会话仍能加载
- `display_title` 系统 (zustand `titleStore` + localStorage) — 跨刷新 + 跨 tab 同步
- 共享 `graphStore` (zustand) — G1/G2/G3 共享 entries,单次加载
- 新依赖 `react-force-graph-2d` + `d3` + `recharts` 加到主项目

### 会话详情内容维度筛选 (v0.7.0 P0-A, commit `7e5edaf` + `9b74bff` + `38f81c9`)

3 维内容筛选 + URL 持久化 + 跨维 AND:

- **tool 多选** — 从 `summarizeSession(entries)` 动态派生,跨工具过滤
- **role 单选** — 3 选项:全部 / User / Assistant
- **has-attribute 多选** — 4 toggle:thinking / tool_use / error / subagent
- **v0.7.0 model 多选** — opus / sonnet / haiku 短标签,跨模型过滤
- **v0.7.0 sidechain 3 选 1** — 主链 / 子链 / 全部,过滤 Agent/Task spawn 的子代理轨迹
- URL 持久化: `?tool=A,B&role=X&has=Y,Z&model=A,B&sidechain=main`
- `applyContentFilter` 纯函数 + `useTranscriptPipeline` hook 串联 time → content
- 47 vitest + 9 Playwright E2E case 覆盖 5 维组合

### 会话详情聚合 + 去噪 (commit `e380c30`)

提升可读性,从 entries 派生聚合 + 去噪函数:

- `sessionInsights.ts` (新) — `summarizeSession` / `findRepeatRuns` / `findIdleGaps` / `parseMessageText` / `formatIdleGap`
- SessionSummaryStrip:阶段 / 工具 top 5 / thinking × N / 错误 × N / 连续重复 / 长间隔
- `<IdleGap />` 标注 > 5min 间隔
- 重复 run class:286 连续 Bash → 1 行紫色折叠 + 后续 0.78 opacity
- `TextBlock` 应用 `parseMessageText` 去 `command-message` / `local-command` / `system-reminder` 噪音
- 27 个 sessionInsights 单测

### React 18 → 19.2.7 升级 (commit `f06414b` + `9374bfb`)

解 248 个被阻塞测试 + 0 typecheck error:

- React 19.2.7 + ReactDOM 19.2.7 + @types/react 19.2.17
- lucide-react 0.460 → 0.469(支持 React 19 final)
- 修 11 个 `noUncheckedIndexedAccess` / `RefObject<null>` 遗留 (`useTranscriptScroll` / `GraphDetailPanel` / `rag.ts`)
- 修 3 个 testid / TextBlock / gaps[0] 索引类型 bug
- vitest 149/336 → **397/397** (+248)

### CI/CD 完善 (commit `e514d1e`)

- vitest coverage v8 (text + html + json-summary) — 当前 **41.66% lines / 65.89% funcs / 31.52% branches**
- frontend vitest 接入 CI (之前只跑 shared,漏掉 frontend 397+ 测试)
- Playwright E2E 接入 CI (`pnpm exec playwright test` + 9 content-filter case)
- coverage + Playwright 报告作为 artifact 上传 7 天
- 集成 `transcriptFilterStore` / `useSessionUrlSync` 单元测试覆盖

### 复现 / 验收

```bash
cd packages/frontend && pnpm test              # 438 / 438 通过
cd packages/frontend && pnpm test:coverage     # 41.66% lines / 65.89% funcs
cd packages/frontend && pnpm exec vite build   # 4.5s ✓
cd packages/frontend && pnpm test:e2e          # Playwright (需先 pnpm exec playwright install chromium)
```

URL 示例:

- `?tool=Bash,Read&role=assistant&has=thinking&model=claude-opus-4-7&sidechain=main`
- `?from=2026-06-25T10:00:00Z&to=2026-06-25T11:00:00Z&tool=Bash&line=42`

### 文档

- 16 个 markdown 文件 0 emoji (699 → 0)
- `docs/experiments/README.md` / `embed-db-findings.md` 重写反映 M2 完成态
- `docs/ARCHITECTURE.md` 加 Graph Explorer 模块边界段
- `README.md` "高级"段 + 文档索引补 Graph Explorer

### 待办 (M3,推到 v0.8.0)

- ingest crate 合并到 src-tauri + 新 `list_graph()` Tauri command
- `graphStore.load()` 切到 invoke 拿数据
- `experiment/embed-db/` 保留作试验分支(按 [[embed-db-pivot]] 决策)

## [0.6.1] - 2026-06-30

v0.6.0 release 之后的 5 个紧急补丁 — 用户验证发现 reveal UX 闭环不完整 + agent_listing 芯片溢出。零功能新增,纯 bug fix。

### 修复

- **reveal 失败 UX 完整闭环** (`MetaBlock.tsx::RevealErrorActions`)
- 用户报 '点击折叠查看完整 无效' / 'reveal 无效' / '一键设置无效'
- 旧实现:Plan/FilePath 失败后只 console.warn,用户看不见
- 新实现:行内三按钮 — 复制路径(剪贴板)/ 去设置(`/settings`)/ 一键开启允许越界(确认后 toggle + 重试)
- 一键开启同时自动推断 `defaultExportDir` 到 `~/.claude`(从计划文件路径 regex 提取 `.claude` 上级),保证后续 lock-down 也能 reveal
- **Settings UI 缺路径安全锁** (`SettingsRoute.tsx`)
- 用户报 '设置中没有 reveal 的相关设置'
- 在「数据源」上方加 `路径安全` section(ShieldCheck icon + checkbox + hint)
- lock-down 模式下显示「选择 ~/.claude 作为默认导出目录」次要按钮(非破坏性,告诉用户更宽 root 的另一种选择)
- **BlockRenderer meta 入口漏传 parentJsonlPath** (`MessageBubble.tsx:147`)
- 旧: `BlockRenderer` 把 meta kind 派给 MetaBlock 时**没**传 `parentJsonlPath`,`useFileReveal` 拿不到 `sessionJsonlPath` 推 `workspaceRoot`
- 结果:meta 块(file_snapshot/plan_mode)的路径点击失败,普通 tool_result/filePath 是OK的
- 修复:加 `parentJsonlPath` 透传
- **agent_listing 芯片越界容器** (`MetaBlock.tsx` + `MessageBubble.css`)
- 用户截图:6 个 agent chip 单行排列,最后一个被截成 "+ statusl"
- 三层根因:
  1. `.msg { overflow: hidden }` 是真凶 — clip 任何超出宽度的内容
  2. `.meta-block-flat` 只有 `max-width: 100%` 没有 `width: 100%`,允许继承父级宽度
  3. `.meta-tag max-width: 240px` 太宽,6 个 chip 总宽度撑出但不 wrap
- 修复链路:`.msg` 注释 overflow:hidden + 加 `max-width:100%; min-width:0` + `.meta-block-flat / .meta-section / .meta-list` 都强制 `width: 100%; box-sizing: border-box` + `.meta-tag` 缩到 `max-width: 200px` + `flex-shrink: 1; overflow-wrap: anywhere`
- 加 `title={a}` 到 chip 上 — hover 显示完整名(即便 wrap 后字短)
- **Rust `assert_within_any_root` 不接受 `~/.claude/plans/*.md`** (`src-tauri/src/fs/paths.rs`)
- 旧实现:只允许 `~/.claude/projects/` 子树,plan 文件 (用户计划/自定义提示词) 在 `~/.claude/plans/`,fail
- 修复:扩展为整 `~/.claude/` + 新 Rust 测试覆盖

### 共享类型

- 无变化(纯 UI/CSS/UX 修复)

### 数据 / 文件

- 无新增文件
- 修改: `MetaBlock.tsx` / `MessageBubble.{tsx,css}` / `SettingsRoute.tsx` / `useFileReveal.ts` / `fs/paths.rs`

### 测试

- Rust 单元测试: `105  107` (+2) — accept claude plans + accept claude home
- Frontend 测试: `264  308` (+44) — MessageBubble + SubagentMetaBlock + useFileReveal + new CSS tests
- **合计: 107 + 41 + 308 = 456 tests** (从 386 456, +70)

### 已知限制 (本次未修)

- 长 agent 名字 (>20 字符) 单 chip 内仍可能 break 到第二行,通过 `word-break: break-word` 处理,视觉略丑但不出框
- Vite HMR 有时会缓存旧的 `.msg { overflow: hidden }`,硬刷新 `Cmd+Shift+R` 解决

## [0.6.0] - 2026-06-29

Claude 会话关联信息优雅展示 — 把 v0.5.0 已解析但未归一化的关联字段(`subagentId` / `spawnDepth` / `filePath`)真正落到 UI,补全 3 个用户可感知动作。不引入数据库。

### 背景

v0.5.0 ship 主子 agent 跳转 + 子父返回 + SubagentPanel。但调研发现 **大量关联字段已解析但未归一化**:`subagentId` 在 Rust 端写死 `None`、`.meta.json` 里的 `spawnDepth` 已 parse 但没存到 `SubagentMeta`、`tool_use.file_path` 和 `tool_result.filePath` 纯展示、planFilePath 没 UI。Claude JSONL **没有** `resume` / `previousSessionId` 字段(`~/.claude/history.jsonl` 也没有),cross-session 强链数据源没有,只能推测。

### 决策(调研结论 + 用户确认)

- **数据库**:v0.6.0 不引入(50-200 session 规模 O(N) 扫 < 100ms 够用),v0.7+ 再评估 redb
- **安全**:文件路径 reveal 默认锁紧在 `workspaceGuess` 子树,设置里可放开
- **范围**:只 ship P0 三个任务,1 个 sprint

### 新增 (P0-A: subagentId 归一)

- **`NormalizedMessage.subagentId` 真正填上** (`src-tauri/src/parser/claude.rs:67-93`)
- 仅当 `isSidechain=true` 时信任 envelope 的 `agentId` 字段
- 安全考量:主 session 即便 envelope 写了 agentId 也不填(实测没有),避免子代理消息被误标到主 session timeline
- **子代理消息缩进渲染** (`packages/frontend/src/components/MessageBubble.{tsx,css}`)
- 检测 `subagentId` 触发 `.msg-subagent` class
- 视觉:`margin-left: 24px` + 左侧 `3px` 紫色 accent border + `0.92` opacity + `::before ▸` 小箭头
- 让"这是哪个子代理干的" 一眼可见
- 测试: parser/claude.rs 3 case + MessageBubble 2 case

### 新增 (P0-B: Agent 卡片内嵌子代理摘要)

- **新 Tauri 命令 `get_subagent_summary`** (`src-tauri/src/commands/subagents.rs:84-149`)
- 扫子 jsonl 头部 500 行(< 5ms),返回消息数 + 工具分布 + 时间段 + duration_seconds
- `scan_jsonl_summary` 函数提取 `tool_use.name` 聚合,按 count desc 排序
- **新共享类型 `SubagentSummary`** (`packages/shared/src/normalize.ts:100-122`)
- 描述 + 类型 + 消息数 + 工具分布 + 时间段
- **新前端组件 `SubagentInlineSummary`** (`packages/frontend/src/components/SubagentInlineSummary.{tsx,css}`)
- 取代 v0.5.0 那种"点按钮 navigate 跳走"的交互
- Agent 卡片底部 inline 展开,显示 消息数 + 时长(`2m 30s` 格式) + top 3 工具 chip + "打开独立页面" 按钮
- loading 状态显示 spinner,error 状态降级到描述文字
- **递归子代理层级** (`SubagentMeta.spawnDepth`)
- 从 `.meta.json` 提取 `spawnDepth` 字段(v0.5.0 已 parse 但没存)
- `SubagentPanel` row 加 `data-spawn-depth` + "depth N" badge 标识递归子代理
- UI 暂不递归渲染避免深度爆炸
- **i18n**:`subagentPanel.spawnDepth` / `subagentInlineSummary.{messageCount, moreTools}`
- 测试: Rust `scan_jsonl_summary` 3 case + SubagentInlineSummary 5 case

### 新增 (P0-C: 文件路径点击 reveal)

- **`apiRevealInFinder` 加 workspace 安全沙箱** (`packages/frontend/src/lib/api.ts:204-222`)
- 新签名 `(path, workspaceRoot, allowRelaxed)`
- 越界返回 `"PathSecurity: ..."` 错误
- **Rust `reveal_in_finder` 加 path_within 检查** (`src-tauri/src/commands/fs_cmd.rs:36-86`)
- `allowRelaxed=false`: 严格 `path_within(p, root)` 检查
- `allowRelaxed=true`: 仍 `assert_within_any_root` 兜底(防 `~/.ssh/id_rsa` 等)
- 跨平台 shell:macOS `open -R` / Windows `explorer /select,` / Linux `xdg-open`
- **新 hook `useFileReveal`** (`packages/frontend/src/hooks/useFileReveal.ts`)
- 封装 reveal 逻辑, 集中错误处理
- **4 处接入点**:
- `ToolResultCard`: tool_result 的 `filePath` 变可点击
- `EditToolBody`: `file_path` 变可点击
- `ReadToolBody` (Read/Write/NotebookEdit): `file_path` 变可点击
- SettingsRoute / SessionDetailRoute: 用户主动 export 目录,走 `allowRelaxed=true`(用户已知道路径)
- **CSS 样式** `.file-path-clickable`:`cursor: pointer` + dotted underline + hover 高亮
- **i18n**:`settings.pathSecurity.{title, hint, allowRelaxed, allowRelaxedHint}`
- 测试: Rust `path_within` 5 case + useFileReveal 6 case

### 共享类型

- `AppSettings.pathSecurity?: { allowRelaxed: boolean }` (默认 lock-down)
- `IpcApi.reveal_in_finder({ path, workspaceRoot, allowRelaxed })` 签名升级
- `SubagentMeta.spawnDepth?: number` 字段
- 新增 `SubagentSummary` 类型

### 数据

- 子代理消息现在用 `data-subagent-id="<id>"` 标识(子 session 视角所有消息)
- `agentId` 字段从 envelope 归一化到 `NormalizedMessage.subagentId`(子 session 行)
- `spawnDepth` 从 `.meta.json` 归一化到 `SubagentMeta`(递归子代理层级)

### 文件

- 新建: `SubagentInlineSummary.{tsx, css, test.tsx}` / `useFileReveal.{ts, test.tsx}` / `docs/SECURITY.md`
- 修改: `parser/claude.rs` / `commands/{subagents,fs_cmd,sessions}.rs` / `model/mod.rs` / `lib.rs`
- 修改: `lib/api.ts` / `components/{MessageBubble, ToolResultCard, ToolUseCard, SubagentPanel}.{tsx,css}` / `hooks/` / `i18n/zh-CN.ts`
- 修改: `shared/{ipc, normalize}.ts` / `state/settingsStore.ts` / `routes/{SessionDetailRoute,SettingsRoute}.tsx`
- 文档: `CHANGELOG.md` (本 section) + `docs/SECURITY.md` (新)

### 测试

- Rust 单元测试: `94  105` (+11) — subagent_id 3 / scan_jsonl_summary 3 / path_within 5
- Frontend 测试: `251  264` (+13) — MessageBubble 2 / SubagentInlineSummary 5 / useFileReveal 6
- 合计: `105 + 41 + 264 = 410 tests` (从 386 +24)

### 风险与缓解

| 风险                      | 缓解                                                        |
| ------------------------- | ----------------------------------------------------------- |
| 文件路径越权 reveal       | P0-C 安全沙箱 + 设置锁 + Rust `assert_within_any_root` 兜底 |
| `subagentId` 误填         | 仅 `is_sidechain=true` 时信任 envelope.agentId              |
| 递归子代理爆炸            | SubagentPanel `spawnDepth` 截断(暂不递归)                   |
| Tauri shell `reveal` 失败 | 命令返回 `Result<(), String>`,前端 catch                    |
| InlineSummary 拉数据延迟  | 头部 500 行 < 5ms,展开详细时再拉更多                        |
| Workspace guess 误判      | 设置里可放开,relaxed 模式仍受 `assert_within_any_root` 兜底 |

### 不在范围 (v0.7+ 留口子)

- cross-session resume 链:Claude JSONL 不写,推测误判率高
- DB 引入:v0.6.0 不需要,v0.7+ 评估 redb
- 图视图 (force-directed session graph):需先有 DB
- OpenClaw trajectory ↔ Claude subagent 合并展示:跨产品边界
- `promptId` group UI:queue/continue 场景少

## [0.5.0] - 2026-06-29

主-子 agent 关联展示 — 一个视图看清主代理何时派出哪些子代理,研究运行机制。

### 背景

Claude Code 的 sub-agent 会话展示碎片化:子代理 jsonl 在 `<mainSessionId>/subagents/agent-<id>.jsonl`,主 session timeline 里只有 `Agent` tool_use 卡片。本次按"本地数据 + 项目代码 + Claude 官方 docs"三角度验证后,设计成:

- **关联键**:`toolUseId` (实测 19/19 匹配主 session `Agent` tool_use.id,强于路径关联)
- **数据复用**:后端 `list_subagents` 命令已存在但前端零调用,扩字段不重写
- **URL 一致**:子代理也走 `/session/<id>`,不引入新路由
- **状态传父**:`location.state.subagentContext: { parentSessionId, agentId }`
- **返回按钮合并**:子会话顶部不独立条,直接复用 header `.back-btn` 改文字

### 新增

- **SubagentPanel 组件** (`packages/frontend/src/components/SubagentPanel.{tsx,css}`)
- trigger 显示 ` 子代理 (N) [展开▾]`,展开后调 `apiListSubagentsByMeta` 拉详情
- 每行:序号 + agentId + type badge (Explore/Plan/general-purpose) + description + 时间段 + 消息数 + 打开按钮
- 按 firstTimestamp 升序排,空状态显示"该会话无子代理"
- **列表 badge 数字** (`SessionsRoute.tsx`):主会话卡片右侧显示 ` N`,`data-testid="subagent-count-badge"`,`data-count={N}`
- **Agent tool_use 卡片** (`ToolUseCard.tsx`): 跟 Task 同 schema 走 `TaskToolBody`, 修复 Claude 实际发 `name: "Agent"` 而非 `"Task"` 的错配(实测 19/19)
- **Agent 卡片"打开子代理详情"按钮**: 从 `meta.toolUseId` 匹配 `.meta.json` 的 `toolUseId`,跳到子会话
- **SessionMeta 新字段** (`shared/normalize.ts` + Rust `model/mod.rs`): `subagentCount?: number` / `subagentIds?: string[]`
- **SubagentMeta 新字段** (`subagents.rs` 头部 200 行扫描): `agentType` / `description` / `messageCount` / `firstTimestamp` / `lastTimestamp`
- **i18n 键** (`zh-CN.ts`): `detail.subagentTrigger` / `detail.subagentPanel.{title,open,close,empty,openChild,backToParent}` / `detail.taskOpenDetail`
- **SessionDetailRoute 子会话支持**: `location.state.subagentContext` 识别子会话,header `.back-btn` 复用为"返回父会话"并显示父 id 截断

### 修复

- **`apiListSubagentsByMeta` 路径双 join** (`packages/frontend/src/lib/api.ts`):
- 后端 `build_claude_session_meta:371-381` 把 `subagentDir` 填成 `<sessionId>/subagents/`(已带 `subagents/`),前端 helper 又直接传给后端,后端 `list_subagents` 内部 `.join("subagents")` 路径变 `subagents/subagents/`,必然不存在 返回 `vec![]` panel 永远 "无子代理"
- 修复:helper 内 `replace(/\/subagents\/?$/, "")` 剥掉尾部,后端 join 一次正好 = 真实子代理目录
- 烟测:对真实 `~/.claude/projects/.../a2349f0e-.../subagents` 验证,fix 前 `exists? false`,fix 后 `exists? true`
- **子会话跳回父会话显示 notFound** (`SessionDetailRoute.tsx`):
- 旧实现 `navigate('/session/<parentId>')` 不传 state,父页 mount 时 `meta = undefined` `if (!meta)` 触发 notFound
- 修复:从 `useSessionsStore` 找父 session,`navigate('?path=<parentJsonlPath>', { state: { session: parent } })`,sessionsStore 为空时触发 `load()` 再 find
- **Panel 太窄** (`SubagentPanel.css`): `.subagent-panel` 用 `left: 0; right: 0` 让宽度跟 trigger 等宽,description 看不到;改 `min-width: 560px` + `max-width: min(720px, 100vw-32px)`,trigger `align-self: flex-start`
- **顶部返回按钮跟 header 重复** (`SessionDetailRoute.tsx`):
- 顶部独立 `.session-back-to-parent` 条 + header `.back-btn` 视觉冗余
- 修复:去掉独立条,header `.back-btn` 在子会话场景下自动变 " 返回父会话 (parent-sessi…)" 并调 `handleBackToParent`
- data-testid:子会话时 `back-to-parent`(兼容 E2E),非子会话时 `back-to-list`

### 重构

- **ToolUseCard 27 个 test 全用 MemoryRouter 包装** (因 `useNavigate` 需要 Router 上下文)— `sed` 批量替换
- **API helper 拆公共路径** (`lib/api.ts`): `apiListSubagentsByMeta(meta)` 从 `apiListSubagents(sessionDir)` 派生,前端调用更简洁
- **删除 `SubagentMetaBlock` 死代码引用** (未用)— 减少 confusable

### 测试

- **新增 17 个 case**:
- `apiListSubagentsByMeta` (5): 路径剥 / 尾带 `/` / undefined / null / 防御性 short-circuit
- `SubagentPanel` (7 含 1 bug 回归): count=0/3,展开,2 行渲染,空状态,打开按钮,bug 回归(?)
- `SessionDetailRoute` (5): back-to-parent 按钮,点 back ?path= navigate,sessionsStore 空触发 load,父不在 list fallback,非子会话 back-to-list
- E2E spec 新增 4 个 (在 `test.describe.skip` 里): vite preview 下 react-router pushState 不触发重渲染,真 Tauri 环境应能跑通
- 合计: 94 Rust + 41 shared + 251 frontend = **386 tests** (其中 17 来自本次 0.5.0)
- vi.mock `react-router-dom` 时 `mockNavigate` 必须用 `vi.hoisted` 包裹(hoisting 顺序问题,踩坑记入)

### 文件

- 新增:`packages/frontend/src/components/SubagentPanel.{tsx,css}` + `.test.tsx` + `packages/frontend/src/routes/SessionDetailRoute.test.tsx`
- 修改:ToolUseCard / MessageBubble / TranscriptView / SessionDetailRoute / SessionsRoute / SubagentPanel / lib/api.ts / i18n/zh-CN.ts / shared/normalize.ts / 5 个 Rust 文件
- 文档:`CHANGELOG.md` (本 section) + `e2e/detail-page.spec.ts` 注释

## [0.4.4] - 2026-06-25

### 变更

- **重新设计 app icon** — 1024×1024 SVG 源 (`icons/icon-source.svg`):
- 圆角矩形背景 (macOS 标准 22%) + 蓝紫青色对角渐变 (#5B6BFF #3F8FFF #00D4FF)
- 几何化 C 字母: 270° 圆弧 + 90° 开口朝右, 130px 粗笔画, 圆头端点
- 内圈一抹淡青色高光, 暗示 "session 流动"
- 左上柔光椭圆高光 + 细阴影 (feDropShadow dy=8, 22% alpha)
- **补 Linux 64×64 尺寸** — Tauri 2 推荐 launcher 64px, 加进 `tauri.conf.json` bundle.icon 数组
- **icon 流水线脚本** — `scripts/build-icon.mjs` (SVG 1024×1024 PNG, sharp + density 300) + `pnpm build:icons` 一行跑全套 (`build:icon` + `tauri icon`)
- **devDep `sharp` ^0.35.2** — 跨平台 SVGPNG 转换, 只 build icon 时用, production bundle 不影响

### 平台覆盖

- **macOS**: `icon.icns` 318KB (含 16/32/64/128/256/512/1024 多尺寸) — 自动 squircle mask
- **Windows**: `icon.ico` 6 icons (16/32/48/64/128/256) — 方形 tile
- **Linux**: 32/64/128/128@2x(256)/512 PNG — 透明背景, 跟系统 icon theme 配合
- **iOS / Android / Windows Store**: 完整 store icons 也重新生成

### 测试

- Rust 单元测试 94 个（不变）
- TypeScript 测试 24 个（不变）

## [0.4.3] - 2026-06-25

### 修复

- **会话内搜索 Next 按钮不滚动 + 加结果下拉列表** (`f5d54cf`)：原 useEffect 调 `jumpToEntry` 走 `scrollIntoView` 改 window viewport，但目标 entry 多半在虚拟列表的未渲染区(overscan 10)，`querySelector` 返回 null 静默失败。`TranscriptView` 加 `useEffect` 调 `virtualizer.scrollToIndex(localIdx, { align: "center" })` 把目标 entry 滚到可视区中央，让 DOM 就绪。
- **高亮 CSS selector 错配** (`f5d54cf`)：`SearchInSessionBar.css` 写的是 `.transcript-view .msg.search-hit-current`，但 `TranscriptView` 把 className 加在**外层 wrapper div** 而不是内层 `.msg`，永远匹配不上。改成 `.transcript-view [data-entry-index].search-hit-current`。
- **n/p 键缺失** (`f5d54cf`)：i18n 字符串和按钮 tooltip 都写 `(n)`/`(p)`，但只绑了 `enter` / `shift+enter`。补 `useKey("n")` / `useKey("p")`，跟其它键统一。
- **结果下拉列表** (`f5d54cf`)：搜索框下加 `position: absolute` dropdown，前 100 条 + "…还有 N 条"；每行 `#entryIndex · role · 时间 + snippet`，当前命中行加 `.is-active`；row click 调新 store action `setCurrentHitIndex(i)` 跳到该 entry；row mouseEnter 也 setCurrentHitIndex(悬停预览)；键盘 `/` 在 query 非空时 intercept 切 hit(空 query 让出原生光标行为)。
- **下拉 dropdown 飘到屏幕外** (`b2dba36`)：`.search-in-session-bar-wrapper` CSS 类漏写 没有 `position: relative`，`.search-results-dropdown` 的 `position: absolute; top: 100%` 锚定到错误祖先，飘屏。
- **时间筛选下点 row 跳到 hits[0] 而非点击的 i** (`b2dba36` / `379a135`)：`SearchInSessionBar` 里 row 渲染用了 `entries.find((e) => e.index === hit.entryIndex)`(全量)，跟 TranscriptView 渲染的 `filteredEntries` 不一致；filter 模式下 row 显示的 entry 可能不在 filter 范围，filter 范围变化时 ref 不稳定 真正根因是 `searchableEntries` 没用 `useMemo` 包装，`entries.filter()` 每次 render 返回新数组，触发 `useEffect([open, debouncedQuery, searchableEntries])` 每帧跑 `search()`，而 `search()` 内部会重置 `currentHitIndex = 0`。修：`searchableEntries` 用 `useMemo` 包，row 查找改用 `searchableEntries`。
- **点 row 后 dropdown 不关** (`2dc04ed`)：onClick 调 `setQuery("")` `showDropdown = query.length > 0` 自动折叠，bar 仍在可继续搜。
- **倒序 + filter 无限下拉** (`2dc04ed`)：原 auto-scroll useEffect 有 `!sortAsc` 和 `filterActive` 早 return，倒序 + filter 时新 entry 加载到顶部(倒序时新内容在顶)但用户 scroll 位置指向"旧底部"，virtualizer 总尺寸持续增长，体感"无限下拉"。改成"用户在底部(50px 容差)时跟随滚到底"统一逻辑，倒序 + filter 也能正常停止。
- **点 row 没正确定位** (`8f1c6f1`)：双跳转冲突 — `SearchInSessionBar` useEffect 调 `onJump  scrollIntoView` 改 window viewport，同时 `TranscriptView` useEffect 调 `virtualizer.scrollToIndex` 改 transcript-scroll 内部 scrollTop，两个改不同容器，`scrollIntoView` 覆盖 `scrollToIndex` 结果。修：`SearchInSessionBar` 不再调 `onJump`，只靠 `TranscriptView` 的 `scrollToIndex` 唯一负责滚动。`?line=N` URL 跳转仍走 `jumpToEntry` 不受影响。
- **agent-name meta block 不识别** (`8f1c6f1`)：`MetaBlockRenderer` case 是 `"agent_name"`(下划线)但 Claude JSONL `type` 是 `"agent-name"`(连字符)，switch 不匹配走 `UnknownBlockCard` 兜底；`isKnownMetaLabel` 也没列 `"agent-name"`。两个地方都加 `"agent-name"` 双匹配。

### 测试

- Rust 单元测试 94 个（不变）
- TypeScript 测试 41 51（不变，v0.4.3 全是 UI 修复,无新增单测）

## [0.4.2] - 2026-06-25

### 新增

- **Edit 工具 line-level diff 视图** (PR1)：引入 `diff` (jsdiff) npm 库,Edit `tool_use` 卡片从折叠 JSON dump 改成红删/绿增 inline diff,未变行灰色,`replace_all: true` 加 "替换全部" badge;5000 行 cap 走 fallback。`packages/frontend/src/lib/diff.ts` 薄包装 + `diff.test.ts` 5 case 单测。
- **Bash/Read/Task (TaskUpdate+TaskCreate) / tool_result 默认展开 + 优化展示** (PR2)：所有 tool 卡片 `useState(true)` 默认展开;Bash 卡片在等宽 code block 里显示 `command`、italic 灰字 `description`、"后台" badge;Read 卡片头部 `file_path` 粗体 + "lines N–M" offset/limit 指示;Task 卡片区分 TaskCreate (description + subagent_type + prompt 预览) vs TaskUpdate (taskId + status 大 badge);tool_result 卡片对常见代码文件后缀 lazy-import shiki 跑语法高亮 (前 500 字符)。其它 tool (Glob/Grep/WebFetch/WebSearch/Write/MultiEdit) 享受 default-open 但 body 仍 JSON dump。
- **时区设置** (PR3)：AppSettings 加 `timezone` 字段,Settings Appearance 加下拉 (auto/UTC/Asia/Shanghai/Asia/Tokyo/Europe/London/America/New_York/America/Los_Angeles,7 个常用 IANA);所有时间展示 (会话列表 / 详情 / 轨迹 / 消息气泡) 跟随;TranscriptView 时间 filter bar 的 `datetime-local` 改 TZ-aware (用 `formatLocalInputToIsoInTz` 显式把 naive 字符串按选定 TZ 解析,不再依赖浏览器 OS TZ);filter preset (1h/24h/7d) 数学 TZ-agnostic 仍正确。`format.test.ts` 5 case 单测覆盖 TZ 转换。

### 变更

- **会话列表 source 默认改回 OpenClaw**：v0.4.1 改成 Claude 防止误把 OpenClaw 当普通会话看,现在改回 OpenClaw (项目初衷),无 OpenClaw 数据时显示现有 "无匹配" 空状态,用户自行切 Claude。

### 测试

- Rust 单元测试 94 个（不变）
- TypeScript 测试 41 65 (+24: packages/frontend 新增 lib/diff 9 case + lib/format 15 case)

## [0.4.1] - 2026-06-25

### 修复

- **详情页深色主题 meta 块**：`theme/tokens.css` 缺少 `--color-surface-1` / `--color-surface-2` 两个 token，深色主题下 `.block-meta-info` 系列 fallback 到 `#f5f5f5` 浅灰背景，深色面板上变成"浅紫底深紫字"突兀。补 token 并清理 MessageBubble.css / TrajectoryView.css 里的硬编码 fallback。
- **子代理会话字段没专属样式**：Claude sub-agent 会话 content 数组里的 `mode` / `permission-mode` / `ai-title` / `custom-title` / `last-prompt` 被后端归一化成 `kind: "meta"`，前端走简化 pill 渲染（一行 ` mode: normal`），挤主流程。新增 `SubagentMetaBlock` 组件，按 label 识别并渲染成可折叠 details，默认折叠。
- **meta 分支的 7 种已知 block 没识别**：`file-history-snapshot` / `agent_listing_delta` / `skill_listing` / `plan_mode` / `pr-link` / `agent_name` / `task_reminder` 在 meta 消息里走 UnknownBlockCard 兜底样式（`? meta xxx N 字段`）。抽出共享 `MetaBlockRenderer` 组件，从 `block.payload` 解包字段（attachment 类型的数据全在 payload 里），按 label 路由到对应专属样式（ agent / skill / plan_mode / file_snapshot 等）。

### 变更

- **列表侧边栏 source 默认改 Claude**：移除"全部"单选，只剩 Claude / OpenClaw 二选一；首次打开默认进 Claude，避免误把 OpenClaw 会话当成普通会话看。
- **tool-chip 深色主题对比度**：`tool-chip` 背景从 `var(--color-surface-2, #e5e5e5)` 改成 `var(--color-bg-hover)` + 边框 + `var(--color-text)`，深色下清晰。

### 测试

- Rust 单元测试 94 个（不变）
- TypeScript 测试 41 个（不变）

## [0.4.0] - 2026-06-25

### 新增

- **会话详情时间段筛选** (PR1)：TranscriptView 顶部新增 4 个 preset (全部 / 1h / 24h / 7d) + 自定义 datetime-local 范围 picker；URL 持久化 `?from=ISO&to=ISO`；meta 消息 (无 timestamp) 保留；search 也在筛选后范围跑
- **会话列表 UI 增强** (PR2)：卡片新增首条 user 提问预览 (1 行省略) + thinking/tool 统计 chips + top 3 工具名；时间显示智能相对化 (刚刚/X 分钟前/X 天前)；后端新增 `firstPrompt` / `lastMessageAt` / `thinkingCount` / `toolUseCount` / `topTools` 字段
- **OpenClaw Trajectory 支持** (PR3)：详情页 header 新增 "运行轨迹" 按钮 (仅 OpenClaw + 有 trajectory 的 session 显示)；新路由 `/session/:id/trajectory` + 8 种事件专属卡片 (session.started / session.ended / trace.metadata / context.compiled / prompt.submitted / model.fallback_step / model.completed / trace.artifacts)；流式加载 + 50 MiB 上限；支持 `.trajectory-path.json` 指针文件 (OPENCLAW_TRAJECTORY_DIR 重定向)

### 测试

- Rust 单元测试 91 94 (+3 trajectory 归一化测试)
- TypeScript 测试 41 个(不变)

## [0.3.2] - 2026-06-25

### 新增

- **3 个新 BlockHandler**（响应 issue #11/#12/#13）：
- `pr-link` `pr_link`:显示 PR 链接卡片,可点击跳转
- `agent-name` `agent_name`:显示当前 agent 标识
- `task_reminder` `task_reminder`:显示任务列表快照（pending/inProgress/completed 计数 + 详情展开）

### 修复

- 关 issue #6/#7/#9/#10:这 4 种 block type 已在 v0.3.1 加专属 handler,UI 不再显示 `[kind]`

### 测试

- Rust 单元测试 85 91 (+6)

## [0.3.1] - 2026-06-24

### 新增

- **会话详情排序切换**：TranscriptView 顶部新增正序/倒序按钮，支持按消息顺序切换
- **4 个新 BlockHandler**：`agent_listing_delta`、`skill_listing`、`plan_mode`、
  `file_history_snapshot` 现在有专属渲染（之前走兜底 UnknownBlockCard）
- README 新增 macOS Gatekeeper 临时解决方案

### 修复

- 修复编译告警：新 handler 测试模块移除多余的 `use super::*` 导入

### 重构

- 新增 `agent_listing.rs`、`skill_listing.rs`、`plan_mode.rs`、`file_snapshot.rs` handler

### 测试

- Rust 单元测试 85 个（+8）

## [0.3.0] - 2026-06-24

### 重构

- **BlockRegistry 模式重构 parser**：新增 `BlockHandler` trait + `BlockRegistry`
- `default_registry()`，加新 block type 只需实现一个 handler + register，
  不再需要改 `match` 语句。

* `normalize_content_block` 委托给 registry (行为不变,53 测试全过)
* `MetaBlockHandler` 最后注册作为兜底 catchall

- **Handler 独立文件**：
- `text.rs` / `thinking.rs` (PR2)
- `tool_use.rs` (5 alias: `tool_use`/`toolUse`/`tool_call`/`function_call`/`toolCall`)
- `tool_result.rs` (2 alias: `tool_result`/`toolResult`)
- `image.rs` / `meta.rs` (PR3)
- **OpenClaw 去 wrapper** (PR4)：
- 不再伪造成 Claude 格式，直接解析 OpenClaw 记录
- `message` type content 走 `BlockRegistry::normalize`
- `tool` role 不再改写为 `user`
- 消除前后端 normalize 路径不对称

### 新增

- **UnknownBlockCard 前端组件** (PR5)：
- `<details>` 默认折叠，展开后显示字段表 + 启发式 hint pills
- 复制 JSON 按钮 + 报告 GitHub issue 链接
- 未知 block type 不再仅显示 `[kind]` 一行字
- **8 个新 handler 独立测试文件**，每个 handler 覆盖 alias/边界/缺失字段

### 移除

- 移除 v0.2.6 调查残留日志（`window.addEventListener("error")` hooks、
  `console.log` banner、`document.title` 注入、`BlockRenderer` 内 console 日志）
- `transcriptStore.ts` 中 dev `console.error("[stream_transcript:error]")`

### 测试

- Rust 单元测试 53 77 (+24，覆盖所有 handler alias + OpenClaw 独立路径)
- TypeScript 类型检查 + Vite build 干净
- Clippy + cargo fmt 干净

## [0.2.6] - 2026-06-24

### 修复

- **Windows [object Object] 错误**：`invoke` 抛 error 对象时 `String(e)` 产生
  `"[object Object]"`。前端 `extractErrorMessage(e)` 优先提取 `message` / `kind` 字段，
  UI 显示真实错误描述而非 `[object Object]`。
- **路径安全 Windows UNC 前缀**：`canonicalize()` 返回 `\\?\C:\Users\...` 而 target
  是短路径 `C:\Users\...`，字符串前缀比较失败。新增 `path_starts_with()` 函数统一分隔符、
  忽略大小写、去掉 `\\?\` 前缀，Windows 路径检测恢复正常。
- **pi-coding-agent toolCall 不识别**：`tool_call` / `toolCall` / `function_call` 5 个别名
  现在统一识别为 `tool_use`，`arguments` 字段自动重命名为 `input`。
- 重复 session 修复：`Path::extension()` 只取最后一段扩展名，导致 `*.trajectory.jsonl`
  被误认为 `jsonl` 文件。walker 增加 `file_stem` 末缀过滤。

### 调试改进

- 首次复现阶段添加分层日志：Windows banner + document.title + console.error 结构化输出

## [0.2.5] - 2026-06-24

### 新增

- **自定义数据源根目录**：Settings 页可添加多个自定义 Claude/OpenClaw 根目录。
  自动探测 `projects/` / `agents/` 子目录判定类型，添加后立即生效。
- **热重载**：保存 settings 后自动 invalidate 缓存 + 通知前端刷新列表，无需重启。
- **跨平台路径安全**：`AppPaths` 支持多 root 路径检测，`assert_within_any_root` 遍历
  所有注册根目录验证路径合法性。

### 修复

- Clippy `needless_borrow`：`load_settings_on_startup(&app.handle())` `app.handle()`。

### 架构

- `AppPaths` 重构为 `default_root + custom_roots` 模型，`RwLock<AppPaths>` 线程安全
- `RootSource` 分离 Claude/OpenClaw 子路径，`all_claude_projects_dirs()` /
  `all_openclaw_agents_dirs()` 统一扫描入口
- `CustomRoot::probe()` 自动探测路径类型

## [0.2.4] - 2026-06-24

### 新增

- **多 Agent UI**:OpenClaw 按 agent 二级分组(顶层紫色 Bot icon,
  副标题显示 channel · label,卡片底部 channel badge)。
- `SessionMeta` 加 `agentId` / `agentLabel` / `agentChannel` /
  `agentTarget` 4 个字段(都 optional,向后兼容)
- 后端从 per-agent `sessions.json` 索引读 label/channel/target
  (文件不存在或 JSON 损坏返回空,不阻塞列表加载)
- `projectKey` 加 `openclaw:` 前缀避免与 Claude projectKey 冲突
- 前端 sessionsStore 加 `agentId` filter(只在 > 1 个 agent 时显示)
- 文本搜索范围扩展到 `agentId` / `agentLabel` / `agentTarget`

### 测试

- Rust 单元测试 35 41(+6 sessions.json 容错/解析测试)

## [0.2.3] - 2026-06-23

### 修复

- macOS 搜索会话崩溃: `Cargo.toml` 里 `panic = "abort"` 编译期
  把 `catch_unwind` / `panic::set_hook` 全部绕过,改回默认
  `panic = "unwind"` 即可;`search.rs` 里再加 UTF-8 char boundary
  防护(`floor_char_boundary`)+ 单条记录 panic log + 吞掉(rust
  2024 不允许 rethrow),单条坏数据不再拉整 App 陪葬。
- 会话列表把 `*.trajectory.jsonl` 误当成 session 列出来
  (openclaw 写在每个 session 旁边的观测/trace 副产物,不是用户
  会话;`Path::extension()` 只取最后一段所以会漏过)。walker 加
  `file_stem` 末缀过滤 + 单测。
- 会话详情返回按钮渲染了两把箭头(JSX 里 `<ArrowLeft />` +
  i18n `back` 字符串里的字面 ``)。删掉 i18n 里的字面箭头。

## [0.2.2] - 2026-06-23

### 修复

- Windows MSI bundling fails on non-ASCII `productName`
  ([tauri-apps/tauri#8363](https://github.com/tauri-apps/tauri/issues/8363)):
  switched to ASCII `OpenClaw Session Viewer`. Window title still
  shows `OpenClaw 会话查看器` at runtime.
- Windows / Linux builds missing `icons/icon.ico`: now committed
- regenerated automatically by CI if missing.

### 变更

- README download table + `docs/RELEASING.md` asset list updated
  to ASCII bundle filenames, with note explaining the rationale.

## [0.2.1] - 2026-06-23

- 修复 window 以及 linux 创建 release 失败问题

## [0.2.0] - 2026-06-23

- 增加 github action 创建 release

### 计划

- 会话对比 (diff)
- 拖拽导入 JSONL
- VS Code 路径跳转

## [0.1.0] - 2026-06-22

### 新增

- 基础会话列表 + 转录查看(Claude Code + OpenClaw)
- 全局跨会话搜索 (Cmd/Ctrl+K)
- 会话内搜索 (Cmd/Ctrl+F,n/p 跳转)
- URL 跳转 (`?line=N`)
- 大模型分析 (4 模板 + 自定义,Anthropic 兼容)
- Markdown / HTML 导出
- 实时 PID 状态(显示运行中的 CLI)
- 工具溢出文件查看
- 深色 / 浅色 / 跟随系统主题
- 中文界面
- 跨平台打包 (macOS / Windows / Linux)
- Rust 单元测试 28 个,TypeScript 测试 41 个
- GitHub Actions CI (lint/test/build)
- GitHub Actions Release(三平台并行 + 自动发版)

### 修复

- OpenClaw camelCase 工具调用 (`toolUse`/`toolResult`) 不识别
- OpenClaw tool 结果 role 被错误映射为 user
- `normalizeClaudeRecord(null)` 抛错
- `joinPath("/a/", "b", "c")` 丢失绝对路径前缀
- macOS 上直接运行裸二进制导致 webview 空白(必须 .app bundle)

### 文档

- README 重写(GitHub 风格)
- docs/ARCHITECTURE.md — 架构总览
- docs/CROSS_PLATFORM_BUILD.md — 跨平台构建指南
- docs/TROUBLESHOOTING.md — 已知问题与解决方案

[Unreleased]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nemo1991/openclaw-session-viewer/releases/tag/v0.1.0
