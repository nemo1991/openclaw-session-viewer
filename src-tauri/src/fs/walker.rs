//! 目录遍历

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::error::AppResult;

/// 列举目录下所有 .jsonl 文件(递归)
///
/// **过滤**:
/// - 跳过 `<sessionId>.trajectory.jsonl` 这类 openclaw 观测/追踪文件
///   — 不是真正的用户会话,只是同目录的 trace 输出。
///   (注意:`Path::extension()` 只返回最后一段,`a.trajectory.jsonl`
///   的 extension 仍是 `"jsonl"`,所以必须看 `file_stem()` 末尾
///   是否是 `.trajectory` / `.traces` 等。)
pub fn list_jsonl_files(dir: &Path) -> AppResult<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(vec![]);
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
            // 排除观测/trace 副产物(OpenClaw 会在每个 session 旁
            // 写 `<id>.trajectory.jsonl`,应当被忽略)
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
    Ok(out)
}

/// 列举目录下所有 .json 文件(非递归,一层)
#[allow(dead_code)]
pub fn list_json_files_shallow(dir: &Path) -> AppResult<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_file() && p.extension().map(|e| e == "json").unwrap_or(false) {
            out.push(p);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"{}").unwrap();
        p
    }

    #[test]
    fn list_jsonl_skips_trajectory_observability_files() {
        let tmp = std::env::temp_dir().join(format!("ocsv-walker-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // 真正的会话文件(应保留)
        make(&tmp, "883031bd-0634-4ce1-9756-bc2d9d9b1b3e.jsonl");
        // openclaw 观测/trace 副产物(应被排除)
        make(
            &tmp,
            "883031bd-0634-4ce1-9756-bc2d9d9b1b3e.trajectory.jsonl",
        );
        make(
            &tmp,
            "883031bd-0634-4ce1-9756-bc2d9d9b1b3e.trajectory-path.json",
        );
        // 子代理的 agent-*.jsonl(应保留 — Claude Code 风格)
        make(&tmp, "agent-abc.jsonl");

        let mut files = list_jsonl_files(&tmp).unwrap();
        files.sort();

        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert!(
            names
                .iter()
                .any(|n| n.ends_with(".jsonl") && !n.contains(".trajectory")),
            "real session jsonl should be kept, got: {:?}",
            names
        );
        assert!(
            !names.iter().any(|n| n.contains(".trajectory")),
            "trajectory file should be excluded, got: {:?}",
            names
        );
        assert!(
            names.iter().any(|n| n.starts_with("agent-")),
            "agent-*.jsonl (subagent) should be kept, got: {:?}",
            names
        );

        fs::remove_dir_all(&tmp).ok();
    }
}
