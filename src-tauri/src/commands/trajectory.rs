//! OpenClaw trajectory 文件读取
//!
//! - 路径解析: 优先读 `<sessionId>.trajectory-path.json` 拿 `runtimeFile`,
//!   fallback 到同目录 `<sessionId>.trajectory.jsonl`
//! - 大小限制: 50 MiB (对齐 spillover.rs 和 openclaw 端 TRAJECTORY_RUNTIME_FILE_MAX_BYTES)
//! - 路径安全: 主 session 路径走 assert_within_any_root;
//!   trajectory-path.json 的 runtimeFile 是绝对路径,豁免(由 openclaw 用 O_NOFOLLOW 写入可信)

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, State};
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};
use crate::fs::paths;
use crate::parser::jsonl;
use crate::parser::trajectory::{normalize_event, TrajectoryEvent};
use crate::AppState;

const MAX_TRAJECTORY_BYTES: u64 = 50 * 1024 * 1024; // 50 MiB

/// 给定主 session jsonl 路径,解析对应的 trajectory 文件路径。
/// 优先读 `<sessionId>.trajectory-path.json` (指向真实路径,可分散到 OPENCLAW_TRAJECTORY_DIR),
/// fallback 到同目录 `<sessionId>.trajectory.jsonl`。
fn resolve_trajectory_path(session_path: &Path) -> AppResult<PathBuf> {
    let stem = session_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Invalid("无法解析 session id".into()))?;
    let dir = session_path
        .parent()
        .ok_or_else(|| AppError::Invalid("session 路径无父目录".into()))?;

    // 1) 优先指针文件
    let pointer_path = dir.join(format!("{}.trajectory-path.json", stem));
    if pointer_path.exists() {
        let text = std::fs::read_to_string(&pointer_path).map_err(AppError::Io)?;
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::Invalid(format!("指针文件 JSON 损坏: {}", e)))?;
        if let Some(runtime_file) = value.get("runtimeFile").and_then(|v| v.as_str()) {
            let p = PathBuf::from(runtime_file);
            if p.exists() {
                return Ok(p);
            }
            log::warn!("指针文件指向不存在的路径: {:?}", p);
        }
    }

    // 2) fallback 同目录
    let default = dir.join(format!("{}.trajectory.jsonl", stem));
    Ok(default)
}

/// 列出 session 的 trajectory 文件信息(元数据,无实际内容)
#[tauri::command]
pub async fn get_trajectory_info(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<TrajectoryInfo> {
    let session_path = PathBuf::from(&path);
    if !session_path.exists() {
        return Err(AppError::NotFound(path.clone()));
    }
    // 主 session 路径走 root 检查
    paths::assert_within_any_root(&state.paths.read(), &session_path)?;

    let trajectory_path = resolve_trajectory_path(&session_path)?;
    if !trajectory_path.exists() {
        return Ok(TrajectoryInfo {
            exists: false,
            path: Some(trajectory_path.to_string_lossy().to_string()),
            size_bytes: None,
            line_count: None,
        });
    }

    let meta = std::fs::metadata(&trajectory_path)?;
    let size_bytes = meta.len();
    let line_count = jsonl::count_lines(&trajectory_path).ok();

    Ok(TrajectoryInfo {
        exists: true,
        path: Some(trajectory_path.to_string_lossy().to_string()),
        size_bytes: Some(size_bytes),
        line_count,
    })
}

/// 流式读取 trajectory 事件
#[tauri::command]
pub async fn stream_trajectory(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    let session_path = PathBuf::from(&path);
    if !session_path.exists() {
        return Err(AppError::NotFound(path.clone()));
    }
    paths::assert_within_any_root(&state.paths.read(), &session_path)?;

    let trajectory_path = resolve_trajectory_path(&session_path)?;
    if !trajectory_path.exists() {
        return Err(AppError::NotFound(format!(
            "无 trajectory 文件: {}",
            trajectory_path.display()
        )));
    }

    // 大小限制
    let meta = std::fs::metadata(&trajectory_path)?;
    if meta.len() > MAX_TRAJECTORY_BYTES {
        return Err(AppError::Invalid(format!(
            "trajectory 文件过大 (>50MiB): {} 字节",
            meta.len()
        )));
    }

    // 路径安全: trajectory 真实路径(可能不在 root 下)
    // 仅记录警告,不阻断(openclaw 端 O_NOFOLLOW 写入可信)
    if paths::assert_within_any_root(&state.paths.read(), &trajectory_path).is_err() {
        log::warn!(
            "trajectory 真实路径不在已知 root 下(豁免): {:?}",
            trajectory_path
        );
    }

    let path_for_log = trajectory_path.to_string_lossy().to_string();
    let (tx, mut rx) = mpsc::channel::<TrajectoryBatch>(64);

    tauri::async_runtime::spawn_blocking(move || {
        let _ = jsonl::stream_batches(&trajectory_path, 200, |batch| {
            let events: Vec<TrajectoryEvent> = batch
                .records
                .iter()
                .filter_map(|v| {
                    // 用 record 数组里的位置作为 seq (1-based)
                    normalize_event(0, v)
                })
                .collect();
            let _ = tx.blocking_send(TrajectoryBatch {
                start_index: batch.start_index,
                events,
            });
        })
        .map_err(|e| log::error!("stream_trajectory 失败 ({}): {}", path_for_log, e));
    });

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(batch) = rx.recv().await {
            let _ = app_clone.emit("trajectory-batch", &batch);
        }
        let _ = app_clone.emit("trajectory-done", &serde_json::json!({}));
    });

    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryInfo {
    pub exists: bool,
    /// 解析到的路径(无论是否存在)
    pub path: Option<String>,
    pub size_bytes: Option<u64>,
    pub line_count: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrajectoryBatch {
    pub start_index: usize,
    pub events: Vec<TrajectoryEvent>,
}
