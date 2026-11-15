# A2 真实重试率评测报告（v0.11 收口）

> 日期：2026-11-14（2026-11-15 v0.11 收口复核：补齐 C1 的 3 个样本，26 → 29 例）
> 对应需求：`docs/ROADMAP_v0.11_Plan.md` A2 / C1、v0.10 PRD 2.3 节
> 性质：**人工构造的脱敏标注集上的算法准确率**，不是真实生产分布上的实测准确率

## 1. 口径

算法与 `src-tauri/src/parser/meta_aggregator.rs::RetryTracker` 一致：

1. 按 wire 出现顺序记录 tool 调用（id、工具名、是否失败）；
2. `tool_result.is_error` / kimi `step.end.finishReason=error` 按 id 回填失败标记；
3. `windows(2)` 判定「前一次调用失败 + 紧随其后同名工具再次调用」计 1 次重试；
4. `retry_rate = retry_count / tool_call_count`，分母为 0 时守卫为 0。

v0.11 (C1)：dsh 的 `assistant/message.content[].tool-call.id` 与
`tool/call.data.callId` 取值不同时，按「工具名 + wire 顺序」FIFO 配对建立 id 别名，
`tool/result.source.callId` 用第三种取值时再按最近一条同名未失败调用 best-effort 回填；
三种 id 都不一致也不会把一次逻辑调用算成两次。

评测**走真实聚合入口**（`aggregate_claude_openclaw` / `aggregate_kimi` / `aggregate_dsh`），
而不是直接调用私有 `RetryTracker`，因此 wire 解析链路一并被覆盖。

## 2. 复现

```bash
pnpm eval:retry
# 等价:cargo test --manifest-path src-tauri/Cargo.toml --lib \
#        parser::retry_eval::tests::eval_retry_rate_accuracy -- --nocapture
```

评测集：`src-tauri/src/parser/__fixtures__/retry-eval-set.json`（脱敏，人工标注，29 例）。
评测器：`src-tauri/src/parser/retry_eval.rs`，同时断言
① 准确率 ≥ 95%（PRD 门槛）、② 29/29 全部一致（回归基线锁）、
③ 覆盖 4 source 与 6 类边界、④ 评测集不含真实标识。

## 3. 实测结果

| 项         | 值                        |
| ---------- | ------------------------- |
| 样本数     | 29                        |
| 判定正确   | 29                        |
| **准确率** | **100.00%**（门槛 ≥ 95%） |
| 失败样本   | 0                         |

按 source 分布：claude 9 · openclaw 4 · kimi 7 · dsh 9（v0.11 新增 3 个 C1 样本均在 dsh）。

| 边界类型                                                                                                                              | 覆盖样本 | 期望行为                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `basic`                                                                                                                               | 3        | 失败后紧随同名调用 → 1 次重试                                        |
| `single-fail-no-retry`                                                                                                                | 3        | 仅单次失败 → 0 次                                                    |
| `different-tool`                                                                                                                      | 3        | 失败后紧随不同名工具 → 0 次                                          |
| `zero-denominator`                                                                                                                    | 3        | 无 tool 调用 → 0/0，重试率守卫为 0                                   |
| `dedup`                                                                                                                               | 5        | 同 id 重复声明 / 双 envelope / C1 三种 id 取值不一致 → 只计 1 次调用 |
| `retry-chain`                                                                                                                         | 2        | 连续失败连续重试 → 2 次                                              |
| 其它（`interleaved` / `late-results` / `missing-id` / `meta-between` / `mixed` / `step-error` / `success-chain` / `independent-ids`） | 10       | 结果晚到、缺 id、夹文本消息、step 级 error、不同 id 独立调用等       |

逐样本 expected / actual 明细由 `pnpm eval:retry` 打印到 stdout（CI 日志可查）。

## 4. 已知边界与诚实声明

- **RK-V3 仍未消除**：29 例评测集全部是人工构造的脱敏序列，样本偏易可能让 100% 虚高。
  该数字只说明「实现与本标注集一致」，**不等价于真实会话分布上的准确率**；
  待有真实脱敏样本后需重建评测集并校正目标值。
- **C1 已补齐（v0.11，2026-11-15）**：`RetryTracker` 新增 `alias_id` /
  `mark_failed_by_name`，`aggregate_dsh` 用「工具名 + wire 顺序」FIFO 配对两种
  envelope 的不同 id。评测集新增 3 个样本：`part.id` ≠ `callId`、
  `source.callId` 用 `part.id`、三种 id 互不相同 —— 均实测 `1/2` 与标注一致。
  仍属 best-effort：wire 完全没有可用于配对的工具名时，失败结果会被忽略而不误标，
  不宣称覆盖所有未知 wire 变体。
- 门禁有效性已做注入验证：把任一标注值改错 → `pnpm eval:retry` 立即 FAIL 并打印差异行。
