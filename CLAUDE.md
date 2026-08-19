# openclaw-session-viewer

Cross-platform desktop app (Tauri 2 + React 19 + Zustand) that lets users browse
local AI session JSONL files from OpenClaw, Claude Code, and Kimi. JSONL
streams are parsed in Rust, batch-collapsed into normalized messages, and
streamed to the React frontend for transcript rendering with virtualized lists
and a per-meta-kind chart series.

- GitHub: `nemo1991/openclaw-session-viewer`
- pnpm workspace: `packages/frontend`, `packages/shared`, `src-tauri`
- Stack: Rust 2021 + Tauri 2 + React 19 + TypeScript + Zustand + Vite + vitest

## Common commands

- `pnpm dev` — frontend dev server (Vite)
- `pnpm dev:tauri` — full app in dev mode (Tauri + Vite)
- `pnpm build` — build shared + frontend
- `pnpm build:tauri` — full Tauri release build
- `pnpm test` — run all tests (vitest frontend + cargo test backend)
- `pnpm typecheck` — `tsc --noEmit` across the workspace
- `pnpm lint` — workspace lint
- `pnpm format` — prettier (TS/TSX/CSS/MD)
- `pnpm format:rust` — cargo fmt

## Code conventions

- Match the surrounding code's comment density, naming, and idiom.
- Reference code as `file_path:line_number` — it's clickable.
- Snake_case Rust fields + `serde(rename_all = "camelCase")` for JSON
  compatibility. Frontend uses a `get()` helper to read either naming from
  snake_case backend or camelCase pre-rename payloads.
- Use `pnpm --filter @ocsv/<package>` to scope commands to one package.
- Lint-staged prettier reformats files on commit; expect reformatting.
- Avoid `git add` of generated files; see `.gitignore`.
- Reference code with `file:line` style. Long builder functions get
  `#[allow(clippy::too_many_lines)]` rather than artificial splits.

## Agent skills

### Issue tracker

GitHub Issues via `gh` CLI (repo `nemo1991/openclaw-session-viewer`). Remote
alias is `openclaw-session-lookup`, not `origin` — push via
`git push openclaw-session-lookup <branch>`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout — root `CONTEXT-MAP.md` points to per-context `CONTEXT.md`
(frontend / shared / src-tauri). See `docs/agents/domain.md`.
