/**
 * v0.9.21 (M6): MetaBlockRouter 单元测试
 *
 * 测试 4 路 router 的 dispatcher 逻辑:
 * - L2 chart label(6 个)→ `<ChartBlock>`
 * - L4 attachment label(13 个)→ `<AttachmentBlock>`
 * - L3 event meta(其他)→ `<EventMetaBlock>`
 * - 未知 label(无 schema 路由)→ `<EventMetaBlock>` (兜底,不是 UnknownBlockCard)
 *
 * 旧 `MetaBlock.test.tsx` 已删除(M3 已经把 fallback 改为 EventMetaBlock
 * 而非 UnknownBlockCard),本测试只覆盖 router 路由正确性,具体 layer
 * 渲染细节在 `ChartBlock.test.tsx` / `AttachmentBlock.test.tsx` /
 * `EventMetaBlock.test.tsx` 里覆盖。
 *
 * v0.9.25 (M8): 加 2 个 regression test 验证 snake/camel 撤兼容 —
 * chart 必须从 snake payload 渲染,只给 camelCase key 时 fallback 到
 * UnknownBlockCard (camel 半边已 dead)。
 */

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaBlockRouter } from "./MetaBlockRouter";
import type { NormalizedBlockFE } from "../../lib/api";

const chartLabels = [
  "context.apply_compaction",
  "llm.tools_snapshot",
  "usage.chart",
  "request.chart",
  "todos.chart",
  "ai-title.chart",
];

const attachmentLabels = [
  "task_reminder",
  "plan_mode",
  "pr_link",
  "agent_name",
  "agent_listing",
  "skill_listing",
  "file_snapshot",
  "file-history-snapshot",
  "invoked_skills",
  "plan_file_reference",
  "compact_file_reference",
  "attached_file",
  "queued_command",
  "queue_operation",
];

const eventMetaLabels = [
  "metadata",
  "config.update",
  "permission.set_mode",
  "tools.set_active_tools",
  "permission.record_approval_result",
  "model_change",
  "compaction",
  "label",
  "title",
  "last-prompt",
];

const makeBlock = (label: string, payload?: Record<string, unknown>): NormalizedBlockFE =>
  ({
    id: `b-${label}`,
    kind: "meta",
    label,
    payload: payload ?? {},
  }) as unknown as NormalizedBlockFE;

// 6 chart 各自需要的最小 payload,否则 fallback 到 UnknownBlockCard
const chartPayload: Record<string, Record<string, unknown>> = {
  "context.apply_compaction": { summary: "test", tokens_before: 100, tokens_after: 50 },
  "llm.tools_snapshot": { tools: ["read", "write"] },
  "usage.chart": {
    buckets: [{ input_other: 1, output: 1, input_cache_read: 1 }],
    total_tokens: 3,
  },
  "request.chart": {
    buckets: [{ max_tokens_avg: 100, max_tokens_max: 100, max_tokens_min: 100 }],
    request_count: 1,
  },
  "todos.chart": {
    buckets: [{ done_count: 1, in_progress_count: 0, pending_count: 0 }],
    update_count: 1,
  },
  "ai-title.chart": {
    buckets: [{ event_count: 1, ai_count: 1, custom_count: 0 }],
    event_count: 1,
  },
};

describe("MetaBlockRouter", () => {
  it.each(chartLabels)("L2 chart label %s → ChartBlock (block-meta-info wrapper)", (label) => {
    const { container } = render(
      <MetaBlockRouter block={makeBlock(label, chartPayload[label])} label={label} />
    );
    // 6 chart sub-component 各自有独立 wrapper class (compaction-meta / usage-chart-meta 等),
    // 但都用 .block-meta-info.meta-block-flat 公共 wrapper
    expect(container.querySelector(".block-meta-info.meta-block-flat")).toBeInTheDocument();
  });

  it.each(attachmentLabels)("L4 attachment label %s → AttachmentBlock", (label) => {
    const { container } = render(<MetaBlockRouter block={makeBlock(label)} label={label} />);
    expect(container.querySelector(".attachment-block-meta")).toBeInTheDocument();
  });

  it.each(eventMetaLabels)("L3 event meta label %s → EventMetaBlock", (label) => {
    render(<MetaBlockRouter block={makeBlock(label)} label={label} />);
    expect(screen.getByTestId("event-meta-block")).toBeInTheDocument();
  });

  it("未知 label 也走 EventMetaBlock(M3 之后 fallback 改用 EventMetaBlock,而非 UnknownBlockCard)", () => {
    render(<MetaBlockRouter block={makeBlock("unknown.kind")} label="unknown.kind" />);
    expect(screen.getByTestId("event-meta-block")).toBeInTheDocument();
    expect(screen.queryByTestId("unknown-block")).not.toBeInTheDocument();
  });

  it("透传 parentJsonlPath 到 AttachmentBlock", () => {
    const { container } = render(
      <MetaBlockRouter
        block={makeBlock("plan_mode")}
        label="plan_mode"
        parentJsonlPath="/tmp/session.jsonl"
      />
    );
    expect(container.querySelector(".attachment-block-meta")).toBeInTheDocument();
  });

  // ===== v0.9.25 (M8) regression: snake/camel 撤兼容 =====
  // chart block payload 必须 snake (Rust `data.insert("snake", ...)`),
  // camel 半边已 dead — 防止以后又有人加 camel fallback 搞反方向。

  it("usage.chart 从 snake payload 正常 render (buckets/input_other/total_tokens)", () => {
    const { container } = render(
      <MetaBlockRouter
        block={makeBlock("usage.chart", {
          buckets: [{ input_other: 100, output: 50, input_cache_read: 25 }],
          total_tokens: 175,
        })}
        label="usage.chart"
      />
    );
    // UsageChartSvg 渲染 → bar 数 = buckets.length (1)
    expect(container.querySelector(".usage-chart-svg")).toBeInTheDocument();
    // 不应 fallback 到 UnknownBlockCard
    expect(container.querySelector(".unknown-block-card")).not.toBeInTheDocument();
  });

  it("usage.chart 只给 camelCase key → fallback 到 UnknownBlockCard (camel 半边已 dead)", () => {
    const { container } = render(
      <MetaBlockRouter
        block={makeBlock("usage.chart", {
          buckets: [{ inputOther: 100, output: 50, inputCacheRead: 25 }],
          totalTokens: 175,
        })}
        label="usage.chart"
      />
    );
    // M8 后 camelCase-only payload 拿不到任何 snake key:
    // total_tokens → undefined → UsageChartMetaBlock 走 UnknownBlockCard fallback
    expect(container.querySelector(".unknown-block-card")).toBeInTheDocument();
    expect(container.querySelector(".usage-chart-svg")).not.toBeInTheDocument();
  });
});
