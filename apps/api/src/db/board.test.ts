import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHEET_NAME,
  DEFAULT_TABLE_NAME,
  buildBoardCompletionPatchesFromLegacy,
  buildDefaultAxisItemSeeds,
  buildMissingDefaultAxisItemSeeds,
  buildManualBoardAxisItemDraft,
  buildBoardAxisItemTransposePlan,
  boardRolesForTableOrientation,
  canApplyBoardTableSettingsUpdate,
  createBoardAxisItem,
  createBoardNote,
  createBoardTable,
  addBoardShareFavorite,
  createManualBoardCharacterForTable,
  createBoardTaskForTable,
  defaultBoardRolesForOrientation,
  defaultOrientationForTableRoles,
  deleteBoardNote,
  deleteBoardShareFavorite,
  ensureDefaultBoard,
  getCurrentBoardCompletionPeriodKeys,
  findBoardCellStatePatchesOutsideCurrentPeriod,
  findUnauthorizedBoardCellStatePatches,
  resolveExpiredBoardCellStateRows,
  findUnauthorizedBoardCompletionPatches,
  findBoardCompletionPatchesOutsideCurrentPeriod,
  listBoardShareFavorites,
  listBoardShares,
  loadBoard,
  loadBoardVersionSummary,
  loadSharedBoard,
  loadSharedBoardVersionSummary,
  startBoardSheetShare,
  stopBoardSheetShare,
  mergeBoardCellStatePatches,
  mergeBoardCompletionPatches,
  reorderBoardAxisItems,
  saveBoardCellStatePatches,
  saveBoardCompletionPatches,
  transposeBoardRoles,
  updateBoardNote,
  updateBoardNoteLayout
} from "./board";

describe("board db defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses Korean-facing default names", () => {
    expect(DEFAULT_SHEET_NAME).toBe("기본");
    expect(DEFAULT_TABLE_NAME).toBe("숙제");
  });

  it("starts sheet sharing with a fresh unguessable share id and bumps versions", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              return null;
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true, meta: { changes: 1 } };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        }
      }
    } as unknown as Parameters<typeof startBoardSheetShare>[0];

    const first = await startBoardSheetShare(env, "user-1", "sheet-1");
    const second = await startBoardSheetShare(env, "user-1", "sheet-1");

    expect(first).toEqual({ shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(second).toEqual({ shareId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(first && second && first !== "not_found" && second !== "not_found" ? first.shareId === second.shareId : true).toBe(false);
    expect(runs).toHaveLength(0);
    expect(batches[0]?.some((statement) => statement.sql.includes("DELETE FROM board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("INSERT INTO board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("board_manifest_versions"))).toBe(true);
  });

  it("stops sheet sharing by deleting the active share and bumping versions", async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT share_id FROM board_shares")) return { share_id: "share-old" };
              return null;
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        }
      }
    } as unknown as Parameters<typeof stopBoardSheetShare>[0];

    await expect(stopBoardSheetShare(env, "user-1", "sheet-1")).resolves.toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("DELETE FROM board_shares"))).toBe(true);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(true);
  });

  it("bumps sheet versions when board notes are created, edited, moved, or deleted", async () => {
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT id FROM board_tables WHERE user_id = ? LIMIT 1")) return { id: "table-existing" };
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              if (sql.includes("SELECT COALESCE(MAX(sort_order)")) return { maxSortOrder: 0, noteCount: 1 };
              return null;
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true, meta: { changes: 1 } };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        }
      }
    } as unknown as Parameters<typeof updateBoardNote>[0];

    await createBoardNote(env, "user-1", { sheetId: "sheet-1", title: "메모", body: "본문" });
    await expect(updateBoardNote(env, "user-1", "note-1", { body: "수정" })).resolves.toBe("updated");
    await expect(updateBoardNoteLayout(env, "user-1", "note-1", { x: 10, y: 20, width: 240, height: 180 })).resolves.toBe(true);
    await expect(deleteBoardNote(env, "user-1", "note-1")).resolves.toBe(true);

    expect(runs).toHaveLength(0);
    expect(batches).toHaveLength(4);
    expect(
      batches.every((statements) => statements.some((statement) => statement.sql.includes("content_version = content_version + 1")))
    ).toBe(true);
  });

  it("lists owner shares and user share favorites", async () => {
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async all() {
              if (sql.includes("FROM board_shares") && sql.includes("JOIN sheets")) {
                return {
                  results: [{ sheet_id: "sheet-1", sheet_name: "숙제", share_id: "share-1", created_at: "2026-06-05 00:00:00" }]
                };
              }
              if (sql.includes("FROM board_share_favorites")) {
                return {
                  results: [
                    {
                      share_id: "share-1",
                      sheet_id: "sheet-1",
                      sheet_name: "숙제",
                      owner_display_name: "냠수",
                      created_at: "2026-06-05 00:00:00"
                    }
                  ]
                };
              }
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof listBoardShares>[0];

    await expect(listBoardShares(env, "user-1")).resolves.toEqual([
      { sheetId: "sheet-1", sheetName: "숙제", shareId: "share-1", createdAt: "2026-06-05 00:00:00" }
    ]);
    await expect(listBoardShareFavorites(env, "viewer-1")).resolves.toEqual([
      {
        shareId: "share-1",
        sheetId: "sheet-1",
        sheetName: "숙제",
        ownerDisplayName: "냠수",
        createdAt: "2026-06-05 00:00:00"
      }
    ]);
  });

  it("adds and removes share favorites only for active shares", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT share_id FROM board_shares")) return { share_id: "share-1" };
              return null;
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true, meta: { changes: 1 } };
            }
          };
        }
      }
    } as unknown as Parameters<typeof addBoardShareFavorite>[0];

    await expect(addBoardShareFavorite(env, "viewer-1", "share-1")).resolves.toEqual({ shareId: "share-1" });
    await expect(deleteBoardShareFavorite(env, "viewer-1", "share-1")).resolves.toBe(true);
    expect(runs.some((statement) => statement.sql.includes("INSERT OR IGNORE INTO board_share_favorites"))).toBe(true);
    expect(runs.some((statement) => statement.sql.includes("DELETE FROM board_share_favorites"))).toBe(true);
  });

  it("loads a shared board with pure read queries and no default seeding", async () => {
    const preparedSql: string[] = [];
    const axisItems = [
      {
        id: "row-task-1",
        user_id: "owner-1",
        table_id: "table-1",
        axis: "row",
        kind: "task",
        label: "일간",
        character_id: null,
        task_id: "task-1",
        task_scope: "character",
        task_reset_type: "daily",
        task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
        task_color: "#2563eb",
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      },
      {
        id: "column-character-1",
        user_id: "owner-1",
        table_id: "table-1",
        axis: "column",
        kind: "character",
        label: "냠수나이스1",
        character_id: "character-1",
        task_id: null,
        task_scope: null,
        task_reset_type: null,
        task_reset_rule_json: null,
        task_color: null,
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      }
    ];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_shares") && sql.includes("share_id = ?")) {
                return { owner_user_id: "owner-1", sheet_id: "sheet-1" };
              }
              if (sql.includes("FROM user_settings")) return null;
              return null;
            },
            async all() {
              if (sql.includes("FROM sheets")) {
                return { results: [{ id: "sheet-1", name: "숙제", sort_order: 0, is_default: 1, content_version: 0 }] };
              }
              if (sql.includes("FROM board_tables")) {
                return {
                  results: [
                    {
                      id: "table-1",
                      user_id: "owner-1",
                      sheet_id: "sheet-1",
                      name: "숙제",
                      sort_order: 0,
                      x: 0,
                      y: 0
                    }
                  ]
                };
              }
              if (sql.includes("FROM board_notes")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) return { results: axisItems };
              if (sql.includes("FROM board_cell_states")) return { results: [] };
              if (sql.includes("FROM board_cell_completions")) {
                return {
                  results: [
                    {
                      table_id: "table-1",
                      row_item_id: "row-task-1",
                      column_item_id: "column-character-1",
                      period_key: "daily:2026-06-05",
                      completed: 1
                    }
                  ]
                };
              }
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof loadSharedBoard>[0];

    await expect(loadSharedBoard(env, "share-1", new Date("2026-06-05T03:00:00.000Z"))).resolves.toMatchObject({
      shareId: "share-1",
      readOnly: true,
      userId: "owner-1",
      sheets: [{ id: "sheet-1", name: "숙제" }],
      tables: [{ id: "table-1", sheet_id: "sheet-1" }],
      completions: [{ period_key: "daily:2026-06-05", completed: 1 }]
    });
    expect(preparedSql.some((sql) => sql.includes("SELECT checklist_orientation"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO board_tables"))).toBe(false);
  });

  it("loads owner board versions without scanning axis items on every poll", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_manifest_versions")) return { version: 3 };
              return null;
            },
            async all() {
              if (sql.includes("FROM sheets")) {
                return { results: [{ id: "sheet-1", content_version: 5 }] };
              }
              if (sql.includes("FROM board_axis_items")) throw new Error("versions should not scan axis items");
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof loadBoardVersionSummary>[0];

    await expect(loadBoardVersionSummary(env, "user-1", new Date("2026-06-05T03:00:00.000Z"))).resolves.toEqual({
      manifestVersion: 3,
      sheets: [{ id: "sheet-1", version: 5 }],
      periodFingerprint: ""
    });
    expect(preparedSql.some((sql) => sql.includes("FROM board_axis_items"))).toBe(false);
  });

  it("loads shared board versions only when the share is active without scanning axis items", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_shares")) {
                return { owner_user_id: "owner-1", sheet_id: "sheet-1", content_version: 7 };
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM board_axis_items")) throw new Error("shared versions should not scan axis items");
              return { results: [] };
            }
          };
        }
      }
    } as unknown as Parameters<typeof loadSharedBoardVersionSummary>[0];

    await expect(loadSharedBoardVersionSummary(env, "AbCdEfGhIjKlMnOpQrStUv", new Date("2026-06-05T03:00:00.000Z"))).resolves.toEqual({
      shareId: "AbCdEfGhIjKlMnOpQrStUv",
      sheetId: "sheet-1",
      version: 7,
      periodFingerprint: ""
    });
    expect(preparedSql.some((sql) => sql.includes("FROM board_axis_items"))).toBe(false);
  });

  it("bumps the owning sheet version when saving completion and cell visibility patches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T03:00:00.000Z"));
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT locked FROM board_tables")) return { locked: 0 };
              return null;
            },
            async all() {
              if (sql.includes("SELECT board_tables.id AS tableId")) {
                return {
                  results: [
                    {
                      tableId: "table-1",
                      rowItemId: "row-task-1",
                      columnItemId: "column-character-1",
                      rowKind: "task",
                      columnKind: "character",
                      rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
                      columnTaskResetRuleJson: null
                    }
                  ]
                };
              }
              return { results: [] };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ success: true, meta: { changes: 1 } }));
        }
      }
    } as unknown as Parameters<typeof saveBoardCompletionPatches>[0];

    await expect(
      saveBoardCompletionPatches(env, "user-1", [
        {
          tableId: "table-1",
          rowItemId: "row-task-1",
          columnItemId: "column-character-1",
          periodKey: "daily:2026-06-05",
          completed: true
        }
      ])
    ).resolves.toBe(true);
    await expect(
      saveBoardCellStatePatches(env, "user-1", [
        {
          tableId: "table-1",
          rowItemId: "row-task-1",
          columnItemId: "column-character-1",
          markType: "disabled",
          memo: null
        }
      ])
    ).resolves.toBe(true);

    expect(batches).toHaveLength(2);
    expect(batches[0]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(true);
    expect(batches[1]?.some((statement) => statement.sql.includes("content_version = content_version + 1"))).toBe(true);
  });

  it("maps existing orientation to board roles", () => {
    expect(defaultBoardRolesForOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(defaultBoardRolesForOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
  });

  it("maps creatable table orientations to board roles", () => {
    expect(boardRolesForTableOrientation("tasks_rows")).toMatchObject({
      rowRole: "task",
      columnRole: "character",
      taskAxis: "rows"
    });
    expect(boardRolesForTableOrientation("tasks_columns")).toMatchObject({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
    expect(boardRolesForTableOrientation("custom")).toMatchObject({
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    });
  });

  it("transposes board table roles without changing custom semantics", () => {
    expect(transposeBoardRoles({ rowRole: "task", columnRole: "character", taskAxis: "rows" })).toEqual({
      rowRole: "character",
      columnRole: "task",
      taskAxis: "columns"
    });
    expect(transposeBoardRoles({ rowRole: "custom", columnRole: "custom", taskAxis: "none" })).toEqual({
      rowRole: "custom",
      columnRole: "custom",
      taskAxis: "none"
    });
  });

  it("allows locked board table settings only when structure is unchanged", () => {
    const current = {
      name: "숙제",
      default_row_height: 40,
      default_column_width: 132,
      display_options_json: null,
      event_options_json: null,
      template_type: "custom" as const,
      locked: 1
    };

    expect(
      canApplyBoardTableSettingsUpdate(current, {
        name: "숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 0,
        displaySettings: undefined
      })
    ).toBe(true);
    expect(
      canApplyBoardTableSettingsUpdate(current, {
        name: "주간 숙제",
        defaultRowHeight: 40,
        defaultColumnWidth: 132,
        locked: 1,
        displaySettings: undefined
      })
    ).toBe(false);
    expect(
      canApplyBoardTableSettingsUpdate({ ...current, locked: 0 }, {
        name: "주간 숙제",
        defaultRowHeight: 44,
        defaultColumnWidth: 144,
        locked: 1,
        displaySettings: {
          show_display_name: 1,
          show_server_name: 1,
          show_class_name: 0,
          show_item_level: 1,
          show_combat_power: 0
        }
      })
    ).toBe(true);
  });

  it("plans axis transposition with temporary sort orders to avoid unique collisions", () => {
    expect(
      buildBoardAxisItemTransposePlan([
        { id: "row-task-1", axis: "row", sort_order: 0, size_px: 40, cross_size_px: 180 },
        { id: "row-task-2", axis: "row", sort_order: 10, size_px: 52, cross_size_px: 180 },
        { id: "column-character-1", axis: "column", sort_order: 0, size_px: 132, cross_size_px: 30 },
        { id: "column-character-2", axis: "column", sort_order: 10, size_px: 148, cross_size_px: 30 }
      ])
    ).toEqual([
      {
        id: "row-task-1",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000010,
        finalSortOrder: 0,
        finalSizePx: 132,
        finalCrossSizePx: 30
      },
      {
        id: "row-task-2",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000020,
        finalSortOrder: 10,
        finalSizePx: 148,
        finalCrossSizePx: 30
      },
      {
        id: "column-character-1",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000010,
        finalSortOrder: 0,
        finalSizePx: 40,
        finalCrossSizePx: 180
      },
      {
        id: "column-character-2",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000020,
        finalSortOrder: 10,
        finalSizePx: 52,
        finalCrossSizePx: 180
      }
    ]);
  });

  it("keeps destination row and column dimensions when transposing uneven axes", () => {
    expect(
      buildBoardAxisItemTransposePlan([
        { id: "row-task-1", axis: "row", sort_order: 0, size_px: 40, cross_size_px: 180 },
        { id: "row-task-2", axis: "row", sort_order: 10, size_px: 52, cross_size_px: 180 },
        { id: "column-character-1", axis: "column", sort_order: 0, size_px: 132, cross_size_px: 30 }
      ])
    ).toEqual([
      {
        id: "row-task-1",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000010,
        finalSortOrder: 0,
        finalSizePx: 132,
        finalCrossSizePx: 30
      },
      {
        id: "row-task-2",
        fromAxis: "row",
        toAxis: "column",
        temporarySortOrder: -1000020,
        finalSortOrder: 10,
        finalSizePx: 132,
        finalCrossSizePx: 30
      },
      {
        id: "column-character-1",
        fromAxis: "column",
        toAxis: "row",
        temporarySortOrder: -2000010,
        finalSortOrder: 0,
        finalSizePx: 40,
        finalCrossSizePx: 180
      }
    ]);
  });

  it("builds task-like manual axis items when the axis role is task", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "row",
        axisRole: "task",
        label: "세르카",
        taskColorIndex: 1
      })
    ).toMatchObject({
      axis: "row",
      kind: "task",
      label: "세르카",
      taskId: null,
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      taskColor: "#13795b"
    });
  });

  it("builds free manual axis items when the axis role is not task", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "column",
        axisRole: "custom",
        label: "냠1",
        taskColorIndex: 0
      })
    ).toMatchObject({
      axis: "column",
      kind: "custom",
      label: "냠1",
      taskId: null,
      characterId: null,
      taskScope: null,
      taskResetType: null,
      taskResetRuleJson: null,
      taskColor: null
    });
  });

  it("builds task-like manual rows for custom tables so their checkboxes can reset", () => {
    expect(
      buildManualBoardAxisItemDraft({
        axis: "row",
        axisRole: "custom",
        label: "필드 보스",
        taskColorIndex: 2
      })
    ).toMatchObject({
      axis: "row",
      kind: "task",
      taskScope: "custom",
      taskResetType: "daily",
      taskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
      taskColor: "#b45309"
    });
  });

  it("derives bootstrap orientation from an existing table's roles", () => {
    expect(defaultOrientationForTableRoles({ rowRole: "task", columnRole: "character" }, "tasks_columns")).toBe("tasks_rows");
    expect(defaultOrientationForTableRoles({ rowRole: "character", columnRole: "task" }, "tasks_rows")).toBe("tasks_columns");
    expect(defaultOrientationForTableRoles({ rowRole: "custom", columnRole: "custom" }, "tasks_rows")).toBe("tasks_rows");
  });

  it("keeps the latest board completion patch per semantic cell and period", () => {
    expect(
      mergeBoardCompletionPatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: true
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          periodKey: "daily:2026-06-01",
          completed: false
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        periodKey: "daily:2026-06-01",
        completed: false
      }
    ]);
  });

  it("keeps the latest board cell state patch per semantic cell", () => {
    expect(
      mergeBoardCellStatePatches([
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "disabled",
          memo: null
        },
        {
          tableId: "table-1",
          rowItemId: "row-1",
          columnItemId: "column-1",
          markType: "fixed",
          memo: "고정파티"
        }
      ])
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-1",
        columnItemId: "column-1",
        markType: "fixed",
        memo: "고정파티"
      }
    ]);
  });

  it("builds task rows and character columns from existing checklist data", () => {
    expect(
      buildDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        tasks: [
          {
            id: "task-a",
            name: "쿠르잔 전선",
            scope: "character",
            resetType: "daily",
            resetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            sortOrder: 20
          }
        ],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([
      { axis: "row", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0, taskColor: "#2563eb" },
      { axis: "column", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 }
    ]);
  });

  it("builds character rows and task columns when the user chose tasks as columns", () => {
    expect(
      buildDefaultAxisItemSeeds({
        orientation: "tasks_columns",
        tasks: [
          {
            id: "task-a",
            name: "쿠르잔 전선",
            scope: "character",
            resetType: "daily",
            resetRuleJson: "{}",
            sortOrder: 20
          }
        ],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([
      { axis: "row", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 },
      { axis: "column", kind: "task", taskId: "task-a", label: "쿠르잔 전선", sortOrder: 0 }
    ]);
  });

  it("does not keep syncing newly imported global characters into an initialized default table", () => {
    expect(
      buildMissingDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        defaultTableCreated: false,
        existingAxisItems: [
          {
            axis: "row",
            kind: "task",
            task_id: "task-a",
            character_id: null,
            sort_order: 0
          }
        ],
        tasks: [],
        characters: [{ id: "character-b", name: "표비캐릭터", sortOrder: 20 }]
      })
    ).toEqual([]);
  });

  it("seeds initial default table axis items when the default table is newly created", () => {
    expect(
      buildMissingDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        defaultTableCreated: true,
        existingAxisItems: [],
        tasks: [],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toMatchObject([{ axis: "column", kind: "character", characterId: "character-a", label: "냠수나이스1", sortOrder: 0 }]);
  });

  it("does not seed an empty default table after it already existed", () => {
    expect(
      buildMissingDefaultAxisItemSeeds({
        orientation: "tasks_rows",
        defaultTableCreated: false,
        existingAxisItems: [],
        tasks: [],
        characters: [{ id: "character-a", name: "냠수나이스1", sortOrder: 10 }]
      })
    ).toEqual([]);
  });

  it("keeps an initialized board empty instead of recreating the default table", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) return null;
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          runs.push(...statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof ensureDefaultBoard>[0];

    await ensureDefaultBoard(env, "user-1");

    expect(runs.some((statement) => statement.sql.includes("INSERT INTO board_tables"))).toBe(false);
  });

  it("skips default seeding and legacy sync when any board table already exists", async () => {
    const preparedSql: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          preparedSql.push(sql);
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("FROM board_tables") && sql.includes("LIMIT 1")) return { id: "table-1" };
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          preparedSql.push(...statements.map((statement) => statement.sql));
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof ensureDefaultBoard>[0];

    await ensureDefaultBoard(env, "user-1");

    expect(preparedSql.some((sql) => sql.includes("FROM tasks"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("FROM characters"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("FROM completions"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("INSERT INTO board_axis_items"))).toBe(false);
  });

  it("creates only the requested table after every existing table was deleted", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: -10, tableCount: 0 };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          runs.push(...statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof createBoardTable>[0];

    await expect(
      createBoardTable(env, "user-1", {
        sheetId: "sheet-1",
        name: "새 표",
        orientation: "custom"
      })
    ).resolves.toEqual({ id: expect.any(String) });

    const tableInserts = runs.filter((statement) => statement.sql.includes("INSERT INTO board_tables"));
    expect(tableInserts).toHaveLength(1);
    expect(tableInserts[0]?.values[3]).toBe("새 표");
  });

  it("places newly added board tables near the top-left even when the sheet already has tables", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) return null;
              if (sql.includes("SELECT id FROM sheets WHERE id = ? AND user_id = ?")) return { id: "sheet-1" };
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: 70, tableCount: 8 };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          runs.push(...statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof createBoardTable>[0];

    await expect(
      createBoardTable(env, "user-1", {
        sheetId: "sheet-1",
        name: "겹쳐서 추가",
        orientation: "tasks_columns"
      })
    ).resolves.toEqual({ id: expect.any(String) });

    const tableInsert = runs.find((statement) => statement.sql.includes("INSERT INTO board_tables"));
    expect(tableInsert?.values.slice(4, 7)).toEqual([80, 24, 24]);
  });

  it("reorders visible axis items when hidden items remain in the table", async () => {
    const axisItems = [
      { id: "row-a", visible: 1 },
      { id: "row-hidden", visible: 0 },
      { id: "row-b", visible: 1 }
    ];
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              return { id: "table-1", locked: 0 };
            },
            async all() {
              const results = sql.includes("visible = 1") ? axisItems.filter((item) => item.visible === 1) : axisItems;
              return { results: results.map((item) => ({ id: item.id, visible: item.visible })) };
            },
            async run() {
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          batches.push(statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof reorderBoardAxisItems>[0];

    await expect(
      reorderBoardAxisItems(env, "user-1", {
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-b", "row-a"]
      })
    ).resolves.toBe(true);
    expect(batches[0]?.map((statement) => statement.values[1])).toEqual(["row-b", "row-a", "row-hidden", "row-b", "row-a", "row-hidden"]);
  });

  it("moves hidden axis items out of the way before reordering visible items", async () => {
    const axisItems = [
      { id: "row-a", visible: 1, sortOrder: 0 },
      { id: "row-hidden", visible: 0, sortOrder: 10 },
      { id: "row-b", visible: 1, sortOrder: 20 }
    ];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              return { id: "table-1", locked: 0 };
            },
            async all() {
              const results = sql.includes("visible = 1") ? axisItems.filter((item) => item.visible === 1) : axisItems;
              return { results: results.map((item) => ({ id: item.id, visible: item.visible })) };
            }
          };
        },
        async batch(statements: Array<{ values: unknown[] }>) {
          for (const statement of statements) {
            const nextSortOrder = Number(statement.values[0]);
            const id = String(statement.values[1]);
            const item = axisItems.find((axisItem) => axisItem.id === id);
            if (!item) throw new Error("missing axis item");
            const collision = axisItems.some((axisItem) => axisItem.id !== id && axisItem.sortOrder === nextSortOrder);
            if (collision) throw new Error("UNIQUE constraint failed: board_axis_items.table_id, board_axis_items.axis, board_axis_items.sort_order");
            item.sortOrder = nextSortOrder;
          }
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof reorderBoardAxisItems>[0];

    await expect(
      reorderBoardAxisItems(env, "user-1", {
        tableId: "table-1",
        axis: "row",
        axisItemIds: ["row-b", "row-a"]
      })
    ).resolves.toBe(true);
    expect(axisItems).toMatchObject([
      { id: "row-a", sortOrder: 10 },
      { id: "row-hidden", sortOrder: 20 },
      { id: "row-b", sortOrder: 0 }
    ]);
  });

  it("inherits visible axis item dimensions when creating a new manual row", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 10, taskCount: 1 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 44, cross_size_px: 180 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [{ axis: "row", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createBoardAxisItem>[0];

    await expect(createBoardAxisItem(env, "user-1", { tableId: "table-1", axis: "row", label: "새 숙제" })).resolves.toEqual({
      id: expect.any(String)
    });

    const inserted = inserts.at(-1);
    expect(inserted?.sql).toContain("size_px");
    expect(inserted?.sql).toContain("cross_size_px");
    expect(inserted?.values.slice(-3)).toEqual([20, 44, 180]);
  });

  it("creates a manual character and attaches it to the table character axis", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("FROM characters") && sql.includes("name = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS max_sort")) return { max_sort: -10 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 44, cross_size_px: 180 };
              if (sql.includes("kind = 'character' AND character_id = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: 10 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) return { results: [] };
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createManualBoardCharacterForTable>[0];

    await expect(
      createManualBoardCharacterForTable(env, "user-1", "table-1", {
        name: "임의캐릭터",
        serverName: "",
        className: "",
        itemLevel: "",
        combatPower: null
      })
    ).resolves.toEqual({ id: expect.any(String) });

    const characterInsert = runs.find((statement) => statement.sql.includes("INSERT INTO characters"));
    const axisInsert = runs.find((statement) => statement.sql.includes("INSERT INTO board_axis_items"));
    expect(characterInsert?.sql).toContain("'manual'");
    expect(characterInsert?.values.slice(2, 7)).toEqual(["임의캐릭터", "", "", "", null]);
    expect(axisInsert?.values.slice(4, 7)).toEqual(["임의캐릭터", expect.any(String), 20]);
  });

  it("uses the existing character axis when table roles are stale after a transpose", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("FROM characters") && sql.includes("name = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS max_sort")) return { max_sort: -10 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 48, cross_size_px: 132 };
              if (sql.includes("kind = 'character' AND character_id = ?")) return null;
              if (sql.includes("COALESCE(MAX(sort_order), -10) AS maxSortOrder")) return { maxSortOrder: 80 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [
                    { axis: "row", kind: "character", task_id: null, character_id: "character-1", sort_order: 0 },
                    { axis: "column", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createManualBoardCharacterForTable>[0];

    await expect(
      createManualBoardCharacterForTable(env, "user-1", "table-1", {
        name: "전환후캐릭터",
        serverName: "",
        className: "",
        itemLevel: "",
        combatPower: null
      })
    ).resolves.toEqual({ id: expect.any(String) });

    const axisInsert = runs.find((statement) => statement.sql.includes("INSERT INTO board_axis_items"));
    const roleRepair = runs.find((statement) => statement.sql.includes("UPDATE board_tables"));
    expect(roleRepair?.values.slice(0, 3)).toEqual(["character", "task", "columns"]);
    expect(axisInsert?.values[3]).toBe("row");
    expect(axisInsert?.values.slice(-3)).toEqual([90, 48, 132]);
  });

  it("inherits visible axis item dimensions when adding a task row", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 44, cross_size_px: 180 };
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 10, taskCount: 1 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [{ axis: "row", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "새 숙제",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        taskColor: "#be123c"
      })
    ).resolves.toEqual({ id: expect.any(String) });

    const inserted = inserts.at(-1);
    expect(inserted?.sql).toContain("size_px");
    expect(inserted?.sql).toContain("cross_size_px");
    expect(inserted?.values.slice(-5)).toEqual(["#be123c", 20, 44, 180, null]);
  });

  it("adds new board tasks to the task column after a table transpose", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "character", column_role: "task" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "character", column_role: "task", locked: 0 };
              }
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 132, cross_size_px: 48 };
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 30, taskCount: 4 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [
                    { axis: "row", kind: "character", task_id: null, character_id: "character-1", sort_order: 0 },
                    { axis: "column", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "전환 후 숙제",
        scope: "character",
        resetRule: { type: "weekly", weekday: 3, hour: 6, timezone: "Asia/Seoul" },
        taskColor: "#7c3aed"
      })
    ).resolves.toEqual({ id: expect.any(String) });

    const inserted = inserts.at(-1);
    expect(inserted?.values[3]).toBe("column");
    expect(inserted?.values[4]).toBe("전환 후 숙제");
    expect(inserted?.values[7]).toBe("weekly");
    expect(inserted?.values.slice(-5)).toEqual(["#7c3aed", 40, 132, 48, null]);
  });

  it("uses the existing task axis when table roles are stale after a transpose", async () => {
    const inserts: Array<{ sql: string; values: unknown[] }> = [];
    const roleRepairs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("SELECT COALESCE(MAX(sort_order), 0) AS max_sort FROM tasks")) return { max_sort: 0 };
              if (sql.includes("SELECT size_px, cross_size_px")) return { size_px: 132, cross_size_px: 48 };
              if (sql.includes("SUM(CASE WHEN kind = 'task'")) return { maxSortOrder: 30, taskCount: 4 };
              return null;
            },
            async all() {
              if (sql.includes("FROM tasks")) return { results: [] };
              if (sql.includes("FROM characters")) return { results: [] };
              if (sql.includes("FROM board_axis_items")) {
                return {
                  results: [
                    { axis: "row", kind: "character", task_id: null, character_id: "character-1", sort_order: 0 },
                    { axis: "column", kind: "task", task_id: "task-1", character_id: null, sort_order: 0 }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE board_tables")) roleRepairs.push({ sql, values: this.values });
              if (sql.includes("INSERT INTO board_axis_items")) inserts.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "역할 불일치 방어",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" }
      })
    ).resolves.toEqual({ id: expect.any(String) });

    expect(roleRepairs.at(-1)?.values.slice(0, 3)).toEqual(["character", "task", "columns"]);
    expect(inserts.at(-1)?.values[3]).toBe("column");
  });

  it("reuses an existing board task created by the same request id", async () => {
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              if (sql.includes("SELECT checklist_orientation")) return null;
              if (sql.includes("FROM sheets") && sql.includes("is_default = 1")) return { id: "sheet-1" };
              if (sql.includes("ORDER BY sort_order LIMIT 1") && sql.includes("FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character" };
              }
              if (sql.includes("SELECT id, row_role, column_role, locked FROM board_tables")) {
                return { id: "table-1", row_role: "task", column_role: "character", locked: 0 };
              }
              if (sql.includes("create_request_id") && sql.includes("FROM board_axis_items")) return { id: "axis-existing" };
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true };
            }
          };
        }
      }
    } as unknown as Parameters<typeof createBoardTaskForTable>[0];

    await expect(
      createBoardTaskForTable(env, "user-1", "table-1", {
        name: "새 숙제",
        scope: "character",
        resetRule: { type: "daily", hour: 6, timezone: "Asia/Seoul" },
        createRequestId: "task-create-1"
      })
    ).resolves.toEqual({ id: "axis-existing" });
    expect(runs.some((statement) => statement.sql.includes("INSERT INTO board_axis_items"))).toBe(false);
  });

  it("maps legacy task-character completions to board row and column item ids", () => {
    expect(
      buildBoardCompletionPatchesFromLegacy({
        tableId: "table-1",
        axisItems: [
          {
            id: "row-task-1",
            axis: "row",
            kind: "task",
            taskId: "task-1",
            characterId: null
          },
          {
            id: "column-character-1",
            axis: "column",
            kind: "character",
            taskId: null,
            characterId: "character-1"
          }
        ],
        completions: [
          {
            taskId: "task-1",
            characterId: "character-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ]
      })
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-character-1",
        periodKey: "daily:2026-06-01",
        completed: true
      }
    ]);
  });

  it("derives only current board completion periods from task reset rules", () => {
    expect(
      getCurrentBoardCompletionPeriodKeys(
        [
          {
            kind: "task",
            task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}'
          },
          {
            kind: "task",
            task_reset_rule_json: '{"type":"weekly","weekday":3,"hour":6,"timezone":"Asia/Seoul"}'
          },
          {
            kind: "task",
            task_reset_rule_json: '{"type":"none"}'
          },
          {
            kind: "character",
            task_reset_rule_json: null
          }
        ],
        new Date("2026-06-04T02:00:00.000Z")
      )
    ).toEqual(["daily:2026-06-04", "weekly:2026-06-03", "none:permanent"]);
  });

  it("loads only current-period board cell completions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T02:00:00.000Z"));

    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    const axisItems = [
      {
        id: "row-task-1",
        user_id: "user-1",
        table_id: "table-1",
        axis: "row",
        kind: "task",
        label: "일간",
        character_id: null,
        task_id: "task-1",
        task_scope: "character",
        task_reset_type: "daily",
        task_reset_rule_json: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
        task_color: "#2563eb",
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      },
      {
        id: "column-character-1",
        user_id: "user-1",
        table_id: "table-1",
        axis: "column",
        kind: "character",
        label: "냠수나이스1",
        character_id: "character-1",
        task_id: null,
        task_scope: null,
        task_reset_type: null,
        task_reset_rule_json: null,
        task_color: null,
        size_px: null,
        cross_size_px: null,
        sort_order: 0,
        visible: 1,
        separator_json: null
      }
    ];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              return { ...this, values };
            },
            async first() {
              prepared.push({ sql, values: this.values });
              if (sql.includes("FROM board_tables") && sql.includes("LIMIT 1")) return { id: "table-1" };
              return null;
            },
            async all() {
              prepared.push({ sql, values: this.values });
              if (sql.includes("FROM board_axis_items")) return { results: axisItems };
              if (sql.includes("FROM board_cell_completions")) {
                return {
                  results: [
                    {
                      table_id: "table-1",
                      row_item_id: "row-task-1",
                      column_item_id: "column-character-1",
                      period_key: "daily:2026-06-04",
                      completed: 1
                    }
                  ]
                };
              }
              return { results: [] };
            },
            async run() {
              prepared.push({ sql, values: this.values });
              return { success: true };
            }
          };
        },
        async batch(statements: Array<{ sql: string; values: unknown[] }>) {
          prepared.push(...statements);
          return statements.map(() => ({ success: true }));
        }
      }
    } as unknown as Parameters<typeof loadBoard>[0];

    await expect(loadBoard(env, "user-1")).resolves.toMatchObject({
      completions: [{ period_key: "daily:2026-06-04", completed: 1 }]
    });

    const completionQuery = prepared.find((statement) => statement.sql.includes("FROM board_cell_completions"));
    expect(completionQuery?.sql).toContain("period_key IN (?)");
    expect(completionQuery?.values).toEqual(["user-1", "daily:2026-06-04"]);
  });

  it("detects board completion patches outside authorized table and axis targets", () => {
    expect(
      findUnauthorizedBoardCompletionPatches(
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          },
          {
            tableId: "table-1",
            rowItemId: "row-from-other-table",
            columnItemId: "column-1",
            periodKey: "daily:2026-06-01",
            completed: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1"
          }
        ]
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-from-other-table",
        columnItemId: "column-1",
        periodKey: "daily:2026-06-01",
        completed: true
      }
    ]);
  });

  it("detects board completion patches outside the server-derived KST period", () => {
    expect(
      findBoardCompletionPatchesOutsideCurrentPeriod(
        [
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-1",
            periodKey: "daily:2026-05-28",
            completed: true
          },
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-2",
            periodKey: "daily:2026-05-29",
            completed: true
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-1",
            rowKind: "task",
            columnKind: "character",
            rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            columnTaskResetRuleJson: null
          },
          {
            tableId: "table-1",
            rowItemId: "row-task-1",
            columnItemId: "column-2",
            rowKind: "task",
            columnKind: "character",
            rowTaskResetRuleJson: '{"type":"daily","hour":6,"timezone":"Asia/Seoul"}',
            columnTaskResetRuleJson: null
          }
        ],
        new Date("2026-05-28T20:59:00.000Z")
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-task-1",
        columnItemId: "column-2",
        periodKey: "daily:2026-05-29",
        completed: true
      }
    ]);
  });

  it("detects board cell state patches outside authorized table and axis targets", () => {
    expect(
      findUnauthorizedBoardCellStatePatches(
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1",
            markType: "disabled",
            memo: null
          },
          {
            tableId: "table-1",
            rowItemId: "row-from-other-table",
            columnItemId: "column-1",
            markType: "default",
            memo: null
          }
        ],
        [
          {
            tableId: "table-1",
            rowItemId: "row-1",
            columnItemId: "column-1"
          }
        ]
      )
    ).toEqual([
      {
        tableId: "table-1",
        rowItemId: "row-from-other-table",
        columnItemId: "column-1",
        markType: "default",
        memo: null
      }
    ]);
  });

  it("rejects reserved cell marks whose period key is not current", () => {
    const target = {
      tableId: "table-1",
      rowItemId: "row-task-1",
      columnItemId: "column-character-1",
      rowKind: "task" as const,
      columnKind: "character" as const,
      rowTaskResetRuleJson: JSON.stringify({ type: "daily", hour: 6, timezone: "Asia/Seoul" }),
      columnTaskResetRuleJson: null
    };
    const now = new Date("2026-06-11T12:00:00+09:00");
    const base = { tableId: "table-1", rowItemId: "row-task-1", columnItemId: "column-character-1" };

    expect(
      findBoardCellStatePatchesOutsideCurrentPeriod(
        [{ ...base, markType: "reserved", memo: "약속", periodKey: "daily:2026-06-11" }],
        [target],
        now
      )
    ).toEqual([]);
    expect(
      findBoardCellStatePatchesOutsideCurrentPeriod(
        [{ ...base, markType: "reserved", memo: "약속", periodKey: "daily:2026-06-10" }],
        [target],
        now
      )
    ).toHaveLength(1);
    expect(
      findBoardCellStatePatchesOutsideCurrentPeriod([{ ...base, markType: "fixed", memo: "고정" }], [target], now)
    ).toEqual([]);
  });

  it("drops expired reserved cell marks while keeping fixed and disabled marks", () => {
    const axisItems = [
      {
        id: "row-task-1",
        kind: "task",
        task_reset_rule_json: JSON.stringify({ type: "daily", hour: 6, timezone: "Asia/Seoul" })
      },
      { id: "column-character-1", kind: "character", task_reset_rule_json: null }
    ];
    const now = new Date("2026-06-11T12:00:00+09:00");
    const base = { row_item_id: "row-task-1", column_item_id: "column-character-1" };

    expect(
      resolveExpiredBoardCellStateRows(
        [
          { ...base, mark_type: "reserved", mark_period_key: "daily:2026-06-11" },
          { ...base, mark_type: "reserved", mark_period_key: "daily:2026-06-10" },
          { ...base, mark_type: "reserved", mark_period_key: null },
          { ...base, mark_type: "fixed", mark_period_key: null },
          { ...base, mark_type: "disabled", mark_period_key: null }
        ],
        axisItems,
        now
      )
    ).toEqual([
      { ...base, mark_type: "reserved", mark_period_key: "daily:2026-06-11" },
      { ...base, mark_type: "fixed", mark_period_key: null },
      { ...base, mark_type: "disabled", mark_period_key: null }
    ]);
  });
});
