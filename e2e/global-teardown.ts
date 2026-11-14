/**
 * Playwright global teardown — 关闭 globalSetup 自己起的 vite preview。
 *
 * 必须是独立文件:Playwright 对 globalSetup 和 globalTeardown 都调用各自
 * 文件的 default export。原先 config 把两者都指向 global-setup.ts,导致
 * teardown 阶段又跑了一遍 setup(去复用刚被自己占住的 4173),而真正的
 * teardown 命名导出从未被调用 —— preview 进程因此成了孤儿,下次运行报
 * "Port 4173 is already in use"。
 *
 * 只关自己起的进程:若 setup 走的是「复用已有 preview」分支,
 * globalThis 上不会挂 __PREVIEW_PROCESS__,这里就什么都不做。
 */

import type { ChildProcess } from "node:child_process";

export default async function globalTeardown() {
  const proc = (globalThis as Record<string, unknown>).__PREVIEW_PROCESS__ as
    | ChildProcess
    | undefined;
  if (proc && !proc.killed && proc.exitCode === null) {
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}
