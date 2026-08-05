/**
 * v0.8.14 item A: 共享 rebuild_db confirm 文案。
 *
 * v0.8.13 改了 rebuild_db 行为 — 只清可重建的 session_meta,保留
 * override/tag/link/history (v0.8.12 之前是清 6 表,跟 UI 文案相反,误删用户数据)。
 *
 * HomeStatusBar 在 v0.8.13 已经把 confirm 改成新措辞。
 * DatabasePanel 还在用旧的 v0.8.12 措辞 — "会清空所有 session_meta / override / tag / link",
 * 跟实际 rebuild_db 行为相反,误让用户以为 rebuild 会丢数据。
 *
 * 提取为常量,两处共用 — 改一处全跟随。
 */
export const REBUILD_CONFIRM_TEXT =
  "重建数据库会清空 sync 缓存并触发全量重新同步。\n所有用户数据 (override / tag / link / 搜索历史) 都保留。\n\n确认重建?";

export const REBUILD_SUCCESS_HINT = "数据库已重建";
