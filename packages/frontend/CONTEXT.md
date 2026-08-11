# packages/frontend

React 19 + Zustand + Tauri webview 前端。会话浏览 UI、transcript 渲染、
virtualized message 列表、按 meta kind 分发的 chart 系列。

## Language

**MetaBlock**:
meta 块的统一渲染组件。接 `label` 或 `kind` 二选一作 dispatch key,根
据字符串分发给对应的 meta kind 渲染器;未知 label/kind 走
`UnknownBlockCard` fallback。
_Avoid_: 渲染器, renderer

**SubagentMetaBlock**:
跟主 MetaBlock 并列的一个独立组件,渲染子代理 meta block(`mode:`、
`permission:`、`title`、`last-prompt` 四类)。跟主 MetaBlock 的区别是
不在 `isKnownMetaLabel`/`isMetaKind` 路径里,而是由 `MessageBubble` 的
subagent 入口直接调用。
_Avoid_: 子代理元数据块, child session meta block

**UnknownBlockCard**:
未知 label/kind 的 fallback 卡片,默认折叠,把 payload 当 key-value 表
展示。
_Avoid_: Generic meta card, fallback meta card

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
底部多种 meta 共存时一眼区分。目前六种:compaction=teal、
tools*snapshot=indigo、usage.chart=amber、request.chart=violet、
todos.chart=emerald、ai-title.chart=rose。
\_Avoid*: Theme color, kind color, meta color

**Drill-down**:
chart meta 底部 "展开 N raw events" 按钮点开后渲染的 raw events 表,
前 N + 后 N 条(N=5),可在收起/展开间切换,跟 v0.9.14 / v0.9.15 /
v0.9.16 / v0.9.17 一脉相承。
_Avoid_: Raw events panel, detail view

**Meta label**:
meta 内 attachment 的 `type` 字符串字段(如 `"file-history-snapshot"`、
`"task_reminder"`、`"usage.chart"`)。由 `isKnownMetaLabel` 判别是否
走专属 MetaBlock。
_Avoid_: Type string, attachment type

**Meta kind**:
`NormalizedBlock.kind` 顶层字段(`"meta"`、`"agent_listing"` 等)。由
`isMetaKind` 判别是否进入 MetaBlock 入口。
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
