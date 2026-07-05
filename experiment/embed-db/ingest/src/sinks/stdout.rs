//! stdout sink — 把每个 SessionGraph 序列化为一行 JSON
//!
//! 格式: NDJSON (一行一个 JSON object)
//! 便于下游(`jq` / streaming 管道 / Surreal import script / etc.) 直接消费

use std::io::{self, BufWriter, Stdout, Write};

use anyhow::Result;
use serde::Serialize;

use crate::graph::SessionGraph;
use crate::sinks::Sink;

pub struct StdoutSink {
    out: BufWriter<Stdout>,
    count: u64,
}

impl StdoutSink {
    pub fn new() -> Self {
        Self {
            out: BufWriter::new(io::stdout()),
            count: 0,
        }
    }
}

impl Default for StdoutSink {
    fn default() -> Self {
        Self::new()
    }
}

/// 序列化包装:node + edges 平摊到一个 JSON 对象里
#[derive(Serialize)]
struct FlatSession<'a> {
    #[serde(flatten)]
    node: &'a crate::graph::SessionNode,
    edges: &'a [crate::graph::Edge],
}

impl Sink for StdoutSink {
    fn name(&self) -> &'static str {
        "stdout"
    }

    fn write(&mut self, g: &SessionGraph) -> Result<()> {
        let flat = FlatSession { node: &g.node, edges: &g.edges };
        let line = serde_json::to_string(&flat)?;
        writeln!(self.out, "{}", line)?;
        self.count += 1;
        Ok(())
    }

    fn finalize(&mut self) -> Result<()> {
        self.out.flush()?;
        eprintln!("[stdout-sink] wrote {} sessions", self.count);
        Ok(())
    }
}
