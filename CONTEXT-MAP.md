# CONTEXT-MAP

Repo root pointer to per-context `CONTEXT.md` files. Skills should read the
context(s) relevant to the topic at hand.

## Contexts

- **`packages/frontend`** — React 19 + Zustand + Tauri webview frontend. Session
  browsing UI, transcript rendering, virtualized message lists, MetaBlock chart
  series. See `packages/frontend/CONTEXT.md`.
- **`packages/shared`** — Cross-package TypeScript types + Zod schemas. Tauri
  command wire types (`NormalizedMessage`, `NormalizedBlock`, etc.). See
  `packages/shared/CONTEXT.md`.
- **`src-tauri`** — Rust backend (Tauri 2 + axum-less commands). Parsers for
  three wire formats (`claude`, `kimi`, `openclaw`), session metadata builder,
  transcript streaming, DB layer (planned), commands exposed to the webview.
  See `src-tauri/CONTEXT.md`.

## System-wide decisions

`docs/adr/` holds decisions that span more than one context (release process,
monorepo layout, CI, etc.). Per-context ADRs live under `src/<context>/docs/adr/`
(e.g. `src-tauri/docs/adr/` for parser-layer decisions).

## M10 single-pass cutover status (v0.9.27)

`src-tauri` has collapsed the two-pass sync architecture
(`db/sync.rs::Two-pass sync` per `src-tauri/CONTEXT.md`). v0.9.27 (M10)
deletes the Pass 2 enrichment loop and `meta_extras.rs` entirely —
`upsert_session_meta` now writes all 47 columns in a single INSERT,
and `parser::meta_aggregator::{aggregate_claude_openclaw, aggregate_kimi}`
produces the full SessionMeta struct in one file scan. v0.9.26 (M9)
validated byte-identity via parallel-run for 3 kimi fields before the
cutover; that debug-check is now gone. The single-pass sync runs as the
only path; there is no frontend-visible behavior change.
