//! 路径解析 — Claude Code 和 OpenClaw 目录布局

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ClaudePaths {
    pub home: PathBuf,
    pub projects_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub session_env_dir: PathBuf,
    pub tasks_dir: PathBuf,
    pub shell_snapshots_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub file_history_dir: PathBuf,
    pub plugins_dir: PathBuf,
    pub skills_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub history_file: PathBuf,
    pub settings_file: PathBuf,
}

impl ClaudePaths {
    pub fn new(home_dir: &Path) -> Self {
        let home = home_dir.join(".claude");
        Self {
            home: home.clone(),
            projects_dir: home.join("projects"),
            sessions_dir: home.join("sessions"),
            session_env_dir: home.join("session-env"),
            tasks_dir: home.join("tasks"),
            shell_snapshots_dir: home.join("shell-snapshots"),
            backups_dir: home.join("backups"),
            file_history_dir: home.join("file-history"),
            plugins_dir: home.join("plugins"),
            skills_dir: home.join("skills"),
            cache_dir: home.join("cache"),
            history_file: home.join("history.jsonl"),
            settings_file: home.join("settings.json"),
        }
    }

    pub fn exists(&self) -> bool {
        self.home.exists()
    }
}

#[derive(Debug, Clone)]
pub struct OpenClawPaths {
    pub home: PathBuf,
    pub agents_dir: PathBuf,
}

impl OpenClawPaths {
    pub fn new(home_dir: &Path) -> Self {
        Self {
            home: home_dir.join(".openclaw"),
            agents_dir: home_dir.join(".openclaw").join("agents"),
        }
    }

    pub fn exists(&self) -> bool {
        self.home.exists()
    }
}

/// v0.2.5: 自定义根目录,自动探测含 Claude 和/或 OpenClaw 数据
///
/// `path` 是用户在 settings 里填的绝对路径(可能是 `~/Downloads/.openclaw/` 这种)。
/// `kind` 是探测出来的类型,扫描时只走对应的子目录。
#[derive(Debug, Clone)]
pub struct CustomRoot {
    /// 用户起的标签(如 "Downloads")
    pub label: String,
    /// 绝对路径
    pub path: PathBuf,
    /// 探测出的内容类型
    pub kind: RootKind,
    /// path/projects/<encoded-cwd>/* 路径(仅 kind 含 Claude 时 Some)
    pub claude_projects_dir: Option<PathBuf>,
    /// path/agents/<agentId>/sessions/* 路径(仅 kind 含 OpenClaw 时 Some)
    pub openclaw_agents_dir: Option<PathBuf>,
}

/// 自动探测一个根目录含哪种数据
///
/// 约定:
/// - 含 `projects/` 子目录 → 视作 Claude
/// - 含 `agents/` 子目录 → 视作 OpenClaw
/// - 两者都含 → Both
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootKind {
    Claude,
    OpenClaw,
    Both,
}

impl CustomRoot {
    /// 探测一个用户提供的路径,返回 None 如果该路径啥都不是
    pub fn probe(path: PathBuf) -> Option<Self> {
        if !path.exists() || !path.is_dir() {
            return None;
        }
        let claude_projects = path.join("projects");
        let openclaw_agents = path.join("agents");
        let has_claude = claude_projects.exists() && claude_projects.is_dir();
        let has_openclaw = openclaw_agents.exists() && openclaw_agents.is_dir();

        let kind = match (has_claude, has_openclaw) {
            (true, true) => RootKind::Both,
            (true, false) => RootKind::Claude,
            (false, true) => RootKind::OpenClaw,
            (false, false) => return None,
        };

        Some(Self {
            label: path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string()),
            path,
            kind,
            claude_projects_dir: has_claude.then_some(claude_projects),
            openclaw_agents_dir: has_openclaw.then_some(openclaw_agents),
        })
    }
}

/// 应用所有可用的根目录(default + custom)。
///
/// `default_root` 是 `~/.claude` 和 `~/.openclaw` 默认组合。
/// `custom_roots` 是用户在 Settings 里加的(可能多个)。
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub home: PathBuf,
    pub default_root: RootSource,
    pub custom_roots: Vec<RootSource>,
}

/// 单个数据根来源(默认或自定义),含 Claude + OpenClaw 子目录
#[derive(Debug, Clone)]
pub struct RootSource {
    pub label: String,
    pub path: PathBuf,
    pub claude: Option<ClaudePaths>,
    pub openclaw: Option<OpenClawPaths>,
}

impl AppPaths {
    pub fn new(home_dir: PathBuf, custom_roots: &[CustomRoot]) -> Self {
        let default_root = RootSource {
            label: "Default".to_string(),
            path: home_dir.clone(),
            claude: Some(ClaudePaths::new(&home_dir)),
            openclaw: if OpenClawPaths::new(&home_dir).exists() {
                Some(OpenClawPaths::new(&home_dir))
            } else {
                None
            },
        };

        let custom_roots = custom_roots
            .iter()
            .map(|cr| RootSource {
                label: cr.label.clone(),
                path: cr.path.clone(),
                claude: cr.claude_projects_dir.as_ref().map(|_| ClaudePaths {
                    // 复用 ClaudePaths 结构,但实际只用 projects_dir
                    home: cr.path.clone(),
                    projects_dir: cr.claude_projects_dir.clone().unwrap(),
                    sessions_dir: cr.path.join("sessions"),
                    session_env_dir: cr.path.join("session-env"),
                    tasks_dir: cr.path.join("tasks"),
                    shell_snapshots_dir: cr.path.join("shell-snapshots"),
                    backups_dir: cr.path.join("backups"),
                    file_history_dir: cr.path.join("file-history"),
                    plugins_dir: cr.path.join("plugins"),
                    skills_dir: cr.path.join("skills"),
                    cache_dir: cr.path.join("cache"),
                    history_file: cr.path.join("history.jsonl"),
                    settings_file: cr.path.join("settings.json"),
                }),
                openclaw: cr.openclaw_agents_dir.as_ref().map(|_| OpenClawPaths {
                    home: cr.path.clone(),
                    agents_dir: cr.openclaw_agents_dir.clone().unwrap(),
                }),
            })
            .collect();

        Self {
            home: home_dir,
            default_root,
            custom_roots,
        }
    }

    /// 列出所有 Claude 项目目录(default + custom)
    pub fn all_claude_projects_dirs(&self) -> Vec<&Path> {
        let mut out = Vec::new();
        if let Some(c) = &self.default_root.claude {
            out.push(c.projects_dir.as_path());
        }
        for cr in &self.custom_roots {
            if let Some(c) = &cr.claude {
                out.push(c.projects_dir.as_path());
            }
        }
        out
    }

    /// 列出所有 OpenClaw agents 目录(default + custom)
    pub fn all_openclaw_agents_dirs(&self) -> Vec<&Path> {
        let mut out = Vec::new();
        if let Some(o) = &self.default_root.openclaw {
            out.push(o.agents_dir.as_path());
        }
        for cr in &self.custom_roots {
            if let Some(o) = &cr.openclaw {
                out.push(o.agents_dir.as_path());
            }
        }
        out
    }

    /// 默认 Claude 路径(兼容老代码 — 主要供 lib.rs 启动 log 用)
    pub fn claude(&self) -> Option<&ClaudePaths> {
        self.default_root.claude.as_ref()
    }

    /// 默认 OpenClaw 路径
    pub fn openclaw(&self) -> Option<&OpenClawPaths> {
        self.default_root.openclaw.as_ref()
    }
}

/// 路径安全检查(允许路径不存在):遍历所有 root 验证
pub fn assert_within_any_root(paths: &AppPaths, target: &Path) -> crate::error::AppResult<()> {
    // 1) default claude.projects_dir
    if let Some(c) = &paths.default_root.claude {
        if target.starts_with(&c.projects_dir) {
            return assert_within_lexical(&c.projects_dir, target);
        }
    }
    // 2) default openclaw.agents_dir
    if let Some(o) = &paths.default_root.openclaw {
        if target.starts_with(&o.agents_dir) {
            return assert_within_lexical(&o.agents_dir, target);
        }
    }
    // 3) 每个 custom_root
    for cr in &paths.custom_roots {
        if let Some(c) = &cr.claude {
            if target.starts_with(&c.projects_dir) {
                return assert_within_lexical(&c.projects_dir, target);
            }
        }
        if let Some(o) = &cr.openclaw {
            if target.starts_with(&o.agents_dir) {
                return assert_within_lexical(&o.agents_dir, target);
            }
        }
    }
    Err(crate::error::AppError::PathSecurity(format!(
        "词法检查: {:?} 不在任一已知 root 下",
        target
    )))
}

/// 路径安全检查(允许路径不存在):只做词法校验(单一 base,保留向后兼容)
pub fn assert_within_lexical(base: &Path, target: &Path) -> crate::error::AppResult<()> {
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let base_str = base_canon.to_string_lossy();
    let target_str = target.to_string_lossy();
    if !target_str.starts_with(base_str.as_ref()) {
        return Err(crate::error::AppError::PathSecurity(format!(
            "词法检查: {:?} 不在 {:?} 下",
            target, base
        )));
    }
    Ok(())
}

/// Claude 项目目录名编码(对应前端 paths.ts)
#[allow(dead_code)]
pub fn encode_project_key(abs_path: &str) -> String {
    const MAX: usize = 200;
    let sanitized: String = abs_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if sanitized.len() <= MAX {
        return sanitized;
    }
    let hash = simple_hash36(abs_path);
    format!("{}-{}", &sanitized[..MAX], hash)
}

#[allow(dead_code)]
fn simple_hash36(input: &str) -> String {
    let mut hash: u32 = 0;
    for b in input.bytes() {
        // wrapping_mul + wrapping_add 在 u32 上已经保证 wrap,不需要 & 0xFFFFFFFF
        hash = hash.wrapping_mul(31).wrapping_add(b as u32);
    }
    let mut n = hash;
    if n == 0 {
        return "0".to_string();
    }
    let mut out = String::new();
    while n > 0 {
        let r = n % 36;
        n /= 36;
        let c = if r < 10 {
            b'0' + r as u8
        } else {
            b'a' + (r - 10) as u8
        } as char;
        out.push(c);
    }
    out.chars().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_short_path() {
        let key = encode_project_key("/Users/foo/bar");
        assert_eq!(key, "-Users-foo-bar");
    }

    #[test]
    fn test_path_with_special_chars() {
        let key = encode_project_key("/Users/alice/my project@v1");
        // 所有非字母数字变成 -
        assert_eq!(key, "-Users-alice-my-project-v1");
    }

    #[test]
    fn test_long_path_truncates_and_hashes() {
        let long_path = format!("/Users/{}", "x".repeat(300));
        let key = encode_project_key(&long_path);
        // 200 字符限制 + "-" + 36 进制 hash
        assert!(key.len() <= 200 + 1 + 12);
        assert!(key.starts_with('-'));
        assert!(key.contains('-'));
    }

    #[test]
    fn test_simple_hash36_consistent() {
        let k1 = encode_project_key("/Users/test/path");
        let k2 = encode_project_key("/Users/test/path");
        assert_eq!(k1, k2);
    }

    #[test]
    fn test_assert_within_lexical_accepts_subpath() {
        let base = std::path::Path::new("/Users/foo");
        let target = std::path::Path::new("/Users/foo/bar/baz");
        assert!(assert_within_lexical(base, target).is_ok());
    }

    #[test]
    fn test_assert_within_lexical_rejects_escape() {
        let base = std::path::Path::new("/Users/foo");
        let target = std::path::Path::new("/etc/passwd");
        assert!(assert_within_lexical(base, target).is_err());
    }

    #[test]
    fn test_custom_root_probe_none_for_nonexistent() {
        let result = CustomRoot::probe(PathBuf::from("/nonexistent/path/xyz"));
        assert!(result.is_none());
    }

    #[test]
    fn test_custom_root_probe_none_for_empty_dir() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let result = CustomRoot::probe(dir.path().to_path_buf());
        assert!(result.is_none());
    }

    #[test]
    fn test_custom_root_probe_openclaw_only() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let agents = dir.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        let result = CustomRoot::probe(dir.path().to_path_buf()).expect("probe");
        assert_eq!(result.kind, RootKind::OpenClaw);
        assert_eq!(result.openclaw_agents_dir, Some(agents));
        assert!(result.claude_projects_dir.is_none());
    }

    #[test]
    fn test_custom_root_probe_claude_only() {
        let dir = tempfile::tempdir().expect("create tempdir");
        let projects = dir.path().join("projects");
        std::fs::create_dir(&projects).unwrap();
        let result = CustomRoot::probe(dir.path().to_path_buf()).expect("probe");
        assert_eq!(result.kind, RootKind::Claude);
        assert_eq!(result.claude_projects_dir, Some(projects));
        assert!(result.openclaw_agents_dir.is_none());
    }

    #[test]
    fn test_custom_root_probe_both() {
        let dir = tempfile::tempdir().expect("create tempdir");
        std::fs::create_dir(dir.path().join("projects")).unwrap();
        std::fs::create_dir(dir.path().join("agents")).unwrap();
        let result = CustomRoot::probe(dir.path().to_path_buf()).expect("probe");
        assert_eq!(result.kind, RootKind::Both);
    }
}
