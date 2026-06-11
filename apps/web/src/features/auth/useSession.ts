import { useEffect, useState } from "react";
import { ApiClientError, apiGet } from "../../api/client";

export interface AuthUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin?: boolean;
}

type SessionPayload = {
  user: AuthUser;
};

export type SessionState =
  | { status: "checking"; user: null; error: null }
  | { status: "anonymous"; user: null; error: null }
  | { status: "authenticated"; user: AuthUser; error: null }
  | { status: "error"; user: null; error: string };

export function formatSessionError(err: unknown): string | null {
  if (err instanceof ApiClientError && err.code === "unauthorized") {
    return null;
  }
  return err instanceof Error ? err.message : "로그인 상태를 확인하지 못했습니다.";
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: "checking", user: null, error: null });

  useEffect(() => {
    let active = true;
    apiGet<SessionPayload>("/api/session")
      .then((payload) => {
        if (active) setState({ status: "authenticated", user: payload.user, error: null });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message = formatSessionError(err);
        setState(message ? { status: "error", user: null, error: message } : { status: "anonymous", user: null, error: null });
      });

    return () => {
      active = false;
    };
  }, []);

  return state;
}
