#!/usr/bin/env node
/**
 * FR-T3 回归门禁:断言 `packages/` 下的 TS/TSX 源码不再出现
 * `NormalizedMessageFE` / `NormalizedBlockFE` 弱类型。
 *
 * v0.10 核验报告偏差 #3:PRD/CHANGELOG 声称「grep 断言无 FE 残留」,
 * 但 CI / husky / lint-staged / scripts 里都没有自动化步骤。此脚本由
 * `pnpm assert:no-fe-types` 调用,并在 CI 与 pre-commit hook 中执行。
 *
 * 只扫 packages/ 下的源码,不扫 docs/:PRD、核验报告与路线图需要引用这两个
 * 历史名称来描述「移除弱类型」这件事,扫文档会产生无法消除的误报。
 *
 * 退出码:0 = 干净 / 1 = 发现残留(打印文件与行号)。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_ROOT = join(ROOT, "packages");
const FORBIDDEN = ["NormalizedMessageFE", "NormalizedBlockFE"];
const SCAN_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".vitest-tmp",
  "playwright-report",
  "test-results",
]);

/** @returns {string[]} 待扫描文件绝对路径 */
function collectFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...collectFiles(join(dir, entry.name)));
    } else if (entry.isFile() && SCAN_EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** @returns {{file: string, line: number, text: string, hit: string}[]} */
function findHits() {
  /** @type {{file: string, line: number, text: string, hit: string}[]} */
  const hits = [];
  for (const file of collectFiles(SCAN_ROOT)) {
    // 生成产物体积很小且不含 FE 名;stat 只用于跳过异常大文件,避免读入构建产物
    if (statSync(file).size > 2 * 1024 * 1024) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const name of FORBIDDEN) {
        if (text.includes(name)) {
          hits.push({ file: relative(ROOT, file), line: i + 1, text: text.trim(), hit: name });
        }
      }
    });
  }
  return hits;
}

const hits = findHits();
if (hits.length > 0) {
  console.error(`检测到 ${hits.length} 处 FE 弱类型残留(FR-T3 回归门禁):`);
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line} [${h.hit}] ${h.text}`);
  }
  console.error("渲染层应统一引用 @ocsv/shared 的 NormalizedMessage / NormalizedBlock。");
  process.exit(1);
}
console.log(`FR-T3 门禁通过:packages/ 下 TS/TSX 源码无 ${FORBIDDEN.join(" / ")} 残留。`);
