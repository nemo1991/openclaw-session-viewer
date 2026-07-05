/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@ocsv/shared": path.resolve(__dirname, "../shared/src"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    // 默认 node 环境 (.test.ts);需要 DOM 的 test (.test.tsx) 显式:
    // `// @vitest-environment jsdom`
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // v0.7.0:coverage(v8)— 排除测试文件 / CSS / Tauri 桥 / generated types
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      // 排除:测试文件自身、setup、类型声明、Tauri command 桥
      exclude: [
        "node_modules/",
        "src/test/**",
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "src/vite-env.d.ts",
        "src/test/setup.ts",
        // Mock-only 文件通常不需覆盖
        "**/mocks/**",
        // Playwright e2e 不计入 unit coverage
        "e2e/**",
      ],
    },
  },
});
