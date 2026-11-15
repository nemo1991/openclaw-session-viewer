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

/// v0.11 (B3): 会话体检规则阈值(估算默认值,可在设置页修改)。
///
/// 与 `packages/shared/src/ipc.ts::HealthRulesConfig` 字段一一对应 ——
/// camelCase 序列化直接写进 settings.json。struct 级 `#[serde(default)]` 保证
/// 老配置(没有该字段)或只写了部分字段的配置都能安全读出,不阻断应用启动。
/// 默认值必须与 TS 侧 `DEFAULT_HEALTH_RULES` 保持一致(下方单测锁定)。
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthRulesConfig {
    pub high_errors_enabled: bool,
    pub high_errors_threshold: u32,
    pub token_outlier_enabled: bool,
    pub token_sigma: f64,
    pub subagents_enabled: bool,
    pub subagents_threshold: u32,
    pub model_drift_enabled: bool,
    pub model_drift_min_models: u32,
}

impl Default for HealthRulesConfig {
    fn default() -> Self {
        Self {
            high_errors_enabled: true,
            high_errors_threshold: 20,
            token_outlier_enabled: true,
            token_sigma: 3.0,
            subagents_enabled: true,
            subagents_threshold: 10,
            model_drift_enabled: true,
            model_drift_min_models: 2,
        }
    }
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
    /// v0.11 (B3): 体检规则阈值,写入本地 settings.json,重启后保留
    #[serde(default)]
    pub health_rules: HealthRulesConfig,
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
            health_rules: HealthRulesConfig::default(),
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

    // 4. v0.8.0: 通知后台 sync_loop 重新扫描(因 paths 变了)
    state.paths_change.notify_waiters();

    // 5. 通知前端刷新会话列表
    let _ = app.emit("sessions-updated", ());

    log::info!("settings 已保存: {} 个自定义根目录", runtime_roots.len());
    Ok(())
}

#[allow(dead_code)]
fn _ensure_state(_s: &Arc<AppState>) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// 老 settings.json(v0.10 及以前)没有 healthRules 字段 —— 必须仍能读出,
    /// 且自动补齐估算默认值,不能因为新增字段导致应用启动失败。
    #[test]
    fn legacy_settings_without_health_rules_deserializes_with_defaults() {
        let legacy = r#"{
            "anthropic": {
                "baseUrl": "https://api.anthropic.com",
                "apiKey": "",
                "model": "claude-sonnet-4-6",
                "maxTokens": 4096
            },
            "theme": "dark",
            "uiLanguage": "zh-CN",
            "defaultExportDir": null,
            "customRoots": [],
            "timezone": "auto"
        }"#;
        let s: AppSettings = serde_json::from_str(legacy).expect("老配置必须能反序列化");
        assert_eq!(s.health_rules, HealthRulesConfig::default());
        assert_eq!(s.ui_language, "zh-CN");
    }

    /// 锁住 Rust ↔ TS 默认值一致:改了一边而忘了另一边,这里立刻失败。
    #[test]
    fn health_rules_defaults_match_ts_contract() {
        let d = HealthRulesConfig::default();
        assert!(d.high_errors_enabled);
        assert_eq!(d.high_errors_threshold, 20);
        assert!(d.token_outlier_enabled);
        assert_eq!(d.token_sigma, 3.0);
        assert!(d.subagents_enabled);
        assert_eq!(d.subagents_threshold, 10);
        assert!(d.model_drift_enabled);
        assert_eq!(d.model_drift_min_models, 2);
    }

    /// 设置页改阈值 → save_settings 写盘 → 重启读出,key 必须是 camelCase 且值不丢。
    #[test]
    fn health_rules_round_trip_uses_camel_case_keys() {
        let mut s = AppSettings::default();
        s.health_rules.high_errors_threshold = 30;
        s.health_rules.high_errors_enabled = false;
        let json = serde_json::to_string(&s).expect("serialize settings");
        assert!(json.contains("\"healthRules\""), "根 key 应为 camelCase");
        assert!(json.contains("\"highErrorsThreshold\":30"));
        assert!(json.contains("\"highErrorsEnabled\":false"));
        let back: AppSettings = serde_json::from_str(&json).expect("deserialize settings");
        assert_eq!(back.health_rules, s.health_rules);
    }

    /// 手改 settings.json 只写两个字段时,其余字段用默认值补齐(struct 级 serde default)。
    #[test]
    fn partial_health_rules_json_fills_missing_fields_with_defaults() {
        let partial = r#"{"highErrorsThreshold":30,"tokenSigma":2.5}"#;
        let r: HealthRulesConfig = serde_json::from_str(partial).expect("部分配置必须可读");
        assert_eq!(r.high_errors_threshold, 30);
        assert_eq!(r.token_sigma, 2.5);
        assert_eq!(r.subagents_threshold, 10);
        assert_eq!(r.model_drift_min_models, 2);
        assert!(r.high_errors_enabled);
    }
}
