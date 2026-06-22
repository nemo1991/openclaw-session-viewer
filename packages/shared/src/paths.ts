/**
 * Claude Code 项目路径编码/解码
 * 参考 openclaw 源码: src/commands/doctor-claude-cli.ts:74-79
 */

/** 路径编码最大长度（不含 hash 后缀） */
export const MAX_SANITIZED_PROJECT_LENGTH = 200;

/**
 * 将绝对路径编码为 Claude Code 使用的项目目录名
 * 例: /Users/foo/bar → -Users-foo-bar
 */
export function encodeClaudeProjectKey(absPath: string): string {
  const sanitized = absPath.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_PROJECT_LENGTH) {
    return sanitized;
  }
  const hash = simpleHash36(absPath);
  return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_LENGTH)}-${hash}`;
}

/**
 * 将项目目录名解码回推测的原始路径
 * 注意: 由于 `-` 是占位符,无法 100% 还原原路径(数字 vs 单词混淆)
 */
export function decodeClaudeProjectKey(key: string): string | null {
  if (!key.startsWith("-")) return null;
  return "/" + key.slice(1).replace(/-/g, "/");
}

/** 简单 32-bit FNV-like 哈希 → base36 */
function simpleHash36(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(hash, 31) + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Claude Code 路径布局 */
export interface ClaudePaths {
  /** ~/.claude */
  home: string;
  /** ~/.claude/projects */
  projectsDir: string;
  /** ~/.claude/sessions (live PID metadata) */
  sessionsDir: string;
  /** ~/.claude/session-env */
  sessionEnvDir: string;
  /** ~/.claude/tasks */
  tasksDir: string;
  /** ~/.claude/shell-snapshots */
  shellSnapshotsDir: string;
  /** ~/.claude/backups */
  backupsDir: string;
  /** ~/.claude/file-history */
  fileHistoryDir: string;
  /** ~/.claude/plugins */
  pluginsDir: string;
  /** ~/.claude/skills */
  skillsDir: string;
  /** ~/.claude/cache */
  cacheDir: string;
  /** ~/.claude/debug */
  debugDir: string;
  /** ~/.claude/paste-cache */
  pasteCacheDir: string;
  /** ~/.claude/pua */
  puaDir: string;
  /** ~/.claude/downloads */
  downloadsDir: string;
  /** ~/.claude/history.jsonl */
  historyFile: string;
  /** ~/.claude/settings.json */
  settingsFile: string;
  /** ~/.claude.json (用户级配置,与 settings.json 不同) */
  userConfigFile: string;
}

/** OpenClaw 路径布局 */
export interface OpenClawPaths {
  /** ~/.openclaw */
  home: string;
  /** ~/.openclaw/agents */
  agentsDir: string;
}

/** 解析 Claude Code 路径布局 */
export function resolveClaudePaths(homeDir: string): ClaudePaths {
  const home = joinPath(homeDir, ".claude");
  return {
    home,
    projectsDir: joinPath(home, "projects"),
    sessionsDir: joinPath(home, "sessions"),
    sessionEnvDir: joinPath(home, "session-env"),
    tasksDir: joinPath(home, "tasks"),
    shellSnapshotsDir: joinPath(home, "shell-snapshots"),
    backupsDir: joinPath(home, "backups"),
    fileHistoryDir: joinPath(home, "file-history"),
    pluginsDir: joinPath(home, "plugins"),
    skillsDir: joinPath(home, "skills"),
    cacheDir: joinPath(home, "cache"),
    debugDir: joinPath(home, "debug"),
    pasteCacheDir: joinPath(home, "paste-cache"),
    puaDir: joinPath(home, "pua"),
    downloadsDir: joinPath(home, "downloads"),
    historyFile: joinPath(home, "history.jsonl"),
    settingsFile: joinPath(home, "settings.json"),
    userConfigFile: joinPath(homeDir, ".claude.json"),
  };
}

/** 解析 OpenClaw 路径布局 */
export function resolveOpenClawPaths(homeDir: string): OpenClawPaths {
  return {
    home: joinPath(homeDir, ".openclaw"),
    agentsDir: joinPath(homeDir, ".openclaw", "agents"),
  };
}

/** 跨平台路径拼接 (浏览器/Rust 端都用 /)
 *
 * 接受 (string | null | undefined) 数组,空值会被忽略。
 */
export function joinPath(...parts: Array<string | null | undefined>): string {
  const filtered = parts.filter((p): p is string => p != null && p !== "");
  if (filtered.length === 0) return "";

  const first = filtered[0]!;
  // 首段以 "/" 开头 → 保留绝对路径前缀
  const isAbsolute = first.startsWith("/");
  // 所有段都去掉首尾斜杠(绝对路径前缀后面手动加)
  const trimmed = filtered.map((p) => p.replace(/^\/+|\/+$/g, ""));
  const nonEmpty = trimmed.filter((p) => p.length > 0);
  if (nonEmpty.length === 0) return isAbsolute ? "/" : "";
  const joined = nonEmpty.join("/");
  return isAbsolute ? `/${joined}` : joined;
}

/** 获取用户主目录 (浏览器侧用) */
export function guessHomeDir(): string {
  // 浏览器中无法直接获取,需由后端传入
  return "";
}
