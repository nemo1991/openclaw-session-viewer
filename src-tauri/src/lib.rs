//! OpenClaw Session Viewer - Tauri 后端入口
//!
//! 模块组织:
//! - `error`      — 统一错误类型,可序列化到前端
//! - `fs`         — 路径解析、目录遍历
//! - `cache`      — mtime 缓存
//! - `db`         — v0.8.0 SQLite 关系型数据库(observer.db)
//! - `parser`     — JSONL 流式解析 + 记录归一化
//! - `commands`   — Tauri 命令
//! - `llm`        — Anthropic API 客户端

use std::sync::Arc;

use tauri::Manager;
use tokio::sync::Notify;

mod cache;
mod commands;
mod db;
mod error;
mod fs;
mod llm;
mod model;
mod parser;

use error::{AppError, AppResult};
use fs::paths::AppPaths;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::commands::settings::AppSettings;

/// 全局应用状态
///
/// v0.2.5: `paths` 和 `settings` 用 `RwLock` 包裹,以支持 save_settings 时
/// 热重载路径(无需重启 App)。锁粒度要小,只 wrap 路径访问,不要 wrap IO。
pub struct AppState {
    /// 用户的 home 目录(常量,启动时确定)
    pub app_home: PathBuf,
    /// 当前生效的 AppPaths(default + 所有 custom_roots)
    pub paths: RwLock<AppPaths>,
    /// 当前生效的 AppSettings(供 get_settings 立即返回最新值)
    pub settings: RwLock<AppSettings>,
    /// mtime 缓存
    pub session_meta_cache: cache::mtime::MetaCache,
    /// 全局 AbortController: 分析中止信号
    pub analyze_aborts: RwLock<HashMap<String, Arc<parking_lot::Mutex<bool>>>>,
    // --- v0.8.0: SQLite 关系型数据库 ---
    /// observer.db 连接池
    pub db: db::DbPool,
    /// settings 变更通知(save_settings 末尾 notify_one)→ sync_loop 重新跑
    pub paths_change: Arc<Notify>,
    /// 手动刷新通知(前端 refresh_sessions 命令调用)→ sync_loop 重新跑
    pub refresh_requested: Arc<Notify>,
}

impl AppState {
    pub fn new(
        app_home: PathBuf,
        app_config_dir: PathBuf,
        paths: AppPaths,
        settings: AppSettings,
    ) -> AppResult<Self> {
        let db = db::open(&app_config_dir)?;
        Ok(Self {
            app_home,
            paths: RwLock::new(paths),
            settings: RwLock::new(settings),
            session_meta_cache: cache::mtime::MetaCache::new(),
            analyze_aborts: RwLock::new(HashMap::new()),
            db,
            paths_change: Arc::new(Notify::new()),
            refresh_requested: Arc::new(Notify::new()),
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化 logger
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    // 自定义 panic hook: 只 log,不 abort。
    // 之前默认行为是 panic → abort 整个 Tauri 进程,任何 search/parse
    // 单条记录出问题都会让用户重启 App。改为: log + 继续运行。
    std::panic::set_hook(Box::new(|info| {
        // 取 location,尽力还原 panic 在哪个文件/行
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown>".to_string());
        log::error!(
            "RUST PANIC at {}: {} (search/analyze 中单条记录异常不会终止 App)",
            loc,
            info.payload()
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "<non-string panic>".to_string())
        );
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // 解析路径
            let home = dirs::home_dir().ok_or(error::AppError::NoHomeDir)?;
            let app_config_dir = app
                .path()
                .app_config_dir()
                .map_err(|e| AppError::Other(e.to_string()))?;

            // 启动时读 settings(custom_roots 需要)
            // 用与 get_settings 一样的逻辑,但不通过 Tauri command(避免循环依赖)
            let settings = load_settings_on_startup(app.handle())?;
            let runtime_roots = commands::settings::to_runtime_custom_roots(&settings.custom_roots);
            let paths = AppPaths::new(home.clone(), &runtime_roots);

            log::info!(
                "应用启动: claude_home={}, openclaw_home={:?}, custom_roots={}, db={:?}",
                paths
                    .default_root
                    .claude
                    .as_ref()
                    .map(|c| c.home.display().to_string())
                    .unwrap_or_else(|| "(none)".into()),
                paths
                    .default_root
                    .openclaw
                    .as_ref()
                    .map(|o| o.home.display().to_string()),
                paths.custom_roots.len(),
                app_config_dir.join("observer.db")
            );

            let state = AppState::new(home, app_config_dir, paths, settings)?;
            let state_arc = Arc::new(state);

            // v0.8.0: spawn 后台同步循环 — 永不返回
            let sync_state = Arc::clone(&state_arc);
            let sync_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                db::sync::run_sync_loop(sync_state, sync_app).await;
            });

            app.manage(state_arc);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::get_session_meta,
            commands::sessions::refresh_sessions,
            commands::transcript::count_entries,
            commands::transcript::stream_transcript,
            commands::subagents::list_subagents,
            commands::subagents::get_subagent_summary,
            commands::spillover::get_tool_result_file,
            commands::trajectory::get_trajectory_info,
            commands::trajectory::stream_trajectory,
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
            // v0.8.0
            commands::overrides::rename_session,
            commands::overrides::hide_session,
            commands::overrides::set_pinned,
            commands::overrides::set_archived,
            commands::overrides::set_notes,
            commands::overrides::remove_rename, // v0.8.1: 撤销 DB rename
            commands::overrides::list_overrides,
            commands::overrides::list_tags,
            commands::overrides::create_tag,
            commands::overrides::delete_tag,
            commands::overrides::set_session_tags,
            commands::overrides::add_session_link,
            commands::overrides::remove_session_link,
            commands::overrides::list_session_links,
            commands::overrides::get_sync_status,
            commands::overrides::get_db_path, // v0.8.4 item 1
            commands::overrides::rebuild_db,
            commands::overrides::export_overrides,
            commands::overrides::import_overrides,
            commands::overrides::record_search,
            commands::overrides::list_search_history,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}

/// 启动时读 settings.json(直接文件 IO,不走 Tauri command 路径)
fn load_settings_on_startup(app: &tauri::AppHandle) -> AppResult<AppSettings> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    let p = dir.join("settings.json");
    if !p.exists() {
        return Ok(AppSettings::default());
    }
    let text = std::fs::read_to_string(&p).map_err(AppError::Io)?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}
