import { Plus, UserPlus, X } from "lucide-react";
import { CharacterImport } from "../characters/CharacterImport";
import { TaskForm } from "../tasks/TaskForm";

export type WorkspaceTool = "characters" | "tasks";

interface WorkspaceActionsProps {
  activeTool: WorkspaceTool | null;
  onOpen: (tool: WorkspaceTool) => void;
  onClose: () => void;
}

function getToolTitle(tool: WorkspaceTool): string {
  return tool === "characters" ? "캐릭터 가져오기" : "숙제 추가";
}

export function WorkspaceActions({ activeTool, onOpen, onClose }: WorkspaceActionsProps) {
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
            <div className="tool-modal-body">{activeTool === "characters" ? <CharacterImport /> : <TaskForm />}</div>
          </section>
        </div>
      ) : null}
    </>
  );
}
