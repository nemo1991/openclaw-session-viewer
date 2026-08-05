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
///
/// v0.2.6: 改用 Path 组件级比较 (Path::starts_with) 而不是字符串前缀。
/// 之前用 `target.to_string_lossy().starts_with(base.to_string_lossy())` 在 Windows
/// 上失败:base canonicalize 后会带 `\\?\` UNC 前缀,target 是短路径,
/// 字符串比较失败但实际是子路径。
///
/// v0.8.14 item I: lexical 检查之外,当 target 实际存在时再 canonicalize 一遍
/// re-check,防止 `/Users/test/.claude/../../../.ssh/id_rsa` 这种 lexical-pass
/// (starts_with `.claude` ✓) 但 canonicalize 后实际指向 root 外的路径逃逸。
///
/// 行为表(对 _存在_ 的 path):
/// - `.claude/foo.txt` → canonicalize = 同 → lexical Ok ✓
/// - `.claude/../.ssh/id_rsa` → canonicalize = `parent_dir/.ssh/id_rsa` → lexical fails → Err ✓ (原本 lexical-pass 漏掉!)
/// - `/etc/passwd` → lexical fails, canonicalize = `/etc/passwd` (or `/private/etc/passwd`) → lexical fails → Err ✓
///
/// 非存在 path 仍走纯 lexical 检查(canonicalize 需要文件存在);
/// 真实使用里非存在 path 是 DB fallback 场景,sanitize 上游过滤已经覆盖。
pub fn assert_within_any_root(paths: &AppPaths, target: &Path) -> crate::error::AppResult<()> {
    // 1) 如果 target 实际存在,canonicalize 拿真实路径。
    //    防 `..` traversal:`/a/b/.claude/../.ssh/id_rsa` lexical-pass `.claude`,
    //    但 canonical 后是 `/a/b/.ssh/id_rsa` 在 root 外。
    let target_canonical = if target.exists() {
        std::fs::canonicalize(target).ok()
    } else {
        None
    };

    let roots = collect_root_paths(paths);

    // 2) 优先 canonical-target vs canonical-root (防 macOS /var→/private/var symlink)
    if let Some(tc) = &target_canonical {
        for root in &roots {
            if let Ok(rc) = std::fs::canonicalize(root) {
                if path_starts_with(tc, &rc) {
                    return Ok(());
                }
            }
        }
        // canonical-target 存在但不在任一 canonical-root 下 → 拒绝
        return Err(crate::error::AppError::PathSecurity(format!(
            "路径安全: {:?} (canonical: {:?}) 不在任一已知 root 下",
            target, tc
        )));
    }

    // 3) target 不存在(或 canonicalize 失败):回退到 raw lexical 比较
    //    (向后兼容 — DB fallback 场景)
    for root in &roots {
        if path_starts_with(target, root) {
            return Ok(());
        }
    }
    Err(crate::error::AppError::PathSecurity(format!(
        "路径安全: {:?} 不在任一已知 root 下",
        target
    )))
}

/// Collect every root path we treat as "inside" for `assert_within_any_root`:
/// default Claude + OpenClaw homes, plus each custom_root (whole + each home).
fn collect_root_paths(paths: &AppPaths) -> Vec<&Path> {
    let mut out: Vec<&Path> = Vec::new();
    if let Some(c) = &paths.default_root.claude {
        out.push(c.home.as_path());
    }
    if let Some(o) = &paths.default_root.openclaw {
        out.push(o.home.as_path());
    }
    for cr in &paths.custom_roots {
        out.push(cr.path.as_path());
        if let Some(c) = &cr.claude {
            out.push(c.home.as_path());
        }
        if let Some(o) = &cr.openclaw {
            out.push(o.home.as_path());
        }
    }
    out
}

/// 路径"target 是 base 的子路径"比较,跨平台安全:
///
/// - 把 `\` 和 `/` 都规范化为 `/`,避免 Windows 上两种分隔符混用
/// - 去掉 `\\?\` UNC 前缀(canonicalize 会加)
/// - 大小写不敏感(Windows 路径是大小写不敏感的)
/// - 不依赖 canonicalize,允许路径不存在
fn path_starts_with(target: &Path, base: &Path) -> bool {
    let norm = |p: &Path| -> String {
        let s = p.to_string_lossy();
        // 去掉 Windows extended-length prefix `\\?\`
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
        // 统一分隔符为 /
        s.replace('\\', "/").to_lowercase()
    };
    let t = norm(target);
    let b = norm(base);

    if t == b {
        return true;
    }
    // 必须以 separator 结尾避免 `/foo/bar` 通过 `/foo/b` 检查
    let b_with_sep = if b.ends_with('/') {
        b.clone()
    } else {
        format!("{}/", b)
    };
    t.starts_with(&b_with_sep)
}

/// 路径安全检查(允许路径不存在):只做词法校验(单一 base,保留向后兼容)
///
/// v0.2.6: 内部已用 path_starts_with 替代,所有 caller 都走
/// assert_within_any_root。保留这个函数供旧代码 + 测试用。
#[allow(dead_code)]
pub fn assert_within_lexical(base: &Path, target: &Path) -> crate::error::AppResult<()> {
    if path_starts_with(target, base) {
        return Ok(());
    }
    Err(crate::error::AppError::PathSecurity(format!(
        "词法检查: {:?} 不在 {:?} 下",
        target, base
    )))
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

    /// v0.6.x: ~/.claude/plans/my-plan.md 应该在 ~/.claude 树下 (不再只检查 projects/)
    #[test]
    fn test_assert_within_any_root_accepts_claude_plan_file() {
        use crate::fs::paths::{assert_within_any_root, AppPaths, ClaudePaths, RootSource};
        let home = std::path::PathBuf::from("/Users/test");
        let paths = AppPaths {
            home: home.clone(),
            default_root: RootSource {
                label: "default".to_string(),
                path: home.join(".claude"),
                claude: Some(ClaudePaths::new(&home)),
                openclaw: None,
            },
            custom_roots: vec![],
        };
        // 计划文件 ~/.claude/plans/my-plan.md 应被接受
        let target = std::path::Path::new("/Users/test/.claude/plans/my-plan.md");
        assert!(assert_within_any_root(&paths, target).is_ok());
        // ~/.claude/projects/<encoded>/abc.jsonl 也应被接受
        let target2 = std::path::Path::new("/Users/test/.claude/projects/-Users-foo/sess.jsonl");
        assert!(assert_within_any_root(&paths, target2).is_ok());
        // ~/.ssh/id_rsa 仍然拒绝
        let bad = std::path::Path::new("/Users/test/.ssh/id_rsa");
        assert!(assert_within_any_root(&paths, bad).is_err());
    }

    /// v0.6.x: custom_root 整个 path 都接受 (不再仅 claude_projects_dir)
    #[test]
    fn test_assert_within_any_root_accepts_custom_root_path() {
        use crate::fs::paths::{assert_within_any_root, AppPaths, RootSource};
        let home = std::path::PathBuf::from("/Users/test");
        let custom_path = std::path::PathBuf::from("/tmp/my-claude-root");
        let paths = AppPaths {
            home: home.clone(),
            default_root: RootSource {
                label: "default".to_string(),
                path: home.join(".claude"),
                claude: None,
                openclaw: None,
            },
            custom_roots: vec![RootSource {
                label: "my-root".to_string(),
                path: custom_path.clone(),
                claude: None,
                openclaw: None,
            }],
        };
        // 自定义 root 下任何路径都接受
        let target = std::path::Path::new("/tmp/my-claude-root/foo/bar.jsonl");
        assert!(assert_within_any_root(&paths, target).is_ok());
        // 之外仍然拒绝
        let bad = std::path::Path::new("/etc/passwd");
        assert!(assert_within_any_root(&paths, bad).is_err());
    }

    /// v0.2.6 回归测试:Windows 上 base 是短路径 (`C:\Users\keepn\.openclaw\agents`),
    /// target 是子路径 (`C:\Users\keepn\.openclaw\agents\liushuyou\sessions\abc.jsonl`),
    /// 之前用 string starts_with 失败(因为 canonicalize base 后带 \\?\ UNC 前缀)。
    #[test]
    fn test_path_starts_with_windows_style_subpath() {
        let base = std::path::Path::new("C:\\Users\\keepn\\.openclaw\\agents");
        let target = std::path::Path::new(
            "C:\\Users\\keepn\\.openclaw\\agents\\liushuyou\\sessions\\94424018-a80d-49c3-bf9b-4116c1435b6d.jsonl",
        );
        assert!(path_starts_with(target, base));
    }

    #[test]
    fn test_path_starts_with_windows_style_exact_match() {
        let base = std::path::Path::new("C:\\Users\\keepn\\.openclaw\\agents");
        assert!(path_starts_with(base, base));
    }

    #[test]
    fn test_path_starts_with_windows_style_rejects_sibling() {
        let base = std::path::Path::new("C:\\Users\\keepn\\.openclaw\\agents");
        // Sibling not child
        let target = std::path::Path::new("C:\\Users\\keepn\\.openclaw\\agents-backup");
        assert!(!path_starts_with(target, base));
    }

    #[test]
    fn test_path_starts_with_windows_style_rejects_other_drive() {
        let base = std::path::Path::new("C:\\Users\\keepn\\.openclaw\\agents");
        let target = std::path::Path::new("D:\\Users\\keepn\\.openclaw\\agents\\foo.jsonl");
        assert!(!path_starts_with(target, base));
    }

    #[test]
    fn test_path_starts_with_handles_trailing_separator() {
        let base = std::path::Path::new("/Users/foo/");
        let target = std::path::Path::new("/Users/foo/bar");
        assert!(path_starts_with(target, base));
    }

    #[test]
    fn test_path_starts_with_unix_style_still_works() {
        let base = std::path::Path::new("/Users/foo/bar");
        let target = std::path::Path::new("/Users/foo/bar/baz/qux.jsonl");
        assert!(path_starts_with(target, base));
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

    // ===== v0.8.14 item I: canonicalize-based traversal defense =====

    /// 构造 AppPaths,default root 指向 tmpdir(让 .claude/... 视为 inside)
    fn make_test_paths_with_root(tmp: &tempfile::TempDir) -> AppPaths {
        let home = tmp.path().to_path_buf();
        AppPaths {
            home: home.clone(),
            default_root: RootSource {
                label: "default".to_string(),
                path: home.clone(),
                claude: Some(ClaudePaths::new(&home)),
                openclaw: None,
            },
            custom_roots: vec![],
        }
    }

    #[test]
    fn test_assert_within_any_root_accepts_existing_file_in_root() {
        // v0.8.14 item I: 合法现有文件应被接受 (canonicalize + re-check)
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths_with_root(&tmp);
        let claude_dir = tmp.path().join(".claude/projects/proj-a");
        std::fs::create_dir_all(&claude_dir).unwrap();
        let legit = claude_dir.join("sess.jsonl");
        std::fs::write(&legit, b"{\"type\":\"user\"}\n").unwrap();

        assert!(
            assert_within_any_root(&paths, &legit).is_ok(),
            "存在的合法文件应被接受"
        );
    }

    #[test]
    fn test_assert_within_any_root_canonicalize_blocks_traversal() {
        // v0.8.14 item I: `..` traversal — lexical-pass .claude,但 canonicalize
        // 后实际指向 root 外 — 应被拒绝。
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths_with_root(&tmp);
        let claude_dir = tmp.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).unwrap();

        // 创建 tmpdir/.claude/../evil.txt (= tmpdir/evil.txt)
        // 注意:这是真实文件,所以 canonicalize 能 resolve 它
        let evil_path = tmp.path().join(".claude/../evil.txt");
        std::fs::write(&evil_path, b"evil\n").unwrap();

        // 直接传 path string,不 canonicalize — lexical starts_with `.claude/` 应 PASS
        // 这是被 fix 之前的脆弱点。我们的 assert_within_any_root 现在应:
        // 1) lexical-passes → 走 canonicalize(re-check) → fails → Err
        assert!(
            assert_within_any_root(&paths, &evil_path).is_err(),
            "traversal 应被 canonicalize 检查拦截"
        );
    }

    #[test]
    fn test_assert_within_any_root_non_existent_inside_root_passes() {
        // v0.8.14 item I: 非存在 path 在 root 内 — 应被接受(向后兼容,
        // DB fallback 场景)
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths_with_root(&tmp);
        // canonicalize 失败(target 不存在),lexical 必须 PASS
        let ghost = tmp.path().join(".claude/projects/proj-a/ghost.jsonl");
        assert!(!ghost.exists());
        assert!(
            assert_within_any_root(&paths, &ghost).is_ok(),
            "非存在 path 在 root 内应被接受(DB fallback 场景)"
        );
    }

    #[test]
    fn test_assert_within_any_root_non_existent_outside_root_rejected() {
        // v0.8.14 item I: 非存在 path 在 root 外 — canonicalize 失败,
        // lexical 失败 → Err
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths_with_root(&tmp);
        let outside = tmp.path().join("not_claude/ghost.jsonl");
        assert!(!outside.exists());
        assert!(
            assert_within_any_root(&paths, &outside).is_err(),
            "非存在 path 在 root 外应被拒绝"
        );
    }

    #[test]
    fn test_assert_within_any_root_etc_passwd_rejected() {
        // v0.8.14 item I: 现实攻击 — /etc/passwd 存在,根是 .claude,
        // lexical starts_with `.claude` 失败;canonicalize 后仍在 /etc/passwd,
        // 仍失败 → Err
        let tmp = tempfile::tempdir().expect("tempdir");
        let paths = make_test_paths_with_root(&tmp);
        // 只在 /etc/passwd 真的存在时跑这条断言(macOS / Linux 通常都在)
        if Path::new("/etc/passwd").exists() {
            assert!(
                assert_within_any_root(&paths, Path::new("/etc/passwd")).is_err(),
                "/etc/passwd 应被拒绝"
            );
        }
    }
}
