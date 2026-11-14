# PRD：v0.10 洞察真实化（技术债治理 + G2 OLAP 真实化）

> 版本：v1.0（草案）｜ 日期：2026-11-14 ｜ 作者：产品经理（司南）
> 关联战略文档：`docs/PRODUCT_ROADMAP_INSIGHTS.md`
> 适用范围：OpenClaw Session Viewer（开源 · 本地优先 · 多源 AI 编码会话浏览器）

---

## 一、文档信息

| 项       | 内容                                              |
| -------- | ------------------------------------------------- |
| 文档版本 | v1.0                                              |
| 作者     | 产品经理（司南）                                  |
| 日期     | 2026-11-14                                        |
| 关联版本 | v0.10（目标 release）                             |
| 评审状态 | 已实现（见 15.3 RTM / 15.5 实施记录；待正式评审） |

**变更记录**

| 版本 | 日期       | 变更摘要                                                   |
| ---- | ---------- | ---------------------------------------------------------- |
| v1.1 | 2026-11-14 | 双 Epic 开发完成：RTM 更新为已实现，补充实施记录与范围决策 |
| v1.0 | 2026-11-14 | 初稿：Epic 1 技术债治理 + Epic 2 G2 真实化                 |

**评审记录**

| 轮次 | 结论   | 修订摘要 |
| ---- | ------ | -------- |
| ——   | 待评审 | ——       |

---

## 二、背景与目标

### 2.1 背景

- **G2 OLAP 口径不可信（事实）**：当前 Analytics 视图是前端 in-memory 纯函数聚合（`docs/experiments/embed-db-G2-olap-findings.md` 已自述 limitation）：`retry_rate` 用 `error_count` 分桶**替代真实重试率**；subagent JSONL **未关联 parent**（被当独立 session 计入）；时间范围仅按 `first/last_timestamp_ms` 遮蔽。这违背"洞察深化"战略对口径可信的要求。
- **双份手写归一化（事实）**：`packages/shared/src/normalize.ts` 与 `src-tauri/src/parser/*.rs` 各实现一份 wire→归一化逻辑，无 ts-rs / Zod / 代码生成保证两侧一致（CHANGELOG `[Unreleased]` 已列为已知技术债）。新增/修改字段须手动同步，存在静默解析/渲染错位的长期风险。
- **前端弱类型（事实）**：前端 `packages/frontend/src/lib/api.ts` 自行定义 `NormalizedMessageFE` / `NormalizedBlockFE`（弱类型），未采用 `@ocsv/shared` 强类型（CHANGELOG 同条）。

### 2.2 要解决的问题

1. 让 G2 分析的核心指标（尤其重试率、subagent 聚合）**口径可信、可解释**。
2. 消除 Rust/TS 双份归一化的长期一致性风险，降低新 source 接入成本。

### 2.3 成功指标与口径

| 指标                 | 定义                                                             | 统计周期 | 目标值                                   |
| -------------------- | ---------------------------------------------------------------- | -------- | ---------------------------------------- |
| 归一化契约一致率     | 同一会话样本，Rust 与 TS 归一化输出字段一致断言通过数 ÷ 断言总数 | 每次构建 | 100%                                     |
| 分析页加载 P95       | 打开 Analytics/体检到首屏可交互                                  | 周       | < 500ms（沿用现有 in-memory 量级，估算） |
| 真实重试率算法准确率 | 评测集（含已知失败-重试序列的人工标注）上算法判定正确率          | 发布前   | ≥ 95%（估算，待评测集建立）              |

---

## 三、名词与术语定义

| 术语                 | 定义                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| 归一化（normalize）  | 将各 source 的原始 wire 事件转换为统一的 `NormalizedMessage` / `NormalizedBlock`                         |
| 重试率（retry rate） | 同一 tool 调用失败后，紧接着发生同 tool 的下一次调用，计为 1 次重试；重试率 = 重试次数 ÷ tool 调用总次数 |
| subagent 折叠        | 将 subagent 会话的用量/错误/工具调用归并到其 parent 会话，避免重复计数                                   |
| is_subagent_root     | parser 在 subagent JSONL 上打的标记，标识该文件为某 parent 的子会话根                                    |
| ts-rs                | 从 Rust 结构体生成 TypeScript 类型的代码生成工具                                                         |
| 契约测试             | 对同一输入断言 Rust 与 TS 两侧归一化输出一致，防止双份实现漂移                                           |

---

## 四、需求范围

### 包含（In Scope）

- Epic 1：技术债治理——共享 schema 单一事实源 + 代码生成 + 前端强类型统一 + 契约测试。
- Epic 2：G2 真实化——真实重试率、subagent→parent 折叠、跨 source 对比维度。

### 不包含（Out of Scope，本期不做）

- DuckDB / WASM 引入（仅当 session 破 10k 或需 window/cube 时，见路线图 S5+）。
- 会话体检（FR-H1/H2，属 v0.11）、脱敏导出（FR-E1，属 v0.12+）。
- ja-JP 等国际化（按战略决策 D-3 暂缓）。
- 云同步 / 账号体系（按战略决策 D-2 不做）。

---

## 五、方案对比与选型说明

### 5.1 Epic 1 技术债治理方案对比

| 方案                                                    | 成本 | 复杂度 | 风险             | 结论                                               |
| ------------------------------------------------------- | ---- | ------ | ---------------- | -------------------------------------------------- |
| A：Rust 为单一归一化源 + ts-rs 生成 TS 类型（**推荐**） | 中   | 中     | 低               | 现有 parser 主导在 Rust，@ocsv/shared 已存在，顺向 |
| B：TS/Zod 为单一源 + 反向生成 Rust                      | 中   | 中     | 中               | 需重写 Rust 侧消费，改动面更大                     |
| C：维持双份 + 仅加契约测试                              | 低   | 低     | 中（治标不治本） | 备选，仅当 A 排期受阻时降级                        |

**推荐 A**：以 Rust parser 为事实源，用 ts-rs 生成 `@ocsv/shared` 类型；前端渲染链路统一消费该类型，消除 `NormalizedMessageFE` 弱类型；新增契约测试锁定两侧一致。

### 5.2 Epic 2 G2 真实化方案对比

| 方案                                       | 成本 | 复杂度 | 风险               | 结论                                                    |
| ------------------------------------------ | ---- | ------ | ------------------ | ------------------------------------------------------- |
| A：下沉到现有 Rust/SQLite 聚合（**推荐**） | 低   | 低     | 低                 | 复用 `meta_aggregator` + 49 列 `session_meta`，不加依赖 |
| B：前端 in-memory 继续打补丁               | 低   | 中     | 中（口径仍不可信） | 不选，无法根治                                          |
| C：引入 DuckDB/WASM                        | 高   | 高     | 中（~20MB 包体）   | 缓做（S5+）                                             |

**推荐 A**：与现有架构一致；真实重试率/折叠在聚合阶段一次算清，前端仅负责展示。

---

## 六、用户角色与使用场景

| 角色                 | 说明                                 | 核心场景                                                 |
| -------------------- | ------------------------------------ | -------------------------------------------------------- |
| 个人开发者（主用户） | 日常用多家 AI 编码助手，本地回顾会话 | 打开 Analytics 看真实重试率/错误分布；识别哪次会话"翻车" |
| 贡献者（次级）       | 社区开发者，接入新 source 或修 bug   | 改字段时靠契约测试防止 Rust/TS 漂移                      |

**用户故事（示例）**

- 作为个人开发者，我想要在 Analytics 看到**真实**的重试率，以便判断某次会话是不是"反复试错"，而不是被一个 error 桶误导。
- 作为个人开发者，我想要 subagent 的用量**归并到父会话**，以便总量不被重复放大。
- 作为贡献者，我想要改一个归一化字段时**自动保证 Rust/TS 一致**，以便不踩静默错位的坑。

---

## 七、功能需求

> 编号规则：FR-Tx = Epic 1 技术债治理；FR-Ix = Epic 2 G2 真实化。每条含业务规则 + 验收标准（Given/When/Then）。

### Epic 1：技术债治理

**FR-T1 共享 schema 单一事实源**

- 规则：在 `packages/shared` 定义归一化 schema（消息/块/元数据的字段与类型），作为 Rust 与 TS 的唯一来源；Rust parser 输出结构体标注 `#[derive(ts_rs::TS)]`。
- 验收：Given 定义完成，When 构建，Then `@ocsv/shared` 导出的类型与 Rust 结构体一一对应，无手工重复定义。

**FR-T2 代码生成 Rust↔TS 类型**

- 规则：CI 中加入 `cargo test`（或脚本）生成 TS 类型到 `packages/shared/src/generated/`；该目录纳入版本控制或构建产物。
- 验收：Given 修改任一 Rust 归一化结构体字段，When 重新生成，Then `packages/shared` 类型同步更新，且 `typecheck` 暴露前端未适配点。

**FR-T3 前端渲染链路统一到强类型**

- 规则：移除 `api.ts` 的 `NormalizedMessageFE` / `NormalizedBlockFE` 弱类型，渲染层统一引用 `@ocsv/shared` 的 `NormalizedMessage` / `NormalizedBlock`。
- 验收：Given 渲染层消费，When 类型检查，Then 无 `FE` 弱类型引用残留（grep 断言）。

**FR-T4 归一化契约测试**

- 规则：选取覆盖 4 种 source 的代表性会话样本（脱敏，不含真实 PII/路径），分别经 Rust 与 TS 归一化，断言关键字段（role / block 类型 / token / error 标记）一致。
- 验收：Given 样本集，When 运行契约测试，Then 任一字段不一致即 FAIL，并打印差异字段。

### Epic 2：G2 真实化（下沉 Rust/SQLite）

**FR-I1 真实重试率**

- 规则：在 `meta_aggregator` 聚合阶段按消息顺序解析；若某 `tool_use` 结果为 error，且紧随其后出现**同一 tool 名**的下一个 `tool_use`，计 1 次重试；会话级重试率 = 重试次数 ÷ tool 调用总次数；跨会话汇总同上。
- 验收：Given 一个含"tool A 失败 → tool A 再调用"的会话，When 打开 Analytics，Then 重试率基于真实序列计算（非零且非 error 桶估值）；Given 仅单次失败无重试，Then 重试率 = 0。

**FR-I2 subagent→parent 折叠**

- 规则：parser 在识别为 subagent 根的 JSONL 上打 `is_subagent_root=true`；G2 聚合时，subagent 的 token/error/tool 调用归并到其 parent（经 `parent_uuid` 或现有 subagent 关联字段）；列表与汇总不重复计入 parent 总量。
- 验收：Given 存在 parent + N 个 subagent 会话，When 看全局汇总，Then 总量 = parent 自身 + Σ subagent，subagent 不被当独立会话重复加总。
- 依赖：dsh 的 `parent_uuid` 待上游 schema 加字段（见第十三章）；该 source 的折叠在字段就绪前降级为"仅 Claude/OpenClaw/Kimi 折叠"，dsh 暂按独立计。

**FR-I3 跨 source 对比维度**

- 规则：Analytics 的现有 `source` 分组补齐"同模型跨 source"对比；确保按 `source` 分组时数据无串源。
- 验收：Given 多 source 数据，When 选择 source 维度，Then 各分组仅含本 source 记录，跨 source 对比视图可按模型对齐。

---

## 八、非功能需求

| 类别   | 要求                                                                                |
| ------ | ----------------------------------------------------------------------------------- |
| 性能   | 真实重试率/折叠在聚合阶段计算，不引入二次全文件扫描；分析页加载 P95 < 500ms（估算） |
| 兼容   | 代码生成不破坏现有 379 Rust + 54 shared + 659 frontend + 24 E2E 测试基线            |
| 可维护 | 新 source 接入不再需要手写 TS 归一化副本                                            |
| 安全   | 契约测试样本不含真实 PII/路径（沿用 v0.9.30 脱敏规范）                              |

---

## 九、业务流程与状态流转

**聚合管线（新增/变更节点）**

```
原始 JSONL → 流式解析（Rust parser）→ 归一化（ts-rs 单一源）→
  meta_aggregator：
    现有：error_count / thinking_count / total_tokens / subagent_count / model_alias
    新增：retry_count（FR-I1）、subagent 折叠归并（FR-I2）
  → session_meta（SQLite 49 列扩列，如需要）→ 前端 Analytics 展示
```

**状态机（无新增实体状态）**：本 PRD 不引入新状态机；复用现有 sync 状态（`sync_state` / `last_error`）。

---

## 十、数据与埋点需求

| 需求           | 说明                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩列（如需要） | `session_meta` 增加 `retry_count` 等聚合列；迁移脚本向后兼容                                                                                                                |
| 埋点           | 事件 `analytics_view_open`（打开 Analytics）、`source_dimension_select`（切换 source 维度）、`retry_rate_displayed`（重试率渲染）——上报字段：source / 会话数 / 是否真实口径 |
| 指标口径       | 重试率口径见 FR-I1；subagent 折叠口径见 FR-I2                                                                                                                               |

---

## 十一、权限与安全要求

- 所有 FS 操作仍须落在已知 source root 白名单（`~/.claude/` `~/.openclaw/` `~/.kimi-code/` `~/.dsh/`），本 PRD 不放宽。
- 契约测试样本与导出一律脱敏（路径/PII 占位符），遵循 v0.9.30 隐私规范。
- 不引入网络上传（符合 D-2 本地优先）。

---

## 十二、异常处理清单

| 异常                                  | 处理                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| 大会话（如 9000+ 行）顺序解析性能退化 | 复用 Pass 1 流式解析，聚合阶段增量算重试，避免二次全扫（RK-1）      |
| subagent 无 parent 关联（孤儿）       | 按独立会话计，并在体检（v0.11）标记"未关联父会话"，不报错           |
| 代码生成产物与手写类型冲突            | CI 失败阻断合并，强制以生成源为准                                   |
| dsh 缺 `parent_uuid`                  | 降级：dsh subagent 暂按独立计，待上游字段就绪后启用折叠（见十三章） |

---

## 十三、上线计划、依赖与上线后验证

**依赖评估**
| 依赖项 | 所属 | 就绪状态 | 分级 | 最晚时限 | 替代 |
|--------|------|----------|------|----------|------|
| dsh schema 增加 `parent_uuid` | DeepSeek Harness 上游 | 未就绪 | 阻塞（仅 FR-I2 的 dsh 部分） | 上游发布 | 先用现有字段近似，dsh 暂独立计 |

**上线计划**

1. M1（Epic 1）：FR-T1→T2→T3→T4，逐 source 灰度切强类型，跑全量测试基线。
2. M2（Epic 2）：FR-I1→I2→I3，下沉聚合，前端切换展示真实口径。
3. 灰度：先在 dev 分支用脱敏样本验证，回归通过后发 v0.10。

**上线后验证**

- 契约测试 100% 通过（CI 门禁）。
- 真实重试率评测集准确率 ≥ 95%（估算）。
- 分析页加载 P95 观测达标。

---

## 十四、风险与遗留问题

| 编号 | 风险                                 | 类别 | 概率 | 影响 | 等级  | 应对                          | 责任人 |
| ---- | ------------------------------------ | ---- | ---- | ---- | ----- | ----------------------------- | ------ |
| RK-1 | 真实重试率全文件顺序解析致大会话退化 | 技术 | 3    | 3    | 9 中  | 复用流式解析 + 聚合增量算     | 后端   |
| RK-2 | 技术债治理改动面大，回归风险         | 技术 | 3    | 4    | 12 中 | 现有测试基线 + 逐 source 灰度 | 全栈   |
| RK-3 | 体检/导出等后续功能因口径变更需返工  | 需求 | 2    | 3    | 6 低  | 本 PRD 先固化口径，后续复用   | 产品   |

**遗留问题**

- dsh `parent_uuid` 上游就绪前，FR-I2 对 dsh 降级。
- DuckDB 是否引入取决于真实规模（S5+ 决策）。
- 国际化维持 zh-CN/en-US（D-3）。

---

## 十五、附录

### 15.1 原型思路（Analytics 视图变更）

- 重试率卡片：原"error 分桶 pie"改为"真实重试率 + 重试次数"数值卡，附口径说明（"基于工具失败-重试序列"）。
- 跨 source 对比：source 维度分组保持不变，新增"同模型跨 source"对齐视图（表格/分组柱状）。
- subagent 折叠：全局汇总 Top 10 / KPI 自动归并，列表项对 subagent 显示"隶属于 parent"标记。

### 15.2 用户故事汇总

- US-1（开发者）：真实重试率判断"反复试错"会话。
- US-2（开发者）：subagent 用量归并到父会话，总量不被放大。
- US-3（贡献者）：改字段自动保证 Rust/TS 一致。

### 15.3 需求追踪矩阵（RTM）

| 需求编号 | PRD 章节  | 设计/原型       | 测试用例                                                                                                     | 状态                       |
| -------- | --------- | --------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| FR-T1    | 7 / Epic1 | shared schema   | `packages/shared/src/contract.test.ts` + `parser/codegen.rs`                                                 | 已实现                     |
| FR-T2    | 7 / Epic1 | 生成脚本        | `pnpm codegen` + CI `git diff --exit-code -- packages/shared/src/generated/`                                 | 已实现                     |
| FR-T3    | 7 / Epic1 | api.ts 改造     | `pnpm typecheck` + grep 无 FE 残留                                                                           | 已实现                     |
| FR-T4    | 7 / Epic1 | 契约测试        | `contract.test.ts`(3 case / 4 source)+ `parser/contract.rs` 快照                                             | 已实现                     |
| FR-I1    | 7 / Epic2 | meta_aggregator | `retry_tracker_*` 3 项 + `aggregate_*_real_retry_rate` 3 项 + DB round-trip + `analytics.test.ts` retry 系列 | 已实现                     |
| FR-I2    | 7 / Epic2 | parser+聚合     | `analytics.test.ts` foldSubagents / foldGraphEntries 5 项                                                    | 已实现（dsh 按 13 章降级） |
| FR-I3    | 7 / Epic2 | Analytics UI    | `analytics.test.ts` sessionsByDay / crossSourceByModel / retryRateBySource 5 项                              | 已实现                     |

### 15.5 实施记录与范围决策（v0.10，2026-11-14）

1. **FR-T1 的边界**: `NormalizedBlock` 在 Rust 侧是 `kind: String` + 开放的
   `data: serde_json::Map`(约 19 种自定义 kind),ts-rs 无法生成闭合 discriminated
   union。故 `@ocsv/shared` 保留手写开放 interface + `[k: string]: unknown`,
   由 ts-rs 生成的 `RustNormalizedMessage` / `RustNormalizedBlock` 等类型做
   **结构断言**,由 FR-T4 契约测试做**取值门禁**;未强行生成会误导渲染层的假类型。
2. **FR-T2 门禁**: `cargo test --lib` 内的 `export_all_to()` 直接写
   `packages/shared/src/generated/`(不依赖 `TS_RS_EXPORT_DIR`),CI 在其后
   `git diff --exit-code` 并把 `Typecheck` 移到生成之后,满足"改 Rust 字段 →
   产物同步 → typecheck 暴露未适配点"。`src-tauri/bindings/` 是 ts-rs 自动
   导出的默认目录,作为构建产物被 `.gitignore` 忽略。
3. **FR-I1 口径**: 重试率 = `retry_count / tool_call_count`,分母为 0 记 0
   (不产生 NaN)。`RetryTracker` 按 wire 顺序记录调用、失败结果按 id 回填,
   仅当"失败调用的下一次调用同名"才 +1;dsh 的 `tool/call` 与
   `assistant/message` 双 envelope 按 callId 去重,避免分母虚高。
   `session_meta` 加 `retry_count` / `tool_call_count` 两列,
   `NEW_COLUMNS` 对老 DB 走幂等 `ALTER TABLE ... DEFAULT 0`。
4. **FR-I2 实现位置**: `is_subagent_root` / `parent_session_id` 此前已由
   `commands/graph.rs::derive_subagent_root()` 从 `subagent_ids_json` 反向 map
   派生并随 `GraphNodeFE` 下发,等价于 PRD 要求的标记,故未重复在 parser 打标。
   折叠发生在展示层 `analytics.ts`(纯函数、可单测),所有 KPI / Top10 / 图表
   都先吃折叠后的 nodes/entries;dsh 与孤儿按第十二章降级独立计。
5. **FR-I3 发现的既有串源**: 修前 `sessionsByDay` 把除 OpenClaw 外的所有
   记录(含 Kimi / DeepSeek Harness)计入 Claude 桶;现拆 4 个独立 key,
   并用 `sourceKey()` 兼容 `"DeepSeek Harness"` / `"DeepSeekHarness"` 两种历史拼写。
6. **回归基线**: `cargo test --lib` 391、shared vitest 57、frontend vitest 702、
   `pnpm typecheck` / `cargo fmt -- --check` / `cargo clippy -- -D warnings`、
   `pnpm build`、CI 参数下 Playwright E2E 20/20 全绿。本地 `fullyParallel`
   多 worker 下 `content-filter.spec.ts` 偶发 click 超时为既有抖动(CI 用
   `workers:1` + `retries:2` 稳定),与本次改动无关。

### 15.4 参考材料

- `docs/PRODUCT_ROADMAP_INSIGHTS.md`（战略）
- `docs/experiments/embed-db-G2-olap-findings.md`（G2 limitation 自述）
- `CHANGELOG.md` `[Unreleased]` 技术债条目
- `src-tauri/src/parser/meta_aggregator.rs`（现有聚合层）
- `packages/shared/src/normalize.ts`（现有 TS 归一化）

---

**合规声明**：本方案为产品设计参考，具体实施请结合公司合规与法务要求确认；所有涉及个人信息（路径/PII）一律默认脱敏，仅输出脱敏示例；产品坚持本地优先、零上传，不引入云端数据处理。
