import { Columns3, Plus, Rows3, UserPlus, X } from "lucide-react";
import { CharacterImport } from "../characters/CharacterImport";
import { TaskForm } from "../tasks/TaskForm";

export type WorkspaceTool = "characters" | "tasks";

interface WorkspaceActionsProps {
  activeTool: WorkspaceTool | null;
  checklistOrientation: "tasks_rows" | "tasks_columns";
  onChecklistOrientationChange: (orientation: "tasks_rows" | "tasks_columns") => void;
  onOpen: (tool: WorkspaceTool) => void;
  onClose: () => void;
}

function getToolTitle(tool: WorkspaceTool): string {
  return tool === "characters" ? "캐릭터 가져오기" : "숙제 추가";
}

export function WorkspaceActions({
  activeTool,
  checklistOrientation,
  onChecklistOrientationChange,
  onOpen,
  onClose
}: WorkspaceActionsProps) {
  return (
    <>
      <div className="workspace-actions">
        <button type="button" onClick={() => onOpen("characters")} title="캐릭터 가져오기">
          <UserPlus size={16} />
          캐릭터 가져오기
        </button>
        <button type="button" onClick={() => onOpen("tasks")} title="숙제 추가">
          <Plus size={16} />
          숙제 추가
        </button>
        <div className="orientation-control" aria-label="표 방향">
          <span>표 방향</span>
          <div className="segmented">
            <button
              className={checklistOrientation === "tasks_rows" ? "active" : ""}
              type="button"
              aria-pressed={checklistOrientation === "tasks_rows"}
              onClick={() => onChecklistOrientationChange("tasks_rows")}
              title="캐릭터를 열로"
            >
              <Columns3 size={16} />
              캐릭터를 열로
            </button>
            <button
              className={checklistOrientation === "tasks_columns" ? "active" : ""}
              type="button"
              aria-pressed={checklistOrientation === "tasks_columns"}
              onClick={() => onChecklistOrientationChange("tasks_columns")}
              title="숙제를 열로"
            >
              <Rows3 size={16} />
              숙제를 열로
            </button>
          </div>
        </div>
      </div>
      {activeTool ? (
        <div className="modal-backdrop">
          <section aria-modal="true" className="tool-modal" role="dialog">
            <header className="tool-modal-header">
              <h2>{getToolTitle(activeTool)}</h2>
              <button type="button" onClick={onClose} title="닫기">
                <X size={16} />
              </button>
            </header>
            <div className="tool-modal-body">
              {activeTool === "characters" ? <CharacterImport /> : <TaskForm />}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
