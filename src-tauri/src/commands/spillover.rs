//! 工具溢出文件读取

use std::path::Path;

use crate::error::{AppError, AppResult};
use crate::fs::paths;
use crate::model::SpilloverFile;
use crate::AppState;
use std::sync::Arc;
use tauri::State;

/// 读取工具结果溢出文件
#[tauri::command]
pub async fn get_tool_result_file(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<SpilloverFile> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(AppError::NotFound(path));
    }
    // 必须在 ~/.claude/projects/ 下
    paths::assert_within_lexical(&state.paths.claude.projects_dir, p)?;

    let meta = std::fs::metadata(p)?;
    // 限制最大 50MB,避免 OOM
    if meta.len() > 50 * 1024 * 1024 {
        return Err(AppError::Invalid("工具溢出文件过大 (>50MB)".into()));
    }
    let content = std::fs::read_to_string(p)?;
    Ok(SpilloverFile {
        path: p.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        content,
    })
}
