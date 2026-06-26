// @vitest-environment jsdom
/**
 * UnknownBlockCard 组件可视化测试
 *
 * 覆盖:
 * - 有 payload → <details> 折叠卡
 * - 无 payload → 退化 pill (div.unknown-pill)
 * - 头部显示 kind badge + label + "N 字段" 计数
 * - 展开后显示字段表
 * - 启发式 hint pills (tool_use / thinking / image 等)
 * - 复制按钮 + 报告链接存在
 * - 字段值:字符串 (含截断) / null / 数字 / 布尔 / 对象 (含折叠)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { UnknownBlockCard } from "./UnknownBlockCard";

// jsdom 不实现 clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(() => Promise.resolve()),
  },
});

describe("UnknownBlockCard", () => {
  beforeEach(() => cleanup());

  it("有 payload → <details> 折叠卡", () => {
    render(<UnknownBlockCard block={{ kind: "future-block", payload: { foo: "bar" } }} />);
    const details = document.querySelector("details");
    expect(details).toBeInTheDocument();
  });

  it("无 payload → 退化 pill (无 details)", () => {
    render(<UnknownBlockCard block={{ kind: "empty" }} />);
    const pill = document.querySelector(".unknown-pill");
    expect(pill).toBeInTheDocument();
    expect(document.querySelector("details")).not.toBeInTheDocument();
  });

  it("头部显示 kind badge + label", () => {
    render(
      <UnknownBlockCard
        block={{ kind: "future-block", label: "future-label", payload: { x: 1 } }}
      />
    );
    expect(screen.getByText("future-label")).toBeInTheDocument();
  });

  it("头部显示 'N 字段' 计数", () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { a: 1, b: 2, c: 3 } }} />);
    expect(screen.getByText("3 字段")).toBeInTheDocument();
  });

  it("label/payload 字段不计入 'N 字段' 计数", () => {
    // 真实数据里 payload 里可能有嵌套 label/payload,应过滤
    render(
      <UnknownBlockCard
        block={{
          kind: "x",
          label: "ignored",
          payload: { label: "nested", payload: {}, foo: "bar" },
        }}
      />
    );
    // 只算顶层 foo
    expect(screen.getByText("1 字段")).toBeInTheDocument();
  });

  it("展开 details 后显示字段表", () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { a: "1", b: "2" } }} />);
    const details = document.querySelector("details") as HTMLElement;
    fireEvent.click(details.querySelector("summary")!);
    // 字段名 a / b
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("启发式 hint:有 id+name+input → tool_use (90%)", () => {
    render(
      <UnknownBlockCard
        block={{
          kind: "x",
          payload: { id: "t1", name: "Bash", input: { command: "ls" } },
        }}
      />
    );
    // hint pill 文案: "tool_use · 90%"
    expect(screen.getByText(/tool_use · 90%/)).toBeInTheDocument();
  });

  it("启发式 hint:有 thinking 字段 → thinking (80%)", () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { thinking: "analyzing..." } }} />);
    expect(screen.getByText(/thinking · 80%/)).toBeInTheDocument();
  });

  it("启发式 hint:有 mediaType → image (80%)", () => {
    render(
      <UnknownBlockCard block={{ kind: "x", payload: { mediaType: "image/png", data: "abc" } }} />
    );
    expect(screen.getByText(/image · 80%/)).toBeInTheDocument();
  });

  it("启发式 hint:有 tool_use_id → tool_result (85%)", () => {
    render(
      <UnknownBlockCard block={{ kind: "x", payload: { tool_use_id: "t1", content: "ok" } }} />
    );
    expect(screen.getByText(/tool_result · 85%/)).toBeInTheDocument();
  });

  it("复制按钮存在 + 点击调 clipboard.writeText", async () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { foo: "bar" } }} />);
    const copyBtn = screen.getByText("📋 复制") as HTMLElement;
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    // 调用的参数含 foo:bar
    const call = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain('"foo"');
    expect(call[0]).toContain('"bar"');
  });

  it("报告 GitHub issue 链接存在 + 含 kind", () => {
    render(<UnknownBlockCard block={{ kind: "future-thing", payload: { x: 1 } }} />);
    const reportLink = screen.getByText("🐛 报告") as HTMLAnchorElement;
    expect(reportLink.tagName).toBe("A");
    expect(reportLink.href).toContain("github.com");
    expect(decodeURIComponent(reportLink.href)).toContain("future-thing");
  });

  it("字段值:null → 'null' 文本", () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { a: null } }} />);
    const details = document.querySelector("details") as HTMLElement;
    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("字段值:undefined → 'undefined' 文本", () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { a: undefined } }} />);
    const details = document.querySelector("details") as HTMLElement;
    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("undefined")).toBeInTheDocument();
  });

  it("字段值:数字 / 布尔 → <code> 等宽", () => {
    render(<UnknownBlockCard block={{ kind: "x", payload: { count: 42, ok: true } }} />);
    const details = document.querySelector("details") as HTMLElement;
    fireEvent.click(details.querySelector("summary")!);
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("字段值:长字符串 → 折叠 details 显示字符数", async () => {
    const longStr = "x".repeat(300);
    render(<UnknownBlockCard block={{ kind: "x", payload: { body: longStr } }} />);
    // jsdom 不自动 toggle details open,手动开 + 等 React 状态更新
    const outerDetails = document.querySelector(".unknown-block-card") as HTMLDetailsElement;
    outerDetails.open = true;
    outerDetails.dispatchEvent(new Event("toggle"));
    await waitFor(() => {
      expect(screen.getByText(/字符串 \(300 字符\)/)).toBeInTheDocument();
    });
  });

  it("字段值:大对象 → 折叠 details 显示 key 数量 (json > 160 字符)", async () => {
    // 拼一个 JSON 序列化后 > 160 字符的对象
    const big = {
      alpha: "long-string-1",
      beta: "long-string-2",
      gamma: "long-string-3",
      delta: "long-string-4",
      epsilon: "long-string-5",
      zeta: "long-string-6",
      eta: "long-string-7",
    };
    render(<UnknownBlockCard block={{ kind: "x", payload: { obj: big } }} />);
    const outerDetails = document.querySelector(".unknown-block-card") as HTMLDetailsElement;
    outerDetails.open = true;
    outerDetails.dispatchEvent(new Event("toggle"));
    await waitFor(() => {
      const truncatedSummary = document.querySelector(".field-truncated summary");
      expect(truncatedSummary?.textContent).toMatch(/对象.*7.*键/);
    });
  });
});
