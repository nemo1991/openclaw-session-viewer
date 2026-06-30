// @vitest-environment jsdom
/**
 * RevealErrorToast 单元测试 (v0.6.x)
 *
 * 覆盖:
 * - REVEAL_ERROR_EVENT 派发 → 渲染 toast (3 个按钮: 复制路径/去设置/关闭)
 * - '人类能读' 错误文案转换 (PathSecurity → 中文提示)
 * - 点 '去设置' 按钮 → useNavigate('/settings')
 * - 点 '复制路径' → 调 navigator.clipboard.writeText + 临时 '已复制' 文案
 * - 6s 自动消失
 * - 多个错同时显示 (排成栈)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { RevealErrorToast } from "./RevealErrorToast";
import { REVEAL_ERROR_EVENT } from "../hooks/useFileReveal";

// navigator.clipboard mock
const writeText = vi.fn();
beforeEach(() => {
  cleanup();
  vi.useRealTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

function renderWithRouter() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <div data-testid="home">Home</div>
              <RevealErrorToast />
            </>
          }
        />
        <Route path="/settings" element={<div data-testid="settings-page">SettingsPage</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const fakeDispatch = (path: string, error: string) => {
  window.dispatchEvent(
    new CustomEvent(REVEAL_ERROR_EVENT, {
      detail: { path, error },
    })
  );
};

describe("RevealErrorToast", () => {
  it("REVEAL_ERROR_EVENT 派发 → 渲染 toast + 3 个按钮", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/Users/foo/bar.ts", "PathSecurity: 需提供 workspace_root (lock-down 模式)");
    });
    const toast = await screen.findByTestId("reveal-error-toast");
    expect(toast).toBeInTheDocument();
    // 路径展示
    expect(toast.textContent).toContain("/Users/foo/bar.ts");
    // 3 个按钮
    expect(screen.getByTestId("reveal-error-copy-path")).toBeInTheDocument();
    expect(screen.getByTestId("reveal-error-go-settings")).toBeInTheDocument();
    expect(screen.getByTestId("reveal-error-dismiss")).toBeInTheDocument();
  });

  it("PathSecurity '需提供 workspace_root' → 转成中文提示", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/a/b", "PathSecurity: 需提供 workspace_root (lock-down 模式)");
    });
    const toast = await screen.findByTestId("reveal-error-toast");
    expect(toast.textContent).toContain("默认导出目录");
  });

  it("PathSecurity '不在 workspace' → 转成中文提示", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/etc/passwd", "PathSecurity: '/etc/passwd' 不在 workspace '/tmp' 内");
    });
    const toast = await screen.findByTestId("reveal-error-toast");
    expect(toast.textContent).toContain("不在允许范围内");
  });

  it("非 PathSecurity 错 → 直接显示原始内容 (去掉前缀)", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/a/b", "SomeOtherError: 文件不存在");
    });
    const toast = await screen.findByTestId("reveal-error-toast");
    expect(toast.textContent).toContain("SomeOtherError: 文件不存在");
  });

  it("点 '复制路径' → 调 navigator.clipboard.writeText + 显示 '已复制'", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/Users/foo/bar.ts", "PathSecurity: nope");
    });
    const copyBtn = await screen.findByTestId("reveal-error-copy-path");
    await userEvent.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("/Users/foo/bar.ts");
    // "已复制" 显示
    expect(copyBtn.textContent).toContain("已复制");
  });

  it("点 '去设置' → 路由跳到 /settings", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/a/b", "PathSecurity: nope");
    });
    const settingsBtn = await screen.findByTestId("reveal-error-go-settings");
    await userEvent.click(settingsBtn);
    // 应该看到 settings 页内容 (路由跳转结果)
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
  });

  it("点 '关闭' → toast 立刻消失", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/a/b", "PathSecurity: nope");
    });
    const dismiss = await screen.findByTestId("reveal-error-dismiss");
    await userEvent.click(dismiss);
    expect(screen.queryByTestId("reveal-error-toast")).toBeNull();
  });

  it("多次错 → 排成栈 (多个 toast)", async () => {
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/a", "Err: 1");
      fakeDispatch("/b", "Err: 2");
      fakeDispatch("/c", "Err: 3");
    });
    const stack = screen.getByTestId("reveal-error-toast-stack");
    expect(stack.querySelectorAll("[data-testid='reveal-error-toast']").length).toBe(3);
  });

  it("6s 自动消失", async () => {
    vi.useFakeTimers();
    renderWithRouter();
    await act(async () => {
      fakeDispatch("/a/b", "PathSecurity: nope");
    });
    expect(screen.getByTestId("reveal-error-toast")).toBeInTheDocument();
    // 推进 7s
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.queryByTestId("reveal-error-toast")).toBeNull();
  });
});
