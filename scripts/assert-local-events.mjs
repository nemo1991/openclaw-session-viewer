#!/usr/bin/env node
/**
 * v0.11 (A1) 零上传门禁:守住战略 D-2「本地优先、零上传」。
 *
 * v0.10 PRD 第十章原写「埋点上报」,与 D-2 冲突;A1 把埋点重定义为**本地事件日志**
 * (Tauri IPC → 本地 SQLite `event_log`)。本脚本静态断言:
 *   1. 埋点链路三个文件里无任何网络 API(剥离注释后扫描);
 *   2. 三个 PRD 事件在 Rust 白名单与前端调用点都真实存在;
 *   3. `event_log` 表在新库 SCHEMA_SQL 与老库 NEW_TABLES 两处都建;
 *   4. append_local_event 已注册到 Tauri invoke_handler。
 *
 * 说明:既有的 `llm/anthropic.rs` 用 reqwest 调 LLM,是用户在「AI 分析」里主动
 * 触发的功能,不在埋点链路内,故不扫全仓而只扫埋点文件。
 *
 * 退出码:0 = 通过 / 1 = 发现违规(打印文件与行号)。
 */

import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const TELEMETRY_FILES = [
  "src-tauri/src/db/event_log.rs",
  "src-tauri/src/commands/events.rs",
  "packages/frontend/src/lib/eventsApi.ts",
  // v0.11 (B2): 体检 tab 也是埋点调用点,必须一起纳入零上传扫描
  "packages/frontend/src/views/graph/HealthView.tsx",
];

const FORBIDDEN_NET = [
  "fetch(",
  "XMLHttpRequest",
  "sendBeacon",
  "new WebSocket",
  "reqwest",
  "axios",
  "HttpClient",
  "navigator.sendBeacon",
  "https://",
  "http://",
];

const EVENTS = ["analytics_view_open", "source_dimension_select", "retry_rate_displayed"];

/** @type {string[]} */
const errors = [];

function read(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    errors.push(`缺少文件: ${rel}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

/** 剥离 // 与 /* *\/ 注释,避免把文档里列举的禁用词当违规 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// 1) 埋点链路零网络 API
for (const rel of TELEMETRY_FILES) {
  const code = stripComments(read(rel));
  code.split(/\r?\n/).forEach((line, i) => {
    for (const api of FORBIDDEN_NET) {
      if (line.includes(api)) {
        errors.push(`${rel}:${i + 1} 出现网络 API「${api}」: ${line.trim()}`);
      }
    }
  });
}

// 2) 三事件真实落地:Rust 白名单 + 前端调用点
const rustEvents = read("src-tauri/src/commands/events.rs");
const rustConstants = read("src-tauri/src/db/event_log.rs");
const view = read("packages/frontend/src/views/graph/AnalyticsView.tsx");
for (const ev of EVENTS) {
  if (!rustConstants.includes(`"${ev}"`)) errors.push(`Rust 事件常量缺失: ${ev}`);
  if (!rustEvents.includes("ALLOWED_EVENTS")) {
    errors.push("commands/events.rs 未使用事件白名单");
  }
  if (!view.includes(`eventName: "${ev}"`)) {
    errors.push(`AnalyticsView.tsx 缺少 ${ev} 的埋点调用`);
  }
}
if (!view.includes('eventName: "analytics_ready"')) {
  errors.push("A3: AnalyticsView.tsx 缺少首屏耗时 analytics_ready 事件");
}

// 2b) v0.11 (B2): 体检 tab 的本地事件必须在 Rust 白名单与前端调用点同时存在
const healthView = read("packages/frontend/src/views/graph/HealthView.tsx");
if (!rustConstants.includes('"health_view_open"')) {
  errors.push("Rust 事件常量缺失: health_view_open");
}
if (!healthView.includes('eventName: "health_view_open"')) {
  errors.push("HealthView.tsx 缺少 health_view_open 的埋点调用");
}

// 3) 新库 / 老库两处 DDL
for (const rel of ["src-tauri/src/db/schema.rs", "src-tauri/src/db/migrations.rs"]) {
  if (!read(rel).includes("CREATE TABLE IF NOT EXISTS event_log")) {
    errors.push(`${rel} 缺少 event_log 建表语句`);
  }
}

// 4) command 注册
const libRs = read("src-tauri/src/lib.rs");
for (const cmd of ["append_local_event", "list_local_events", "local_event_p95"]) {
  if (!libRs.includes(`commands::events::${cmd}`)) {
    errors.push(`lib.rs invoke_handler 未注册 ${cmd}`);
  }
}

if (errors.length > 0) {
  console.error(`本地事件日志零上传门禁失败(${errors.length} 项):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error("\n埋点必须只写本地 SQLite,禁止任何网络上报(D-2)。");
  process.exit(1);
}

console.log(
  `A1 门禁通过:${TELEMETRY_FILES.length} 个埋点文件零网络 API,` +
    `3 个 PRD 事件 + analytics_ready + health_view_open 已落地,新/老库 DDL 与 command 注册齐备。`
);
console.log(`  扫描文件:${TELEMETRY_FILES.map((f) => relative(ROOT, join(ROOT, f))).join(", ")}`);
