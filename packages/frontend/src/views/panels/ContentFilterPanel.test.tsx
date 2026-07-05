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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
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
        availableModels={[]}
        selectedModels={[]}
        onToggleModel={noop}
        sidechainMode="all"
        onSetSidechainMode={noop}
        onClearContent={onClearContent}
      />
    );
    expect(screen.getByTestId("content-filter-clear")).toBeInTheDocument();
  });

  // ===== v0.7.0: model 维度 =====
  it("availableModels 渲染成 chip,空数组不渲染 model 行", () => {
    const { rerender } = render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={["claude-opus-4-7", "claude-sonnet-4-5"]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("content-filter-model-claude-opus-4-7")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-model-claude-sonnet-4-5")).toBeInTheDocument();

    rerender(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={[]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    expect(screen.queryByTestId("content-filter-models")).toBeNull();
  });

  it("model chip 短标签:opus / sonnet / haiku 关键字识别", () => {
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={["claude-opus-4-7", "claude-sonnet-4-5", "claude-haiku-4-5"]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    const opus = screen.getByTestId("content-filter-model-claude-opus-4-7");
    const sonnet = screen.getByTestId("content-filter-model-claude-sonnet-4-5");
    const haiku = screen.getByTestId("content-filter-model-claude-haiku-4-5");
    expect(opus.textContent).toBe("opus");
    expect(sonnet.textContent).toBe("sonnet");
    expect(haiku.textContent).toBe("haiku");
  });

  it("model chip 点击 → onToggleModel(model) + active 状态反映", async () => {
    const onToggleModel = vi.fn();
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={["claude-opus-4-7"]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={onToggleModel}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    const chip = screen.getByTestId("content-filter-model-claude-opus-4-7");
    expect(chip.getAttribute("data-active")).toBe("false");
    await userEvent.click(chip);
    expect(onToggleModel).toHaveBeenCalledWith("claude-opus-4-7");
  });

  it("selectedModels 含 model → chip 高亮", () => {
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={["claude-opus-4-7", "claude-sonnet-4-5"]}
        selectedModels={["claude-opus-4-7"]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    expect(
      screen.getByTestId("content-filter-model-claude-opus-4-7").getAttribute("data-active")
    ).toBe("true");
    expect(
      screen.getByTestId("content-filter-model-claude-sonnet-4-5").getAttribute("data-active")
    ).toBe("false");
  });

  // ===== v0.7.0: sidechainMode 维度 =====
  it("sidechain 3 选项:渲染 all / main / sidechain", () => {
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={[]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("filter-sidechain-all")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sidechain-main")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sidechain-sidechain")).toBeInTheDocument();
  });

  it("sidechainMode='main' → main chip 高亮,其它 false", () => {
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={[]}
        selectedModels={[]}
        sidechainMode="main"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("filter-sidechain-main").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("filter-sidechain-all").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("filter-sidechain-sidechain").getAttribute("data-active")).toBe(
      "false"
    );
  });

  it("sidechain chip 点击 → onSetSidechainMode(mode) 触发", async () => {
    const onSetSidechainMode = vi.fn();
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={[]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={onSetSidechainMode}
        onClearContent={noop}
      />
    );
    await userEvent.click(screen.getByTestId("filter-sidechain-main"));
    expect(onSetSidechainMode).toHaveBeenCalledWith("main");
    await userEvent.click(screen.getByTestId("filter-sidechain-sidechain"));
    expect(onSetSidechainMode).toHaveBeenCalledWith("sidechain");
  });

  it("sidechainMode='main' 激活时,清除按钮显示", () => {
    render(
      <ContentFilterPanel
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={[]}
        selectedModels={[]}
        sidechainMode="main"
        onToggleTool={noop}
        onSetRole={noop}
        onToggleHas={noop}
        onToggleModel={noop}
        onSetSidechainMode={noop}
        onClearContent={noop}
      />
    );
    expect(screen.getByTestId("content-filter-clear")).toBeInTheDocument();
  });
});
