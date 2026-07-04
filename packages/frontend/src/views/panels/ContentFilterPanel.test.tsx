/**
 * ContentFilterPanel 组件可视化测试
 *
 * 覆盖(v0.7.0):
 * 1. 受控:props → callbacks,无 store 直接接触
 * 2. availableTools 动态生成 chip;空数组时不渲染 tool 行
 * 3. role 单选:3 选项高亮切换
 * 4. has-attribute 多选:toggle 触发 onToggleHas
 * 5. 清除按钮:仅当任一 content filter active 时出现
 * 6. data-active / data-testid 反射 active 状态
 */

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentFilterPanel } from "./ContentFilterPanel";

const noop = () => undefined;

describe("ContentFilterPanel", () => {
  it("availableTools 渲染成 chip,空数组不渲染 tool 行", () => {
    const { rerender } = render(
      <ContentFilterPanel
        availableTools={["Bash", "Read", "Edit"]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("content-filter-tool-Bash")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-tool-Read")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-tool-Edit")).toBeInTheDocument();

    rerender(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    expect(screen.queryByTestId("content-filter-tools")).toBeNull();
  });

  it("tool chip 点选 → onToggleTool(tool)", async () => {
    const onToggleTool = vi.fn();
    render(
      <ContentFilterPanel
        availableTools={["Bash", "Read"]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={onToggleTool}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    await userEvent.click(screen.getByTestId("content-filter-tool-Bash"));
    expect(onToggleTool).toHaveBeenCalledWith("Bash");
  });

  it("selectedTools 含某 tool → chip 高亮 + data-active='true'", () => {
    render(
      <ContentFilterPanel
        availableTools={["Bash", "Read"]}
        selectedTools={["Bash"]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    const bashChip = screen.getByTestId("content-filter-tool-Bash");
    const readChip = screen.getByTestId("content-filter-tool-Read");
    expect(bashChip.getAttribute("data-active")).toBe("true");
    expect(bashChip.className).toContain("content-chip-active");
    expect(readChip.getAttribute("data-active")).toBe("false");
  });

  it("role 3 选项:点击 → onSetRole(role|undefined)", async () => {
    const onSetRole = vi.fn();
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={onSetRole}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    await userEvent.click(screen.getByTestId("filter-role-user"));
    expect(onSetRole).toHaveBeenCalledWith("user");
    await userEvent.click(screen.getByTestId("filter-role-assistant"));
    expect(onSetRole).toHaveBeenCalledWith("assistant");
    await userEvent.click(screen.getByTestId("filter-role-all"));
    expect(onSetRole).toHaveBeenCalledWith(undefined);
  });

  it("role 当前值 → 对应 chip data-active=true", () => {
    render(
      <ContentFilterPanel
        availableTools={["Bash"]}
        selectedTools={[]}
        role="user"
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("filter-role-user").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("filter-role-all").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("filter-role-assistant").getAttribute("data-active")).toBe("false");
  });

  it("has 4 选项:点选 → onToggleHas(attr)", async () => {
    const onToggleHas = vi.fn();
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={onToggleHas}
        onClearContent={noop}
      />
    );
    await userEvent.click(screen.getByTestId("content-filter-has-thinking"));
    expect(onToggleHas).toHaveBeenCalledWith("thinking");
    await userEvent.click(screen.getByTestId("content-filter-has-error"));
    expect(onToggleHas).toHaveBeenCalledWith("error");
    await userEvent.click(screen.getByTestId("content-filter-has-subagent"));
    expect(onToggleHas).toHaveBeenCalledWith("subagent");
  });

  it("has 当前选中 → 对应 chip data-active=true,其它 false", () => {
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={["thinking", "error"]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("content-filter-has-thinking").getAttribute("data-active")).toBe(
      "true"
    );
    expect(screen.getByTestId("content-filter-has-error").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("content-filter-has-tool_use").getAttribute("data-active")).toBe(
      "false"
    );
    expect(screen.getByTestId("content-filter-has-subagent").getAttribute("data-active")).toBe(
      "false"
    );
  });

  it("content filter 全部空时,不渲染清除按钮", () => {
    render(
      <ContentFilterPanel
        availableTools={["Bash"]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={noop}
      />
    );
    expect(screen.queryByTestId("content-filter-clear")).toBeNull();
  });

  it("任一 content filter active → 渲染清除按钮,点击触发 onClearContent", async () => {
    const onClearContent = vi.fn();
    const { rerender } = render(
      <ContentFilterPanel
        availableTools={["Bash"]}
        selectedTools={["Bash"]}
        role={undefined}
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={onClearContent}
      />
    );
    const clearBtn = screen.getByTestId("content-filter-clear");
    expect(clearBtn).toBeInTheDocument();
    await userEvent.click(clearBtn);
    expect(onClearContent).toHaveBeenCalled();

    // 测 role active 路径
    onClearContent.mockClear();
    rerender(
      <ContentFilterPanel
        availableTools={["Bash"]}
        selectedTools={[]}
        role="user"
        has={[]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={onClearContent}
      />
    );
    expect(screen.getByTestId("content-filter-clear")).toBeInTheDocument();

    // 测 has active 路径
    rerender(
      <ContentFilterPanel
        availableTools={["Bash"]}
        selectedTools={[]}
        role={undefined}
        has={["thinking"]}
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onClearContent={onClearContent}
      />
    );
    expect(screen.getByTestId("content-filter-clear")).toBeInTheDocument();
  });
});
