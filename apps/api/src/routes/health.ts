import { Hono } from "hono";
import type { Env } from "../env";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", (c) => c.json({ ok: true, service: "riceark-api" }));
