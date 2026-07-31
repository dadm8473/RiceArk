import { describe, expect, it } from "vitest";
import app from "../index";
import {
  characterDetailsSchema,
  characterDisplayNameSchema,
  characterIdParamSchema,
  importCharactersSchema,
  manualCharacterSchema,
  characterOrderSchema,
  characterSearchSchema
} from "./characters";

const TARGET_USER_ID = "12345678-1234-4abc-8def-123456789012";

describe("characterDisplayNameSchema", () => {
  it("accepts optional compact display names", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠1" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠🙂" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: "" }).success).toBe(true);
    expect(characterDisplayNameSchema.safeParse({ displayName: null }).success).toBe(true);
  });

  it("rejects display names longer than 20 characters", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "123456789012345678901" }).success).toBe(false);
  });

  it("rejects invisible control characters in display names", () => {
    expect(characterDisplayNameSchema.safeParse({ displayName: "냠\u200B1" }).success).toBe(false);
  });
});

describe("characterSearchSchema", () => {
  it("accepts valid Lost Ark character names", () => {
    expect(characterSearchSchema.safeParse({ name: "냠수나이스1" }).success).toBe(true);
    expect(characterSearchSchema.safeParse({ name: "RiceArk123" }).success).toBe(true);
  });

  it("rejects names over 12 characters or containing spaces and special characters", () => {
    expect(characterSearchSchema.safeParse({ name: "가나다라마바사아자차카타파" }).success).toBe(false);
    expect(characterSearchSchema.safeParse({ name: "냠수 나이스1" }).success).toBe(false);
    expect(characterSearchSchema.safeParse({ name: "냠수-나이스1" }).success).toBe(false);
  });
});

describe("characterDetailsSchema", () => {
  it("accepts editable character details including manual identity fields", () => {
    expect(
      characterDetailsSchema.parse({
        name: "임의캐릭터",
        serverName: "",
        className: null,
        displayName: "냠🙂",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "상아탑 고정🙂"
      })
    ).toMatchObject({
      name: "임의캐릭터",
      serverName: "",
      className: null,
      displayName: "냠🙂",
      itemLevel: "1,640.00",
      combatPower: "2,549.41",
      memo: "상아탑 고정🙂"
    });
  });

  it("accepts independent boolean stat pins and rejects numeric pin values", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: null,
        itemLevel: "1,700.00",
        combatPower: "3,000.00",
        itemLevelPinned: true,
        combatPowerPinned: false
      }).success
    ).toBe(true);
    expect(
      characterDetailsSchema.safeParse({
        displayName: null,
        itemLevel: "1,700.00",
        combatPower: null,
        itemLevelPinned: 1
      }).success
    ).toBe(false);
  });

  it("accepts blank optional manual details while keeping nickname required when supplied", () => {
    expect(
      characterDetailsSchema.parse({
        name: "임의캐릭터",
        serverName: "",
        className: "",
        displayName: null,
        itemLevel: "",
        combatPower: null,
        memo: null
      })
    ).toMatchObject({
      name: "임의캐릭터",
      serverName: "",
      className: "",
      itemLevel: "",
      combatPower: null
    });
    expect(
      characterDetailsSchema.safeParse({
        name: " ",
        displayName: null,
        itemLevel: "1,640.00"
      }).success
    ).toBe(false);
  });

  it("accepts plus suffixes on user-edited character level and combat power notes", () => {
    expect(
      characterDetailsSchema.parse({
        displayName: "냠1",
        itemLevel: "1770+",
        combatPower: "5000+",
        memo: null
      })
    ).toMatchObject({
      itemLevel: "1770+",
      combatPower: "5000+"
    });
  });

  it("allows blank optional item level for manual characters", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: null,
        itemLevel: " ",
        combatPower: null,
        memo: null
      }).success
    ).toBe(true);
  });

  it("rejects unsafe editable character text", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "1,640.00",
        combatPower: "2,549.41",
        memo: "상아탑\u0000고정"
      }).success
    ).toBe(false);
  });

  it("rejects non-numeric character level and combat power text", () => {
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "높음",
        combatPower: "2,549.41",
        memo: null
      }).success
    ).toBe(false);
    expect(
      characterDetailsSchema.safeParse({
        displayName: "냠1",
        itemLevel: "1,640.00",
        combatPower: "전투력높음",
        memo: null
      }).success
    ).toBe(false);
  });

  it("normalizes safe editable character text", () => {
    expect(
      characterDetailsSchema.parse({
        displayName: "  ＮＡＭ１  ",
        itemLevel: "１,６４０.００",
        combatPower: "２,５４９.４１",
        memo: "  상아탑\r\n고정  "
      })
    ).toMatchObject({
      displayName: "NAM1",
      itemLevel: "1,640.00",
      combatPower: "2,549.41",
      memo: "상아탑\n고정"
    });
  });
});

describe("characterOrderSchema", () => {
  it("accepts ordered character ids", () => {
    expect(characterOrderSchema.safeParse({ characterIds: ["character-a", "character-b"] }).success).toBe(true);
  });

  it("rejects duplicate character ids", () => {
    expect(characterOrderSchema.safeParse({ characterIds: ["character-a", "character-a"] }).success).toBe(false);
  });
});

describe("characterIdParamSchema", () => {
  it("accepts non-empty character ids", () => {
    expect(characterIdParamSchema.safeParse({ id: "character-1" }).success).toBe(true);
  });

  it("rejects empty character ids", () => {
    expect(characterIdParamSchema.safeParse({ id: "" }).success).toBe(false);
  });
});

describe("importCharactersSchema", () => {
  it("accepts rosters larger than 30 characters across multiple servers", () => {
    const characters = Array.from({ length: 120 }, (_, index) => ({
      name: `캐릭터${index + 1}`,
      serverName: index % 2 === 0 ? "아만" : "카단",
      className: "브레이커",
      itemLevel: "1,640.00",
      combatPower: "2,549.41"
    }));

    expect(importCharactersSchema.safeParse({ characters }).success).toBe(true);
  });

  it("keeps plus suffixes out of imported Lost Ark character stats", () => {
    expect(
      importCharactersSchema.safeParse({
        characters: [
          {
            name: "냠수나이스1",
            serverName: "아만",
            className: "브레이커",
            itemLevel: "1,770+",
            combatPower: "5,000"
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("manualCharacterSchema", () => {
  it("requires only a nickname and accepts blank optional fields", () => {
    expect(
      manualCharacterSchema.parse({
        name: "임의캐릭터🙂",
        serverName: "",
        className: null,
        itemLevel: "",
        combatPower: null
      })
    ).toMatchObject({
      name: "임의캐릭터🙂",
      serverName: "",
      className: null,
      itemLevel: "",
      combatPower: null
    });
  });

  it("accepts plus suffixes on manually added character level and combat power", () => {
    expect(
      manualCharacterSchema.parse({
        name: "임의캐릭터",
        itemLevel: "1770+",
        combatPower: "5000+"
      })
    ).toMatchObject({
      itemLevel: "1770+",
      combatPower: "5000+"
    });
  });

  it("rejects unsafe or empty manual character names", () => {
    expect(manualCharacterSchema.safeParse({ name: "", serverName: "" }).success).toBe(false);
    expect(manualCharacterSchema.safeParse({ name: "임의\u200B", serverName: "" }).success).toBe(false);
  });
});

describe("character route targeting", () => {
  function createTargetedCharacterRouteEnv() {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    const runs: Array<{ sql: string; values: unknown[] }> = [];
    const env = {
      APP_ORIGIN: "http://127.0.0.1:5173",
      COOKIE_DOMAIN: "127.0.0.1",
      ENVIRONMENT: "test",
      SESSION_SECRET: "test-secret",
      LOSTARK_API_KEY: "test-key",
      ADMIN_OAUTH_ALLOWLIST: "discord:admin-provider",
      CACHE: {
        async get() {
          return { characters: [] };
        },
        async put() {}
      },
      DB: {
        prepare(sql: string) {
          const statement = {
            sql,
            values: [] as unknown[],
            bind(...values: unknown[]) {
              this.values = values;
              return this;
            },
            async first() {
              if (sql.includes("FROM sessions")) {
                return { id: "admin-1", display_name: "Admin", avatar_url: null };
            }
            if (sql.includes("SELECT id, display_name, avatar_url FROM users WHERE id = ?")) {
              return { id: TARGET_USER_ID, display_name: "Target", avatar_url: null };
              }
              if (sql.includes("MAX(sort_order)")) return { max_sort: 0 };
              return null;
            },
            async all() {
              if (sql.includes("FROM oauth_accounts")) {
                return { results: [{ provider: "discord", provider_user_id: "admin-provider" }] };
              }
              if (sql.includes("characters.last_refresh_attempt_at")) {
                return {
                  results: [{
                    position: 0,
                    requested_id: "character-1",
                    id: "character-1",
                    name: "RiceArk1",
                    server_name: "Aman",
                    class_name: "Class",
                    item_level: "1,640.00",
                    combat_power: null,
                    source: "manual",
                    last_refresh_attempt_at: null
                  }]
                };
              }
              return { results: [] };
            },
            async run() {
              runs.push({ sql, values: this.values });
              return { success: true, meta: { changes: 1 } };
            }
          };
          statements.push(statement);
          return statement;
        },
        async batch(batch: Array<{ sql: string; values: unknown[] }>) {
          batches.push(batch);
          return batch.map((statement) => {
            if (statement.sql.includes("RETURNING id, name, server_name")) {
              const characters = JSON.parse(String(statement.values[1])) as Array<{ name: string; serverName: string }>;
              return {
                success: true,
                meta: { changes: characters.length },
                results: characters.map((character) => ({
                  id: "character-1",
                  name: character.name,
                  server_name: character.serverName
                }))
              };
            }
            return { success: true, meta: { changes: 1 }, results: [] };
          });
        }
      }
    };
    return { env, statements, batches, runs };
  }

  const targetHeaders = {
    Cookie: "riceark_session=admin-session",
    "X-RiceArk-Admin-Target-User": TARGET_USER_ID
  };

  it("writes manual character CRUD data for the targeted user", async () => {
    const { env, runs } = createTargetedCharacterRouteEnv();
    const response = await app.request(
      "/api/characters/manual",
      {
        method: "POST",
        headers: { ...targetHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "RiceArk1" })
      },
      env
    );

    expect(response.status).toBe(201);
    const characterBindings = runs
      .filter((statement) => statement.sql.includes("INSERT INTO characters"))
      .flatMap((statement) => statement.values);
    expect(characterBindings).toContain(TARGET_USER_ID);
    expect(characterBindings).not.toContain("admin-1");
  });

  it("imports characters for the targeted user", async () => {
    const { env, batches } = createTargetedCharacterRouteEnv();
    const response = await app.request(
      "/api/characters/import",
      {
        method: "POST",
        headers: { ...targetHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          characters: [{ name: "RiceArk1", serverName: "Aman", className: "Class", itemLevel: "1,640.00" }]
        })
      },
      env
    );

    expect(response.status).toBe(200);
    const characterBindings = batches.flat().flatMap((statement) => statement.values);
    expect(characterBindings).toContain(TARGET_USER_ID);
    expect(characterBindings).not.toContain("admin-1");
  });

  it("refreshes a targeted character rather than the session actor", async () => {
    const { env, statements } = createTargetedCharacterRouteEnv();
    const response = await app.request(
      "/api/characters/character-1/refresh",
      { method: "POST", headers: targetHeaders },
      env
    );

    expect(response.status).toBe(400);
    const refreshBindings = statements
      .filter((statement) => statement.sql.includes("characters.last_refresh_attempt_at"))
      .flatMap((statement) => statement.values);
    expect(refreshBindings).toContain(TARGET_USER_ID);
    expect(refreshBindings).not.toContain("admin-1");
  });

  it("keeps character search actor-owned when a target header is present", async () => {
    const { env, statements } = createTargetedCharacterRouteEnv();
    const response = await app.request(
      "/api/characters/search?name=RiceArk1",
      { headers: targetHeaders },
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ characters: [] });
    expect(statements.filter((statement) => statement.sql.includes("FROM sessions"))).toHaveLength(1);
    expect(statements.some((statement) => statement.sql.includes("FROM oauth_accounts"))).toBe(false);
    expect(statements.some((statement) => statement.sql.includes("FROM users WHERE id = ?"))).toBe(false);
  });
});
