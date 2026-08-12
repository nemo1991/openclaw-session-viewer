/**
 * v0.9.18 (M2): ToolsSnapshotChartMetaBlock — 从 MetaBlock.tsx 抽出
 *
 * v0.9.13 引入 llm.tools_snapshot 专属渲染。dcwin11 bpm-large (6040 行)
 * 1 条 llm.tools_snapshot, 24 个 tool,每个带 300-500 字符 description,
 * SHA256 hash 作 LLM 缓存键。indigo accent border 跟 teal compaction 区分。
 *
 * M2 抽到独立 file,ChartBlock dispatcher 按 label 路由。
 */

import { useState } from "react";
import { UnknownBlockCard } from "../../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../../lib/api";
import { readMetaField } from "./chart-utils";

export function ToolsSnapshotChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  // v0.9.25 (M8): snapshotHash (camel) 和 hash (inbound Kimi wire key)
  // 都是 dead code — Rust emit "snapshot_hash" (snake) (kimi.rs:764),
  // "hash" 是 inbound Kimi wire key,re-emit 时已转 snake。3-key 简化为
  // 单 snake key。
  const hash =
    typeof readMetaField(block, "snapshot_hash") === "string"
      ? (readMetaField(block, "snapshot_hash") as string)
      : null;
  const toolNames = (readMetaField(block, "tool_names") as string[]) ?? [];
  const toolDescs = (readMetaField(block, "tool_descriptions") as Record<string, string>) ?? {};
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const rawTools = (pl.tools as Array<{ name?: string }>) ?? [];

  // 缺关键字段 → fallback (老 wire / 老 DB 缓存)
  if (toolNames.length === 0 && rawTools.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const [showAll, setShowAll] = useState(false);
  const visibleNames = showAll ? toolNames : toolNames.slice(0, 12);
  const overflow = toolNames.length - visibleNames.length;

  return (
    <div className="block-meta-info meta-block-flat tools-snapshot-meta">
      <span className="meta-kind-badge">🔧 tools snapshot</span>
      <span className="meta-primary-text" data-testid="tools-snapshot-count">
        {toolNames.length} 个 tool 配置
      </span>
      {hash && (
        <span
          className="meta-sub"
          title={`SHA256 hash (LLM cache key): ${hash}`}
          data-testid="tools-snapshot-hash"
        >
          {hash.slice(0, 8)}…
        </span>
      )}
      <div className="meta-list tools-snapshot-list" data-testid="tools-snapshot-list">
        {visibleNames.map((name) => {
          const desc = toolDescs[name];
          return (
            <span
              key={name}
              className="meta-tag tools-snapshot-tag"
              title={desc ? `${name}: ${desc}` : name}
            >
              {name}
            </span>
          );
        })}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="tools-snapshot-toggle"
          onClick={() => setShowAll((v) => !v)}
          title={showAll ? "收起 tool 列表" : `展开剩余 ${overflow} 个 tool`}
        >
          {showAll ? "收起" : `展开剩余 ${overflow} 个 tool`}
        </button>
      )}
    </div>
  );
}
