/**
 * 生成一个测试用 JSONL fixture,用于本地 dev / 调试
 *
 * 用法:
 *   pnpm tsx scripts/seed-fixture.ts [count] [out]
 *
 * 默认生成 1000 条记录到 fixtures/sample-claude.jsonl
 */

import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const count = parseInt(process.argv[2] ?? "1000", 10);
const out = resolve(process.argv[3] ?? "fixtures/sample-claude.jsonl");

mkdirSync(dirname(out), { recursive: true });

const lines: string[] = [];

const baseTime = Date.parse("2026-06-15T10:00:00Z");
const SESSION_ID = "fixture-session-uuid-1234";
const PROMPT_ID = "fixture-prompt-uuid";

for (let i = 0; i < count; i++) {
  const ts = new Date(baseTime + i * 60_000).toISOString();
  const uuid = `uuid-${i.toString().padStart(6, "0")}`;

  if (i === 0) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        timestamp: ts,
        sessionId: SESSION_ID,
        parentUuid: null,
        isSidechain: false,
        promptId: PROMPT_ID,
        message: {
          role: "user",
          content: "请帮我实现一个 TODO 应用的 CRUD 接口,使用 TypeScript 和 SQLite",
        },
      })
    );
    continue;
  }

  if (i % 7 === 0) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        timestamp: ts,
        sessionId: SESSION_ID,
        parentUuid: `uuid-${(i - 1).toString().padStart(6, "0")}`,
        message: {
          role: "user",
          content: `补充:第 ${i} 条消息 - 增加分页功能,每页 20 条`,
        },
      })
    );
    continue;
  }

  if (i % 3 === 0) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid,
        timestamp: ts,
        sessionId: SESSION_ID,
        parentUuid: `uuid-${(i - 1).toString().padStart(6, "0")}`,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          content: [
            { type: "thinking", thinking: `让我先看看当前的目录结构,看看是否有现成的 schema。` },
            { type: "text", text: `让我先查看一下当前项目结构。` },
            {
              type: "tool_use",
              id: `tool_${i}`,
              name: "Bash",
              input: { command: `ls -la src/`, description: "列出 src 目录" },
            },
          ],
          usage: {
            input_tokens: 1000 + i * 10,
            output_tokens: 200 + i * 5,
            cache_read_input_tokens: 500,
          },
        },
      })
    );
    continue;
  }

  if (i % 3 === 1) {
    lines.push(
      JSON.stringify({
        type: "user",
        uuid,
        timestamp: ts,
        sessionId: SESSION_ID,
        parentUuid: `uuid-${(i - 1).toString().padStart(6, "0")}`,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool_${i - 1}`,
              content: "src/index.ts\nsrc/db.ts\nsrc/routes.ts",
              is_error: false,
            },
          ],
        },
      })
    );
    continue;
  }

  lines.push(
    JSON.stringify({
      type: "assistant",
      uuid,
      timestamp: ts,
      sessionId: SESSION_ID,
      parentUuid: `uuid-${(i - 1).toString().padStart(6, "0")}`,
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `已了解项目结构,这是第 ${i} 条助手回复。` }],
        usage: { input_tokens: 800, output_tokens: 100 },
      },
    })
  );
}

// 添加一些 meta 记录
lines.splice(
  5,
  0,
  JSON.stringify({
    type: "mode",
    timestamp: lines[0] ? JSON.parse(lines[0]!).timestamp : new Date().toISOString(),
    sessionId: SESSION_ID,
  })
);

writeFileSync(out, lines.join("\n") + "\n");

console.log(`✓ Generated ${lines.length} records → ${out}`);
console.log(`  size: ${(statSync(out).size / 1024).toFixed(1)} KB`);