import { Hono } from "hono";
import { cors } from "hono/cors";
import { recordApiError } from "./admin/errorCounters";
import type { Env } from "./env";
import { bodyLimit } from "./http/bodyLimit";
import { ApiError, jsonError, notFound } from "./http/errors";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { boardRoutes } from "./routes/board";
import { characterRoutes } from "./routes/characters";
import { dashboardRoutes } from "./routes/dashboard";
import { healthRoutes } from "./routes/health";
import { lostArkEventRoutes } from "./routes/lostarkEvents";
import { patchNoteRoutes } from "./routes/patchNotes";
import { settingsRoutes } from "./routes/settings";
import { taskRoutes } from "./routes/tasks";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.use("*", async (c, next) => {
  const origin = c.env.APP_ORIGIN;
  return cors({
    origin,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })(c, next);
});

app.use("*", bodyLimit());

app.route("/", authRoutes);
app.route("/", adminRoutes);
app.route("/", boardRoutes);
app.route("/", characterRoutes);
app.route("/", dashboardRoutes);
app.route("/", healthRoutes);
app.route("/", lostArkEventRoutes);
app.route("/", patchNoteRoutes);
app.route("/", settingsRoutes);
app.route("/", taskRoutes);

app.notFound((c) => jsonError(c, notFound()));

app.onError((error, c) => {
  const apiError = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Internal server error");
  if (!(error instanceof ApiError)) {
    console.error(error);
  }

  const recorded = recordApiError(c.env, {
    status: apiError.status,
    code: apiError.code,
    path: c.req.path
  }).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(recorded);
  } catch {
    // Test environments have no execution context; the catch above keeps the
    // fire-and-forget write from surfacing as an unhandled rejection.
  }

  return jsonError(c, apiError);
});

export default app;
