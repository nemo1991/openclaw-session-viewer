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
const search = useSearchInSessionStore(); // 返回整个 state 对象
useEffect(() => {
  search.search(entries); // 调用 action,触发 setState
}, [entries, search]); // search 引用每次 setState 后都变
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
}, [open, entries]); // 不放整个 store 对象
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

**根因**: Claude Code 用 `tool_use`,OpenClaw 用 `toolUse`(camelCase)。早期 `normalize_content_block` 只识别 snake_case。

**修复**: 在 `ToolUseBlockHandler::matches()` 同时识别 5 个 alias (`tool_use`/`toolUse`/`tool_call`/`function_call`/`toolCall`),`ToolResultBlockHandler` 同理覆盖 `tool_result`/`toolResult`。

**测试**: `parser/blocks/tool_use.rs` 每个 alias 各一个测试 + `arguments → input` 重命名测试。

### 5. OpenClaw tool 结果 role 错误

**现象**: OpenClaw 工具结果显示成"用户"消息气泡,样式不对。

**根因**: 早期 `normalize_entry` 把 OpenClaw `role: "tool"` 直接映射为 Claude 的 `user`(Claude 格式中 tool 结果是 user 消息),丢失了原始 `tool` role 信息。

**修复**: 自 v0.3.0 起 `openclaw.rs` 不再 wrapper 转 Claude,`role` 直接保留为 `tool`,不再需要后续 patch。

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

### 11.5. Windows [object Object] 错误(v0.2.6 修复)

**现象**: Windows 用户打开 liushuyou/91d1796e 详情页,`[object Object]` 字面量出现。

**根因**: 多个相互作用 — Tauri `serde(flatten)` 在 WebView2 上序列化行为与 WKWebView 不一致,导致
`block.text` 偶尔从 string 变成 object 形态。前端 `String(block.text)` 直接输出 `[object Object]`。

**修复**:

- Rust 端 `TextBlockHandler` 内部用 `Value::as_str` 强制断言,失败时用 `Value::to_string()` 兜底
- 前端 `BlockRenderer` 加类型守卫: `typeof block.text === "string"` 才用,否则尝试 `block.text.text` / `JSON.stringify`
- 前端 `extractErrorMessage(e)` 优先提取 `message`/`kind` 字段

### 11.6. 路径安全 Windows UNC 前缀(v0.2.6 修复)

**现象**: Windows 上 `canonicalize()` 返回 `\\?\C:\Users\...`,而 target 是短路径 `C:\Users\...`,前缀比较失败,误报路径越界。

**修复**: `path_starts_with()` 统一分隔符、忽略大小写、去掉 `\\?\` 前缀。

### 11.7. `*.trajectory.jsonl` 误认为 session(v0.2.3 修复)

**现象**: 会话列表出现重复 session,一次 36KB(主),一次 624KB(trajectory)。

**根因**: `Path::extension()` 只取最后一段扩展名,`.trajectory.jsonl` 被认成 `jsonl`。

**修复**: walker 用 `file_stem` 末缀过滤 `*.trajectory`。

### 11.8. `[skip ci]` 同时跳过 tag 触发的 release workflow(v0.3.1 踩坑)

**现象**: 打 tag `v0.3.1` 后,GitHub Actions 没有触发 Release workflow。

**根因**: tag 指向的 commit message 含 `[skip ci]`,GitHub Actions 把这个标记当作"任何 workflow 都跳过",**包括 `on: push: tags` 触发的 release job**。

**解决**:

- 选项 A:把版本号改到单独的 release commit(不带 `[skip ci]`)
- 选项 B:已在 README/CHANGELOG 改完 → commit 不带 `[skip ci]` → 重新打 tag
- 选项 C:`gh workflow run Release --ref v0.3.1` 手动触发(本次采用)

**教训**:**任何触发发布/部署的关键 commit 都不要带 `[skip ci]`**。docs-only 改用 paths-ignore 即可,不要靠 commit message 标记。

### 11.9. macOS Gatekeeper 拦截未签名 DMG(v0.3.1 文档化)

**现象**: 首次打开 GitHub 下载的 `.dmg`,弹出"`OpenClaw Session Viewer` 已损坏,无法打开"。

**根因**: CI 产出的 DMG 没 Apple 开发者签名,Gatekeeper quarantine 拒绝执行。

**临时解决**: 拖入 Applications 后执行

```bash
sudo xattr -rd com.apple.quarantine "/Applications/OpenClaw Session Viewer.app"
```

或右键 App → 打开 → 对话框点「打开」。

**长期解决**: 接入 Apple Developer ID + notarization(未在路线图优先级内)。

---

## 🔐 v0.6.x 文件路径 reveal & 子代理 UI

### 14. `reveal in Finder` 没反应 / 静默失败 (v0.6.0)

**现象**: 点击 `Read` / `Edit` / `Write` 工具结果的 `filePath` 链接,Finder 没打开,UI 没任何反馈。

**根因**: `reveal_in_finder` 失败时,旧实现只 `console.warn` 不给用户反馈,用户以为没点中。

**修复**:

- `MetaBlock.tsx` 加行内 `RevealErrorActions`: 显示人类语言化的错误描述 + 「复制路径」/「去设置」/「一键开启允许越界」三按钮
- 「一键开启」会 **先弹 confirm 弹窗告知风险**, 确认后:
  - toggle `settings.pathSecurity.allowRelaxed = true`
  - **自动推断** `defaultExportDir = <.claude 上级>`(从 `path.match(/^(.*?\.claude)(\/|$)/)`)
  - 重新调 reveal 实现 retry
- `ToolResultCard.tsx` 的 filePath 链接也接入(原 `revealAndNotify` 走的是 `console.warn` 静默分支,改为 toast — v0.6.0 行内错误不变)

### 15. agent_listing 芯片单行溢出 (v0.6.x)

**现象**: v0.6.0 P0-B ship 后,用户截图反馈 agent_listing_delta 显示 6 个 chip 全部排成一行,最后一个被截成 `+ statusl`。

**根因(三层)**:

1. `.msg { overflow: hidden }` 是元凶 — 任何超出宽度的内容都被裁掉
2. `.meta-block-flat` 只有 `max-width: 100%` 没有 `width: 100%`,允许继承父级宽度
3. `.meta-tag { max-width: 240px }` 太宽,6 个 chip 总宽撑出但不触发 wrap

**修复链路**:

```css
.msg {
  /* 注释掉 overflow: hidden */
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.meta-block-flat {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.meta-section,
.meta-list {
  width: 100%;
  box-sizing: border-box;
}
.meta-tag {
  max-width: 200px; /* 240 → 200 */
  min-width: 0;
  flex-shrink: 1;
  overflow-wrap: anywhere;
  word-break: break-word;
}
```

同时 `MetaBlock.tsx` 加 `title={a}` 让 chip hover 显示完整名(即便 wrap 后字短)。

### 16. `~/.claude/plans/*.md` reveal 被 PathSecurity 拒 (v0.6.0 → v0.6.1)

**现象**: 用户点 `.plan` 文件 reveal 按钮,看到 `⚠ PathSecurity: 需提供 workspace_root (lock-down 模式)`。

**根因**: `paths::assert_within_any_root` v0.6.0 实现只允许 `~/.claude/projects/` 子树,但 `.plan` 文件在 `~/.claude/plans/`,必然 fail。

**修复**(两个 commit):

- **`fs/paths.rs`**: `assert_within_any_root` 改为接受整 `~/.claude/` + 新 Rust 测试
- **`SettingsRoute.tsx`**: 加「选择 `~/.claude` 作为默认导出目录」按钮(用户友好分支,不需要放开全局锁)
- **`MetaBlock.tsx::unlockAndRetry`**: 自动从 path 推断 `.claude` 上级,作为 `defaultExportDir` 写入(防再被 lock-down 拒)

### 17. BlockRenderer meta 入口漏传 parentJsonlPath (v0.6.1)

**现象**: 用户报 `Plan` reveal 失败,但 `SettingsRoute` 加锁后**仍**失败。

**根因**: `MessageBubble.tsx::BlockRenderer` 把 meta kind 派给 `MetaBlock` 时**没**透传 `parentJsonlPath`。结果 `useFileReveal` 拿不到 `sessionJsonlPath`,推导不出 `workspaceRoot`,lock-down 直接拒。

**修复**:

```tsx
// 旧:
return <MetaBlock block={block} label={...} />;
// 新:
return <MetaBlock block={block} label={...} parentJsonlPath={parentJsonlPath} />;
```

教训:**任何透传到 hook 的 prop,新加 entry point 时一定要继续透传**(hooks 依赖 prop → prop 缺失 → 静默 fallback 到 null)。

### 18. 设置页没有 reveal 相关设置 (v0.6.1)

**现象**: 用户报"设置里没有 reveal 相关设置"。只看到「数据源」「API」「外观」,找不到`pathSecurity`。

**根因**: v0.6.0 引入 `settings.pathSecurity`,但 UI 一直漏加对应的 input。文档 README 也没列。

**修复**:

- `SettingsRoute.tsx` 加 `path-security-section`(ShieldCheck icon + checkbox + hint 文本)
- lock-down 模式下显示「选择 ~/.claude 作为默认导出目录」次要按钮
- README + CHANGELOG 同步这条 UI

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
    invoke: async (cmd, args) => {
      /* mock */
    },
    transformCallback: (cb) => cb, // ← 必须 mock,否则 listen() 报错
  };
});
```

注意: mock 必须实现 `transformCallback`,否则所有 `listen()` 调用都失败。

---

## 📝 总结

按修复成本排序的高频错误类型:

| 错误类型                 | 出现次数 | 解决模式                                                                |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| React 状态/zustand 使用  | 2        | 用 selector 而不是整个 store                                            |
| 多 schema/camelCase 兼容 | 3        | 总是接受多种命名变体(handler `matches()` 接受多个 alias)                |
| 平台特定行为             | 3        | macOS 用 `.app` bundle + DMG 公证;Linux webkit2gtk 4.1;Windows UNC 路径 |
| 测试覆盖不足             | 1        | TDD 同 PR 提交                                                          |
| 路径遍历 / 输入校验      | 3        | `assert_within_lexical` + 前端类型守卫                                  |
| 平台特定 bug             | 1        | CI 测三平台,Windows 错误显式提取 `message`/`kind` 字段                  |

**核心教训**:

1. **测试覆盖率 = 调试时间**。早期跳过测试导致 Phase 9 才发现 3 个 bug;严格 TDD 后基本零回归。
2. **多源兼容永远不要假设字段名固定**。OpenClaw 用 camelCase、pi-coding-agent 又用 snake_case、`toolCall` 还混进来。`BlockHandler::matches` 接受所有已知 alias 是最便宜的兼容方式。
3. **`[skip ci]` 是把双刃剑**。改文档方便,但**关键 release commit 不应带**。
4. **前端不要 `String(anything)`**。永远先 `typeof === "string"` 守卫,或者 `extractErrorMessage()` 抽象。
