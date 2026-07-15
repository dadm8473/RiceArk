import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DATABASE_NAME = "riceark";
const USER_ID = "user-1";
const SHEET_ID = "sheet-1";
const TABLE_ID = "table-1";
const CHARACTER_ID = "character-1";
const CHARACTER_REFRESH_GUARD_PATH = "$[riceark_character_refresh_exact_set_guard_constraint_v1";
const SUCCESS_LINE = "board bulk SQL verified: cells=2, completed=2, version=1";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = dirname(scriptDirectory);
const migrationsDirectory = join(apiDirectory, "migrations");
const require = createRequire(import.meta.url);
const wranglerBin = require.resolve("wrangler/bin/wrangler.js");

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlBatch(...statements) {
  return `${statements.join(";\n")};`;
}

function boardInputCte(payloadJson) {
  return `input AS (
    SELECT CAST(key AS INTEGER) AS ordinal,
           json_extract(value, '$.id') AS id,
           json_extract(value, '$.table_id') AS table_id,
           json_extract(value, '$.row_item_id') AS row_item_id,
           json_extract(value, '$.column_item_id') AS column_item_id,
           json_extract(value, '$.period_key') AS period_key,
           CAST(json_extract(value, '$.completed') AS INTEGER) AS completed,
           CAST(json_extract(value, '$.checkbox_visible') AS INTEGER) AS checkbox_visible,
           json_extract(value, '$.mark_type') AS mark_type,
           json_extract(value, '$.mark_icon') AS mark_icon,
           json_extract(value, '$.memo') AS memo,
           json_extract(value, '$.mark_period_key') AS mark_period_key,
           CAST(json_extract(value, '$.delete_state') AS INTEGER) AS delete_state,
           json_extract(value, '$.sheet_id') AS sheet_id,
           json_extract(value, '$.row_kind') AS row_kind,
           json_extract(value, '$.column_kind') AS column_kind,
           json_extract(value, '$.row_task_reset_rule_json') AS row_task_reset_rule_json,
           json_extract(value, '$.column_task_reset_rule_json') AS column_task_reset_rule_json,
           CAST(json_extract(value, '$.guard_expires_at') AS INTEGER) AS guard_expires_at
    FROM json_each(${sqlLiteral(payloadJson)})
  )`;
}

function boardValidCte() {
  return `valid AS (
    SELECT input.*
    FROM input
    JOIN board_tables AS tables
      ON tables.id = input.table_id
     AND tables.user_id = ${sqlLiteral(USER_ID)}
     AND tables.locked = 0
     AND tables.sheet_id = input.sheet_id
    JOIN sheets
      ON sheets.id = input.sheet_id
     AND sheets.user_id = ${sqlLiteral(USER_ID)}
    JOIN board_axis_items AS row_items
      ON row_items.id = input.row_item_id
     AND row_items.user_id = ${sqlLiteral(USER_ID)}
     AND row_items.table_id = input.table_id
     AND row_items.axis = 'row'
     AND row_items.visible = 1
     AND row_items.kind = input.row_kind
     AND row_items.task_reset_rule_json IS input.row_task_reset_rule_json
    JOIN board_axis_items AS column_items
      ON column_items.id = input.column_item_id
     AND column_items.user_id = ${sqlLiteral(USER_ID)}
     AND column_items.table_id = input.table_id
     AND column_items.axis = 'column'
     AND column_items.visible = 1
     AND column_items.kind = input.column_kind
     AND column_items.task_reset_rule_json IS input.column_task_reset_rule_json
    WHERE input.guard_expires_at IS NULL
       OR CAST(strftime('%s', 'now') AS INTEGER) < input.guard_expires_at
  )`;
}

const completeBoardGuard = `(SELECT COUNT(*) FROM valid) = (SELECT COUNT(*) FROM input)`;

function boardCompletionUpsertSql(payloadJson) {
  return `WITH ${boardInputCte(payloadJson)}, ${boardValidCte()}
    INSERT INTO board_cell_completions
      (id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at)
    SELECT id, ${sqlLiteral(USER_ID)}, table_id, row_item_id, column_item_id, period_key, completed, CURRENT_TIMESTAMP
    FROM valid
    WHERE ${completeBoardGuard}
    ON CONFLICT(user_id, table_id, row_item_id, column_item_id, period_key)
    DO UPDATE SET completed = excluded.completed, updated_at = CURRENT_TIMESTAMP
    RETURNING table_id AS tableId, row_item_id AS rowItemId,
              column_item_id AS columnItemId, period_key AS periodKey`;
}

function boardGuardAssertionSql(payloadJson) {
  return `WITH ${boardInputCte(payloadJson)}, ${boardValidCte()}
    INSERT INTO board_cell_completions
      (id, user_id, table_id, row_item_id, column_item_id, period_key, completed, updated_at)
    SELECT 'board-bulk-guard', NULL, '', '', '', '', 0, CURRENT_TIMESTAMP
    WHERE NOT (${completeBoardGuard})`;
}

function boardVersionUpdateSql(payloadJson) {
  return `WITH ${boardInputCte(payloadJson)}, ${boardValidCte()}
    UPDATE sheets
    SET content_version = content_version + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE sheets.user_id = ${sqlLiteral(USER_ID)}
      AND ${completeBoardGuard}
      AND sheets.id IN (SELECT DISTINCT sheet_id FROM valid)
    RETURNING id, content_version AS version`;
}

function boardCellStateDeleteSql(payloadJson) {
  return `WITH ${boardInputCte(payloadJson)}, ${boardValidCte()}
    DELETE FROM board_cell_states
    WHERE user_id = ${sqlLiteral(USER_ID)}
      AND ${completeBoardGuard}
      AND (table_id, row_item_id, column_item_id) IN (
        SELECT table_id, row_item_id, column_item_id FROM valid WHERE delete_state = 1
      )
    RETURNING table_id AS tableId, row_item_id AS rowItemId, column_item_id AS columnItemId`;
}

function boardCellStateUpsertSql(payloadJson) {
  return `WITH ${boardInputCte(payloadJson)}, ${boardValidCte()}
    INSERT INTO board_cell_states
      (id, user_id, table_id, row_item_id, column_item_id, checkbox_visible, mark_type, mark_icon, memo, mark_period_key, updated_at)
    SELECT id, ${sqlLiteral(USER_ID)}, table_id, row_item_id, column_item_id,
           checkbox_visible, mark_type, mark_icon, memo, mark_period_key, CURRENT_TIMESTAMP
    FROM valid
    WHERE delete_state = 0 AND ${completeBoardGuard}
    ON CONFLICT(table_id, row_item_id, column_item_id)
    DO UPDATE SET checkbox_visible = excluded.checkbox_visible,
                  mark_type = excluded.mark_type,
                  mark_icon = excluded.mark_icon,
                  memo = excluded.memo,
                  mark_period_key = excluded.mark_period_key,
                  updated_at = CURRENT_TIMESTAMP
    RETURNING table_id AS tableId, row_item_id AS rowItemId, column_item_id AS columnItemId`;
}

function boardOrderUpdateSql(orderedIdsJson, temporary) {
  const nextSortOrder = temporary
    ? "(ordered.position - (SELECT COUNT(*) FROM ordered)) * 10"
    : "ordered.position * 10";
  return `WITH requested AS MATERIALIZED (
      SELECT CAST(key AS INTEGER) AS position, value AS id
      FROM json_each(${sqlLiteral(orderedIdsJson)})
    ),
    owned_requested AS MATERIALIZED (
      SELECT requested.position, requested.id
      FROM requested
      JOIN board_axis_items ON board_axis_items.id = requested.id
      WHERE board_axis_items.user_id = ${sqlLiteral(USER_ID)}
        AND board_axis_items.table_id = ${sqlLiteral(TABLE_ID)}
        AND board_axis_items.axis = 'column'
        AND board_axis_items.visible = 1
    ),
    hidden AS MATERIALIZED (
      SELECT board_axis_items.id,
             json_array_length(${sqlLiteral(orderedIdsJson)}) + ROW_NUMBER() OVER (
               ORDER BY board_axis_items.sort_order, board_axis_items.label, board_axis_items.id
             ) - 1 AS position
      FROM board_axis_items
      WHERE board_axis_items.user_id = ${sqlLiteral(USER_ID)}
        AND board_axis_items.table_id = ${sqlLiteral(TABLE_ID)}
        AND board_axis_items.axis = 'column'
        AND board_axis_items.visible <> 1
    ),
    ordered AS MATERIALIZED (
      SELECT id, position FROM owned_requested
      UNION ALL
      SELECT id, position FROM hidden
    ),
    eligible AS MATERIALIZED (
      SELECT 1
      WHERE EXISTS (
        SELECT 1
        FROM board_tables
        WHERE board_tables.id = ${sqlLiteral(TABLE_ID)}
          AND board_tables.user_id = ${sqlLiteral(USER_ID)}
          AND board_tables.locked = 0
      )
        AND (SELECT COUNT(*) FROM requested) = json_array_length(${sqlLiteral(orderedIdsJson)})
        AND (SELECT COUNT(DISTINCT id) FROM requested) = json_array_length(${sqlLiteral(orderedIdsJson)})
        AND (SELECT COUNT(*) FROM owned_requested) = json_array_length(${sqlLiteral(orderedIdsJson)})
        AND (
          SELECT COUNT(*)
          FROM board_axis_items
          WHERE board_axis_items.user_id = ${sqlLiteral(USER_ID)}
            AND board_axis_items.table_id = ${sqlLiteral(TABLE_ID)}
            AND board_axis_items.axis = 'column'
            AND board_axis_items.visible = 1
        ) = json_array_length(${sqlLiteral(orderedIdsJson)})
    )
    UPDATE board_axis_items
    SET sort_order = (
          SELECT ${nextSortOrder}
          FROM ordered
          WHERE ordered.id = board_axis_items.id
        ),
        updated_at = CURRENT_TIMESTAMP
    WHERE board_axis_items.user_id = ${sqlLiteral(USER_ID)}
      AND board_axis_items.table_id = ${sqlLiteral(TABLE_ID)}
      AND board_axis_items.axis = 'column'
      AND EXISTS (SELECT 1 FROM eligible)
      AND board_axis_items.id IN (SELECT id FROM ordered)
    RETURNING id`;
}

function characterProfileUpdateSql(payloadJson) {
  return `WITH input AS (
      SELECT json_extract(value, '$.id') AS id,
             json_extract(value, '$.className') AS class_name,
             json_extract(value, '$.itemLevel') AS item_level,
             json_extract(value, '$.combatPower') AS combat_power
      FROM json_each(${sqlLiteral(payloadJson)})
    ),
    valid_input AS (
      SELECT *
      FROM input
      WHERE typeof(id) = 'text'
        AND typeof(class_name) = 'text'
        AND typeof(item_level) = 'text'
        AND (combat_power IS NULL OR typeof(combat_power) = 'text')
    )
    UPDATE characters
    SET class_name = (SELECT class_name FROM valid_input WHERE valid_input.id = characters.id),
        item_level = (SELECT item_level FROM valid_input WHERE valid_input.id = characters.id),
        combat_power = (SELECT combat_power FROM valid_input WHERE valid_input.id = characters.id),
        source = 'lostark',
        updated_at = CURRENT_TIMESTAMP
    WHERE characters.user_id = ${sqlLiteral(USER_ID)}
      AND characters.enabled = 1
      AND characters.deleted_at IS NULL
      AND characters.source <> 'manual'
      AND characters.id IN (SELECT id FROM valid_input)
      AND (SELECT COUNT(*) FROM valid_input) = json_array_length(${sqlLiteral(payloadJson)})
      AND (SELECT COUNT(DISTINCT id) FROM valid_input) = json_array_length(${sqlLiteral(payloadJson)})
    RETURNING id`;
}

function characterExactSetGuardSql(payloadJson) {
  return `INSERT INTO characters (
      id, user_id, name, server_name, class_name, item_level, combat_power,
      sort_order, enabled, deleted_at, source, updated_at
    )
    SELECT '__riceark_character_refresh_exact_set_guard__',
           ${sqlLiteral(USER_ID)},
           '__riceark_character_refresh_exact_set_guard__',
           '__riceark_character_refresh_exact_set_guard__',
           '__riceark_character_refresh_exact_set_guard__',
           '0',
           NULL,
           0,
           1,
           NULL,
           json_extract('[]', ${sqlLiteral(CHARACTER_REFRESH_GUARD_PATH)}),
           CURRENT_TIMESTAMP
    WHERE changes() <> json_array_length(${sqlLiteral(payloadJson)})
       OR (SELECT COUNT(*) FROM json_each(${sqlLiteral(payloadJson)})) <> json_array_length(${sqlLiteral(payloadJson)})
       OR (
         SELECT COUNT(DISTINCT json_extract(value, '$.id'))
         FROM json_each(${sqlLiteral(payloadJson)})
       ) <> json_array_length(${sqlLiteral(payloadJson)})
    RETURNING id`;
}

function characterCooldownClaimSql(requestedIdsJson, attemptAt, cutoffAt) {
  return `WITH input AS (
      SELECT value AS id
      FROM json_each(${sqlLiteral(requestedIdsJson)})
      WHERE typeof(value) = 'text'
    )
    UPDATE characters
    SET last_refresh_attempt_at = ${sqlLiteral(attemptAt)}
    WHERE user_id = ${sqlLiteral(USER_ID)}
      AND enabled = 1
      AND deleted_at IS NULL
      AND source <> 'manual'
      AND id IN (SELECT id FROM input)
      AND (
        last_refresh_attempt_at IS NULL
        OR julianday(last_refresh_attempt_at) IS NULL
        OR julianday(last_refresh_attempt_at) <= julianday(${sqlLiteral(cutoffAt)})
      )
      AND (SELECT COUNT(DISTINCT id) FROM input) = json_array_length(${sqlLiteral(requestedIdsJson)})
    RETURNING id`;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function jsonDocuments(value) {
  const documents = [];
  for (let start = 0; start < value.length; start += 1) {
    const opening = value[start];
    if (opening !== "[" && opening !== "{") continue;

    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "[" || character === "{") {
        stack.push(character);
      } else if (character === "]" || character === "}") {
        const expected = character === "]" ? "[" : "{";
        if (stack.pop() !== expected) break;
        if (stack.length === 0) {
          try {
            documents.push(JSON.parse(value.slice(start, index + 1)));
            start = index;
          } catch {
            // Wrangler may print informational text containing brackets before its JSON payload.
          }
          break;
        }
      }
    }
  }
  return documents;
}

function isD1ResultPayload(value) {
  return Array.isArray(value) && value.every((entry) => (
    entry !== null && typeof entry === "object" && "success" in entry
  ));
}

function commandDiagnostics(result) {
  const stdout = stripAnsi(result.stdout).trim();
  const stderr = stripAnsi(result.stderr).trim();
  return [
    `exit: ${result.code ?? `signal ${result.signal ?? "unknown"}`}`,
    `stdout:\n${stdout || "<empty>"}`,
    `stderr:\n${stderr || "<empty>"}`
  ].join("\n");
}

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false"
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new Error(`Unable to start Wrangler: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function applyMigrations(stateDirectory) {
  const result = await runWrangler([
    "d1",
    "migrations",
    "apply",
    DATABASE_NAME,
    "--local",
    "--persist-to",
    stateDirectory
  ]);
  if (result.code !== 0) {
    throw new Error(`Applying production migrations failed.\n${commandDiagnostics(result)}`);
  }
}

async function executeSql(stateDirectory, sql, label) {
  const result = await runWrangler([
    "d1",
    "execute",
    DATABASE_NAME,
    "--local",
    "--persist-to",
    stateDirectory,
    "--command",
    sql,
    "--json",
    "--yes"
  ]);
  if (result.code !== 0) {
    throw new Error(`${label} failed.\n${commandDiagnostics(result)}`);
  }
  const payload = jsonDocuments(stripAnsi(result.stdout)).findLast(isD1ResultPayload);
  if (!payload) {
    throw new Error(`${label} did not produce a Wrangler D1 JSON result.\n${commandDiagnostics(result)}`);
  }
  for (const [index, entry] of payload.entries()) {
    assert.equal(entry.success, true, `${label} statement ${index + 1} reported success=false`);
    assert.ok(Array.isArray(entry.results), `${label} statement ${index + 1} omitted its results array`);
  }
  return payload;
}

async function expectSqlFailure(stateDirectory, sql, label, expectedFragments) {
  const result = await runWrangler([
    "d1",
    "execute",
    DATABASE_NAME,
    "--local",
    "--persist-to",
    stateDirectory,
    "--command",
    sql,
    "--json",
    "--yes"
  ]);
  assert.notEqual(result.code, 0, `${label} unexpectedly succeeded`);
  const diagnostics = stripAnsi(`${result.stdout}\n${result.stderr}`);
  for (const fragment of expectedFragments) {
    assert.ok(
      diagnostics.includes(fragment),
      `${label} failed without diagnostic fragment ${JSON.stringify(fragment)}.\n${commandDiagnostics(result)}`
    );
  }
}

function rowsAt(results, index, label) {
  assert.ok(results[index], `${label} did not return statement ${index + 1}`);
  return results[index].results;
}

function sortedCellRows(rows) {
  return rows.map((row) => ({
    tableId: row.tableId,
    rowItemId: row.rowItemId,
    columnItemId: row.columnItemId
  })).sort((left, right) => (
    `${left.rowItemId}/${left.columnItemId}`.localeCompare(`${right.rowItemId}/${right.columnItemId}`)
  ));
}

async function verifyBoardBulkSql(stateDirectory) {
  await applyMigrations(stateDirectory);

  const expectedMigrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const seedResults = await executeSql(
    stateDirectory,
    sqlBatch(
      "SELECT name FROM d1_migrations ORDER BY id",
      `INSERT INTO users (id, display_name) VALUES (${sqlLiteral(USER_ID)}, 'Verifier')`,
      `INSERT INTO characters (
         id, user_id, name, server_name, class_name, item_level, sort_order, enabled, source
       ) VALUES (
         ${sqlLiteral(CHARACTER_ID)}, ${sqlLiteral(USER_ID)}, 'VerifierCharacter', 'VerifierServer',
         'OriginalClass', '1600.00', 0, 1, 'lostark'
       )`,
      `INSERT INTO sheets (id, user_id, name, sort_order, is_default)
       VALUES (${sqlLiteral(SHEET_ID)}, ${sqlLiteral(USER_ID)}, 'Fixture', 0, 1)`,
      `INSERT INTO board_tables (
         id, user_id, sheet_id, name, sort_order, row_role, column_role, task_axis
       ) VALUES (
         ${sqlLiteral(TABLE_ID)}, ${sqlLiteral(USER_ID)}, ${sqlLiteral(SHEET_ID)},
         'Verifier table', 0, 'custom', 'custom', 'none'
       )`,
      `INSERT INTO board_axis_items (
         id, user_id, table_id, axis, kind, label, character_id, sort_order, visible
       ) VALUES
         ('row-1', ${sqlLiteral(USER_ID)}, ${sqlLiteral(TABLE_ID)}, 'row', 'character', 'Character', ${sqlLiteral(CHARACTER_ID)}, 0, 1),
         ('row-2', ${sqlLiteral(USER_ID)}, ${sqlLiteral(TABLE_ID)}, 'row', 'custom', 'Custom row', NULL, 10, 1),
         ('column-1', ${sqlLiteral(USER_ID)}, ${sqlLiteral(TABLE_ID)}, 'column', 'custom', 'Column one', NULL, 0, 1),
         ('column-2', ${sqlLiteral(USER_ID)}, ${sqlLiteral(TABLE_ID)}, 'column', 'custom', 'Column two', NULL, 10, 1)`,
      `INSERT INTO board_cell_states (
         id, user_id, table_id, row_item_id, column_item_id, checkbox_visible,
         mark_type, mark_icon, memo, mark_period_key
       ) VALUES (
         'stale-state', ${sqlLiteral(USER_ID)}, ${sqlLiteral(TABLE_ID)}, 'row-1', 'column-1',
         0, 'disabled', NULL, NULL, NULL
       )`,
      `SELECT
         (SELECT COUNT(*) FROM board_cell_states) AS cells,
         (SELECT COUNT(*) FROM board_cell_completions) AS completions,
         (SELECT content_version FROM sheets WHERE id = ${sqlLiteral(SHEET_ID)}) AS version`
    ),
    "Migration verification and fixture seed"
  );
  assert.equal(seedResults.length, 8, "Fixture seed returned an unexpected statement count");
  assert.deepEqual(
    rowsAt(seedResults, 0, "Migration verification").map((row) => row.name),
    expectedMigrations,
    "Wrangler did not apply every production migration in filename order"
  );
  assert.deepEqual(rowsAt(seedResults, 7, "Fixture baseline"), [{ cells: 1, completions: 0, version: 0 }]);

  const completionRows = [
    {
      id: "completion-1",
      table_id: TABLE_ID,
      row_item_id: "row-1",
      column_item_id: "column-2",
      period_key: "weekly:2030-01-01",
      completed: 1,
      sheet_id: SHEET_ID,
      row_kind: "character",
      column_kind: "custom",
      row_task_reset_rule_json: null,
      column_task_reset_rule_json: null,
      guard_expires_at: null
    },
    {
      id: "completion-2",
      table_id: TABLE_ID,
      row_item_id: "row-2",
      column_item_id: "column-1",
      period_key: "weekly:2030-01-01",
      completed: 1,
      sheet_id: SHEET_ID,
      row_kind: "custom",
      column_kind: "custom",
      row_task_reset_rule_json: null,
      column_task_reset_rule_json: null,
      guard_expires_at: null
    }
  ];
  const completionPayload = JSON.stringify(completionRows);
  const rejectedCompletionPayload = JSON.stringify([
    completionRows[0],
    { ...completionRows[1], id: "completion-rejected", row_kind: "task" }
  ]);

  await expectSqlFailure(
    stateDirectory,
    sqlBatch(
      `UPDATE sheets SET name = 'board-guard-rollback-marker' WHERE id = ${sqlLiteral(SHEET_ID)} RETURNING id`,
      boardCompletionUpsertSql(rejectedCompletionPayload),
      boardGuardAssertionSql(rejectedCompletionPayload)
    ),
    "Board guard rollback batch",
    ["NOT NULL constraint failed", "board_cell_completions.user_id"]
  );

  const statePayload = JSON.stringify([
    {
      id: "state-delete",
      table_id: TABLE_ID,
      row_item_id: "row-1",
      column_item_id: "column-1",
      checkbox_visible: 1,
      mark_type: "default",
      mark_icon: null,
      memo: null,
      mark_period_key: null,
      delete_state: 1,
      sheet_id: SHEET_ID,
      row_kind: "character",
      column_kind: "custom",
      row_task_reset_rule_json: null,
      column_task_reset_rule_json: null,
      guard_expires_at: null
    },
    {
      id: "state-fixed",
      table_id: TABLE_ID,
      row_item_id: "row-1",
      column_item_id: "column-2",
      checkbox_visible: 1,
      mark_type: "fixed",
      mark_icon: "pin",
      memo: "kept",
      mark_period_key: null,
      delete_state: 0,
      sheet_id: SHEET_ID,
      row_kind: "character",
      column_kind: "custom",
      row_task_reset_rule_json: null,
      column_task_reset_rule_json: null,
      guard_expires_at: null
    },
    {
      id: "state-reserved",
      table_id: TABLE_ID,
      row_item_id: "row-2",
      column_item_id: "column-1",
      checkbox_visible: 1,
      mark_type: "reserved",
      mark_icon: "clock",
      memo: "later",
      mark_period_key: "weekly:2030-01-01",
      delete_state: 0,
      sheet_id: SHEET_ID,
      row_kind: "custom",
      column_kind: "custom",
      row_task_reset_rule_json: null,
      column_task_reset_rule_json: null,
      guard_expires_at: null
    }
  ]);
  const orderedColumns = JSON.stringify(["column-2", "column-1"]);
  const profilePayload = JSON.stringify([{
    id: CHARACTER_ID,
    className: "Bard",
    itemLevel: "1700.00",
    combatPower: "9000"
  }]);

  const mainResults = await executeSql(
    stateDirectory,
    sqlBatch(
      `SELECT name, content_version AS version,
              (SELECT COUNT(*) FROM board_cell_states) AS cells,
              (SELECT COUNT(*) FROM board_cell_completions) AS completions
       FROM sheets WHERE id = ${sqlLiteral(SHEET_ID)}`,
      boardCellStateDeleteSql(statePayload),
      boardCellStateUpsertSql(statePayload),
      boardGuardAssertionSql(statePayload),
      boardOrderUpdateSql(orderedColumns, true),
      boardOrderUpdateSql(orderedColumns, false),
      `UPDATE board_tables
       SET x = 12, y = 34, updated_at = CURRENT_TIMESTAMP
       WHERE id = ${sqlLiteral(TABLE_ID)} AND user_id = ${sqlLiteral(USER_ID)} AND locked = 0
       RETURNING id`,
      boardCompletionUpsertSql(completionPayload),
      boardGuardAssertionSql(completionPayload),
      boardVersionUpdateSql(completionPayload),
      characterProfileUpdateSql(profilePayload),
      characterExactSetGuardSql(profilePayload)
    ),
    "Representative production-shaped SQL batch"
  );
  assert.equal(mainResults.length, 12, "Representative SQL batch returned an unexpected statement count");
  assert.deepEqual(rowsAt(mainResults, 0, "Board rollback verification"), [
    { name: "Fixture", version: 0, cells: 1, completions: 0 }
  ]);
  assert.deepEqual(rowsAt(mainResults, 1, "Cell-state delete"), [
    { tableId: TABLE_ID, rowItemId: "row-1", columnItemId: "column-1" }
  ]);
  assert.deepEqual(sortedCellRows(rowsAt(mainResults, 2, "Cell-state upsert")), [
    { tableId: TABLE_ID, rowItemId: "row-1", columnItemId: "column-2" },
    { tableId: TABLE_ID, rowItemId: "row-2", columnItemId: "column-1" }
  ]);
  assert.deepEqual(rowsAt(mainResults, 3, "Cell-state guard"), []);
  assert.deepEqual(new Set(rowsAt(mainResults, 4, "Temporary ordering update").map((row) => row.id)), new Set(["column-1", "column-2"]));
  assert.deepEqual(new Set(rowsAt(mainResults, 5, "Final ordering update").map((row) => row.id)), new Set(["column-1", "column-2"]));
  assert.deepEqual(rowsAt(mainResults, 6, "UPDATE RETURNING"), [{ id: TABLE_ID }]);
  assert.equal(rowsAt(mainResults, 7, "Completion upsert").length, 2, "Completion upsert did not accept exactly two cells");
  assert.deepEqual(sortedCellRows(rowsAt(mainResults, 7, "Completion upsert")), [
    { tableId: TABLE_ID, rowItemId: "row-1", columnItemId: "column-2" },
    { tableId: TABLE_ID, rowItemId: "row-2", columnItemId: "column-1" }
  ]);
  assert.deepEqual(rowsAt(mainResults, 8, "Completion guard"), []);
  assert.deepEqual(rowsAt(mainResults, 9, "Sheet version increment"), [{ id: SHEET_ID, version: 1 }]);
  assert.deepEqual(rowsAt(mainResults, 10, "Character exact-set update"), [{ id: CHARACTER_ID }]);
  assert.deepEqual(rowsAt(mainResults, 11, "Character exact-set guard"), []);

  const duplicateProfilePayload = JSON.stringify([
    { id: CHARACTER_ID, className: "InvalidOne", itemLevel: "1", combatPower: null },
    { id: CHARACTER_ID, className: "InvalidTwo", itemLevel: "2", combatPower: null }
  ]);
  await expectSqlFailure(
    stateDirectory,
    sqlBatch(
      `UPDATE sheets SET name = 'exact-set-rollback-marker' WHERE id = ${sqlLiteral(SHEET_ID)} RETURNING id`,
      characterProfileUpdateSql(duplicateProfilePayload),
      characterExactSetGuardSql(duplicateProfilePayload)
    ),
    "Character changes exact-set guard batch",
    ["bad JSON path", CHARACTER_REFRESH_GUARD_PATH]
  );

  const claimIds = JSON.stringify([CHARACTER_ID]);
  const attemptAt = "2030-01-01T00:00:00.000Z";
  const cutoffAt = "2029-12-31T23:59:00.000Z";
  const finalResults = await executeSql(
    stateDirectory,
    sqlBatch(
      `SELECT sheets.name AS sheet_name,
              characters.class_name,
              characters.item_level,
              characters.combat_power
       FROM sheets
       JOIN characters ON characters.id = ${sqlLiteral(CHARACTER_ID)}
       WHERE sheets.id = ${sqlLiteral(SHEET_ID)}`,
      characterCooldownClaimSql(claimIds, attemptAt, cutoffAt),
      characterCooldownClaimSql(claimIds, attemptAt, cutoffAt),
      `SELECT
         (SELECT COUNT(*) FROM board_cell_states) AS cells,
         (SELECT COUNT(*) FROM board_cell_completions WHERE completed = 1) AS completed,
         (SELECT content_version FROM sheets WHERE id = ${sqlLiteral(SHEET_ID)}) AS version,
         (SELECT name FROM sheets WHERE id = ${sqlLiteral(SHEET_ID)}) AS sheet_name,
         (SELECT x FROM board_tables WHERE id = ${sqlLiteral(TABLE_ID)}) AS table_x,
         (SELECT y FROM board_tables WHERE id = ${sqlLiteral(TABLE_ID)}) AS table_y,
         (SELECT group_concat(id || ':' || sort_order, ',')
          FROM (
            SELECT id, sort_order
            FROM board_axis_items
            WHERE table_id = ${sqlLiteral(TABLE_ID)} AND axis = 'column'
            ORDER BY sort_order
          )) AS column_order,
         (SELECT COUNT(*)
          FROM board_cell_states
          WHERE (row_item_id = 'row-1' AND column_item_id = 'column-2'
                 AND mark_type = 'fixed' AND mark_icon = 'pin' AND memo = 'kept'
                 AND mark_period_key IS NULL AND checkbox_visible = 1)
             OR (row_item_id = 'row-2' AND column_item_id = 'column-1'
                 AND mark_type = 'reserved' AND mark_icon = 'clock' AND memo = 'later'
                 AND mark_period_key = 'weekly:2030-01-01' AND checkbox_visible = 1)) AS expected_cells,
         (SELECT COUNT(*)
          FROM board_cell_completions
          WHERE period_key = 'weekly:2030-01-01' AND completed = 1
            AND ((row_item_id = 'row-1' AND column_item_id = 'column-2')
              OR (row_item_id = 'row-2' AND column_item_id = 'column-1'))) AS expected_completions,
         (SELECT last_refresh_attempt_at FROM characters WHERE id = ${sqlLiteral(CHARACTER_ID)}) AS claimed_at`
    ),
    "Rollback, cooldown CAS, and final-state verification"
  );
  assert.equal(finalResults.length, 4, "Final verification returned an unexpected statement count");
  assert.deepEqual(rowsAt(finalResults, 0, "Exact-set rollback verification"), [{
    sheet_name: "Fixture",
    class_name: "Bard",
    item_level: "1700.00",
    combat_power: "9000"
  }]);
  const claimCounts = [
    rowsAt(finalResults, 1, "First cooldown claim").length,
    rowsAt(finalResults, 2, "Second cooldown claim").length
  ];
  assert.deepEqual(claimCounts, [1, 0], "Character cooldown compare-and-swap claims were not [1,0]");

  const [summary] = rowsAt(finalResults, 3, "Final state");
  assert.deepEqual(summary, {
    cells: 2,
    completed: 2,
    version: 1,
    sheet_name: "Fixture",
    table_x: 12,
    table_y: 34,
    column_order: "column-2:0,column-1:10",
    expected_cells: 2,
    expected_completions: 2,
    claimed_at: attemptAt
  });
  return { cells: summary.cells, completed: summary.completed, version: summary.version };
}

function formatError(error) {
  if (error instanceof AggregateError) {
    return `${error.message}\n${error.errors.map((entry) => formatError(entry)).join("\n")}`;
  }
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

let stateDirectory;
let summary;
let verificationError;
try {
  stateDirectory = await mkdtemp(join(tmpdir(), "riceark-d1-sql-"));
  summary = await verifyBoardBulkSql(stateDirectory);
} catch (error) {
  verificationError = error;
} finally {
  if (stateDirectory) {
    try {
      await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      verificationError = verificationError
        ? new AggregateError([verificationError, error], "Verification and temporary-state cleanup both failed")
        : new Error(`Unable to remove temporary Wrangler state at ${stateDirectory}`, { cause: error });
    }
  }
}

if (verificationError) {
  console.error(`board bulk SQL verification failed:\n${formatError(verificationError)}`);
  process.exitCode = 1;
} else {
  assert.deepEqual(summary, { cells: 2, completed: 2, version: 1 });
  console.log(SUCCESS_LINE);
}
