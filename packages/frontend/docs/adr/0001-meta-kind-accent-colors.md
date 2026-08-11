# Meta kind accent colors (v0.9.12–v0.9.18)

每个 meta kind 各自分配一种 accent 配色(左侧 border + 浅色背景),详情页
底部多种 meta 共存时一眼区分。当前六种:compaction=teal、
tools_snapshot=indigo、usage.chart=amber、request.chart=violet、
todos.chart=emerald、ai-title.chart=rose;v0.9.18 起 13 个 attachment
kind 统一 `slate`。

**Status**: accepted(v0.9.12 起逐步引入,v0.9.17 落地第 6 色;
v0.9.18 集中化到 `theme/meta-palette.ts` + 13 attachment 统一 slate)

## Context

v0.9.10 之前的 meta block 共用一种配色(都是灰边框),详情页底部一长串
meta 时用户视觉上分不清不同 meta 来源。v0.9.12 开始给每种 meta kind 分
独立的 accent 颜色,用色彩承载"语义信号"(teal=压缩、indigo=工具配置、
amber=成本、violet=上下文、emerald=完成、rose=身份)。

## Decision

每加一种新的 chart meta,在前端的 `MessageBubble.css` 里新增一组
`<kind>-meta` class,用一种还没被占用的 accent 配色。配色从
Tailwind 调色板里选,跟 chart SVG 的 stacked bar fill 颜色保持一致,
保证图例和左侧 border 视觉对得上。

新 meta kind 加进来时,先查已有六种确认不撞色再分配。

## Alternatives considered

- **不区分,所有 meta 用同一种配色**:实现简单,但跟 v0.9.12 之前一样,
  详情页多种 meta 共存时视觉拥挤,放弃。
- **用图标而非颜色区分**:图标方案需要每个 meta 一个 SVG,资产体积膨胀,
  且色盲用户对图标的辨识同样依赖语义。颜色 + 现有 icon 双重信号更稳。
- **用 hash 把任意 label 映射到色板**:省去手动分配,但同色撞色概率高
  (六色空间里随便 hash 撞色),且语义上"压缩"该用哪个色就完全靠运气。
  手动配色保留语义控制。

## Consequences

- 调色板是稀缺资源,六色用完后新 meta kind 需要重新决策配色策略(回到
  icon-only,或者引入饱和度/明度区分)。
- 改任一 meta kind 的配色是 breaking visual change,既有 detail 页会突然
  变样;做色彩调整时要评估是否值得。
- 配色跟 SVG stacked bar 强绑定,跨 chart meta 复用组件时(目前没发生)
  会需要重新校准 fill 颜色。

## v0.9.18 update — 13 attachment kind 统一 slate + accent 集中化

13 个 Claude attachment kind(plan_mode / task_reminder / pr_link /
agent_name / agent_listing / skill_listing / file_snapshot /
file-history-snapshot / invoked_skills / plan_file_reference /
compact_file_reference / attached_file / queued_command /
queue_operation)之前共用 generic wrapper,无 accent。v0.9.18 决策:

1. **统一 slate accent**(rgba(100,116,139,0.6) border + 0.04 alpha bg)
   作为一个"attachment 类别"跟 6 chart 区分。slate 是 Tailwind
   slate-500,中性色不会跟 6 chart 撞色。
2. **集中化** accent token 到 `packages/frontend/src/theme/meta-palette.ts`:
   - `META_ACCENT.compaction` / `toolsSnapshot` / `usageChart` /
     `requestChart` / `todoChart` / `aiTitleChart` — 6 chart kind 各自
   - `META_ACCENT.attachment` — 13 attachment kind 共享 slate
   - `META_ACCENT.eventMeta` — 预留,单事件 inline meta 用更弱 slate
     (border 0.4 vs 0.6),三层视觉梯度:chart > attachment > eventMeta
3. **CSS variables** 加到 `theme/tokens.css`:`--meta-accent-X-border`
   / `--meta-accent-X-bg`。React 组件可以同时用 TS token (内联
   style) 跟 CSS variable (CSS class)。
4. **ATTACHMENT_META_LABELS** Set 在 `meta-palette.ts` 里集中 13 个
   attachment label 字符串,未来 dispatcher (M3) 用它路由到
   `<AttachmentBlock>`。

### 备选(被否)

- **每个 attachment kind 一色**:13 种配色 + 6 chart = 19 色 palette,
  撞色概率高,饱和度挑战大。
- **按 4 类分配 4 色**(状态/输入/输出/控制):palette 仍近 10 色,
  维护负担接近"每个 kind 一色"。
- **保持无配色**:视觉混乱问题没解决,放弃。

### 后果

- 13 attachment kind 之间视觉无区分(用户靠 label text 找具体 kind),
  但整体作为一个"metadata 类别"跟 6 chart 区分是清晰的。
- palette 仍是 6 chart + 1 slate,饱和度可控。
- 改 accent 一处生效(TS token 跟 CSS variable 双向 sync),未来深色
  主题适配只需加 `[data-theme="dark"]` 块覆盖 CSS variables。
