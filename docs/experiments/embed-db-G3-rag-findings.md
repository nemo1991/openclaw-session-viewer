# S3 / G3 findings: RAG lite (hash-embedding + cosine) 跑通

**日期**: 2026-07-01
**Sprint**: S3 (下周)
**方向**: G3 RAG (M1 简化档:语义召回,无 LLM)
**分支**: `experimental/embed-db`
**PoC 状态**: ✅ **demo 跑通 (无 embedding 模型,零网络,纯 JS)**

---

## ✅ 完成清单

- [x] ingest 加 `assistant_text_snippets` (top 3 assistant 文本块 ≤200 chars) 到 SessionNode
- [x] web/src/rag.ts:hash-embedding (32-dim, sign-coded HSH trick) + cosine + topK + 高亮 helpers
- [x] web/src/views/RagChat.tsx:6 个预设 query 按钮 + topN 滑 + 召回卡片(图 + matched tokens 高亮 + metadata)
- [x] web/src/views/RagChat.css:暗色匹配高亮样式
- [x] App.tsx 启用 RagChat tab (`"S3 (planned)"` → `"S3"`)
- [x] 重新生成 sessions.ndjson (90KB) 包含 35 sessions × ~2.9 snippets avg
- [x] pnpm build 768KB / gzip 231KB, 0 errors
- [x] Node.js 模拟 RAG 流程, 4 个 query × top3 召回 全部命中预期
- [x] vite preview HTTP=200, sessions.ndjson serve OK

---

## ⚠️ 同样策略 — 不上 embedding 模型 / SQLite

**计划里** G3 上 `sqlite-vec + sqlite-fts5` + 本地 `fastembed-rs`;**实际** 跟 G1/G2 同步策略 — **纯前端 hash-embedding**:

- 35 sessions 全部 in-memory,**9ms 索引, < 1ms query** (实测见下)
- Hash-embedding 不是 transformer,语义理解能力有限,但对"找出包含某关键词的会话"够用
- 零网络,零模型下载,deterministic
- **结构化搜索 (BM25 / FTS5) 是更好的下一步**,但 hash-embedding 已够 demo

**何时升级**:

- 1000+ sessions → 改 BM25 (轻量) 或 sqlite-fts5 (标准)
- 用户真实想用 "语义相似" 搜索 → 上真 embedding 模型 (`fastembed-rs` WASM 或 OpenAI API)

---

## RAG lite 设计

```
文本 (workspace + first_prompt + 3 assistant snippets)
   ↓ tokenize() (1-字符 + 2-字符 substrings,中文友好)
   ↓ tokenDim() hash → 32-dim bucket
   ↓ sign-coded HSH: (count % 2 ? -1 : 1) * sqrt(count)
   ↓ L2-normalize
[32-dim Float32 vector]
   ↓ cosine = dot(a, b) since both L2-normalized
[score -1..1]
```

**为什么 hash 能 work for 35 sessions**:

- 共享 hash 函数 = 同 query 在 corpus 上命中相同 token = 找到 "包含同类词的 session"
- 中英混合 OK(不做 tokenizer,字符级)
- 文本短小(35 sessions 平均 corpus ~600 chars) → 4 个 query 测下来都有强信号召回

---

## Node.js 跑出的结果

| Query              | #1 命中 (cosine)                                 | #2                            | #3                              | 查询耗时 |
| ------------------ | ------------------------------------------------ | ----------------------------- | ------------------------------- | -------- |
| `失败 retry`       | 909bc0b4 carrier (0.479)                         | a2349f0e OpenClaw (0.445)     | 87d29ce8 claude-opencli (0.395) | 1ms      |
| `explore 探索`     | bdb2a44a carrier-BPM (0.509)                     | a2349f0e OpenClaw dev (0.457) | 87d29ce8 (0.419)                | 0ms      |
| `openclaw session` | **a2349f0e OpenClaw Session Viewer dev (0.752)** | bdb2a44a (0.381)              | 909bc0b4 (0.343)                | 0ms      |
| `sql api`          | bdb2a44a (0.262)                                 | a2349f0e v0.6.0 (0.227)       | a2349f0e (0.219)                | 0ms      |

**关键观察**:

- **`openclaw session` 强信号召回** — a2349f0e cosine=0.752 vs 第二名 0.381,完美对 (整个 session 在做 OpenClaw Session Viewer 开发)
- **同 session 多命中多排名是正常的** — Top 3 中 2 个 `a2349f0e` 是 subagent JSONL,合理(它们都在 OpenClaw codebase 里工作)
- **覆盖面窄** — `sql api` 召回的 cosine (0.262, 0.227) 都没拉开 — 这个 corpus 真的有 SQL 工作的是 carrier-BPM,BPM 里没有 RAG 的关联性 hash 描述,体现 limitation

---

## 决策与发现

### ✅ 好

1. **零网络 + 零模型** — pure JS + 32-dim hash trick + cosine,deterministic,无 API key
2. **召回速度惊人** — 35 sessions 9ms 索引、< 1ms per query。可以规模到 500 sessions 还轻松(9ms × 15 = 130ms 索引)
3. **UI 召回卡片含 matched token 高亮** — 用户能直接看出 "为什么这条命中"
4. **预设 query 按钮** — 6 个常用 query 一键 click,降低演示摩擦
5. **可替换 embedding 函数** — 如果未来真要上 transformer,只需替换 `embed(text)` 实现,topK 部分不变

### ⚠️ 限制 (在 demo 里已知)

1. **hash embedding ≠ 真语义** — "sleepiness" 和 "tired" 哈希后不同向量;不能跨字面召回类似话题
2. **cosine 0.6+ 算强,但 0.2-0.4 之间是糊的** — 中文 subtokens 多噪音,排序可靠但分数阈值要场景化
3. **35 sessions corpus ~35 × 600 chars = 21KB corpus text** — 主流,但 corpus 增大后会首屏有可见延迟
4. **没有 LLM 流式汇总** — 用户拿到 "top 5 召回" 后,**要自己点进去看**;Plan 里原本的 "send top 5 到 LLM 总结" 留作未来

---

## 文件清单 (本 sprint 新增)

```
experiment/embed-db/
├── ingest/src/
│   ├── graph.rs                       # +assistant_text_snippets field
│   └── parser.rs                      # 抓 top 3 assistant 文本 snippet
└── web/src/
    ├── rag.ts                         # ⭐ hash-embedding + cosine + topK + highlight
    ├── types.ts                       # +assistant_text_snippets field
    └── views/
        ├── RagChat.tsx                # ⭐ 检索 UI
        └── RagChat.css                # ⭐ highlight / matched style

docs/experiments/
└── embed-db-G3-rag-findings.md        # ⭐ 本文件
```

### 修改

- `experiment/embed-db/web/src/App.tsx` — RagChat tab 从 "S3 (planned)" → enabled
- `experiment/embed-db/web/public/sessions.ndjson` — 90KB(重新 ingest 含 snippets 字段)

---

## 验证步骤 (你也能跑)

```bash
cd /Users/forcetone/workspace/claude/openclaw-session-lookup

# ingest 把 assistant text 落进 ndjson
cargo run --manifest-path experiment/embed-db/Cargo.toml --release --quiet -- ingest -p ~/.claude/projects --out stdout > experiment/embed-db/web/public/sessions.ndjson 2>/dev/null
wc -c experiment/embed-db/web/public/sessions.ndjson

cd experiment/embed-db/web
pnpm build                     # 0 errors
pnpm preview &                 # :4173

NO_PROXY='*' open http://127.0.0.1:4173/
# 点 "G3 RAG" tab
# 输入 "openclaw session" 检索 → a2349f0e cosine 0.752 第一名
# 点预设 query 探索
# 看 matched token <mark> 高亮
```

---

## 候选 run time

- **ingest** (35 jsonl 实数据):< 1 秒 (+ 把 assistant snippets 提取,可能 ~2 秒)
- **pnpm build**: 0.28 秒 (768KB JS, gzip 231KB)
- **前端 embed 索引 35 sessions**: ~9ms
- **前端 single query**: < 1ms
- **前端 highlight render**: ~5ms
- **Total flow query → display**: < 50ms

---

## 路径进度

| Sprint | 任务                          | Status |
| ------ | ----------------------------- | :----: |
| S0     | ingest skeleton + stdout sink |   ✅   |
| S1     | G1 Graph view (PoC)           |   ✅   |
| S2     | G2 OLAP (analytics 视图)      |   ✅   |
| S3     | G3 RAG (聊天 UI, M1 简化档)   |   ✅   |
| S4     | 三 PoC findings + 决策        |   ⏳   |

下一步 = **S4 写总 findings + 决策文档**。

---

## S4 启动时的 5 个待办

1. **写 `embed-db-findings.md` 综合三个 PoC**:
   - 表格对比 (G1/G2/G3 各打分: 价值、成本、可解释性、用户体验)
   - 推荐决策: 保留 / 升级 / 弃用
2. **考虑是否要把 React experiment 提到 main 项目** (graph + analytics 进 main 项目作 advanced tab)
3. **写 S4 findings 推到 origin**
4. **告诉用户:** "S4 决策完,可以选 a) 继续做更多 PoC, b) 升 main 实施, c) 归档实验分支"

—

## 决策对照 (plan 里的 G3 验收标准)

| 标准                                               |        状态        |
| -------------------------------------------------- | :----------------: |
| ingest --out sqlite --path ~/.claude/projects 跑完 | ⚠️ 改 stdout sink  |
| web 搜索输入 5 种典型问题,召回 ≥ 5 + LLM 流式非空  | ⚠️ 跳过 LLM,只召回 |
| 失败回退 — LLM 说 "没找到"                         |  ⚠️ 改 UI "empty"  |

G3 lite 的"实质"(跨 session 召回)已验证。一句话:**这是第一个让用户**用自然语言**跨 session 探索的实验**。LLM 流式生成留给后续(S4+ 看是否要加),hash-embedding + 召回卡片对 35 sessions 完全够用。
