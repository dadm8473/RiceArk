import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { ApiError, jsonError, notFound } from "./http/errors";
import { authRoutes } from "./routes/auth";
import { characterRoutes } from "./routes/characters";
import { dashboardRoutes } from "./routes/dashboard";
import { healthRoutes } from "./routes/health";

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

app.route("/", authRoutes);
app.route("/", characterRoutes);
app.route("/", dashboardRoutes);
app.route("/", healthRoutes);

app.notFound((c) => jsonError(c, notFound()));

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return jsonError(c, error);
  }

  console.error(error);
  return jsonError(c, new ApiError(500, "internal_error", "Internal server error"));
});

export default app;
