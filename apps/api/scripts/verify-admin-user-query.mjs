import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const DATABASE_NAME = "riceark";
const SESSION_SECRET = "admin-query-verifier-secret";
const SESSION_TOKEN = "admin-query-verifier-session";
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const FIRST_PAGE_LAST_USER_ID = "00000000-0000-4000-8000-000000000030";
const SELECTED_USER_ID = "00000000-0000-4000-8000-000000000031";
const SUCCESS_LINE = "admin user D1 query verified: first=30, second=1, selected=1, recent=1";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = dirname(scriptDirectory);
const require = createRequire(import.meta.url);
const wranglerBin = require.resolve("wrangler/bin/wrangler.js");

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlBatch(...statements) {
  return `${statements.join(";\n")};`;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function commandDiagnostics(result) {
  return [
    `exit: ${result.code ?? `signal ${result.signal ?? "unknown"}`}`,
    `stdout:\n${stripAnsi(result.stdout).trim() || "<empty>"}`,
    `stderr:\n${stripAnsi(result.stderr).trim() || "<empty>"}`
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
    child.once("error", reject);
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
    throw new Error(`Applying migrations failed.\n${commandDiagnostics(result)}`);
  }
}

async function seedFixture(stateDirectory) {
  const users = Array.from({ length: 31 }, (_, index) => {
    const ordinal = index + 1;
    const id = `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
    const day = String(32 - ordinal).padStart(2, "0");
    return `(${sqlLiteral(id)}, ${sqlLiteral(`Verifier ${ordinal}`)}, ${sqlLiteral(`2026-07-${day} 00:00:00`)})`;
  });
  const tokenHash = createHmac("sha256", SESSION_SECRET)
    .update(SESSION_TOKEN)
    .digest("hex");
  const sql = sqlBatch(
    `INSERT INTO users (id, display_name, created_at) VALUES ${users.join(",\n")}`,
    `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id)
     VALUES ('admin-oauth', ${sqlLiteral(ADMIN_USER_ID)}, 'discord', 'admin-provider')`,
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES ('admin-session', ${sqlLiteral(ADMIN_USER_ID)}, ${sqlLiteral(tokenHash)}, '2099-01-01T00:00:00.000Z', '2026-07-31 12:00:00')`,
    `INSERT INTO sheets (id, user_id, name, sort_order, is_default, updated_at)
     VALUES ('selected-sheet', ${sqlLiteral(SELECTED_USER_ID)}, 'Selected', 0, 1, '2026-08-01 12:34:56')`
  );
  const sqlFile = join(stateDirectory, "admin-query-seed.sql");
  await writeFile(sqlFile, sql, "utf8");
  const result = await runWrangler([
    "d1",
    "execute",
    DATABASE_NAME,
    "--local",
    "--persist-to",
    stateDirectory,
    "--file",
    sqlFile,
    "--yes"
  ]);
  if (result.code !== 0) {
    throw new Error(`Seeding admin query fixture failed.\n${commandDiagnostics(result)}`);
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

function startApi(stateDirectory, port) {
  const child = spawn(process.execPath, [
    wranglerBin,
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    stateDirectory,
    "--var",
    `SESSION_SECRET:${SESSION_SECRET}`,
    "--var",
    "ADMIN_OAUTH_ALLOWLIST:discord:admin-provider"
  ], {
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
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => stripAnsi(output) };
}

async function stopApi(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function fetchAdminPage(baseUrl, query = "") {
  const response = await fetch(`${baseUrl}/api/admin/users${query}`, {
    headers: {
      Cookie: `riceark_session=${SESSION_TOKEN}`
    }
  });
  const text = await response.text();
  assert.equal(response.status, 200, `Admin users endpoint returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForApi(baseUrl, server) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Wrangler exited before startup.\n${server.output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Wrangler is still binding its local listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Wrangler.\n${server.output()}`);
}

async function verifyAdminUserQuery(stateDirectory) {
  await applyMigrations(stateDirectory);
  await seedFixture(stateDirectory);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startApi(stateDirectory, port);
  try {
    await waitForApi(baseUrl, server);

    const firstPage = await fetchAdminPage(baseUrl);
    assert.equal(firstPage.users.length, 30);
    assert.equal(typeof firstPage.nextCursor, "string");
    assert.equal(firstPage.selectedUser, null);

    const decodedCursor = JSON.parse(Buffer.from(firstPage.nextCursor, "base64url").toString("utf8"));
    assert.deepEqual(decodedCursor, ["2026-07-02 00:00:00", FIRST_PAGE_LAST_USER_ID]);

    const secondPage = await fetchAdminPage(
      baseUrl,
      `?cursor=${encodeURIComponent(firstPage.nextCursor)}`
    );
    assert.deepEqual(secondPage.users.map((user) => user.id), [SELECTED_USER_ID]);
    assert.equal(secondPage.nextCursor, null);

    const selectedPage = await fetchAdminPage(
      baseUrl,
      `?selectedUserId=${encodeURIComponent(SELECTED_USER_ID)}`
    );
    assert.equal(selectedPage.selectedUser.id, SELECTED_USER_ID);
    assert.equal(selectedPage.selectedUser.recentActivityAt, "2026-08-01T12:34:56.000Z");
    assert.equal(selectedPage.selectedUser.createdAt, "2026-07-01T00:00:00.000Z");
    assert.doesNotMatch(JSON.stringify(selectedPage), /email|providerUserId|provider_user_id/i);

    return {
      first: firstPage.users.length,
      second: secondPage.users.length,
      selected: selectedPage.selectedUser ? 1 : 0,
      recent: selectedPage.selectedUser.recentActivityAt ? 1 : 0
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nWrangler output:\n${server.output()}`,
      { cause: error }
    );
  } finally {
    await stopApi(server.child);
  }
}

let stateDirectory;
try {
  stateDirectory = await mkdtemp(join(tmpdir(), "riceark-admin-query-d1-"));
  const summary = await verifyAdminUserQuery(stateDirectory);
  assert.deepEqual(summary, { first: 30, second: 1, selected: 1, recent: 1 });
  console.log(SUCCESS_LINE);
} catch (error) {
  console.error(`admin user D1 query verification failed:\n${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  if (stateDirectory) {
    await rm(stateDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}
