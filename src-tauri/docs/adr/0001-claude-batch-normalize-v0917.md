# Claude transcript 路径走 batch normalize(v0.9.17)

Claude transcript 路径改走 batch `normalize_session()`,把 `ai-title` 和
`custom-title` event 聚合成一个 `ai-title.chart` meta,跟 kimi 同模式。
Streaming `normalize()` 保持原样,继续给 export、analyze、subagent jsonls
路径调用。

**Status**: accepted(v0.9.17)

## Context(背景)

<redacted-session-id> 这个 Claude session 每个 turn 会 emit 1185 条 `ai-title` 事件
(还有少量 `custom-title`)。在 streaming `normalize()` 的 arm 下,每条都是
一条原始 meta block,详情页直接被 1185 个 title block 撑爆。kimi 在 v0.9.0
就解过同类问题——把 transcript 路径走 `normalize_session()`,这样可以 emit
合成 chart meta,并对噪声大的 event class 跳过 inline emit。

## Decision(决策)

在 `claude.rs` 加 `pub fn normalize_session(records) -> Vec<NormalizedMessage>`,
并把 `transcript.rs::stream_transcript` 的 Claude 分支路由过去。Streaming
`normalize()` 保留 `ai-title` / `custom-title` 两个 arm;**只有 batch 路径
才会聚合**。两路径行为故意不同:

- **transcript UI**(batch)— 把 title event 聚合成一个 chart meta
- **export / analyze / subagent jsonls**(streaming)— 保留按 event emit,
  这样 `SubagentMetaBlock` 还能渲染每个 event 的 title / mode / permission /
  last-prompt 字段

## Alternatives considered(考虑过的备选)

- **从 streaming `normalize()` 里删掉 ai-title / custom-title arm**:更简单,
  但 export 和 subagent jsonls(都走 streaming)那边 `SubagentMetaBlock` 渲染
  就废了。最终选了双路径分叉。
- **聚合放到前端**:每个 session 还是要推 1185 个 block 跨 Tauri bridge,
  失去聚合意义。已否决。

## Consequences(后果)

- 新 builder(`build_ai_title_chart_meta`)让 title-precedence 逻辑存在两处:
  `commands/sessions.rs::build_claude_session_meta`(session 级 metadata),
  以及 chart builder(transcript 级聚合)。两处必须保持同步;任何 precedence
  改动都要同时动两边。
- Claude transcript 路径现在要求 emit 前把整 session 读进内存(跟 kimi 一
  致);多 GB 的 Claude session 会付这个代价。v0.9.17 范围内可接受;streaming-
  window 变体留作 v0.9.18+ 未来选项。
- `transcript.rs` 增加了 per-source 分支(`kimi` batch、`claude` batch、
  `openclaw` streaming);以后要加第四个 source,就得再加一个分支。
