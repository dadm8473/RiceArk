import { zValidator } from "@hono/zod-validator";
import { isValidLostArkCharacterName, LOSTARK_CHARACTER_NAME_MAX_LENGTH } from "@riceark/core";
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
import { resourceIdSchema, safeText } from "../http/input";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<{ Bindings: Env }>();

export const characterDisplayNameSchema = z.object({
  displayName: safeText({ allowEmpty: true, maxChars: 20 }).nullable()
}).strict();

export const lostArkCharacterNameSchema = safeText({ maxChars: LOSTARK_CHARACTER_NAME_MAX_LENGTH }).refine(isValidLostArkCharacterName, {
  message: "Lost Ark character name must be 12 characters or fewer and contain only Hangul, Latin letters, or numbers"
});

export const characterSearchSchema = z.object({
  name: lostArkCharacterNameSchema
}).strict();

const editableCharacterText = (max: number) => safeText({ maxChars: max });
const optionalEditableCharacterText = (max: number) => safeText({ allowEmpty: true, maxChars: max }).nullable();
export const numericCharacterStatPattern = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
export const numericCharacterStatText = safeText({ maxChars: 20 }).refine((value) => numericCharacterStatPattern.test(value), {
  message: "Character stat must be numeric"
});
export const optionalNumericCharacterStatText = safeText({ allowEmpty: true, maxChars: 20 })
  .nullable()
  .refine((value) => value === null || value === "" || numericCharacterStatPattern.test(value), {
    message: "Character stat must be numeric"
  });

export const characterDetailsSchema = z
  .object({
    displayName: optionalEditableCharacterText(20),
    itemLevel: numericCharacterStatText,
    combatPower: optionalNumericCharacterStatText,
    memo: safeText({ allowEmpty: true, maxBytes: 1024, maxChars: 200, multiline: true }).nullable().optional()
  })
  .strict();

export const characterIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

export const characterOrderSchema = z
  .object({
    characterIds: z.array(resourceIdSchema).max(100)
  })
  .strict()
  .refine((input) => !hasDuplicates(input.characterIds), {
    message: "Duplicate character ids are not allowed",
    path: ["characterIds"]
  });

characterRoutes.get(
  "/characters/search",
  zValidator("query", characterSearchSchema),
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
      itemLevel: input.itemLevel.trim(),
      combatPower: input.combatPower?.trim() ? input.combatPower.trim() : null,
      memo: input.memo === undefined ? undefined : input.memo?.trim() ? input.memo.trim() : null
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
            name: lostArkCharacterNameSchema,
            serverName: editableCharacterText(20),
            className: editableCharacterText(20),
            itemLevel: numericCharacterStatText,
            combatPower: optionalNumericCharacterStatText.optional()
          })
          .strict()
        )
        .min(1)
        .max(30)
    }).strict()
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
