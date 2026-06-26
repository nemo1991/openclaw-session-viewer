/**
 * UnknownBlock 组件可视化测试 — 透传到 UnknownBlockCard
 *
 * 覆盖:
 * - 有 payload → <details> 折叠卡
 * - 无 payload → 退化 pill
 */

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UnknownBlock } from "./UnknownBlock";
import type { NormalizedBlockFE } from "../../lib/api";

describe("UnknownBlock", () => {
  it("有 payload → <details> 折叠卡", () => {
    const block: NormalizedBlockFE = { kind: "totally-future", payload: { foo: "bar" } };
    const { container } = render(<UnknownBlock block={block} />);
    expect(container.querySelector("details")).toBeInTheDocument();
  });

  it("无 payload → 退化 pill", () => {
    const block: NormalizedBlockFE = { kind: "totally-future" };
    const { container } = render(<UnknownBlock block={block} />);
    expect(container.querySelector(".unknown-pill")).toBeInTheDocument();
  });
});
