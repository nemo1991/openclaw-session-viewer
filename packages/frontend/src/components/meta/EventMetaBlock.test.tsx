/**
 * v0.9.20 (M3): EventMetaBlock — L3 layer 单元测试
 *
 * 单事件 inline meta (Kimi metadata / config.update / OpenClaw model_change /
 * 等) 的通用渲染。Label + payload 字段表 + 折叠交互。
 *
 * 测试覆盖:
 * - 渲染 label 为 kind badge
 * - payload 字段表 (key-value)
 * - 顶层字段 + payload 双源
 * - 默认折叠 (>MAX_TABLE_ROWS 字段)
 * - 空 payload / 完全无字段 → UnknownBlockCard 兜底
 * - event-meta-block-meta wrapper class
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EventMetaBlock } from "./EventMetaBlock";
import type { NormalizedBlockFE } from "../../lib/api";

beforeEach(() => {
  cleanup();
});

function renderEvent(block: NormalizedBlockFE) {
  return render(<EventMetaBlock block={block} />);
}

describe("EventMetaBlock (M3 — L3 layer, inline meta)", () => {
  it("渲染 label 为 kind badge + 字段表", () => {
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "config.update",
      payload: { key1: "value1", key2: 42 },
    };
    const { container } = renderEvent(block);
    expect(container.querySelector(".event-meta-block-meta")).toBeInTheDocument();
    expect(screen.getByText(/📄 config.update/)).toBeInTheDocument();
    expect(screen.getByTestId("event-meta-row-key1")).toBeInTheDocument();
    expect(screen.getByTestId("event-meta-row-key2")).toBeInTheDocument();
    expect(screen.getByText("value1")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("顶层字段 + payload 双源都渲染", () => {
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "model_change",
      payload: { from: "claude-opus-4-5" },
      model: "claude-sonnet-5",
    };
    renderEvent(block);
    // 顶层 model
    expect(screen.getByTestId("event-meta-row-model")).toBeInTheDocument();
    // payload from
    expect(screen.getByTestId("event-meta-row-from")).toBeInTheDocument();
  });

  it("完全空 payload + 无 label → UnknownBlockCard 兜底", () => {
    const block: NormalizedBlockFE = { kind: "meta" };
    const { container } = renderEvent(block);
    // EventMetaBlock 不应渲染(完全无内容时兜底到 UnknownBlockCard)
    expect(container.querySelector(".event-meta-block-meta")).toBeNull();
    // UnknownBlockCard 接管渲染(空 payload 时退化为 .unknown-pill)
    expect(container.querySelector(".unknown-pill")).toBeInTheDocument();
  });

  it("数组 payload preview (前 8 项 + 溢出标记)", () => {
    const arr = Array.from({ length: 12 }, (_, i) => `i${i}`);
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "list-event",
      payload: { items: arr },
    };
    renderEvent(block);
    // preview 应该是 "[i0, i1, ..., +4]"
    expect(screen.getByText(/i7/)).toBeInTheDocument();
    // overflow 标记
    expect(screen.getByText(/\+4/)).toBeInTheDocument();
  });

  it("长字符串 preview (>240 字符截断)", () => {
    const longStr = "a".repeat(300);
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "long-event",
      payload: { data: longStr },
    };
    renderEvent(block);
    // 240 字符后加 …
    const valueCell = screen.getByTestId("event-meta-row-data").querySelector(".meta-event-value");
    expect(valueCell?.textContent).toMatch(/^a+…$/);
    expect(valueCell?.textContent?.length).toBeLessThanOrEqual(241);
  });

  it("折叠: >16 字段默认隐藏溢出", () => {
    const fields: Record<string, number> = {};
    for (let i = 0; i < 20; i++) fields[`field_${i}`] = i;
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "many-fields",
      payload: fields,
    };
    const { container } = renderEvent(block);
    // 默认折叠 → 只渲染前 16 行
    expect(screen.getByTestId("event-meta-row-field_0")).toBeInTheDocument();
    expect(screen.queryByTestId("event-meta-row-field_19")).toBeNull();
    // 折叠按钮
    const toggle = screen.getByTestId("event-meta-toggle");
    expect(toggle.textContent).toContain("展开剩余");
  });
});
