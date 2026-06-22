//! OpenClaw Session Viewer - Tauri 后端入口
//!
//! 模块组织:
//! - `error`      — 统一错误类型,可序列化到前端
//! - `fs`         — 路径解析、目录遍历
//! - `cache`      — mtime 缓存
//! - `parser`     — JSONL 流式解析 + 记录归一化
//! - `commands`   — Tauri 命令
//! - `llm`        — Anthropic API 客户端

use std::sync::Arc;

use tauri::Manager;

mod error;
mod fs;
mod cache;
mod parser;
mod commands;
mod llm;
mod model;

use error::AppResult;
use fs::paths::AppPaths;
use parking_lot::RwLock;
use std::collections::HashMap;

/// 全局应用状态
pub struct AppState {
    pub paths: AppPaths,
    /// mtime 缓存
    pub session_meta_cache: cache::mtime::MetaCache,
    /// 全局 AbortController: 分析中止信号
    pub analyze_aborts: RwLock<HashMap<String, Arc<parking_lot::Mutex<bool>>>>,
}

impl AppState {
    pub fn new(paths: AppPaths) -> AppResult<Self> {
        Ok(Self {
            paths,
            session_meta_cache: cache::mtime::MetaCache::new(),
            analyze_aborts: RwLock::new(HashMap::new()),
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化 logger
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 解析路径
            let home = dirs::home_dir()
                .ok_or_else(|| error::AppError::NoHomeDir)?;
            let paths = AppPaths::new(home);

            log::info!(
                "应用启动: claude_home={}, openclaw_home={:?}",
                paths.claude.home.display(),
                paths.openclaw.as_ref().map(|o| o.home.display().to_string())
            );

            let state = AppState::new(paths)?;
            app.manage(Arc::new(state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::get_session_meta,
            commands::sessions::refresh_sessions,
            commands::transcript::count_entries,
            commands::transcript::stream_transcript,
            commands::subagents::list_subagents,
            commands::spillover::get_tool_result_file,
            commands::live::list_live_pids,
            commands::search::search_session,
            commands::search::search_all,
            commands::export::export_markdown,
            commands::export::export_html,
            commands::analyze::analyze_session,
            commands::analyze::cancel_analyze,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::fs_cmd::pick_export_dir,
            commands::fs_cmd::reveal_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
