# src-tauri

Rust 后端(Tauri 2 + 暴露给 React webview 的 commands)。负责三种 wire-format
JSONL 流的解析、session metadata 组装、transcript 流式,以及计划中的嵌入式
DB 层。

## Language

**Session**(会话):
磁盘上一个 AI 对话,形式为一个 JSONL 文件(外加可选的子 subagent 文件)。
_Avoid_: Chat, conversation, transcript file

**Wire format**(线格式):
每个 source 用的 JSONL schema。当前三种:Claude Code(`claude`)、Kimi Code
(`kimi`)、OpenClaw trajectory(`openclaw`)。
_Avoid_: Format, dialect, schema(含义过载)

**Source**(来源):
从 session 路径推断出的 wire-format 判别字符串(`"claude" | "kimi" |
"openclaw"`)。决定跑哪个 parser、走 streaming 还是 batch 路由。
_Avoid_: Parser name, format name, kind

**NormalizedMessage**(归一化消息):
任一 normalize 路径产出的 collapse 结果。携带 `id`、`role`、`blocks`,以及
可选的 `model` / `token_usage` / `subagent_id`。
_Avoid_: Message, record(跟 raw event 含义撞), chat message

**Streaming normalize**(流式归一化):
`normalize(record, idx) -> Option<NormalizedMessage>`。一条 raw event 进,
一条 NormalizedMessage 出,不做聚合。给 export、analyze、subagent jsonls,以
及 openclaw transcript 路径用。
_Avoid_: Single-event normalize, raw normalize, per-event normalize

**Batch normalize**(批量归一化):
`normalize_session(records) -> Vec<NormalizedMessage>`。N 条 raw event 进,
M 条消息出(M ≤ N);可以在 run 末尾 emit 合成 chart meta。给 kimi 和 Claude
transcript 路径用(v0.9.0+、v0.9.17+)。
_Avoid_: Session normalize, aggregate normalize, whole-file normalize

**Two-pass sync**(双 pass 同步) [v0.8.4 - v0.9.26]:
`db/sync.rs` 当前 2 阶段架构:

- **Pass 1** (`sync_one_file` at sync.rs:491) — quick path 50 行 head 扫,
  写 SessionMeta 大部分字段到 DB。
- **Pass 2** (enrichment loop at sync.rs:323-444) — `meta_extras::build_meta_full`
  重开文件扫 ≤5000 行,算派生指标(可用 models、think 计数、tool 分布、
  repeat run、idle gap、kimi 专属聚合)→ `enrich_session_meta` 写 28-param UPDATE。

两 pass 都用 `jsonl::for_each_line` 单文件扫,Pass 2 不复用 Pass 1 结果。
v0.9.26 (M9) 起,kimi 3 字段 (`kimi_token_usage` / `available_models` /
`thinking_count`) 也由 Pass 1 算,跟 Pass 2 比对验证 byte-identical。
M10 (v0.9.27) 才会切 Pass 1 only + 删 `meta_extras.rs`。
_Avoid_: Sync pipeline, enrichment pipeline (含义过载)

**Chart meta**(图表元数据):
仅由 batch normalize emit 的合成 NormalizedMessage,把某一类 event 聚合成
一条消息,内含 payload 形态的数据(60 个 bucket、timeline、top-list、
raw-event drill-down)。例子:`usage.chart`、`request.chart`、`todos.chart`
(kimi);`ai-title.chart`(Claude)。
_Avoid_: Aggregate meta, rollup meta, summary block

**Subagent jsonl**(子代理 jsonl):
位于 `<main>/subagents/agent-<id>.jsonl` 的子 session 文件。通过 envelope
里 `isSidechain=true` + `agentId` 识别。Streaming normalize 保留按 event
emit 的行为,让 `SubagentMetaBlock` 能渲染 mode / permission / title /
last-prompt 等字段。
_Avoid_: Child session, sidechain jsonl, nested session

**Bucketed chart**(分桶图表):
chart meta 的 payload 里装 60 个等距时间窗 bucket(`bucket_start` /
`bucket_end` 索引 + 各 event class 的计数)。给时间序列密度可视化用(前
端 SVG 渲染器里画 60 根 stacked bar)。
_Avoid_: Binned chart, histogram, time series

**Priority metadata**(优先级元数据):
`custom-title > ai-title > first_user_text` 这条优先级规则,同时被
streaming session-metadata builder 和 v0.9.17 batch chart builder 保留,
确保后续用户手动 rename 在 LLM 频繁自动 rename 之下能存活。
_Avoid_: Title precedence, rename priority

**Meta kind**(元数据种类):
一个字符串 label,标识前端里某一种按 kind 渲染的组件(`compaction`、
`tools_snapshot`、`usage.chart` 等)。每个 kind 有自己的 accent 颜色和
CSV 布局;目前共 6 种颜色(teal / indigo / amber / violet / emerald /
rose)。
_Avoid_: Meta type, block kind
