import { ChevronDown, LogOut, UserCircle } from "lucide-react";
import type { AuthUser } from "./useSession";

export type AuthMenuStatus = "checking" | "anonymous" | "authenticated" | "error";

interface AuthMenuProps {
  status: AuthMenuStatus;
  user?: AuthUser | null;
  menuOpen: boolean;
  logoutPending?: boolean;
  onToggleMenu?: () => void;
  onLogout: () => void;
}

function getAvatarInitial(user: AuthUser): string {
  return user.displayName.trim().charAt(0) || "U";
}

export function AuthMenu({ status, user, menuOpen, logoutPending = false, onToggleMenu, onLogout }: AuthMenuProps) {
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
          <div className="profile-menu-heading">
            <UserCircle aria-hidden="true" size={16} />
            <span>{user.displayName}</span>
          </div>
          <button disabled={logoutPending} role="menuitem" type="button" onClick={onLogout}>
            <LogOut aria-hidden="true" size={16} />
            {logoutPending ? "로그아웃 중..." : "로그아웃"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
