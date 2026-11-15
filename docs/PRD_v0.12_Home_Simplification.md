# PRD v0.12：首页减负与操作简化（筛选收敛 + 卡片分层 + 风险前置）— B1 / C1 / C2

> 版本：v1.0（正式 PRD）｜ 日期：2026-11-15 ｜ 作者：产品经理（司南）
> 关联：`docs/ROADMAP_v0.12_UI_Simplification.md`（本版规划，决策来源） · `docs/PRD_v0.12_Navigation.md`（同版 A1/A2，先行） · `docs/PRD_v0.11_Session_Health_Check.md`（C2 能力来源）
> 状态：**已实现并封版 `v0.12.0`（2026-11-15）** — A1（方案 α）与 B1 / C1 / C2 及 FR-F4 / FR-C3 两个 Could 全部落地；实施记录见 §15.5

---

## 一、文档信息

| 项       | 内容                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标版本 | v0.12                                                                                                                                                                                                    |
| 决策状态 | A1 导航（α 侧边栏）已拍板；本 PRD 覆盖 ROADMAP 的 B1 / C1 / C2                                                                                                                                           |
| 战略约束 | D-1 洞察深化 · D-2 纯开源社区（本地优先、零上传、不引账号） · D-3 国际化暂缓（仅 zh-CN/en-US）                                                                                                           |
| 影响面   | `sessionsStore.ts`（新增 `resetFilter` + `source:"all"`）、`SessionsRoute.tsx`（筛选区重构 + `SessionCard` 分层 + 风险徽标）、`SessionsRoute.css`、新增 `useGraphStore` 消费、`i18n/zh-CN.ts`·`en-US.ts` |
| 不开事项 | 移动端/响应式、拖拽排序、自定义仪表盘、ja-JP（D-3）、云同步/账号（D-2）；D 组 D1/D2/D3 属 Could，不在本文件展开（见 §四/§十四）                                                                          |

---

## 二、背景与目标

### 2.1 背景（基于代码事实）

A1（α 侧边栏）落地后，首页 `SessionsRoute` 顶部散落的 `graph / tools / settings` 图标被移除（`SessionsRoute.tsx:229-255`），首页主体由「侧栏筛选区 + 会话卡片列表」构成。但两个**真实的认知与操作摩擦**仍在：

- **筛选区过载且默认视角偏窄**。`sessionsStore.ts:10-19` 的 `SessionsFilter` 把 `source` 限为 `"claude"|"openclaw"|"kimi"|"dsh"` 四选一单选，且**默认值是 `"openclaw"`（`:43`）**。首页 `.filter-section`（`SessionsRoute.tsx:262-382`）平铺：**3 个 checkbox**（liveOnly / hasSubagents / last7Days）+ **4 个 source radio（无「全部」）** + 条件渲染的 **agent×N radio** + **2 个 checkbox**（showHidden / showArchived）+ 搜索框，**无折叠、无「重置筛选」**。
  - 直接后果：开箱首屏**只能看到 openclaw 会话**；要看 claude/kimi/dsh 必须手动切 radio，且**永远无法在同屏看全部 source**——对一个「多源浏览器」是反直觉的硬伤。
- **卡片信息过载，风险信号被淹没**。`SessionCard`（`SessionsRoute.tsx:468-744`）默认渲染：5 类 badge（live / subagent / source / pin / hide）+ meta 行 + firstPrompt 预览 + **最多 9 个 stat-chip**（thinking / tools / duration / error / repeat / idle / todo / tokens / compaction，`:586-714`）+ topTools + **4 个常驻操作图标**（pin / hide / archive / rename，`:716-741`）。
  - v0.11 已交付的**会话体检标记（FR-H1）没有任何列表表面**——用户必须进 `/graph?view=health` 才知道哪条会话有问题，洞察闭环在列表层断裂。
  - 重命名依赖**双击标题**（`:521`），可发现性差。

### 2.2 要解决的问题

1. 让首屏默认呈现**全部 source** 且常用筛选（source + 搜索）一眼可达，低频筛选折叠收敛。
2. 提供「重置筛选」一键回到默认，消除「不知道改了什么、怎么还原」的困惑。
3. 卡片默认只露高信号信息（标题 + meta + 风险），9 个 stat-chip 折叠，降低视觉噪音。
4. 把 v0.11 体检的「风险」**前置到首页卡片**，让异常会话在列表层即可识别、可一键直达体检。

### 2.3 成功指标与口径

| 指标                             | 定义                                         | 目标值（估算）            | 口径来源                              |
| -------------------------------- | -------------------------------------------- | ------------------------- | ------------------------------------- |
| 首页首屏常驻筛选控件数           | 不滚动即见、默认展开的筛选控件               | 14 → **≤6**               | B1 折叠后：source 组(含全部) + 搜索   |
| 卡片默认可见 stat-chip 数        | 未展开时卡片上常驻的 stat-chip               | ≤9 → **≤3**               | C1 分层（错误/重复/时长优先，余折叠） |
| 风险会话在首页可识别比例         | 命中体检规则的会话中，首页卡片显示徽标的比例 | 0% → **100%**（同源数据） | C2 复用 v0.11 引擎                    |
| 体检到达步数（从列表看单条风险） | 首页卡片徽标 → 看到该会话体检详情            | 3 → **1**（徽标直达）     | C2 徽标 `→ /graph?view=health`        |
| 筛选重置所需操作                 | 从「已改筛选」回到默认                       | 手动逐项关 → **1 步**     | B1 重置按钮                           |

> 目标值为基于当前代码控件数的估算，落地后以 v0.11 A1 本地事件日志的导航/筛选点击数据为校正基准；不使用未核实外部数据。

---

## 三、名词与术语定义

| 术语        | 定义                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| 全部 source | 新增的 `SessionsFilter.source = "all"` 取值；`filteredSessions` 不按 source 过滤          |
| 高级筛选    | 默认折叠的低频筛选区：agent 组 / showHidden / showArchived /（及相对低频的 last7Days 等） |
| 常驻筛选    | 默认展开、首屏可见的筛选：source 切换（含「全部」）+ 搜索框                               |
| 风险徽标    | 命中 v0.11 体检任一规则的会话卡片上叠加的「风险(N)」徽标，点击直达体检                    |
| 数据桥      | 首页为渲染风险徽标而消费 `useGraphStore` 折叠节点 + v0.11 `evaluateHealth` 的本地计算链路 |

---

## 四、需求范围

### 包含（In Scope）

- **B 组（筛选收敛）**：FR-F1 新增「全部 source」且默认选中；FR-F2 高级筛选折叠（首屏常驻 ≤6 控件）；FR-F3「重置筛选」按钮（store `resetFilter` + 本地 showHidden/archived 重置）。
- **C 组（卡片减负 + 风险前置）**：FR-C1 卡片信息分层（默认 ≤3 chip + 展开切换）；FR-C2 体检风险徽标前置到首页卡片（含数据桥与直达）。
- 中英（zh-CN/en-US）i18n 文案同步。

### 不包含（Out of Scope，本期不做）

- 移动端/响应式侧栏；拖拽排序；自定义仪表盘。
- ja-JP 等新增语言（D-3）；云同步/账号入口（D-2）。
- **D 组其余 Could 项不在本文件展开**：D1 悬浮/右键操作菜单（替代 4 常驻图标）、D2 体检阈值内联、D3 快捷键可视化提示。其中 **D4（重命名显式化）** 以 **FR-C3（Could）** 轻量纳入本 PRD（仅把双击改为「显式菜单项 + 保留双击」），其余 D1/D2/D3 留待 v0.12.x 或 v0.13 评审（见 §十四）。
- 本 PRD 不做「强制看全部」之外的默认行为重写；不引入第二套体检口径（C2 强制复用 v0.11 引擎）。

---

## 五、方案对比与选型说明

### 5.1 FR-F1：默认 source 取值（修复「只能看 openclaw」）

| 方案                                             | 描述                                                                                                                        | 优点                                                             | 缺点                                                   | 结论                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | ----------------------- |
| **A：新增「全部」radio 并默认选中**              | `SessionsFilter.source` 扩为含 `"all"`；`filteredSessions` 在 `source==="all"` 时跳过 source 过滤；radio 组首项「全部」默认 | 还用户「多源同屏」的本来预期，零学习成本；不改单 source 切换能力 | 首屏列表变长（4 source 混合）；openclaw 单源用户需习惯 | **采用**                |
| B：保留默认 openclaw，仅新增「全部」选项但不默认 | 同 A 但默认仍是 openclaw                                                                                                    | 对 openclaw 重度用户更温和                                       | 「看全部」仍需手动点，未根治首屏偏窄                   | 落选（作为 RK-B1 兜底） |
| C：默认 openclaw 且不加「全部」                  | 不动                                                                                                                        | 改动最小                                                         | 未解决硬伤                                             | 不采用                  |

**拍板理由**：产品定位是「多源浏览器」，开箱只给单一 source 是反定位的；A 的列表变长问题由既有 agent/workspace 分组（`:132-177`）吸收，且可被「重置/折叠」对冲，收益远大于成本。

### 5.2 FR-C2：风险徽标的数据桥选型

| 方案                                                                          | 描述                                                                                                                                                                                                    | 优点                                                                                          | 缺点                                                                                                                            | 结论     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **A：复用 `useGraphStore` 折叠节点 + v0.11 `evaluateHealth`**                 | 首页读 `useGraphStore(s=>s.entries)`；为空则触 `load()`；`evaluateHealth(foldGraphEntries(entries).nodes, healthRules)` 一次（memoized）→ `Map<session_id, FlaggedSession>` 经 props 传入 `SessionCard` | **零第二套口径**（RK-V1 已规避）；token/model 字段齐备；O(n) 单次遍历复用折叠（RK-V5 同口径） | 首页首次触发 graph 加载有成本；需处理 entries 空/加载中                                                                         | **采用** |
| B：从 `SessionMeta` 现有字段（errorCount/subagentCount/primaryModel）本地重算 | 不依赖 graphStore，直接吃卡片已有字段                                                                                                                                                                   | 无额外加载                                                                                    | token_outlier / modelDrift 缺 `token_total`/`available_models` 字段，无法复用 v0.11 完整四规则 → **产生第二套口径**，违背 RK-V1 | 不采用   |
| C：Rust/IPC 新增「首页体检摘要」接口                                          | 后端算好 flags 随 `list_sessions` 返回                                                                                                                                                                  | 首页零额外前端加载                                                                            | 阈值变更需后端重算、老库迁移、双份口径风险（同 v0.11 §八方案 B，已否）                                                          | 不采用   |

**映射规则（验收边界）**：`foldGraphEntries` 把 subagent 归并到 parent 节点，`node.session_id` 是 **parent** 的 id。因此徽标按 `node.session_id` **精确匹配**卡片 `sessionId`：① parent 卡片命中即标；② 子会话卡片（带 `subagentDir`）**不单独标**（其问题已折叠进 parent，避免重复计数），除非它本身是另一 parent 的 root。

---

## 六、用户角色与使用场景

| 角色       | 场景                                          | 本 PRD 收益                                 |
| ---------- | --------------------------------------------- | ------------------------------------------- |
| 多源用户   | 打开应用想一眼看所有 source 的最近会话        | 默认「全部」同屏，无需逐个切 radio（FR-F1） |
| 新用户     | 不小心勾了筛选，列表变空/变少，不知道怎么还原 | 点「重置筛选」一步回默认（FR-F3）           |
| 个人开发者 | 想快速从列表找出「哪几条会话有问题」          | 卡片「风险」徽标直达体检（FR-C2）           |
| 重度用户   | 卡片上一堆 chip 看着吵，只想看高信号          | 默认 ≤3 chip，展开才看全部（FR-C1）         |

---

## 七、功能需求

> 本 PRD 覆盖 ROADMAP 的 **B1 / C1 / C2**（D4 以 FR-C3 Could 轻量纳入）。验收为 GWT 摘要，开发前如需更细可补子用例。

### Epic B：首页筛选收敛

| 编号           | 功能                                                                                                                                                                                                                                       | 验收要点（Given/When/Then 摘要）                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-F1          | `SessionsFilter.source` 扩为含 `"all"`；`filteredSessions` 在 `source==="all"` 时跳过 source 过滤；source radio 首项「全部」默认选中；`sessionsStore` 默认 `source:"all"`                                                                  | Given 初次进入首页（未改筛选），When 看列表，Then 同时出现 claude/openclaw/kimi/dsh 会话（按分组）；Given 选某单 source，Then 仅该 source；Given 选「全部」，Then 恢复同屏 |
| FR-F2          | `.filter-section` 拆为「常驻区」（source 组含全部 + 搜索框，默认展开）与「高级筛选」折叠区（agent / showHidden / showArchived / last7Days / hasSubagents / liveOnly，默认折叠）；`SessionsRoute` 顶部 nav 图标已由 A1 移除，本项只动 aside | Given 首页默认态，When 看侧栏，Then 仅见 ≤6 常驻控件（5 source radio + 搜索）；Given 点「高级筛选」展开，Then 可见其余控件；Given 折叠后，Then 无高频信息丢失              |
| FR-F3          | 新增「重置筛选」按钮；`sessionsStore` 加 `resetFilter`（清 `filter` 回默认含 `source:"all"`）；组件内同步重置 `showHidden`/`showArchived` 本地 state                                                                                       | Given 已勾选若干筛选，When 点重置，Then `filter` 回默认（source=全部、各 checkbox 关、query 空）且 `showHidden`/`showArchived` 关、列表恢复默认                            |
| FR-F4（Could） | 折叠/展开态本地持久化（localStorage），重启保留                                                                                                                                                                                            | Given 展开高级筛选并重启，When 再看侧栏，Then 仍为展开态                                                                                                                   |

### Epic C：卡片信息分层 + 风险前置

| 编号           | 功能                                                                                                                                                                                                                                                                                                                          | 验收要点（Given/When/Then 摘要）                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-C1          | `SessionCard` 默认仅渲染标题 + meta + 风险徽标（FR-C2）；stat-chip 区（thinking/tools/duration/error/repeat/idle/todo/tokens/compaction + topTools）默认折叠，提供「展开/收起」切换；默认可见 chip ≤3（优先级 error > repeat > duration，其余折叠）                                                                           | Given 未展开卡片，When 看首屏，Then 可见 chip ≤3；Given 点展开，Then 显示全部 stat；Given 设「默认展开全部」（若实现设置项），Then 回到旧行为                                           |
| FR-C2          | 首页消费 `useGraphStore.entries`（空则触 `load()`），`evaluateHealth(foldGraphEntries(entries).nodes, healthRules)` 一次（memoized）→ `Map<session_id, FlaggedSession>`；命中规则卡片叠加「风险(N)」徽标（N=flags 数，hover 显示首要标签与实际值/阈值）；徽标 `stopPropagation` 且 `onClick → navigate('/graph?view=health')` | Given 某会话命中 error≥阈值，When 看首页卡片，Then 显示「风险」徽标；Given 点徽标，Then 到 `/graph?view=health`；Given 未命中，Then 无徽标；Given entries 加载中，Then 不报错、徽标暂缺 |
| FR-C3（Could） | 卡片操作区把「重命名」从纯双击改为**显式菜单项/按钮 + 保留双击**；弱化 discoverability 差                                                                                                                                                                                                                                     | Given 未双击，When 看操作入口，Then 有显式重命名项；Given 仍双击，Then 仍可触发                                                                                                         |

> **与 A1 的衔接**：FR-N1 已移除 `SessionsRoute` 顶部 `graph/tools/settings` 图标，B 组的「常驻区」落在 `.sessions-sidebar` aside 内（非 topbar），B 组顺 A1 之后合入即可，无布局冲突。

---

## 八、非功能需求

- **性能**：FR-C2 的 `evaluateHealth` 为 O(n) 单次遍历，复用 `foldGraphEntries` 结果，与 v0.11 HealthView 同口径（RK-V5）；计算 `useMemo` 缓存，仅在 `entries`/`healthRules` 变化时重算。graph 加载**懒触发**（仅当 `entries` 为空时 `load()` 一次），不阻塞首屏渲染。
- **可访问性**：折叠区用 `<button aria-expanded>` 或原生 `<details>`；重置按钮有可访问名；风险徽标 `aria-label` 含命中数；操作入口为 `<button>` 语义。
- **视觉一致性**：沿用 `SessionsRoute.css` 现有 token 与 `global.css`；徽标配色与 v0.11 HealthView 的风险语义对齐（不与现有 `live/subagent/source` badge 混淆）。
- **响应式**：本期不做移动端（Won't）；桌面固定布局。

---

## 九、业务流程与状态流转

```
[首页加载]
  ├─ sessionsStore.load() → 会话列表（source 默认 "all"）
  ├─ graphStore: 若 entries 空 → load()（懒触发，仅一次）
  │     └─ foldGraphEntries(entries).nodes → evaluateHealth(nodes, healthRules)
  │           └─ Map<session_id, FlaggedSession>（memoized）
  └─ 渲染:
       ├─ 侧栏: [常驻] 全部/claude/openclaw/kimi/dsh + 搜索  ｜  [折叠] 高级筛选
       ├─ 卡片(默认): 标题 + meta + 风险徽标(若有)  ｜ stat-chip 折叠(展开可见全部)
       └─ 点风险徽标 → /graph?view=health（复用 v0.11 体检页）
```

状态要点：筛选状态由 `sessionsStore.filter` + 本地 `showHidden`/`showArchived` 构成，`resetFilter` 一次性归位；风险徽标只读派生，不产生第二份持久化口径。

---

## 十、数据与埋点需求

- **不引入任何网络上报**（D-2）。
- **C2 数据全部本地**：`useGraphStore.entries` 来自既有本地聚合；`evaluateHealth` 为本地纯函数；`healthRules` 来自本机 `settings.json`。
- **可选本地事件（Could，非必须）**：复用 v0.11 A1 本地 `event_log`，可记录 `risk_badge_click`（字段：`source`="home"），**仅写本地 SQLite、零上传**，用于校正 §2.3「风险会话可识别比例 / 徽标点击转化」。
- 本期**不强制**新增埋点。

---

## 十一、权限与安全要求

- 无新增权限、无新增账号/云依赖（D-2）。
- 沿用本地优先、零上传；风险徽标不读取任何额外用户文件，仅消费既有本地聚合数据。
- 与 §十一致：禁止任何网络请求。

---

## 十二、异常处理清单

| 异常场景                                         | 处理                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `graphStore.entries` 为空且 `load()` 失败/进行中 | 风险徽标暂缺，列表正常渲染，不报错；加载完成后再补算（loader 态可接受）    |
| 子会话卡片（subagentDir 存在）                   | 按 §5.2 映射规则不单独标徽标（问题已折叠进 parent），避免重复计数          |
| 体检规则被用户在设置页全关                       | `evaluateHealth` 返回零命中，首页无徽标（与 v0.11 行为一致）               |
| 改默认 `source` 后既有书签/分享链接带 `?source=` | 单选逻辑不变；「全部」仅影响默认值，不破坏旧单 source 深链                 |
| 重置后 `showHidden`/`showArchived` 未同步        | `resetFilter` 必须同时重置本地 state（FR-F3 显式涵盖），否则隐藏项仍不显示 |

---

## 十三、上线计划、依赖与上线后验证

### 13.1 依赖

| 依赖项                                                  | 状态               | 说明                                                               |
| ------------------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| A1（α 侧边栏）                                          | 已拍板、先行合入   | B 组「常驻区」落在 aside，需在 A1 布局稳定后合入，避免 topbar 冲突 |
| `useGraphStore` / `foldGraphEntries` / `evaluateHealth` | 已就绪（v0.11）    | C2 直接复用，不新增计算口径                                        |
| `useSettingsStore.healthRules`                          | 已就绪（v0.11 B3） | C2 读取本机阈值，改阈值后首页徽标随 `useMemo` 重算                 |
| i18n（zh-CN/en-US）                                     | 已就绪             | 新增 filter.advanced / filter.reset / riskBadge 等 key             |
| 外部阻塞                                                | 无                 | —                                                                  |

### 13.2 分阶段实施

- **阶段 1（B 组）**：FR-F1（`source:"all"` + 默认 + `filteredSessions` 分支）→ FR-F2（高级筛选折叠）→ FR-F3（`resetFilter` + 本地 state 重置）→ 补 `sessionsStore` 默认与 source 分支测试。
- **阶段 2（C 组）**：FR-C2（数据桥 + 徽标 + 跳转）→ FR-C1（卡片分层 + 展开切换）→ FR-C3（显式重命名，若排期）。
- **阶段 3**：全量回归（Rust lib / shared / frontend / typecheck / 四门禁 / E2E）→ v0.12.0 封版。

### 13.3 上线后验证清单

- 首屏默认同屏 4 source（FR-F1）；首屏常驻筛选控件 ≤6（FR-F2）。
- 「重置筛选」一步回默认（FR-F3）；`sessionsStore` 默认 `source:"all"` 单测通过。
- 卡片默认 chip ≤3、展开可见全部（FR-C1）。
- 命中体检规则的会话首页显示「风险」徽标、点击直达 `/graph?view=health`（FR-C2）；`e2e/health.spec.ts` 仍全绿（深链兼容）。
- `pnpm typecheck` 0、`pnpm build` 通过、四门禁（含 `assert-local-events.mjs` 零上传断言）通过。

---

## 十四、风险与遗留问题

| 编号  | 风险                                                | 类别 | 概率 | 影响 | 等级 | 应对                                                                                                    |
| ----- | --------------------------------------------------- | ---- | ---- | ---- | ---- | ------------------------------------------------------------------------------------------------------- |
| RK-B1 | 默认改「全部」使首屏列表变长，openclaw 重度用户不适 | 体验 | 3    | 2    | 6 低 | 保留 agent/workspace 分组吸收；提供「重置」；若反馈强烈回退为方案 B（默认 openclaw + 仅加「全部」选项） |
| RK-B2 | 折叠被误以为功能丢失                                | 体验 | 3    | 2    | 6 低 | 折叠区加「高级筛选」明确标签 + FR-F4 展开态记忆                                                         |
| RK-C1 | 卡片分层后重度用户嫌多一步展开                      | 体验 | 2    | 2    | 4 低 | 设置项允许「默认展开全部 stat」（若实现）；或按 source 记忆                                             |
| RK-C2 | 首页触发 graphStore.load 拖慢首屏 / 大库 O(n)       | 技术 | 2    | 3    | 6 低 | 懒触发（仅 entries 空时一次）+ memoized + 复用折叠；加载中徽标暂缺不报错；可与「首屏不强制加载」降级    |
| RK-C3 | graphStore 与列表 session_id 口径错位（subagent）   | 技术 | 2    | 2    | 4 低 | §5.2 映射规则：徽标按 parent session_id 精确匹配，子会话不重复标；单测覆盖 parent/child 两种卡          |
| RK-B3 | 改默认 source 破坏既有 `sessionsStore` 测试/行为    | 技术 | 2    | 2    | 4 低 | 阶段 1 必回归 `sessionsStore.test.ts` 默认与 `filteredSessions` source 分支，并补 `"all"` 分支用例      |

**遗留（明确不在本文件，待评审/后续）**：

1. **D 组其余 Could 项**：D1 悬浮/右键操作菜单（替代 4 常驻图标）、D2 体检阈值内联到体检面板（消除配置/查看跨页）、D3 快捷键可视化提示。三者为体验打磨，可视 v0.12 排期或顺延 v0.13；FR-C3 已轻量纳入 D4。
2. **C2 徽标与「单条会话体检详情」的衔接**：本期徽标直达全局体检页（按 score 排序可见该会话），未在 `/session/:id` 详情内嵌体检面板；若需「点徽标看该会话专属体检」，属 v0.12.x 增强。
3. **v0.11 保留边界仍有效**：FR-T1 部分实现、重试率评测集为标注集准确率、P95 无真实值、「标记有用率」仍不可测（缺反馈入口）——本 PRD 不解决，沿用 ROADMAP/QA 报告结论。

---

## 十五、附录

### 15.1 原型思路（首页筛选区 + 卡片）

```
┌─ 侧栏（A1 常驻） ┌─ 常驻筛选（默认展开） ─────────────┐
│ 会话              │ (●)全部 ( )claude ( )openclaw       │
│ 图探索            │ ( )kimi   ( )dsh                    │
│ 分析              │ [ 搜索会话…            ]             │
│ 体检 ★            ├─ 高级筛选 ▸（默认折叠） ───────────┤
│ 知识问答          │   最近7天 / 含子会话 / 仅进行中      │
│ 工具              │   agent: main / agent: x…           │
│ 设置              │   显示隐藏 / 显示归档               │
│                   │ [ 重置筛选 ]                        │
└────────────────── └────────────────────────────────────┘

会话卡片（默认）:
┌───────────────────────────────────────────┐
│ 修复登录 bug            ●live  ⎇3  [Claude] │
│ 2026-11-15 · 2.3MB · 142 条 · sonnet      │
│ 🔴 风险(2)   ← 命中 highErrors + modelDrift │
│ 🧠 12  ⚠ 25  ⏱ 1h（默认≤3，点展开看全部） │
└───────────────────────────────────────────┘
```

说明：筛选区首屏仅 6 个常驻控件；卡片默认 ≤3 chip + 风险徽标；点「风险」徽标直达 `/graph?view=health`。

### 15.2 用户故事汇总

- 作为多源用户，我希望开箱就能同屏看到所有 source 的会话，以便快速总览（FR-F1）。
- 作为新用户，我希望一键重置筛选，以便从「改乱了」恢复到默认（FR-F3）。
- 作为个人开发者，我希望在列表里直接看到哪条会话有风险，以便少走一步进体检（FR-C2）。
- 作为重度用户，我希望卡片默认干净、需要时再展开细节，以便降低视觉噪音（FR-C1）。

### 15.3 需求追踪矩阵（RTM）

| 编号  | 规划章节    | 关联代码 / 文档（实装）                                                                                                              | 验证物（实装）                                                              | 状态       |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------- |
| FR-F1 | 五/七       | `state/sessionsStore.ts`（`SourceFilter` / `DEFAULT_SESSIONS_FILTER` / `filteredSessions`）、`SessionsRoute.tsx`（`SOURCE_OPTIONS`） | `sessionsStore.test.ts` 四源同屏 + `"all"` 分支；E2E 默认 `source-all` 选中 | **已实现** |
| FR-F2 | 五/七       | `SessionsRoute.tsx`（常驻区 + `advanced-filter-toggle`）、`SessionsRoute.css`                                                        | E2E 断言 5 radio + 搜索框 = 6 控件、高级区默认折叠、展开可见                | **已实现** |
| FR-F3 | 五/七       | `state/sessionsStore.ts`（`resetFilter`）、`SessionsRoute.tsx`（`handleResetFilter`）                                                | `sessionsStore.test.ts` 全字段归位 + 新对象；E2E 一步回默认                 | **已实现** |
| FR-F4 | 七（Could） | `SessionsRoute.tsx`（`ADVANCED_FILTERS_KEY` + localStorage）                                                                         | E2E reload 后展开态保留、`aria-expanded="true"`                             | **已实现** |
| FR-C1 | 五/七       | `routes/sessionCardChips.ts`（`selectStatChips`）、`SessionsRoute.tsx`（`SessionCard`）                                              | `sessionCardChips.test.ts` 7 例；E2E 默认 3 chip / 展开 9 chip              | **已实现** |
| FR-C2 | 五/七       | `views/graph/healthBridge.ts`、`SessionsRoute.tsx`（数据桥 + 徽标）、`SessionsRoute.css`                                             | `healthBridge.test.ts` 9 例；E2E 徽标显示 + 直达 `/graph?view=health`       | **已实现** |
| FR-C3 | 七（Could） | `SessionsRoute.tsx`（`card-rename` 显式按钮）                                                                                        | E2E 显式按钮可见且进入编辑态；双击标题仍保留                                | **已实现** |

### 15.4 参考材料

- `docs/ROADMAP_v0.12_UI_Simplification.md`（决策来源，含 B/C/D 项定义与指标）
- `docs/PRD_v0.12_Navigation.md`（同版 A1/A2，先行；FR-N1 移除 topbar 图标是本 PRD 前置）
- `docs/PRD_v0.11_Session_Health_Check.md`（C2 能力来源：FR-H1 标记、evaluateHealth、healthRules）
- `packages/frontend/src/routes/SessionsRoute.tsx`、`state/sessionsStore.ts`、`views/graph/health.ts`、`views/graph/graphStore.ts`、`views/graph/analytics.ts`、`i18n/zh-CN.ts`、`i18n/en-US.ts`（诊断证据源）

### 15.5 实施记录与保留边界

- **状态**：本 PRD 的 B1 / C1 / C2 与 FR-F4 / FR-C3 全部落地，随 A1/A2 导航一并
  封版 `v0.12.0`（2026-11-15，annotated tag）。发布说明与完整回归数字见
  `CHANGELOG.md [0.12.0]`。
- **回归基线（实测，全绿）**：`cargo test --lib` 413/413、`pnpm typecheck` 0、
  shared 57/57、frontend **748/748**（新增 21 项：B1 5 / C1 7 / C2 9）、
  `pnpm build` 成功（主 chunk 687.75 kB / gzip 210.04 kB）、`CI=1` Playwright
  E2E **30/30**（新增 `e2e/home-simplification.spec.ts` 8 项）、四门禁与
  generated 产物幂等通过。
- **指标实测**：首屏常驻筛选控件 = 6（5 source radio + 搜索）；卡片默认 chip = 3、
  展开 = 9；命中体检规则的会话在首页 100% 可识别（同源 `evaluateHealth` 数据，
  4 source 单测覆盖）；徽标 → 体检 1 步；重置筛选 1 步。
  > 上述为**代码/E2E 断言层面的实测**，不是真实用户行为数据；§2.3 的估算目标
  > 仍待 v0.11 A1 本地事件日志的导航/筛选点击数据校正（本期未新增埋点）。
- **按代码事实修正的偏差（不改写本 PRD 第一~十四章历史判定）**：
  1. §12 提到的 `?source=` 分享/书签深链在代码中**不存在**（`SessionsRoute` 无
     `URLSearchParams`），本期未引入该解析，单 source 单选行为不变。
  2. §5.2 把「带 `subagentDir` 的卡片」当作子会话；实际 `subagentDir` 表示
     **该会话拥有子会话目录（即 parent）**，卡片用它渲染 `⎇ N` 徽标。按字面排除
     会把全部 parent 卡片排除、徽标几乎不显示。实现改为按 `foldGraphEntries`
     折叠后的 `node.session_id` 精确匹配；子会话 id 不在索引中，自然不重复计数
     （`healthBridge.test.ts` 已锁该映射）。
  3. §2.1/§2.4 称「重命名仅靠双击」；实际已有 `✎` 按钮但无文字标签，FR-C3
     改为显式文字按钮 + 保留双击。
  4. §13.1 依赖表写 `useSettingsStore.healthRules`；实际读取为
     `useSettingsStore((s) => s.settings.healthRules)`（v0.11 既有形态）。
  5. A1 在本 PRD 写作时**尚未实现**（「已拍板先行」是决策状态而非代码状态），
     本版与 B/C 组一并落地，见 `docs/PRD_v0.12_Navigation.md` §15.5。
- **保留边界**：D1 / D2 / D3 不在本文件（§十四遗留 1）；C2 徽标直达**全局体检页**，
  未内嵌单条会话专属体检详情（§十四遗留 2，留 v0.12.x）；v0.11 五项保留边界
  仍有效（§十四遗留 3：FR-T1 部分实现、A2 标注集准确率、A3 无真实 P95、
  标记有用率不可测、C2/C3 待排期）。结论是「**B/C 组验收通过**」，不是「所有
  历史边界已消除」。

### 15.6 合规声明

本方案为产品设计参考，具体实施请结合公司合规与法务要求确认；产品坚持本地优先、零上传，本 PRD 不涉及任何网络上报或账号体系（§十/§十一）。所有数值目标标注估算，待真实数据校正。

---

**v0.12 范围闭合说明**：v0.12 三份 PRD 已齐——`PRD_v0.12_Navigation.md`（A1/A2 连通）、本文件（B1/C1/C2 首页减负）、D 组（D1/D2/D3）为 Could 待评审。至此 ROADMAP_v0.12 的 A/B/C 主线全部落地为可执行 PRD，D 组留作排期弹性。
