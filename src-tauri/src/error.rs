//! 统一错误类型 — 可序列化到前端 (Tauri command 失败时返回此)

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("无 HOME 目录")]
    NoHomeDir,

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 解析错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("路径安全检查失败: {0}")]
    PathSecurity(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("无效输入: {0}")]
    Invalid(String),

    #[error("LLM 调用错误: {0}")]
    Llm(String),

    #[error("网络错误: {0}")]
    Http(String),

    #[error("配置错误: {0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

pub type AppResult<T> = Result<T, AppError>;

/// 序列化为前端可用的错误对象
#[derive(Serialize)]
pub struct AppErrorPayload {
    pub kind: String,
    pub message: String,
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            AppError::NoHomeDir => "NoHomeDir",
            AppError::Io(_) => "Io",
            AppError::Json(_) => "Json",
            AppError::PathSecurity(_) => "PathSecurity",
            AppError::NotFound(_) => "NotFound",
            AppError::Invalid(_) => "Invalid",
            AppError::Llm(_) => "Llm",
            AppError::Http(_) => "Http",
            AppError::Config(_) => "Config",
            AppError::Other(_) => "Other",
        };
        AppErrorPayload {
            kind: kind.to_string(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Other(e.to_string())
    }
}
