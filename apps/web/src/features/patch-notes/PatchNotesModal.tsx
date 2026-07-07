import { FileText, Pencil, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPatch, apiPost, ApiClientError } from "../../api/client";

export interface PatchNote {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  updatedAt: string;
}

export interface PatchNoteFormState {
  title: string;
  body: string;
}

type PatchNotesPayload = {
  notes: PatchNote[];
};

type PatchNotePayload = {
  note: PatchNote;
};

interface PatchNotesModalProps {
  isAdmin: boolean;
  onClose: () => void;
}

interface PatchNotesModalContentProps {
  editNoteId: string | null;
  error: string | null;
  form: PatchNoteFormState;
  isAdmin: boolean;
  loading: boolean;
  notes: PatchNote[];
  pending: boolean;
  onClose: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onDelete: (id: string) => void;
  onEditCancel: () => void;
  onEditStart: (note: PatchNote) => void;
  onFieldChange: (field: keyof PatchNoteFormState, value: string) => void;
  onSaveEdit: (event: FormEvent<HTMLFormElement>) => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return "패치노트를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.";
}

export function formatPatchNoteDate(value: string): string {
  const compact = value.replace("T", " ").replace("Z", "").slice(0, 16);
  const match = compact.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return value;
  return `${match[1]}.${match[2]}.${match[3]} ${match[4]}:${match[5]}`;
}

export function PatchNotesModalContent({
  editNoteId,
  error,
  form,
  isAdmin,
  loading,
  notes,
  pending,
  onClose,
  onCreate,
  onDelete,
  onEditCancel,
  onEditStart,
  onFieldChange,
  onSaveEdit
}: PatchNotesModalContentProps) {
  const isEditing = editNoteId !== null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="tool-modal edit-modal patch-notes-modal" aria-modal="true" role="dialog" aria-label="패치노트">
        <header className="tool-modal-header">
          <h2>
            <FileText aria-hidden="true" size={18} />
            패치노트
          </h2>
          <button className="modal-close-button" type="button" aria-label="닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="tool-modal-body patch-notes-body">
          {error ? <p className="error-text">{error}</p> : null}
          {isAdmin ? (
            <form className="patch-note-editor" onSubmit={isEditing ? onSaveEdit : onCreate}>
              <h3>{isEditing ? "패치노트 수정" : "패치노트 작성"}</h3>
              <div className="patch-note-editor-grid">
                <label>
                  제목
                  <input
                    maxLength={80}
                    placeholder="예: 공유 쌀통 UI 개선"
                    type="text"
                    value={form.title}
                    onChange={(event) => onFieldChange("title", event.currentTarget.value)}
                  />
                </label>
                <label>
                  내용
                  <textarea
                    maxLength={5000}
                    placeholder="변경된 내용을 적어주세요."
                    rows={5}
                    value={form.body}
                    onChange={(event) => onFieldChange("body", event.currentTarget.value)}
                  />
                </label>
              </div>
              <div className="patch-note-editor-actions">
                {isEditing ? (
                  <button type="button" onClick={onEditCancel}>
                    취소
                  </button>
                ) : null}
                <button className="primary-button" disabled={pending || !form.title.trim() || !form.body.trim()} type="submit">
                  {isEditing ? "저장" : "게시"}
                </button>
              </div>
            </form>
          ) : null}

          <div className="patch-note-list" aria-live="polite">
            {loading ? <p className="muted-text">패치노트를 불러오는 중입니다.</p> : null}
            {!loading && notes.length === 0 ? <p className="muted-text">아직 등록된 패치노트가 없습니다.</p> : null}
            {notes.map((note) => (
              <article className="patch-note-card" key={note.id}>
                <div className="patch-note-card-header">
                  <div>
                    <h3>{note.title}</h3>
                    <time dateTime={note.publishedAt}>{formatPatchNoteDate(note.publishedAt)}</time>
                  </div>
                  {isAdmin ? (
                    <div className="patch-note-card-actions">
                      <button type="button" onClick={() => onEditStart(note)}>
                        <Pencil aria-hidden="true" size={14} />
                        수정
                      </button>
                      <button className="danger-button" type="button" onClick={() => onDelete(note.id)}>
                        <Trash2 aria-hidden="true" size={14} />
                        삭제
                      </button>
                    </div>
                  ) : null}
                </div>
                <p className="patch-note-body-text">{note.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export function PatchNotesModal({ isAdmin, onClose }: PatchNotesModalProps) {
  const [notes, setNotes] = useState<PatchNote[]>([]);
  const [form, setForm] = useState<PatchNoteFormState>({ title: "", body: "" });
  const [editNoteId, setEditNoteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await apiGet<PatchNotesPayload>("/api/patch-notes");
      setNotes(payload.notes);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleFieldChange = (field: keyof PatchNoteFormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const resetEditor = () => {
    setForm({ title: "", body: "" });
    setEditNoteId(null);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const payload = await apiPost<PatchNotePayload>("/api/patch-notes", form);
      setNotes((current) => [payload.note, ...current]);
      resetEditor();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const handleEditStart = (note: PatchNote) => {
    setEditNoteId(note.id);
    setForm({ title: note.title, body: note.body });
  };

  const handleSaveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editNoteId) return;
    setPending(true);
    setError(null);
    try {
      const payload = await apiPatch<PatchNotePayload>(`/api/patch-notes/${editNoteId}`, form);
      setNotes((current) => current.map((note) => (note.id === payload.note.id ? payload.note : note)));
      resetEditor();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("이 패치노트를 삭제할까요?")) return;
    setPending(true);
    setError(null);
    try {
      await apiDelete(`/api/patch-notes/${id}`);
      setNotes((current) => current.filter((note) => note.id !== id));
      if (editNoteId === id) resetEditor();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <PatchNotesModalContent
      editNoteId={editNoteId}
      error={error}
      form={form}
      isAdmin={isAdmin}
      loading={loading}
      notes={notes}
      pending={pending}
      onClose={onClose}
      onCreate={handleCreate}
      onDelete={handleDelete}
      onEditCancel={resetEditor}
      onEditStart={handleEditStart}
      onFieldChange={handleFieldChange}
      onSaveEdit={handleSaveEdit}
    />
  );
}
