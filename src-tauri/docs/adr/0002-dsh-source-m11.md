# DeepSeek Harness (dsh) 作为第 4 种 wire-format source (v0.9.28 / M11)

把 `~/.dsh/sessions/` 接入现有的 3-source 解析/聚合/UI 框架,作为第一类
filter / badge / graph label。需要兼顾两个 wire-format 的特殊性: `.jsonl.zstd`
压缩 + `--Users-foo-bar--` 包裹的项目目录名。

**Status**: accepted (v0.9.28)

## Context (背景)

`openclaw-session-viewer` 当前 3 种 source:
- Claude Code (`~/.claude/projects/.../*.jsonl`)
- OpenClaw (`~/.openclaw/agents/.../sessions/*.jsonl`)
- Kimi Code (`~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`)

用户把 **DeepSeek Harness** (4th source) 加入使用:`~/.dsh/sessions/<project>/session-<uuid>/session.jsonl.zstd`。

Wire-format 两个核心 twist,要求新基础设施(超出 "再加一个 builder"):
1. **`.jsonl.zstd`** — 每个文件都是 zstd 压缩的 JSONL。需要纯 Rust `zstd = "0.13"`
   reader + 在 `parser/jsonl.rs` 加一个按扩展名派发的 wrapper,让现有 3 source 调用点零改动。
2. **`--Users-foo-bar--` bracket 包裹** — dsh 把 Claude 风格编码再包一层 `--…--`。
   纯 `decodeClaudeProjectKey` 不能 round-trip;加一个 dsh 专属 decoder
   (strip bracket → delegate Claude),project_key 在 DB 里以 `dsh:<dir-name>`
   不透明存储,避开 lossy decode。

M11 落地后,source union 从 3 增到 4 (`claude` / `openclaw` / `kimi` / `dsh`),
UX 一致(filter chip / source badge / graph label / settings heuristic 都有 dsh 入口)。

## Decision (决策)

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| Source label (DB CHECK + i18n key) | `"dsh"` | 沿用现有 3 字母模式,CHECK constraint 加 `'dsh'` |
| Project-key 存储 | 不透明 `dsh:<dir-name>` | dir-name 是稳定 identity;bracket 是 name 一部分。避免每次读取做 lossy re-decode |
| `workspace_guess` decode | 新 `decodeDshProjectKey` (TS + Rust):strip `--…--` 还原 `-…-` 前缀,再 delegate Claude decoder | 纯 display value;round-trip lossy (与现有 Claude decoder 容忍度一致) |
| Compression reader | 新 `parser/jsonl_zst.rs` 镜像 `parser/jsonl.rs`;`jsonl::for_each_line_auto`/`count_lines_auto`/`parse_first_n_auto` 按 `.zst`/`.zstd` 扩展名派发。现有 3 source 走非压缩分支 | 单点开关,现有 call site 零改动 |
| Aggregator | 新 `aggregate_dsh(path)` 在 `meta_aggregator.rs` 镜像 `aggregate_kimi`(走 `data.*` 子对象的 envelope 形态) | dsh envelope 比 claude/openclaw 更接近 kimi(claude/openclaw 是 envelope-free 顶层) |
| Subagents | v0.9.28 不做 — `~/.dsh/sessions/` 样本里没看到 `subagents/` layout | Feature-flag-able later;ADR pointer |
| `parent_uuid` | v0.9.28 不做 — dsh envelope 没有 `parentUuid` 字段 | 文档 backlog |
| Token-usage column | 复用 `kimi_token_usage_json` (Option A):同一列,dsh tokens 也写这里。注释 + TODO 推 v0.9.29 重命名 | 避免 schema rebuild dance;列在语义上是 wire-agnostic |

## Architecture (架构)

```
                          ┌────────────────────────────────────┐
                          │  parser/jsonl.rs                   │
   for_each_line_auto  ──▶│  dispatch on extension:            │──▶ non-zstd
                          │   .zst / .zstd → jsonl_zst::*_zst  │──▶ zstd
                          └────────────────────────────────────┘

   aggregate_dsh(path) ──▶ for_each_line_auto ──▶ envelope dispatch:
     - session          → agent_name (top-level agentPreset, fallback data.agentPreset)
     - user/message     → user_message_count + first_user_time
     - assistant/message→ model, thinking/text/tool-call (via data.message.content[]),
                          kimi_token_usage (reuse Option A), repeat_run + idle_gap
     - tool/call        → call_id_to_name 反查 + tool_usage
     - tool/result      → error_count + tool_error[] (反查 source.callId)

   build_dsh_session_meta(ds) ──▶ 47 列 INSERT 到 session_meta
                            ──▶ decode_dsh_workspace_guess(ds.project_key) for display
```

## Subagents + parent_uuid (deferred)

`~/.dsh/sessions/` 抽样没观察到 `subagents/` layout。dsh envelope 也没有
`parentUuid` 字段,所以 v0.9.28 不实现:
- `commands/subagents.rs` 的 `"dsh"` 分支返回空 Vec
- `parentUuidsText` 永远为空字符串
- `normalize_dsh_record` 把 `tool/call` event 视为 `meta`(独立声明 callId → name
  关系,不参与 assistant message 归一化)

如果未来 dsh 加入 subagent layout,把这两个分支实现起来即可(已在 ADR 留 pointer)。

## Alternatives considered (考虑过的备选)

### Alt 1: 新建独立 `session_meta_dsh` 表而不是扩 `session_meta`

- ❌ Schema 复杂化,前端要 union 多个 source
- ✅ 零 migration 成本
- ❌ 不能 union 跨 4 个 source 查 "total messages / tokens"

M10 单 pass 架构已经把 47 列固化进一张表,4th source 也应该 follow 同模式。

### Alt 2: 把 dsh token 写新列 `dsh_token_usage_json` 而不是复用 kimi 列

- ✅ 列名语义清晰
- ❌ 加列触发 SQLite table rebuild (12 步 dance)
- ❌ 跟 M11-A zstd dispatch 的 "透明化" 哲学相悖 — dsh 是 4th source,不是
     单独的"特殊"source

Option A (复用列) 赢:把 `kimi_token_usage` rename 到 `session_token_usage`
推迟到 v0.9.29。

### Alt 3: dsh wire 用 streaming collapse state machine

- ✅ 可以 collapse streaming chunks (`assistant/chunk` 等)
- ❌ dsh wire 已经在 `assistant/message` 里 pre-collapse 了,再加 state
     machine 是死代码

v0.9.28 走 per-event normalize (跟 kimi 同思路),v0.9.29+ 再考虑 streaming
chunk 折叠 (`meta_banner` 等)。

## Migration dance (CHECK 约束)

`session_meta.source` 是 `CHECK(source IN ('claude','openclaw','kimi'))`,
加 `'dsh'` 必须走 SQLite 12 步 rebuild dance:

1. 备份原表 → `session_meta_backup`
2. 改 schema line 36:`CHECK(source IN ('claude','openclaw','kimi','dsh'))`
3. `apply()` 时按顺序跑 `ensure_kimi_in_source_check` → `ensure_dsh_in_source_check`
4. 每条 migration 用 `.replace()` 兼容 3 种状态:
   - pre-kimi:`'claude','openclaw'`
   - post-kimi:`'claude','openclaw','kimi'`
   - post-dsh:`'claude','openclaw','kimi','dsh'` (idempotent skip)
5. 测试覆盖:post-kimi 链式 / pre-kimi fallback / idempotent skip

## Verification (验证)

- `cargo test --workspace` 全绿(376 lib tests + 16 migration tests)
- `pnpm test` 全绿(54 shared + 687 frontend)
- 真实 `~/.dsh/sessions/` 同步 → DB 行有 `source='dsh'`,badge "DeepSeek Harness",
  filter chip 工作,transcript 渲染 user/assistant/tool blocks,graph view 显示
  dsh 节点 + 正确 label
- 多 source 同步 (Claude + dsh) 都正确归位

## Future work (backlog)

| Item | Why deferred | Target |
| --- | --- | --- |
| `parent_uuid` for dsh | wire 无 `parentUuid` 字段 | v0.9.29+ |
| Subagent walk for dsh | 没观察到 `subagents/` layout | v0.9.29+ |
| `kimi_token_usage` rename → `session_token_usage` | schema migration 成本 | v0.9.29 (low priority) |
| Streaming-chunk 可视化 | 当前 filter 到 None;可作 timeline ripple | v0.10+ |
| `meta_banner` for dsh permission/approval/sandbox | 当前 emit meta;可折叠成 banner | v0.9.29+ |