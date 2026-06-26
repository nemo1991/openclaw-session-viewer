/**
 * FilterPanel 组件可视化测试
 *
 * 关键回归测试 — 验证:
 * 1. 受控 datetime-local 输入(不再用 document.getElementById)
 * 2. preset 切换不渲染 datetime-local
 * 3. Apply 提交受控值(localInputToIso 转换后再 onApply)
 * 4. Clear 触发 onClear
 * 5. store 的 from/to 变化同步本地输入
 */

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterPanel } from "./FilterPanel";

const noop = () => undefined;
/** 模拟 lib/format.isoToLocalInputInTz: ISO → naive "YYYY-MM-DDTHH:mm"(去 Z + 秒)
 *  Test 用:避免依赖 Intl TZ,UTC 输入 → UTC 输出,稳定可断言
 */
function fakeIsoToLocal(iso: string | undefined): string {
  if (!iso) return "";
  // "2026-06-25T00:00:00Z" → "2026-06-25T00:00"
  return iso.replace(/Z$/, "").replace(/:\d{2}(\.\d+)?$/, "");
}

describe("FilterPanel", () => {
  it("preset='all':4 个 preset 按钮 + custom 按钮,无 datetime 输入", () => {
    render(
      <FilterPanel
        preset="all"
        tz="UTC"
        localInputToIso={noop}
        isoToLocalInput={fakeIsoToLocal}
        onPresetChange={noop}
        onApply={noop}
        onClear={noop}
      />
    );
    expect(screen.getByTestId("filter-preset-all")).toBeInTheDocument();
    expect(screen.getByTestId("filter-preset-1h")).toBeInTheDocument();
    expect(screen.getByTestId("filter-preset-24h")).toBeInTheDocument();
    expect(screen.getByTestId("filter-preset-7d")).toBeInTheDocument();
    expect(screen.getByTestId("filter-preset-custom")).toBeInTheDocument();
    // 非 custom 模式 → datetime-local 不渲染
    expect(screen.queryByTestId("filter-from-input")).toBeNull();
    expect(screen.queryByTestId("filter-to-input")).toBeNull();
  });

  it("preset='24h':点击 → 触发 onPresetChange('24h')", async () => {
    const onPresetChange = vi.fn();
    render(
      <FilterPanel
        preset="all"
        tz="UTC"
        localInputToIso={noop}
        isoToLocalInput={fakeIsoToLocal}
        onPresetChange={onPresetChange}
        onApply={noop}
        onClear={noop}
      />
    );
    await userEvent.click(screen.getByTestId("filter-preset-24h"));
    expect(onPresetChange).toHaveBeenCalledWith("24h");
  });

  it("preset='custom':渲染 datetime-local 输入,初值来自 props.from/to", () => {
    render(
      <FilterPanel
        preset="custom"
        from="2026-06-25T00:00:00Z"
        to="2026-06-25T23:59:00Z"
        tz="UTC"
        localInputToIso={noop}
        isoToLocalInput={fakeIsoToLocal}
        onPresetChange={noop}
        onApply={noop}
        onClear={noop}
      />
    );
    const fromInput = screen.getByTestId("filter-from-input") as HTMLInputElement;
    const toInput = screen.getByTestId("filter-to-input") as HTMLInputElement;
    expect(fromInput).toBeInTheDocument();
    expect(toInput).toBeInTheDocument();
    expect(fromInput.value).toBe("2026-06-25T00:00");
    expect(toInput.value).toBe("2026-06-25T23:59");
  });

  it("Apply:输入值 → localInputToIso 转换 → onApply(from?, to?)", async () => {
    const onApply = vi.fn();
    const localInputToIso = vi.fn((s: string) => `iso(${s})`);
    render(
      <FilterPanel
        preset="custom"
        tz="UTC"
        localInputToIso={localInputToIso}
        isoToLocalInput={fakeIsoToLocal}
        onPresetChange={noop}
        onApply={onApply}
        onClear={noop}
      />
    );
    const fromInput = screen.getByTestId("filter-from-input");
    const toInput = screen.getByTestId("filter-to-input");
    await userEvent.type(fromInput, "2026-06-25T10:00");
    await userEvent.type(toInput, "2026-06-25T12:00");
    await userEvent.click(screen.getByTestId("filter-apply-btn"));
    expect(localInputToIso).toHaveBeenCalledWith("2026-06-25T10:00");
    expect(localInputToIso).toHaveBeenCalledWith("2026-06-25T12:00");
    expect(onApply).toHaveBeenCalledWith("iso(2026-06-25T10:00)", "iso(2026-06-25T12:00)");
  });

  it("Clear 按钮 → 触发 onClear", async () => {
    const onClear = vi.fn();
    render(
      <FilterPanel
        preset="custom"
        tz="UTC"
        localInputToIso={noop}
        isoToLocalInput={fakeIsoToLocal}
        onPresetChange={noop}
        onApply={noop}
        onClear={onClear}
      />
    );
    await userEvent.click(screen.getByTestId("filter-clear-btn"));
    expect(onClear).toHaveBeenCalled();
  });

  it("store from/to 变化:本地 input 同步更新", () => {
    const isoToLocalInput = vi.fn(fakeIsoToLocal);
    const { rerender } = render(
      <FilterPanel
        preset="custom"
        tz="UTC"
        localInputToIso={noop}
        isoToLocalInput={isoToLocalInput}
        onPresetChange={noop}
        onApply={noop}
        onClear={noop}
      />
    );
    // 初始 mount: from=undefined → fakeIsoToLocal(undefined) → ""
    expect(isoToLocalInput).toHaveBeenCalledWith(undefined);
    // props.from 变化触发 effect
    rerender(
      <FilterPanel
        preset="custom"
        from="2026-06-25T08:00:00Z"
        tz="UTC"
        localInputToIso={noop}
        isoToLocalInput={isoToLocalInput}
        onPresetChange={noop}
        onApply={noop}
        onClear={noop}
      />
    );
    const fromInput = screen.getByTestId("filter-from-input") as HTMLInputElement;
    expect(fromInput.value).toBe("2026-06-25T08:00");
  });
});
