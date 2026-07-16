import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATABASE_BINDING = "DB";
const USER_ID = "board-read-measure-user";
const SESSION_TOKEN = "board-read-measure-session-token";
const SESSION_SECRET = "board-read-measure-session-secret";
const SESSION_TOKEN_HASH = createHmac("sha256", SESSION_SECRET).update(SESSION_TOKEN).digest("hex");
const ACTIVE_SHEET_ID = "sheet-1";
const FIXED_NOW = "2026-06-05T03:00:00.000Z";
const FIXTURE_PERIOD_KEY = "weekly:2026-06-03";
const RESET_RULE_JSON = JSON.stringify({
  type: "weekly",
  weekday: 3,
  hour: 6,
  timezone: "Asia/Seoul"
});
const WORKER_HOST = "127.0.0.1";
const WORKER_START_ATTEMPTS = 5;
const WORKER_READY_TIMEOUT_MS = 12_000;
const WORKER_REQUEST_TIMEOUT_MS = 10_000;
const CHILD_COMMAND_TIMEOUT_MS = 60_000;
const CHILD_STOP_TIMEOUT_MS = 3_000;

const FIXTURE = Object.freeze({
  sheetCount: 3,
  tablesPerSheet: 3,
  notesPerSheet: 4,
  rowsPerTable: 20,
  columnsPerTable: 12,
  cellStatesPerTable: 180
});

const CELLS_PER_TABLE = FIXTURE.rowsPerTable * FIXTURE.columnsPerTable;

const COMPLETION_DENSITY_PERCENTAGES = Object.freeze([20, 50, 90]);

const BUDGETS = Object.freeze({
  establishedBootstrapQueriesIncludingAuthMax: 10,
  legacyFullBoardQueriesIncludingAuthAndPreflight: 9,
  legacyEnsureDefaultBoardPreflightStatements: 1,
  noChangeVersionSqlStatements: 1,
  activeCompletionSqlStatements: 1,
  legacyCompletionSqlStatements: 1,
  activeRowsReadReductionPercentMin: 40,
  activeCompletionRowsReadReductionPercentMin: 40,
  activeCompletionRowsReadMustNotExceedLegacy: true
});

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = dirname(scriptDirectory);
const repositoryDirectory = dirname(dirname(apiDirectory));
const wranglerConfigPath = join(apiDirectory, "wrangler.jsonc");
const SOURCE_MODULES = Object.freeze({
  auth: "apps/api/src/auth/sessions.ts#findUserBySessionToken",
  active: "apps/api/src/db/boardReads.ts#loadBoardBootstrap",
  legacy: "apps/api/src/db/board.ts#loadBoard",
  version: "apps/api/src/db/board.ts#loadBoardVersionSummary"
});
const require = createRequire(import.meta.url);
const wranglerBin = require.resolve("wrangler/bin/wrangler.js");

const WORKER_SOURCE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const nonce = request.headers.get("x-measurement-nonce");
    if (nonce !== env.HEALTH_NONCE) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, nonce: env.HEALTH_NONCE });
    }
    if (request.method !== "POST" || url.pathname !== "/execute") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const body = await request.json();
      if (
        typeof body.sql !== "string" ||
        !Array.isArray(body.bindings) ||
        (body.method !== "all" && body.method !== "run")
      ) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const prepared = env.DB.prepare(body.sql);
      const statement = body.bindings.length > 0 ? prepared.bind(...body.bindings) : prepared;
      return Response.json(body.method === "run" ? await statement.run() : await statement.all());
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
};
`;

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
            // Wrangler can print informational text containing brackets before JSON.
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

async function settlesWithin(promise, timeoutMs) {
  let timeout;
  return new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function terminateChild(processState) {
  if (processState.state.code !== null || processState.state.signal !== null) {
    await processState.closed;
    return;
  }
  processState.child.kill("SIGTERM");
  if (await settlesWithin(processState.closed, CHILD_STOP_TIMEOUT_MS)) return;
  processState.child.kill("SIGKILL");
  assert.ok(
    await settlesWithin(processState.closed, CHILD_STOP_TIMEOUT_MS),
    `Child process did not terminate after bounded TERM/KILL timeouts.\n${childDiagnostics(processState.state)}`
  );
}

function assertLocalWranglerArgs(args) {
  assert.ok(!args.includes("--remote"), "Measurement must never pass Wrangler --remote");
  assert.ok(!args.some((argument) => /^https?:\/\//i.test(argument)), "Measurement must not pass a remote URL");
  assert.ok(args.includes("--local"), "Every measurement Wrangler command must pass --local");
  assert.ok(args.includes("--persist-to"), "Every measurement Wrangler command must use isolated --persist-to state");
}

async function runWrangler(args, label) {
  assertLocalWranglerArgs(args);
  const processState = spawnCaptured(process.execPath, [wranglerBin, ...args], { cwd: apiDirectory });
  const completed = await settlesWithin(processState.closed, CHILD_COMMAND_TIMEOUT_MS);
  if (!completed) {
    await terminateChild(processState);
    throw new Error(
      `${label} exceeded ${CHILD_COMMAND_TIMEOUT_MS}ms and was terminated.\n${childDiagnostics(processState.state)}`
    );
  }
  if (processState.state.error) {
    throw new Error(`Unable to start ${label}: ${processState.state.error.message}`, {
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
  ], "Wrangler local D1 migrations");
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
  ], "Wrangler local D1 fixture seed");
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

async function waitForWorkerReadiness(worker) {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (worker.state.error) {
      throw new Error(`Unable to start Wrangler dev: ${worker.state.error.message}`, {
        cause: worker.state.error
      });
    }
    if (worker.state.code !== null || worker.state.signal !== null) {
      throw new Error(`Wrangler dev exited before readiness.\n${childDiagnostics(worker.state)}`);
    }
    try {
      const response = await fetch(`${worker.baseUrl}/health`, {
        headers: { "x-measurement-nonce": worker.nonce },
        signal: AbortSignal.timeout(500)
      });
      const body = response.ok ? await response.json() : null;
      if (body?.ok === true && body.nonce === worker.nonce) return;
    } catch {
      // The selected port is not yet serving this exact nonce.
    }
    await delay(100);
  }
  throw new Error(
    `Wrangler dev did not serve its unguessable health nonce within ${WORKER_READY_TIMEOUT_MS}ms.\n` +
    childDiagnostics(worker.state)
  );
}

async function startMeasurementWorker(temporaryDirectory, stateDirectory, d1Config) {
  const workerPath = join(temporaryDirectory, "measurement-worker.mjs");
  const workerConfigPath = join(temporaryDirectory, "measurement-wrangler.json");
  await writeFile(workerPath, WORKER_SOURCE, "utf8");
  const failures = [];

  for (let attempt = 1; attempt <= WORKER_START_ATTEMPTS; attempt += 1) {
    const port = await reserveFreePort();
    const nonce = randomBytes(24).toString("hex");
    await writeFile(
      workerConfigPath,
      `${JSON.stringify({
        name: "riceark-board-read-measurement",
        main: "measurement-worker.mjs",
        compatibility_date: d1Config.compatibilityDate,
        vars: { HEALTH_NONCE: nonce },
        d1_databases: [{
          binding: DATABASE_BINDING,
          database_name: d1Config.databaseName,
          database_id: d1Config.databaseId
        }]
      }, null, 2)}\n`,
      "utf8"
    );

    const wranglerArgs = [
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
    ];
    assertLocalWranglerArgs(wranglerArgs);
    assert.equal(wranglerArgs[wranglerArgs.indexOf("--ip") + 1], WORKER_HOST);
    const processState = spawnCaptured(
      process.execPath,
      [wranglerBin, ...wranglerArgs],
      { cwd: temporaryDirectory }
    );
    const worker = {
      ...processState,
      baseUrl: `http://${WORKER_HOST}:${port}`,
      nonce
    };

    try {
      await waitForWorkerReadiness(worker);
      return worker;
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      await terminateChild(processState);
    }
  }

  throw new Error(
    `Wrangler dev failed ${WORKER_START_ATTEMPTS} loopback startup attempts with fresh ports.\n${failures.join("\n")}`
  );
}

async function executeWorkerSql(worker, input) {
  let response;
  try {
    response = await fetch(`${worker.baseUrl}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-measurement-nonce": worker.nonce
      },
      body: JSON.stringify({
        sql: input.sql,
        bindings: input.bindings ?? [],
        method: input.method ?? "all"
      }),
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    throw new Error(
      `${input.label} did not receive a local Worker response.\n${childDiagnostics(worker.state)}`,
      { cause: error }
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${input.label} returned HTTP ${response.status}: ${body}`);
  }
  let result;
  try {
    result = JSON.parse(body);
  } catch (error) {
    throw new Error(`${input.label} returned invalid JSON: ${body}`, { cause: error });
  }
  assert.equal(result.success, true, `${input.label} returned success=false`);
  if (input.requireReadMeta !== false) {
    assert.equal(
      typeof result.meta?.rows_read,
      "number",
      `${input.label} omitted truthful local D1 meta.rows_read`
    );
  }
  if (input.allowWrites !== true) {
    assert.equal(
      result.meta?.rows_written,
      0,
      `${input.label} unexpectedly wrote ${String(result.meta?.rows_written)} rows`
    );
  }
  return result;
}

function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

function classifyStatement(pathName, sql, issuedKinds) {
  const normalized = normalizeSql(sql);
  if (normalized.includes("FROM sessions") && normalized.includes("INNER JOIN users")) return "auth";
  if (normalized.startsWith("SELECT EXISTS(") && normalized.includes("board_tables")) {
    return "ensureDefaultBoardPreflight";
  }
  if (normalized.includes("WITH manifest AS")) {
    if (pathName === "noChangeVersionCheck") return "versionSummary";
    const manifestCount = issuedKinds.filter((kind) => kind.startsWith("manifest")).length;
    return manifestCount === 0 ? "manifest" : "manifestFence";
  }
  if (/FROM (?:main\.)?board_cell_completions\b/.test(normalized)) return "completions";
  if (normalized.includes("FROM board_cell_states")) return "cellStates";
  if (normalized.includes("FROM board_axis_items")) return "axisItems";
  if (normalized.includes("FROM board_notes")) return "notes";
  if (normalized.includes("FROM board_tables")) return "tables";
  if (normalized.includes("FROM user_settings")) return "settings";
  if (normalized.includes("FROM sheets")) {
    return normalized.includes("WHERE id = ? AND user_id = ?") ? "activeSheetMetadata" : "sheets";
  }
  return "unclassified";
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function createInstrumentedEnv(worker, pathName) {
  const records = [];
  const issuedKinds = [];
  let nextSequence = 0;

  function prepare(sql, bindings = []) {
    return {
      bind(...values) {
        return prepare(sql, values);
      },
      async all() {
        const sequence = nextSequence;
        nextSequence += 1;
        const kind = classifyStatement(pathName, sql, issuedKinds);
        issuedKinds.push(kind);
        const result = await executeWorkerSql(worker, {
          label: `${pathName} ${kind}`,
          sql,
          bindings,
          method: "all"
        });
        records.push({
          sequence,
          kind,
          method: "all",
          bindingCount: bindings.length,
          rowsRead: result.meta.rows_read,
          resultBytes: serializedBytes(result.results)
        });
        return result;
      },
      async first(column) {
        const sequence = nextSequence;
        nextSequence += 1;
        const kind = classifyStatement(pathName, sql, issuedKinds);
        issuedKinds.push(kind);
        const result = await executeWorkerSql(worker, {
          label: `${pathName} ${kind}`,
          sql,
          bindings,
          method: "all"
        });
        const row = result.results?.[0] ?? null;
        const value = column === undefined ? row : row?.[column] ?? null;
        records.push({
          sequence,
          kind,
          method: "first",
          bindingCount: bindings.length,
          rowsRead: result.meta.rows_read,
          resultBytes: serializedBytes(value)
        });
        return value;
      },
      async run() {
        throw new Error(`${pathName} unexpectedly attempted a write through D1PreparedStatement.run()`);
      }
    };
  }

  const DB = {
    prepare,
    async batch() {
      throw new Error(`${pathName} unexpectedly attempted D1Database.batch(); fixture was not established`);
    }
  };

  return {
    env: { DB, SESSION_SECRET },
    summarize() {
      const statements = records.toSorted((left, right) => left.sequence - right.sequence);
      const completions = statements.filter((entry) => entry.kind === "completions");
      return {
        queryCount: statements.length,
        rowsRead: statements.reduce((sum, entry) => sum + entry.rowsRead, 0),
        resultBytes: statements.reduce((sum, entry) => sum + entry.resultBytes, 0),
        completion: {
          queryCount: completions.length,
          rowsRead: completions.reduce((sum, entry) => sum + entry.rowsRead, 0),
          resultBytes: completions.reduce((sum, entry) => sum + entry.resultBytes, 0)
        },
        statements: statements.map(({ kind, method, bindingCount, rowsRead, resultBytes }) => ({
          kind,
          method,
          bindingCount,
          rowsRead,
          resultBytes
        }))
      };
    }
  };
}

async function withFixedClock(operation) {
  const OriginalDate = globalThis.Date;
  const fixedTime = OriginalDate.parse(FIXED_NOW);
  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedTime] : args));
    }

    static now() {
      return fixedTime;
    }
  }
  globalThis.Date = FixedDate;
  try {
    return await operation();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

async function loadProductionLoaders() {
  const vitestPackagePath = require.resolve("vitest/package.json");
  const viteRequire = createRequire(vitestPackagePath);
  const viteEntryPath = viteRequire.resolve("vite");
  const { createServer: createViteServer } = await import(pathToFileURL(viteEntryPath).href);
  const vite = await createViteServer({
    root: repositoryDirectory,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true }
  });
  try {
    const [sessions, boardReads, board] = await Promise.all([
      vite.ssrLoadModule("/apps/api/src/auth/sessions.ts"),
      vite.ssrLoadModule("/apps/api/src/db/boardReads.ts"),
      vite.ssrLoadModule("/apps/api/src/db/board.ts")
    ]);
    assert.equal(typeof sessions.findUserBySessionToken, "function", `Missing ${SOURCE_MODULES.auth}`);
    assert.equal(typeof boardReads.loadBoardBootstrap, "function", `Missing ${SOURCE_MODULES.active}`);
    assert.equal(typeof board.loadBoard, "function", `Missing ${SOURCE_MODULES.legacy}`);
    assert.equal(typeof board.loadBoardVersionSummary, "function", `Missing ${SOURCE_MODULES.version}`);
    return {
      vite,
      findUserBySessionToken: sessions.findUserBySessionToken,
      loadBoardBootstrap: boardReads.loadBoardBootstrap,
      loadBoard: board.loadBoard,
      loadBoardVersionSummary: board.loadBoardVersionSummary
    };
  } catch (error) {
    await vite.close();
    throw new Error("Programmatic Vite SSR loading of production board read exports failed", { cause: error });
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
            ${sqlLiteral(RESET_RULE_JSON)},
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
            ${sqlLiteral(RESET_RULE_JSON)},
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
              THEN ${sqlLiteral(FIXTURE_PERIOD_KEY)}
              ELSE NULL
            END
     FROM sheet_numbers CROSS JOIN table_numbers CROSS JOIN state_numbers`,
    "ANALYZE"
  );
}

function completionFixtureSql(completionsPerTable) {
  return `WITH RECURSIVE sheet_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM sheet_numbers WHERE value < ${FIXTURE.sheetCount}
  ), table_numbers(value) AS (
    VALUES(1)
    UNION ALL SELECT value + 1 FROM table_numbers WHERE value < ${FIXTURE.tablesPerSheet}
  ), completion_numbers(value) AS (
    VALUES(0)
    UNION ALL SELECT value + 1 FROM completion_numbers WHERE value < ${completionsPerTable - 1}
  )
  INSERT INTO board_cell_completions (
    id, user_id, table_id, row_item_id, column_item_id, period_key, completed
  )
  SELECT 'completion-' || sheet_numbers.value || '-' || table_numbers.value || '-' || completion_numbers.value,
         ${sqlLiteral(USER_ID)},
         'table-' || sheet_numbers.value || '-' || table_numbers.value,
         'row-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
           (CAST(((completion_numbers.value * 97) % ${CELLS_PER_TABLE}) / ${FIXTURE.columnsPerTable} AS INTEGER) + 1),
         'column-' || sheet_numbers.value || '-' || table_numbers.value || '-' ||
           (((completion_numbers.value * 97) % ${CELLS_PER_TABLE}) % ${FIXTURE.columnsPerTable} + 1),
         ${sqlLiteral(FIXTURE_PERIOD_KEY)},
         CASE WHEN completion_numbers.value % 3 = 0 THEN 0 ELSE 1 END
  FROM sheet_numbers CROSS JOIN table_numbers CROSS JOIN completion_numbers`;
}

async function replaceCompletions(worker, completionsPerTable) {
  await executeWorkerSql(worker, {
    label: "Completion fixture reset",
    sql: "DELETE FROM board_cell_completions WHERE user_id = ?",
    bindings: [USER_ID],
    method: "run",
    allowWrites: true,
    requireReadMeta: false
  });
  await executeWorkerSql(worker, {
    label: "Completion fixture seed",
    sql: completionFixtureSql(completionsPerTable),
    method: "run",
    allowWrites: true,
    requireReadMeta: false
  });
  await executeWorkerSql(worker, {
    label: "Completion fixture statistics",
    sql: "ANALYZE board_cell_completions",
    method: "run",
    allowWrites: true,
    requireReadMeta: false
  });
}

async function verifyFixture(worker, completionsPerTable) {
  const expected = Array.from({ length: FIXTURE.sheetCount }, (_, index) => ({
    id: `sheet-${index + 1}`,
    tables: FIXTURE.tablesPerSheet,
    notes: FIXTURE.notesPerSheet,
    axis_items: FIXTURE.tablesPerSheet * (FIXTURE.rowsPerTable + FIXTURE.columnsPerTable),
    cell_states: FIXTURE.tablesPerSheet * FIXTURE.cellStatesPerTable,
    completions: FIXTURE.tablesPerSheet * completionsPerTable
  }));
  const result = await executeWorkerSql(worker, {
    label: "Fixture shape verification",
    sql: `SELECT sheets.id,
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
    bindings: [USER_ID]
  });
  assert.deepEqual(result.results, expected, "Fixture must be even across exactly three sheets");
  return {
    completionDensityPercent: Math.round((completionsPerTable / CELLS_PER_TABLE) * 100),
    cellsPerTable: CELLS_PER_TABLE,
    completionsPerTable,
    perSheet: {
      tables: expected[0].tables,
      notes: expected[0].notes,
      axisItems: expected[0].axis_items,
      cellStates: expected[0].cell_states,
      completions: expected[0].completions
    }
  };
}

async function measurePath(worker, pathName, operation) {
  const instrumented = createInstrumentedEnv(worker, pathName);
  const value = await withFixedClock(() => operation(instrumented.env));
  return { value, metrics: instrumented.summarize() };
}

async function measureEstablishedBootstrap(worker, loaders, completionsPerTable) {
  const measured = await measurePath(worker, "establishedBootstrap", async (env) => {
    const user = await loaders.findUserBySessionToken(env, SESSION_TOKEN);
    assert.equal(user?.id, USER_ID, "Production auth lookup did not resolve the fixture user");
    return loaders.loadBoardBootstrap(env, USER_ID, ACTIVE_SHEET_ID);
  });
  assert.equal(measured.value.activeSheet.sheet.id, ACTIVE_SHEET_ID);
  assert.equal(measured.value.activeSheet.tables.length, FIXTURE.tablesPerSheet);
  assert.equal(measured.value.activeSheet.completions.length, FIXTURE.tablesPerSheet * completionsPerTable);
  assert.ok(
    measured.value.activeSheet.completions.every((completion) => (
      completion.table_id.startsWith("table-1-") &&
      completion.period_key === FIXTURE_PERIOD_KEY
    )),
    "Production bootstrap returned a completion outside the owned active tables or current period"
  );
  assert.equal(
    measured.value.activeSheet.periodFingerprint,
    FIXTURE_PERIOD_KEY,
    "Production bootstrap did not derive the fixture's current period key from its valid ResetRule"
  );
  return {
    ...measured.metrics,
    periodFingerprint: measured.value.activeSheet.periodFingerprint
  };
}

async function measureLegacyFullBoard(worker, loaders, completionsPerTable) {
  const measured = await measurePath(worker, "legacyFullBoard", async (env) => {
    const user = await loaders.findUserBySessionToken(env, SESSION_TOKEN);
    assert.equal(user?.id, USER_ID, "Production auth lookup did not resolve the fixture user");
    return loaders.loadBoard(env, USER_ID);
  });
  assert.equal(measured.value.sheets.length, FIXTURE.sheetCount);
  assert.equal(measured.value.tables.length, FIXTURE.sheetCount * FIXTURE.tablesPerSheet);
  assert.equal(
    measured.value.completions.length,
    FIXTURE.sheetCount * FIXTURE.tablesPerSheet * completionsPerTable
  );
  assert.ok(
    measured.value.completions.every((completion) => completion.period_key === FIXTURE_PERIOD_KEY),
    "Production legacy loader returned a completion outside the fixed current period"
  );
  return measured.metrics;
}

async function measureVersionCheck(worker, loaders) {
  const measured = await measurePath(worker, "noChangeVersionCheck", (env) => (
    loaders.loadBoardVersionSummary(env, USER_ID)
  ));
  assert.equal(measured.value.sheets.length, FIXTURE.sheetCount);
  return measured.metrics;
}

function percentReduction(baseline, reduced) {
  assert.ok(baseline > 0, "Cannot calculate reduction from a zero baseline");
  return ((baseline - reduced) / baseline) * 100;
}

function rounded(value) {
  return Number(value.toFixed(2));
}

function assertDensityBudgets(densityPercent, establishedBootstrap, legacyFullBoard) {
  assert.ok(
    establishedBootstrap.queryCount <= BUDGETS.establishedBootstrapQueriesIncludingAuthMax,
    `${densityPercent}% density established bootstrap used ${establishedBootstrap.queryCount} queries including auth; ` +
    `budget is <= ${BUDGETS.establishedBootstrapQueriesIncludingAuthMax}`
  );
  assert.equal(
    legacyFullBoard.queryCount,
    BUDGETS.legacyFullBoardQueriesIncludingAuthAndPreflight,
    `${densityPercent}% density legacy load used ${legacyFullBoard.queryCount} queries including auth and preflight; ` +
    `expected ${BUDGETS.legacyFullBoardQueriesIncludingAuthAndPreflight}`
  );
  assert.equal(
    legacyFullBoard.statements.filter((entry) => entry.kind === "ensureDefaultBoardPreflight").length,
    BUDGETS.legacyEnsureDefaultBoardPreflightStatements,
    `${densityPercent}% density legacy measurement did not naturally execute ensureDefaultBoard preflight exactly once`
  );
  assert.equal(
    establishedBootstrap.completion.queryCount,
    BUDGETS.activeCompletionSqlStatements,
    "Active completion query count drifted"
  );
  assert.equal(
    legacyFullBoard.completion.queryCount,
    BUDGETS.legacyCompletionSqlStatements,
    "Legacy completion query count drifted"
  );

  const rowsReadReduction = percentReduction(legacyFullBoard.rowsRead, establishedBootstrap.rowsRead);
  assert.ok(
    rowsReadReduction >= BUDGETS.activeRowsReadReductionPercentMin,
    `${densityPercent}% density active rows_read reduction was ${rounded(rowsReadReduction)}%; ` +
    `budget is >= ${BUDGETS.activeRowsReadReductionPercentMin}%. Active: ${JSON.stringify(establishedBootstrap)} ` +
    `Legacy: ${JSON.stringify(legacyFullBoard)}`
  );

  const completionRowsReadReduction = percentReduction(
    legacyFullBoard.completion.rowsRead,
    establishedBootstrap.completion.rowsRead
  );
  if (BUDGETS.activeCompletionRowsReadMustNotExceedLegacy) {
    assert.ok(
      establishedBootstrap.completion.rowsRead <= legacyFullBoard.completion.rowsRead,
      `${densityPercent}% density active completion rows_read regressed: ` +
      `${establishedBootstrap.completion.rowsRead} active > ${legacyFullBoard.completion.rowsRead} legacy`
    );
  }
  assert.ok(
    completionRowsReadReduction >= BUDGETS.activeCompletionRowsReadReductionPercentMin,
    `${densityPercent}% density active completion rows_read reduction was ${rounded(completionRowsReadReduction)}%; ` +
    `budget is >= ${BUDGETS.activeCompletionRowsReadReductionPercentMin}% ` +
    `(active ${establishedBootstrap.completion.rowsRead}, legacy ${legacyFullBoard.completion.rowsRead})`
  );

  return {
    rowsRead: legacyFullBoard.rowsRead - establishedBootstrap.rowsRead,
    rowsReadPercent: rounded(rowsReadReduction),
    resultBytes: legacyFullBoard.resultBytes - establishedBootstrap.resultBytes,
    resultBytesPercent: rounded(percentReduction(legacyFullBoard.resultBytes, establishedBootstrap.resultBytes)),
    completionRowsRead: legacyFullBoard.completion.rowsRead - establishedBootstrap.completion.rowsRead,
    completionRowsReadPercent: rounded(completionRowsReadReduction),
    completionResultBytes: legacyFullBoard.completion.resultBytes - establishedBootstrap.completion.resultBytes,
    completionResultBytesPercent: rounded(percentReduction(
      legacyFullBoard.completion.resultBytes,
      establishedBootstrap.completion.resultBytes
    ))
  };
}

async function measureDensity(worker, loaders, densityPercent) {
  const completionsPerTable = Math.round((CELLS_PER_TABLE * densityPercent) / 100);
  assert.equal(
    completionsPerTable / CELLS_PER_TABLE,
    densityPercent / 100,
    `${densityPercent}% must produce an exact integer completion count`
  );
  await replaceCompletions(worker, completionsPerTable);
  const fixture = await verifyFixture(worker, completionsPerTable);
  const establishedBootstrap = await measureEstablishedBootstrap(worker, loaders, completionsPerTable);
  const legacyFullBoard = await measureLegacyFullBoard(worker, loaders, completionsPerTable);
  const savings = assertDensityBudgets(densityPercent, establishedBootstrap, legacyFullBoard);
  return {
    densityPercent,
    fixture,
    establishedBootstrap,
    legacyFullBoard,
    savings
  };
}

function formatError(error) {
  if (error instanceof AggregateError) {
    return `${error.message}\n${error.errors.map((entry) => formatError(entry)).join("\n")}`;
  }
  if (error instanceof Error) {
    const cause = error.cause ? `\nCaused by: ${formatError(error.cause)}` : "";
    return `${error.stack ?? error.message}${cause}`;
  }
  return String(error);
}

let temporaryDirectory;
let worker;
let loaders;
let summary;
let measurementError;
try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "riceark-board-read-measure-"));
  const stateDirectory = join(temporaryDirectory, "state");
  const d1Config = await readLocalD1Config();
  await applyMigrations(stateDirectory, d1Config.databaseName);
  await seedFixture(temporaryDirectory, stateDirectory, d1Config.databaseName);
  worker = await startMeasurementWorker(temporaryDirectory, stateDirectory, d1Config);
  loaders = await loadProductionLoaders();

  const densitySweep = [];
  for (const densityPercent of COMPLETION_DENSITY_PERCENTAGES) {
    densitySweep.push(await measureDensity(worker, loaders, densityPercent));
  }
  const productionPeriodFingerprints = new Set(
    densitySweep.map((entry) => entry.establishedBootstrap.periodFingerprint)
  );
  assert.deepEqual(
    [...productionPeriodFingerprints],
    [FIXTURE_PERIOD_KEY],
    "Production loaders derived inconsistent period fingerprints across the density sweep"
  );
  const noChangeVersionCheck = await measureVersionCheck(worker, loaders);
  assert.equal(
    noChangeVersionCheck.queryCount,
    BUDGETS.noChangeVersionSqlStatements,
    `No-change version check used ${noChangeVersionCheck.queryCount} SQL statements; ` +
    `budget is ${BUDGETS.noChangeVersionSqlStatements}`
  );

  summary = {
    adapter: "actual-production-loaders-via-vite-and-wrangler-local-worker-d1",
    sourceModules: SOURCE_MODULES,
    fixedNow: FIXED_NOW,
    fixtureResetRule: JSON.parse(RESET_RULE_JSON),
    productionDerivedPeriodKey: [...productionPeriodFingerprints][0],
    completionDensityPercentages: COMPLETION_DENSITY_PERCENTAGES,
    budgets: BUDGETS,
    densitySweep,
    noChangeVersionCheck
  };
} catch (error) {
  measurementError = error;
} finally {
  if (loaders?.vite) {
    try {
      await loaders.vite.close();
    } catch (error) {
      measurementError = measurementError
        ? new AggregateError([measurementError, error], "Measurement and Vite cleanup both failed")
        : error;
    }
  }
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
