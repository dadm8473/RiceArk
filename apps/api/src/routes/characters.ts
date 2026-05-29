import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<{ Bindings: Env }>();

characterRoutes.get(
  "/characters/search",
  zValidator("query", z.object({ name: z.string().min(1).max(20) })),
  async (c) => {
    const { name } = c.req.valid("query");
    const characters = await searchRosterCharacters(c.env, name);
    return c.json({ characters });
  }
);
