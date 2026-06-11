import { Check, ChevronDown, LogOut, Moon, Pencil, Sun, UserCircle, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { AuthUser } from "./useSession";

export type AuthMenuStatus = "checking" | "anonymous" | "authenticated" | "error";
export type AppTheme = "light" | "dark";

export const DISPLAY_NAME_MAX_CHARS = 12;

interface AuthMenuProps {
  status: AuthMenuStatus;
  user?: AuthUser | null;
  menuOpen: boolean;
  logoutPending?: boolean;
  theme?: AppTheme;
  onToggleMenu?: () => void;
  onThemeToggle?: () => void;
  onDisplayNameSave?: ((displayName: string) => Promise<void>) | undefined;
  onLogout: () => void;
}

function getAvatarInitial(user: AuthUser): string {
  return user.displayName.trim().charAt(0) || "U";
}

export function AuthMenu({
  status,
  user,
  menuOpen,
  logoutPending = false,
  theme = "light",
  onToggleMenu,
  onThemeToggle,
  onDisplayNameSave,
  onLogout
}: AuthMenuProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [namePending, setNamePending] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  if (status === "checking") {
    return <div className="auth-status auth-status-muted">로그인 확인 중...</div>;
  }

  if (status !== "authenticated" || !user) {
    return (
      <div className="login-actions">
        <a className="button" href="/api/auth/discord/start">
          Discord로 로그인
        </a>
        <a className="button" href="/api/auth/google/start">
          Google로 로그인
        </a>
      </div>
    );
  }

  function startNameEdit() {
    if (!user) return;
    setNameDraft(user.displayName);
    setNameError(null);
    setEditingName(true);
  }

  function cancelNameEdit() {
    setEditingName(false);
    setNameError(null);
  }

  async function submitNameEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onDisplayNameSave) return;
    const nextName = nameDraft.trim();
    if (!nextName || nextName === user?.displayName) {
      cancelNameEdit();
      return;
    }

    setNamePending(true);
    setNameError(null);
    try {
      await onDisplayNameSave(nextName);
      setEditingName(false);
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "닉네임을 저장하지 못했습니다.");
    } finally {
      setNamePending(false);
    }
  }

  return (
    <div className="auth-menu">
      <button
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        className="profile-button"
        type="button"
        onClick={onToggleMenu}
      >
        {user.avatarUrl ? (
          <img alt="" className="profile-avatar" src={user.avatarUrl} />
        ) : (
          <span className="profile-avatar profile-avatar-fallback">{getAvatarInitial(user)}</span>
        )}
        <span className="profile-name">{user.displayName}</span>
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      {menuOpen ? (
        <div className="profile-menu" role="menu">
          {editingName ? (
            <form className="profile-name-edit" onSubmit={submitNameEdit}>
              <input
                aria-label="닉네임"
                autoFocus
                maxLength={DISPLAY_NAME_MAX_CHARS}
                value={nameDraft}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
              />
              <button aria-label="닉네임 저장" className="profile-name-edit-save" disabled={namePending} type="submit">
                <Check aria-hidden="true" size={14} />
              </button>
              <button aria-label="닉네임 편집 취소" disabled={namePending} type="button" onClick={cancelNameEdit}>
                <X aria-hidden="true" size={14} />
              </button>
            </form>
          ) : (
            <div className="profile-menu-heading">
              <UserCircle aria-hidden="true" size={16} />
              <span>{user.displayName}</span>
              {onDisplayNameSave ? (
                <button
                  aria-label="닉네임 수정"
                  className="profile-name-edit-button"
                  title="닉네임 수정 (공유 쌀통에 표시되는 이름)"
                  type="button"
                  onClick={startNameEdit}
                >
                  <Pencil aria-hidden="true" size={13} />
                </button>
              ) : null}
            </div>
          )}
          {nameError ? <p className="profile-name-edit-error">{nameError}</p> : null}
          <button role="menuitem" type="button" onClick={onThemeToggle}>
            {theme === "dark" ? <Sun aria-hidden="true" size={16} /> : <Moon aria-hidden="true" size={16} />}
            {theme === "dark" ? "라이트모드" : "다크모드(Beta)"}
          </button>
          <button disabled={logoutPending} role="menuitem" type="button" onClick={onLogout}>
            <LogOut aria-hidden="true" size={16} />
            {logoutPending ? "로그아웃 중..." : "로그아웃"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
