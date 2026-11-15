# PRD v0.11：会话体检（Session Health Check）

> 版本：v1.0 ｜ 日期：2026-11-15 ｜ 状态：**已实现并封版 `v0.11.0`**
> 上位文档：`docs/ROADMAP_v0.11_Plan.md`（v1.2）、`docs/PRODUCT_ROADMAP_INSIGHTS.md`（FR-H1 / FR-H2）
> 关联：`docs/PRD_v0.10_Insight_Realization.md`、`docs/QA_v0.10_Acceptance_Verification.md`

---

## 一、文档信息

| 项       | 内容                                                               |
| -------- | ------------------------------------------------------------------ |
| 目标版本 | v0.11.0                                                            |
| 前置     | v0.10.0 已封版；A 组 A0–A5 收口已合入 `main`                       |
| 战略约束 | D-1 洞察深化 · D-2 纯开源社区（本地优先、零上传） · D-3 国际化暂缓 |
| 本版主线 | 让「洞察」从「用户自己翻 Analytics」升级为「系统主动标出异常会话」 |
| 范围决策 | ROADMAP 原定范围：B1 / B2 / B3 + 顺手补 C1；**不重写归一化层**     |

---

## 二、背景与问题

v0.10 交付了可信的聚合口径（真实重试率、subagent 折叠、跨 source 对比），但用户仍需要自己
在 Analytics 里翻图表才能发现问题。QA 核验报告同时留下五项保留边界，其中「B 组会话体检未开发」
是本版主线，C1 是非阻塞的 dsh 去重边界。

ROADMAP 第四章已明确把「强行重写归一化层为单一实现」列为 **Won't**，因此本版不触碰
FR-T1 根因；FR-T1 在 v0.10 PRD 的 RTM 中仍为「部分实现（可检出漂移）」。

## 三、目标与非目标

- **目标**：① 系统按可配置规则主动标记异常会话，每个标记可解释；② 提供全局体检报告与下钻；
  ③ 阈值可在设置页修改、本地持久化、重启保留；④ 补齐 C1 的 dsh 去重鲁棒性。
- **非目标**：云同步 / 账号 / 团队版（D-2）、脱敏导出 FR-E1（v0.12+）、成本异常 FR-H3（v0.12+）、
  重写 Rust/TS 双份归一化（Won't）、「用户确认有用」反馈入口（有用率指标本版仍不可测）。

## 四、用户与场景

| 角色             | 场景                                                          | 期望结果                                          |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| 个人开发者       | 一周跑了很多会话，想快速找出「哪几个出问题了」                | 打开体检 tab 直接看到 Top 风险会话与命中原因      |
| 重度多源用户     | claude / openclaw / kimi / dsh 混用，担心某个 source 异常聚集 | 按 source 分布图定位，标签在各 source 均可触发    |
| 对误报敏感的用户 | 默认阈值（估算值）不适合自己的工作流                          | 设置页关规则 / 调阈值，保存后立刻重算，重启不丢失 |

## 五、需求范围与优先级

| 编号 | 需求                                             | 优先级 | 状态       |
| ---- | ------------------------------------------------ | ------ | ---------- |
| B1   | FR-H1 异常会话标记（可配置规则 + 可解释标签）    | Must   | **已实现** |
| B2   | FR-H2 全局体检报告 tab（分布 + Top 风险 + 下钻） | Must   | **已实现** |
| B3   | 体检规则阈值配置入口 + 本地持久化                | Should | **已实现** |
| C1   | dsh 双 envelope 不同 id 取值的去重鲁棒性         | Could  | **已实现** |
| C2   | 本地事件日志可视化（自查面板）                   | Could  | 待排期     |
| C3   | 口径说明 / 帮助入口统一                          | Could  | 待排期     |

## 六、功能需求与验收（GWT）

| 编号 | 验收要点                                                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1   | Given 会话 `error_count = 25`，When 体检渲染，Then 显示「高错误数（25 ≥ 20）」且 hover 显示 `error_count = 25，阈值 = 20`；Given 未命中任何规则，Then 无标签；Given 关闭某规则，Then 不再标记 |
| B2   | Given 已 sync 数据，When 打开 `?view=health`，Then 展示 KPI、按规则分布、按 source 分布、Top 风险表；Given 点击某行，Then 跳 `/session/:id`；Given 空数据，Then 展示空状态而非报错            |
| B3   | Given 把错误阈值改为 30，When 重新计算，Then `error_count = 25` 的会话不再标记；Given 重启应用，Then 配置保留（老 settings.json 无该字段时用默认值，不阻断启动）                              |
| C1   | Given dsh 的 `part.id` / `data.callId` / `source.callId` 取值互不相同，When 走真实聚合入口，Then `tool_call_count` 不重复计数且失败回填不丢，评测样本判定与人工标注一致                       |

## 七、规则定义（估算默认值，非调研结论）

| 规则 ID         | 判定条件                                         | 默认值 | 可解释标签示例                 |
| --------------- | ------------------------------------------------ | ------ | ------------------------------ |
| `highErrors`    | `error_count ≥ highErrorsThreshold`              | 20     | 高错误数（25 ≥ 20）            |
| `tokenOutlier`  | `token_total > μ + tokenSigma × σ`（总体标准差） | 3σ     | token 离群（12000 > 9532）     |
| `manySubagents` | `subagent_count ≥ subagentsThreshold`            | 10     | 子会话过多（12 ≥ 10）          |
| `modelDrift`    | `available_models.length ≥ modelDriftMinModels`  | 2      | 同会话模型漂移（3 个模型 ≥ 2） |

防御：样本 < 2 或 σ = 0 时不判定 token 离群（避免全量误报）；阈值经
`normalizeHealthRules()` clamp，NaN / 负数 / 越界值一律回退；缺 `available_models`
字段的 source 不臆造模型信息，该规则静默跳过。不做黑盒健康分（RK-V1）。

## 八、技术方案与选型

| 方案                                 | 成本 | 风险                         | 结论                                     |
| ------------------------------------ | ---- | ---------------------------- | ---------------------------------------- |
| A：前端纯函数规则引擎（**采用**）    | 低   | 低，复用现有 graphStore 数据 | 规则只做只读派生，不产生第二套持久化口径 |
| B：Rust/SQLite 新增体检表 + 物化标记 | 中   | 阈值变更需全量重算、老库迁移 | 不做；阈值是用户可配的展示层参数         |
| C：引入评分模型 / 黑盒健康分         | 中   | RK-V1 用户不信任             | 明确不做                                 |

**关键约束**：体检必须消费 `foldGraphEntries()` 折叠后的 nodes，与 G2 Analytics 同一口径
（subagent 的错误 / token / 工具调用已归并到 parent），禁止直接吃 `graphStore.entries`。

## 九、数据链路

```
session_meta.available_models_json (v0.11 新增读取)
  → commands/graph.rs::list_graph (GraphNodeFE.available_models)
  → graphStore.entries
  → foldGraphEntries(entries).nodes            ← 与 Analytics 共用
  → health.ts::evaluateHealth(nodes, rules)    ← 纯函数、可单测
  → HealthView.tsx (KPI / 分布图 / Top 风险表 / 下钻)
  → /session/:sessionId
```

配置链路：`SettingsRoute → useSettingsStore.update({healthRules}) → save(settings)`
→ Tauri `save_settings` 写本地 `settings.json` → Rust `HealthRulesConfig`（camelCase、
`#[serde(default)]` 兼容老配置）→ 重启由 `get_settings` 读回。

## 十、隐私与合规（D-2）

- 体检全部在本地计算，**不引入任何网络请求**；新增 `health_view_open` 事件只写本地
  SQLite `event_log`，`scripts/assert-local-events.mjs` 的扫描文件已由 3 个扩展到 4 个
  （含 `HealthView.tsx`），CI 与 pre-commit 断言零上传。
- 新增代码 / 评测样本一律使用占位标识，不含真实路径、用户名或会话 id。
- 阈值配置只写用户本机 `settings.json`，不随会话数据导出。

## 十一、风险与应对

| 编号  | 风险                                | 应对                                                                  |
| ----- | ----------------------------------- | --------------------------------------------------------------------- |
| RK-V1 | 阈值误报 / 漏报导致不信任黑盒       | 可解释标签（命中规则 + 实际值 + 阈值）+ 阈值可配 + 默认值标注「估算」 |
| RK-V3 | 评测集样本偏易、准确率虚高          | 100% 只表述为「标注集准确率」，RK-V3 明确未消除                       |
| RK-V5 | 大会话体检重算拖慢首屏              | 复用折叠结果，不二次全扫；规则为 O(n) 单次遍历                        |
| 新增  | 老 settings.json 缺字段导致启动失败 | `#[serde(default)]` + 4 项 Rust 单测覆盖                              |
| 新增  | C1 别名误配导致重试率错算           | FIFO 按「工具名 + wire 顺序」配对；同名兜底只匹配最近未失败调用       |

## 十二、测试与验证物

- `packages/frontend/src/views/graph/health.test.ts`：16 项，覆盖 4 source 触发、空数据、
  四条规则、阈值开关 / 重算、NaN 防御、排序、折叠口径一致性。
- `src-tauri/src/commands/settings.rs`：4 项（老配置兼容 / 默认值一致 / camelCase round-trip / 部分字段补齐）。
- `src-tauri/src/commands/graph.rs`：2 项（`available_models_json` 为 NULL / 有值）。
- `src-tauri/src/parser/meta_aggregator.rs`：4 项（别名去重、同名兜底、两种真实聚合入口场景）。
- 评测集 `retry-eval-set.json`：26 → 29 例，`pnpm eval:retry` 实测 100.00%（29/29）。
- `e2e/health.spec.ts`：2 项（体检 tab 深链 + 空状态；设置页阈值编辑与恢复默认）。
- 全量回归数字见 `CHANGELOG.md [0.11.0]` 与 `docs/QA_v0.10_Acceptance_Verification.md` 第九章。

## 十三、需求追踪矩阵（RTM）

| FR / 项 | 实现位置                                                            | 验证物                                 | 状态       |
| ------- | ------------------------------------------------------------------- | -------------------------------------- | ---------- |
| FR-H1   | `views/graph/health.ts`                                             | `health.test.ts` 16 项                 | **已实现** |
| FR-H2   | `views/graph/HealthView.tsx`、`routes/GraphExplorerRoute.tsx`       | `e2e/health.spec.ts` 2 项 + 纯函数单测 | **已实现** |
| B3      | `routes/SettingsRoute.tsx`、`shared/ipc.ts`、`commands/settings.rs` | Rust 4 项 + 设置页 E2E                 | **已实现** |
| C1      | `parser/meta_aggregator.rs`、`__fixtures__/retry-eval-set.json`     | Rust 4 项 + 评测集 3 例                | **已实现** |

## 十四、实施记录与保留边界

**本版通过的验收**：B1 / B2 / B3 / C1 的功能主体、测试、门禁、文档口径与发版动作。

**仍保留、不得写成已通过的边界**（与 ROADMAP 第九章、QA 报告第九章一致）：

1. **FR-T1 仍是部分实现**：Rust `parser/*.rs` 与 `packages/shared/src/normalize.ts` 双份手写归一化根因未消除;按 ROADMAP 第四章 Won't 不重写。
2. **A2 的 100% 是标注集准确率**：29 例均为人工构造的脱敏序列，非真实生产分布（RK-V3 未消除）。
3. **A3 无真实大会话 P95 实测值**：`<500ms` 仍是估算预算，采集与门槛断言就绪，不宣称性能达标。
4. **「体检标记有用率 ≥70%」仍不可测**：缺「用户确认有用」反馈入口，本版只交付标记能力与本地事件底座。
5. **C2 / C3 待排期**；dsh `parent_uuid` 上游未就绪，折叠降级仍在。

## 十五、合规声明

本方案为产品设计参考，具体实施请结合公司合规与法务要求确认；涉及个人信息一律脱敏，
仅输出脱敏示例；产品坚持本地优先、零上传，所有数值目标均标注估算、待真实数据校正。
