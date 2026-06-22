# 故障排除与开发经验

本文档记录项目开发过程中遇到的所有重要 bug、踩过的坑、调试经验。按问题类型分类。

---

## 🚨 关键问题(必修)

### 1. macOS: 直接运行裸二进制 → 窗口空白

**症状**: 应用启动,标题栏正确显示,但内部完全空白。

**根因**: Tauri 2 在 macOS 上通过 WKWebView 渲染 webview。WKWebView 子进程 (`com.apple.WebKit.WebContent.xpc`) 只能由 **LaunchServices** 通过 `.app` bundle 派生。直接执行二进制绕过 LaunchServices,主进程启动但 webview 无法 attach。

**复现**:
```bash
# ❌ 不工作 — 窗口出现但内容空白
./src-tauri/target/release/openclaw-session-viewer

# ✅ 工作
open src-tauri/target/release/bundle/macos/OpenClaw*.app
```

**诊断方法**:
```bash
# 启动后看进程树
ps -ef | awk '/openclaw-session-viewer/ && !/awk/ {print $2, $3}'
# 如果子进程 PID 是 1 (launchd),说明 webview 没 attach
# 如果有 com.apple.WebKit.WebContent.xpc 子进程,说明 OK
```

**解决**: 始终从 `.app` bundle 启动。CI/CD 也要传 `.app` 而不是裸二进制。

---

### 2. Zustand: 整个 store 对象作为 useEffect 依赖 → 死循环

**症状**: 点击搜索按钮后 1-2 秒崩溃,控制台报 `Maximum update depth exceeded`。

**根因**: 
```tsx
// ❌ 错的写法
const search = useSearchInSessionStore();  // 返回整个 state 对象
useEffect(() => {
    search.search(entries);  // 调用 action,触发 setState
}, [entries, search]);  // search 引用每次 setState 后都变
```

死循环:
```
state 变化 → search 引用变化 → useEffect 重跑 → search.search() 又 setState
→ search 引用再变 → useEffect 再跑 → ... → React 抛错
```

**解决**: Zustand 的 selector 模式
```tsx
// ✅ 正确
const search = useSearchInSessionStore((s) => s.search);
const open = useSearchInSessionStore((s) => s.open);
useEffect(() => {
    if (!open) return;
    search(entries);
}, [open, entries]);  // 不放整个 store 对象
```

**经验**: **永远不要把 `useStore()` 返回的对象放进 `useEffect`/`useKey` 的 deps**。要么用 selector,要么只订阅 action(action 引用稳定)。

---

### 3. 路径编码 round-trip 不一致

**症状**: 前端显示 `-Users-alice-projects-test`,但解码出来不是 `/Users/alice/projects/test`。

**根因**: 用 `key.replace(/-/g, "/")` 反推,但中文/数字混淆:
- `/Users/alice/test` → `-Users-alice-test` ✓
- `/Users/alice-projects/test` → `-Users-alice-projects-test` (看起来一样)
- 但反推: `-Users-alice-projects-test` 可能是 `/Users/alice/projects/test` 或 `/Users/alice-projects/test`

**解决**: 接受不确定性,标记 `workspaceGuess` 为推测值。在 UI 上加 "(推测)" 提示,不要假装是真实路径。

---

## 🐛 数据/Schema 相关

### 4. OpenClaw content 块使用 camelCase

**现象**: OpenClaw 工具调用在 UI 中显示为 `meta` 而不是 `tool_use`。

**根因**: Claude Code 用 `tool_use`,OpenClaw 用 `toolUse`(camelCase)。`normalize_content_block` 只识别 snake_case。

**修复** (`src-tauri/src/parser/claude.rs`):
```rust
"tool_use" | "toolUse" | "tool_call" | "function_call" => "tool_use".to_string(),
"tool_result" | "toolResult" => "tool_result".to_string(),
```

**测试**: 添加 `test_normalize_user_with_camelcase_tool_use` 覆盖。

### 5. OpenClaw tool 结果 role 错误

**现象**: OpenClaw 工具结果显示成"用户"消息气泡,样式不对。

**根因**: `normalize_entry` 把 OpenClaw `role: "tool"` 直接映射为 Claude 的 `user`(因为 Claude 格式中 tool 结果是 user 消息),但丢失了原始 `tool` role 信息。

**修复**:
```rust
let original_role = obj.get("message").and_then(|m| m.get("role"))...to_string();
// ... 调用 normalize() 后:
if original_role == "tool" {
    msg.role = "tool".to_string();  // 还原
}
```

### 6. `joinPath` 丢失绝对路径前缀

**现象**: `joinPath("/a/", "b", "c")` 返回 `"a/b/c"` 而非 `"/a/b/c"`。

**根因**: 实现把首段尾部斜杠去掉,但没意识到首段以 `/` 开头表示绝对路径。

**修复**:
```ts
const isAbsolute = first.startsWith("/");
const trimmed = filtered.map((p) => p.replace(/^\/+|\/+$/g, ""));
// ...
return isAbsolute ? `/${joined}` : joined;
```

### 7. normalizeClaudeRecord 不接受 null

**现象**: 传 `null` 给 `normalizeClaudeRecord` 会 throw `Cannot read property 'uuid' of null`。

**修复**: 加 null guard
```ts
export function normalizeClaudeRecord(
  record: ClaudeRecord | null | undefined,
  index: number
): NormalizedMessage | null {
  if (!record || typeof record !== "object") return null;
  // ...
}
```

---

## 🛠 开发/构建

### 8. pnpm install 报 503

**原因**: 默认镜像源 `http://mirrors.cloud.tencent.com/npm/` 经常返回 503。

**解决**:
```bash
pnpm config set registry https://registry.npmjs.org/
```

### 9. Tauri 系统依赖在 Linux 缺失

**症状**: `cargo tauri build` 在 Linux 上失败,报 `webkit2gtk-4.0 not found`。

**根因**: Ubuntu 22.04 默认装 webkit2gtk **4.0**,Tauri 2 需要 **4.1**。

**解决**:
```bash
sudo add-apt-repository ppa:webkitgtk/4.1
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev
```

### 10. Rust 测试看不到私有函数

**症状**: `cargo test` 报 `cannot find function 'normalize' in this scope`。

**根因**: 用 Edit 工具时如果不小心覆盖整个文件,只剩 `#[cfg(test)] mod tests` 没有顶层函数。

**解决**: 重新补回实现代码,或把 `pub fn` 改成 `pub(crate) fn`。

### 11. Tauri webview 在 sandbox 环境不渲染

**现象**: 在 Claude Code 的 CLI 环境中(非 GUI),webview 子进程永远不派生。

**诊断**: 这不是 bug,是 sandbox 限制。CLI 工具没有 GUI 显示权限。
- 可以用 Playwright headless 验证 webview 内容
- 实际用户体验不受影响(用户的 macOS 有 GUI)

---

## 🧪 测试经验

### 12. 测试覆盖度低时漏掉实际 bug

**现象**: 在 Phase 1-7 编写时没有足够测试,Phase 9 才补测。结果发现 3 个实际 bug:
- 上面 #4 (camelCase)
- 上面 #5 (tool role)
- 上面 #7 (null guard)

**经验**: 任何新增功能应该同 PR 提交测试。**测试驱动 vs 调试驱动** — 后者代价更高。

### 13. Playwright 验证 Tauri webview

由于无法直接截屏 Tauri 应用窗口(沙箱限制),用 Playwright + mock Tauri API 来验证 UI:

```js
await page.addInitScript(() => {
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    invoke: async (cmd, args) => { /* mock */ },
    transformCallback: (cb) => cb,  // ← 必须 mock,否则 listen() 报错
  };
});
```

注意: mock 必须实现 `transformCallback`,否则所有 `listen()` 调用都失败。

---

## 📝 总结

按修复成本排序的高频错误类型:

| 错误类型 | 出现次数 | 解决模式 |
|---|---|---|
| React 状态/zustand 使用 | 2 | 用 selector 而不是整个 store |
| 多 schema/camelCase 兼容 | 3 | 总是接受多种命名变体 |
| macOS/平台特定行为 | 2 | 用 `.app` bundle,验证签名/权限 |
| 测试覆盖不足 | 1 | TDD 同 PR 提交 |

**核心教训**: 测试覆盖率 = 调试时间。在 Phase 1-7 跳过测试导致 Phase 9 才发现 3 个 bug,Phase 9-10 严格 TDD 后基本零回归。