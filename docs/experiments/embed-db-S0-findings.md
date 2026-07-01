# S0 findings: ingest CLI 跑通 stdout sink

**日期**: 2026-07-01
**Sprint**: S0 (本周) — branch + ingest skeleton + doc 概要
**分支**: `experimental/embed-db`
**commit**: 待 push

---

## ✅ 完成清单

- [x] 创建实验分支 `experimental/embed-db` (从 `feature/subagent-parent-link`)
- [x] 仓库结构: `experiment/embed-db/{Cargo.toml workspace, ingest 子 crate, web/ (空)}` + `docs/experiments/{README, embed-db-S0-findings}`
- [x] ingest 子 crate 含 4 个模块 + 1 个 sink: `graph.rs` / `scanner.rs` / `parser.rs` / `cli.rs` / `sinks/stdout.rs` / `main.rs`
- [x] 共享 graph schema:`SessionNode`(15 字段) + `Edge`(5 类型: Spawned / ParentUuid / UsedTool / AttemptedFix / CrossSession) + `SessionGraph`
- [x] Cli: clap derive,`ingest --path <dir> --out stdout`
- [x] Sink trait + StdoutSink (NDJSON 输出)
- [x] 6 个单测通过(scanner 3 + parser 3)
- [x] CLI 跑 fixture & 实测数据:
  - ✅ Fixture (`fixtures/sample-claude.jsonl`) → 1 session,1001 行,2.89M tokens,UsedTool Bash=286
  - ✅ Real `~/.claude/projects` → 35 sessions,其中 1 个主 session 含 25 个 subagent(OpenClaw Session Viewer 自身开发)

---

## 实测数据展示

### fixture sample-claude.jsonl

输入: 1001 行 Claude JSONL, fixture 自动生成

输出 1 行 NDJSON:

```json
{
  "node_id": "node:/tmp/exp-fixtures/sample.jsonl",
  "source": "Claude",
  "session_id": "fixture-session-uuid-1234",
  "size_bytes": 401992,
  "first_prompt": "请帮我实现一个 TODO 应用的 CRUD 接口,使用 TypeScript 和 SQLite",
  "first_timestamp_ms": 1781517600000,
  "last_timestamp_ms": 1781577540000,
  "token_total": 2890775,
  "subagent_count": 0,
  "subagent_ids": [],
  "is_subagent_root": false,
  "parent_session_id": null,
  "message_count": 1001,
  "edges": [{ "type": "UsedTool", "session": "...", "tool_name": "Bash", "count": 286 }]
}
```

### 真实 `~/.claude/projects` 关键 session

**主 session 1** (`a2349f0e-...` OpenClaw Session Viewer 自身开发):

```json
{
  "session_id": "a2349f0e-...",
  "first_prompt": "了解一下openclaw 创建的session目录结构...",
  "subagent_count": 25,
  "subagent_ids": ["agent-a4aa771a37b9e06bf", "agent-a42e236e77fe4606c", ...25 个],
  "edges": [
    { "type": "Spawned", "from_session": "...", "to_subagent_id": "agent-a4aa771a37b9e06bf", "to_subagent_path": "..." }, // ×25
    { "type": "UsedTool", "tool_name": "..." },   // ×16
    { "type": "AttemptedFix", "error_count": N }
  ]
}
```

**这就是 S1 Graph view PoC 要喂的数据** — 25 个 subagent 节点 + 25 条 Spawned 边可以立刻画力导向图。

---

## 决策与发现

### ✅ 好

1. **完全独立的子 crate 零 rebase 摩擦**
   - 全部 ingest 代码在 `experiment/embed-db/`,不污染 main
   - main 上修复 parser / 加 SessionMeta 字段时,本分支可以单独 rebase
2. **schema 设计能 cover 三个 PoC 的输入需求**
   - G1 Graph 需要的 (session ↔ subagent, tool calls 计数, parent chain) 都已经产出
   - G2 OLAP 需要的 (token 聚合, time range, tool 分布) 也都到位
   - G3 RAG 需要的 (first_prompt 文本) 已经产出(后续会加 assistant text content)
3. **NDJSON stdout 是天然管道**
   - 后续三个 sink (surreal / parquet / sqlite) 直接读 stdin / pipe 就好
   - jq / python 都可以消费

### ⚠️ 限制 (现在已知)

1. **没用 raypar / async** — 35 session 跑 0.x 秒,到 5000 session 不确定;S1 加并发
2. **subagent 关联靠 sibling 目录推导** — Claude 实际布局是 `projects/<encoded>/<uuid>.jsonl` + `projects/<encoded>/<uuid>/subagents/`,逻辑找对 sibling,但 OpenClaw 路径未测
3. **没处理 edge 类型 SingleMessageParentUuid** — Claude envelope 有 `parentUuid` 字段,但目前只产出 main_session ↔ subagent 边,不画单 message 链。G1 PoC 决定要不要加
4. **fields 不全** — `primary_model` / `thinking_count` / `top_tools` / `subagent_count` 等 v0.5.0+ 字段还没从 JSONL 推出来

---

## 路线图对照

| Task                        | Status | 备注        |
| --------------------------- | :----: | ----------- |
| S0 branch + skeleton + docs |   ✅   | 本 findings |
| S1 G1 Graph view 跑通       |   ⏳   | 下周        |
| S2 G2 OLAP 跑通             |   ⏳   | 下下周      |
| S3 G3 RAG 跑通              |   ⏳   | 三周        |
| S4 三 PoC findings + 决策   |   ⏳   | 四周        |

---

## 下一步 (S1 启动前)

1. **push 当前代码到 origin**:
   ```bash
   git add experiment/ docs/experiments/
   git commit -m "experiment(embed-db): S0 ingest skeleton + stdout sink"
   git push origin experimental/embed-db
   ```
2. **新建 web 子项目** — Vite + React + TypeScript 用 pnpm workspace 化
3. **新建 surreal sink** — `cargo add surrealdb` 在 ingest/Cargo.toml
4. **加更多 SessionNode 字段**(`primary_model` / `thinking_count` / `top_tools[0..3]`)供 G1 graph view 节点着色

---

## 验证步骤 (你也能跑)

```bash
cd /Users/forcetone/workspace/claude/openclaw-session-lookup
git checkout experimental/embed-db  # already on this branch

# 编译 + 跑测试
cd experiment/embed-db
cargo test --release   # 6 passed
cargo build --release

# 跑 fixture demo
cp ../../fixtures/sample-claude.jsonl /tmp/exp-test.jsonl
cargo run --release -- ingest -p /tmp/exp-test.jsonl-dir --out stdout 2>/dev/null
# ↑ 期待 1 行 NDJSON

# 跑真实数据
cargo run --release -- ingest -p ~/.claude/projects --out stdout 2>/dev/null > /tmp/real.ndjson
wc -l /tmp/real.ndjson
python3 -c "
import json
hits = [json.loads(l) for l in open('/tmp/real.ndjson') if json.loads(l)['subagent_count'] > 0]
print(f'{len(hits)} sessions have subagents')
for h in hits[:3]:
    print(f'  {h[\"session_id\"][:8]}... → {h[\"subagent_count\"]} subagents')
"
```

---

## 文件清单 (本 sprint 创建)

```
docs/experiments/
├── README.md                              # 3 PoC 概览 (44 行)
└── embed-db-S0-findings.md                # 本文件

experiment/embed-db/
├── Cargo.toml                             # workspace + shared deps
└── ingest/
    ├── Cargo.toml
    └── src/
        ├── main.rs                        # 入口 + CLI orchestration (70 行)
        ├── cli.rs                         # clap 参数 (55 行)
        ├── graph.rs                       # 共享 schema (113 行)
        ├── scanner.rs                     # WalkDir 复刻 (88 行)
        ├── parser.rs                      # JSONL → SessionGraph (260 行)
        └── sinks/
            ├── mod.rs                     # Sink trait (24 行)
            └── stdout.rs                  # NDJSON sink (49 行)
```

共 ~660 行业务代码 + 130 行测试。
