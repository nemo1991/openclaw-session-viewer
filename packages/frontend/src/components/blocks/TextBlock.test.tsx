/**
 * TextBlock 组件可视化测试 — Markdown 渲染透传
 */

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TextBlock } from "./TextBlock";
import type { NormalizedBlockFE } from "../../lib/api";

describe("TextBlock", () => {
  it("简单文本透传", () => {
    const block: NormalizedBlockFE = { kind: "text", text: "hello world" };
    const { container } = render(<TextBlock block={block} />);
    expect(container.textContent).toContain("hello world");
  });

  it("Markdown 语法:**bold** 渲染成 <strong>", () => {
    const block: NormalizedBlockFE = { kind: "text", text: "**bold**" };
    const { container } = render(<TextBlock block={block} />);
    const strong = container.querySelector("strong");
    expect(strong).toBeInTheDocument();
    expect(strong?.textContent).toBe("bold");
  });

  it("缺 text → 返回 null 不崩(parseMessageText 把空当无内容)", () => {
    const block: NormalizedBlockFE = { kind: "text" };
    const { container } = render(<TextBlock block={block} />);
    // v0.5.0+: TextBlock 返回 null 而不是空 div — 没必要渲染空容器
    expect(container.querySelector(".block-text")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
