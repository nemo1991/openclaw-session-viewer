//! 目录遍历

use std::path::{Path, PathBuf};

use walkdir::WalkDir;

use crate::error::AppResult;

/// 列举目录下所有 .jsonl 文件(递归)
pub fn list_jsonl_files(dir: &Path) -> AppResult<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).max_depth(4).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_file() && p.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(p.to_path_buf());
        }
    }
    Ok(out)
}

/// 列举目录下所有 .json 文件(非递归,一层)
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
