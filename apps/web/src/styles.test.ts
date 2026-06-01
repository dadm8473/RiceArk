import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("apps/web/src/styles.css", "utf8");

describe("matrix styles", () => {
  it("keeps disabled checklist cells visually neutral", () => {
    expect(styles).toContain(".matrix-check:disabled");
    expect(styles).toContain(".matrix-check:disabled {\n  cursor: default;\n  background: #ffffff;");
  });

  it("lets matrix rows cover the full scrollable grid width", () => {
    const rowBlock = styles.match(/\.matrix-row\s*{[^}]+}/)?.[0] ?? "";

    expect(rowBlock).toContain("width: max-content;");
    expect(rowBlock).toContain("min-width: 100%;");
  });

  it("keeps compact edit inputs inside their grid columns", () => {
    const compactGridBlock = styles.match(/\.compact-edit-grid\s*{[^}]+}/)?.[0] ?? "";
    const compactLabelBlock = styles.match(/\.compact-edit-grid label\s*{[^}]+}/)?.[0] ?? "";
    const inputBlock = styles.match(/\.edit-form input,\n\.edit-form select,\n\.edit-form textarea\s*{[^}]+}/)?.[0] ?? "";

    expect(compactGridBlock).toContain("minmax(0, 1fr)");
    expect(compactLabelBlock).toContain("min-width: 0;");
    expect(inputBlock).toContain("min-width: 0;");
    expect(inputBlock).toContain("width: 100%;");
  });

  it("separates destructive edit actions from save actions", () => {
    const editActionsBlock = styles.match(/\.edit-actions\s*{[^}]+}/)?.[0] ?? "";
    const editPrimaryBlock = styles.match(/\.edit-actions \.primary-button\s*{[^}]+}/)?.[0] ?? "";

    expect(editActionsBlock).not.toContain("justify-content: flex-end;");
    expect(editPrimaryBlock).toContain("margin-left: auto;");
  });

  it("keeps the task creation modal and form compact", () => {
    const modalBlock = styles.match(/\.task-tool-modal\s*{[^}]+}/)?.[0] ?? "";
    const formBlock = styles.match(/\.compact-task-form\s*{[^}]+}/)?.[0] ?? "";
    const inputBlock = styles.match(/\.compact-task-form input\s*{[^}]+}/)?.[0] ?? "";
    const selectBlock = styles.match(/\.compact-task-form select\s*{[^}]+}/)?.[0] ?? "";

    expect(modalBlock).toContain("width: min(520px, 100%);");
    expect(formBlock).toContain("align-items: center;");
    expect(inputBlock).toContain("flex: 1 1 220px;");
    expect(selectBlock).toContain("flex: 0 0 112px;");
  });

  it("animates compact loading indicators", () => {
    const spinBlock = styles.match(/\.spin-icon\s*{[^}]+}/)?.[0] ?? "";

    expect(styles).toContain("@keyframes spin");
    expect(spinBlock).toContain("animation: spin 1s linear infinite;");
  });
});
