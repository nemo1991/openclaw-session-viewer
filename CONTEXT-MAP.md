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

## M9 parallel-run status (v0.9.26)

`src-tauri` is mid-way through collapsing the two-pass sync architecture
(`db/sync.rs::Two-pass sync` per `src-tauri/CONTEXT.md`). v0.9.26 introduces
a parallel-run mode where 3 kimi-only SessionMeta fields are computed by both
Pass 1 (`scan_kimi_usage`) and Pass 2 (`meta_extras::build_meta_full_kimi`),
and any divergence is `log::warn!`d in debug builds. M10 (v0.9.27) will cut
over to Pass 1 only and delete `meta_extras.rs`. Until then, both paths run
side-by-side — there is no frontend-visible behavior change.
