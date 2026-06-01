import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireUser } from "../auth/requireUser";
import {
  deleteCharacter,
  reorderCharacters,
  saveSelectedCharacters,
  updateCharacterDetails,
  updateCharacterDisplayName
} from "../db/characters";
import type { Env } from "../env";
import { ApiError } from "../http/errors";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<{ Bindings: Env }>();

export const characterDisplayNameSchema = z.object({
  displayName: z.string().max(20).nullable()
});

const editableCharacterText = (max: number) => z.string().trim().min(1).max(max);

export const characterDetailsSchema = z
  .object({
    displayName: z.string().max(20).nullable(),
    serverName: editableCharacterText(20),
    className: editableCharacterText(30),
    itemLevel: editableCharacterText(20),
    combatPower: z.string().min(1).max(30).nullable(),
    memo: z.string().max(200).nullable()
  })
  .strict();

export const characterIdParamSchema = z.object({
  id: z.string().min(1)
});

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const characterOrderSchema = z
  .object({
    characterIds: z.array(z.string().min(1)).max(100)
  })
  .refine((input) => !hasDuplicates(input.characterIds), {
    message: "Duplicate character ids are not allowed",
    path: ["characterIds"]
  });

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

characterRoutes.patch(
  "/characters/order",
  zValidator("json", characterOrderSchema),
  async (c) => {
    const user = await requireUser(c);
    const { characterIds } = c.req.valid("json");
    const updated = await reorderCharacters(c.env, user.id, characterIds);
    if (!updated) throw new ApiError(400, "invalid_character_order", "Character order contains unavailable characters");
    return c.json({ ok: true });
  }
);

characterRoutes.patch(
  "/characters/:id",
  zValidator("param", characterIdParamSchema),
  zValidator("json", characterDetailsSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const normalized = {
      ...input,
      displayName: input.displayName?.trim() ? input.displayName.trim() : null,
      serverName: input.serverName.trim(),
      className: input.className.trim(),
      itemLevel: input.itemLevel.trim(),
      combatPower: input.combatPower?.trim() ? input.combatPower.trim() : null,
      memo: input.memo?.trim() ? input.memo.trim() : null
    };
    const updated = await updateCharacterDetails(c.env, user.id, id, normalized);
    if (!updated) throw new ApiError(404, "character_not_found", "Character not found");
    return c.json({ ok: true });
  }
);

characterRoutes.patch(
  "/characters/:id/display-name",
  zValidator("param", characterIdParamSchema),
  zValidator("json", characterDisplayNameSchema),
  async (c) => {
    const user = await requireUser(c);
    const { displayName } = c.req.valid("json");
    const normalized = displayName?.trim() ? displayName.trim() : null;
    const { id } = c.req.valid("param");
    const updated = await updateCharacterDisplayName(c.env, user.id, id, normalized);
    if (!updated) throw new ApiError(404, "character_not_found", "Character not found");
    return c.json({ ok: true });
  }
);

characterRoutes.delete(
  "/characters/:id",
  zValidator("param", characterIdParamSchema),
  async (c) => {
    const user = await requireUser(c);
    const { id } = c.req.valid("param");
    const deleted = await deleteCharacter(c.env, user.id, id);
    if (!deleted) throw new ApiError(404, "character_not_found", "Character not found");
    return c.body(null, 204);
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
            itemLevel: z.string().min(1).max(20),
            combatPower: z.string().min(1).max(30).nullable().optional()
          })
        )
        .min(1)
        .max(30)
    })
  ),
  async (c) => {
    const user = await requireUser(c);
    const { characters } = c.req.valid("json");
    await saveSelectedCharacters(
      c.env,
      user.id,
      characters.map((character) => ({ ...character, combatPower: character.combatPower ?? null }))
    );
    return c.json({ ok: true });
  }
);
