import { zValidator } from "@hono/zod-validator";
import { isValidLostArkCharacterName, LOSTARK_CHARACTER_NAME_MAX_LENGTH } from "@riceark/core";
import { Hono } from "hono";
import { z } from "zod";
import { requireSubjectUser } from "../auth/userAccess";
import { requireUser } from "../auth/requireUser";
import {
  CHARACTER_REFRESH_BATCH_MAX_COUNT,
  createManualCharacter,
  deleteCharacter,
  refreshCharactersFromLostArk,
  reorderCharacters,
  saveSelectedCharacters,
  updateCharacterDetails,
  updateCharacterDisplayName
} from "../db/characters";
import type { AppEnv } from "../env";
import { ApiError } from "../http/errors";
import { resourceIdSchema, safeText } from "../http/input";
import { searchRosterCharacters } from "../lostark/client";

export const characterRoutes = new Hono<AppEnv>();

export const characterDisplayNameSchema = z.object({
  displayName: safeText({ allowEmpty: true, allowEmoji: true, maxChars: 20 }).nullable()
}).strict();

export const lostArkCharacterNameSchema = safeText({ maxChars: LOSTARK_CHARACTER_NAME_MAX_LENGTH }).refine(isValidLostArkCharacterName, {
  message: "Lost Ark character name must be 12 characters or fewer and contain only Hangul, Latin letters, or numbers"
});

export const characterSearchSchema = z.object({
  name: lostArkCharacterNameSchema
}).strict();

const editableCharacterText = (max: number) => safeText({ maxChars: max });
const optionalEditableCharacterText = (max: number) => safeText({ allowEmpty: true, maxChars: max }).nullable();
const optionalEmojiCharacterText = (max: number) => safeText({ allowEmpty: true, allowEmoji: true, maxChars: max }).nullable();
export const numericCharacterStatPattern = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/;
export const editableCharacterStatPattern = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\+?$/;
export const numericCharacterStatText = safeText({ maxChars: 20 }).refine((value) => numericCharacterStatPattern.test(value), {
  message: "Character stat must be numeric"
});
export const optionalNumericCharacterStatText = safeText({ allowEmpty: true, maxChars: 20 })
  .nullable()
  .refine((value) => value === null || value === "" || numericCharacterStatPattern.test(value), {
    message: "Character stat must be numeric"
  });
export const optionalEditableCharacterStatText = safeText({ allowEmpty: true, maxChars: 20 })
  .nullable()
  .refine((value) => value === null || value === "" || editableCharacterStatPattern.test(value), {
    message: "Character stat must be numeric or end with +"
  });
const manualCharacterNameSchema = safeText({ allowEmoji: true, maxChars: 20, maxBytes: 80 });

export const characterDetailsSchema = z
  .object({
    name: manualCharacterNameSchema.optional(),
    serverName: optionalEditableCharacterText(20).optional(),
    className: optionalEditableCharacterText(20).optional(),
    displayName: optionalEmojiCharacterText(20),
    itemLevel: optionalEditableCharacterStatText,
    combatPower: optionalEditableCharacterStatText,
    itemLevelPinned: z.boolean().optional(),
    combatPowerPinned: z.boolean().optional(),
    memo: safeText({ allowEmpty: true, allowEmoji: true, maxBytes: 1024, maxChars: 200, multiline: true }).nullable().optional()
  })
  .strict();

export const characterIdParamSchema = z.object({
  id: resourceIdSchema
}).strict();

export const CHARACTER_IMPORT_MAX_COUNT = 200;

export const importCharactersSchema = z.object({
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
    .max(CHARACTER_IMPORT_MAX_COUNT)
}).strict();

export const manualCharacterSchema = z.object({
  name: manualCharacterNameSchema,
  serverName: optionalEditableCharacterText(20).optional().default(""),
  className: optionalEditableCharacterText(20).optional().default(""),
  itemLevel: optionalEditableCharacterStatText.optional().default(""),
  combatPower: optionalEditableCharacterStatText.optional().default(null)
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

export const characterRefreshBatchSchema = z
  .object({
    characterIds: z.array(resourceIdSchema).min(1).max(CHARACTER_REFRESH_BATCH_MAX_COUNT)
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
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
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
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { id } = c.req.valid("param");
    const input = c.req.valid("json");
    const normalized = {
      ...input,
      name: input.name?.trim(),
      serverName: input.serverName === undefined ? undefined : input.serverName?.trim() ? input.serverName.trim() : "",
      className: input.className === undefined ? undefined : input.className?.trim() ? input.className.trim() : "",
      displayName: input.displayName?.trim() ? input.displayName.trim() : null,
      itemLevel: input.itemLevel?.trim() ? input.itemLevel.trim() : "",
      combatPower: input.combatPower?.trim() ? input.combatPower.trim() : null,
      memo: input.memo === undefined ? undefined : input.memo?.trim() ? input.memo.trim() : null
    };
    const updated = await updateCharacterDetails(c.env, user.id, id, normalized);
    if (!updated) throw new ApiError(404, "character_not_found", "Character not found");
    return c.json(updated);
  }
);

characterRoutes.post(
  "/characters/refresh-batch",
  zValidator("json", characterRefreshBatchSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { characterIds } = c.req.valid("json");
    return c.json(await refreshCharactersFromLostArk(c.env, user.id, characterIds));
  }
);

characterRoutes.post(
  "/characters/:id/refresh",
  zValidator("param", characterIdParamSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { id } = c.req.valid("param");
    const refreshed = await refreshCharactersFromLostArk(c.env, user.id, [id]);
    const result = refreshed.results[0];
    if (!result) throw new ApiError(500, "character_refresh_failed", "Character refresh failed");
    if (result.status === "manual") {
      throw new ApiError(400, "manual_character_refresh_unavailable", "수동 캐릭터는 갱신할 수 없습니다.");
    }
    if (result.status === "not_found") throw new ApiError(404, "character_not_found", "Character not found");
    if (result.status === "rate_limited") {
      c.header("Retry-After", String(result.retryAfterSeconds));
      throw new ApiError(
        429,
        "character_refresh_rate_limited",
        `캐릭터 갱신은 1분에 한 번만 시도할 수 있습니다. ${result.retryAfterSeconds}초 후 다시 시도해주세요.`
      );
    }
    if (result.status === "not_available") {
      throw new ApiError(404, "lostark_character_not_found", "로스트아크 API에서 캐릭터 정보를 찾지 못했습니다.");
    }
    if (result.status === "failed") {
      throw new ApiError(
        result.code === "lostark_key_missing" ? 500 : 502,
        result.code,
        "로스트아크 API에서 캐릭터 정보를 갱신하지 못했습니다."
      );
    }
    if (result.status !== "updated") {
      throw new ApiError(500, "character_refresh_failed", "Character refresh failed");
    }
    return c.json({ ...result.character, versions: refreshed.versions });
  }
);

characterRoutes.post(
  "/characters/manual",
  zValidator("json", manualCharacterSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const input = c.req.valid("json");
    const character = await createManualCharacter(c.env, user.id, {
      name: input.name,
      serverName: input.serverName?.trim() ? input.serverName.trim() : "",
      className: input.className?.trim() ? input.className.trim() : "",
      itemLevel: input.itemLevel?.trim() ? input.itemLevel.trim() : "",
      combatPower: input.combatPower?.trim() ? input.combatPower.trim() : null
    });
    return c.json(character, 201);
  }
);

characterRoutes.patch(
  "/characters/:id/display-name",
  zValidator("param", characterIdParamSchema),
  zValidator("json", characterDisplayNameSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { displayName } = c.req.valid("json");
    const normalized = displayName?.trim() ? displayName.trim() : null;
    const { id } = c.req.valid("param");
    const updated = await updateCharacterDisplayName(c.env, user.id, id, normalized);
    if (!updated) throw new ApiError(404, "character_not_found", "Character not found");
    return c.json(updated);
  }
);

characterRoutes.delete(
  "/characters/:id",
  zValidator("param", characterIdParamSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { id } = c.req.valid("param");
    const deleted = await deleteCharacter(c.env, user.id, id);
    if (!deleted) throw new ApiError(404, "character_not_found", "Character not found");
    return c.json(deleted);
  }
);

characterRoutes.post(
  "/characters/import",
  zValidator("json", importCharactersSchema),
  async (c) => {
    const user = await requireSubjectUser(c, { allowAdminTarget: true });
    const { characters } = c.req.valid("json");
    await saveSelectedCharacters(
      c.env,
      user.id,
      characters.map((character) => ({ ...character, combatPower: character.combatPower ?? null }))
    );
    return c.json({ ok: true });
  }
);
