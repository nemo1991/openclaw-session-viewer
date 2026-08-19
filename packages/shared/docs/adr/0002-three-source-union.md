# 三 source SessionSource union(v0.9.0+)

`SessionSource = "claude" | "openclaw" | "kimi"` 字符串 union 在 Rust
跟 TS 两边定义,作为 source_from_path() 返回值、parser 派发 key、
batch/stream 路由分支的统一来源。

**Status**: accepted(v0.9.0 起,跟 kimi parser 一起引入)

## Context

v0.9.0 之前只有 Claude parser 一个 source,所有 session 文件都走同一个
parser。v0.9.0 加 Kimi parser,需要 source discriminator 区分文件走哪
条解析路径。最初有过"按文件扩展名 / 路径 pattern 各自分支"的做法,但
维护时容易漏一个 source,统一 union 更显式。

## Decision

`SessionSource` 字符串 union 是唯一 source 入口。`source_from_path()`
从 session 路径推断出 union 字符串,Tauri command `stream_transcript`
根据这个值分支到对应 parser + 走 batch 还是 streaming 路由。新加
source 时必须:

1. 在 Rust + TS 两边同时扩展 `SessionSource` union
2. 在 `source_from_path()` 里加识别分支
3. 在 `transcript.rs::stream_transcript` 里加 batch/stream 分支
4. 在 `packages/shared/src/<source>-types.ts` 里加 wire contract

## Alternatives considered

- **每个 source 单独一个 enum,source_from_path 返回更大 enum**:多一
  层抽象,但 `stream_transcript` 还是要逐个 match,徒增绕路。
- **按文件扩展名 + magic bytes 派发,不用字符串**:更难调试,Tauri
  command 边界处还是得有个判别值,最终还是字符串。
- **每个 source 一个独立 Tauri command(无 source 派发)**:每个
  command 重复 stream_transcript 的 emit 逻辑,违反 DRY。否决。

## Consequences

- 加第四个 source 一定要动四个地方(union / path 推断 / transcript
  分支 / wire types),少一个就跑不通。这是显式成本,胜过"靠记忆
  添加"。
- SessionSource 字符串 literal 在 Rust 跟 TS 两份代码里出现,容易打错
  字漏 match。靠 TypeScript exhaustiveness check + Rust match 的
  `_ => ...` 兜底兜住。
- 字符串 union 跟 enum 比起来,没有 namespace,容易跟其他字符串(如
  `meta kind`、session ID 前缀)撞名,使用时要加注释。
