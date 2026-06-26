//! 应用设置 (Anthropic API Key、主题、**自定义根目录** 等)

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::fs::paths::CustomRoot;
use crate::AppState;

#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnthropicConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
}

/// v0.2.5: 用户在 settings 里加的额外数据根目录(持久化形态)。
/// 启动时(和保存时)用 `CustomRoot::probe` 转成运行时形态。
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomRootConfig {
    /// 用户起的名字(如 "Downloads")
    pub label: String,
    /// 绝对路径,前端传进来时已展开 ~ 和 normalize
    pub path: String,
    /// "Claude" | "OpenClaw" | "Both"(探测结果)
    pub kind: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub anthropic: AnthropicConfig,
    pub theme: String,
    pub ui_language: String,
    pub default_export_dir: Option<String>,
    /// v0.2.5: 用户自定义的额外数据根目录
    #[serde(default)]
    pub custom_roots: Vec<CustomRootConfig>,
    /// v0.4.2: 时区。"auto" 或 IANA 名(Asia/Shanghai 等)。None = auto
    #[serde(default)]
    pub timezone: Option<String>,
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
            custom_roots: vec![],
            timezone: None,
        }
    }
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// 把持久化形态转成运行时形态(探测路径是否含 Claude/OpenClaw)
/// 探测失败的条目直接丢弃,不阻断其他 root 的加载
pub fn to_runtime_custom_roots(configs: &[CustomRootConfig]) -> Vec<CustomRoot> {
    configs
        .iter()
        .filter_map(|c| match CustomRoot::probe(PathBuf::from(&c.path)) {
            Some(r) => Some(r),
            None => {
                log::warn!(
                    "自定义根目录 {:?} 探测失败(目录不存在或不包含 Claude/OpenClaw 数据)",
                    c.path
                );
                None
            }
        })
        .collect()
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

/// 写入设置(同时刷新 AppPaths + 清缓存 + emit sessions-updated)
#[tauri::command]
pub async fn save_settings(
    settings: AppSettings,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> AppResult<()> {
    let p = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings)?;
    std::fs::write(&p, json)?;

    // 1. 更新内存里的 settings 副本
    *state.settings.write() = settings.clone();

    // 2. 探测 custom_roots,重建 AppPaths
    let runtime_roots = to_runtime_custom_roots(&settings.custom_roots);
    let home = state.app_home.clone();
    let new_paths = crate::fs::paths::AppPaths::new(home, &runtime_roots);
    *state.paths.write() = new_paths;

    // 3. 清缓存
    state.session_meta_cache.invalidate_all().await;

    // 4. 通知前端刷新会话列表
    let _ = app.emit("sessions-updated", ());

    log::info!("settings 已保存: {} 个自定义根目录", runtime_roots.len());
    Ok(())
}

#[allow(dead_code)]
fn _ensure_state(_s: &Arc<AppState>) {}
