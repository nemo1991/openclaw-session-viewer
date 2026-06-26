// @vitest-environment jsdom
/**
 * ToolUseCard 组件可视化测试
 *
 * 覆盖 body dispatch (v0.4.2):
 * - Edit → line diff 视图 (有 +N -M stats / 颜色行)
 * - Edit 缺字段 → fallback JSON
 * - Edit replace_all=true → "替换全部" badge
 * - Bash → command 等宽块 + description caption + 后台 badge
 * - Read → file_path + offset/limit 行号指示
 * - Task (Create) → description + subagent_type + prompt
 * - Task (Update) → taskId + status badge + content
 * - 其它 tool (Grep/Glob/WebSearch) → JSON dump fallback
 * - 默认展开 (v0.4.2)
 * - 头部有工具名 + id 截断
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ToolUseCard } from "./ToolUseCard";

describe("ToolUseCard", () => {
  beforeEach(() => cleanup());

  describe("通用头部", () => {
    it("默认展开 (v0.4.2 变更)", () => {
      render(<ToolUseCard id="abc123def456" name="Bash" input={{ command: "ls" }} />);
      // 默认展开 → body 存在
      expect(document.querySelector(".tool-use-body")).toBeInTheDocument();
    });

    it("头部显示工具名 + id 截断前 8 字符", () => {
      render(<ToolUseCard id="abcdef1234567890" name="Bash" input={{ command: "ls" }} />);
      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("abcdef12")).toBeInTheDocument();
    });

    it("summary:Bash 用 command 截 80 字符 (在 header summary 里)", () => {
      render(<ToolUseCard id="t1" name="Bash" input={{ command: "ls -la /tmp" }} />);
      // text 出现在 summary 和 body 两处,用 summary 元素锁定 header
      const summary = document.querySelector(".tool-summary");
      expect(summary?.textContent).toBe("ls -la /tmp");
    });

    it("summary:Read 用 file_path (在 header summary 里)", () => {
      render(<ToolUseCard id="t1" name="Read" input={{ file_path: "/etc/hosts" }} />);
      const summary = document.querySelector(".tool-summary");
      expect(summary?.textContent).toBe("/etc/hosts");
    });

    it("summary:Glob 用 pattern", () => {
      render(<ToolUseCard id="t1" name="Glob" input={{ pattern: "**/*.ts" }} />);
      const summary = document.querySelector(".tool-summary");
      expect(summary?.textContent).toBe("**/*.ts");
    });

    it("summary:Task 有 taskId → 走 [更新] 路径 + status", () => {
      render(<ToolUseCard id="t1" name="Task" input={{ taskId: "abc123", status: "completed" }} />);
      const summary = document.querySelector(".tool-summary");
      expect(summary?.textContent).toBe("[更新] completed");
    });

    it("summary:Task 无 taskId → 走 description", () => {
      render(<ToolUseCard id="t1" name="Task" input={{ description: "搜索代码" }} />);
      const summary = document.querySelector(".tool-summary");
      expect(summary?.textContent).toBe("搜索代码");
    });
  });

  describe("Edit body", () => {
    it("完整输入 → 走 line diff 视图,显示 +/- stats", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Edit"
          input={{
            file_path: "/tmp/a.ts",
            old_string: "hello\n",
            new_string: "hi\n",
          }}
        />
      );
      // 出现 +1 / -1 / 0 未变 这种 stats
      expect(screen.getByText("+1")).toBeInTheDocument();
      expect(screen.getByText("-1")).toBeInTheDocument();
      // file_path 出现在 body 顶部 (跟 header summary 区分)
      const bodyFilePath = document.querySelector(".tool-edit-file-path");
      expect(bodyFilePath?.textContent).toBe("/tmp/a.ts");
      // diff 行
      const delRow = document.querySelector(".tool-diff-row-del");
      const addRow = document.querySelector(".tool-diff-row-add");
      expect(delRow).toBeInTheDocument();
      expect(addRow).toBeInTheDocument();
    });

    it("缺 old_string → fallback 到 JSON dump", () => {
      render(
        <ToolUseCard id="t1" name="Edit" input={{ file_path: "/tmp/a.ts", new_string: "y" }} />
      );
      const json = document.querySelector(".tool-body-json");
      expect(json).toBeInTheDocument();
    });

    it("缺 new_string → fallback 到 JSON dump", () => {
      render(
        <ToolUseCard id="t1" name="Edit" input={{ file_path: "/tmp/a.ts", old_string: "x" }} />
      );
      const json = document.querySelector(".tool-body-json");
      expect(json).toBeInTheDocument();
    });

    it("replace_all: true → 显示 '替换全部' badge", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Edit"
          input={{
            file_path: "/tmp/a.ts",
            old_string: "x",
            new_string: "y",
            replace_all: true,
          }}
        />
      );
      expect(screen.getByText("替换全部")).toBeInTheDocument();
    });

    it("replace_all: false → 不显示 '替换全部' badge", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Edit"
          input={{
            file_path: "/tmp/a.ts",
            old_string: "x",
            new_string: "y",
            replace_all: false,
          }}
        />
      );
      expect(screen.queryByText("替换全部")).not.toBeInTheDocument();
    });
  });

  describe("Bash body", () => {
    it("command 显示在等宽 code block", () => {
      render(<ToolUseCard id="t1" name="Bash" input={{ command: "npm run build" }} />);
      const cmd = document.querySelector(".tool-bash-command");
      expect(cmd).toBeInTheDocument();
      expect(cmd?.textContent).toBe("npm run build");
    });

    it("description 显示为 caption (前缀 '说明: ')", () => {
      render(
        <ToolUseCard id="t1" name="Bash" input={{ command: "ls", description: "列出文件" }} />
      );
      expect(screen.getByText(/说明: 列出文件/)).toBeInTheDocument();
    });

    it("run_in_background: true → '后台运行' badge", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Bash"
          input={{ command: "long-task", run_in_background: true }}
        />
      );
      expect(screen.getByText("后台运行")).toBeInTheDocument();
    });

    it("缺 command → '(空命令)' 提示", () => {
      render(<ToolUseCard id="t1" name="Bash" input={{}} />);
      expect(screen.getByText("(空命令)")).toBeInTheDocument();
    });
  });

  describe("Read/Write/NotebookEdit body", () => {
    it("Read:file_path 粗体 + offset+limit 拼成 'lines N–M'", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Read"
          input={{ file_path: "/src/a.ts", offset: 10, limit: 30 }}
        />
      );
      // file_path 在 body 里 (跟 header summary 区分)
      const bodyFp = document.querySelector(".tool-read-file-path");
      expect(bodyFp?.textContent).toBe("/src/a.ts");
      expect(screen.getByText(/lines 10–40/)).toBeInTheDocument();
    });

    it("Read:仅 offset → '从 line N 起'", () => {
      render(<ToolUseCard id="t1" name="Read" input={{ file_path: "/src/a.ts", offset: 50 }} />);
      expect(screen.getByText(/从 line 50 起/)).toBeInTheDocument();
    });

    it("Read:仅 limit → '前 N 行'", () => {
      render(<ToolUseCard id="t1" name="Read" input={{ file_path: "/src/a.ts", limit: 100 }} />);
      expect(screen.getByText(/前 100 行/)).toBeInTheDocument();
    });

    it("Read:无 file_path → '(无文件路径)' 提示", () => {
      render(<ToolUseCard id="t1" name="Read" input={{}} />);
      expect(screen.getByText("(无文件路径)")).toBeInTheDocument();
    });

    it("NotebookEdit:用 notebook_path (在 body 里)", () => {
      render(
        <ToolUseCard id="t1" name="NotebookEdit" input={{ notebook_path: "/tmp/nb.ipynb" }} />
      );
      const bodyFp = document.querySelector(".tool-read-file-path");
      expect(bodyFp?.textContent).toBe("/tmp/nb.ipynb");
    });
  });

  describe("Task body", () => {
    it("Create:description + subagent_type badge + prompt 预览", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Task"
          input={{
            description: "代码搜索",
            subagent_type: "Explore",
            prompt: "查找所有 .tsx 文件",
          }}
        />
      );
      // description 在 body headline (跟 header summary 区分)
      const headline = document.querySelector(".tool-task-headline");
      expect(headline?.textContent).toBe("代码搜索");
      expect(screen.getByText("Explore")).toBeInTheDocument();
      expect(screen.getByText(/查找所有 .tsx 文件/)).toBeInTheDocument();
    });

    it("Create:prompt 长于 200 字符 → 截断加 …", () => {
      const longPrompt = "x".repeat(250);
      render(
        <ToolUseCard id="t1" name="Task" input={{ description: "test", prompt: longPrompt }} />
      );
      const pre = document.querySelector(".tool-task-prompt");
      expect(pre?.textContent?.endsWith("…")).toBe(true);
    });

    it("Update:有 taskId + status → status 大 badge + 中文标签", () => {
      render(
        <ToolUseCard
          id="t1"
          name="Task"
          input={{ taskId: "abc-123-456-789", status: "in_progress", content: "正在做" }}
        />
      );
      // taskId 截前 12,在 <code class="tool-task-id"> 里
      // "abc-123-456-789".slice(0, 12) = "abc-123-456-"
      const taskIdEl = document.querySelector(".tool-task-id");
      expect(taskIdEl?.textContent).toBe("abc-123-456-");
      // status 中文 "进行中"
      expect(screen.getByText("进行中")).toBeInTheDocument();
      // content
      expect(screen.getByText("正在做")).toBeInTheDocument();
    });

    it("Update:status badge 有对应 className", () => {
      render(<ToolUseCard id="t1" name="Task" input={{ taskId: "t1", status: "completed" }} />);
      const badge = document.querySelector(".tool-task-status-completed");
      expect(badge).toBeInTheDocument();
    });
  });

  describe("其它 tool (default JSON dump)", () => {
    it("Grep → JSON dump", () => {
      render(<ToolUseCard id="t1" name="Grep" input={{ pattern: "TODO", path: "/src" }} />);
      const json = document.querySelector(".tool-body-json");
      expect(json).toBeInTheDocument();
      // JSON 内容含 pattern
      expect(json?.textContent).toContain("TODO");
    });

    it("WebFetch → JSON dump", () => {
      render(<ToolUseCard id="t1" name="WebFetch" input={{ url: "https://example.com" }} />);
      const json = document.querySelector(".tool-body-json");
      expect(json).toBeInTheDocument();
    });
  });
});
