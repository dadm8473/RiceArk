import type { CSSProperties } from "react";
import type { DashboardPayload } from "./types";

interface Props {
  dashboard: DashboardPayload;
}

export function ChecklistMatrix({ dashboard }: Props) {
  const columns = [
    { id: "roster", name: "원정대" },
    ...dashboard.characters.map((character) => ({
      id: character.id,
      name: character.name
    }))
  ];
  const rowStyle = {
    "--column-count": columns.length,
    "--row-height": `${dashboard.settings.row_height}px`,
    "--column-width": `${dashboard.settings.column_width}px`
  } as CSSProperties;

  return (
    <div className={`matrix density-${dashboard.settings.density}`}>
      <div className="matrix-row matrix-header" style={rowStyle}>
        <div className="matrix-task-cell">숙제</div>
        {columns.map((column) => (
          <div className="matrix-cell" key={column.id}>
            {column.name}
          </div>
        ))}
      </div>
      {dashboard.tasks.map((task) => (
        <div className="matrix-row" key={task.id} style={rowStyle}>
          <div className="matrix-task-cell">
            <span>{task.name}</span>
            <small>{task.reset_type}</small>
          </div>
          {columns.map((column) => {
            const disabled = task.scope === "character" && column.id === "roster";
            const rosterOnly = task.scope === "roster" && column.id !== "roster";
            return (
              <button
                className="matrix-cell matrix-check"
                disabled={disabled || rosterOnly}
                key={`${task.id}:${column.id}`}
                type="button"
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
