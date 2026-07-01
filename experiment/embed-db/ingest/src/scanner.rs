//! 目录扫描:复刻 main `src-tauri/src/fs/walker.rs::list_jsonl_files` 的语义
//!
//! 完全独立,不依赖 main 内部 crate,避免 rebase 时跨 crate 冲突。

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 列举目录下所有 .jsonl 文件(递归 max_depth=4)
///
/// 跳过 `<stem>.trajectory.jsonl` / `<stem>.traces.*` / `<stem>.trajectory-path.json`
/// 这些是 OpenClaw 的观测/追踪副产物,不是真正的 session。
pub fn list_jsonl_files(dir: &Path) -> Vec<PathBuf> {
    if !dir.exists() {
        return vec![];
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().map(|e| e == "jsonl").unwrap_or(false) {
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if stem.ends_with(".trajectory")
                    || stem.ends_with(".traces")
                    || stem.ends_with(".trajectory-path")
                {
                    continue;
                }
            }
            out.push(p.to_path_buf());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write(p: &Path, content: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    #[test]
    fn ignores_trajectory_files() {
        let dir = tempdir().unwrap();
        write(&dir.path().join("a.jsonl"), "x");
        write(&dir.path().join("b.jsonl"), "x");
        write(&dir.path().join("a.trajectory.jsonl"), "skip-me");
        write(&dir.path().join("c.json"), "not-jsonl");
        let files = list_jsonl_files(dir.path());
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|p| p.extension().unwrap() == "jsonl"));
        assert!(!files
            .iter()
            .any(|p| p.file_name().unwrap().to_string_lossy().contains(".trajectory")));
    }

    #[test]
    fn missing_dir_returns_empty() {
        let files = list_jsonl_files(Path::new("/nonexistent/path/should/be/safe"));
        assert!(files.is_empty());
    }

    #[test]
    fn respects_max_depth() {
        let dir = tempdir().unwrap();
        // depth 5 应被截断
        let deep = dir.path().join("a/b/c/d/e/f.jsonl");
        write(&deep, "x");
        let files = list_jsonl_files(dir.path());
        assert!(files.is_empty(), "depth>4 应被忽略");
    }
}
