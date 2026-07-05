//! CLI 参数定义(clap derive)
//!
//! 设计原则:
//! - `--out` 选 `stdout | surreal | parquet | sqlite` (S0 只实现 stdout)
//! - `--path` 接受多个 (e.g. `~/.claude/projects` + `~/.openclaw/agents`)
//! - 必填 `--path` — 不让用户误把整个 home 灌进去

use std::path::PathBuf;

use clap::{Parser, ValueEnum};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum SinkKind {
    Stdout,
    Surreal,
    Parquet,
    Sqlite,
}

#[derive(Parser, Debug)]
#[command(version, about = "OpenClaw session ingest — 实验分支 PoC")]
pub struct Args {
    /// 子命令
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Parser, Debug)]
pub enum Cmd {
    /// 扫描一个或多个 JSONL 根目录,产出 SessionGraph 流
    Ingest {
        /// 根目录路径 (可重复 -p /Users/x/.claude/projects -p /Users/x/.openclaw/agents)
        #[arg(short, long, value_name = "DIR", required = true)]
        path: Vec<PathBuf>,

        /// 输出 sink
        #[arg(long, value_enum, default_value_t = SinkKind::Stdout)]
        out: SinkKind,

        /// sqlite 输出路径 (仅 --out sqlite 有效)
        #[arg(long)]
        sqlite_path: Option<PathBuf>,

        /// surreal 输出路径 (仅 --out surreal 有效)
        #[arg(long)]
        surreal_path: Option<PathBuf>,

        /// parquet 输出目录 (仅 --out parquet 有效)
        #[arg(long)]
        parquet_dir: Option<PathBuf>,

        /// 最大并发解析数 (默认 4)
        #[arg(long, default_value_t = 4)]
        jobs: usize,

        /// 输出汇总统计 (每个 session 1 行)
        #[arg(long)]
        stats: bool,
    },
}
