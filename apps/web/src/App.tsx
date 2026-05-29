import { ChecklistMatrix } from "./features/dashboard/ChecklistMatrix";
import { useDashboard } from "./features/dashboard/useDashboard";

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
        {data ? <ChecklistMatrix dashboard={data} /> : null}
      </section>
    </main>
  );
}
