import { useState } from "react";
import { apiPatch, apiPostNoContent } from "./api/client";
import { AuthMenu } from "./features/auth/AuthMenu";
import { useSession } from "./features/auth/useSession";
import { BoardOverview } from "./features/board/BoardOverview";
import { useBoard } from "./features/board/useBoard";
import { ChecklistMatrix } from "./features/dashboard/ChecklistMatrix";
import { useDashboard } from "./features/dashboard/useDashboard";
import { WorkspaceActions, type WorkspaceTool } from "./features/tools/WorkspaceActions";

export function App() {
  const { data, error } = useDashboard();
  const board = useBoard();
  const session = useSession();
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [activeTool, setActiveTool] = useState<WorkspaceTool | null>(null);

  const handleLogout = async () => {
    setLogoutPending(true);
    setAuthMenuOpen(false);
    try {
      await apiPostNoContent("/api/auth/logout");
      window.location.assign("/");
    } catch (err) {
      setLogoutPending(false);
      console.error(err);
    }
  };

  const handleChecklistOrientationChange = async (checklistOrientation: "tasks_rows" | "tasks_columns") => {
    if (data?.settings.checklist_orientation === checklistOrientation) return;
    await apiPatch("/api/settings", { checklistOrientation });
    window.location.reload();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>RiceArk</h1>
        <AuthMenu
          logoutPending={logoutPending}
          menuOpen={authMenuOpen}
          status={session.status}
          user={session.user}
          onLogout={handleLogout}
          onToggleMenu={() => setAuthMenuOpen((open) => !open)}
        />
      </header>
      <section className="workspace">
        {session.status === "error" ? <p className="error-text">{session.error}</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
        {board.error && !error ? <p className="error-text">{board.error}</p> : null}
        {!data && !error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
        {data ? (
          <>
            <WorkspaceActions
              activeTool={activeTool}
              checklistOrientation={data.settings.checklist_orientation}
              onChecklistOrientationChange={(orientation) => void handleChecklistOrientationChange(orientation)}
              onClose={() => setActiveTool(null)}
              onOpen={setActiveTool}
            />
            {board.data ? <BoardOverview board={board.data} onBoardChanged={board.reload} /> : null}
            <ChecklistMatrix dashboard={data} />
          </>
        ) : null}
      </section>
    </main>
  );
}
