//! 转录流式读取

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, State};
use tokio::sync::mpsc;

use crate::error::AppResult;
use crate::fs::source::source_from_path;
use crate::parser::claude::{normalize, NormalizedBlock, NormalizedMessage, TokenUsageOut};
use crate::parser::jsonl;
use crate::parser::kimi::normalize_session as normalize_kimi_session;
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

    let path_for_log = path.clone();

    // v0.8.14 item D: 跟踪 stream_batches 的错误,通过 done 事件的
    // `error` 字段传给前端。之前 spawn_blocking 用 `let _ = ...` 吞掉
    // error,前端只看到 `transcript-done` 不带任何错误信息,误以为成功。
    // v0.9.0: source_from_path 单点推断 — 三源 claude/openclaw/kimi 各自走自己
    // 的 normalize。kimi 走单条 fallback,完整 collapse 在 export/analyze 里跑
    // normalize_session(若未来加)。
    let src = source_from_path(&path);
    let (tx, mut rx) = mpsc::channel::<StreamBatch>(64);
    let (err_tx, mut err_rx) = mpsc::channel::<String>(4);

    tauri::async_runtime::spawn_blocking(move || {
        // v0.9.8: kimi wire.jsonl 是事件流,无法 streaming collapse (state machine 必须
        // 看完 step.begin → step.end 才 flush),且 collapse 后 ~50 messages 取代
        // ~1000 events。改成 batch load 全读后跑 normalize_session,emit collapsed
        // StreamBatch(es)。claude/openclaw 保持 stream_batches line-by-line (它们的
        // jsonl 已经是 message 流,1 行 = 1 NormalizedMessage)。
        if src == "kimi" {
            let result: Result<(), String> = (|| {
                // 1) 一次性读完所有 records
                let mut records: Vec<serde_json::Value> = Vec::new();
                jsonl::for_each_line(&p, |_idx, _byte, v| {
                    records.push(v.clone());
                })
                .map_err(|e| e.to_string())?;
                // 2) 跑 normalize_session state machine → collapsed NormalizedMessage
                let messages = normalize_kimi_session(records);
                // 3) 按 200 条一组分包,避免单 batch payload 太大
                const SUB_BATCH: usize = 200;
                let mut global_idx: usize = 0;
                for chunk in messages.chunks(SUB_BATCH) {
                    let entries: Vec<TranscriptEntryOut> = chunk
                        .iter()
                        .map(|norm| TranscriptEntryOut {
                            index: global_idx,
                            byte_offset: 0,
                            raw: serde_json::Value::Null, // collapsed 后无对应 raw
                            normalized: norm.clone(),
                        })
                        .collect();
                    let start = global_idx;
                    global_idx += entries.len();
                    let _ = tx.blocking_send(StreamBatch {
                        start_index: start,
                        entries,
                    });
                }
                Ok(())
            })();
            if let Err(e) = result {
                log::error!("kimi batch transcript 失败 ({}): {}", path_for_log, e);
                let _ = err_tx.blocking_send(e);
            }
        } else if let Err(e) = jsonl::stream_batches(&p, 500, |batch| {
            let entries: Vec<TranscriptEntryOut> = batch
                .records
                .iter()
                .enumerate()
                .filter_map(|(i, v)| {
                    let idx = batch.start_index + i;
                    let norm = match src {
                        "openclaw" => normalize_entry(v, idx),
                        _ => normalize(v, idx),
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
        }) {
            log::error!("stream_transcript 失败 ({}): {}", path_for_log, e);
            let _ = err_tx.blocking_send(e.to_string());
        }
    });

    // 把 batch 通过 event 推送到前端 + done 事件带 error 字段
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stream_error: Option<String> = None;
        while let Some(batch) = rx.recv().await {
            let _ = app_clone.emit("transcript-batch", &batch);
        }
        // drain error channel(可能有 0/1 个)
        if let Some(msg) = err_rx.recv().await {
            stream_error = Some(msg);
        }
        let _ = app_clone.emit(
            "transcript-done",
            &serde_json::json!({ "error": stream_error }),
        );
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
