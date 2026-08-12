/**
 * v0.9.24 (M7-C): SessionNotesPanel — L0 层 notes + links + link dialog
 *
 * 抽出 SessionDetailRoute.tsx 尾部 3 个 region:
 * 1. **notes panel** — 显示当前 session 的 markdown 笔记 + 编辑模式切换 +
 *    保存 (commitNotes)
 * 2. **links panel** — 显示 链接到 (linksTo) / 被链接 (linksFrom) 两组关系
 * 3. **link dialog** — modal 弹窗, 输入目标 sessionId + 备注 → addLink
 *
 * 数据流:
 * - props `meta` 必填 (route 已做 notFound 早 return)
 * - props `notesEditing` visibility toggle 由 route 统管 (1 bit state)
 *   actions row 的 sticky note button 调 onNotesToggle 翻状态
 * - props `onNotesToggle` 回调 route 用 — actions row button 触发
 *
 * 内部 hooks:
 * - `useOverrides()` 读 snap.notes + linksTo + linksFrom + 调 setNotes /
 *   addLink / removeLink mutation API
 *
 * 内部 useState:
 * - notesDraft: textarea 当前编辑内容 (sessionId 切换时 useEffect 同步)
 * - linkDialogOpen: link dialog 可见性
 * - linkTarget / linkNote: link dialog 输入框内容
 *
 * Visibility 规则 (跟 route 原 inline 一致):
 * - notes panel: `notesEditing || overrides.snap.notes[sid]` 非空时显示
 * - links panel: `linksTo.length || linksFrom.length` 非空时显示
 * - link dialog: `linkDialogOpen === true` 时显示 (modal backdrop)
 *
 * CSS: 跟 SessionDetailRoute 共享 .session-notes-panel / .session-links-panel /
 * .link-dialog-* class (子组件 import 父 CSS file)。
 */

import { useEffect, useState } from "react";
import { StickyNote, X } from "lucide-react";

import type { SessionMeta } from "@ocsv/shared";
import { useOverrides } from "../../state/overridesStore";
import "../../routes/SessionDetailRoute.css";

export interface SessionNotesPanelProps {
  meta: SessionMeta;
  /** notes panel 可见性 toggle (route 层 state) */
  notesEditing: boolean;
  /** notes button 调它 toggle notesEditing */
  onNotesToggle: () => void;
  /** link dialog 可见性 (route 层 state, actions row 的 link button 调 onLinkAdd 翻 true) */
  linkDialogOpen: boolean;
  /** actions row 的 link button 调它 → route setLinkDialogOpen(true) */
  onLinkAdd: () => void;
  /** link dialog 关闭 (backdrop / 取消 button 都用它) */
  onLinkDialogClose: () => void;
}

// ===== Sub-component: NotesPanel =====

interface NotesPanelProps {
  meta: SessionMeta;
  notesEditing: boolean;
  notesContent: string;
  onEditClick: () => void;
  onSaveClick: () => void;
  onDraftChange: (v: string) => void;
}

function NotesPanel({
  meta,
  notesEditing,
  notesContent,
  onEditClick,
  onSaveClick,
  onDraftChange,
}: NotesPanelProps) {
  return (
    <div className="session-notes-panel" data-testid="session-notes-panel">
      <div className="notes-header">
        <StickyNote size={14} />
        <span>笔记</span>
        {notesEditing && (
          <button onClick={onSaveClick} className="notes-save">
            保存
          </button>
        )}
        {!notesEditing && <button onClick={onEditClick}>编辑</button>}
      </div>
      {notesEditing ? (
        <textarea
          autoFocus
          value={notesContent}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder="Markdown 笔记..."
          rows={6}
        />
      ) : (
        <pre className="notes-display">{notesContent}</pre>
      )}
    </div>
  );
}

// ===== Sub-component: LinksPanel =====

interface LinksPanelProps {
  linksTo: Array<{ toSession: string; note: string | null }>;
  linksFrom: Array<{ fromSession: string; note: string | null }>;
  onRemoveLink: (toSession: string) => void;
}

function LinksPanel({ linksTo, linksFrom, onRemoveLink }: LinksPanelProps) {
  return (
    <div className="session-links-panel">
      {linksTo.length > 0 && (
        <div className="links-group">
          <h4>链接到 →</h4>
          {linksTo.map((l) => (
            <div key={l.toSession} className="link-item">
              <span>{l.toSession.slice(0, 12)}…</span>
              {l.note && <span className="link-note">({l.note})</span>}
              <button onClick={() => onRemoveLink(l.toSession)} title="删除链接">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {linksFrom.length > 0 && (
        <div className="links-group">
          <h4>被链接 ←</h4>
          {linksFrom.map((l) => (
            <div key={l.fromSession} className="link-item">
              <span>{l.fromSession.slice(0, 12)}…</span>
              {l.note && <span className="link-note">({l.note})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Sub-component: LinkDialog =====

interface LinkDialogProps {
  open: boolean;
  target: string;
  note: string;
  onTargetChange: (v: string) => void;
  onNoteChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

function LinkDialog({
  open,
  target,
  note,
  onTargetChange,
  onNoteChange,
  onClose,
  onSubmit,
}: LinkDialogProps) {
  if (!open) return null;
  return (
    <div className="link-dialog-backdrop" onClick={onClose}>
      <div className="link-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>链接到其他 session</h3>
        <input
          autoFocus
          placeholder="目标 session id"
          value={target}
          onChange={(e) => onTargetChange(e.target.value)}
        />
        <input
          placeholder="备注(可选)"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
        />
        <div className="link-dialog-actions">
          <button onClick={onClose}>取消</button>
          <button onClick={onSubmit} className="primary">
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Main component: SessionNotesPanel =====

export function SessionNotesPanel({
  meta,
  notesEditing,
  onNotesToggle,
  linkDialogOpen,
  onLinkAdd: _onLinkAdd,
  onLinkDialogClose,
}: SessionNotesPanelProps) {
  const overrides = useOverrides();
  const [notesDraft, setNotesDraft] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [linkNote, setLinkNote] = useState("");

  // sessionId 切换时重置 notes 草稿
  useEffect(() => {
    setNotesDraft(overrides.snap.notes[meta.sessionId] ?? "");
  }, [meta.sessionId, overrides.snap.notes]);

  // 派生: 当前 notes + links
  const notesContent = overrides.snap.notes[meta.sessionId] ?? "";
  const linksTo = overrides.snap.linksTo[meta.sessionId] ?? [];
  const linksFrom = overrides.snap.linksFrom[meta.sessionId] ?? [];

  const commitNotes = async () => {
    onNotesToggle();
    try {
      await overrides.setNotes(meta.sessionId, notesDraft);
    } catch (e) {
      console.error("setNotes failed", e);
    }
  };

  const addLink = async () => {
    if (!linkTarget.trim()) return;
    try {
      await overrides.addLink(meta.sessionId, linkTarget.trim(), linkNote.trim() || undefined);
      onLinkDialogClose();
      setLinkTarget("");
      setLinkNote("");
    } catch (e) {
      console.error("addLink failed", e);
    }
  };

  const startEdit = () => {
    setNotesDraft(notesContent);
    onNotesToggle();
  };

  return (
    <>
      {/* v0.8.0: notes 编辑面板 — visibility = notesEditing OR 有内容 */}
      {(notesEditing || notesContent) && (
        <NotesPanel
          meta={meta}
          notesEditing={notesEditing}
          notesContent={notesEditing ? notesDraft : notesContent}
          onEditClick={startEdit}
          onSaveClick={() => void commitNotes()}
          onDraftChange={setNotesDraft}
        />
      )}

      {/* links 列表 — visibility = 任一 linksTo / linksFrom 非空 */}
      {(linksTo.length > 0 || linksFrom.length > 0) && (
        <LinksPanel
          linksTo={linksTo}
          linksFrom={linksFrom}
          onRemoveLink={(toSession) => void overrides.removeLink(meta.sessionId, toSession)}
        />
      )}

      <LinkDialog
        open={linkDialogOpen}
        target={linkTarget}
        note={linkNote}
        onTargetChange={setLinkTarget}
        onNoteChange={setLinkNote}
        onClose={onLinkDialogClose}
        onSubmit={() => void addLink()}
      />
    </>
  );
}
