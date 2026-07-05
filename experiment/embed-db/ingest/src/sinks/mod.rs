//! Sink trait — 把 SessionGraph 写出到不同后端

use anyhow::Result;

use crate::graph::SessionGraph;

/// 各 sink 共用接口
pub trait Sink: Send {
    /// 名字(给 log 用)
    fn name(&self) -> &'static str;

    /// 写一个 SessionGraph
    fn write(&mut self, g: &SessionGraph) -> Result<()>;

    /// 收尾(可选 flush / close)
    fn finalize(&mut self) -> Result<()> {
        Ok(())
    }
}

// stdout sink — S0 阶段唯一实现
pub mod stdout;

pub use stdout::StdoutSink;
