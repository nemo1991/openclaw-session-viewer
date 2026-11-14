//! v0.10 (Epic 1 / FR-T1 + FR-T2): 受控的 ts-rs 类型生成入口。
//!
//! Rust 归一化结构体（`NormalizedMessage` / `NormalizedBlock` / `TokenUsageOut` /
//! `SubagentSummary`）即 TS 类型唯一事实源。运行以下命令把它们导出为
//! `packages/shared/src/generated/normalize-types.ts`：
//!
//! ```bash
//! cargo test --lib parser::codegen::tests::export_normalize_types
//! ```
//!
//! `export_all_to()` 会写出该类型及其所有 `#[ts(export)]` 依赖到各自的 `export_to`。
//!
//! v0.10 (FR-T2) CI 门禁:本测试用 `export_all_to()` 直接把产物写到
//! `packages/shared/src/generated/`(不依赖外部 env),所以 `cargo test --lib`
//! 一条命令即可刷新 shared 侧类型。CI 在该步骤后用 `git diff --exit-code`
//! 检查该目录,产物与源码不一致即阻断合并,强制以 Rust 为唯一事实源。
#![allow(dead_code)]
use ts_rs::TS;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SubagentSummary;
    use crate::parser::claude::{NormalizedBlock, NormalizedMessage, TokenUsageOut};
    use std::path::PathBuf;

    #[test]
    fn export_normalize_types() {
        let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("packages/shared/src/generated");
        // export_all_to 忽略 TS_RS_EXPORT_DIR,直接写到指定目录。
        // #[ts(export)] 自动生成的测试仍会写 ./bindings(构建产物,已 gitignore),
        // 但受控产物一定落在这里。
        std::fs::create_dir_all(&out_dir).expect("创建 generated 目录失败");
        NormalizedMessage::export_all_to(&out_dir).expect("failed to export NormalizedMessage");
        SubagentSummary::export_all_to(&out_dir).expect("failed to export SubagentSummary");
        // 触达其余类型,确保它们都正确注册到全局导出表。
        let _ = (NormalizedBlock::name(), TokenUsageOut::name());

        let generated = out_dir.join("normalize-types.ts");
        assert!(
            generated.exists(),
            "ts-rs 未写出 {:?};检查 #[ts(export_to)] 与 out_dir",
            generated
        );
    }
}
