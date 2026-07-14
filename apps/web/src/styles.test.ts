import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("apps/web/src/styles.css", "utf8");

describe("matrix styles", () => {
  it("shows the app icon as a compact circular brand mark", () => {
    const brandBlock = styles.match(/\.brand-mark\s*{[^}]+}/)?.[0] ?? "";
    const brandIconBlock = styles.match(/\.brand-icon\s*{[^}]+}/)?.[0] ?? "";

    expect(brandBlock).toContain("display: inline-flex;");
    expect(brandBlock).toContain("align-items: center;");
    expect(brandIconBlock).toContain("width: 34px;");
    expect(brandIconBlock).toContain("height: 34px;");
    expect(brandIconBlock).toContain("border-radius: 999px;");
    expect(brandIconBlock).toContain("object-fit: cover;");
    expect(brandIconBlock).toContain("background: #000000;");
  });

  it("keeps the support link visually quieter than primary action buttons", () => {
    const supportLinkBlock = styles.match(/\.support-link\s*{[^}]+}/)?.[0] ?? "";

    expect(supportLinkBlock).toContain("min-height: 32px;");
    expect(supportLinkBlock).toContain("padding: 0 9px;");
    expect(supportLinkBlock).toContain("font-size: 13px;");
  });

  it("keeps disabled checklist cells visually neutral", () => {
    expect(styles).toContain(".matrix-check:disabled");
    expect(styles).toContain(".matrix-check:disabled {\n  cursor: default;\n  background: #ffffff;");
  });

  it("keeps read-only board checkboxes colorful while preventing interaction", () => {
    const checkBlock = styles.match(/\.board-check\s*{[^}]+}/)?.[0] ?? "";
    const checkedBlock = styles.match(/\.board-check:checked\s*{[^}]+}/)?.[0] ?? "";
    const checkmarkBlock = styles.match(/\.board-check:checked::before\s*{[^}]+}/)?.[0] ?? "";
    const disabledBlock = styles.match(/\.board-check:disabled\s*{[^}]+}/)?.[0] ?? "";
    const disabledCheckedBlock = styles.match(/\.board-check:disabled:checked\s*{[^}]+}/)?.[0] ?? "";
    const darkCheckedBlock = styles.match(/\.app-shell\[data-theme="dark"\] \.board-check:checked\s*{[^}]+}/)?.[0] ?? "";

    expect(checkBlock).toContain("appearance: none;");
    expect(checkedBlock).toContain("background: var(--task-color, #2563eb);");
    expect(checkmarkBlock).toContain("border-right: 2px solid #ffffff;");
    expect(disabledBlock).toContain("opacity: 1;");
    expect(disabledBlock).toContain("cursor: default;");
    expect(disabledCheckedBlock).toContain("background: var(--task-color, #2563eb);");
    expect(darkCheckedBlock).toContain("background: var(--task-color, #2563eb);");
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

  it("keeps task edit fields grouped into compact rows", () => {
    const taskBasicBlock = styles.match(/\.task-edit-basic-grid\s*{[^}]+}/)?.[0] ?? "";
    const taskAxisStyleBlock = styles.match(/\.task-axis-style-grid\s*{[^}]+}/)?.[0] ?? "";

    expect(taskBasicBlock).toContain("display: grid;");
    expect(taskBasicBlock).toContain("grid-template-columns: minmax(0, 1fr) 144px;");
    expect(taskAxisStyleBlock).toContain("grid-template-columns: 90px 90px minmax(116px, 1fr);");
  });

  it("presents imported character identity and layout controls as polished compact rows", () => {
    const modalBlock = styles.match(/\.character-axis-edit-modal\s*{[^}]+}/)?.[0] ?? "";
    const summaryBlock = styles.match(/\.character-summary-card\s*{[^}]+}/)?.[0] ?? "";
    const titleBlock = styles.match(/\.character-summary-title\s*{[^}]+}/)?.[0] ?? "";
    const chipBlock = styles.match(/\.character-summary-chip\s*{[^}]+}/)?.[0] ?? "";
    const layoutBlock = styles.match(/\.character-axis-layout-grid\s*{[^}]+}/)?.[0] ?? "";
    const displayOptionsBaseBlock = styles.match(/\.board-display-options\s*{[^}]+}/)?.[0] ?? "";
    const displayOptionsLabelBlock = styles.match(/\n\.board-display-options label\s*{[^}]+}/)?.[0] ?? "";
    const displayOptionsBlock = styles.match(/\.character-axis-layout-grid \.board-display-options\s*{[^}]+}/)?.[0] ?? "";

    expect(modalBlock).toContain("width: min(680px, 100%);");
    expect(summaryBlock).toContain("display: grid;");
    expect(summaryBlock).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
    expect(titleBlock).toContain("text-overflow: ellipsis;");
    expect(chipBlock).toContain("border: 1px solid #c7d2e1;");
    expect(layoutBlock).toContain("grid-template-columns: 90px 90px minmax(260px, 1fr);");
    expect(displayOptionsBaseBlock).toContain("gap: 10px;");
    expect(displayOptionsBaseBlock).toContain("padding: 8px 10px;");
    expect(displayOptionsLabelBlock).toContain("gap: 6px;");
    expect(displayOptionsBlock).toContain("min-width: 320px;");
  });

  it("separates destructive edit actions from save actions", () => {
    const editActionsBlock = styles.match(/\.edit-actions\s*{[^}]+}/)?.[0] ?? "";
    const editPrimaryBlock = styles.match(/\.edit-actions \.primary-button\s*{[^}]+}/)?.[0] ?? "";

    expect(editActionsBlock).not.toContain("justify-content: flex-end;");
    expect(editPrimaryBlock).toContain("margin-left: auto;");
  });

  it("keeps the task creation modal and form compact", () => {
    const modalBlock = styles.match(/\.task-tool-modal\s*{[^}]+}/)?.[0] ?? "";
    const presetGridBlock = styles.match(/\.task-preset-grid\s*{[^}]+}/)?.[0] ?? "";
    const presetCardBlock = styles.match(/\.task-preset-card\s*{[^}]+}/)?.[0] ?? "";
    const presetButtonCardBlock = styles.match(/button\.task-preset-card\s*{[^}]+}/)?.[0] ?? "";
    const presetCardTitleBlock = styles.match(/\.task-preset-card strong\s*{[^}]+}/)?.[0] ?? "";
    const presetCardDescriptionBlock = styles.match(/\.task-preset-card span\s*{[^}]+}/)?.[0] ?? "";
    const formBlock = styles.match(/\.compact-task-form\s*{[^}]+}/)?.[0] ?? "";
    const inputBlock = styles.match(/\.compact-task-form input\s*{[^}]+}/)?.[0] ?? "";
    const selectBlock = styles.match(/\.compact-task-form select\s*{[^}]+}/)?.[0] ?? "";
    const buttonBlock = styles.match(/\.compact-task-form button\s*{[^}]+}/)?.[0] ?? "";

    expect(modalBlock).toContain("width: min(520px, 100%);");
    expect(presetGridBlock).toContain("grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));");
    expect(presetGridBlock).toContain("gap: 6px;");
    expect(presetCardBlock).toContain("border-radius: 0;");
    expect(presetCardBlock).toContain("text-align: left;");
    expect(presetButtonCardBlock).toContain("display: grid;");
    expect(presetButtonCardBlock).toContain("justify-content: stretch;");
    expect(presetButtonCardBlock).toContain("grid-template-rows: auto 1fr auto;");
    expect(presetCardTitleBlock).toContain("font-size: 14px;");
    expect(presetCardDescriptionBlock).toContain("white-space: normal;");
    expect(presetCardDescriptionBlock).not.toContain("text-overflow: ellipsis;");
    expect(formBlock).toContain("align-items: center;");
    expect(inputBlock).toContain("flex: 1 1 220px;");
    expect(selectBlock).toContain("flex: 0 0 112px;");
    expect(buttonBlock).toContain("margin-left: auto;");
  });

  it("animates compact loading indicators", () => {
    const spinBlock = styles.match(/\.spin-icon\s*{[^}]+}/)?.[0] ?? "";

    expect(styles).toContain("@keyframes spin");
    expect(spinBlock).toContain("animation: spin 1s linear infinite;");
  });

  it("keeps edit modal checkboxes at one compact size", () => {
    const checkboxBlock = styles.match(/\.edit-form input\[type="checkbox"\]\s*{[^}]+}/)?.[0] ?? "";

    expect(checkboxBlock).toContain("width: 16px;");
    expect(checkboxBlock).toContain("height: 16px;");
    expect(checkboxBlock).toContain("min-height: 0;");
  });

  it("centers character names in board axis labels", () => {
    const characterAxisBlock = styles.match(/\.board-character-axis-label\s*{[^}]+}/)?.[0] ?? "";
    const characterLabelBlock = styles.match(/\.board-character-label\s*{[^}]+}/)?.[0] ?? "";

    expect(characterAxisBlock).toContain("align-items: center;");
    expect(characterAxisBlock).toContain("text-align: center;");
    expect(characterLabelBlock).toContain("text-overflow: ellipsis;");
  });

  it("wraps character metadata instead of hiding enabled display fields", () => {
    const characterMetaBlock = styles.match(/\.board-character-meta\s*{[^}]+}/)?.[0] ?? "";

    expect(characterMetaBlock).toContain("white-space: normal;");
    expect(characterMetaBlock).toContain("overflow-wrap: anywhere;");
    expect(characterMetaBlock).not.toContain("text-overflow: ellipsis;");
  });

  it("renders character identity and progress metadata on separate lines", () => {
    const characterMetaLineBlock = styles.match(/\.board-character-meta span\s*{[^}]+}/)?.[0] ?? "";

    expect(characterMetaLineBlock).toContain("display: block;");
  });

  it("does not clip task color swatches with generic row span overflow", () => {
    const swatchBlock = styles.match(/\.board-task-color-swatch\s*{[^}]+}/)?.[0] ?? "";

    expect(styles).not.toContain(".board-column-label span,\n.board-row-label span");
    expect(swatchBlock).toContain("overflow: visible;");
  });

  it("clips board axis label overflow when row label width or column header height is tiny", () => {
    const axisLabelBlock = styles.match(/\.board-axis-label\s*{[^}]+}/)?.[0] ?? "";

    expect(axisLabelBlock).toContain("overflow: hidden;");
  });

  it("keeps board axis label fonts consistent between editable and locked states", () => {
    const axisLabelBlock = styles.match(/\.board-axis-label\s*{[^}]+}/)?.[0] ?? "";
    const axisEditButtonBlock = styles.match(/\.board-axis-edit-button\s*{[^}]+}/)?.[0] ?? "";

    expect(axisLabelBlock).toContain("font: inherit;");
    expect(axisEditButtonBlock).toContain("font: inherit;");
  });

  it("keeps editable axis label borders consistent with locked axis labels", () => {
    const editableRowBlock = styles.match(/\.board-row-label\.board-axis-edit-button\s*{[^}]+}/)?.[0] ?? "";
    const editableColumnBlock = styles.match(/\.board-column-label\.board-axis-edit-button\s*{[^}]+}/)?.[0] ?? "";

    expect(editableRowBlock).toContain("border-right: 1px solid #d2d9e4;");
    expect(editableRowBlock).toContain("border-bottom: 1px solid #d2d9e4;");
    expect(editableColumnBlock).toContain("border-bottom: 1px solid #c6cfdd;");
  });

  it("draws cell mark icons inside checkboxes and a content-sized hover tooltip", () => {
    const iconWrapBlock = styles.match(/\.board-check-wrap\s*{[^}]+}/)?.[0] ?? "";
    const iconOverlayBlock = styles.match(/\.board-check-icon-overlay\s*{[^}]+}/)?.[0] ?? "";
    const checkedIconBlock = styles.match(/\.board-check-wrap\.checked \.board-check-icon-overlay\s*{[^}]+}/)?.[0] ?? "";
    const iconOnlyButtonBlock = styles.match(/\.board-cell-mark-option\.icon-only\s*{[^}]+}/)?.[0] ?? "";
    const tooltipBlock = styles.match(/\.board-cell-mark-tooltip\s*{[^}]+}/)?.[0] ?? "";
    const markEditHoverBlock =
      styles.match(/\.board-table-summary\.mark-edit-mode \.board-check-cell:hover\s*{[^}]+}/)?.[0] ?? "";

    expect(iconWrapBlock).toContain("position: relative;");
    expect(iconOverlayBlock).toContain("position: absolute;");
    expect(iconOverlayBlock).toContain("pointer-events: none;");
    expect(checkedIconBlock).toContain("color: #ffffff;");
    expect(iconOnlyButtonBlock).toContain("width: 32px;");
    expect(iconOnlyButtonBlock).toContain("padding: 0;");
    expect(tooltipBlock).toContain("position: fixed;");
    expect(tooltipBlock).toContain("width: max-content;");
    expect(tooltipBlock).toContain("transform: translateX(-50%);");
    expect(markEditHoverBlock).toContain("outline: 2px dashed #2563eb;");
    expect(styles).not.toContain(".board-check-mark.fixed");
    expect(styles).not.toContain(".board-check-memo-dot");
    expect(styles).toContain('.app-shell[data-theme="dark"] .board-check-icon-overlay');
    expect(styles).toContain('.app-shell[data-theme="dark"] .board-cell-mark-tooltip');
    expect(styles).toContain('.app-shell[data-theme="dark"] .board-cell-mark-option.active');
  });

  it("highlights draggable axis headers and dims check cells in reorder mode", () => {
    const sortableHighlightBlock =
      styles.match(/\.board-table-summary\.reorder-mode \.board-sortable-axis-label\s*{[^}]+}/)?.[0] ?? "";
    const dimmedCellBlock = styles.match(/\.board-table-summary\.reorder-mode \.board-check-cell\s*{[^}]+}/)?.[0] ?? "";
    const darkSortableHighlightBlock =
      styles.match(
        /\.app-shell\[data-theme="dark"\] \.board-table-summary\.reorder-mode \.board-sortable-axis-label\s*{[^}]+}/
      )?.[0] ?? "";

    expect(sortableHighlightBlock).toContain("outline: 2px dashed #2563eb;");
    expect(sortableHighlightBlock).toContain("background: #eff6ff;");
    expect(dimmedCellBlock).toContain("opacity: 0.35;");
    expect(darkSortableHighlightBlock).toContain("outline-color: #60a5fa;");
  });

  it("keeps the board workspace open and moves table creation to a floating action", () => {
    const canvasBlock = styles.match(/\.board-canvas\s*{[^}]+}/)?.[0] ?? "";
    const floatingActionsBlock = styles.match(/\.floating-board-actions\s*{[^}]+}/)?.[0] ?? "";
    const floatingButtonBlock = styles.match(/\.floating-table-add-button\s*{[^}]+}/)?.[0] ?? "";
    const sheetBarBlock = styles.match(/\.sheet-tab-bar\s*{[^}]+}/)?.[0] ?? "";
    const sheetTabListBlock = styles.match(/\.sheet-tab-list\s*{[^}]+}/)?.[0] ?? "";
    const sheetSettingsButtonBlock = styles.match(/\.sheet-settings-button\s*{[^}]+}/)?.[0] ?? "";
    const zoomControlsBlock = styles.match(/\.board-zoom-controls\s*{[^}]+}/)?.[0] ?? "";
    const zoomButtonBlock = styles.match(/\.board-zoom-controls button\s*{[^}]+}/)?.[0] ?? "";
    const zoomValueBlock = styles.match(/\.board-zoom-value\s*{[^}]+}/)?.[0] ?? "";
    const canvasSpaceBlock = styles.match(/\.board-canvas-space\s*{[^}]+}/)?.[0] ?? "";
    const canvasContentBlock = styles.match(/\.board-canvas-content\s*{[^}]+}/)?.[0] ?? "";

    expect(canvasBlock).not.toContain("border:");
    expect(canvasBlock).not.toContain("background: #eef2f7;");
    expect(canvasBlock).toContain("padding: 0 0 40px;");
    expect(canvasSpaceBlock).toContain("width: calc(var(--board-canvas-width) * var(--board-zoom));");
    expect(canvasSpaceBlock).toContain("height: calc(var(--board-canvas-height) * var(--board-zoom));");
    expect(canvasContentBlock).toContain("transform: scale(var(--board-zoom));");
    expect(canvasContentBlock).toContain("transform-origin: top left;");
    expect(floatingActionsBlock).toContain("position: fixed;");
    expect(floatingActionsBlock).toContain("right: 24px;");
    expect(floatingActionsBlock).toContain("bottom: 24px;");
    expect(floatingButtonBlock).toContain("min-height: 42px;");
    expect(sheetBarBlock).toContain("border-bottom: 1px solid #d9e0ea;");
    expect(sheetBarBlock).toContain("padding: 6px 20px;");
    expect(sheetBarBlock).not.toContain("padding: 8px 20px 0;");
    expect(sheetTabListBlock).toContain("flex: 0 1 auto;");
    expect(sheetTabListBlock).not.toContain("flex: 1 1 auto;");
    expect(zoomControlsBlock).toContain("margin-left: auto;");
    expect(zoomControlsBlock).toContain("flex: 0 0 auto;");
    expect(zoomControlsBlock).toContain("align-self: center;");
    expect(zoomControlsBlock).toContain("min-height: 30px;");
    expect(zoomButtonBlock).toContain("width: 28px;");
    expect(zoomButtonBlock).toContain("border: 0;");
    expect(zoomValueBlock).toContain("display: inline-flex;");
    expect(zoomValueBlock).toContain("align-items: center;");
    expect(zoomValueBlock).toContain("justify-content: center;");
    expect(zoomValueBlock).toContain("height: 28px;");
    expect(sheetSettingsButtonBlock).toContain("height: 30px;");
    expect(sheetSettingsButtonBlock).toContain("min-height: 30px;");
    expect(sheetSettingsButtonBlock).toContain("align-self: center;");
    expect(sheetSettingsButtonBlock).toContain("justify-content: center;");
    expect(sheetSettingsButtonBlock).toContain("line-height: 1;");
    expect(sheetSettingsButtonBlock).toContain("border: 0;");
  });

  it("lets shared read-only boards feel like the normal board surface", () => {
    const fullBoardBlock = styles.match(/\.shared-rice-bin-board-full\s*{[^}]+}/)?.[0] ?? "";
    const fullBoardSheetBarBlock = styles.match(/\.shared-rice-bin-board-full \.sheet-tab-bar\s*{[^}]+}/)?.[0] ?? "";

    expect(fullBoardBlock).toContain("border: 0;");
    expect(fullBoardBlock).toContain("gap: 6px;");
    expect(fullBoardBlock).toContain("margin: 0 -20px;");
    expect(fullBoardBlock).toContain("padding: 6px 20px 20px;");
    expect(fullBoardBlock).toContain("width: calc(100% + 40px);");
    expect(fullBoardBlock).toContain("background: #ffffff;");
    expect(fullBoardSheetBarBlock).toContain("margin: 0 -20px 12px;");
    expect(fullBoardSheetBarBlock).toContain("padding: 6px 20px;");
  });

  it("keeps shared rice bin cards and lookup buttons stable on narrow widths", () => {
    const hubBlock = styles.match(/\.shared-rice-bin-hub\s*{[^}]+}/)?.[0] ?? "";
    const singleHubBlock = styles.match(/\.shared-rice-bin-hub\.single\s*{[^}]+}/)?.[0] ?? "";
    const lookupButtonBlock = styles.match(/\.shared-rice-bin-lookup button\s*{[^}]+}/)?.[0] ?? "";

    expect(hubBlock).toContain("grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));");
    expect(hubBlock).toContain("margin-top: 10px;");
    expect(singleHubBlock).toContain("grid-template-columns: minmax(0, 720px);");
    expect(lookupButtonBlock).toContain("flex: 0 0 auto;");
    expect(lookupButtonBlock).toContain("min-width: 88px;");
    expect(lookupButtonBlock).toContain("width: 88px;");
  });

  it("keeps sheet settings selection, editing, and deletion in one natural edit area", () => {
    const editorBlock = styles.match(/\.sheet-settings-editor\s*{[^}]+}/)?.[0] ?? "";
    const selectedBlock = styles.match(/\.sheet-settings-selected-card\s*{[^}]+}/)?.[0] ?? "";
    const editZoneBlock = styles.match(/\.sheet-settings-edit-zone\s*{[^}]+}/)?.[0] ?? "";
    const detailActionsBlock = styles.match(/\.sheet-settings-detail-actions\s*{[^}]+}/)?.[0] ?? "";
    const dangerBlock = styles.match(/\.sheet-settings-danger-zone\s*{[^}]+}/)?.[0] ?? "";

    expect(editorBlock).toContain("grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.3fr);");
    expect(selectedBlock).toContain("border: 1px solid #c7d2e1;");
    expect(selectedBlock).toContain("background: #f8fafc;");
    expect(editZoneBlock).toContain("border: 1px solid #d8dee8;");
    expect(detailActionsBlock).toContain("display: flex;");
    expect(detailActionsBlock).toContain("justify-content: space-between;");
    expect(dangerBlock).toBe("");
  });

  it("keeps the table move target compact even when the title is long", () => {
    const titleBlock = styles.match(/\.board-table-title\s*{[^}]+}/)?.[0] ?? "";
    const staticTitleBlock = styles.match(/\.board-table-static-title\s*{[^}]+}/)?.[0] ?? "";
    const titleTextBlock = styles.match(/\.board-table-title strong\s*{[^}]+}/)?.[0] ?? "";
    const tableMenuButtonBlock = styles.match(/\.board-table-menu-button\s*{[^}]+}/)?.[0] ?? "";
    const tableLockButtonBlock = styles.match(/\.board-table-lock-button\s*{[^}]+}/)?.[0] ?? "";

    expect(titleBlock).toContain("flex: 0 1 auto;");
    expect(titleBlock).toContain("max-width: 180px;");
    expect(titleBlock).toContain("min-height: 26px;");
    expect(staticTitleBlock).toContain("color: #111827;");
    expect(titleTextBlock).toContain("text-overflow: ellipsis;");
    expect(tableMenuButtonBlock).toContain("border: 0;");
    expect(tableMenuButtonBlock).toContain("background: transparent;");
    expect(tableLockButtonBlock).toContain("border: 0;");
    expect(tableLockButtonBlock).toContain("background: transparent;");
  });

  it("centers task and completion labels when they are column headers", () => {
    const columnAxisTextBlock = styles.match(/\.board-column-label \.board-axis-label-text\s*{[^}]+}/)?.[0] ?? "";
    const columnTaskLabelBlock = styles.match(/\.board-column-label \.board-task-label\s*{[^}]+}/)?.[0] ?? "";

    expect(columnAxisTextBlock).toContain("justify-content: center;");
    expect(columnAxisTextBlock).toContain("width: 100%;");
    expect(columnTaskLabelBlock).toContain("text-align: center;");
  });

  it("lets adventure island continent and times occupy their own readable lines", () => {
    const islandLineBlock = styles.match(/\.board-schedule-island-continent,\n\.board-schedule-island-times\s*{[^}]+}/)?.[0] ?? "";

    expect(islandLineBlock).toContain("display: block;");
    expect(islandLineBlock).toContain("white-space: normal;");
  });

  it("keeps board table and memo title spacing compact", () => {
    const tableSummaryBlock = styles.match(/\.board-table-summary\s*{[^}]+}/)?.[0] ?? "";
    const checkGridBlock = styles.match(/\.board-check-grid\s*{[^}]+}/)?.[0] ?? "";
    const noteTitleInputBlock = styles.match(/\.board-note-title-input\s*{[^}]+}/)?.[0] ?? "";
    const noteTitleViewBlock = styles.match(/\.board-note-title-view\s*{[^}]+}/)?.[0] ?? "";

    expect(tableSummaryBlock).toContain("padding: 3px 7px;");
    expect(checkGridBlock).toContain("margin-top: 3px;");
    expect(noteTitleInputBlock).toContain("padding: 3px;");
    expect(noteTitleViewBlock).toContain("padding: 3px;");
  });

  it("removes the default translucent line from the final board row", () => {
    const finalRowBlock = styles.match(/\.board-row-label\.board-grid-last-row,\n\.board-check-cell\.board-grid-last-row\s*{[^}]+}/)?.[0] ?? "";

    expect(finalRowBlock).toContain("border-bottom: 0;");
  });

  it("styles board notes like compact sticky memo cards", () => {
    const noteBlock = styles.match(/\.board-note-card\s*{[^}]+}/)?.[0] ?? "";
    const noteMenuOpenBlock = styles.match(/\.board-note-card\.menu-open\s*{[^}]+}/)?.[0] ?? "";
    const noteHeaderBlock = styles.match(/\.board-note-header\s*{[^}]+}/)?.[0] ?? "";
    const noteBodyBlock = styles.match(/\.board-note-body\s*{[^}]+}/)?.[0] ?? "";
    const noteTitleInputBlock = styles.match(/\.board-note-title-input\s*{[^}]+}/)?.[0] ?? "";
    const noteTitleViewBlock = styles.match(/\.board-note-title-view\s*{[^}]+}/)?.[0] ?? "";
    const noteMenuWrapBlock = styles.match(/\.board-note-menu-wrap\s*{[^}]+}/)?.[0] ?? "";
    const noteMenuButtonBlock = styles.match(/\.board-note-menu-button\s*{[^}]+}/)?.[0] ?? "";
    const noteMenuDotsBlock = styles.match(/\.board-note-menu-dots\s*{[^}]+}/)?.[0] ?? "";
    const noteResizeBlock = styles.match(/\.board-note-resize-handle\s*{[^}]+}/)?.[0] ?? "";
    const noteResizeLockIconBlock = styles.match(/\.board-note-resize-lock-icon\s*{[^}]+}/)?.[0] ?? "";

    expect(noteBlock).toContain("position: absolute;");
    expect(noteBlock).toContain("box-sizing: border-box;");
    expect(noteBlock).toContain("overflow: hidden;");
    expect(noteMenuOpenBlock).toContain("overflow: visible;");
    expect(noteHeaderBlock).toContain("cursor: grab;");
    expect(noteHeaderBlock).toContain("min-width: 0;");
    expect(noteTitleInputBlock).toContain("flex: 1 1 0;");
    expect(noteTitleViewBlock).toContain("text-overflow: ellipsis;");
    expect(noteTitleViewBlock).toContain("flex: 1 1 0;");
    expect(noteTitleViewBlock).toContain("min-width: 0;");
    expect(noteBodyBlock).toContain("white-space: pre-wrap;");
    expect(noteMenuWrapBlock).toContain("flex: 0 0 28px;");
    expect(noteMenuWrapBlock).toContain("width: 28px;");
    expect(noteMenuWrapBlock).toContain("min-width: 28px;");
    expect(noteMenuButtonBlock).toContain("border: 0;");
    expect(noteMenuButtonBlock).toContain("background: transparent;");
    expect(noteMenuButtonBlock).toContain("flex: 0 0 28px;");
    expect(noteMenuDotsBlock).toContain("box-shadow:");
    expect(noteResizeBlock).toContain("position: absolute;");
    expect(noteResizeBlock).toContain("right: 0;");
    expect(noteResizeBlock).toContain("bottom: 0;");
    expect(noteResizeLockIconBlock).toContain("width: 12px;");
    expect(noteResizeLockIconBlock).toContain("height: 12px;");
  });

  it("defines a dark app theme for the profile menu toggle", () => {
    const darkThemeBlock = styles.match(/\.app-shell\[data-theme="dark"\]\s*{[^}]+}/)?.[0] ?? "";

    expect(darkThemeBlock).toContain("color-scheme: dark;");
    expect(darkThemeBlock).toContain("background: #0f172a;");
    expect(darkThemeBlock).toContain("color: #e5e7eb;");
  });
});
