//! v0.10 (Epic 1 / FR-T4): 归一化契约测试 —— Rust 侧快照生成器。
//!
//! 与 `packages/shared/src/contract.test.ts` 共用同一份脱敏样本
//! (`packages/shared/src/__fixtures__/contract-samples.json`)。
//!
//! 运行（CI / 本地）：
//! ```bash
//! cargo test --lib parser::contract::tests::export_normalize_contract_snapshot
//! ```
//! 会把 Rust 归一化结果投影成 PRD FR-T4 要求的 4 类关键字段
//! (`role` / `blockKinds` / `tokenUsage` / `hasError`)，写入
//! `packages/shared/src/generated/normalize-contract-rust.json`（纳入版本控制）。
//! 随后 `pnpm --filter @ocsv/shared test` 中的契约测试会逐样本逐字段对照，
//! 任一字段不一致即 FAIL 并打印差异字段。
//!
//! 为什么只投影这 4 类字段：`id` / `rawType` / `label` 等字段两侧本就有
//! 合理的实现差异（Rust 用 uuid、TS 用 idx-N；meta label 前缀不同），
//! 全量对象比对会产生噪声。FR-T4 明确只锁定 role / block 类型 / token / error 标记。

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use std::path::PathBuf;

    use super::super::claude;
    use super::super::dsh;
    use super::super::kimi;
    use super::super::openclaw;

    /// 从 src-tauri/Cargo.toml 所在目录解析工作区内相对路径。
    fn workspace_path(rel: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    /// 把一条归一化消息投影成契约关心的关键字段。
    /// `None`（该 wire event 被跳过）投影成 `normalized: false`。
    fn project(msg: Option<claude::NormalizedMessage>) -> Value {
        let Some(msg) = msg else {
            return json!({
                "normalized": false,
                "role": null,
                "blockKinds": [],
                "tokenUsage": null,
                "hasError": false,
            });
        };

        let block_kinds: Vec<&str> = msg.blocks.iter().map(|b| b.kind.as_str()).collect();

        // error 标记：message 级 stop_reason == "error"，或任一 tool_result block 的 is_error
        let has_error = msg.stop_reason.as_deref() == Some("error")
            || msg
                .blocks
                .iter()
                .any(|b| b.data.get("is_error").and_then(|v| v.as_bool()) == Some(true));

        let token_usage = msg.token_usage.as_ref().map(|t| {
            json!({
                "input": t.input,
                "output": t.output,
                "cacheRead": t.cache_read,
                "cacheWrite": t.cache_write,
            })
        });

        json!({
            "normalized": true,
            "role": msg.role,
            "blockKinds": block_kinds,
            "tokenUsage": token_usage,
            "hasError": has_error,
        })
    }

    fn normalize_sample(
        source: &str,
        record: &Value,
        index: usize,
    ) -> Option<claude::NormalizedMessage> {
        match source {
            "claude" => claude::normalize(record, index),
            "openclaw" => openclaw::normalize_entry(record, index),
            "kimi" => kimi::normalize_kimi_record(record, index),
            "dsh" => dsh::normalize_dsh_record(record, index),
            other => panic!("契约样本出现未知 source: {other}"),
        }
    }

    #[test]
    fn export_normalize_contract_snapshot() {
        let samples_path = workspace_path("packages/shared/src/__fixtures__/contract-samples.json");
        let raw = std::fs::read_to_string(&samples_path)
            .unwrap_or_else(|e| panic!("读取契约样本失败 {:?}: {e}", samples_path));
        let doc: Value = serde_json::from_str(&raw).expect("契约样本 JSON 解析失败");
        let samples = doc["samples"].as_array().expect("samples 必须是数组");

        let mut cases: Vec<Value> = Vec::new();
        for s in samples {
            let id = s["id"].as_str().expect("sample.id");
            let source = s["source"].as_str().expect("sample.source");
            let index = s["index"].as_u64().expect("sample.index") as usize;
            let record = &s["record"];

            let mut case = project(normalize_sample(source, record, index));
            case["id"] = json!(id);
            case["source"] = json!(source);
            case["index"] = json!(index);
            cases.push(case);
        }

        // 4 种 source 全覆盖断言 —— 样本集若被误删 source，这里直接 FAIL
        let mut sources: Vec<&str> = samples
            .iter()
            .filter_map(|s| s["source"].as_str())
            .collect();
        sources.sort_unstable();
        sources.dedup();
        assert_eq!(
            sources,
            vec!["claude", "dsh", "kimi", "openclaw"],
            "契约样本必须覆盖全部 4 种 source"
        );

        let snapshot = json!({
            "version": 1,
            "generator": "cargo test --lib parser::contract::tests::export_normalize_contract_snapshot",
            "source": "rust",
            "note": "由 Rust parser 归一化投影生成，请勿手工编辑。TS 侧契约测试以此为准。",
            "cases": cases,
        });

        let out_path = workspace_path("packages/shared/src/generated/normalize-contract-rust.json");
        let text = serde_json::to_string_pretty(&snapshot).expect("快照序列化失败");
        std::fs::write(&out_path, format!("{text}\n"))
            .unwrap_or_else(|e| panic!("写入契约快照失败 {:?}: {e}", out_path));

        assert!(!cases.is_empty(), "契约快照不能为空");
    }
}
