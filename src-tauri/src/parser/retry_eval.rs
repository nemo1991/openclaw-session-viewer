//! v0.11 (A2): 真实重试率评测集与准确率断言
//!
//! v0.10 核验报告的缺口 G-2:PRD 写了「评测集上准确率 ≥ 95%」,但全仓没有
//! 评测集 / 人工标注 / 准确率验证物。本模块补上:
//! - `src/parser/__fixtures__/retry-eval-set.json`:脱敏人工标注样本,覆盖
//!   claude / openclaw / kimi / dsh 四种 source,以及单次失败无重试、分母 0、
//!   相邻不同名工具、重复 id、连续重试链、step 级 error、envelope 去重等边界。
//! - 评测**走真实聚合入口**(`aggregate_claude_openclaw` / `aggregate_kimi` /
//!   `aggregate_dsh`),而不是直接调 `RetryTracker` 私有方法,覆盖 wire 解析链路。
//! - 输出可复现报告(每个 case 的 expected / actual / 判定)+ 准确率断言。
//!
//! 复现:`pnpm eval:retry`(等价 `cargo test --lib parser::retry_eval -- --nocapture`)。
//! 本模块仅在 `#[cfg(test)]` 下编译,不影响生产二进制。

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashSet};
    use std::path::Path;

    use serde::Deserialize;
    use serde_json::Value;

    use crate::error::AppResult;
    use crate::parser::meta_aggregator::{
        aggregate_claude_openclaw, aggregate_dsh, aggregate_kimi,
    };

    const EVAL_SET_JSON: &str = include_str!("__fixtures__/retry-eval-set.json");
    /// v0.10 PRD 2.3 节的发布前验证门槛
    const ACCURACY_THRESHOLD: f64 = 0.95;

    #[derive(Debug, Deserialize)]
    struct EvalSet {
        version: u32,
        cases: Vec<EvalCase>,
    }

    #[derive(Debug, Deserialize)]
    struct EvalCase {
        id: String,
        source: String,
        label: String,
        edge: String,
        wire: Vec<Value>,
        expected: Expected,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        retry_count: u32,
        tool_call_count: u32,
    }

    fn load_set() -> EvalSet {
        let set: EvalSet =
            serde_json::from_str(EVAL_SET_JSON).expect("retry-eval-set.json 必须是合法 JSON");
        assert_eq!(set.version, 1, "评测集版本不匹配");
        set
    }

    /// 把 wire 写成临时 .jsonl,按 source 走真实聚合入口,返回 (retry, tool_calls)
    fn run_case(case: &EvalCase, dir: &Path) -> AppResult<(u32, u32)> {
        let path = dir.join(format!("{}.jsonl", case.id));
        let mut text = String::new();
        for line in &case.wire {
            text.push_str(&serde_json::to_string(line)?);
            text.push('\n');
        }
        std::fs::write(&path, text)?;
        let m = match case.source.as_str() {
            "claude" | "openclaw" => aggregate_claude_openclaw(&path)?,
            "kimi" => aggregate_kimi(&path)?,
            "dsh" => aggregate_dsh(&path)?,
            other => panic!("评测集出现未知 source: {other}"),
        };
        Ok((m.retry_count, m.tool_call_count))
    }

    #[test]
    fn eval_set_covers_all_sources_and_edge_cases() {
        let set = load_set();
        assert!(
            set.cases.len() >= 20,
            "评测集样本过少({}),准确率数字会虚高 (RK-V3)",
            set.cases.len()
        );

        let sources: BTreeSet<&str> = set.cases.iter().map(|c| c.source.as_str()).collect();
        let expected_sources: BTreeSet<&str> =
            ["claude", "openclaw", "kimi", "dsh"].into_iter().collect();
        assert_eq!(sources, expected_sources, "必须覆盖 4 种 source");

        for edge in [
            "basic",
            "single-fail-no-retry",
            "different-tool",
            "zero-denominator",
            "dedup",
            "retry-chain",
        ] {
            assert!(
                set.cases.iter().any(|c| c.edge == edge),
                "评测集缺少边界样本: {edge}"
            );
        }

        let mut ids = HashSet::new();
        for c in &set.cases {
            assert!(ids.insert(&c.id), "评测集 id 重复: {}", c.id);
            assert!(!c.label.is_empty(), "{} 缺少标注说明", c.id);
        }
    }

    #[test]
    fn eval_set_is_desensitized() {
        // 与 v0.9.30 隐私治理一致:评测集不得含真实路径 / 用户标识
        for banned in [
            "liushuyou",
            "forcetone",
            "6030344417",
            "keepn",
            "/Users/",
            "C:\\Users",
        ] {
            assert!(
                !EVAL_SET_JSON.contains(banned),
                "评测集含疑似真实标识: {banned}"
            );
        }
    }

    /// A2 主门禁:走真实聚合入口比对人工标注,准确率必须 ≥ 95%。
    #[test]
    fn eval_retry_rate_accuracy() {
        let set = load_set();
        let tmp = tempfile::tempdir().expect("create tempdir");
        let mut correct = 0usize;
        let mut rows: Vec<String> = Vec::new();

        for c in &set.cases {
            let (actual_retry, actual_calls) = run_case(c, tmp.path())
                .unwrap_or_else(|e| panic!("评测样本 {} 运行失败: {e}", c.id));
            let expected = (c.expected.retry_count, c.expected.tool_call_count);
            let ok = expected == (actual_retry, actual_calls);
            if ok {
                correct += 1;
            }
            rows.push(format!(
                "| {} | {} | {} | {}/{} | {}/{} | {} |",
                c.id,
                c.source,
                c.edge,
                c.expected.retry_count,
                c.expected.tool_call_count,
                actual_retry,
                actual_calls,
                if ok { "PASS" } else { "FAIL" }
            ));
        }

        let total = set.cases.len();
        let accuracy = correct as f64 / total as f64;
        println!("\n=== A2 真实重试率评测报告 (v0.11 收口) ===");
        println!("算法: RetryTracker(失败后紧随同名调用计 1 次重试 / 分母=tool 调用总数)");
        println!(
            "样本数: {total} · 正确: {correct} · 准确率: {:.2}% · 门槛: ≥ {:.0}%",
            accuracy * 100.0,
            ACCURACY_THRESHOLD * 100.0
        );
        println!("| case | source | edge | expected retry/calls | actual retry/calls | 结果 |");
        println!("| --- | --- | --- | --- | --- | --- |");
        for r in &rows {
            println!("{r}");
        }
        println!("=== 报告结束 ===\n");

        assert!(
            accuracy >= ACCURACY_THRESHOLD,
            "重试率准确率 {:.2}% 低于门槛 ≥{:.0}%\n{}",
            accuracy * 100.0,
            ACCURACY_THRESHOLD * 100.0,
            rows.join("\n")
        );
        // 除了 95% 发布门槛,还锁住「评测集当前 100% 通过」这条回归基线:
        // 算法后续任何改动导致哪怕 1 个标注样本不一致,也应该立刻暴露,
        // 而不是被 25/26 = 96% 这样的汇总数字掩盖。
        assert_eq!(
            correct,
            total,
            "评测集存在 {} 个标注不一致样本,逐样本明细见上方报告",
            total - correct
        );
    }
}
