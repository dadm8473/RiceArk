import { CharacterImport } from "./features/characters/CharacterImport";
import { ChecklistMatrix } from "./features/dashboard/ChecklistMatrix";
import { useDashboard } from "./features/dashboard/useDashboard";
import { DensityControls } from "./features/settings/DensityControls";
import { TaskForm } from "./features/tasks/TaskForm";

export function App() {
  const { data, error } = useDashboard();

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>RiceArk</h1>
        <div className="login-actions">
          <a className="button" href="/api/auth/discord/start">
            Discord
          </a>
          <a className="button" href="/api/auth/google/start">
            Google
          </a>
        </div>
      </header>
      <section className="workspace">
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
