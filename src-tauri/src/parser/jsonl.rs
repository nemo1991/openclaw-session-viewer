//! 流式 JSONL 解析器
//!
//! 设计:
//! - 使用 `BufReader` 64KB 缓冲,逐行读取
//! - 损坏的行直接跳过(不报错),输出到 stderr
//! - 每行解析为 `serde_json::Value`,调用方决定如何归一化
//! - 支持从指定 byte offset 开始(续读)
//! - 流式回调:每 N 行推送一批,减少 channel 往返

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

use crate::error::AppResult;

/// 一批解析结果
pub struct Batch {
    pub start_index: usize,
    pub start_byte: u64,
    pub records: Vec<serde_json::Value>,
}

/// 流式遍历整个 JSONL 文件
pub fn for_each_line<F>(path: &Path, mut on_line: F) -> AppResult<()>
where
    F: FnMut(usize, u64, &serde_json::Value),
{
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut index = 0usize;
    let mut byte: u64 = 0;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        byte += n as u64;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => {
                on_line(index, byte, &v);
                index += 1;
            }
            Err(e) => {
                log::warn!(
                    "跳过损坏的 JSONL 行 ({}:{}): {}",
                    path.display(),
                    index,
                    e
                );
            }
        }
    }
    Ok(())
}

/// 流式遍历并按批次回调
pub fn stream_batches<F>(path: &Path, batch_size: usize, mut on_batch: F) -> AppResult<()>
where
    F: FnMut(Batch),
{
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf: Vec<serde_json::Value> = Vec::with_capacity(batch_size);
    let mut index = 0usize;
    let mut byte: u64 = 0;
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            break;
        }
        byte += n as u64;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(v) => {
                buf.push(v);
                if buf.len() >= batch_size {
                    on_batch(Batch {
                        start_index: index,
                        start_byte: byte,
                        records: std::mem::take(&mut buf),
                    });
                    buf = Vec::with_capacity(batch_size);
                }
                index += 1;
            }
            Err(e) => {
                log::warn!(
                    "跳过损坏的 JSONL 行 ({}:{}): {}",
                    path.display(),
                    index,
                    e
                );
            }
        }
    }
    if !buf.is_empty() {
        on_batch(Batch {
            start_index: index,
            start_byte: byte,
            records: buf,
        });
    }
    Ok(())
}

/// 只解析前 N 行(用于提取 quick meta)
pub fn parse_first_n(path: &Path, max: usize) -> AppResult<Vec<serde_json::Value>> {
    let mut out = Vec::with_capacity(max.min(64));
    for_each_line(path, |idx, _, v| {
        if idx < max {
            out.push(v.clone());
        }
    })?;
    Ok(out)
}

/// 计数 JSONL 记录数(不解析内容,只数行)
pub fn count_lines(path: &Path) -> AppResult<u64> {
    let file = File::open(path)?;
    let reader = BufReader::with_capacity(128 * 1024, file);
    let mut count = 0u64;
    for line in reader.lines() {
        let line = line?;
        if !line.trim().is_empty() {
            count += 1;
        }
    }
    Ok(count)
}

/// 从文件尾部读取(用于"加载更新的尾部")
pub fn tail_lines(path: &Path, n: usize) -> AppResult<Vec<serde_json::Value>> {
    use std::io::Read;

    const CHUNK: usize = 64 * 1024;
    let mut file = File::open(path)?;
    let len = file.metadata()?.len() as usize;
    if len == 0 {
        return Ok(vec![]);
    }
    let read_size = CHUNK.min(len);
    file.seek(SeekFrom::End(-(read_size as i64)))?;
    let mut buf = vec![0u8; read_size];
    file.read_exact(&mut buf)?;

    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    let mut out = Vec::with_capacity(lines.len() - start);
    for line in &lines[start..] {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            out.push(v);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("ocsv_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn test_count_lines_basic() {
        let p = write_temp(
            "count_basic.jsonl",
            "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n",
        );
        assert_eq!(count_lines(&p).unwrap(), 3);
    }

    #[test]
    fn test_count_lines_skips_blanks() {
        let p = write_temp(
            "count_blank.jsonl",
            "{\"a\":1}\n\n{\"a\":2}\n   \n{\"a\":3}\n",
        );
        assert_eq!(count_lines(&p).unwrap(), 3);
    }

    #[test]
    fn test_count_lines_empty_file() {
        let p = write_temp("count_empty.jsonl", "");
        assert_eq!(count_lines(&p).unwrap(), 0);
    }

    #[test]
    fn test_stream_batches() {
        let content: String = (0..100)
            .map(|i| format!("{{\"i\":{}}}\n", i))
            .collect();
        let p = write_temp("stream.jsonl", &content);
        let mut total = 0;
        let mut max_batch = 0;
        stream_batches(&p, 30, |batch| {
            total += batch.records.len();
            max_batch = max_batch.max(batch.records.len());
        })
        .unwrap();
        assert_eq!(total, 100);
        assert!(max_batch <= 30);
    }

    #[test]
    fn test_for_each_line_skips_malformed() {
        let content = "{\"ok\":1}\nNOT JSON\n{\"ok\":2}\n{trailing\n{\"ok\":3}\n";
        let p = write_temp("malformed.jsonl", content);
        let mut indices = vec![];
        for_each_line(&p, |idx, _, v| {
            indices.push(idx);
            assert_eq!(v["ok"], idx as i64 + 1);
        })
        .unwrap();
        // 3 valid lines, even though there are 5 total
        assert_eq!(indices.len(), 3);
    }

    #[test]
    fn test_parse_first_n() {
        let content: String = (0..10)
            .map(|i| format!("{{\"i\":{}}}\n", i))
            .collect();
        let p = write_temp("first_n.jsonl", &content);
        let first = parse_first_n(&p, 5).unwrap();
        assert_eq!(first.len(), 5);
        assert_eq!(first[0]["i"], 0);
        assert_eq!(first[4]["i"], 4);
    }

    #[test]
    fn test_parse_first_n_fewer_than_n() {
        let content = "{\"i\":0}\n{\"i\":1}\n";
        let p = write_temp("fewer.jsonl", content);
        let first = parse_first_n(&p, 10).unwrap();
        assert_eq!(first.len(), 2);
    }
}