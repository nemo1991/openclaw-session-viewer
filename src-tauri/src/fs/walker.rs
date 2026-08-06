//! 目录遍历

use std::path::{Path, PathBuf};

use serde::Deserialize;
use walkdir::WalkDir;

use crate::error::AppResult;

/// 列举目录下所有 .jsonl 文件(递归)
///
/// **过滤**:
/// - 跳过 `<sessionId>.trajectory.jsonl` 这类 openclaw 观测/追踪文件
///   — 不是真正的用户会话,只是同目录的 trace 输出。
///   (注意:`Path::extension()` 只返回最后一段,`a.trajectory.jsonl`
///   的 extension 仍是 `"jsonl"`,所以必须看 `file_stem()` 末尾
///   是否是 `.trajectory` / `.traces` 等。)
pub fn list_jsonl_files(dir: &Path) -> AppResult<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().map(|e| e == "jsonl").unwrap_or(false) {
            // 排除观测/trace 副产物(OpenClaw 会在每个 session 旁
            // 写 `<id>.trajectory.jsonl`,应当被忽略)
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if stem.ends_with(".trajectory")
                    || stem.ends_with(".traces")
                    || stem.ends_with(".trajectory-path")
                {
                    continue;
                }
            }
            out.push(p.to_path_buf());
        }
    }
    Ok(out)
}

/// 列举目录下所有 .json 文件(非递归,一层)
#[allow(dead_code)]
pub fn list_json_files_shallow(dir: &Path) -> AppResult<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_file() && p.extension().map(|e| e == "json").unwrap_or(false) {
            out.push(p);
        }
    }
    Ok(out)
}

/// v0.9.0: Kimi session 描述 — 用于 build_kimi_session_meta 输入
///
/// 来自 `~/.kimi/sessions/wd_<ws>_<hash>/session_<uuid>/state.json`
#[derive(Debug, Clone)]
pub struct KimiSession {
    /// session 目录(`<root>/wd_x/session_<uuid>`)
    pub session_dir: PathBuf,
    /// 截取 `session_` 后的 uuid 字符串(不带前缀)
    pub session_id: String,
    /// 父目录名,例 `wd_bpm_ab308ba3bc10`
    pub wd_name: String,
    /// `<session_dir>/agents/main/wire.jsonl`(主 agent transcript);
    /// 若文件缺失(主 agent 未创建或 session 中途崩溃)则为 None — 由调用方 skip
    pub main_wire: Option<PathBuf>,
    /// `<session_dir>/state.json`
    pub state_json: PathBuf,
    /// 从 state.json 读出的 workDir(Windows 路径原样)
    pub work_dir: Option<String>,
    /// 从 state.json 读出的 title(目前 build_kimi_session_meta 走 state_json 二次解析,
    /// 字段保留供未来 caller 直接用)
    #[allow(dead_code)]
    pub title: Option<String>,
    /// agents/* 子目录名列表,含 `main`,例 `["agent-0", "main"]`(字典序)
    pub agent_ids: Vec<String>,
}

/// v0.9.0: state.json 最小子集解析
///
/// kimi state.json 含 `createdAt`/`updatedAt`/`title`/`isCustomTitle`/`agents`/
/// `custom`/`workDir`/`lastPrompt`。我们只读三个字段:title / workDir / agents keys。
/// 不解析每个 agent 内部细节(留到 build_kimi_session_meta 阶段按需)。
#[derive(Debug, Deserialize)]
struct KimiStateJson {
    #[serde(default)]
    title: Option<String>,
    // kimi state.json 用 camelCase (`workDir`);serde 默认 snake_case,要 rename
    #[serde(default, rename = "workDir")]
    work_dir: Option<String>,
    #[serde(default)]
    agents: serde_json::Map<String, serde_json::Value>,
}

/// 列举 `~/.kimi/sessions/` 目录下所有 session 描述
///
/// 策略:
/// - `read_dir(sessions_root)` → `wd_*` 子目录
/// - 每个 `wd_*` 内 `read_dir` → `session_*` 子目录
/// - 读 `state.json` (失败跳过,log warn)
/// - 探测 `agents/main/wire.jsonl` 是否存在
/// - 收集 `agents/*` 子目录名作为 `agent_ids` (字典序)
pub fn list_kimi_sessions(sessions_root: &Path) -> AppResult<Vec<KimiSession>> {
    if !sessions_root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();

    let wd_iter = match std::fs::read_dir(sessions_root) {
        Ok(it) => it,
        Err(e) => {
            log::warn!("kimi walker read_dir {:?} 失败: {e}", sessions_root);
            return Ok(vec![]);
        }
    };

    // Sort wd dirs for stable ordering
    let mut wd_dirs: Vec<PathBuf> = wd_iter
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("wd_"))
                .unwrap_or(false)
        })
        .collect();
    wd_dirs.sort();

    for wd_dir in wd_dirs {
        let wd_name = wd_dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let sess_iter = match std::fs::read_dir(&wd_dir) {
            Ok(it) => it,
            Err(e) => {
                log::warn!("kimi walker read_dir {:?} 失败: {e}", wd_dir);
                continue;
            }
        };

        let mut sess_dirs: Vec<PathBuf> = sess_iter
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("session_"))
                    .unwrap_or(false)
            })
            .collect();
        sess_dirs.sort();

        for session_dir in sess_dirs {
            let state_json = session_dir.join("state.json");
            let (work_dir, title, agent_keys) = match read_kimi_state(&state_json) {
                Some(s) => (
                    s.work_dir,
                    s.title,
                    s.agents.keys().cloned().collect::<Vec<_>>(),
                ),
                None => {
                    log::warn!("kimi walker state.json 解析失败: {:?}", state_json);
                    continue;
                }
            };

            // agents/main/wire.jsonl
            let main_wire = session_dir.join("agents").join("main").join("wire.jsonl");
            let main_wire = if main_wire.exists() {
                Some(main_wire)
            } else {
                None
            };

            // agents/* 子目录字典序
            let mut agent_ids = agent_keys;
            agent_ids.sort();

            let session_id = session_dir
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|s| s.strip_prefix("session_"))
                .unwrap_or("")
                .to_string();
            if session_id.is_empty() {
                continue;
            }

            // 跳过缺 main wire 的 session (主 agent 未创建或中途崩溃) —
            // build_kimi_session_meta 仍能跑(从 state.json 派生),但
            // sync_loop 拿不到 jsonl_path 会 skip。这里 return 但不存,
            // 跟旧版 walker 行为不同 — 旧版 list_jsonl_files 只列存在的
            // 文件,kimi 把 session_dir 当主键,缺 wire 视为 zombie。
            if main_wire.is_none() {
                log::debug!("kimi walker 跳过 zombie session: {:?}", session_dir);
                continue;
            }

            out.push(KimiSession {
                session_dir,
                session_id,
                wd_name: wd_name.clone(),
                main_wire,
                state_json,
                work_dir,
                title,
                agent_ids,
            });
        }
    }
    Ok(out)
}

fn read_kimi_state(path: &Path) -> Option<KimiStateJson> {
    let f = std::fs::File::open(path).ok()?;
    serde_json::from_reader(f).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"{}").unwrap();
        p
    }

    #[test]
    fn list_jsonl_skips_trajectory_observability_files() {
        let tmp = std::env::temp_dir().join(format!("ocsv-walker-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // 真正的会话文件(应保留)
        make(&tmp, "883031bd-0634-4ce1-9756-bc2d9d9b1b3e.jsonl");
        // openclaw 观测/trace 副产物(应被排除)
        make(
            &tmp,
            "883031bd-0634-4ce1-9756-bc2d9d9b1b3e.trajectory.jsonl",
        );
        make(
            &tmp,
            "883031bd-0634-4ce1-9756-bc2d9d9b1b3e.trajectory-path.json",
        );
        // 子代理的 agent-*.jsonl(应保留 — Claude Code 风格)
        make(&tmp, "agent-abc.jsonl");

        let mut files = list_jsonl_files(&tmp).unwrap();
        files.sort();

        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        assert!(
            names
                .iter()
                .any(|n| n.ends_with(".jsonl") && !n.contains(".trajectory")),
            "real session jsonl should be kept, got: {:?}",
            names
        );
        assert!(
            !names.iter().any(|n| n.contains(".trajectory")),
            "trajectory file should be excluded, got: {:?}",
            names
        );
        assert!(
            names.iter().any(|n| n.starts_with("agent-")),
            "agent-*.jsonl (subagent) should be kept, got: {:?}",
            names
        );

        fs::remove_dir_all(&tmp).ok();
    }

    /// v0.9.0: kimi walker 只列 main wire 存在的 session,缺 state.json 跳过
    #[test]
    fn list_kimi_sessions_filters_orphans() {
        let tmp = std::env::temp_dir().join(format!("ocsv-kimi-walker-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // session 1: 完整
        let s1 = tmp.join("wd_alpha").join("session_aaaaaaaa-1111");
        fs::create_dir_all(s1.join("agents").join("main")).unwrap();
        fs::write(
            s1.join("state.json"),
            r#"{"title":"t1","workDir":"C:/x","agents":{"main":{}}}"#,
        )
        .unwrap();
        fs::write(s1.join("agents/main/wire.jsonl"), b"{}").unwrap();

        // session 2: 缺 main wire(中途崩溃) → 应被过滤
        let s2 = tmp.join("wd_alpha").join("session_bbbbbbbb-2222");
        fs::create_dir_all(&s2).unwrap();
        fs::write(
            s2.join("state.json"),
            r#"{"title":"t2","workDir":"C:/y","agents":{}}"#,
        )
        .unwrap();

        // session 3: wd_alpha 子目录但不是 session_*,应跳过
        let s3 = tmp.join("wd_alpha").join("not-a-session");
        fs::create_dir_all(&s3).unwrap();

        // wd_bravo 目录但无 session_* → 静默跳过
        fs::create_dir_all(tmp.join("wd_bravo")).unwrap();

        // 顶层非 wd_* 目录 → 跳过
        fs::create_dir_all(tmp.join("random")).unwrap();

        let sessions = list_kimi_sessions(&tmp).unwrap();
        assert_eq!(
            sessions.len(),
            1,
            "expected only the complete session, got: {:?}",
            sessions
        );
        let s = &sessions[0];
        assert_eq!(s.session_id, "aaaaaaaa-1111");
        assert_eq!(s.wd_name, "wd_alpha");
        assert_eq!(s.title.as_deref(), Some("t1"));
        assert_eq!(s.work_dir.as_deref(), Some("C:/x"));
        assert_eq!(s.agent_ids, vec!["main".to_string()]);
        assert!(s.main_wire.is_some());

        fs::remove_dir_all(&tmp).ok();
    }
}
