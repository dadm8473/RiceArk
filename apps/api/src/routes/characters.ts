import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import { saveSelectedCharacters } from "../db/characters";
import type { Env } from "../env";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<{ Bindings: Env }>();

characterRoutes.get(
  "/characters/search",
  zValidator("query", z.object({ name: z.string().min(1).max(20) })),
  async (c) => {
    await requireUser(c);
    const { name } = c.req.valid("query");
    const characters = await searchRosterCharacters(c.env, name);
    return c.json({ characters });
  }
);

characterRoutes.post(
  "/characters/import",
  zValidator(
    "json",
    z.object({
      characters: z
        .array(
          z.object({
            name: z.string().min(1).max(20),
            serverName: z.string().min(1).max(20),
            className: z.string().min(1).max(30),
            itemLevel: z.string().min(1).max(20)
          })
        )
        .min(1)
        .max(30)
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    const { characters } = c.req.valid("json");
    await saveSelectedCharacters(c.env, user.id, characters);
    return c.json({ ok: true });
  }
);
