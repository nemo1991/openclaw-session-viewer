//! Anthropic Messages API 客户端(流式 SSE)

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};

pub struct AnthropicRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<Value>,
}

#[derive(Serialize, Default, Clone)]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u32>,
}

/// 流式调用,返回 (delta_text, latest_usage) 的 channel
pub fn stream_anthropic(req: &AnthropicRequest) -> mpsc::Receiver<AppResult<(String, Usage)>> {
    let (tx, rx) = mpsc::channel::<AppResult<(String, Usage)>>(64);
    let req = req.clone_inner();

    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_stream(req, tx).await {
            log::error!("LLM stream error: {}", e);
        }
    });

    rx
}

async fn run_stream(
    req: AnthropicRequest,
    tx: mpsc::Sender<AppResult<(String, Usage)>>,
) -> AppResult<()> {
    let url = format!("{}/v1/messages", req.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "messages": req.messages,
    });

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let api_key_value =
        HeaderValue::from_str(&req.api_key).map_err(|e| AppError::Llm(e.to_string()))?;
    headers.insert(HeaderName::from_static("x-api-key"), api_key_value);
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static("2023-06-01"),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Http(e.to_string()))?;

    let res = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Http(e.to_string()))?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        let _ = tx
            .send(Err(AppError::Llm(format!("API 错误 {}: {}", status, text))))
            .await;
        return Ok(());
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut current_usage = Usage::default();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = tx.send(Err(AppError::Http(e.to_string()))).await;
                break;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(pos) = buffer.find("\n\n") {
            let event_str: String = buffer.drain(..pos + 2).collect();
            if let Some((event_type, data)) = parse_sse_event(&event_str) {
                match event_type.as_str() {
                    "content_block_delta" => {
                        if let Some(text) = data
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            if tx
                                .send(Ok((text.to_string(), current_usage.clone())))
                                .await
                                .is_err()
                            {
                                return Ok(());
                            }
                        }
                    }
                    "message_delta" => {
                        if let Some(usage) = data.get("usage") {
                            if let Some(out) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                                current_usage.output_tokens = Some(out as u32);
                            }
                        }
                    }
                    "message_start" => {
                        if let Some(msg) = data.get("message") {
                            if let Some(usage) = msg.get("usage") {
                                if let Some(inp) =
                                    usage.get("input_tokens").and_then(|v| v.as_u64())
                                {
                                    current_usage.input_tokens = Some(inp as u32);
                                }
                            }
                        }
                    }
                    "error" => {
                        let msg = data
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error")
                            .to_string();
                        let _ = tx.send(Err(AppError::Llm(msg))).await;
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

impl AnthropicRequest {
    fn clone_inner(&self) -> Self {
        Self {
            base_url: self.base_url.clone(),
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            messages: self.messages.clone(),
        }
    }
}

fn parse_sse_event(event_str: &str) -> Option<(String, Value)> {
    let mut event_type = "message".to_string();
    let mut data_str = String::new();
    for line in event_str.lines() {
        if let Some(rest) = line.strip_prefix("event: ") {
            event_type = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data: ") {
            data_str.push_str(rest.trim());
        }
    }
    if data_str.is_empty() {
        return None;
    }
    serde_json::from_str(&data_str)
        .ok()
        .map(|v| (event_type, v))
}
