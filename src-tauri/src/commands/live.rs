//! 实时 PID 状态

use std::sync::Arc;

use tauri::State;

use crate::commands::sessions::read_live_pids_meta;
use crate::error::AppResult;
use crate::model::LivePidMeta;
use crate::AppState;

/// 列出所有运行中的 CLI 进程
///
/// live_pid 机制只来自 default `~/.claude/sessions/<pid>.json`(openclaw 没有这个)
#[tauri::command]
pub async fn list_live_pids(state: State<'_, Arc<AppState>>) -> AppResult<Vec<LivePidMeta>> {
    let dir = state
        .paths
        .read()
        .default_root
        .claude
        .as_ref()
        .map(|c| c.sessions_dir.clone());
    match dir {
        Some(d) => read_live_pids_meta(&d),
        None => Ok(vec![]),
    }
}
