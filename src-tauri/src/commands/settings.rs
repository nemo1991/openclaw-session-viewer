//! 应用设置 (Anthropic API Key、主题等)

use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::error::AppResult;
use crate::AppState;

#[derive(Deserialize, serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
}

#[derive(Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub anthropic: AnthropicConfig,
    pub theme: String,
    pub ui_language: String,
    pub default_export_dir: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            anthropic: AnthropicConfig {
                base_url: "https://api.anthropic.com".to_string(),
                api_key: String::new(),
                model: "claude-sonnet-4-6".to_string(),
                max_tokens: 4096,
            },
            theme: "dark".to_string(),
            ui_language: "zh-CN".to_string(),
            default_export_dir: None,
        }
    }
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// 读取设置
#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<AppSettings> {
    let p = settings_path(&app)?;
    if !p.exists() {
        return Ok(AppSettings::default());
    }
    let text = std::fs::read_to_string(&p)?;
    let s: AppSettings = serde_json::from_str(&text).unwrap_or_default();
    Ok(s)
}

/// 写入设置
#[tauri::command]
pub async fn save_settings(settings: AppSettings, app: AppHandle) -> AppResult<()> {
    let p = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&p, json)?;
    Ok(())
}

#[allow(dead_code)]
fn _ensure_state(_s: &Arc<AppState>) {}
