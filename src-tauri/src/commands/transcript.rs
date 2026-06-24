//! 转录流式读取

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, State};
use tokio::sync::mpsc;

use crate::error::AppResult;
use crate::parser::claude::{normalize, NormalizedBlock, NormalizedMessage, TokenUsageOut};
use crate::parser::jsonl;
use crate::parser::openclaw::normalize_entry;
use crate::AppState;

/// 计数 JSONL 记录数
#[tauri::command]
pub async fn count_entries(path: String) -> AppResult<u64> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(0);
    }
    jsonl::count_lines(p)
}

/// 流式读取转录(按 batch emit)
#[tauri::command]
pub async fn stream_transcript(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(crate::error::AppError::NotFound(path.clone()));
    }

    // 路径安全:遍历所有 root 验证(支持 custom_root)
    crate::fs::paths::assert_within_any_root(&state.paths.read(), &p)?;

    let is_openclaw = path.contains(".openclaw");
    let path_for_log = path.clone();

    // 启动一个 blocking task 流式读取
    let (tx, mut rx) = mpsc::channel::<StreamBatch>(64);

    tauri::async_runtime::spawn_blocking(move || {
        let _ = jsonl::stream_batches(&p, 500, |batch| {
            let entries: Vec<TranscriptEntryOut> = batch
                .records
                .iter()
                .enumerate()
                .filter_map(|(i, v)| {
                    let idx = batch.start_index + i;
                    let norm = if is_openclaw {
                        normalize_entry(v, idx)
                    } else {
                        normalize(v, idx)
                    }?;
                    Some(TranscriptEntryOut {
                        index: idx,
                        byte_offset: batch.start_byte,
                        raw: v.clone(),
                        normalized: norm,
                    })
                })
                .collect();
            let _ = tx.blocking_send(StreamBatch {
                start_index: batch.start_index,
                entries,
            });
        })
        .map_err(|e| log::error!("stream_transcript 失败 ({}): {}", path_for_log, e));
    });

    // 把 batch 通过 event 推送到前端
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(batch) = rx.recv().await {
            let _ = app_clone.emit("transcript-batch", &batch);
        }
        let _ = app_clone.emit("transcript-done", &serde_json::json!({}));
    });

    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamBatch {
    pub start_index: usize,
    pub entries: Vec<TranscriptEntryOut>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntryOut {
    pub index: usize,
    pub byte_offset: u64,
    pub raw: serde_json::Value,
    pub normalized: NormalizedMessage,
}

// 保留导入,避免 unused warning
#[allow(dead_code)]
fn _ensure_blocks_compile(_b: &NormalizedBlock) {}
#[allow(dead_code)]
fn _ensure_token_compile(_t: &TokenUsageOut) {}
