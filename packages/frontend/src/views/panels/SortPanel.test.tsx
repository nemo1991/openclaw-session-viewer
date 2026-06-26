/**
 * SortPanel 组件可视化测试
 */

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SortPanel } from "./SortPanel";

describe("SortPanel", () => {
  it("sortAsc=true:asc 按钮 active", () => {
    render(<SortPanel sortAsc={true} onChange={vi.fn()} />);
    expect(screen.getByTestId("sort-asc").className).toContain("sort-btn-active");
    expect(screen.getByTestId("sort-desc").className).not.toContain("sort-btn-active");
  });

  it("sortAsc=false:desc 按钮 active", () => {
    render(<SortPanel sortAsc={false} onChange={vi.fn()} />);
    expect(screen.getByTestId("sort-desc").className).toContain("sort-btn-active");
    expect(screen.getByTestId("sort-asc").className).not.toContain("sort-btn-active");
  });

  it("点 asc → onChange(true)", async () => {
    const onChange = vi.fn();
    render(<SortPanel sortAsc={false} onChange={onChange} />);
    await userEvent.click(screen.getByTestId("sort-asc"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("点 desc → onChange(false)", async () => {
    const onChange = vi.fn();
    render(<SortPanel sortAsc={true} onChange={onChange} />);
    await userEvent.click(screen.getByTestId("sort-desc"));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
