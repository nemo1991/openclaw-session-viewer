//! 实时 PID 状态

use std::sync::Arc;

use tauri::State;

use crate::commands::sessions::read_live_pids_meta;
use crate::error::AppResult;
use crate::model::LivePidMeta;
use crate::AppState;

/// 列出所有运行中的 CLI 进程
#[tauri::command]
pub async fn list_live_pids(state: State<'_, Arc<AppState>>) -> AppResult<Vec<LivePidMeta>> {
    read_live_pids_meta(&state.paths.claude.sessions_dir)
}
