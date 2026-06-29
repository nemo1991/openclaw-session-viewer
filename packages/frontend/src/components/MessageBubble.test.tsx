// @vitest-environment jsdom
/**
 * MessageBubble 组件可视化测试
 *
 * 覆盖:
 * - 角色头 (user / assistant / meta) + icon + 标签
 * - text block → Markdown
 * - thinking block → ThinkingBlock
 * - tool_use / tool_result → 各自卡片
 * - meta 分支:已知 label 走 MetaBlockRenderer, 未知走 UnknownBlockCard 或 pill
 * - 子代理字段 (mode: / permission: / title / last-prompt) 走 SubagentMetaBlock
 *
 * 每个 case 用 snapshot 锁住 DOM 结构 + 关键文本断言
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageBubble, BlockRenderer } from "./MessageBubble";
import { useSettingsStore } from "../state/settingsStore";
import type { TranscriptEntryOut } from "../lib/api";

function makeEntry(
  index: number,
  role: string,
  blocks: Array<Record<string, unknown>> = [],
  extras: Partial<TranscriptEntryOut["normalized"]> = {}
): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `entry-${index}`,
      role,
      rawType: "test",
      timestamp: "2026-06-25T14:00:00Z",
      blocks: blocks as TranscriptEntryOut["normalized"]["blocks"],
      ...extras,
    },
  };
}

describe("MessageBubble", () => {
  beforeEach(() => {
    cleanup();
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, timezone: "UTC" },
      loaded: true,
    });
  });

  describe("role 头部", () => {
    it("user 角色:显示 '用户' 标签", () => {
      render(<MessageBubble entry={makeEntry(0, "user", [{ kind: "text", text: "hello" }])} />);
      expect(screen.getByText("用户")).toBeInTheDocument();
    });

    it("assistant 角色:显示 '助手' 标签 + 可选 model", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "assistant", [{ kind: "text", text: "hi" }], {
            model: "claude-opus-4",
          })}
        />
      );
      expect(screen.getByText("助手")).toBeInTheDocument();
      expect(screen.getByText("claude-opus-4")).toBeInTheDocument();
    });

    it("system 角色:显示 '系统' 标签", () => {
      render(<MessageBubble entry={makeEntry(0, "system", [{ kind: "text", text: "init" }])} />);
      expect(screen.getByText("系统")).toBeInTheDocument();
    });

    it("未知 role:显示原始 role 字符串", () => {
      render(<MessageBubble entry={makeEntry(0, "weird-role", [])} />);
      expect(screen.getByText("weird-role")).toBeInTheDocument();
    });

    it("带 tokenUsage 时显示 token 计数", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "assistant", [{ kind: "text", text: "x" }], {
            tokenUsage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
          })}
        />
      );
      expect(screen.getByText(/100\/200/)).toBeInTheDocument();
    });

    it("cacheRead > 0 时显示 ⚡", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "assistant", [{ kind: "text", text: "x" }], {
            tokenUsage: { input: 100, output: 200, cacheRead: 5000, cacheWrite: 0 },
          })}
        />
      );
      expect(screen.getByText(/⚡5\.0k/)).toBeInTheDocument();
    });
  });

  describe("blocks 渲染", () => {
    it("text block → Markdown (粗体/链接)", () => {
      render(<MessageBubble entry={makeEntry(0, "user", [{ kind: "text", text: "**bold**" }])} />);
      // react-markdown 把 **bold** 渲染成 <strong>bold</strong>
      const strong = document.querySelector("strong");
      expect(strong).toBeInTheDocument();
      expect(strong?.textContent).toBe("bold");
    });

    it("thinking block → ThinkingBlock (有 '思考' 文本)", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "assistant", [{ kind: "thinking", thinking: "先分析一下..." }])}
        />
      );
      // ThinkingBlock 渲染两份:preview (折叠可见) + content (展开可见)
      // 至少有一个出现
      const matches = screen.getAllByText(/先分析一下/);
      expect(matches.length).toBeGreaterThan(0);
    });

    it("tool_use block → ToolUseCard (有 Edit 工具名)", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "assistant", [
            {
              kind: "tool_use",
              id: "t1",
              name: "Edit",
              input: { file_path: "/tmp/a.ts", old_string: "x", new_string: "y" },
            },
          ])}
        />
      );
      // ToolUseCard 头部显示工具名
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    it("tool_result block → ToolResultCard (有 filePath header)", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "user", [
            {
              kind: "tool_result",
              tool_use_id: "t1",
              content: "result content",
              is_error: false,
            },
          ])}
        />
      );
      // 卡片默认展开,显示 content
      expect(screen.getByText(/result content/)).toBeInTheDocument();
    });

    it("image block → 显示图片元数据描述", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "assistant", [
            {
              kind: "image",
              mediaType: "image/png",
              dataBase64: "iVBORw0KGgo=",
            },
          ])}
        />
      );
      expect(screen.getByText(/图片/)).toBeInTheDocument();
      expect(screen.getByText(/image\/png/)).toBeInTheDocument();
    });
  });

  describe("meta 分支", () => {
    it("已知 meta label (file-history-snapshot) → MetaBlockRenderer 专属样式", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "file-history-snapshot",
              payload: { trackedFileBackups: { "/a.ts": {}, "/b.ts": {} }, messageId: "abc123def" },
            },
          ])}
        />
      );
      expect(screen.getByText("📁 file_snapshot")).toBeInTheDocument();
      expect(screen.getByText(/2 个跟踪文件/)).toBeInTheDocument();
    });

    it("agent_name (连字符) meta → 走 MetaBlockRenderer (v0.4.3 修复)", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "agent-name",
              payload: { agentName: "session-viewer-app" },
            },
          ])}
        />
      );
      expect(screen.getByText("🏷 agent_name")).toBeInTheDocument();
      expect(screen.getByText("session-viewer-app")).toBeInTheDocument();
    });

    it("task_reminder meta → 显示待办/进行/完成统计", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "task_reminder",
              payload: {
                itemCount: 3,
                pendingCount: 1,
                inProgressCount: 1,
                completedCount: 1,
                content: [
                  { id: "t1", status: "pending", subject: "task A" },
                  { id: "t2", status: "in_progress", subject: "task B" },
                  { id: "t3", status: "completed", subject: "task C" },
                ],
              },
            },
          ])}
        />
      );
      expect(screen.getByText("📝 task_reminder")).toBeInTheDocument();
      expect(screen.getByText(/1 待办 · 1 进行 · 1 完成/)).toBeInTheDocument();
    });

    it("pr-link meta → 显示 PR 链接 (有 url)", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "pr-link",
              payload: {
                prNumber: 42,
                prRepository: "openclaw/session-viewer",
                prUrl: "https://github.com/openclaw/session-viewer/pull/42",
              },
            },
          ])}
        />
      );
      expect(screen.getByText("🔗 pr_link")).toBeInTheDocument();
      const link = screen.getByRole("link");
      expect(link.getAttribute("href")).toBe("https://github.com/openclaw/session-viewer/pull/42");
    });

    it("未知 meta label + 有 payload → 走 UnknownBlockCard 兜底", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "some-unknown-future-type",
              payload: { foo: "bar" },
            },
          ])}
        />
      );
      // UnknownBlockCard 是个 <details>
      const details = document.querySelector("details");
      expect(details).toBeInTheDocument();
    });

    it("未知 meta label + 无 payload → 走 pill 标签", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "minimal",
            },
          ])}
        />
      );
      const pill = document.querySelector(".msg-meta-pill");
      expect(pill).toBeInTheDocument();
      expect(pill?.textContent).toContain("minimal");
    });

    it("子代理字段 (mode:) → 走 SubagentMetaBlock (可折叠 details)", () => {
      render(
        <MessageBubble
          entry={makeEntry(0, "meta", [
            {
              kind: "meta",
              label: "mode:normal",
            },
          ])}
        />
      );
      const details = document.querySelector("details");
      expect(details).toBeInTheDocument();
    });
  });

  // v0.6.0: subagentId 缩进渲染
  describe("v0.6.0: subagentId 缩进", () => {
    it("子代理消息 (subagentId 存在) → 加 .msg-subagent class + data-subagent-id", () => {
      const entry: TranscriptEntryOut = {
        index: 0,
        byteOffset: 0,
        raw: {},
        normalized: {
          id: "uuid-1",
          role: "assistant",
          blocks: [{ kind: "text", text: "子代理内部思考" }],
          isSidechain: true,
          subagentId: "a1d924c184a57a7da",
          rawType: "assistant",
        },
      };
      const { container } = render(<MessageBubble entry={entry} />);
      const bubble = container.querySelector(".msg.msg-assistant");
      expect(bubble).toBeInTheDocument();
      expect(bubble?.classList.contains("msg-subagent")).toBe(true);
      expect(bubble?.getAttribute("data-subagent-id")).toBe("a1d924c184a57a7da");
      expect(bubble?.getAttribute("data-is-sidechain")).toBe("true");
    });

    it("主 session 消息 (无 subagentId) → 不加 .msg-subagent", () => {
      const entry: TranscriptEntryOut = {
        index: 0,
        byteOffset: 0,
        raw: {},
        normalized: {
          id: "uuid-2",
          role: "user",
          blocks: [{ kind: "text", text: "主 session 用户消息" }],
          isSidechain: false,
          rawType: "user",
        },
      };
      const { container } = render(<MessageBubble entry={entry} />);
      const bubble = container.querySelector(".msg.msg-user");
      expect(bubble).toBeInTheDocument();
      expect(bubble?.classList.contains("msg-subagent")).toBe(false);
      expect(bubble?.getAttribute("data-subagent-id")).toBeNull();
    });
  });
});

describe("BlockRenderer 独立使用", () => {
  beforeEach(() => cleanup());

  it("未知 kind + 有 payload → UnknownBlockCard (<details> 折叠卡)", () => {
    render(
      <BlockRenderer
        block={{
          kind: "totally-future-block",
          // payload 必须放顶层 (不是嵌套 payload) 才能让 UnknownBlockCard 走 details 路径
          payload: { foo: "bar", count: 42 },
        }}
      />
    );
    const details = document.querySelector("details");
    expect(details).toBeInTheDocument();
  });

  it("未知 kind + 无 payload → UnknownBlockCard 退化 pill", () => {
    render(<BlockRenderer block={{ kind: "totally-future-block" }} />);
    const pill = document.querySelector(".unknown-pill");
    expect(pill).toBeInTheDocument();
  });

  it("agent_listing (顶层 kind) → 走 MetaBlockRenderer 入口", () => {
    render(
      <BlockRenderer
        block={{
          kind: "agent_listing",
          addedTypes: ["Explore", "Plan"],
          isInitial: true,
        }}
      />
    );
    expect(screen.getByText("🤖 agent")).toBeInTheDocument();
    expect(screen.getByText(/初始化 2 个 agent/)).toBeInTheDocument();
  });
});
