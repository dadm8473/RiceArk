import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PatchNotesModalContent, type PatchNote } from "./PatchNotesModal";

const notes: PatchNote[] = [
  {
    id: "note-1",
    title: "패치노트 ✨",
    body: "관리자만 게시할 수 있습니다.\n사용자는 읽기만 합니다.",
    publishedAt: "2026-06-16 12:00:00",
    updatedAt: "2026-06-16 12:00:00"
  }
];

describe("PatchNotesModalContent", () => {
  it("renders public patch notes without admin posting controls", () => {
    const html = renderToStaticMarkup(
      createElement(PatchNotesModalContent, {
        error: null,
        isAdmin: false,
        loading: false,
        notes,
        pending: false,
        editNoteId: null,
        form: { title: "", body: "" },
        onClose: vi.fn(),
        onCreate: vi.fn(),
        onDelete: vi.fn(),
        onEditCancel: vi.fn(),
        onEditStart: vi.fn(),
        onFieldChange: vi.fn(),
        onSaveEdit: vi.fn()
      })
    );

    expect(html).toContain("패치노트");
    expect(html).toContain("패치노트 ✨");
    expect(html).toContain("관리자만 게시할 수 있습니다.");
    expect(html).not.toContain("패치노트 작성");
    expect(html).not.toContain('class="primary-button"');
    expect(html).not.toContain("삭제");
  });

  it("shows create, edit, and delete controls to admins", () => {
    const html = renderToStaticMarkup(
      createElement(PatchNotesModalContent, {
        error: null,
        isAdmin: true,
        loading: false,
        notes,
        pending: false,
        editNoteId: null,
        form: { title: "", body: "" },
        onClose: vi.fn(),
        onCreate: vi.fn(),
        onDelete: vi.fn(),
        onEditCancel: vi.fn(),
        onEditStart: vi.fn(),
        onFieldChange: vi.fn(),
        onSaveEdit: vi.fn()
      })
    );

    expect(html).toContain("패치노트 작성");
    expect(html).toContain("제목");
    expect(html).toContain("내용");
    expect(html).toContain("게시");
    expect(html).toContain("수정");
    expect(html).toContain("삭제");
  });
});
