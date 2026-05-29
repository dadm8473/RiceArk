import { useState } from "react";
import { apiPostNoContent } from "./api/client";
import { AuthMenu } from "./features/auth/AuthMenu";
import { useSession } from "./features/auth/useSession";
import { CharacterImport } from "./features/characters/CharacterImport";
import { ChecklistMatrix } from "./features/dashboard/ChecklistMatrix";
import { useDashboard } from "./features/dashboard/useDashboard";
import { DensityControls } from "./features/settings/DensityControls";
import { TaskForm } from "./features/tasks/TaskForm";

export function App() {
  const { data, error } = useDashboard();
  const session = useSession();
  const [authMenuOpen, setAuthMenuOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);

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
        {!data && !error ? <p>로스트아크 숙제 체크리스트를 불러오는 중입니다.</p> : null}
        {data ? (
          <>
            <div className="tool-grid">
              <CharacterImport />
              <TaskForm />
              <DensityControls
                density={data.settings.density}
                rowHeight={data.settings.row_height}
                columnWidth={data.settings.column_width}
              />
            </div>
            <ChecklistMatrix dashboard={data} />
          </>
        ) : null}
      </section>
    </main>
  );
}
