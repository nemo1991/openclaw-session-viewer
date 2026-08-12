# Snake/camel 字段名双兼容(v0.6.0+)

Rust 端 struct 字段用 snake_case,经 `#[serde(rename_all = "camelCase")]`
序列化成 camelCase 走 Tauri bridge。前端 `get()` helper 在读 meta block
顶层字段时,既查 snake_case(后端早期 emit 直接平铺)又查 camelCase(pre-
rename payload),兼容历史 wire 和老 DB 缓存。

**Status**: superseded by v0.9.25 M8 (chart block payload) — see below

## Context

最初 Rust struct 字段名是 snake_case(例如 `event_count`、
`title_changes_count`),序列化成 JSON 后前端 camelCase 跟 snake_case
两种命名都见过(v0.5.x 之前 emit 平铺,字段是 snake_case;v0.6.0 之后
Rust 加 rename_all camelCase,字段是 camelCase)。前端代码不能假设只有一
种命名,否则读老 wire 或老 DB 缓存时所有字段都拿不到。

## Decision

Rust 端统一加 `#[serde(rename_all = "camelCase")]`,新 emit 全是
camelCase;前端 `get()` helper 双查:

```
function get(...keys) {
  for (const k of keys) {
    if (blk[k] !== undefined) return blk[k];
    if (pl[k] !== undefined) return pl[k];
  }
}
```

调用处传双名,例如 `get("event_count", "eventCount")`。

## Alternatives considered

- **改前端全部用 snake_case**:跟 camelCase 主命名风格不一致,新代码读
  起来别扭,且不利于未来扩到 openclaw / kimi 等本身就用 camelCase 的
  source。否决。
- **迁移老 wire / DB 缓存一次性变 camelCase**:成本高,且运行时仍然会
  收到外部 session 文件直读(不经过 DB)的 snake_case 旧数据。
- **后端保留 snake_case 不加 rename**:跟 Tauri bridge 跨语言惯例冲
  突,前端开发者阅读 API 命名不一致。否决。

## Consequences

- 每个 `get()` 调用都要写 snake + camel 两个名,容易漏。漏了会让某个
  字段在老 wire 上读不到但代码看起来没问题(因为新 wire 上能读)。
  review 时要特别盯双名。
- 字段重命名要同时考虑三层:Rust 字段名(snake)→ serde rename
  (camel)→ 前端 `get()` 入参(两个名)。三层命名容易脱钩。
- 未来如果所有现存 wire 都迁完,可以撤掉 snake_case 兼容路径,但没有
  显式信号能确认"已迁完"(外部用户的 session 文件不在 DB 里)。

## Status (updated v0.9.25 M8)

Superseded for **chart block payloads**. 原始 ADR 假设 "Rust 端统一
加 `#[serde(rename_all="camelCase")]`,新 emit 全是 camelCase" — 这只
对 typed IPC struct (SessionMeta / StreamBatch / 等) 成立。对 chart
block payload 实际不成立:chart blocks 走 `parser/kimi.rs` 和
`parser/claude.rs` 里的手动 `data.insert("snake_key", ...)` emit(不
走 serde rename),输出始终是 snake_case。

前端 `(snake, camel)` 双查调用里的 camel 半边从来拿不到值(没有 emit
源),是 dead code。M8 (v0.9.25) 撤掉 ~53 处 camel fallback,简化为单
snake key;同时删 `lib/meta.ts::getPayloadField` + `unwrapPayload`(0
caller)。

仍然 valid for **typed IPC structs** (SessionMeta / StreamBatch /
TranscriptEntryOut / 等 37 处 `rename_all="camelCase"`) — 这部分早就
单 camelCase emit + 单 camelCase 读,无双查,无需动。

## Bug fixed

`CompactionChartMetaBlock` 用单 key `contextSummary` (camel) 查 context 系统提示,但 Rust `kimi.rs:686` emit 的是 `context_summary` (snake)。
camel 半边永远是 `undefined`,`!summary && contextSummary` UI 分支从来
没渲染过。M8 改成 snake key,顺手修 latent bug。

`ToolsSnapshotChartMetaBlock` 3-key `(snapshot_hash, snapshotHash,
hash)` 调用里的 `hash` 是 inbound Kimi wire key(`kimi.rs:762` 读
`obj.get("hash")`),Rust re-emit 时转 snake(`kimi.rs:764` insert
`snapshot_hash`),永远不会以 `"hash"` 出现在 block payload 里。`hash`
fallback 也是 dead branch。M8 简化为单 `snapshot_hash`。

## 不在 M8 范围

- **统一 chart block emit 到 camelCase** — 跟 attachment block 看齐
  (后者 emit camelCase)。scope 大:rust parser 改 emit + frontend
  bucket interface 改 + 所有 test fixture 改。留作未来 M9+。
- **`graph.rs::GraphNodeFE` / `EdgeFE` 的 `rename_all="snake_case"`**
  — deliberate,镜像 SQLite column 名,跟 SQLite schema 绑定(CHANGELOG
  `:2901` 历史 PascalCase/snake mismatch bug 是 contract)。不动。
