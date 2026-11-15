# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

## [0.12.0] - 2026-11-15

### 首页减负与操作简化（A1/A2 + B1/C1/C2 + Could）

按 `docs/ROADMAP_v0.12_UI_Simplification.md`、`docs/PRD_v0.12_Navigation.md`、
`docs/PRD_v0.12_Home_Simplification.md` 落地，覆盖 v0.12 的 A / B / C 主线。

- **A1/A2 统一一级导航（方案 α）**：新增 `components/AppLayout.tsx` + `AppLayout.css`，
  `App.tsx` 用其包裹 `<Routes>`，左侧 `SideNav` 常驻 7 项（会话 / 图探索 / 分析 /
  体检 / 知识问答 / 工具 / 设置），「体检」一步直达 `/graph?view=health`；Logo 可点回首页。
  高亮以 `useLocation`（path + `?view=`）为唯一真相源，与 `explorer-tabs` 天然双向同步，
  **`?view=` 深链与 `health-tab` testid 原样保留**。`SessionsRoute` 顶部冗余的
  graph / tools / settings 图标移除，`search` / `refresh` 保留为首页上下文操作；
  zh-CN / en-US 同步新增 `nav.*` 文案。
- **B1 筛选收敛（FR-F1/F2/F3）**：`sessionsStore` 的 `source` 扩为含 `"all"` 并设为默认
  （修复开箱只能看 openclaw），`filteredSessions` 在 `all` 时跳过 source 过滤；
  新增 `DEFAULT_SESSIONS_FILTER` 与 `resetFilter()` 作为单一归位入口。首页筛选区拆为
  「常驻区」（5 个 source radio 含「全部」+ 搜索框 = 6 控件）与默认折叠的「高级筛选」
  （liveOnly / hasSubagents / last7Days / agent / showHidden / showArchived，
  `aria-expanded` 按钮），新增「重置筛选」同步复位本地 `showHidden` / `showArchived`。
- **FR-F4（Could）**：高级筛选展开态用 localStorage 持久化，重启保留。
- **C1 卡片分层（FR-C1）**：新增 `routes/sessionCardChips.ts` 纯函数，按
  `error > repeat > duration` 优先、其余折叠，卡片默认只露 ≤3 个 stat-chip，
  「展开 / 收起」切换显示原有全部 chip 与 topTools。
- **C2 风险徽标前置（FR-C2）**：新增 `views/graph/healthBridge.ts`，首页消费
  `useGraphStore.entries`（空则懒触发一次 `load()`）+ `settings.healthRules`，
  `useMemo` 执行 `foldGraphEntries` → `evaluateHealth` →
  `Map<session_id, FlaggedSession>`。**强制复用 v0.11 引擎，零第二套口径**；
  命中卡片叠加「风险(N)」徽标（hover 显示规则 / 实际值 / 阈值，`aria-label` 含命中数），
  点击直达 `/graph?view=health`。entries 加载中 / 为空 / 脏数据均返回空索引、不阻塞首屏。
- **FR-C3（Could，D4）**：卡片操作区重命名改为显式文字按钮（保留双击标题），
  补 `aria-label` / testid。
- **文档**：三份 v0.12 PRD 的 RTM 与实施记录回填、ROADMAP 升 v1.1、README 时间线、
  6 处版本 bump 至 `0.12.0`；i18n 两组语言同步。
- **全量回归（全绿）**：`cargo test --lib` **413/413**、`cargo fmt -- --check` /
  `clippy --all-targets -D warnings` 通过；`pnpm typecheck` 0；shared **57/57**、
  frontend **748/748**（新增 21 项：B1 5 / C1 7 / C2 9）；`pnpm build` 成功
  （主 chunk 687.75 kB / gzip 210.04 kB，较 v0.11 +18 kB，因首页复用体检计算模块）；
  `CI=1` Playwright E2E **30/30**（新增 8 项）；四个门禁与 generated 产物幂等通过。

**按代码事实修正的 PRD 偏差（不改写 PRD 历史判定，仅登记）**

1. PRD 描述的 `?source=` 分享 / 书签深链在代码中**不存在**（`SessionsRoute` 无
   `URLSearchParams`），本期未引入该解析，单 source 单选行为不变。
2. PRD §5.2 把「带 `subagentDir` 的卡片」当作子会话；实际 `subagentDir` 表示
   **该会话拥有子会话目录（即 parent）**，首页用它渲染 `⎇ N` 徽标。若按字面排除
   会把全部 parent 卡片排除、徽标几乎不显示。实现改为按 `foldGraphEntries` 折叠后的
   `node.session_id` 精确匹配；子会话 id 不在索引中，自然不重复计数。
3. PRD 称「重命名仅靠双击」；实际已有 `✎` 按钮但无文字标签，FR-C3 改为显式文字 + 保留双击。
4. PRD 依赖表写 `useSettingsStore.healthRules`；实际读取为
   `useSettingsStore((s) => s.settings.healthRules)`（v0.11 既有形态）。
5. v0.12 的 A1 在代码里原本未实现（PRD 写「已拍板先行」），本版与 B / C 组一并落地。

**保留边界（不得写成已通过）**：D1 / D2 / D3（悬浮菜单 / 阈值内联 / 快捷键提示）未开发；
C2 徽标直达**全局体检页**，未内嵌单条会话专属体检详情（留 v0.12.x）；
v0.11 五项保留边界仍有效（FR-T1 部分实现、A2 标注集准确率、A3 无真实 P95、
标记有用率不可测、C2 / C3 待排期）；本期不新增任何埋点与网络上报（D-2）。

## [0.11.0] - 2026-11-15

### 会话体检（B1 / B2 / B3）+ C1 dsh 去重鲁棒性

按 `docs/ROADMAP_v0.11_Plan.md`（v1.2）与 `docs/PRD_v0.11_Session_Health_Check.md` 落地。

- **B1 异常会话标记（FR-H1）**：新增 `packages/frontend/src/views/graph/health.ts` 纯函数规则引擎，
  四条可配置规则 —— `error_count ≥ 20`、`token_total > μ + 3σ`（总体标准差）、
  `subagent_count ≥ 10`、`available_models.length ≥ 2`（同会话模型漂移）。
  每条标记输出**可解释标签**（命中规则 + 实际值 + 阈值 + hover 判定依据），不做黑盒评分。
  样本 < 2 或 σ = 0 时不判定离群；阈值经 `normalizeHealthRules()` clamp，NaN / 负数 /
  越界值回退默认；字段缺失静默跳过，空数据不报错。
- **数据链路**：`commands/graph.rs` 的 `list_graph` 增读 `available_models_json`
  （`GraphNodeFE.available_models`，NULL 降级空数组），前端 `SessionNode` 同步增可选字段。
  体检与 G2 Analytics **共用 `foldGraphEntries()` 折叠后的 nodes**，不产生第二套汇总口径。
- **B2 全局体检报告（FR-H2）**：`GraphExplorerRoute` 新增 `?view=health` 深链与「G4 体检」tab；
  `HealthView.tsx` 提供 KPI、按规则 / 按 source 分布图、Top 风险会话表（点击下钻
  `/session/:id`）、空数据空状态与口径说明。新增 `health_view_open` 本地事件，
  零上传门禁扫描文件由 3 个扩到 4 个并增加事件落地断言。
- **B3 阈值配置与持久化（RK-V1）**：`HealthRulesConfig` 定义在 `@ocsv/shared`（单一事实源），
  Rust `commands/settings.rs` 用 `#[serde(default)]` 兼容老 `settings.json`；设置页新增
  4 组开关 / 数值输入 + 恢复默认值，保存后体检页自动重算、重启保留。
- **C1 dsh 去重鲁棒性**：`RetryTracker` 增 `alias_id` / `mark_failed_by_name`，
  `aggregate_dsh` 按「工具名 + wire 顺序」FIFO 配对两种 envelope 的不同 id，
  `source.callId` 为第三种取值时按最近同名未失败调用 best-effort 回填。
  评测集 26 → 29 例，`pnpm eval:retry` 实测 **100.00%（29/29）**。
- **文档**：新增 `docs/PRD_v0.11_Session_Health_Check.md`；ROADMAP 升 v1.2
  （RTM 的 B1/B2/B3/C1 标为已实现，C2/C3 待排期）；QA 核验报告新增第九章复核
  （不改第一~八章历史判定）；评测报告更新样本数与 C1 说明；README 时间线补 v0.11.0；
  6 处版本 bump 至 `0.11.0`。
- **全量回归（全绿）**：`cargo test --lib` **413/413**（新增 10 项）、`cargo fmt -- --check` /
  `clippy --all-targets -D warnings` 通过；`pnpm typecheck` 0；shared vitest **57/57**、
  frontend vitest **727/727**（新增 16 项体检规则）；`pnpm build` 成功
  （主 chunk 669.38 kB / gzip 204.23 kB，未回归）；`CI=1` Playwright E2E **22/22**
  （22.8s，单 worker）；`git diff --exit-code -- packages/shared/src/generated/` 为 0；
  FE grep / 零上传 / 评测集准确率 / P95 四个门禁全部通过。

**保留边界（不得写成已通过）**：FR-T1 双份手写归一化根因未消除（按 ROADMAP 第四章
Won't 不重写）；A2 的 100% 是人工标注集准确率、非真实生产分布（RK-V3 未消除）；
A3 的 `<500ms` 仍是估算预算、无 9000+ 行大会话 P95 实测值；
「体检标记有用率 ≥70%」缺「用户确认有用」反馈入口、指标仍不可测；
C2 / C3 待排期；dsh `parent_uuid` 折叠降级仍在。

### v0.10 验收收口（v0.11 规划 A 组 A0–A5 全部完成）

按 `docs/QA_v0.10_Acceptance_Verification.md` 与 `docs/ROADMAP_v0.11_Plan.md`，
把 v0.10 遗留的三个配套缺口全部补齐（此前按「有条件放行」建议结转）：

- **A0 / A4 / A5** 已于 `8e8929b` 完成：封版 `0.10.0` + tag `v0.10.0`、
  CHANGELOG 归档、FR-T1 编译期结构断言、CI grep 门禁、PRD 偏差清单 8 项修订、
  合规注释与陈旧示例清理（详见 [0.10.0] 段与 QA 报告第八章复核记录）。
- **A1 埋点口径重定义 + 本地事件日志（G-1）**：按 D-2「本地优先、零上传」把
  PRD 第十章的「埋点上报」重定义为**本地事件日志**。新增 `event_log` 表
  （`db/schema.rs` 新库 + `db/migrations.rs::NEW_TABLES` 老库幂等补表）、
  `db/event_log.rs`、三个 Tauri command（`append_local_event` /
  `list_local_events` / `local_event_p95`）。前端 `lib/eventsApi.ts` +
  `AnalyticsView.tsx` 落地 `analytics_view_open` / `source_dimension_select` /
  `retry_rate_displayed` 三事件（含 source 维度可点选过滤），记录事件名 / 时间戳 /
  source / 会话数 / 是否真实口径；**禁止任何网络请求**。
  `scripts/assert-local-events.mjs` + `pnpm assert:local-events` 在 CI 与
  pre-commit 扫描埋点链路，已做注入验证（注入 `fetch(...)` 即 exit 1）。
- **A2 真实重试率评测集（G-2）**：新增 26 个脱敏人工标注样本
  （`src-tauri/src/parser/__fixtures__/retry-eval-set.json`），覆盖 4 source 与
  单次失败无重试 / 分母 0 / 相邻不同名工具 / 重复 id / 连续重试链 /
  step 级 error / envelope 去重等边界；`parser/retry_eval.rs` **走真实聚合入口**
  比对 `retry_count` / `tool_call_count`，输出逐样本可复现报告，断言准确率 ≥95%
  与 26/26 基线锁。实测 **100.00%（26/26）**，`pnpm eval:retry` 可复现，
  报告见 `docs/experiments/retry-rate-eval-report.md`。
- **A3 分析页 P95 采集与门槛（G-3）**：`analytics_ready` 事件用
  `performance.now()` 记录「打开 Analytics → 首屏可交互」耗时写入本地 event_log；
  Rust `check_p95_budget` 与前端 `views/graph/perf.ts` 使用一致的 nearest-rank
  P95 定义；`<500ms` 是 PRD 自标的**估算预算**，仅开发 / CI 模式断言，
  生产不硬失败。`pnpm assert:p95` 跑 9 个单测（含慢样本注入验证）。
- CI 新增三步门禁 `pnpm assert:local-events` / `pnpm eval:retry` /
  `pnpm assert:p95`；`.husky/pre-commit` 同步加零上传门禁。
- 文档：`ROADMAP_v0.11_Plan.md` 的 A0–A5 RTM 标为已实现并留变更记录；
  PRD 升 v1.3 补 15.6 收口复核；QA 核验报告新增第八章复核记录（不篡改原结论）。
- 版本说明：`v0.10.0` tag 保持为功能封版基线、不回改；以上收口补丁与本版 B 组改动
  一同在 `v0.11.0` 发布（遵循 `docs/RELEASING.md`「tag 之后的 fix 累积到下一版本」）。
- 全量回归（全绿）：`cargo test --lib` **403/403**（新增 12 项 A1/A2/A3 测试）、
  `cargo fmt -- --check` / `cargo clippy --all-targets -- -D warnings` 通过；
  `pnpm typecheck` 0；shared vitest **57/57**、frontend vitest **711/711**
  （新增 9 项 P95 断言）；`pnpm build` 成功（主 chunk 665.53 kB / gzip 202.83 kB，
  未回归）；`CI=1` Playwright E2E **20/20**（20.4s，单 worker）；
  `git diff --exit-code -- packages/shared/src/generated/` 为 0；
  FE grep / 零上传 / 评测集准确率 / P95 四个门禁全部通过。

## [0.10.0] - 2026-11-14

### v0.10 洞察真实化（技术债治理 + G2 OLAP 真实化）

按 `docs/PRD_v0.10_Insight_Realization.md` 落地双 Epic（FR-T1~T4 / FR-I1~I3）。

- **Epic 1 技术债治理**
  - FR-T1/T2: Rust `NormalizedMessage` / `NormalizedBlock` / `TokenUsageOut` /
    `SubagentSummary` 标注 `#[derive(ts_rs::TS)]` 作为唯一事实源;
    `cargo test --lib` 把类型确定性写到 `packages/shared/src/generated/normalize-types.ts`,
    契约快照写到 `.../normalize-contract-rust.json`。新增 `pnpm codegen` 脚本;
    CI 在 Rust 测试后用 `git diff --exit-code` 门禁、且把 Typecheck 移到生成之后,
    产物不一致即阻断合并。`src-tauri/bindings/`(ts-rs 默认导出)改为忽略的构建产物。
  - FR-T3: `api.ts` 删除 `NormalizedMessageFE` / `NormalizedBlockFE` 弱类型,
    渲染链路统一消费 `@ocsv/shared` 强类型,全量 typecheck 通过。
  - FR-T4: 4 种 source 脱敏样本 + Rust/TS 双侧归一化契约测试
    (`packages/shared/src/contract.test.ts`),锁定 role / blockKinds / tokenUsage /
    hasError,任一字段不一致即 FAIL 并打印差异。
  - 范围决策: `NormalizedBlock` 的 `data` 是开放 `serde_json::Map`(约 19 种自定义
    kind),ts-rs 无法生成闭合 union;shared 保留手写开放 interface +
    `[k: string]: unknown`,由契约测试门禁保证不漂移,而非强行生成错误类型。
- **Epic 2 G2 真实化**
  - FR-I1: `meta_aggregator::RetryTracker` 按 wire 顺序记录 tool 调用,失败结果
    通过 id 回填,`windows(2)` 判定"失败后紧随同名调用";产出
    `retry_count` / `tool_call_count`,3 个聚合入口(claude/openclaw/kimi/dsh)全接入。
    字段经 `MetaExtras → SessionMeta → session_meta` 两列(含老 DB `ALTER TABLE` 迁移)
    → `JOIN_SELECT_BASE` → `GraphNodeFE` → 前端 `SessionNode`。Analytics 把
    error 分桶 pie 换成真实重试率数值卡 + 按 source 明细 + 口径说明。
  - FR-I2: `analytics.ts::foldSubagents` / `foldGraphEntries` 把 subagent 的
    token/error/tool 调用/retry 归并到 parent(支持多级递归 + 环保护),子会话
    不再作为独立会话重复加总,edges 挂到 parent 不丢调用;孤儿与 dsh(缺
    `parent_uuid`)按 PRD 降级独立计。列表项显示"含 N 个"折叠标记。
    注: `is_subagent_root` / `parent_session_id` 沿用 `commands/graph.rs`
    由 `subagent_ids_json` 反向 map 派生的等价标记,未重复在 parser 加字段。
  - FR-I3: `sessionsByDay` 拆成 Claude / OpenClaw / Kimi / DeepSeekHarness
    四个独立桶(此前 Kimi/dsh 被静默算进 Claude);新增
    `crossSourceByModel` 同模型跨 source 对齐表 + `retryRateBySource` /
    `sessionsBySource`,分组 key 含 source,不串源。
- 口径文档: PRD v1.2 按 QA 验收核验报告修订 RTM 与验收措辞(FR-T1 降为「部分实现」),
  并列出实现决策与降级项;章节顺序 15.3 → 15.4 → 15.5 已修正。
- 验收收口 (PRD v1.2): 补 `packages/shared/src/schema-assert.ts` 编译期结构断言
  (生成类型从零消费变为真实被引用,Rust 改字段而 shared 未同步时 typecheck 失败)、
  `scripts/assert-no-fe-types.mjs` + `pnpm assert:no-fe-types` 在 CI 与 pre-commit
  断言无 FE 弱类型回归;修订 FR-T2 / FR-T3 / FR-T4 / FR-I2 验收措辞与代码事实一致;
  清理 `normalize.ts` / `model/mod.rs` 注释及测试 fixture 中的疑似真实标识,
  更新 `docs/PARSER_ARCHITECTURE.md` 陈旧 `NormalizedBlockFE` 示例。
  G-1 埋点 / G-2 重试率评测集 / G-3 P95 采集三项配套缺口按放行建议结转
  `docs/ROADMAP_v0.11_Plan.md` A1/A2/A3,不在 v0.10 实现
  （已于 2026-11-14 由 A1/A2/A3 在 `main` 补齐,见上文 `[Unreleased]` 与 PRD 15.6）。
  收口复跑核实: `cargo test --lib` 391 / shared vitest 57 / frontend vitest 702 /
  `CI=1` Playwright E2E 20/20(22.2s,单 worker),核验报告 §四「未复跑」项已补齐。
- 回归: `cargo test --lib` 391 / shared vitest 57 / frontend vitest 702 /
  `cargo fmt -- --check` + `clippy -D warnings` 全绿;CI 参数下 Playwright E2E 20/20。
  (本地 `fullyParallel` 多 worker 下 `content-filter.spec.ts` 仍偶发 click 超时,
  属 11-14 已记录的既有抖动;CI 用单 worker + retries 稳定。)

### 已知技术债 / 改进方向

- **双份手写归一化（根因仍在）**: Rust `parser/*.rs` 与 `packages/shared/src/normalize.ts`
  仍是两份独立实现,v0.10 **未**做到「单一事实源 / 无手工重复定义」。已增加
  `schema-assert.ts` 编译期结构断言 + ts-rs 类型生成 + 4 source 契约快照 +
  CI `git diff` 门禁,把**静默漂移变成可检出漂移**;新增/修改字段仍须同步两侧,
  新增自定义 kind 仍需补契约样本。FR-T1 按 QA 核验报告标为「部分实现」。
- **渲染层弱类型（已治理）**: `api.ts` 自定的 `NormalizedMessageFE` /
  `NormalizedBlockFE` 已删除,渲染链路统一到 `@ocsv/shared` 强类型;
  `pnpm assert:no-fe-types` 在 CI 与 pre-commit hook 断言无回归。
- **i18n**: 框架层已支持 `en-US` / `zh-CN` 切换(设置页选择即生效,启动按已保存语言加载);
  组件级文案迁移到 `t()` 已完成(已合并 main,`en-US` 下组件文案现已翻译),断言中文的
  测试已同步更新。`zh-CN` / `en-US` 资源位于 `packages/frontend/src/i18n/`。

## [0.9.30] - 2026-08-21

- 隐私: `fixtures/` 目录(含真实会话样本)从 git 历史彻底清除,`.gitignore` 整目录忽略。
- CI: 修 10 个 clippy lint denials(clippy 1.97 收紧默认),Lint & Format job 转绿。

## [0.9.29] - 2026-08-20

- M11.1 补丁: `first_prompt` 持久化、`tool_use_count` 改走 aggregator、启动 sync 显式触发。
- M11.2-5 dsh 修复: optimistic pill、banner 聚合、noise filter、sandbox/approval 路由。
- 隐私: 移除 fixture 驱动的测试、用户路径脱敏为占位符、文档路径清理。

## [0.9.28] - 2026-08-19

- **M11 — DeepSeek Harness (dsh) 第 4 种 wire-format source**: 接入 `~/.dsh/sessions/`。
- `.jsonl.zstd` 透明 reader(`jsonl_zst.rs` + 按扩展名派发的 `*_auto` 包装)。
- `--…--` bracket 包裹解码:project_key 以 `dsh:<dir-name>` 不透明存储。
- `SessionSource` 扩为 4 元 union,DB CHECK 加 `'dsh'`;per-event envelope normalize(无 state machine)。
- UI: filter chip / source badge "DeepSeek Harness" / graph label。

## 0.9.0 → 0.9.27(逐版压缩)

- **0.9.27** — M10: meta 聚合 Pass 2→Pass 1 single-pass cutover。
- **0.9.26** — M9: Pass 1↔Pass 2 并行跑验证 3 个 kimi 字段。
- **0.9.25** — snake/camel 兼容第二阶段撤除。
- **0.9.24** — 从 SessionDetailRoute 抽 SessionHeader + SessionNotesPanel + useSessionActions。
- **0.9.23** — 6 个 chart blocks 抽到独立 ChartsRegion + 后端 StreamBatch 加 `charts` 字段。
- **0.9.22** — 抽 L1 SessionOverview + SessionSummaryStrip 空数据 3 重 guard。
- **0.9.21** — 集中 meta 工具、MetaBlock→MetaBlockRouter 改名、ADR 落地。
- **0.9.20** — MetaBlock 拆 4-way router + AttachmentBlock + EventMetaBlock。
- **0.9.19** — 抽 6 个 chart 子组件 + ChartBlock dispatcher。
- **0.9.18** — 13 种 attachment kind 统一 slate + accent 配色集中化。
- **0.9.17** — claude: ai-title / custom-title 聚合 chart。
- **0.9.16** — kimi: tools.update_store → todo chart(57 events 聚合为 1 chart)。
- **0.9.15** — kimi: llm.request 上下文 headroom + config drift chart。
- **0.9.14** — kimi: usage.record per-turn token chart。
- **0.9.13** — kimi: llm.tools_snapshot 会话工具配置。
- **0.9.12** — kimi: context.apply_compaction 摘要 + 压缩统计。
- **0.9.11** — kimi: plan_mode.exit 视为用户可观测的 plan 退出。
- **0.9.10** — kimi: subagent 发现 + 4 个缺失 event type。
- **0.9.9** — kimi: unwrap context.append_loop_event envelope + content.part thinking parser 修复。
- **0.9.8** — kimi: 真实样本驱动 3 聚合(todo/token/banner)+ transcript collapse。
- **0.9.7** — kimi: 真实样本回归 4 闭合 + 2 bug fix。
- **0.9.6** — thinking_count 跨 source 全填。
- **0.9.5** — kimi MetaExtras 5 字段跨 source 对齐。
- **0.9.4** — kimi 跨 session 工具聚合。
- **0.9.3** — kimi 聚合 usage.record → SessionMeta.total_tokens。
- **0.9.2** — e2e 改 HashRouter + `?path=` 修复 18 个历史 spec。
- **0.9.1** — kimi 默认 home 改 `~/.kimi-code`。
- **0.9.0** — **Kimi Code 第 3 种 source**: wire.jsonl 解析 + 状态机 + 子代理。

## 0.8.0 → 0.8.15(逐版压缩)

- **0.8.15** — keymap 跨平台化 + 撤 6 个 band-aid。
- **0.8.14** — 后端安全收紧 + 流式契约修复(9 项)。
- **0.8.13** — Data integrity 收口。
- **0.8.12** — Critical bug 收口(4 真 bug + 2 test gap + 1 UX)。
- **0.8.11** — 详情页 reload 按钮 + Cmd+R/Ctrl+R。
- **0.8.10** — Defense in depth(2 真 bug + 3 hardening + 2 test gap)。
- **0.8.9** — 收口 db/sync + analytics test gap + add_session_link ON CONFLICT 修复。
- **0.8.8** — 修 v0.8.5 起的 3 个 graph bug。
- **0.8.7** — GraphView CrossSession + ParentUuid edges + 读写连接分离。
- **0.8.6** — GraphView edges + export 隐私 + sync_state last_error。
- **0.8.5** — per-tool 失败维度 + 跨 session 工具聚合 + /tools 路由 + G1/G2 切 DB。
- **0.8.4** — session_meta 扩 19 列 + HomeStatusBar + 6 meta handler + Transcript 性能。
- **0.8.3** — refresh storm 修复 + String(e) + LEFT JOIN NULL。
- **0.8.2** — 3 个 hotfix(NOT NULL / orphan sweep failsafe / unused import)。
- **0.8.1** — 5 个 review 后修(排序 / rename / 孤儿清理 / tx / apply_bool mode)。
- **0.8.0** — **嵌入式 SQLite session DB**:rename/hide/pin/archive/notes/tags/links 覆盖 + 搜索历史。

## 早期版本(< 0.8,按阶段压缩)

- **v0.7.x** — 会话详情内容维度筛选(role/属性)+ 聚合去噪 + React 18→19 升级 + vitest 覆盖率 + Playwright E2E;修复 transcript 虚拟化性能回归。
- **v0.6.x** — Claude 会话关联信息优雅展示:subagentId 归一、Agent 卡片内嵌子代理摘要、文件路径点击 reveal、meta 块显示优化。
- **v0.5.x** — 主-子 agent 关联:SubagentPanel、tool_use 卡片、子会话跳转。
- **v0.4.x** — app icon + 平台尺寸;timezone 设置;会话内搜索 + diff 高亮;OpenClaw trajectory view;3 个新 meta handler。
- **v0.3.x** — parser 重构为 BlockRegistry + handler 拆分,消灭未知 block 崩溃;排序切换。
- **v0.2.x** — 自定义数据源 roots + hot reload;multi-agent UI 分组;Windows `[object Object]` 安全加固;CI 跨平台产物 + SHA256SUMS。
- **v0.1.0** — 初始版:Tauri 2 + React + Rust 桌面应用,浏览本地 Claude Code / OpenClaw 会话 JSONL。
