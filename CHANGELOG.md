# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

_暂无未发布变更；v0.10 已归档为 [0.10.0]。_

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
  `docs/ROADMAP_v0.11_Plan.md` A1/A2/A3,不在 v0.10 实现。
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
