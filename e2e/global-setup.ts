/**
 * Playwright global setup — 起(或复用) vite preview server
 *
 * 为什么不走 Playwright 的 webServer 配置:
 * Playwright 的 webServer URL check 走系统代理 (http_proxy env),
 * 某些 dev 环境的代理指向不存在的 server → check 失败 → 60s timeout。
 *
 * 改成 global setup,自己探测 + spawn,Playwright 不再 check URL。
 *
 * 复用语义(对应原注释里的 "reuseExistingServer"):
 * 若 4173 已有可用的 preview (CI 里 workflow 会先手动起一个),直接复用,
 * 不再 spawn 第二个 —— 否则两个 vite 抢同一端口,启动失败还会白等 30s。
 *
 * 注意:globalTeardown 在 ./global-teardown.ts,不能和本文件共用 ——
 * Playwright 对 setup/teardown 都调用各自文件的 default export。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4173;

/** 端口上是否已有可用的 preview(全局 fetch 不受 http_proxy env 影响) */
async function previewAlreadyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PORT}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  // 先清掉代理 env (跟 test 时的 use.proxy 配合)
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;

  if (await previewAlreadyRunning()) {
    console.log(`[playwright] 复用已运行的 vite preview: http://localhost:${PORT}`);
    return;
  }

  // 用当前 Node 直接跑 vite 的 JS 入口,而不是 spawn("pnpm", ...)。
  // Windows 上 pnpm 是 .cmd/.ps1 shim,spawn 不带 shell 会直接 ENOENT;
  // CI 跑 Ubuntu 的 pnpm 是 shell 脚本所以没暴露。绕开包管理器还能让
  // teardown 真正作用于 vite 进程本身,不留孤儿进程。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const frontendDir = path.join(repoRoot, "packages", "frontend");
  const viteBin = path.join(frontendDir, "node_modules", "vite", "bin", "vite.js");

  const server = spawn(
    process.execPath,
    [viteBin, "preview", "--port", String(PORT), "--strictPort"],
    {
      cwd: frontendDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    }
  );

  // 就绪判断:直接轮询 HTTP,不依赖 stdout 文本。
  // vite 被 spawn 成 pipe 子进程(非 TTY)时不会输出 "Local:" 横幅,
  // 靠 stdout 匹配会永远等不到 → 30s 假超时。
  let startupError = "";
  server.stderr!.on("data", (data: Buffer) => {
    startupError += data.toString();
    console.error("[preview stderr]", data.toString());
  });
  server.on("error", (err) => {
    startupError += String(err);
  });
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      startupError += `\npreview 进程退出 code=${code}`;
    }
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await previewAlreadyRunning()) {
      console.log(`[playwright] vite preview 起在 http://localhost:${PORT}`);
      // 供独立 teardown 文件关闭(两者在同一进程,共享 globalThis)
      (globalThis as Record<string, unknown>).__PREVIEW_PROCESS__ = server;
      return;
    }
    if (startupError) {
      server.kill();
      throw new Error(`preview 启动失败: ${startupError.trim()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`preview 启动超时 (30s)${startupError ? `: ${startupError.trim()}` : ""}`);
}
