# packages/shared

跨 package 的 TypeScript 类型 + Zod schema + 转换函数。被前端
(`@ocsv/frontend`) 直接 import,Rust 端通过 `ts-rs` 把同一些类型导出成
Rust struct(或手写对齐)。定义 wire 层跟 normalized 层两边的契约。

## Language

**Wire contract**:
Rust 跟 TS 两边共享的类型契约总称。TS 端手写在
`packages/shared/src/<source>-types.ts` 里,Rust 端用 `serde` + `ts-rs`
(或手工)对应。改 wire contract 等于同时动两边。
_Avoid_: Shared schema, cross-boundary type

**SessionSource**:
`"claude" | "openclaw" | "kimi"` 三个 source 的字符串 union。在 Rust
跟 TS 两边同步,`source_from_path()` 返回这个值,Tauri command 拿它
派发到正确的 parser + 走 stream/batch 路由。
_Avoid_: Wire source, format tag

**Wire record**:
原始 JSONL 一行,顶层 wire envelope + discriminated union 子类型。每
个 source 一份:`ClaudeRecord` / `OpenClawEntry` / `KimiRecord`。
_Avoid_: Raw record, source record

**Wire envelope**:
每条 wire record 顶层的公共字段集合(uuid / type / timestamp /
sessionId 等)。不同 source 的 envelope 字段名/集不同(Claude 用
`uuid` + `type`,Kimi 用 `eventType`,OpenClaw 用 `seq` + `sourceSeq`),
但都叫 envelope。
_Avoid_: Record header, common header

**Source-specific union**:
每个 source 一份顶层 discriminated union(ClaudeRecord /
OpenClawEntry / KimiRecord),按 source-specific 字段(如
ClaudeRecordType / KimiEventType)discriminate,跟 SessionSource 一一
对应。
_Avoid_: Wire type union, source DU

**Attachment record**:
Claude 端 `type` 字段是 meta kind label、内层 `attachment` 对象是
payload 的特殊 wire record(`plan_mode` / `task_reminder` /
`file-history-snapshot` 等)。前端拿到后映射到 `NormalizedBlock.kind =
"meta"`,label 取 `record.attachment.type`。
_Avoid_: Meta record(易跟 NormalizedBlock.kind="meta" 撞), envelope
record

**NormalizedBlock**:
collapse 后传给前端的内容块,discriminated by `kind`。常见 kind:
`text` / `thinking` / `tool_use` / `tool_result` / `image` / `meta`。
`kind: "meta"` 时还带 `label: string` + `payload?: unknown`。
_Avoid_: Block, content block(含义撞)
