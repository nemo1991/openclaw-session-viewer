# packages/frontend

React 19 + Zustand + Tauri webview 前端。会话浏览 UI、transcript 渲染、
virtualized message 列表、按 meta kind 分发的 chart 系列。

## Language

**MetaBlockRouter** (v0.9.21):
meta 块的 4 路 router。接 `label` 或 `kind` 二选一作 dispatch key,分
发到 L2 `<ChartBlock>` (6 chart) / L4 `<AttachmentBlock>` (13 attachment)
/ L3 `<EventMetaBlock>` (其他 inline meta) / `<UnknownBlockCard>`
fallback。v0.9.21 之前叫 `MetaBlock`,M3 拆出 AttachmentBlock /
EventMetaBlock 之后,M6 改名强调"它只是 router,不是 monolith"。
_Avoid_: 渲染器, renderer

**SubagentMetaBlock**:
跟主 MetaBlockRouter 并列的一个独立组件,渲染子代理 meta block(`mode:`、
`permission:`、`title`、`last-prompt` 四类)。跟主 MetaBlockRouter 的区
别是不在 `isKnownMetaLabel`/`isMetaKind` 路径里,而是由 `MessageBubble`
的 subagent 入口直接调用。
_Avoid_: 子代理元数据块, child session meta block

**UnknownBlockCard**:
未知 label/kind 的 fallback 卡片,默认折叠,把 payload 当 key-value 表
展示。所有 4 个 layer (L1/L2/L3/L4)的兜底。
_Avoid_: Generic meta card, fallback meta card

**SessionOverview** (v0.9.21, M4):
L1 层。渲染 session 头部 chrome + summary strip + (kimi) meta banner
fold。"这是什么 session?" 问题的答案。接收 `SessionMeta` props,从
`SessionDetailRoute` 抽出(M4 计划)。
_Avoid_: header panel, summary card, overview pane

**ChartsRegion** (v0.9.21, M5):
L2 层 container。在 SessionOverview 下方、TranscriptView 上方,2-3 column
grid 渲染 6 个 `<ChartBlock>`。"过程可视化?" 问题的答案。chart blocks
从 transcript timeline 抽离后放在这里。M5 落地。
_Avoid_: chart grid, chart section, chart dashboard

**ChartBlock**:
L2 层 dispatcher。接 `block.label`,switch 到 6 个 chart sub-component
(`UsageChartMetaBlock` / `RequestChartMetaBlock` /
`TodoChartMetaBlock` / `AiTitleChartMetaBlock` /
`CompactionChartMetaBlock` / `ToolsSnapshotChartMetaBlock`)。
_Avoid_: chart dispatcher, chart router

**EventMetaBlock**:
L3 层。渲染单事件 inline meta(Kimi metadata / config.update /
permission.set*mode / tools.set_active_tools /
permission.record_approval_result / OpenClaw model_change /
compaction / label / 等)。label + payload 字段表,无 payload 走
`<UnknownBlockCard>` fallback。
\_Avoid*: inline meta, meta row

**AttachmentBlock**:
L4 层。13 + 4 个 Claude attachment kind 枚举(`task_reminder` /
`plan_mode` / `pr_link` / `agent_name` / `agent_listing` /
`skill_listing` / `file_snapshot` / `file-history-snapshot` /
`invoked_skills` / `plan_file_reference` / `compact_file_reference` /
`attached_file` / `queued_command` / `queue_operation`)。统一
`.attachment-block-meta` wrapper + slate accent (`META_ACCENT.attachment`)。
_Avoid_: envelope block, meta envelope

**Meta layer taxonomy** (v0.9.18–v0.9.21):
4 层抽象分层,跟具体 user-question 对应:

- L1 SessionOverview: "这是什么 session?"
- L2 ChartsRegion + ChartBlock: "过程可视化?"
- L3 EventMetaBlock: "这条消息的元数据"
- L4 AttachmentBlock: "Claude attachment 信息"
  "meta" 现在只作为 L3/L4 的 umbrella,L1/L2 用自己的命名
  (`SessionOverview` / `ChartsRegion`)。详见 ADR 0002。
  _Avoid_: meta stack, meta layer

**Chart SVG**:
每个 chart meta 的 inline SVG 子组件(`UsageChartSvg` /
`RequestChartSvg` / `TodoChartSvg` / `AiTitleChartSvg`),统一
viewBox 600×80,60 个 stacked bar,bar 宽 = `(W - pad) / 60`。
_Avoid_: Bar chart SVG, density chart

**Stacked bar**:
同一 bar 内叠加多个 `<rect>` layer,每个 layer 一个 event class 子项
(比如 todos 的 pending/in*progress/done 三层,ai-title 的
ai-title/custom-title 两层)。共享同一个 `barW` 宽度,`y` 坐标从底往上累
减。
\_Avoid*: Multi-layer bar, layered bar chart

**Accent color**:
每个 meta kind 一种左侧 border + 浅色背景的配色,作语义信号,详情页
底部多种 meta 共存时一眼区分。三个梯度:

- 6 chart (compaction=teal / tools_snapshot=indigo /
  usage.chart=amber / request.chart=violet / todos.chart=emerald /
  ai-title.chart=rose) 各自独立 accent
- 13 attachment 统一 slate (border 0.6)
- 1 event meta 弱 slate (border 0.4)
  \_Avoid\*: Theme color, kind color, meta color

**Drill-down**:
chart meta 底部 "展开 N raw events" 按钮点开后渲染的 raw events 表,
前 N + 后 N 条(N=5),可在收起/展开间切换,跟 v0.9.14 / v0.9.15 /
v0.9.16 / v0.9.17 一脉相承。
_Avoid_: Raw events panel, detail view

**Meta label**:
meta 内 attachment 的 `type` 字符串字段(如 `"file-history-snapshot"`、
`"task_reminder"`、`"usage.chart"`)。由 `isKnownMetaLabel` 判别是否
走专属 MetaBlockRouter。
_Avoid_: Type string, attachment type

**Meta kind**:
`NormalizedBlock.kind` 顶层字段(`"meta"`、`"agent_listing"` 等)。由
`isMetaKind` 判别是否进入 MetaBlockRouter 入口。
_Avoid_: Block kind, top-level kind

注:`label` 跟 `kind` 是两个独立的字符串概念,两者通过 `BlockRenderer`
入口分发(`kind` 走主路径)跟 meta 分支入口分发(`label` 走 meta 分支
路径)区分。`chart meta` 在两个入口都能识别,这是为了兼容老 wire /
BlockRenderer 两种 emit 形态。

**META_ACCENT** (v0.9.18):
meta block accent 配色集中 token,位于
`packages/frontend/src/theme/meta-palette.ts`。8 个 key:6 chart
(compaction / toolsSnapshot / usageChart / requestChart / todoChart /
aiTitleChart)各自独立配色;attachment (13 个 Claude attachment kind
共享 slate);eventMeta (单事件 inline meta,较弱 slate)。每个 key 含
`border` / `bg` / `tagBg` / `tagFg` / `barAlpha` / `barSolid` /
`badge` / `displayName` 字段。跟 `theme/tokens.css` 的
`--meta-accent-X-*` CSS variables 一一对应,改一处全局生效。
_Avoid_: color palette, theme token

**getMetaField** (v0.9.21, M6):
meta 字段读取 utility,从 `lib/meta.ts` 导出。snake*case + camelCase
双查 + 顶层 + payload 双源 fallback。4 个 chart SVG / 6 chart
sub-component / `<AttachmentBlock>` / `<EventMetaBlock>` 共享。
\_Avoid*: snake camel compat, dual lookup

**lib/meta.ts** (v0.9.21, M6):
meta 子组件的 utility 集中,导出 `getMetaField` / `unwrapPayload` /
`getPayloadField` / `numOrZero` / `numOrNull` / `formatPreviewValue`。
`charts/chart-utils.ts` 保留作为 re-export shim,内部组件仍然从
`./chart-utils` import,行为不变。
_Avoid_: meta utils, format helpers
