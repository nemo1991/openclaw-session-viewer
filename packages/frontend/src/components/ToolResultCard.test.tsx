// @vitest-environment jsdom
/**
 * ToolResultCard 组件可视化测试
 *
 * 覆盖:
 * - 默认展开 (v0.4.2)
 * - 头部:工具结果 / 工具结果 (失败) / filePath 末两段 / id 截断
 * - string content → 直接显示
 * - object content (有 stdout 字段) → 提取 stdout
 * - array content → 拼接
 * - 长 content (>500) → 截断 + "共 N 字符" 提示
 * - 有 filePath + 已知扩展名 → 走 shiki 高亮 (异步,async 等待)
 * - isError=true → 加 "err" class + X icon + "工具结果 (失败)" 文案
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ToolResultCard } from "./ToolResultCard";

// mock shiki 避免真高亮(测试只要看 "有 highlightedHtml" 即可)
vi.mock("shiki", () => ({
  getHighlighter: vi.fn(async () => ({
    codeToHtml: (_code: string, opts: { lang: string }) =>
      `<pre class="shiki"><code class="lang-${opts.lang}">${_code}</code></pre>`,
  })),
}));

describe("ToolResultCard", () => {
  beforeEach(() => cleanup());

  it("默认展开 (v0.4.2)", () => {
    render(<ToolResultCard toolUseId="abc123def" content="hello" />);
    expect(document.querySelector(".tool-result-body")).toBeInTheDocument();
  });

  it("头部:成功结果文案", () => {
    render(<ToolResultCard toolUseId="abc123def" content="x" />);
    expect(screen.getByText("工具结果")).toBeInTheDocument();
  });

  it("头部:失败结果文案 + X icon", () => {
    render(<ToolResultCard toolUseId="abc123def" content="x" isError={true} />);
    expect(screen.getByText("工具结果 (失败)")).toBeInTheDocument();
    // 卡片有 err className
    const card = document.querySelector(".tool-result-card");
    expect(card?.classList.contains("err")).toBe(true);
  });

  it("头部:id 截断前 8 字符", () => {
    render(<ToolUseCardOrResult toolUseId="abcdef1234567890" content="x" />);
    expect(screen.getByText("abcdef12")).toBeInTheDocument();
  });

  it("头部:filePath 显示末两段路径", () => {
    render(
      <ToolResultCard
        toolUseId="t1"
        content="x"
        filePath="/Users/alice/projects/web/src/index.ts"
      />
    );
    // 末两段 = "src/index.ts"
    expect(screen.getByText(/src\/index\.ts/)).toBeInTheDocument();
  });

  it("string content 直接显示", () => {
    render(<ToolResultCard toolUseId="t1" content="hello world" />);
    const pre = document.querySelector(".tool-result-content");
    expect(pre?.textContent).toBe("hello world");
  });

  it("object content 有 stdout 字段 → 提取 stdout", () => {
    render(<ToolResultCard toolUseId="t1" content={{ stdout: "build ok", stderr: "warnings" }} />);
    const pre = document.querySelector(".tool-result-content");
    expect(pre?.textContent).toBe("build ok");
  });

  it("array content → 拼接 (有 stdout 优先)", () => {
    render(
      <ToolResultCard
        toolUseId="t1"
        content={[
          { type: "text", stdout: "first" },
          { type: "text", stdout: "second" },
        ]}
      />
    );
    const pre = document.querySelector(".tool-result-content");
    expect(pre?.textContent).toBe("first\nsecond");
  });

  it("长 content (>500 字符) → 截断 + '共 N 字符' 提示", () => {
    const long = "x".repeat(1000);
    render(<ToolResultCard toolUseId="t1" content={long} />);
    const more = document.querySelector(".tool-result-more");
    expect(more?.textContent).toContain("1000 字符");
    // pre 里的内容被截断
    const pre = document.querySelector(".tool-result-content");
    expect(pre?.textContent?.length).toBeLessThan(1000);
    expect(pre?.textContent?.endsWith("…")).toBe(true);
  });

  it("有 filePath + 已知扩展名 → 走 shiki 高亮 (异步)", async () => {
    const tsContent = "const x: number = 1;";
    render(<ToolResultCard toolUseId="t1" content={tsContent} filePath="/src/a.ts" />);
    // 等待 useEffect 异步加载
    await waitFor(() => {
      const shiki = document.querySelector(".tool-result-shiki");
      expect(shiki).toBeInTheDocument();
    });
  });

  it("有 filePath + 未知扩展名 → 不高亮,显示 plain <pre>", () => {
    render(<ToolResultCard toolUseId="t1" content="random binary" filePath="/file.unknown" />);
    // 同步渲染出 pre
    expect(document.querySelector(".tool-result-content")).toBeInTheDocument();
    expect(document.querySelector(".tool-result-shiki")).not.toBeInTheDocument();
  });

  it("点击 header 切换 open 状态", async () => {
    render(<ToolResultCard toolUseId="t1" content="x" />);
    const header = document.querySelector(".tool-result-header") as HTMLElement;
    expect(document.querySelector(".tool-result-body")).toBeInTheDocument();
    header.click();
    await waitFor(() => {
      expect(document.querySelector(".tool-result-body")).not.toBeInTheDocument();
    });
    header.click();
    await waitFor(() => {
      expect(document.querySelector(".tool-result-body")).toBeInTheDocument();
    });
  });
});

// 包装函数,让一个测试同时用 ToolUseCard / ToolResultCard 而不混
function ToolUseCardOrResult(props: { toolUseId: string; content: unknown }) {
  return <ToolResultCard {...props} />;
}
