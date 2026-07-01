//! ingest CLI — 入口
//!
//! 工作流:
//! 1. parse args (clap)
//! 2. 对每个 --path 调用 scanner::list_jsonl_files
//! 3. 对每个 JSONL 调 parser::parse_session → SessionGraph
//! 4. 写出到 sink (stdout / surreal / parquet / sqlite)
//!
//! S0 阶段只实现 stdout sink。

use anyhow::{Context, Result};
use clap::Parser;

mod cli;
mod graph;
mod parser;
mod scanner;
mod sinks;

use cli::{Args, Cmd, SinkKind};
use graph::SessionGraph;
use scanner::list_jsonl_files;
use sinks::{Sink, StdoutSink};

fn build_sink(kind: SinkKind, sqlite_path: Option<std::path::PathBuf>, _surreal_path: Option<std::path::PathBuf>, _parquet_dir: Option<std::path::PathBuf>) -> Result<Box<dyn Sink>> {
    match kind {
        SinkKind::Stdout => Ok(Box::new(StdoutSink::new())),
        SinkKind::Sqlite => {
            let p = sqlite_path.context("--out sqlite 需要 --sqlite-path")?;
            eprintln!("[ingest] --out sqlite 尚未实现 (计划 S2+),fallback 到 stdout sink");
            // TODO S2: 引入 rusqlite + sqlite-vec
            let _ = p;
            Ok(Box::new(StdoutSink::new()))
        }
        SinkKind::Surreal => {
            eprintln!("[ingest] --out surreal 计划在 S1 实现 (G1 PoC)");
            Ok(Box::new(StdoutSink::new()))
        }
        SinkKind::Parquet => {
            eprintln!("[ingest] --out parquet 计划在 S2 实现 (G2 PoC)");
            Ok(Box::new(StdoutSink::new()))
        }
    }
}

fn run_ingest(cmd: Cmd) -> Result<()> {
    let Cmd::Ingest { path, out, sqlite_path, surreal_path, parquet_dir, jobs: _, stats: _ } = cmd;

    let mut sink = build_sink(out, sqlite_path, surreal_path, parquet_dir)?;
    eprintln!("[ingest] sink = {}", sink.name());

    let mut total = 0u64;
    let mut failed = 0u64;
    let mut by_source = std::collections::HashMap::new();

    for dir in &path {
        eprintln!("[ingest] scanning {}", dir.display());
        let files = list_jsonl_files(dir);
        eprintln!("[ingest] found {} jsonl files in {}", files.len(), dir.display());

        for f in files {
            match parser::parse_session(&f) {
                Ok(g) => {
                    *by_source.entry(format!("{:?}", g.node.source)).or_insert(0u64) += 1;
                    if let Err(e) = sink.write(&g) {
                        eprintln!("[ingest] write failed for {}: {}", f.display(), e);
                        failed += 1;
                    } else {
                        total += 1;
                    }
                }
                Err(e) => {
                    eprintln!("[ingest] parse failed for {}: {:#}", f.display(), e);
                    failed += 1;
                }
            }
        }
    }

    sink.finalize()?;

    eprintln!("[ingest] done: total={} failed={}", total, failed);
    for (k, v) in by_source {
        eprintln!("[ingest]   source[{}] = {}", k, v);
    }
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    match args.cmd {
        Cmd::Ingest { .. } => run_ingest(args.cmd),
    }
}

// Touch unused import to avoid dead_code warning during transitional phase
#[allow(dead_code)]
fn _ensure_session_graph_used(_: &SessionGraph) {}
