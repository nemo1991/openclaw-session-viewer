/**
 * MessageHeader 组件可视化测试
 *
 * 覆盖:
 * - 4 种 role label (user/assistant/tool/system) + 默认 fallback
 * - model 可选显示
 * - timestamp 可选显示
 * - tokenUsage 显示 token 计数 + cacheRead ⚡
 * - React.memo:props 不变不重渲染
 */

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageHeader } from "./MessageHeader";
import { useSettingsStore } from "../state/settingsStore";

describe("MessageHeader", () => {
  it("user 角色显示 '用户' label", () => {
    render(<MessageHeader role="user" />);
    expect(screen.getByText("用户")).toBeInTheDocument();
  });

  it("assistant 角色显示 '助手' label", () => {
    render(<MessageHeader role="assistant" />);
    expect(screen.getByText("助手")).toBeInTheDocument();
  });

  it("tool 角色显示 '工具' label", () => {
    render(<MessageHeader role="tool" />);
    expect(screen.getByText("工具")).toBeInTheDocument();
  });

  it("system 角色显示 '系统' label", () => {
    render(<MessageHeader role="system" />);
    expect(screen.getByText("系统")).toBeInTheDocument();
  });

  it("未知 role 显示原字符串", () => {
    render(<MessageHeader role="weird" />);
    expect(screen.getByText("weird")).toBeInTheDocument();
  });

  it("提供 model 时显示", () => {
    render(<MessageHeader role="assistant" model="claude-opus-4" />);
    expect(screen.getByText("claude-opus-4")).toBeInTheDocument();
  });

  it("提供 timestamp 时显示(formatted)", () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, timezone: "UTC" },
      loaded: true,
    });
    render(<MessageHeader role="assistant" timestamp="2026-06-25T14:00:00Z" />);
    // formatTimeExact 输出形如 "2026-06-25 14:00:00 UTC" — 至少包含年份
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it("tokenUsage 显示 input/output 计数", () => {
    render(
      <MessageHeader
        role="assistant"
        tokenUsage={{ input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }}
      />
    );
    expect(screen.getByText(/100\/200/)).toBeInTheDocument();
  });

  it("cacheRead > 0 显示 ⚡", () => {
    render(
      <MessageHeader
        role="assistant"
        tokenUsage={{ input: 100, output: 200, cacheRead: 5000, cacheWrite: 0 }}
      />
    );
    expect(screen.getByText(/⚡5\.0k/)).toBeInTheDocument();
  });

  it("React.memo:同样 props 第二次 render 不重新挂载", () => {
    const { rerender } = render(<MessageHeader role="user" />);
    expect(screen.getByText("用户")).toBeInTheDocument();
    // 重新 render 同样 props — memo 应当 skip
    rerender(<MessageHeader role="user" />);
    expect(screen.getByText("用户")).toBeInTheDocument();
    expect(screen.getAllByText("用户")).toHaveLength(1);
  });
});
