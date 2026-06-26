/**
 * Playwright global setup — 手动起 vite preview server
 *
 * 为什么不走 Playwright 的 webServer 配置:
 * Playwright 的 webServer URL check 走系统代理 (http_proxy env),
 * 某些 dev 环境的代理指向不存在的 server → check 失败 → 60s timeout。
 *
 * 改成 global setup,直接 spawn server,Playwright 不再 check URL。
 * 测试通过 reuseExistingServer: true 复用。
 */

import { spawn, type ChildProcess } from "node:child_process";

const PORT = 4173;
let server: ChildProcess | null = null;

export default async function globalSetup() {
  // 先清掉代理 env (跟 test 时的 use.proxy: direct:// 配合)
  const env = { ...process.env };
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;

  server = spawn("pnpm", ["--filter", "@ocsv/frontend", "preview", "--port", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // 等待 server 真正起来
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("preview 启动超时")), 30_000);
    server!.stdout!.on("data", (data: Buffer) => {
      const s = data.toString();
      if (s.includes("Local:") || s.includes("http://localhost:" + PORT)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server!.stderr!.on("data", (data: Buffer) => {
      // vite 启动错误
      const s = data.toString();
      if (s.toLowerCase().includes("error")) {
        // 容忍某些非致命错误
        if (!s.includes("strictPort")) {
          console.error("[preview stderr]", s);
        }
      }
    });
    server!.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`preview 进程退出 code=${code}`));
      }
    });
  });

  // 等 server 几秒就绪
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[playwright] vite preview 起在 http://localhost:${PORT}`);

  // 把 server PID 写到 globalThis 供 teardown 关闭
  (globalThis as Record<string, unknown>).__PREVIEW_PID__ = server.pid;
  (globalThis as Record<string, unknown>).__PREVIEW_PROCESS__ = server;
}

export async function globalTeardown() {
  if (server) {
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}
