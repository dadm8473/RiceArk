import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DATABASE_BINDING = "DB";
const USER_ID = "board-read-measure-user";
const SESSION_TOKEN_HASH = "board-read-measure-token-hash";
const ACTIVE_SHEET_ID = "sheet-1";
const PERIOD_KEYS_JSON = JSON.stringify(["weekly:2030-01-01"]);
const WORKER_HOST = "127.0.0.1";
const WORKER_READY_TIMEOUT_MS = 20_000;
const WORKER_REQUEST_TIMEOUT_MS = 10_000;
const WORKER_STOP_TIMEOUT_MS = 5_000;

// Each 20x12 table keeps cell-state rows dense enough to stress payloads while
// current-period completions stay sparse, matching persisted user interaction.
const FIXTURE = Object.freeze({
  sheetCount: 3,
  tablesPerSheet: 3,
  notesPerSheet: 4,
  rowsPerTable: 20,
  columnsPerTable: 12,
  cellStatesPerTable: 180,
  completionsPerTable: 48
});

const BUDGETS = Object.freeze({
  establishedBootstrapQueriesIncludingAuth: 10,
  noChangeVersionSqlStatements: 1,
  activeRowsReadReductionPercent: 40
});

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = dirname(scriptDirectory);
const wranglerConfigPath = join(apiDirectory, "wrangler.jsonc");
const boardReadsPath = join(apiDirectory, "src", "db", "boardReads.ts");
const legacyBoardPath = join(apiDirectory, "src", "db", "board.ts");
const sessionsPath = join(apiDirectory, "src", "auth", "sessions.ts");
const require = createRequire(import.meta.url);
const wranglerBin = require.resolve("wrangler/bin/wrangler.js");

const AUTH_EQUIVALENT_SQL = `SELECT users.id, users.display_name, users.avatar_url
     FROM sessions
     INNER JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
     LIMIT 1`;

// Mirrors BOARD_MANIFEST_SQL and loadBoardSheetAttempt in boardReads.ts.
const BOARD_MANIFEST_SQL = `WITH manifest AS (
  SELECT COALESCE(
    (SELECT version FROM board_manifest_versions WHERE user_id = ?1),
    0
  ) AS manifest_version
)
SELECT
  manifest.manifest_version,
  COALESCE(user_settings.show_display_name, 1) AS show_display_name,
  COALESCE(user_settings.show_server_name, 0) AS show_server_name,
  COALESCE(user_settings.show_class_name, 0) AS show_class_name,
  COALESCE(user_settings.show_item_level, 1) AS show_item_level,
  COALESCE(user_settings.show_combat_power, 0) AS show_combat_power,
  sheets.id,
  sheets.name,
  sheets.sort_order,
  sheets.is_default,
  sheets.content_version AS version
FROM manifest
LEFT JOIN user_settings ON user_settings.user_id = ?1
LEFT JOIN sheets ON sheets.user_id = ?1
ORDER BY sheets.sort_order, sheets.name`;

const ACTIVE_SHEET_METADATA_SQL = `SELECT id, name, sort_order, is_default, content_version
     FROM sheets
     WHERE id = ? AND user_id = ?`;

const ACTIVE_TABLES_SQL = `SELECT board_tables.id,
              board_tables.sheet_id,
              board_tables.name,
              board_tables.sort_order,
              board_tables.x,
              board_tables.y,
              board_tables.width,
              board_tables.height,
              board_tables.row_role,
              board_tables.column_role,
              board_tables.task_axis,
              board_tables.default_row_height,
              board_tables.default_column_width,
              board_tables.locked,
              board_tables.display_options_json,
              board_tables.event_options_json,
              board_tables.template_type
       FROM board_tables
       JOIN sheets
         ON sheets.id = board_tables.sheet_id
        AND sheets.user_id = ?1
       WHERE board_tables.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_tables.sort_order, board_tables.name`;

const ACTIVE_NOTES_SQL = `SELECT board_notes.id,
              board_notes.sheet_id,
              board_notes.title,
              board_notes.body,
              board_notes.color,
              board_notes.sort_order,
              board_notes.x,
              board_notes.y,
              board_notes.width,
              board_notes.height,
              board_notes.locked
       FROM board_notes
       JOIN sheets
         ON sheets.id = board_notes.sheet_id
        AND sheets.user_id = ?1
       WHERE board_notes.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_notes.sort_order, board_notes.title`;

const ACTIVE_AXIS_ITEMS_SQL = `SELECT board_axis_items.id,
              board_axis_items.table_id,
              board_axis_items.axis,
              board_axis_items.kind,
              board_axis_items.label,
              board_axis_items.character_id,
              board_axis_items.task_id,
              board_axis_items.task_scope,
              board_axis_items.task_reset_type,
              board_axis_items.task_reset_rule_json,
              board_axis_items.task_color,
              board_axis_items.size_px,
              board_axis_items.cross_size_px,
              board_axis_items.sort_order,
              board_axis_items.visible,
              board_axis_items.separator_json,
              board_axis_items.display_options_json,
              characters.name AS character_name,
              characters.display_name AS character_display_name,
              characters.server_name AS character_server_name,
              characters.class_name AS character_class_name,
              characters.item_level AS character_item_level,
              characters.combat_power AS character_combat_power,
              characters.source AS character_source
       FROM board_axis_items
       JOIN board_tables
         ON board_tables.id = board_axis_items.table_id
        AND board_tables.user_id = ?1
       JOIN sheets
         ON sheets.id = board_tables.sheet_id
        AND sheets.user_id = ?1
       LEFT JOIN characters
         ON characters.id = board_axis_items.character_id
        AND characters.user_id = board_axis_items.user_id
        AND characters.deleted_at IS NULL
       WHERE board_axis_items.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_axis_items.table_id,
                board_axis_items.axis,
                board_axis_items.sort_order,
                board_axis_items.label`;

const ACTIVE_CELL_STATES_SQL = `SELECT board_cell_states.table_id,
              board_cell_states.row_item_id,
              board_cell_states.column_item_id,
              board_cell_states.checkbox_visible,
              board_cell_states.mark_type,
              board_cell_states.mark_icon,
              board_cell_states.memo,
              board_cell_states.mark_period_key
       FROM board_cell_states
       JOIN board_tables
         ON board_tables.id = board_cell_states.table_id
        AND board_tables.user_id = ?1
       JOIN sheets
         ON sheets.id = board_tables.sheet_id
        AND sheets.user_id = ?1
       WHERE board_cell_states.user_id = ?1
         AND sheets.id = ?2
       ORDER BY board_cell_states.table_id,
                board_cell_states.row_item_id,
                board_cell_states.column_item_id`;

const ACTIVE_COMPLETIONS_SQL = `SELECT board_cell_completions.table_id,
                  board_cell_completions.row_item_id,
                  board_cell_completions.column_item_id,
                  board_cell_completions.period_key,
                  board_cell_completions.completed
           FROM board_cell_completions
           JOIN board_tables
             ON board_tables.id = board_cell_completions.table_id
            AND board_tables.user_id = ?1
           JOIN sheets
             ON sheets.id = board_tables.sheet_id
            AND sheets.user_id = ?1
           WHERE board_cell_completions.user_id = ?1
             AND sheets.id = ?2
             AND board_cell_completions.period_key IN (SELECT value FROM json_each(?3))
           ORDER BY board_cell_completions.table_id,
                    board_cell_completions.row_item_id,
                    board_cell_completions.column_item_id,
                    board_cell_completions.period_key`;

// Mirrors the compatible full-board reads in board.ts loadBoard.
const LEGACY_SHEETS_SQL = "SELECT * FROM sheets WHERE user_id = ? ORDER BY sort_order, name";
const LEGACY_TABLES_SQL = "SELECT * FROM board_tables WHERE user_id = ? ORDER BY sort_order, name";
const LEGACY_NOTES_SQL = "SELECT * FROM board_notes WHERE user_id = ? ORDER BY sort_order, title";
const LEGACY_AXIS_ITEMS_SQL = `SELECT board_axis_items.*,
              characters.name AS character_name,
              characters.display_name AS character_display_name,
              characters.server_name AS character_server_name,
              characters.class_name AS character_class_name,
              characters.item_level AS character_item_level,
              characters.combat_power AS character_combat_power,
              characters.source AS character_source
       FROM board_axis_items
       LEFT JOIN characters
         ON characters.id = board_axis_items.character_id
        AND characters.user_id = board_axis_items.user_id
        AND characters.deleted_at IS NULL
       WHERE board_axis_items.user_id = ?
       ORDER BY board_axis_items.table_id, board_axis_items.axis, board_axis_items.sort_order, board_axis_items.label`;
const LEGACY_CELL_STATES_SQL =
  "SELECT * FROM board_cell_states WHERE user_id = ? ORDER BY table_id, row_item_id, column_item_id";
const LEGACY_SETTINGS_SQL = `SELECT show_display_name,
              show_server_name,
              show_class_name,
              show_item_level,
              show_combat_power
       FROM user_settings
       WHERE user_id = ?`;
const LEGACY_COMPLETIONS_SQL = `SELECT table_id, row_item_id, column_item_id, period_key, completed
           FROM board_cell_completions
           WHERE user_id = ?1
             AND period_key IN (SELECT value FROM json_each(?2))`;

// Mirrors board.ts loadBoardVersionSummary.
const VERSION_SUMMARY_SQL = `WITH manifest AS (
       SELECT COALESCE(
         (SELECT version FROM board_manifest_versions WHERE user_id = ?1),
         0
       ) AS manifest_version
     )
     SELECT manifest.manifest_version,
            COALESCE(user_settings.show_display_name, 1) AS show_display_name,
            COALESCE(user_settings.show_server_name, 0) AS show_server_name,
            COALESCE(user_settings.show_class_name, 0) AS show_class_name,
            COALESCE(user_settings.show_item_level, 1) AS show_item_level,
            COALESCE(user_settings.show_combat_power, 0) AS show_combat_power,
            sheets.id,
            sheets.name,
            sheets.sort_order,
            sheets.is_default,
            sheets.content_version AS version
     FROM manifest
     LEFT JOIN user_settings ON user_settings.user_id = ?1
     LEFT JOIN sheets ON sheets.user_id = ?1
     ORDER BY sheets.sort_order, sheets.name`;

const WORKER_SOURCE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method !== "POST" || url.pathname !== "/execute") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const body = await request.json();
      if (typeof body.sql !== "string" || !Array.isArray(body.bindings)) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const prepared = env.DB.prepare(body.sql);
      const statement = body.bindings.length > 0 ? prepared.bind(...body.bindings) : prepared;
      return Response.json(await statement.all());
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
};
`;

function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlBatch(...statements) {
  return `${statements.join(";\n")};`;
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

function commandDiagnostics(result) {
  return [
    `exit: ${result.code ?? `signal ${result.signal ?? "unknown"}`}`,
    `stdout:\n${stripAnsi(result.stdout).trim() || "<empty>"}`,
    `stderr:\n${stripAnsi(result.stderr).trim() || "<empty>"}`
  ].join("\n");
}

function childDiagnostics(childState) {
  return [
    `exit: ${childState.code ?? `signal ${childState.signal ?? "running"}`}`,
    `stdout:\n${stripAnsi(childState.stdout).trim() || "<empty>"}`,
    `stderr:\n${stripAnsi(childState.stderr).trim() || "<empty>"}`
  ].join("\n");
}

function spawnCaptured(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      WRANGLER_SEND_METRICS: "false",
      ...options.env
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const state = { stdout: "", stderr: "", code: null, signal: null, error: null };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  child.once("error", (error) => {
    state.error = error;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      state.code = code;
      state.signal = signal;
      resolve();
    });
  });
  return { child, state, closed };
}

async function runWrangler(args) {
  const processState = spawnCaptured(process.execPath, [wranglerBin, ...args], { cwd: apiDirectory });
  await processState.closed;
  if (processState.state.error) {
    throw new Error(`Unable to start Wrangler: ${processState.state.error.message}`, {
      cause: processState.state.error
    });
  }
  return processState.state;
}

async function readLocalD1Config() {
  let config;
  try {
    config = JSON.parse(await readFile(wranglerConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse ${wranglerConfigPath} as JSON-compatible JSONC`, { cause: error });
  }
  const database = config.d1_databases?.find((entry) => entry.binding === DATABASE_BINDING);
  assert.ok(database, `Wrangler config has no ${DATABASE_BINDING} D1 binding`);
  assert.equal(typeof database.database_name, "string", `${DATABASE_BINDING} database_name is missing`);
  assert.equal(typeof database.database_id, "string", `${DATABASE_BINDING} database_id is missing`);
  assert.equal(typeof config.compatibility_date, "string", "Wrangler compatibility_date is missing");
  return {
    databaseName: database.database_name,
    databaseId: database.database_id,
    compatibilityDate: config.compatibility_date
  };
}

async function applyMigrations(stateDirectory, databaseName) {
  const result = await runWrangler([
    "d1",
    "migrations",
    "apply",
    databaseName,
    "--local",
    "--persist-to",
    stateDirectory,
    "--config",
    wranglerConfigPath
  ]);
  if (result.code !== 0) {
    throw new Error(`Applying production migrations failed.\n${commandDiagnostics(result)}`);
  }
}

async function seedFixture(temporaryDirectory, stateDirectory, databaseName) {
  const sqlFile = join(temporaryDirectory, "fixture.sql");
  await writeFile(sqlFile, fixtureSql(), "utf8");
  const result = await runWrangler([
    "d1",
    "execute",
    databaseName,
    "--local",
    "--persist-to",
    stateDirectory,
    "--config",
    wranglerConfigPath,
    "--file",
    sqlFile,
    "--json",
    "--yes"
  ]);
  if (result.code !== 0) {
    throw new Error(`Seeding the deterministic fixture failed.\n${commandDiagnostics(result)}`);
  }
  const payload = jsonDocuments(stripAnsi(result.stdout)).findLast((value) => (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => entry !== null && typeof entry === "object" && "success" in entry)
  ));
  assert.ok(payload, `Fixture seed did not produce Wrangler JSON.\n${commandDiagnostics(result)}`);
  for (const [index, entry] of payload.entries()) {
    assert.equal(entry.success, true, `Fixture seed statement ${index + 1} reported success=false`);
  }
}

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, WORKER_HOST, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Unable to reserve a local worker port");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function terminateChild(processState) {
  if (processState.state.error) {
    await Promise.race([processState.closed, delay(WORKER_STOP_TIMEOUT_MS)]);
    return;
  }
  if (processState.state.code !== null || processState.state.signal !== null) {
    await processState.closed;
    return;
  }
  processState.child.kill("SIGTERM");
  await Promise.race([processState.closed, delay(WORKER_STOP_TIMEOUT_MS)]);
  if (processState.state.code === null && processState.state.signal === null) {
    processState.child.kill("SIGKILL");
    await Promise.race([processState.closed, delay(WORKER_STOP_TIMEOUT_MS)]);
  }
  assert.ok(
    processState.state.code !== null || processState.state.signal !== null,
    `Wrangler dev did not terminate within ${WORKER_STOP_TIMEOUT_MS * 2}ms`
  );
}

async function startMeasurementWorker(temporaryDirectory, stateDirectory, d1Config) {
  const workerPath = join(temporaryDirectory, "measurement-worker.mjs");
  const workerConfigPath = join(temporaryDirectory, "measurement-wrangler.json");
  const port = await reserveFreePort();
  await writeFile(workerPath, WORKER_SOURCE, "utf8");
  await writeFile(
    workerConfigPath,
    `${JSON.stringify({
      name: "riceark-board-read-measurement",
      main: "measurement-worker.mjs",
      compatibility_date: d1Config.compatibilityDate,
      d1_databases: [{
        binding: DATABASE_BINDING,
        database_name: d1Config.databaseName,
        database_id: d1Config.databaseId
      }]
    }, null, 2)}\n`,
    "utf8"
  );

  const processState = spawnCaptured(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "--config",
      workerConfigPath,
      "--local",
      "--persist-to",
      stateDirectory,
      "--ip",
      WORKER_HOST,
      "--port",
      String(port)
    ],
    { cwd: temporaryDirectory }
  );
  const baseUrl = `http://${WORKER_HOST}:${port}`;
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      if (processState.state.error) {
        throw new Error(`Unable to start Wrangler dev: ${processState.state.error.message}`, {
          cause: processState.state.error
        });
      }
      if (processState.state.code !== null || processState.state.signal !== null) {
        throw new Error(`Wrangler dev exited before readiness.\n${childDiagnostics(processState.state)}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(500)
        });
        if (response.ok && (await response.json()).ok === true) {
          return { ...processState, baseUrl };
        }
      } catch {
        // The local worker has not started accepting requests yet.
      }
      await delay(100);
    }
    throw new Error(
      `Wrangler dev did not become ready within ${WORKER_READY_TIMEOUT_MS}ms.\n${childDiagnostics(processState.state)}`
    );
  } catch (error) {
    await terminateChild(processState);
    throw error;
  }
}

async function executeWorkerSql(worker, statement) {
  let response;
  try {
    response = await fetch(`${worker.baseUrl}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: statement.sql, bindings: statement.bindings }),
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `${statement.label} did not receive a local worker response.\n${childDiagnostics(worker.state)}`,
      { cause: error }
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${statement.label} returned HTTP ${response.status}: ${body}`);
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch (error) {
    throw new Error(`${statement.label} returned invalid JSON: ${body}`, { cause: error });
  }
  assert.equal(result.success, true, `${statement.label} returned success=false`);
  assert.ok(Array.isArray(result.results), `${statement.label} omitted results`);
  assert.equal(
    typeof result.meta?.rows_read,
    "number",
    `${statement.label} omitted the required local D1 meta.rows_read`
  );
  assert.equal(
    result.meta?.rows_written,
    0,
    `${statement.label} unexpectedly wrote ${String(result.meta?.rows_written)} rows`
  );
  return result;
}

function statement(label, sql, bindings) {
  return { label, sql, bindings };
}

const ESTABLISHED_BOOTSTRAP_STATEMENTS = [
  statement("Established bootstrap auth-equivalent lookup", AUTH_EQUIVALENT_SQL, [SESSION_TOKEN_HASH]),
  statement("Established bootstrap manifest", BOARD_MANIFEST_SQL, [USER_ID]),
  statement("Established bootstrap active-sheet metadata", ACTIVE_SHEET_METADATA_SQL, [ACTIVE_SHEET_ID, USER_ID]),
  statement("Established bootstrap active-sheet tables", ACTIVE_TABLES_SQL, [USER_ID, ACTIVE_SHEET_ID]),
  statement("Established bootstrap active-sheet notes", ACTIVE_NOTES_SQL, [USER_ID, ACTIVE_SHEET_ID]),
  statement("Established bootstrap active-sheet axis items", ACTIVE_AXIS_ITEMS_SQL, [USER_ID, ACTIVE_SHEET_ID]),
  statement("Established bootstrap active-sheet cell states", ACTIVE_CELL_STATES_SQL, [USER_ID, ACTIVE_SHEET_ID]),
  statement("Established bootstrap active-sheet completions", ACTIVE_COMPLETIONS_SQL, [
    USER_ID,
    ACTIVE_SHEET_ID,
    PERIOD_KEYS_JSON
  ]),
  statement("Established bootstrap manifest fence", BOARD_MANIFEST_SQL, [USER_ID])
];

const LEGACY_FULL_BOARD_STATEMENTS = [
  statement("Legacy full-board auth-equivalent lookup", AUTH_EQUIVALENT_SQL, [SESSION_TOKEN_HASH]),
  statement("Legacy full-board sheets", LEGACY_SHEETS_SQL, [USER_ID]),
  statement("Legacy full-board tables", LEGACY_TABLES_SQL, [USER_ID]),
  statement("Legacy full-board notes", LEGACY_NOTES_SQL, [USER_ID]),
  statement("Legacy full-board axis items", LEGACY_AXIS_ITEMS_SQL, [USER_ID]),
  statement("Legacy full-board cell states", LEGACY_CELL_STATES_SQL, [USER_ID]),
  statement("Legacy full-board settings", LEGACY_SETTINGS_SQL, [USER_ID]),
  statement("Legacy full-board completions", LEGACY_COMPLETIONS_SQL, [USER_ID, PERIOD_KEYS_JSON])
];

const NO_CHANGE_VERSION_STATEMENTS = [
  statement("No-change version summary", VERSION_SUMMARY_SQL, [USER_ID])
];

async function measureStatements(worker, statements) {
  const measurements = [];
  for (const current of statements) {
    const result = await executeWorkerSql(worker, current);
    measurements.push({
      label: current.label,
      rowsRead: result.meta.rows_read,
      resultBytes: Buffer.byteLength(JSON.stringify(result.results), "utf8")
    });
  }
  return {
    queryCount: measurements.length,
    rowsRead: measurements.reduce((sum, entry) => sum + entry.rowsRead, 0),
    resultBytes: measurements.reduce((sum, entry) => sum + entry.resultBytes, 0),
    statements: measurements
  };
}

function percentReduction(baseline, reduced) {
  assert.ok(baseline > 0, "Cannot calculate reduction from a zero baseline");
  return ((baseline - reduced) / baseline) * 100;
}

function rounded(value) {
  return Number(value.toFixed(2));
}

async function assertSourceLinkedSql() {
  const [boardReadsSource, legacyBoardSource, sessionsSource] = await Promise.all([
    readFile(boardReadsPath, "utf8"),
    readFile(legacyBoardPath, "utf8"),
    readFile(sessionsPath, "utf8")
  ]);
  const sources = [
    [sessionsSource, AUTH_EQUIVALENT_SQL, "sessions.ts findUserBySessionToken"],
    [boardReadsSource, BOARD_MANIFEST_SQL, "boardReads.ts BOARD_MANIFEST_SQL"],
    [boardReadsSource, ACTIVE_SHEET_METADATA_SQL, "boardReads.ts loadOwnedBoardSheetMetadata"],
    [boardReadsSource, ACTIVE_TABLES_SQL, "boardReads.ts loadBoardSheetAttempt tables"],
    [boardReadsSource, ACTIVE_NOTES_SQL, "boardReads.ts loadBoardSheetAttempt notes"],
    [boardReadsSource, ACTIVE_AXIS_ITEMS_SQL, "boardReads.ts loadBoardSheetAttempt axis items"],
    [boardReadsSource, ACTIVE_CELL_STATES_SQL, "boardReads.ts loadBoardSheetAttempt cell states"],
    [boardReadsSource, ACTIVE_COMPLETIONS_SQL, "boardReads.ts loadBoardSheetAttempt completions"],
    [legacyBoardSource, LEGACY_SHEETS_SQL, "board.ts loadBoard sheets"],
    [legacyBoardSource, LEGACY_TABLES_SQL, "board.ts loadBoard tables"],
    [legacyBoardSource, LEGACY_NOTES_SQL, "board.ts loadBoard notes"],
    [legacyBoardSource, LEGACY_AXIS_ITEMS_SQL, "board.ts loadBoard axis items"],
    [legacyBoardSource, LEGACY_CELL_STATES_SQL, "board.ts loadBoard cell states"],
    [legacyBoardSource, LEGACY_SETTINGS_SQL, "board.ts loadBoard settings"],
    [legacyBoardSource, LEGACY_COMPLETIONS_SQL, "board.ts loadBoard completions"],
    [legacyBoardSource, VERSION_SUMMARY_SQL, "board.ts loadBoardVersionSummary"]
  ];
  for (const [source, sql, label] of sources) {
    assert.ok(
      normalizeSql(source).includes(normalizeSql(sql)),
      `Measurement SQL drifted from ${label}; update this source-linked script`
    );
  }
}

function fixtureSql() {
  const sheetNumbers = `WITH RECURSIVE numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM numbers WHERE value < ${FIXTURE.sheetCount}
  )`;
  const tableNumbers = `WITH RECURSIVE sheet_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM sheet_numbers WHERE value < ${FIXTURE.sheetCount}
  ), table_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM table_numbers WHERE value < ${FIXTURE.tablesPerSheet}
  )`;
  const noteNumbers = `${tableNumbers}, note_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM note_numbers WHERE value < ${FIXTURE.notesPerSheet}
  )`;
  const rowNumbers = `${tableNumbers}, row_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM row_numbers WHERE value < ${FIXTURE.rowsPerTable}
  )`;
  const columnNumbers = `${tableNumbers}, column_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM column_numbers WHERE value < ${FIXTURE.columnsPerTable}
  )`;
  const cellStateNumbers = `${tableNumbers}, state_numbers(value) AS (
    VALUES(0)
    UNION ALL SELECT value + 1 FROM state_numbers WHERE value < ${FIXTURE.cellStatesPerTable - 1}
  )`;
  const completionNumbers = `${tableNumbers}, completion_numbers(value) AS (
    VALUES(0)
    UNION ALL SELECT value + 1 FROM completion_numbers WHERE value < ${FIXTURE.completionsPerTable - 1}
  )`;
  const taskNumbers = `WITH RECURSIVE numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM numbers WHERE value < ${FIXTURE.rowsPerTable}
  )`;
  const characterNumbers = `WITH RECURSIVE numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM numbers WHERE value < ${FIXTURE.columnsPerTable}
  )`;

  return sqlBatch(
    `INSERT INTO users (id, display_name)
     VALUES (${sqlLiteral(USER_ID)}, 'Board Read Measurement')`,
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES ('board-read-measure-session', ${sqlLiteral(USER_ID)}, ${sqlLiteral(SESSION_TOKEN_HASH)}, '2099-01-01T00:00:00.000Z')`,
    `INSERT INTO user_settings (
       user_id, density, row_height, column_width, show_display_name, show_server_name,
       show_class_name, show_item_level, show_combat_power
     ) VALUES (${sqlLiteral(USER_ID)}, 'default', 40, 132, 1, 1, 1, 1, 1)`,
    `INSERT INTO board_manifest_versions (user_id, version)
     VALUES (${sqlLiteral(USER_ID)}, 7)`,
    `${characterNumbers}
     INSERT INTO characters (
       id, user_id, name, display_name, server_name, class_name, item_level,
       combat_power, sort_order, enabled, source
     )
     SELECT 'character-' || value,
            ${sqlLiteral(USER_ID)},
            'Character ' || value,
            'Character ' || value,
            'Server ' || ((value - 1) % 4 + 1),
            'Class ' || ((value - 1) % 6 + 1),
            CAST(1700 + value AS TEXT) || '.00',
            CAST(100000 + value * 100 AS TEXT),
            (value - 1) * 10,
            1,
            'lostark'
     FROM numbers`,
    `${taskNumbers}
     INSERT INTO tasks (
       id, user_id, name, scope, reset_type, reset_rule_json, sort_order, enabled, is_template
     )
     SELECT 'task-' || value,
            ${sqlLiteral(USER_ID)},
            'Task ' || value,
            'character',
            'weekly',
            '{"type":"weekly","weekday":3}',
            (value - 1) * 10,
            1,
            0
     FROM numbers`,
    `${sheetNumbers}
     INSERT INTO sheets (id, user_id, name, sort_order, is_default, content_version)
     SELECT 'sheet-' || value,
            ${sqlLiteral(USER_ID)},
            'Sheet ' || value,
            (value - 1) * 10,
            CASE value WHEN 1 THEN 1 ELSE 0 END,
            value + 10
     FROM numbers`,
    `${tableNumbers}
     INSERT INTO board_tables (
       id, user_id, sheet_id, name, sort_order, x, y, width, height,
       row_role, column_role, task_axis, default_row_height, default_column_width,
       locked, display_options_json, event_options_json, template_type
     )
     SELECT 'table-' || sheet_numbers.value || '-' || table_numbers.value,
            ${sqlLiteral(USER_ID)},
            'sheet-' || sheet_numbers.value,
            'Table ' || sheet_numbers.value || '-' || table_numbers.value,
            (table_numbers.value - 1) * 10,
            (table_numbers.value - 1) * 720,
            0,
            680,
            760,
            'task',
            'character',
            'rows',
            40,
            132,
            0,
            '{"show_display_name":1,"show_server_name":1,"show_class_name":1,"show_item_level":1,"show_combat_power":1}',
            NULL,
            'custom'
     FROM sheet_numbers CROSS JOIN table_numbers`,
    `${noteNumbers}
     INSERT INTO board_notes (
       id, user_id, sheet_id, title, body, color, sort_order, x, y, width, height, locked
     )
     SELECT 'note-' || sheet_numbers.value || '-' || note_numbers.value,
            ${sqlLiteral(USER_ID)},
            'sheet-' || sheet_numbers.value,
            'Note ' || sheet_numbers.value || '-' || note_numbers.value,
            'Deterministic board measurement fixture note with production-shaped content.',
            CASE note_numbers.value % 4
              WHEN 0 THEN '#fee2e2'
              WHEN 1 THEN '#dbeafe'
              WHEN 2 THEN '#dcfce7'
              ELSE '#fef3c7'
            END,
            (note_numbers.value - 1) * 10,
            note_numbers.value * 24,
            note_numbers.value * 36,
            260,
            180,
            0
     FROM sheet_numbers CROSS JOIN note_numbers`,
    `${rowNumbers}
     INSERT INTO board_axis_items (
       id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope,
       task_reset_type, task_reset_rule_json, task_color, size_px, cross_size_px,
       sort_order, visible, separator_json, display_options_json
     )
     SELECT 'row-' || sheet_numbers.value || '-' || table_numbers.value || '-' || row_numbers.value,
            ${sqlLiteral(USER_ID)},
            'table-' || sheet_numbers.value || '-' || table_numbers.value,
            'row',
            'task',
            'Task ' || row_numbers.value,
            NULL,
            'task-' || row_numbers.value,
            'character',
            'weekly',
            '{"type":"weekly","weekday":3}',
            CASE row_numbers.value % 5
              WHEN 0 THEN '#dc2626'
              WHEN 1 THEN '#2563eb'
              WHEN 2 THEN '#16a34a'
              WHEN 3 THEN '#9333ea'
              ELSE '#ca8a04'
            END,
            40,
            132,
            (row_numbers.value - 1) * 10,
            1,
            NULL,
            NULL
     FROM sheet_numbers CROSS JOIN table_numbers CROSS JOIN row_numbers`,
    `${columnNumbers}
     INSERT INTO board_axis_items (
       id, user_id, table_id, axis, kind, label, character_id, task_id, task_scope,
       task_reset_type, task_reset_rule_json, task_color, size_px, cross_size_px,
       sort_order, visible, separator_json, display_options_json
     )
     SELECT 'column-' || sheet_numbers.value || '-' || table_numbers.value || '-' || column_numbers.value,
            ${sqlLiteral(USER_ID)},
            'table-' || sheet_numbers.value || '-' || table_numbers.value,
            'column',
            'character',
            'Character ' || column_numbers.value,
            'character-' || column_numbers.value,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            132,
            40,
            (column_numbers.value - 1) * 10,
            1,
            NULL,
            '{"show_display_name":1,"show_server_name":1,"show_class_name":1,"show_item_level":1,"show_combat_power":1}'
     FROM sheet_numbers CROSS JOIN table_numbers CROSS JOIN column_numbers`,
    `${cellStateNumbers}
     INSERT INTO board_cell_states (
       id, user_id, table_id, row_item_id, column_item_id, checkbox_visible,
       mark_type, mark_icon, memo, mark_period_key
     )
     SELECT 'state-' || sheet_numbers.value || '-' || table_numbers.value || '-' || state_numbers.value,
            ${sqlLiteral(USER_ID)},
            'table-' || sheet_numbers.value || '-' || table_numbers.value,
            'row-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
              (CAST(state_numbers.value / ${FIXTURE.columnsPerTable} AS INTEGER) + 1),
            'column-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
              (state_numbers.value % ${FIXTURE.columnsPerTable} + 1),
            1,
            CASE state_numbers.value % 4
              WHEN 0 THEN 'fixed'
              WHEN 1 THEN 'reserved'
              ELSE 'default'
            END,
            CASE state_numbers.value % 4
              WHEN 0 THEN 'pin'
              WHEN 1 THEN 'clock'
              ELSE NULL
            END,
            CASE WHEN state_numbers.value % 4 < 2
              THEN 'Fixture mark ' || state_numbers.value
              ELSE NULL
            END,
            CASE WHEN state_numbers.value % 4 = 1
              THEN 'weekly:2030-01-01'
              ELSE NULL
            END
     FROM sheet_numbers CROSS JOIN table_numbers CROSS JOIN state_numbers`,
    `${completionNumbers}
     INSERT INTO board_cell_completions (
       id, user_id, table_id, row_item_id, column_item_id, period_key, completed
     )
     SELECT 'completion-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
              completion_numbers.value,
            ${sqlLiteral(USER_ID)},
            'table-' || sheet_numbers.value || '-' || table_numbers.value,
            'row-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
              (CAST(completion_numbers.value / ${FIXTURE.columnsPerTable} AS INTEGER) + 1),
            'column-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
              (completion_numbers.value % ${FIXTURE.columnsPerTable} + 1),
            'weekly:2030-01-01',
            CASE WHEN completion_numbers.value % 3 = 0 THEN 0 ELSE 1 END
     FROM sheet_numbers CROSS JOIN table_numbers CROSS JOIN completion_numbers`,
    // A freshly bulk-seeded SQLite database has no planner statistics; production-like
    // indexed sheet reads require statistics before rows_read is representative.
    "ANALYZE"
  );
}

async function verifyFixture(worker) {
  const expected = Array.from({ length: FIXTURE.sheetCount }, (_, index) => ({
    id: `sheet-${index + 1}`,
    tables: FIXTURE.tablesPerSheet,
    notes: FIXTURE.notesPerSheet,
    axis_items: FIXTURE.tablesPerSheet * (FIXTURE.rowsPerTable + FIXTURE.columnsPerTable),
    cell_states: FIXTURE.tablesPerSheet * FIXTURE.cellStatesPerTable,
    completions: FIXTURE.tablesPerSheet * FIXTURE.completionsPerTable
  }));
  const result = await executeWorkerSql(worker, statement(
    "Fixture shape verification",
    `SELECT sheets.id,
            (SELECT COUNT(*) FROM board_tables WHERE board_tables.sheet_id = sheets.id) AS tables,
            (SELECT COUNT(*) FROM board_notes WHERE board_notes.sheet_id = sheets.id) AS notes,
            (SELECT COUNT(*)
             FROM board_axis_items
             JOIN board_tables ON board_tables.id = board_axis_items.table_id
             WHERE board_tables.sheet_id = sheets.id) AS axis_items,
            (SELECT COUNT(*)
             FROM board_cell_states
             JOIN board_tables ON board_tables.id = board_cell_states.table_id
             WHERE board_tables.sheet_id = sheets.id) AS cell_states,
            (SELECT COUNT(*)
             FROM board_cell_completions
             JOIN board_tables ON board_tables.id = board_cell_completions.table_id
             WHERE board_tables.sheet_id = sheets.id) AS completions
     FROM sheets
     WHERE sheets.user_id = ?
     ORDER BY sheets.sort_order, sheets.name`,
    [USER_ID]
  ));
  assert.deepEqual(result.results, expected, "Fixture must be even across exactly three sheets");
  return {
    sheetCount: FIXTURE.sheetCount,
    perSheet: {
      tables: expected[0].tables,
      notes: expected[0].notes,
      axisItems: expected[0].axis_items,
      cellStates: expected[0].cell_states,
      completions: expected[0].completions
    },
    totals: {
      tables: expected[0].tables * FIXTURE.sheetCount,
      notes: expected[0].notes * FIXTURE.sheetCount,
      axisItems: expected[0].axis_items * FIXTURE.sheetCount,
      cellStates: expected[0].cell_states * FIXTURE.sheetCount,
      completions: expected[0].completions * FIXTURE.sheetCount
    }
  };
}

function assertBudgets(establishedBootstrap, legacyFullBoard, noChangeVersionCheck) {
  assert.ok(
    establishedBootstrap.queryCount <= BUDGETS.establishedBootstrapQueriesIncludingAuth,
    `Established bootstrap used ${establishedBootstrap.queryCount} D1 queries including auth-equivalent lookup; budget is ${BUDGETS.establishedBootstrapQueriesIncludingAuth}`
  );
  assert.equal(
    noChangeVersionCheck.queryCount,
    BUDGETS.noChangeVersionSqlStatements,
    `No-change version check used ${noChangeVersionCheck.queryCount} SQL statements; budget is ${BUDGETS.noChangeVersionSqlStatements}`
  );
  const rowsReadReductionPercent = percentReduction(legacyFullBoard.rowsRead, establishedBootstrap.rowsRead);
  assert.ok(
    rowsReadReductionPercent >= BUDGETS.activeRowsReadReductionPercent,
    `Active-sheet rows_read reduction was ${rounded(rowsReadReductionPercent)}%; budget is at least ${BUDGETS.activeRowsReadReductionPercent}% (active ${establishedBootstrap.rowsRead}, legacy ${legacyFullBoard.rowsRead}). Active statements: ${JSON.stringify(establishedBootstrap.statements)}. Legacy statements: ${JSON.stringify(legacyFullBoard.statements)}`
  );
  return {
    rowsRead: legacyFullBoard.rowsRead - establishedBootstrap.rowsRead,
    rowsReadPercent: rounded(rowsReadReductionPercent),
    resultBytes: legacyFullBoard.resultBytes - establishedBootstrap.resultBytes,
    resultBytesPercent: rounded(percentReduction(legacyFullBoard.resultBytes, establishedBootstrap.resultBytes))
  };
}

function formatError(error) {
  if (error instanceof AggregateError) {
    return `${error.message}\n${error.errors.map((entry) => formatError(entry)).join("\n")}`;
  }
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

let temporaryDirectory;
let worker;
let summary;
let measurementError;
try {
  await assertSourceLinkedSql();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "riceark-board-read-measure-"));
  const stateDirectory = join(temporaryDirectory, "state");
  const d1Config = await readLocalD1Config();
  await applyMigrations(stateDirectory, d1Config.databaseName);
  await seedFixture(temporaryDirectory, stateDirectory, d1Config.databaseName);
  worker = await startMeasurementWorker(temporaryDirectory, stateDirectory, d1Config);
  const fixture = await verifyFixture(worker);
  const establishedBootstrap = await measureStatements(worker, ESTABLISHED_BOOTSTRAP_STATEMENTS);
  const legacyFullBoard = await measureStatements(worker, LEGACY_FULL_BOARD_STATEMENTS);
  const noChangeVersionCheck = await measureStatements(worker, NO_CHANGE_VERSION_STATEMENTS);
  const savings = assertBudgets(establishedBootstrap, legacyFullBoard, noChangeVersionCheck);
  summary = {
    adapter: "wrangler-local-worker-d1-binding",
    fixture,
    budgets: BUDGETS,
    establishedBootstrap,
    legacyFullBoard,
    noChangeVersionCheck,
    savings
  };
} catch (error) {
  measurementError = error;
} finally {
  if (worker) {
    try {
      await terminateChild(worker);
    } catch (error) {
      measurementError = measurementError
        ? new AggregateError([measurementError, error], "Measurement and Wrangler cleanup both failed")
        : error;
    }
  }
  if (temporaryDirectory) {
    try {
      await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      measurementError = measurementError
        ? new AggregateError([measurementError, error], "Measurement and temporary-state cleanup both failed")
        : new Error(`Unable to remove temporary measurement directory ${temporaryDirectory}`, { cause: error });
    }
  }
}

if (measurementError) {
  console.error(`board read measurement failed:\n${formatError(measurementError)}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(summary));
}
